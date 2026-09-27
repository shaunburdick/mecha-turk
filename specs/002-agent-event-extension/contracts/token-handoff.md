# Contract: Token Handoff & Credential Custody (SECURITY-GATED)

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27
**Status**: **GATED** — task T-001 sends this document (with panel-service.md) to the `security-auditor` agent; **no token-handoff, account-custody, or service-credential code may be written before findings are resolved and sign-off is recorded in §8** (tasks T-001 → T-002, gate G1).

Governing requirements: FR-006 (N-account custody flow), FR-007 (panel never retains), FR-008 (two-part security gate), FR-009 (numeric-id keying, fail-closed expected login), FR-010 (scope matrix), FR-012 (rotation without data loss), NFR-004 (zero token occurrences), AC-001–AC-004.

## 1. Approval requirements (both parts, before any token moves)

1. **Install-time capability grant** — the manifest's implied capability set (`sessions`, `prompt`, `service`, `network`) is approved once at install (GUEST_SERVICES.md lifecycle). Without the `service` grant the first `serviceRequest` fails `NO_SERVICE` and **the handoff is refused with approval instruction; no token leaves the panel** (AC-002).
2. **In-panel consent (FR-008)** — before the *first* handoff on this install, the panel shows a consent step stating in plain language:
   - this local service is **allowed but sandbox-advisory**: "Phase 1 does not enforce an OS sandbox; an allowed service can run any command and read or write any file your user can" (GUEST_SERVICES.md wording, quoted from research R1.5);
   - the token will be sent over the loopback proxy to the service and stored outside OpenChamber extension storage, protected by file permissions the operator can back up;
   - the consent is **recorded in the service audit as an occurrence only** (`eventType: 'consent'`, `{ version, givenAt }`, no token, no login required) and mirrored in panel state as `{ givenAt, version }`.
   - Declining keeps the panel usable for health/runs display; account add stays disabled with the reason shown.

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
| ① | Panel | Token enters a dedicated input (`type="password"`, no autocomplete persistence, never bound to any rendered text node elsewhere). |
| ② | Panel | Token exists **only in a module-scoped variable** of the handoff action; it is never written to `host.storage`, the mirror, ledger entries, toasts, error strings, or `console`. Panel-side handling is **write-through**: one shot, no cache, no retry buffer. |
| ③ | Panel | Consent gate (§1) must already be satisfied; otherwise refuse with instruction (AC-002). Also re-check `serviceStatus()`; `stopped/starting` → wait/`failed` → manual retry copy. |
| ④ | Panel → host → service | `POST /v1/accounts/verify` body `{"token":"…","expectedLogin":"<optional>"}` (≤60,000 chars; token itself is ~40–120 chars). The host proxies verbatim; nothing inspects the body (001 Q5). |
| ⑤ | Service | Shape-checks the token (non-empty, no whitespace, ≤4096 chars) — a malformed token is rejected **before** any network call. Calls `GET https://api.github.com/user` with `Authorization: Bearer <token>` and `X-GitHub-Api-Version: 2022-11-28`, plus free `GET /rate_limit` for budget baselining. Uses **its own `fetch`** with timeout via `AbortSignal.timeout(15000)`. |
| ⑥ | Service | Identity rules (FR-009): key = numeric `id`; `login` stored for display; if `expectedLogin` was supplied and differs (case-insensitive) → **reject, fail closed**, nothing persisted. Duplicate `numericUserId` → `409` (offer rotate flow). Scope matrix recorded (`metadata/issues/pull-requests/contents` → `ok/missing/unknown`) from endpoint probes/status semantics — **missing scopes never downgrade silently**; they pre-block the affected streams with the capability named (FR-010). Persist `accounts/<id>.json` with `credential` (file `0600`, dir `0700`, atomic temp+rename) **outside `host.storage`** (default data dir, research R2). |
| ⑦ | Service → panel | `201 { numericUserId, login, state:'active', verifiedAt, scopeCheck }`. **Response construction runs through the same redaction guard as audit writes**; a test asserts the serialized body contains no token-shaped substring. |
| ⑧ | Panel | `finally { token = undefined; }` — the variable is cleared on **every** exit (success, 4xx, 5xx, timeout, thrown). Input field is cleared. No retry re-uses the token; a retry means the operator pastes again. |
| ⑨ | Panel | Renders `Connected as <login>` (+ numeric id in diagnostics). Records account metadata (id/login/scope/state only) into the accounts view and the service-backed store. |
| ⑩ | Service | Appends `account.verified` audit entry: correlation id, numeric id, login, scope results, `redaction: { redacted: false }` — **no token bytes by construction** (the writer never receives the token). Consent occurrence recorded separately (§1.2). |

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
3. **Error bodies**: GitHub 401/403 responses are mapped to reason classes (`auth-failed`, `scope-missing:<capability>`, `sso-required`); raw response bodies are never forwarded to the panel or written to audit (they can echo request metadata).
4. **Toast/copy**: account errors name the capability or state, never bytes of the credential (AC-003: "rejected with a clear reason and no token echo").

## 5. Failure modes

| # | Condition | Behavior | Requirement |
| --- | --- | --- | --- |
| F1 | `service` capability not granted | `serviceRequest` → `NO_SERVICE`; panel shows approval instruction; token never sent (input disabled until `serviceStatus()` reachable) | AC-002 |
| F2 | Extension disabled mid-flow | `DISABLED`; token cleared; nothing persisted | FR-007 |
| F3 | Service crashed | `SERVICE_FAILED`; token cleared; manual retry only (no loop) | AC-018 |
| F4 | Leg timeout (20 s) | `HOST_TIMEOUT`; token cleared; audit `account.error` reason `timeout`; operator re-pastes | FR-007 |
| F5 | GitHub 401/404 on `/user` | `401/422` reason `auth-failed`; nothing persisted; no echo | AC-003 |
| F6 | GitHub 403 (SSO/org policy/scope) | reason `scope-missing:<name>` or `sso-required`; account rejected or stored with pre-blocked streams per FR-010 | FR-010 |
| F7 | `expectedLogin` mismatch | `422 account-rejected`, fail closed, nothing persisted | FR-009 |
| F8 | Duplicate numeric id | `409` → panel offers rotation flow | FR-012 |
| F9 | Network offline | reason `network`; checkpoint/rate state untouched (no account yet) | FR-024 |
| F10 | Storage dir unwritable | `503 storage-unavailable` **before** accepting the token (pre-flight check on `/health`+`/v1/status`) | FR-039 |
| F11 | Consent declined/gated | Handoff button disabled with reason; no token typed state leaves the input | FR-008 |
| F12 | Token pasted into wrong field/other screens | Only the handoff input accepts a credential; all other renders use redaction guard | NFR-004 |

## 6. Custody rules (steady state)

- Exactly **one** copy of a token at rest: `accounts/<numericUserId>.json` (`0600`) in the service store; never duplicated into `host.storage`, backups of panel state, ledgers, or git (`.env.example` stays comment-only; `.gitignore` covers `.env*`).
- Tokens live only in service memory between requests; the in-memory map is cleared on graceful shutdown.
- Rotation replaces the at-rest copy atomically; old token bytes are not retained anywhere (no history of secrets).
- Revocation (on GitHub) + next poll → account `revoked`/`error` state, streams block with capability named, other accounts unaffected (spec Edge Case).
- The panel's *host-managed* optional integration card (FR-011) is a **separate** credential OpenChamber owns; it is never read into panel state and never used for polling/dispatch.

## 7. Threat notes for the reviewer (T-001 scope)

1. Loopback transit: token crosses panel→host→127.0.0.1 in the request body; host does not inspect it; TLS not applicable on loopback; service verifies bearer on every route (prevents other local processes from reading our store via *our* HTTP API — they must instead beat file permissions `0600`, same as any local secret file).
2. Advisory-permission service: an allowed service has full user access (GUEST_SERVICES.md); our mitigations are least-privilege *code* posture (stdlib only, read/write confined to our data dir, outbound only to `api.github.com`), audited startup, and the honest FR-008 consent copy.
3. Response/oracle surface: uniform 401 shape, no timing affordances beyond `timingSafeEqual`, no token-derived identifiers.
4. Backup exposure: the data dir is operator-controlled; quickstart documents that `accounts/*.json` contains plaintext credentials and must be protected like `~/.ssh`.

## 8. Sign-off

| Field | Value |
| --- | --- |
| Reviewer | `security-auditor` agent (task T-001) |
| Scope | this file + `panel-service.md` + FR-008 consent copy |
| Findings | _(recorded at review time)_ |
| Resolution | _(task T-002)_ |
| Gate G1 status | **OPEN** — closes when findings are resolved and this table is updated |
