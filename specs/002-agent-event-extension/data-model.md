# Data Model: Agent Event Extension (Production)

**Feature**: `specs/002-agent-event-extension` · **Spec**: v1.0.0 · **Date**: 2026-09-27

> **Historical-path note (2026-09-28, cleanup review).** Short-form `001 …` citations in this file (contract amendment 1 in 001 `contracts/openchamber.md`, 001 `events.md` v1, "001 amendment 4") refer to the `specs/001-agent-event-orchestrator/` directory **removed in commit `110c0a2`**. They are stamped provenance: recover with `git show 110c0a2^:specs/001-agent-event-orchestrator/<file>`; the live event schema is `contracts/events-carry-forward.md`, and the production model is this file.

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
| `allowedUsers` | `string[]` \| **absent** | **added at v1.11.0 (FR-047).** GitHub logins permitted to trigger this binding. **Three states, no fourth:** key **absent** = no policy configured, any human actor may trigger; **non-empty** = exactly those logins, compared **case-insensitively** with the submitted spelling preserved verbatim; an explicitly **empty array `[]` is a refusal**, not "anyone" and not "nobody" — the way to stop every trigger is to disable the binding, which `state` already models. Validated on **every read and every write** by the one reader in `service/bindings.ts` (a hand-edited file and a panel save are judged by one rule set). Per element: a GitHub login — ≤39 characters, alphanumeric with single interior hyphens, never leading/trailing hyphen (research §R9). **No list-length cap** (plan D6): boundedness is carried by the per-login bound, `MAX_BINDINGS = 100`, and the transport body cap. **A `[bot]` login is accepted and inert** (plan D7): detection filters bots for all four trigger kinds, so no bot event ever exists to be admitted. Lives **only** in `bindings.json` — never in `host.storage`, never in the ledger, never in an audit row, never in a run record, never in a projection, never in a bundle (NFR-113). |
| `repository` (shape note, v1.11.0) | exactly one `owner/name` | **Exactly one repository per binding, permanently** (FR-048). A plural `repository` and a wildcard are forbidden and load-bearing, not merely unbuilt: `projectId` flows `binding.projectId` → the enqueued event → the run record → `host.startSession({ projectId })`, so a multi-repository binding makes "which project does this dispatch into?" ill-defined. The issue's three scenarios are expressed as **N bindings**. |
| `historyScope` | `'new-only' \| 'recent-history'` \| **absent** | **added at v1.13.0 (FR-053), GitHub issue #22.** Selects where this binding's scan window's lower bound comes from. **Documented default `'new-only'`**, which is also the single reading of an **absent** key — there is no legacy reading and no per-record-age behaviour (FR-058). `'recent-history'` baselines the first window at `createdAt − 604,800,000 ms` (7 days), once; `'new-only'` baselines it at `createdAt − overlapMs`. **Two values, no third**: no boolean spelling, no stored duration, no `null` meaning, no wildcard, no empty string. An explicitly stored `null` reads as **cleared to the default** (FR-062); any **other** present-but-unusable value (number, boolean, object, array, `''`, unrecognized string) **refuses the record** with a field-level remediation naming the two accepted names, quarantining the file (FR-061, FR-024). Validated on **every read and every write** by the same reader that judges `allowedUsers`, so a hand-edited file and a panel save are judged by one rule set. **Omission preserves** in the whole-file grant; an explicit name sets; `null` clears (FR-057). The look-back length itself is **not a member of this record and not of `config.json`** — a service-declared constant with a documented bound of 3,600,000 – 2,592,000,000 ms, read by nothing the operator can change (FR-059). Lives **only** in `bindings.json` — never `host.storage`, never the ledger, never a run record, never a bundle. |

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
| `baselineAt` | string \| null | **added at v1.13.0 (FR-066, FR-067, FR-073).** The **widest window this binding has ever scanned from**. Derived **once** from its **stored** creation stamp — `createdAt − overlapMs` in `'new-only'`, `createdAt − 604,800,000 ms` in `'recent-history'` — and thereafter **widened, never narrowed**, by every scan that opens a wider window. `null` means *not yet derived*. **Derived, not stored on the record**: the stored document has no duration member, so no stored state can ask for an unbounded window (FR-060). Retained rather than recomputed so three failed scans and then a success still open at the creation boundary rather than at a later clock reading (FR-066, AC-036); **monotone** so a recovery replay re-covers at least everything an earlier scan covered, which matters because an armed `rescanFrom` bound (`now − 7 days`) is *earlier* than a binding younger than a week's own creation boundary (FR-073; plan H8, corrected 2026-10-05). A stored creation stamp that is **absent** falls back to the assembled stamp; one that is **present and unreadable** derives **nothing** and the binding refuses with a recorded reason instead (FR-072) — deriving from the assembled stamp would read `now` there. **Written by the poll loop alone**, on a completing scan only: the derivation before the first scan, and the widening after every one. |
| `forceReplay` | boolean | **added at v1.13.0 (FR-074).** `true` only when this binding's checkpoint was cleared to recover a lost or quarantined event queue. **Only the recovery path can write it `true`**; the poll loop writes the member on every scan but may only clear it, and never by a first scan. **Never inferred by any reader** from an absent or cleared `lastScanAt` — the two cases (`never completed a scan` and `cleared for recovery`) are separate values in the same atomic write (FR-018). While `true`, the next scan replays this binding's in-window work **whatever its `historyScope` is and whatever catch-up is armed** (FR-073; plan H8, corrected 2026-10-05 — the replay outranks an armed `rescanFrom`), and the flag is surfaced on the binding's health row so a burst of older events is explained (FR-078, FR-092). An incomplete scan leaves it `true` (FR-076). |
| `rescanFrom` | string \| null | **added at v1.13.0 (FR-023, FR-084).** One binding's **chosen lower bound for its next scan** — the single rescan mechanism, and FR-023's one required caller. Written by the bindings grant when a submission moves a binding **into** `'recent-history'` and that binding has completed a scan, as `now − 604,800,000 ms`; `null` otherwise. **No operator-timestamp surface exists**: no route, no submitted member, no control (002 `## Out of Scope`), so the bound is always the documented look-back and never a value somebody chose (FR-060). It **wins** the window rule ahead of the recorded stamp, though a **recovery replay outranks it** (FR-073; plan H8, corrected 2026-10-05), and it is cleared **only by a scan whose window covered the armed bound** — not merely by one that completed, because a replay that ran *past* the arming and never reached its ground has not answered the request, and clearing there discards a deliberate operator request with nothing recording it (FR-076, FR-084; `answersCatchUp`). The clearing is in the same atomic write that advances `lastScanAt` (FR-018); a scan that does not complete leaves it armed. Editing back to the default mode **does not** clear it (FR-085). |

**Transitions** (spec States): `uninitialized → active` after first fully durable window; `active → backing_off` (429/5xx/timeout) `→ active` (next attempt succeeds) ; `active → blocked` (401/403/unsupported response/identity failure) ; `active → stale` (no successful poll > 3× interval, surfaced in health) ; any → `disabled` (binding disabled). **Advances only in the same atomic write that durably represents the full fetched window** (FR-018, FR-020).

### Delivery (normalized event)

| Field | Type | Constraints |
| --- | --- | --- |
| `schemaVersion` | `'1.2'` | **v1.2 (added at v1.11.0, FR-043)** = 001 `events.md` v1 (historical; see the note at the top of this file) + `deliveryKey` (1.1) + `actorLogin` + `actorAttribution` (1.2). **This is a contract version, not a stored member**: the shipped `QueuedEvent` row carries no `schemaVersion` field, so the bump lives in `contracts/events-carry-forward.md` and no row gains a version (plan D1 — a stored version would make every pre-existing row fail its own check and quarantine the file, which is the migration the product owner ruled out on 2026-10-03) |
| `actorLogin` | string | **added at v1.11.0 (FR-043).** The GitHub login the event is attributed to. Mandatory for every row this build writes, bounded by the module's existing `AUTHOR_LOGIN_MAX_CHARS = 60` (plan D8); credential-free by construction — a login is public repository identity, never a secret |
| `actorAttribution` | `'direct' \| 'subject-author'` | **added at v1.11.0 (FR-043, FR-044); `direct`-only from v1.12.0.** The basis union stays **closed** and **both** values stay **legal on read** — an unrecognized value still **refuses the row** rather than defaulting (002 FR-024). `direct` — GitHub named the identity that **performed the act**: the comment's author for a comment mention, the issue's author for an issue-body mention, and, **from v1.12.0**, the `assigned` event's `assigner` for an assignment and the `review_requested` event's `review_requester` for a review request. `subject-author` — **readable but no longer produced**: rows the shipped build wrote carry it and must still parse and render; **no row written under v1.12.0 may carry it**, and it has no producer (research §R8, rewritten at v1.12.0; the v1.11.0 rationale — that GitHub's feeds name no actor — was **false**, and was a two-endpoint sample generalized to a provider) |
| (both, on **pre-v1.11.0 rows**) | **absent** | Absentable on read so an older row still parses (plan D2). Absence means *no attribution was recorded* — never *allowed later*: 003 FR-080 refuses a run whose references carry no readable actor, and no migration is written (product owner, 2026-10-03) |
| **not in the delivery key** | — | **FR-046.** `buildEventId` is unchanged: `evt-<owner>~<repo>~<issueNumber>~<accountNumericUserId>` plus its optional discriminator (`~mention~<commentId>`, the fixed `~mention~body`, or `~review`). The actor **rides the record and never its identity**, so one observation is one event before and after this amendment and under any allow-list (AC-027) |
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
| `eventType` | string enum | `account.added/verified/rejected/rotated/error/deleted`, `binding.*`, `poll.checkpoint/observation/duplicate`, `rate.*`, `policy.decision`, `run.created/relayed/dispatched/verified/blocked/retried/dead_lettered`, `service.started/stopped/failed`,  `config.changed`, `audit.trimmed` *(the `consent` member this enum carried was **removed at v1.9.0**, 2026-10-01, with the consent dialog — a vocabulary removal recorded in changelog.md; rows already on disk keep parsing, since the reader accepts any `eventType` string)* **added at v1.13.0: `binding.history-scope-updated`** — a **configuration** row in the `binding.` prefix 003 `data-model.md` §4.2 already reserved, carrying `{ bindingId, decision: set\|changed\|cleared, from, to, actorSource }` and **nothing else** (FR-086): the mode's values are two fixed names, so there is no free text, no length, and no fingerprint. **No dispatch-lifecycle type is added, renamed, or changed** (FR-088), and `poll.observation` / `poll.checkpoint` stay reserved and unwritten (FR-087). |
| `actorSource` | string | e.g. `panel`, `service`, `operator` |
| `entity` | `{ kind: 'service' \| 'account' \| 'binding' \| 'run' \| 'delivery', id: string }` | `service` for entries that reference no account (identity-less credential rejections, configuration-wide rows) |
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
| `project` | string | selected project id — **picker memory, not configuration**: the spike key is retained (005 FR-025, `AGENTS.md` invariant 4), and since 002 FR-041 (v1.6.0, 2026-09-28) there is no `project-id` card setting beneath it in precedence — the `integration-setting` fallback was retired with the card's settings; the binding's `projectId` is the configuration (FR-013/FR-014). *The "001 amendment 4" precedence rule this row once cited is historical — see the note at the top of this file* |
| ~~`consent`~~ | ~~`{ givenAt: string, version: 1 }`~~ | **Removed at v1.9.0 (2026-10-01)** with the consent dialog: no panel state reads or writes this key any more (002 FR-008 re-cut). The key is *removed, not renamed*, so no storage-namespace reset occurs (AGENTS invariant 4); an orphaned value on an upgraded install is unread and harmless |
| `accounts` | JSON array | bounded account mirror `{ numericUserId, login, state, scopeCheck }` written after a successful handoff — display only, never authoritative, never a credential (token-handoff §3) |
| `expected-agent` mirror | string | effective value + provenance for display — **source superseded 2026-09-28**: the manifest setting is gone (002 FR-041 re-cut, card = zero settings) and the provenance is now *service configuration (`expectedAgent` in `config.json`) vs the documented default*; the panel reads it through `GET /v1/config` (002 FR-029 as amended, 006 FR-100). Whether the panel still mirrors it into `host.storage` is Phase 4's call — it is UI state either way (FR-034) |
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
9. **v1.11.0 — the allow-list field, all three states through the whole-file grant**: `allowedUsers` absent on a binding reads valid and means any human may trigger; `['Alice','bob']` saves and reads back **byte-identically** while matching `alice`, `ALICE`, and `Bob`; `[]` is refused with a field-level remediation naming both honest alternatives and **no submitted value echoed**; a hand-edited `bindings.json` carrying `[]` is refused on read the same way; a non-array, and an element that is not a GitHub login (over 39 characters, leading/trailing hyphen, non-text), are each refused naming `allowedUsers`; every refusal is collected with the others in one `422`, never first-issue-only; and **no new endpoint, method, or error code exists for the field** (AC-026).
10. **v1.11.0 — attribution, all four kinds**: a comment mention and an issue-body mention record `direct` with the comment's / issue's author; an assignment and a review request record `subject-author` with the issue / pull-request author; `PollPull` carries `authorLogin`/`authorType`; a bot-authored comment, issue body, assignment, and review request each create **no event**, and an assignment or review whose subject author GitHub sent no `user` for creates none either; and no surface, row, or projection states that either actor assigned or requested anything (AC-024, AC-025). **Superseded on the attribution rows at v1.12.0 — see entry 11; the entry is preserved as the record of what shipped.**
11. **v1.12.0 — the actor is named by the event, for all four kinds**: a comment mention and an issue-body mention still record `direct` with the comment's / issue's author, and now so do the other two — an assignment records `direct` with the naming `assigned` event's **`assigner`**, and a review request records `direct` with the naming `review_requested` event's **`review_requester`**. The actor is read from a **per-item** `GET /repos/{owner}/{repo}/issues/{issue_number}/events` fetched **only** for an already-detected candidate (FR-049); the naming event must carry the bound account in **`assignee`** / **`requested_reviewer`** respectively, and among qualifying events the greatest **`created_at`** wins (FR-050); the window is compared **client-side** on `created_at` because that endpoint — like the repository-wide and timeline endpoints — has **no `since` parameter** (FR-051); and a `null`, unreadable, or bot actor produces **no event this cycle**, substituting nothing, with the overlapping scan window re-attempting it on the next cycle (FR-052). **No member is added, removed, renamed, or retyped**: `actorAttribution` keeps its two values, `subject-author` keeps its rows' readability, and no new row may carry it. `PollPull`'s `authorLogin` / `authorType` lose their only stated consumer with FR-045's proxy sentence struck, so **no requirement now asks for them** (AC-024, AC-025, AC-028 – AC-031).
11. **v1.11.0 — identity is unchanged**: the same issue, comment, or pull request observed twice produces **one** event whose `evt-…` identifier is byte-identical across both observations, including once under a populated list and again under an absent one; a binding carrying one `repository` is the only shape that validates, with no plural or wildcard accepted (AC-027, FR-046, FR-048).
12. **v1.11.0 — the permitted set never leaves `bindings.json`**: after a dispatch authorized under a populated list, a scan over every audit row the build can write, the run record, the run-history projection, the audit read, and both committed bundles finds **no permitted login anywhere** — only the shape — while the gate's own refusal row still names every **denied** login with its basis (NFR-113; the gate is 003's, so the scan is 003's task, recorded here because the field is 002's).
