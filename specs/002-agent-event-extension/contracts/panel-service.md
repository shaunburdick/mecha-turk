# Contract: Panel ↔ Service HTTP API (v1)

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27 · **Status**: binding for implementation; reviewed by security-auditor as task T-001 and **amended by T-002** (findings SEC-01…SEC-17 resolved — sign-off in [token-handoff.md](./token-handoff.md) §8; **gate G1 CLOSED 2026-09-27**).

**Transport**: `panel --serviceRequest--> host --HTTP 127.0.0.1:<ephemeral port>--> service` (001 research §b.9, GUEST_SERVICES.md). Request/response only; no streaming; no panel→loopback dialing; the panel never receives `OPENCHAMBER_SERVICE_TOKEN`.

## 1. Transport rules (non-negotiable)

| Rule | Value | Source |
| --- | --- | --- |
| Bind | `127.0.0.1:$OPENCHAMBER_SERVICE_PORT` only, never `0.0.0.0` | GUEST_SERVICES.md |
| Auth | `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` on **every** request, including `GET /health`. **Pinned fail-closed (SEC-02)**: (a) grammar = literal `Bearer` + exactly one space + a non-empty credential — missing header, any other scheme, `Bearer` alone, or an empty credential → `401` **before any other work**; (b) comparison = `sha256(provided)` vs `sha256(expected)` through `crypto.timingSafeEqual` (equal-length digests → constant length, **never throws**, no length probe); (c) authentication runs **before route/method resolution** — an unknown path with *valid* auth is `404`, with *invalid* auth is `401` (no route/method oracle); (d) `401` is reserved for bearer failure only and its body is **byte-identical** every time: `{ error: { code: 'unauthorized', message: 'service authentication failed' } }` (SEC-09) | GUEST_SERVICES.md, SEC-02, SEC-09 |
| Startup | The service **refuses to start** — exit non-zero *before binding*, on a log line that names the variable but never a value — when `OPENCHAMBER_SERVICE_TOKEN` is missing or shorter than **32 characters**. The host's readiness probe never turns green → panel `SERVICE_FAILED` (F16). *Floor = 32, set by T-002; it supersedes Wave 1's shipped 16 — `extension/service/env.ts` + tests updated in T-002* | SEC-02a, SEC-10d |
| Path | starts with `/`, no scheme, ≤2,000 chars (`GUEST_REQUEST_PATH_MAX`) | `contract.d.ts` |
| Request body | JSON only; service cap **60,000 chars** (host cap 64,000 minus margin); over → `413 { error: { code: 'payload-too-large', message } }`. Unparseable body → `400 invalid-json` (fixed message, no echo); a body that parses but is invalid for the route → `422 validation` with `issues[].field = 'body'` (or the offending field) — **values are never echoed** (SEC-10/SEC-11) | `GUEST_REQUEST_BODY_MAX`, SEC-10 |
| Response body | JSON; **must stay ≤ 256,000 chars** — every list endpoint paginates; the service measures serialized size before writing and truncates *pagination*, never data (`500 { code: 'response-too-large' }` if a guard trips) | `GUEST_REQUEST_RESPONSE_MAX` |
| Timeout | Leg timeout 20,000 ms; long-poll `waitMs` cap **10,000 ms** | `GUEST_REQUEST_TIMEOUT_MS` |
| Concurrency | **max 1 in-flight `POST /v1/accounts/verify`** (a concurrent second → `429 { code: 'verify-busy' }`); rolling cap **≤10 verify attempts / 5 min** → `429 rate-limited` with `retry-after`; **max 4 concurrent `GET /v1/dispatches` long-polls** (excess → immediate `{ runs: [], cursor }` or `429`). Throttle bookkeeping never echoes or logs a token (SEC-04) | SEC-04 |
| Methods | `GET`, `POST`, `PUT`, `DELETE` only | `GuestRequestMethod` |
| Errors | Always `{ error: { code: string, message: string, correlationId?: string } }`; `422` responses may add `error.issues?: [{ field, remediation }]` (**Wave 1 superset, ratified by T-002** — field names + remediation text only, **never** received values); `401` uses only the fixed body above. Messages never contain token material | FR-007/FR-024, SEC-09, SEC-11 |
| Versioning | Prefix `/v1`; additive changes only within v1; breaking changes → `/v2` + `state.json` migration | NFR-010 |

**Wave 1 ratifications (recorded by T-002, so the shipped code and this contract agree):**

1. **422 superset body** — `{ error: { code, message, correlationId?, issues?: [{ field, remediation }] } }` as shipped by T-006 (`error.issues` nested in the envelope); satisfies SEC-11 as long as no received value ever appears in an issue or the message.
2. **Transport codes** — `404 not-found`, `405 method-not-allowed` (+ `Allow` header), `400 bad-path` / `400 invalid-json`, `500 response-too-large` (catalogued in §4; SEC-09's unified `401` still wins over all of them).
3. **Wrappers & enums** — `GET/PUT /v1/config` answer `{ config }`; `service.status: 'ok' | 'degraded'`; `schemaVersion: number | null` (`null` while the store is unavailable).
4. **Token floor** — 32 characters (supersedes the 16 that shipped in Wave 1; code + tests updated in T-002).

Panel-side mapping of host transport errors: `NO_SERVICE` → "service not approved/not started" copy; `NOT_GRANTED` → install-approval instruction (same copy family as `NO_SERVICE`, never the bearer-failure copy); `DISABLED` → "extension disabled" copy; `SERVICE_FAILED` → `failed` health + manual retry button (no automatic retry loop) — includes a service that refused to start on a bad token (F16); `HOST_TIMEOUT` → soft miss on long-poll (cursor unchanged), surfaced as `degraded` after 3 consecutive misses, and the panel **re-reads `GET /v1/status` before declaring an account handoff failed** (SEC-05); `HOST_UNAVAILABLE` → "OpenChamber host is not reachable — restart the app" copy; `HOST_REJECTED` → "the host refused this request — re-approve the extension" copy; `BAD_PATH` → "malformed request path — this is a bug, report the correlation id" copy (never silent).

## 2. Endpoints

### 2.1 Lifecycle & health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Ready probe (host polls ≤15 s). `{ status: 'ok', version, schemaVersion }` — store-independent by design (readiness must not depend on the data dir; storage problems surface on `/v1/status` and store-backed 503s). No state. |
| `GET` | `/v1/status` | Full health model (FR-036): `{ service: { status: 'ok' \| 'degraded', uptimeMs, dataDir, schemaVersion: number \| null, storage: { writable: boolean } }, accounts: [{ numericUserId, login, connectionState, rate: RateState, streams: [{bindingId, state, blockedReason?}] }], repositories: [{ bindingId, lastPolledAt, checkpointAgeMs, state }], agentPin: { expectedAgent, lastVerification: {runKeyHash, observedAgent, ok, at} \| null }, polling: { intervalMs, nextPollAt, paused: boolean, pausedReason? }, surface: { supported: boolean } }`. **`service.storage.writable` (SEC-08)** is the handoff pre-flight: the panel **checks it before enabling the token input** (`false` → setup-prerequisite copy, input stays disabled) and re-checks the response outcome after submission (F14). `status: 'degraded'` with `schemaVersion: null` while the store is unusable (ratified shapes). *Implementation note: `storage` is contract-mandated by T-002 and not yet in the T-006 skeleton — it must land before T-019.* |
| `POST` | `/v1/lifecycle/shutdown` | Graceful shutdown (drain, persist, close) — used by tests and SIGTERM path (FR-037) |
| `GET` | `/v1/config` · `PUT` | ServiceConfig (interval, overlap, perPage, retry bounds, retention, logLevel) — both answer `{ config }` (ratified wrapper). Validation errors list field + remediation, **never received values** of any kind (FR-039, SEC-11) |

### 2.2 Accounts (credential custody — see [token-handoff.md](./token-handoff.md))

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/accounts/verify` | `{ token, expectedLogin?, consentVersion }` → `201 { numericUserId, login, state, verifiedAt, scopeCheck }` | Service calls GitHub `/user` (+ free `/rate_limit` probe) with **its own fetch**. Response never echoes the token. Duplicate id → `409` (rotate instead). Login mismatch → `422 account-rejected`. Missing/low `consentVersion` → `422 consent-required` (token-handoff §1.2) — checked **before** any network call. GitHub 401/403 → `422 credential-rejected` + `reasonClass` (§4). **Throttled**: 1 in-flight (concurrent → `429 verify-busy`), ≤10 attempts/5 min (→ `429` + `retry-after`); GitHub `429` during verify → `429 rate-limited` + `retry-after`, nothing persisted, panel clears the token (F15). |
| `POST` | `/v1/accounts/:numericUserId/token` | `{ token, consentVersion }` → `200 { numericUserId, login, verifiedAt }` | **Rotation (SEC-06)**: the service verifies the *new* token through `/user`; if its numeric id ≠ the path id → `422 account-rejected` and **nothing is persisted**; on success `login`/`scopeCheck`/`verifiedAt` refresh while `numericUserId`, checkpoints, deliveries, runs, and audit are unchanged (FR-012). Same consent + throttle rules as verify. |
| `GET` | `/v1/accounts` | → `200 { accounts: [...] }` | No credential fields, by construction |
| `DELETE` | `/v1/accounts/:numericUserId` | → `200 { removed: true }` | Manual only; refuses while bindings reference it (`409`) unless `?force=1`, which also disables those bindings (audited). **`?force=1` is an operator-confirmed action only** — never issued automatically (SEC-14) |

### 2.3 Repository bindings

| Method | Path | Body → Response |
| --- | --- | --- |
| `GET` | `/v1/bindings` | → `{ bindings: RepositoryBinding[] }` (no credential fields) |
| `PUT` | `/v1/bindings/:bindingId` | Partial binding `{ accountNumericUserId?, repository?, projectId?, triggers?, mentionToken?, worktreeOption?, policyProfileId?, state? }` → `200 { binding }`. Server validates state machine; invalid transition → `422 { error: { code: 'invalid-transition' } }` |
| `POST` | `/v1/bindings` | Create draft: `{ accountNumericUserId, repository }` → `201 { binding }` (`state: 'draft' \| 'project_missing'` until `projectId` set) |
| `DELETE` | `/v1/bindings/:bindingId` | → `200` (manual cleanup; checkpoints for it become `disabled`) |
| `POST` | `/v1/bindings/:bindingId/poll` | Operator "Poll now" → `202 { nextPollAt }` (respects rate budget; never bursts) |
| `POST` | `/v1/bindings/:bindingId/rescan` | `{ since: string }` controlled replay from timestamp → `202 { window }` — dedup keys unchanged, replays audited as duplicates (FR-023) |

### 2.4 Event relay & dispatch (the only way work leaves the service)

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/dispatches?cursor=<n>&waitMs=<0..10000>` | Long-poll. Returns immediately with dispatchable runs (`state: 'created'`, policy allows), else holds ≤`waitMs` then `{ runs: [], cursor }`. Each run: `{ runKeyHash, runKey, correlationId, bindingId, accountNumericUserId, projectId, source: { type, id, number, title, url, kind }, worktreeOption, attachItemId, context: { excerpt, delimiters }, policyDecision, lease: { leaseId, expiresAt, attempt } }`. Lease issued atomically; lease = single dispatch authorization (plan.md relay protocol). **Concurrency cap: max 4 held long-polls; an excess request answers immediately with `{ runs: [], cursor }` (or `429`) — never queued** (SEC-04). |
| `POST` | `/v1/runs/:runKeyHash/dispatch-result` | `{ leaseId, result: StartSessionResult-shaped }` → `200 { run }`. Wrong/expired lease → `409 stale-lease` (panel then runs reconciliation, never re-dispatches). Partial failures (`sessionId: null`) recorded and block per FR-030. |
| `POST` | `/v1/runs/:runKeyHash/verification` | `{ leaseId, observedAgent: string \| null, expectedAgent, ok, note? }` → `200 { run }`. Mismatch/unreadable → run `blocked:agent-mismatch`, audit entry written, **no further automated handling**. |
| `POST` | `/v1/runs/:runKeyHash/approval` | `{ decision: 'approve' \| 'reject', actor: string, reason?: string }` → `200 { run }` — only valid from `waiting_approval`; audited (FR-027). **Operator-confirmed action only**: reachable from an explicit panel confirmation, never automatic (SEC-14) |
| `POST` | `/v1/runs/:runKeyHash/reconcile` | `{ sessionId }` — attach-id recovery outcome (crash path) → `200 { run }` |
| `POST` | `/v1/runs/:runKeyHash/retry` | Operator-initiated retry from `blocked:*` → `202` **only if** cause flagged cleared; otherwise `409 { cause }` (FR-030) |

### 2.5 Queries for the panel

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/runs?state=&limit=&cursor=` | Paginated runs (default limit 25, max 50) with source link, policy decision, state, correlation id (SC-006) |
| `GET` | `/v1/runs/:runKeyHash` | One run incl. SessionRef + attempts |
| `GET` | `/v1/audit?correlationId=&entity=&limit=&cursor=` | Paginated AuditEntry rows (default 100, max 200) — **read-only**; append-only on disk |
| `GET` | `/v1/deliveries?bindingId=&state=&limit=` | Diagnostics for the Runs/Health views (bounded, redacted content only) |

## 3. Invariants asserted by contract tests

1. **Auth — pinned fail-closed (SEC-02, SEC-09)**: every route (incl. `/health`) rejects without the bearer token; a wrong token never yields a different error shape (no oracle). Sub-assertions:
   - **(a) startup**: the process exits non-zero *before binding*, logging only the variable name, when `OPENCHAMBER_SERVICE_TOKEN` is missing or shorter than 32 chars — a service never answers over an unauthenticated listener;
   - **(b) grammar**: literal `Bearer` + exactly one space + non-empty credential is the *only* accepted shape; missing header, wrong scheme, `Bearer` alone, empty credential, and extra/absent whitespace all → `401`;
   - **(c) comparison**: `sha256(provided)` vs `sha256(expected)` through `timingSafeEqual` — equal-length inputs by construction, so it never throws and header shape can never provoke a `500`;
   - **(d) ordering**: authentication runs before route/method resolution — unknown path **with valid auth** → `404`, unknown path with invalid auth → `401`;
   - **(e) byte-identical 401**: the response body for missing, malformed, length-mismatched, and wrong-value credentials is byte-for-byte the same `{ error: { code: 'unauthorized', message: 'service authentication failed' } }`, and `401` is used for bearer failure *only* (a GitHub verdict is `422 credential-rejected`, never `401`).
2. **No GitHub from the panel**: the panel codebase contains no GitHub fetch path; its only outbound calls are `serviceRequest` and documented host calls (test: static import scan + fake-host harness).
3. **No token in responses**: serialized bodies of every endpoint are scanned against token-shaped patterns (AC-001, NFR-004).
4. **Idempotency**: replaying any relayed run's `dispatch-result`/`verification` with the same lease returns the same run state; a consumed lease cannot authorize a second `startSession` (NFR-002).
5. **Size guard**: every list response ≤ `GUEST_REQUEST_RESPONSE_MAX` (fixture: max-page renders stay under 256,000 chars).
6. **Fail-closed**: unknown run, stale lease, invalid state transition, missing policy, unapproved service capability → explicit error codes, never silent success (NFR-005).
7. **Fail-safe availability**: `GET /v1/dispatches` with `waitMs=0` is the panel's health probe; `SERVICE_FAILED` never auto-loops (panel retries only on operator action) (AC-018).
8. **Consent gate (SEC-01)**: no `POST /v1/accounts/verify` or `POST /v1/accounts/:id/token` request without a **current** `consentVersion` returns 2xx — absent/low version → `422 consent-required` *before* any GitHub call; a request with the current version records exactly one `consent` audit occurrence `{ version, givenAt }` (replay of the same version writes nothing); consent occurrences contain no token bytes; the panel re-prompts when its stored `version < CONSENT_VERSION` (AC-002, FR-008).
9. **Throttles (SEC-04)**: a second concurrent verify → `429 verify-busy`; more than 10 verify attempts in a rolling 5 minutes → `429 rate-limited` + `retry-after`; more than 4 concurrent long-polls → immediate empty result (or `429`). Throttle state is never serialized into a response and never logged with a token (SEC-11).
10. **No credential logging (SEC-11)**: the `Authorization` header and the request bodies of `/v1/accounts/verify` and `/v1/accounts/:id/token` appear in **no** log line at any level in any format, and no `422` issue ever carries a received value — only `field` + `remediation`. *Test (implementation task): force a `500` on verify and scan the entire captured log output for the registered token — zero occurrences (feeds the NFR-004 suite, T-031).*
11. **Panel rendering (SEC-14)**: service-supplied strings are rendered via `textContent` / text nodes — never `innerHTML`, `insertAdjacentHTML`, or any HTML sink. *Test: static scan of the panel for HTML sinks on service-fed fields + a DOM assertion with a hostile `<img onerror>` login title (redaction ≠ escaping — token-handoff §4 rule 5).*

## 4. Error code catalog

| HTTP | `code` | Meaning | Panel copy |
| --- | --- | --- | --- |
| 400 | `bad-path` | Request target is not an origin-form path on loopback (transport, ratified) | Internal — "malformed request path; report the correlation id" |
| 400 | `invalid-json` | Body could not be parsed as JSON — fixed message, **no echo of the body** (transport, ratified). Structurally invalid *but parseable* bodies are `422 validation` with `issues[].field = 'body'` | Internal — "request was malformed; this is a bug" |
| 401 | `unauthorized` | **Bearer failure only** (missing/malformed/length-mismatch/wrong value) — reserved by SEC-03; body byte-identical in every case: `{ error: { code: 'unauthorized', message: 'service authentication failed' } }` | "Service authentication failed — reinstall/approve the extension" |
| 404 | `not-found` · `unknown-run` · `unknown-binding` · `unknown-account` | Unknown path with **valid** auth (transport, ratified), or no such entity | Shows entity id, offers refresh |
| 405 | `method-not-allowed` | Known path, wrong method — answers with `Allow` (transport, ratified) | Internal — "unsupported method; report the correlation id" |
| 409 | `stale-lease` · `duplicate-account` · `invalid-transition` · `cause-not-cleared` | Concurrency/state guards | Explains guard; retry guidance |
| 413 | `payload-too-large` | >60,000 chars | Internal (should never surface) |
| 422 | `account-rejected` | Identity disagreement: `expectedLogin` ≠ `/user` login (F7), or rotation's `/user` numeric id ≠ path id (SEC-06) — always `422`, never `409` | "Token identity does not match the expected account" (no token echo) |
| 422 | `consent-required` | `consentVersion` absent or below the current `CONSENT_COPY_V1` version (SEC-01) — rejected before any GitHub call | "Consent needs renewing — review and accept the handoff notice again" |
| 422 | `credential-rejected` | GitHub rejected the presented PAT. `reasonClass:` **`auth-failed`** → "GitHub rejected this token — create a fresh PAT and paste it again"; **`scope-missing:<capability>`** → "This token is missing the `<capability>` scope — update the token, then paste it again"; **`sso-required`** → "Your organization requires SSO — authorize the token for this org, then paste it again". **HTTP 401 is never used for these** (SEC-03) | Inline, reason-specific — always "no token echo" |
| 422 | `validation` | Field-level: `error.issues[].{field, remediation}` (ratified superset) — **received values never echoed**, including `field: 'body'` for a structurally invalid body (SEC-10/SEC-11) | Inline field errors with remediation text |
| 429 | `verify-busy` | A verify is already in flight — max 1 concurrent (SEC-04) | "A verification is already running — wait a moment, then retry" |
| 429 | `rate-limited` | GitHub primary/secondary limit (polling, or during verify with `retry-after`). **During verify**: nothing persisted, panel clears the token, **no automatic retry** — the operator re-pastes after the stated time (F15) | "Delayed — next attempt at <time>" |
| 500 | `internal` | Unexpected, correlationId attached | "Report this correlation id"; no stack in body |
| 500 | `response-too-large` | Serialized response exceeded the 256,000-char cap; service errors instead of truncating data (ratified) | Internal — pagination is the fix |
| 503 | `storage-unavailable` | Data dir unwritable — surfaced by the pre-flight (`service.storage.writable: false`) *and* by any store-backed route after submission (F14: nothing persisted, token cleared, manual retry) | Setup prerequisite failure (FR-039) |

**Non-HTTP failure (SEC-10d)**: a missing/short `OPENCHAMBER_SERVICE_TOKEN` never produces a response at all — the process exits non-zero before binding (F16) and the host reports `SERVICE_FAILED`; panel copy: "The local service did not start — the service token is missing or too short; reinstall/approve the extension or check the host's service environment." (never echoes the environment).

## 5. Out of scope for this contract

- GitHub endpoint shapes (service-internal adapter; see research §R6 and 001 §a).
- Panel UI layout (app-level).
- Host APIs (`startSession`, `openSession`, `listProjects`…) — documented SDK surface, covered by [events-carry-forward.md](./events-carry-forward.md) pointers to 001 `contracts/openchamber.md`.
