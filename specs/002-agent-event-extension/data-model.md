# Data Model: Agent Event Extension (Production)

**Feature**: `specs/002-agent-event-extension` · **Spec**: v1.0.0 · **Date**: 2026-09-27

Conventions:

- **Service tier** = durable store under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename writes, NDJSON append for audit). This tier is authoritative for everything listed as *durable* below and is the audit home (FR-033).
- **Panel tier** = `host.storage` (extension-namespaced keys, 64 KiB/value, 2 MiB/2,000-key namespace, **wiped on uninstall** — FR-034). UI state and bounded display mirrors only; never the sole home of audit, checkpoints, or runs.
- JSON field names are **camelCase** in both tiers (repo lint `@typescript-eslint/naming-convention`; same reasoning as contract amendment 1 in 001 `contracts/openchamber.md`). The wire event schema keeps 001 `events.md` as the semantic reference — mapping in `contracts/events-carry-forward.md`.
- Provider ids and GitHub numbers are **strings** in storage; timestamps are RFC3339 UTC strings; durations are integer milliseconds.
- **Secrets are never fields anywhere below.** The credential is the one exception and lives only in `Account.credential`, which no response, log, audit entry, or panel surface may ever read (token-handoff contract §Redaction).

---

## Storage tier 1 — service durable store

### Files layout

```text
$HOME/.config/openchamber/mecha-turk/
├── config.json            # ServiceConfig (operator-editable via PUT /v1/config)
├── accounts/<numericUserId>.json   # Account incl. credential (0600)
├── bindings.json          # RepositoryBinding[]
├── checkpoints/<account>-<repoId>-<stream>.json
├── deliveries.json        # delivery-key index (dedup), bounded by retention
├── runs/<runKeyHash>.json # Run + SessionRef
├── rate/<account>.json    # RateState per account
├── audit.ndjson           # append-only AuditEntry lines (retention-trimmed)
└── state.json             # service schema version, last cursor, migration marker
```

### Account

| Field | Type | Constraints |
| --- | --- | --- |
| `numericUserId` | string | **durable key** = GitHub `/user.id`; never the login (FR-009) |
| `login` | string | display-only, ≤200 chars; rename updates this field only (AC-004) |
| `expectedLogin` | string \| null | optional; mismatch with `/user` → account rejected, fail closed (FR-009) |
| `credential` | `{ token: string, kind: 'fine-grained' \| 'classic' \| 'unknown', verifiedAt: string }` | file mode 0600; **never** in any API response, log, audit, or panel state (FR-007) |
| `scopeCheck` | `{ checkedAt: string, results: Record<'metadata'\|'issues'\|'pull-requests'\|'contents', 'ok'\|'missing'\|'unknown'> }` | missing → affected streams block with the capability named (FR-010) |
| `state` | `'pending_handoff' \| 'verifying' \| 'active' \| 'rejected' \| 'revoked' \| 'error'` | see transitions |
| `connectionState` | `'connected' \| 'auth-failed' \| 'rate-limited' \| 'offline'` | derived from last poll outcome, exposed in health |
| `createdAt`, `updatedAt` | string | RFC3339. `updatedAt` stamps **record-shape** changes only: a rotation refreshes `verifiedAt` and deliberately leaves `updatedAt` untouched (contract §6), so "when was this credential last proven?" is answered by `verifiedAt`, not by the file's rewrite time (T-009m) |

**Transitions**: `pending_handoff → verifying` (handoff received) → `active` (verified) | `rejected` (login mismatch / `/user` failure). `active → error` (transient auth/network failure), `active → revoked` (401 on poll), `error → active` (next successful poll). Only `active` accounts poll (spec States).

**Stale states (T-009m)**: `pending_handoff` and `verifying` are declared by this model but are **not produced by the current handoff flow** — the service persists an account only after `/user` succeeds, so an interrupted handoff leaves either a complete `active` record or no record at all. They are retained for crash/foreign-file recovery: startup reconciliation defensively re-verifies any record found in them or marks it `error:interrupted-handoff` (F13). The transition is therefore reachable *in storage* (an older build, a hand edit) but is never written by application code today.

**Rotation**: `POST /v1/accounts/:numericUserId/token` replaces `credential` **in place** — `numericUserId`, checkpoints, deliveries, runs, audit untouched (FR-012).

### RepositoryBinding

| Field | Type | Constraints |
| --- | --- | --- |
| `bindingId` | string | UUID, panel-tier-safe (≤64 chars) |
| `repository` | `{ id: string, owner: string, name: string }` | GitHub repo **id** durable; owner/name display |
| `accountNumericUserId` | string | FK → Account; each account polls only its own bindings (FR-016) |
| `projectId` | string \| null | resolved from `host.listProjects()`; `null` = `project_missing` (FR-014) |
| `triggers` | `{ issueAssignment: boolean, reviewRequest: boolean, mention: boolean }` | at least one true or binding is `disabled` (FR-015) |
| `mentionToken` | string \| null | `null` → default `@<account.login>`; case-insensitive match (FR-015) |
| `worktreeOption` | `'none' \| 'generated' \| \`new:${string}\`` | default `generated`; `new:` supports `{number}` only (spec Assumption) |
| `policyProfileId` | string | FK → PolicyProfile; default `default` |
| `state` | `'draft' \| 'project_missing' \| 'active' \| 'blocked' \| 'disabled'` | `blocked` carries `blockedReason: string` |
| `createdAt`, `updatedAt`, `lastPolledAt` | string \| null | RFC3339 / null before first poll |

**Transitions**: `draft → project_missing` (no registered project) `→ active` (project selected) ; `active → blocked` (credential/scope/API failure, reason required) ; `active → disabled` (operator; stops polling) ; `blocked → active` (cause cleared, audited) ; any → `draft` (major config change, e.g. account removed).

### Checkpoint

One per `(accountNumericUserId, repositoryId, stream)` where `stream ∈ issues | issue_comments | pulls`.

| Field | Type | Constraints |
| --- | --- | --- |
| `stream` | `'issues' \| 'issue_comments' \| 'pulls'` | endpoint/filter identity lives here (FR-018) |
| `filters` | `{ query: Record<string,string> }` | the exact query used, minus page cursor |
| `lastObservedId` | string \| null | provider item id; **not sufficient alone** (FR-019) |
| `lastObservedAt` | string \| null | provider timestamp driving overlap window |
| `page` | `{ sinceId: string \| null, sinceTime: string \| null, hasNext: boolean }` | pagination position; window complete only when `hasNext=false` (FR-020) |
| `validators` | `{ etag: string \| null, lastModified: string \| null }` | optimization only, never load-bearing (FR-021) |
| `lastPolledAt`, `nextPollAt` | string | RFC3339 |
| `retry` | `{ attempts: number, backoffMs: number, nextAttemptAt: string \| null, lastErrorClass: string \| null }` | bounded exponential backoff + jitter (FR-022) |
| `accountScope` | `{ numericUserId: string, scopeSnapshot: string }` | credential scope at last poll (FR-018) |
| `state` | `'uninitialized' \| 'active' \| 'backing_off' \| 'stale' \| 'blocked' \| 'disabled'` | see transitions |

**Transitions** (spec States): `uninitialized → active` after first fully durable window; `active → backing_off` (429/5xx/timeout) `→ active` (next attempt succeeds) ; `active → blocked` (401/403/unsupported response/identity failure) ; `active → stale` (no successful poll > 3× interval, surfaced in health) ; any → `disabled` (binding disabled). **Advances only in the same atomic write that durably represents the full fetched window** (FR-018, FR-020).

### Delivery (normalized event)

| Field | Type | Constraints |
| --- | --- | --- |
| `schemaVersion` | `'1.1'` | v1.1 = 001 `events.md` v1 + `deliveryKey` (see carry-forward contract) |
| `deliveryKey` | string | `sha256(provider ‖ accountNumericUserId ‖ repositoryId ‖ sourceType ‖ sourceId ‖ eventKind)` hex — dedup identity (FR-019) |
| `provider` | `'github'` | fixed |
| `accountNumericUserId`, `repository` | string / `{id, owner, name}` | source identity scope |
| `source` | `{ type, id, updatedAt, url }` | `type ∈ issue \| issue_comment \| pull_request \| pull_request_review` |
| `kind` | `'mention' \| 'issue_assignment' \| 'review_request' \| 'review_assignment'` | FR-015 set |
| `subject` | `{ type: 'issue' \| 'pull', number: string, baseRef: string \| null, headSha: string \| null }` | head SHA retained for drift detection (FR-026) |
| `content` | `{ excerpt: string, authorId: string, deleted: boolean, truncated: boolean }` | excerpt ≤4,000 chars, untrusted, delimiter-marked (FR-028) |
| `correlationId` | string (UUID) | traces the whole chain (NFR-007) |
| `observedAt`, `sourceUpdatedAt` | string | overlap/dedup inputs |
| `state` | `'discovered' \| 'ignored' \| 'duplicate' \| 'queued' \| 'processing' \| 'dispatched' \| 'dead_lettered'` (+ `blocked` pre-dispatch) | see transitions |

Immutable after write except `state` (append-only payload, FR-035). **Transitions**: `discovered → ignored | duplicate | queued` → `processing` → `dispatched | blocked | dead_lettered`. `duplicate` is recorded (audited) whenever a delivery key already exists inside the overlap/retention window — including the 100× replay case (NFR-002).

### Run

| Field | Type | Constraints |
| --- | --- | --- |
| `runKey` | string | `sha256(provider ‖ accountNumericUserId ‖ repositoryId ‖ subjectType ‖ subjectNumber ‖ actionClass)` hex — deterministic (FR-030) |
| `runKeyHash` | string | first 32 hex chars → filename |
| `deliveryKeys` | string[] | run←deliveries link; assignment+mention collision = 2 keys, 1 run (spec Edge Case) |
| `projectId`, `bindingId`, `accountNumericUserId` | string | routing inputs |
| `policyDecision` | PolicyEntry (embedded) | recorded before dispatch (FR-027) |
| `worktreeOption` | binding's option at dispatch time | snapshot |
| `attachItemId` | string | `mt-run-${runKeyHash[0:24]}` — deterministic, ≤128 chars; crash reconciliation key |
| `lease` | `{ leaseId: string, expiresAt: string, attempt: number } \| null` | single-use dispatch lease; null when not relayed |
| `dispatch` | `{ sessionId: string, sent: string, directory?: string, worktree?: ..., linked?: boolean, at: string } \| null` | complete `StartSessionResult` capture incl. partial failures |
| `verification` | `{ observedAgent: string \| null, expectedAgent: string, ok: boolean, at: string, note?: string } \| null` | FR-029 |
| `state` | see below | |
| `blockedReason` | string \| null | required whenever `state` starts with `blocked` |
| `attempts` | number | each attempt audited |
| `correlationId` | string | shared with deliveries/audit |
| `createdAt`, `updatedAt` | string | |

**States** (spec): `created → dispatching → verifying_agent → dispatched`, plus `waiting_approval`, `blocked:agent-mismatch | blocked:project-missing | blocked:credential | blocked:policy | blocked:source-changed | blocked:dispatch-unknown`, `retrying`, `completed`, `dead_lettered`.

**Transitions**:

- `created` — relayed (lease issued) → `dispatching`.
- `dispatching` + result posted → `verifying_agent`; verification ok → `dispatched` → (panel observes `onSessionLifecycle`) → `completed` when the session reaches a terminal phase; verification fail → `blocked:agent-mismatch` (no further automated handling, FR-029).
- `dispatching` + lease expired without result → `blocked:dispatch-unknown`; cleared **only** by attach-id reconciliation via `listSessions().items` (found → resume `verifying_agent` with the recovered `sessionId`; not found → operator-confirmed `retrying`, same run key, audited).
- `created` with a policy gate → `waiting_approval` → approval → `created` (re-queued); rejection → `blocked:policy`.
- Any `blocked` → `retrying` **only** when the named cause clears, same run key, each attempt audited (FR-030).
- A run whose `dispatch.sessionId` is non-empty **never** re-enters `dispatching` (FR-030 hard rule).

### SessionRef

Stored inside `Run.dispatch` plus a lightweight index row for the panel mirror. OpenChamber stays authoritative; we store only the pointer.

| Field | Type | Constraints |
| --- | --- | --- |
| `sessionId` | string | host-owned; never mutated |
| `title`, `sourceUrl` | string | display + source link |
| `dispatchedAt` | string | RFC3339 |
| `observedAgent`, `observedModel` | string \| null | from `onSession().agent/.model`; `GUEST_SESSION_AGENT_MAX` 80 |
| `verificationStatus` | `'pending' \| 'verified' \| 'mismatch' \| 'unreadable'` | fail-closed on `mismatch`/`unreadable` |
| `worktree` | `{ directory, name, branch } \| null` | host-reported |

No session, worktree, or project is ever created, mutated, or deleted outside `host.startSession()` (FR-004/FR-005/FR-040).

### PolicyProfile and PolicyEntry

**PolicyProfile** (config, `config.json`):

| Field | Type | Constraints |
| --- | --- | --- |
| `id` | string | `default` ships; per-binding selectable |
| `version` | integer | bumped on every edit; recorded in decisions |
| `gates` | `Record<'start_work', boolean>` | autonomous **default = false (no gate)**; missing profile → fail closed for that action (FR-027) |
| `effectiveAt` | string | |

**PolicyEntry** (durable decision record, embedded in Run and mirrored as an audit entry):

| Field | Type | Constraints |
| --- | --- | --- |
| `policyVersion` | integer | |
| `actorSource` | `'operator' \| 'service:auto' \| 'github-event'` | |
| `action` | `'start_work'` | future write/merge gates exist only as documented statements (FR-027/FR-032) |
| `decision` | `'allow' \| 'require-approval' \| 'deny'` | |
| `reason` | string | human-readable, no secrets |
| `decidedAt` | string | |

### AuditEntry (`audit.ndjson`, append-only)

| Field | Type | Constraints |
| --- | --- | --- |
| `seq` | number (monotonic) | assigned by the writer |
| `timestamp` | string | RFC3339 |
| `correlationId` | string | NFR-007 chain |
| `eventType` | string enum | `consent`, `account.added/verified/rejected/rotated/error/deleted`, `binding.*`, `poll.checkpoint/observation/duplicate`, `rate.*`, `policy.decision`, `run.created/relayed/dispatched/verified/blocked/retried/dead_lettered`, `service.started/stopped/failed`, `config.changed`, `audit.trimmed` |
| `actorSource` | string | e.g. `panel`, `service`, `operator` |
| `entity` | `{ kind: 'service' \| 'account' \| 'binding' \| 'run' \| 'delivery', id: string }` | `service` for entries that reference no account (consent occurrences, identity-less credential rejections) |
| `decision`, `reason` | string \| null | |
| `redaction` | `{ redacted: boolean, fields: string[] }` | which fields were stripped |
| `details` | JSON (pre-redaction pass) | **no token material, ever** (FR-035) |

> **Amended 2026-09-27 during implementation (T-007–T-009)** to match the
> G1-amended contracts: `eventType` gained `account.error` (contract F13
> writes it) and `account.deleted` (FR-035 terminal outcome); `entity.kind`
> gained `service` for entries that reference no account; storage tier 2
> gained the `accounts` mirror that token-handoff §3 requires.

Retention (spec Assumption): 180 days **or** 50,000 entries, whichever first; payload excerpts 30 days; minimal references (ids/links/decisions) kept until the account/binding is deleted. Trims write an `audit.trimmed` entry first (the trim itself is auditable).

### RateState (per account)

`{ remaining: number|null, limit: number|null, resetAt: string|null, usedLastHour: number, secondaryBlockedUntil: string|null, conditionalSupport: 'unknown'|'yes'|'no', updatedAt }` — shared across all repositories bound to the account (FR-022), rendered in health.

---

## Storage tier 2 — panel `host.storage` (UI state, uninstall-wiped)

| Key (namespace `mecha-turk:`) | Type | Contents / limits |
| --- | --- | --- |
| `ui` | JSON | active tab, filters, last-viewed run, sort; ≤4 KiB |
| `project` | string | selected project id (spike key retained; precedence rules unchanged, 001 amendment 4) |
| `consent` | `{ givenAt: string, version: 1 }` | **occurrence only** — no token material; mirrors the service audit `consent` entry (FR-008) |
| `accounts` | JSON array | bounded account mirror `{ numericUserId, login, state, scopeCheck }` written after a successful handoff — display only, never authoritative, never a credential (token-handoff §3) |
| `expected-agent` mirror | string | effective value + provenance (integration setting vs default) for display |
| `runs-mirror` | JSON array | **bounded** display mirror of the latest ≤50 runs `{ runKeyHash, state, sourceUrl, correlationId, updatedAt }` — never authoritative, never an audit home (FR-034) |
| `health-mirror` | JSON | last rendered `ServiceHealth` snapshot + `fetchedAt`; stale-render guard |
| `handoff-guard` | never present | **assertion-tested key**: writing any key whose serialized value matches token-shaped patterns must fail (NFR-004 scan includes this key set) |

**Wipe semantics**: all of the above are deleted on extension uninstall (documented); the panel shows the "what was wiped" checklist from `health-mirror`-independent copy, and the service store is untouched (research R2, verified by T-033).

---

## Relationships

```
Account (1) ──< RepositoryBinding (N) ──< Checkpoint (N×streams)
Account (1) ──< RateState (1)
RepositoryBinding (N) ──> PolicyProfile (1)
Delivery (N) ──> Run (1)   [via deliveryKeys; collision ⇒ 2:1]
Run (1) ──> SessionRef (0..1)
Run (1) ──> PolicyEntry (1)
Every entity ──> AuditEntry (0..N, correlationId)
```

## Validation scenarios (drive contract tests)

1. Fresh store: no accounts → `/v1/status` reports `config-incomplete`, no polling (FR-039).
2. Account verify returns login/id; response body scanned for token bytes (AC-001/AC-003).
3. Checkpoint interrupted mid-page → prior checkpoint retained; resume re-scans overlap, duplicates recorded (AC-007).
4. 100× replay of one window → zero new deliveries-in-run/runs/sessions (AC-008).
5. Policy removed → `start_work` decision = `deny`, run blocked with `blocked:policy` (AC-011).
6. Verification mismatch/unreadable → `blocked:agent-mismatch` + audit + panel warning (AC-013).
7. Service killed → `serviceStatus()=failed`, all files intact, manual retry resumes under same run keys (AC-018).
8. Uninstall → service store still present and readable (T-033, AC-015/AC-017/SC-007).
