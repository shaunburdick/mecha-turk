# Contract: Panel ↔ Service HTTP API (v1)

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27 · **Status**: binding for implementation; reviewed by security-auditor as task T-001.

**Transport**: `panel --serviceRequest--> host --HTTP 127.0.0.1:<ephemeral port>--> service` (001 research §b.9, GUEST_SERVICES.md). Request/response only; no streaming; no panel→loopback dialing; the panel never receives `OPENCHAMBER_SERVICE_TOKEN`.

## 1. Transport rules (non-negotiable)

| Rule | Value | Source |
| --- | --- | --- |
| Bind | `127.0.0.1:$OPENCHAMBER_SERVICE_PORT` only, never `0.0.0.0` | GUEST_SERVICES.md |
| Auth | `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` on **every** request, including `GET /health`; compared with `crypto.timingSafeEqual`; missing/wrong → `401 { error: 'unauthorized' }` | GUEST_SERVICES.md |
| Path | starts with `/`, no scheme, ≤2,000 chars (`GUEST_REQUEST_PATH_MAX`) | `contract.d.ts` |
| Request body | JSON only; service cap **60,000 chars** (host cap 64,000 minus margin); over → `413 { error: 'payload-too-large' }` | `GUEST_REQUEST_BODY_MAX` |
| Response body | JSON; **must stay ≤ 256,000 chars** — every list endpoint paginates; the service measures serialized size before writing and truncates *pagination*, never data (`{ error: 'response-too-large' }` if a guard trips) | `GUEST_REQUEST_RESPONSE_MAX` |
| Timeout | Leg timeout 20,000 ms; long-poll `waitMs` cap **10,000 ms** | `GUEST_REQUEST_TIMEOUT_MS` |
| Methods | `GET`, `POST`, `PUT`, `DELETE` only | `GuestRequestMethod` |
| Errors | Always `{ error: { code: string, message: string, correlationId?: string } }`; messages never contain token material | FR-007/FR-024 |
| Versioning | Prefix `/v1`; additive changes only within v1; breaking changes → `/v2` + `state.json` migration | NFR-010 |

Panel-side mapping of host transport errors: `NO_SERVICE` → "service not approved/not started" copy; `DISABLED` → "extension disabled" copy; `SERVICE_FAILED` → `failed` health + manual retry button (no automatic retry loop); `HOST_TIMEOUT` → soft miss on long-poll (cursor unchanged), surfaced as `degraded` after 3 consecutive misses.

## 2. Endpoints

### 2.1 Lifecycle & health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Ready probe (host polls ≤15 s). `{ status: 'ok', version, schemaVersion }`. No state. |
| `GET` | `/v1/status` | Full health model (FR-036): `{ service: { status, uptimeMs, dataDir, schemaVersion }, accounts: [{ numericUserId, login, connectionState, rate: RateState, streams: [{bindingId, state, blockedReason?}] }], repositories: [{ bindingId, lastPolledAt, checkpointAgeMs, state }], agentPin: { expectedAgent, lastVerification: {runKeyHash, observedAgent, ok, at} \| null }, polling: { intervalMs, nextPollAt, paused: boolean, pausedReason? }, surface: { supported: boolean } }` |
| `POST` | `/v1/lifecycle/shutdown` | Graceful shutdown (drain, persist, close) — used by tests and SIGTERM path (FR-037) |
| `GET` | `/v1/config` · `PUT` | ServiceConfig (interval, overlap, perPage, retry bounds, retention, logLevel). Validation errors list field + remediation, never values that could be secret (FR-039) |

### 2.2 Accounts (credential custody — see [token-handoff.md](./token-handoff.md))

| Method | Path | Body → Response | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/accounts/verify` | `{ token, expectedLogin? }` → `201 { numericUserId, login, state, verifiedAt, scopeCheck }` | Service calls GitHub `/user` (+ free `/rate_limit` probe) with **its own fetch**. Response never echoes the token. Duplicate id → `409` (rotate instead). Login mismatch → `422 account-rejected`. |
| `POST` | `/v1/accounts/:numericUserId/token` | `{ token }` → `200 { numericUserId, login, verifiedAt }` | Rotation; preserves checkpoints/deliveries/runs/audit (FR-012) |
| `GET` | `/v1/accounts` | → `200 { accounts: [...] }` | No credential fields, by construction |
| `DELETE` | `/v1/accounts/:numericUserId` | → `200 { removed: true }` | Manual only; refuses while bindings reference it (`409`) unless `?force=1`, which also disables those bindings (audited) |

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
| `GET` | `/v1/dispatches?cursor=<n>&waitMs=<0..10000>` | Long-poll. Returns immediately with dispatchable runs (`state: 'created'`, policy allows), else holds ≤`waitMs` then `{ runs: [], cursor }`. Each run: `{ runKeyHash, runKey, correlationId, bindingId, accountNumericUserId, projectId, source: { type, id, number, title, url, kind }, worktreeOption, attachItemId, context: { excerpt, delimiters }, policyDecision, lease: { leaseId, expiresAt, attempt } }`. Lease issued atomically; lease = single dispatch authorization (plan.md relay protocol). |
| `POST` | `/v1/runs/:runKeyHash/dispatch-result` | `{ leaseId, result: StartSessionResult-shaped }` → `200 { run }`. Wrong/expired lease → `409 stale-lease` (panel then runs reconciliation, never re-dispatches). Partial failures (`sessionId: null`) recorded and block per FR-030. |
| `POST` | `/v1/runs/:runKeyHash/verification` | `{ leaseId, observedAgent: string \| null, expectedAgent, ok, note? }` → `200 { run }`. Mismatch/unreadable → run `blocked:agent-mismatch`, audit entry written, **no further automated handling**. |
| `POST` | `/v1/runs/:runKeyHash/approval` | `{ decision: 'approve' \| 'reject', actor: string, reason?: string }` → `200 { run }` — only valid from `waiting_approval`; audited (FR-027) |
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

1. **Auth**: every route (incl. `/health`) rejects without the bearer token; a wrong token never yields a different error shape (no oracle).
2. **No GitHub from the panel**: the panel codebase contains no GitHub fetch path; its only outbound calls are `serviceRequest` and documented host calls (test: static import scan + fake-host harness).
3. **No token in responses**: serialized bodies of every endpoint are scanned against token-shaped patterns (AC-001, NFR-004).
4. **Idempotency**: replaying any relayed run's `dispatch-result`/`verification` with the same lease returns the same run state; a consumed lease cannot authorize a second `startSession` (NFR-002).
5. **Size guard**: every list response ≤ `GUEST_REQUEST_RESPONSE_MAX` (fixture: max-page renders stay under 256,000 chars).
6. **Fail-closed**: unknown run, stale lease, invalid state transition, missing policy, unapproved service capability → explicit error codes, never silent success (NFR-005).
7. **Fail-safe availability**: `GET /v1/dispatches` with `waitMs=0` is the panel's health probe; `SERVICE_FAILED` never auto-loops (panel retries only on operator action) (AC-018).

## 4. Error code catalog

| HTTP | `code` | Meaning | Panel copy |
| --- | --- | --- | --- |
| 401 | `unauthorized` | Missing/wrong bearer token | "Service authentication failed — reinstall/approve the extension" |
| 404 | `unknown-run` / `unknown-binding` / `unknown-account` | No such entity | Shows entity id, offers refresh |
| 409 | `stale-lease` · `duplicate-account` · `invalid-transition` · `cause-not-cleared` | Concurrency/state guards | Explains guard; retry guidance |
| 409/422 | `account-rejected` | `/user` disagrees with `expectedLogin` | "Token identity does not match expected login" (no token echo) |
| 413 | `payload-too-large` | >60,000 chars | Internal (should never surface) |
| 422 | `validation` | Field-level, remediation-named | Inline field errors |
| 429 | `rate-limited` | GitHub secondary/primary limit for that account | "Delayed — next attempt at <time>" |
| 500 | `internal` | Unexpected, correlationId attached | "Report this correlation id"; no stack in body |
| 503 | `storage-unavailable` | Data dir unwritable | Setup prerequisite failure (FR-039) |

## 5. Out of scope for this contract

- GitHub endpoint shapes (service-internal adapter; see research §R6 and 001 §a).
- Panel UI layout (app-level).
- Host APIs (`startSession`, `openSession`, `listProjects`…) — documented SDK surface, covered by [events-carry-forward.md](./events-carry-forward.md) pointers to 001 `contracts/openchamber.md`.
