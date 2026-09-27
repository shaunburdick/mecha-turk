# Contract: Token Handoff & Credential Custody (SECURITY-GATED)

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27
**Status**: **GATE G1 CLOSED (2026-09-27)** — this document (with panel-service.md) was reviewed by the `security-auditor` agent as task T-001; all findings SEC-01…SEC-17 are resolved by the T-002 amendments recorded in §8. Token-handoff, account-custody, and service-credential code may now be written **within this contract** (Wave 2: T-007 → T-008, T-009).

Governing requirements: FR-006 (N-account custody flow), FR-007 (panel never retains), FR-008 (two-part security gate), FR-009 (numeric-id keying, fail-closed expected login), FR-010 (scope matrix), FR-012 (rotation without data loss), NFR-004 (zero token occurrences), AC-001–AC-004.

## 1. Approval requirements (both parts, before any token moves)

1. **Install-time capability grant** — the manifest's implied capability set (`sessions`, `prompt`, `service`, `network`) is approved once at install (GUEST_SERVICES.md lifecycle). Without the `service` grant the first `serviceRequest` fails `NO_SERVICE` and **the handoff is refused with approval instruction; no token leaves the panel** (AC-002).
2. **In-panel consent (FR-008)** — before the *first* handoff on this install, the panel shows a consent step rendering **`CONSENT_COPY_V1` (§1.1) verbatim**; nothing else may be shown as the consent text. Declining keeps the panel usable for health/runs display; account add stays disabled with the reason shown.

### 1.1 Canonical consent string — `CONSENT_COPY_V1` (single source, SEC-12)

> **Mecha Turk wants to send a GitHub token to a local service.**
>
> This local service is allowed but sandbox-advisory: Phase 1 does not enforce an OS sandbox; an allowed service has your full user access — it can run any command and read or write any file your user can.
>
> Your GitHub token is sent over the loopback proxy to this service and stored outside OpenChamber extension storage, protected by file permissions you can back up. It is stored unencrypted (plaintext) on disk, readable by anything running as your user.
>
> Consent is recorded in the service audit as an occurrence only — a version and a time, never the token.

Rules for this block:

- **One source**: this quoted block is the *only* definition of the consent string in the repository. T-009 must render it **verbatim** (no paraphrase, no trimming, no concatenation with other copy).
- **Version**: `CONSENT_VERSION = 1`. The version **bumps by +1 whenever any character of `CONSENT_COPY_V1` changes**, so a stale consent can always be told apart from a current one.
- **Mirror**: panel state stores `{ givenAt, version }` (`host.storage` consent key); the service audit stores the occurrence `{ version, givenAt }` — never a token, never a login.

### 1.2 Consent version enforcement (contract invariant, SEC-01)

`consentVersion` (a **non-secret** integer naming the current copy version) is **required** in the request body of both credential routes:

| Route | Required body |
| --- | --- |
| `POST /v1/accounts/verify` | `{ token, expectedLogin?, consentVersion }` |
| `POST /v1/accounts/:numericUserId/token` | `{ token, consentVersion }` |

- Service rejects with `422 { error: { code: 'consent-required', message } }` when `consentVersion` is absent, not an integer, or **below the service's current `CONSENT_VERSION`** (panel-service.md §4). Nothing is persisted and no GitHub call is made.
- On acceptance the service writes a consent audit occurrence `{ version, givenAt }` **idempotently**: written when that `version` is new to the service, skipped (no duplicate row) when it already recorded it.
- **Re-consent rule (panel side)**: a stored panel consent whose `version < CONSENT_VERSION` forces the consent step again before the next handoff — an old "yes" never covers new wording.
- **Invariant (contract test)**: no `verify`/`token` request without a current `consentVersion` ever yields a 2xx; a request *with* the current version records exactly one consent occurrence per version (replay is a no-op), and no consent occurrence ever contains token bytes.

## 2. Exact sequence (happy path)

```
operator pastes token  →  panel (memory only)  →  consent gate  →  serviceRequest
   ①                              ②                   ③               ④
service: verify (GitHub /user via own fetch)  →  persist credential  →  respond identity
   ⑤                                        ⑥                          ⑦
panel: clear token (finally)  →  render "Connected as <login>"  →  audit (service-side)
   ⑧                                              ⑨                              ⑩
```

| Step | Actor | Detail |
| --- | --- | --- |
| ① | Panel | Token enters a dedicated input (`type="password"`, `autocomplete="new-password"` per SEC-17 so the browser's credential manager offers to *save* rather than *autofill* an existing one; failing that, `autocomplete="off"` — never a persisted suggestion, never bound to any rendered text node elsewhere). |
| ② | Panel | Token exists **only in a module-scoped variable** of the handoff action; it is never written to `host.storage`, the mirror, ledger entries, toasts, error strings, or `console`. Panel-side handling is **write-through**: one shot, no cache, no retry buffer. |
| ③ | Panel | Consent gate (§1) must already be satisfied; otherwise refuse with instruction (AC-002). Also re-check `serviceStatus()`; `stopped/starting` → wait/`failed` → manual retry copy. |
| ④ | Panel → host → service | `POST /v1/accounts/verify` body `{"token":"…","expectedLogin":"<optional>","consentVersion":1}` (≤60,000 chars; token itself is ~40–120 chars). The host proxies verbatim; nothing inspects the body (001 Q5). |
| ⑤ | Service | Shape-checks the token (non-empty, no whitespace, ≤4096 chars) — a malformed token is rejected **before** any network call. Calls `GET https://api.github.com/user` with `Authorization: Bearer <token>` and `X-GitHub-Api-Version: 2022-11-28`, plus free `GET /rate_limit` for budget baselining. Uses **its own `fetch`** with timeout via `AbortSignal.timeout(15000)`. |
| ⑥ | Service | Identity rules (FR-009): key = numeric `id`; `login` stored for display; if `expectedLogin` was supplied and differs (case-insensitive) → **reject, fail closed**, nothing persisted. Duplicate `numericUserId` → `409` (offer rotate flow). Scope matrix recorded (`metadata/issues/pull-requests/contents` → `ok/missing/unknown`) from endpoint probes/status semantics — **missing scopes never downgrade silently**; they pre-block the affected streams with the capability named (FR-010). **Persist ordering (SEC-05)**: `accounts/<id>.json` is written **only after `/user` succeeds**, and the success response is written **immediately after the persist completes** — a crash in between leaves no half-registered account (see F13). File `0600`, dir `0700`, atomic temp+rename (§6) **outside `host.storage`** (default data dir, research R2). |
| ⑦ | Service → panel | `201 { numericUserId, login, state:'active', verifiedAt, scopeCheck }`. **Response construction runs through the same redaction guard as audit writes**; a test asserts the serialized body contains no token-shaped substring. |
| ⑧ | Panel | `finally { token = undefined; }` — the variable is cleared on **every** exit (success, 4xx, 5xx, timeout, thrown). Input field is cleared. No retry re-uses the token; a retry means the operator pastes again. |
| ⑨ | Panel | Renders `Connected as <login>` (+ numeric id in diagnostics). Records account metadata (id/login/scope/state only) into the accounts view and the service-backed store. |
| ⑩ | Service | Appends `account.verified` audit entry: correlation id, numeric id, login, scope results, `redaction: { redacted: false }` — **no token bytes by construction** (the writer never receives the token). Consent occurrence `{ version, givenAt }` recorded separately and idempotently (§1.2). |

## 3. What enters / clears panel state

| Phase | In panel memory | In `host.storage` | In service store | In audit |
| --- | --- | --- | --- | --- |
| Before paste | nothing | nothing | nothing | nothing |
| Pasted, pre-consent | token (module var) | **nothing** | nothing | nothing |
| In flight | token until `finally` | **nothing** | — | — |
| Verified | **cleared** | account mirror `{numericUserId, login, state, scopeCheck}` | `credential` (0600) + account record | `consent`, `account.verified` (no token) |
| Failed (any reason) | **cleared** | nothing (or prior account mirror untouched) | nothing new | `account.rejected` / `account.error` with reason class only |

**Assertion (executable, NFR-004)**: a token-shaped pattern (PAT prefixes `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`; plus any value ever handed to the service, registered with the test harness) must not appear in: serialized `host.storage` writes, any panel-side error/toast/log string, any service HTTP response body, any audit line, or any run/delivery record. The scan runs across the whole suite (task T-031).

## 4. Redaction rules

1. **Panel**: every surface that renders request/response material passes through the shared `redact()` (spike `redaction.ts`, global patterns — T009c); `assertRedacted` guards all `host.storage` writes (spike discipline kept).
2. **Service**: logging and audit writers accept a `SafeDetail` type only — plain JSON with a `redactSecrets()` pass applied at write time; the token type is never a field of any log/audit DTO (structural impossibility, not discipline).
3. **Error bodies**: GitHub 401/403 responses from `/user` are mapped to reason classes (`auth-failed`, `scope-missing:<capability>`, `sso-required`) and surfaced to the panel as **`422 credential-rejected`** — HTTP `401` is *reserved for bearer-auth failure against our own service* and never carries a GitHub verdict (panel-service.md §1/§4, SEC-03); raw GitHub response bodies are never forwarded to the panel or written to audit (they can echo request metadata).
4. **Toast/copy**: account errors name the capability or state, never bytes of the credential (AC-003: "rejected with a clear reason and no token echo").
5. **Rendering is not redaction (SEC-14)**: every string the service supplies (logins, error messages, `pausedReason`, field names, remediation text, audit slices) is rendered through `textContent` / `document.createTextNode` — **never** `innerHTML`, `insertAdjacentHTML`, or any HTML-parsing sink. Redaction removes secret bytes; escaping controls markup interpretation; **neither substitutes for the other**, and a string that survived redaction is still untrusted input.
6. **Logging ban (SEC-11)**: the `Authorization` header and the request bodies of the verify/rotation routes (`POST /v1/accounts/verify`, `POST /v1/accounts/:id/token`) are **never logged, at any level, in any format** — not in access lines, not in error dumps, not in `debug`, not as a truncated prefix. Validation errors name **field + remediation only** and never echo received values (panel-service.md §3 invariant 10 carries the executable check).
7. **Destructive routes stay operator-driven**: `DELETE /v1/accounts/:id?force=1` and `POST /v1/runs/:runKeyHash/approval` are reachable only from an operator-confirmed UI action (confirm dialog / explicit button) — never from an automatic retry, a dispatched run, or a background poll (panel-service.md §2.2/§2.4).

## 5. Failure modes

| # | Condition | Behavior | Requirement |
| --- | --- | --- | --- |
| F1 | `service` capability not granted | `serviceRequest` → `NO_SERVICE`; panel shows approval instruction; token never sent (input disabled until `serviceStatus()` reachable) | AC-002 |
| F2 | Extension disabled mid-flow | `DISABLED`; token cleared; nothing persisted | FR-007 |
| F3 | Service crashed | `SERVICE_FAILED`; token cleared; manual retry only (no loop) | AC-018 |
| F4 | Leg timeout (20 s) | `HOST_TIMEOUT`; token cleared; panel **re-reads `GET /v1/status` before declaring failure** (the service — not the timeout — is the authority on whether an account appeared) and only then shows the failure copy; operator re-pastes | FR-007, SEC-05 |
| F5 | GitHub 401/404 on `/user` | `422 credential-rejected`, `reasonClass: 'auth-failed'`; nothing persisted; no echo | AC-003 |
| F6 | GitHub 403 (SSO/org policy/scope) | `422 credential-rejected`, `reasonClass: 'scope-missing:<name>'` or `'sso-required'`; account rejected or stored with pre-blocked streams per FR-010 | FR-010 |
| F7 | `expectedLogin` mismatch | `422 account-rejected`, fail closed, nothing persisted | FR-009 |
| F8 | Duplicate numeric id | `409` → panel offers rotation flow | FR-012 |
| F9 | Network offline | reason `network`; checkpoint/rate state untouched (no account yet) | FR-024 |
| F10 | Storage dir unwritable | `503 storage-unavailable` **before** accepting the token: pre-flight reads `GET /v1/status` → `service.storage.writable` (`/health` is deliberately store-independent, so it cannot carry this signal, SEC-08) | FR-039 |
| F11 | Consent declined/gated | Handoff button disabled with reason; no token typed state leaves the input | FR-008 |
| F12 | Token pasted into wrong field/other screens | Only the handoff input accepts a credential; all other renders use redaction guard. **Named negative-path test (T-019)**: each non-handoff input, on every screen, is asserted to reject/ignore credential text — render-redaction alone is not the test (SEC-10e) | NFR-004 |
| F13 | Crash mid-handoff (service dies around verify/persist) | The service persists only after `/user` succeeds and responds only after the persist; on **startup** any account left in `pending_handoff`/`verifying` is **re-verified or marked `error:interrupted-handoff`** (audited, `account.error`) — an account is never left in a transient state across restarts | NFR-006, SEC-05 |
| F14 | `503 storage-unavailable` **after** submission | Nothing persisted, token cleared in `finally`, manual retry only (no loop); panel pre-checked `service.storage.writable` first (SEC-08) | FR-039 |
| F15 | GitHub `429` during verify | `429 rate-limited` + `retry-after`; nothing persisted; panel clears the token; **no automatic retry of the handoff** — the operator re-pastes after the stated time | FR-024, SEC-10 |
| F16 | Service refuses to start: `OPENCHAMBER_SERVICE_TOKEN` missing or shorter than **32** chars | Process exits non-zero **before binding**, with a secret-free startup log line; readiness never turns green → panel `SERVICE_FAILED` + start-failure copy | SEC-02a, AC-018 |

**Audit-writer rule (SEC-05)**: `account.error` is written **only by the service, only for conditions it observes itself** (its own timeout, its own persistence failure, an interrupted handoff it found at startup). The panel never writes service audit rows, and a host-leg timeout the service cannot see is *not* an audit-worthy account error — the F4 host-timeout audit requirement from the earlier draft is dropped as unimplementable.

## 6. Custody rules (steady state)

- Exactly **one** copy of a token at rest: `accounts/<numericUserId>.json` (`0600`) in the service store; never duplicated into `host.storage`, backups of panel state, ledgers, or git (`.env.example` stays comment-only; `.gitignore` covers `.env*`).
- **Atomic credential-file specifics (SEC-13)** — every store write, credential files included:
  1. the temporary file is created **inside the target directory** (never in a shared temp dir — a cross-device `rename` is not atomic) with mode **`0600` passed explicitly** (never inherited from the umask);
  2. content is written, then **`fsync`**ed;
  3. only then is it **`rename`**d over the target (same directory, atomic replace);
  4. at **startup** the service verifies the store directory is mode **`0700`**, corrects it (`chmod`) when it can, and reports `storage-unavailable` / `service.storage.writable: false` when it cannot — a world-readable store never silently persists;
  5. **crash debris**: an orphaned temp file from an interrupted write is ignored by readers and swept on the next startup (it never shadows the real target; it must not be world-readable either).
  *Implementation note: extends T-005's store tests — temp-file mode assertion (pre-rename), umask-independence, startup dir-mode verification/correction path.*
- Tokens live only in service memory between requests; the in-memory map is cleared on graceful shutdown.
- **Rotation (FR-012, SEC-06)** — `POST /v1/accounts/:numericUserId/token`:
  - the new token is verified through `/user` **before** anything is written;
  - the numeric id GitHub reports **must equal the path id** — a mismatch is `422 account-rejected`, **nothing is persisted**, the old credential stays untouched;
  - on success only `login`, `scopeCheck`, and `verifiedAt` are refreshed: `numericUserId`, checkpoints, deliveries, runs, and audit history are **unchanged**;
  - old token bytes are not retained anywhere (no history of secrets), and the replaced copy is gone atomically.
  *Contract test note: rotate with a different-id token → 422 + byte-identical store; rotate with a same-id token → store diff shows only credential/login/scopeCheck/verifiedAt.*
- Revocation (on GitHub) + next poll → account `revoked`/`error` state, streams block with capability named, other accounts unaffected (spec Edge Case).
- The panel's *host-managed* optional integration card (FR-011) is a **separate** credential OpenChamber owns; it is never read into panel state and never used for polling/dispatch.

## 7. Threat notes for the reviewer (T-001 scope)

1. **Loopback transit & what bearer auth actually buys (amended per SEC-07)**: the token crosses panel→host→127.0.0.1 in the request body; the host does not inspect it; TLS is not applicable on loopback. The service verifies the bearer on every route — but that only isolates **other local *users*** (and other processes that do not already hold the secret) from reaching our HTTP API. It is **not** a custody boundary against same-user code: any process running as the same user can read `OPENCHAMBER_SERVICE_TOKEN` straight out of the service's environment (`/proc/<pid>/environ`), or skip HTTP entirely and read the `0600` store from disk. **The real custody boundary is file permissions + uid separation**, not the service token; the bearer check is defence-in-depth for the network surface only.
2. Advisory-permission service: an allowed service has full user access (GUEST_SERVICES.md); our mitigations are least-privilege *code* posture (stdlib only, read/write confined to our data dir, outbound only to `api.github.com`), audited startup, and the honest FR-008 consent copy (§1.1, including the plaintext-at-rest sentence).
3. Response/oracle surface: uniform byte-identical `401` body, exact `Bearer <token>` grammar (any deviation → 401 before route resolution), no timing affordances beyond `sha256` + `timingSafeEqual`, no token-derived identifiers.
4. Backup exposure: the data dir is operator-controlled; quickstart documents that `accounts/*.json` contains plaintext credentials and must be protected like `~/.ssh`.
5. **Platform trust assumption (SEC-16)**: this contract assumes the **host never logs or persists `serviceRequest` bodies** (which carry the token on every handoff). That property belongs to the OpenChamber platform, is **not verifiable by our tests**, and is accepted as a residual risk: if the host ever records request bodies, the token lands in host-owned storage outside everything this contract governs. Recorded honestly rather than implied away; re-evaluate if the platform documents change.

## 8. Sign-off

| Field | Value |
| --- | --- |
| Reviewer | `security-auditor` agent (task T-001) |
| Scope | this file + `panel-service.md` + FR-008 consent copy |
| Verdict | **PASS-with-fixes** — 2 High, 5 Medium, 7 Low, 3 Info (no Critical) |
| Findings | SEC-01 … SEC-17 — resolution table below |
| Resolution | **task T-002** — all findings resolved by amendment (one sanctioned code change: SEC-02a token floor 16 → 32); **no finding rejected** |
| Date | 2026-09-27 |
| Gate G1 status | **CLOSED** — every finding below is Resolved-by-amendment or acknowledged; Wave 2 (T-007, T-008, T-009) is unblocked |

### 8.1 Findings and resolutions

| ID | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| SEC-01 | High | FR-008 consent had no service-side record or enforcement path (no consent field/route; no version re-prompt rule) | **Resolved-by-amendment** — §1.2: `consentVersion` required on `POST /v1/accounts/verify` and `POST /v1/accounts/:id/token`; `422 consent-required` when absent/below current; idempotent consent audit occurrence `{version, givenAt}`; panel re-consent when stored `version < current`; new contract invariant (panel-service §3) |
| SEC-02 | High | Bearer auth not pinned fail-closed (startup, grammar, length-mismatch throw, auth-vs-routing order) | **Resolved-by-amendment + code** — panel-service §1 Auth/Startup rows pin (a) exit non-zero + secret-free log when `OPENCHAMBER_SERVICE_TOKEN` missing or **< 32 chars**, (b) exact `Bearer` + SP + non-empty grammar → else 401, (c) `sha256` both sides → `timingSafeEqual` (constant length, never throws), (d) authenticate before route/method resolution (unknown path + valid auth → 404); all four added as invariant-1 sub-assertions. **Code change**: `extension/service/env.ts` floor 16 → 32 (+ tests) — supersedes Wave 1's 16 |
| SEC-03 | Medium | HTTP 401 collided: GitHub `auth-failed` vs service bearer `unauthorized` (F5 said "401/422") | **Resolved-by-amendment** — 401 reserved for bearer failure only; GitHub rejection → `422 credential-rejected` with `reasonClass: 'auth-failed' \| 'scope-missing:<cap>' \| 'sso-required'`; three reason classes + panel copy added to §4; F5/F6 rewritten |
| SEC-04 | Medium | No throttle/concurrency cap on verify or long-poll | **Resolved-by-amendment** — max 1 in-flight verify (concurrent → `429 verify-busy`), rolling ≤10 verify attempts/5 min → `429` + `retry-after`, max 4 concurrent long-polls (excess → empty result or 429), throttle state never echoes/logs the token; new invariant (panel-service §3) |
| SEC-05 | Medium | Crash/timeout split-brain: persist-then-crash divergence, unimplementable F4 audit, orphaned `verifying` | **Resolved-by-amendment** — F13 added (persist only after `/user`, respond only after persist; startup re-verifies or marks `error:interrupted-handoff`, audited); F4 rewritten (panel re-reads `/v1/status` before declaring failure); audit-writer rule: `account.error` written by the service only for conditions it observes — host-timeout audit requirement dropped as unimplementable |
| SEC-06 | Medium | Rotation never required the new token's `/user` id to equal the path id | **Resolved-by-amendment** — §6 rotation rules + panel-service §2.2: mismatch → `422 account-rejected`, nothing persisted; success refreshes `login`/`scopeCheck`/`verifiedAt` only, `numericUserId`/checkpoints/deliveries/runs/audit unchanged; contract test noted |
| SEC-07 | Medium | Threat note overstated bearer auth ("prevents other local processes") | **Resolved-by-amendment** — §7.1 amended: bearer auth isolates other **local users** only; same-user processes read the token from `/proc/<pid>/environ` and the `0600` store directly; **the service token is not a custody boundary — file permissions + uid separation are** |
| SEC-08 | Low | F10 pre-flight not implementable (no writability signal; post-submission 503 missing) | **Resolved-by-amendment** — `service.storage: { writable: boolean }` added to `/v1/status` (panel pre-checks before enabling the input); F14 added: 503 after submission → nothing persisted, token cleared, manual retry |
| SEC-09 | Low | 401 body written two ways (bare string vs envelope) | **Resolved-by-amendment** — unified on `{ error: { code: 'unauthorized', message: <fixed> } }` everywhere; invariant-1 sub-assertions require a **byte-identical** body for missing/malformed/length-mismatch/wrong-value |
| SEC-10 | Low | Failure table / catalog gaps (429-on-verify, malformed JSON, host codes, missing-token startup, F12 negative-path test) | **Resolved-by-amendment** — F15 (GitHub 429 during verify: retry-after, token cleared, no auto-retry), malformed/structurally-invalid body → `422 validation` `field: 'body'` (values never echoed) alongside the ratified transport `400 invalid-json`, host codes `HOST_UNAVAILABLE`/`HOST_REJECTED`/`BAD_PATH`/`NOT_GRANTED` mapped to panel copy, F16 (missing/short service token → non-zero exit → `SERVICE_FAILED`), F12 gains a named field-acceptance negative-path test |
| SEC-11 | Low | Request-body logging / validation echo not explicitly banned | **Resolved-by-amendment** — §4 rule 6 + panel-service §3 invariant 10: `Authorization` header and verify/rotation bodies never logged at any level in any format; validation errors name field + remediation only, never received values; test noted (force a 500 on verify, scan the full log for the registered token) |
| SEC-12 | Low | Consent copy diverged three ways; not a renderable string; plaintext not stated | **Resolved-by-amendment** — §1.1 designates the single quoted block `CONSENT_COPY_V1` (T-009 renders it verbatim), including the advisory/full-user-access sentence **and** "stored unencrypted (plaintext) on disk, readable by anything running as your user"; `version` bumps on every string change |
| SEC-13 | Low | Atomic write details for the credential file unspecified | **Resolved-by-amendment** — §6: temp file created **mode `0600` inside the target dir** (never umask default), written, `fsync`ed, then renamed (temp cleanup on crash noted); startup verifies dir mode `0700` and corrects or reports `storage-unavailable`; T-005 store tests extended accordingly (implementation note) |
| SEC-14 | Low | Redaction ≠ output-encoding; panel renders service-supplied strings | **Resolved-by-amendment** — §4 rule 5: all service-supplied strings render via `textContent` (never `innerHTML`/`insertAdjacentHTML`), redaction ≠ escaping; §4 rule 7: `DELETE ?force=1` and `/approval` are operator-confirmed actions only |
| SEC-15 | Info | Positive controls to preserve (redaction-guarded responses, SafeDetail DTOs, credential-free account DTOs, `handoff-guard`, registered-token scan, F1/F11 gating, fail-closed `expectedLogin`, pre-network shape check, quickstart plaintext honesty) | **Acknowledged — no action required** (Info by design); the listed controls are preserved verbatim by these amendments and guarded by the existing invariants/tests — any Wave-2 edit that removes one is a regression against this sign-off |
| SEC-16 | Info | Undocumented host-leg trust assumption (host never logs/persists `serviceRequest` bodies) | **Resolved-by-amendment** — §7.5 records it explicitly as a platform trust assumption, unverifiable by our tests, residual risk noted |
| SEC-17 | Info | `type="password"` without a pinned autocomplete attribute | **Resolved-by-amendment** — §2 step ① pins `autocomplete="new-password"` (fallback `autocomplete="off"`) on the handoff input |

**Gate note**: the two binding conditions from the T-001 verdict (SEC-01, SEC-02) are both amended; the five Mediums, seven Lows, and three Infos are all resolved or acknowledged above. No finding was rejected, so G1 closes with this table (T-002).
