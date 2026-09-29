# Data Model: Dispatch Integrity & Recovery

**Feature**: `specs/003-dispatch-integrity` · **Spec**: v1.3.0 · **Date**: 2026-09-28

Conventions (inherited from 002 `data-model.md`, unchanged):

- **Service tier** = durable store under `$HOME/.config/openchamber/mecha-turk/` — directory `0700`, files `0600`, atomic temp+rename writes, NDJSON append for audit. Authoritative for runs, deliveries, leases, tokens, attempts, and the audit trail.
- **Panel tier** = `host.storage` (extension-namespaced, 64 KiB/value, 2 MiB namespace, **wiped on uninstall**) — UI state and the FR-024 reconciliation record only; never an audit home.
- JSON fields are camelCase; provider ids and GitHub numbers are **strings** in storage; timestamps RFC 3339; durations integer milliseconds.
- **No credential is a field anywhere below.** The dispatch token is an authorization artifact (see naming rule in [research.md](./research.md) §R3), not a credential.

---

## 1. State-machine delta (shipped vocabulary → spec vocabulary)

### Shipped (what `events.json` rows carry today)

```
pending ──claim (bare flip + claimedAt)──▶ in-flight ──result (sessionId | problem)──▶ dispatched (TERMINAL)
                ▲                              │
                └──────── operator retry ──────┘        (a problem result is also terminal — defect FR-040)
```

Three states, no lease, no attempt, no reservation, no distinction between "session exists" and "dispatch failed".

### Target (003 `## Dispatch State Model`, implemented verbatim)

| State | Meaning | Terminal? | Joins a new delivery? | Leaves via |
| --- | --- | --- | --- | --- |
| `pending` | waiting for a panel; no lease | no | yes | claim → `claimed` |
| `claimed` | a panel holds the lease; has not reserved yet | no | yes | reserve → `starting`; lease expiry → `pending` (+attempt, +requeue) or → `dead-lettered`; guard report → `blocked:<reason>` |
| `starting` | single-use token issued; about to call the host | no | yes (marked post-authorization) | result → `dispatched` \| `failed`; deadline → `unconfirmed`; abandon → `failed` |
| `dispatched` | a session was created and reported | **yes** | no — opens the next ordinal | (refuses retry — FR-041) |
| `failed` | attempted, produced no session, cause recorded | no | yes | operator retry → `pending` (+attempt) |
| `blocked:<reason>` | fail-closed guard refused before any host call | no | yes | operator retry once the cause clears → `pending` (+attempt) |
| `unconfirmed` | reservation exists, no result — fail-closed wedge | no | yes | panel reconciliation or explicit operator resolve → `dispatched` \| `pending` (+attempt) |
| `dead-lettered` | requeue budget exhausted (or parked) | **yes** | no — opens the next ordinal | operator requeue → `pending` (**attempt reset**) |

`blocked:<reason>` is stored as the full string `blocked:<reason>` with `reason` a non-empty kebab token; the parser validates **prefix + non-empty suffix**, never a fixed enum, so `blocked:project-missing`, `blocked:binding-missing` (both produced today), and the declared-but-not-yet-produced `blocked:credential`, `blocked:policy` (FR-042's list) all parse. States the model declares but no shipped guard currently produces are retained, not invented: the panel's guards can only see binding and project problems (policy gates are documentation-only; the service never dispatches).

### Non-destructive migration table (spec `## Dispatch State Model`, honoured exactly)

| Stored delivery row | Run created at adoption | Follow-up |
| --- | --- | --- |
| `pending` | `pending`, attempt 1, no lease, `requeuesUsed 0` | claimable on the first post-upgrade claim |
| `in-flight`, no reservation recorded | `claimed` with an **already-expired synthetic lease** (`leaseId` minted at adoption; `expiresAt` = the **earlier** of the legacy claim's own stamp and the adopting stamp minus one millisecond, so the lease reads as expired to any clock that could judge it — including a sweep pass whose stamp predates the mint, T-045) | boot sweep requeues once: attempt 1→2, `dispatch.lease-expired` with reason naming **migration recovery**, **not charged to the requeue budget** (plan migration strategy) |
| `in-flight` + reservation recorded | `starting`, result deadline armed from the adoption stamp | branch unreachable for rows the shipped build wrote (no reserve operation exists); implemented and unit-tested from a synthetic row so the table is complete |
| `dispatched` + session id in `dispatchResult` | `dispatched` (terminal) | carried through |
| `dispatched` + problem string in `dispatchResult` | `failed`, retryable, cause from the stored string | classified per research §R2; the branch taken is recorded in `run.migrated` details |

**Adoption writes exactly one `run.migrated` row per adopted run** (FR-005, NFR-103, AC-126). It never touches `scan-state.json`, never quarantines, and **never rewrites a legacy delivery row** — the stored `state` value keeps its shipped meaning and is read only as migration input (005 FR-005's "projects through the migration table rather than being rewritten in place"). Linkage for adopted rows lives on the run (`sourceReferences[].deliveryId`) and in that audit row; rows written *by 003* additionally carry the forward link on the delivery (FR-012).

---

## 2. Storage tier 1 — service durable store

### Files layout (delta against 002's)

```text
$HOME/.config/openchamber/mecha-turk/
├── state.json             # schemaVersion: 1 — UNCHANGED (additive file, see §2.6)
├── config.json            # ServiceConfig + leaseMs, resultDeadlineMs (new fields, additive)
├── accounts/…  bindings.json  scan-state.json  audit.ndjson   # unchanged in shape
├── events.json            # DELIVERIES — top-level array shape UNCHANGED;
│                          #   legacy rows byte-identical; new rows add absentable
│                          #   runCorrelationId + subjectType and omit lifecycle fields
└── runs.json              # NEW — { schemaVersion, subjects, runs[] }
```

### 2.1 Delivery (row inside `events.json` — evolved, never rewritten)

| Field | Type | 003 change |
| --- | --- | --- |
| `id` | string | **unchanged** — dedupe key + path segment, byte-identical format (FR-012, AC-104) |
| all detection fields (`bindingId`, `kind`, `repository`, `accountNumericUserId`, `accountLogin`, `projectId`, `worktreeOption`, `issue*`, `headSha`, `baseRef`, `triggerNote`, `detectedAt`) | as shipped | unchanged |
| `runCorrelationId` | string, **absentable** | **new** — the run this delivery belongs to (FR-012); written only on rows 003 enqueues; absent on adopted rows |
| `subjectType` | `'issue' \| 'pull_request'`, **absentable** | **new** — captured at detection (a body mention can sit on a PR; `isIssueBodyMention` does not filter PRs) so the run key's subject type is truthful; adopted rows derive `kind === 'review' ? 'pull_request' : 'issue'` |
| `state`, `claimedAt`, `dispatchedAt`, `dispatchResult` | as shipped | **frozen legacy**: still parsed (migration input), still written by nothing; new rows omit them. The parser widens them to absentable — a row without them is a post-003 row, a row with them is a pre-003 row, and neither reading can quarantine the other (FR-005) |

Bounds: file still carries the shipped eviction tail (`MAX_DISPATCHED_EVENTS` legacy rows with `state: 'dispatched'`); post-003 rows are retained while their run is non-terminal and evicted with their run's terminal tail, so growth follows NFR-107. A post-003 row carries **no lifecycle field of its own**, which is why the per-binding `pendingCount` in the status projection is derived from `runs.json` (`state === 'pending'`) rather than from this file (T-040a): counting delivery rows counted every completed run's deliveries too, so the number grew with finished work and never fell below the truth.

### 2.2 Run (inside `runs.json`)

| Field | Type | Constraints / source |
| --- | --- | --- |
| `runKey` | string | `github\|<accountNumericUserId>\|<owner/name>\|<issue\|pull_request>\|<number>\|<ordinal>` — FR-010, displayed to the operator (human-readable by design) |
| `correlationId` | string | `mt-run-<sha256(runKey) hex[0:24]>` — single path-safe segment; service-minted, panel echoes, never re-derived by a caller (FR-050, FR-051) |
| `attachmentId` | string | = `correlationId` (identity derivation, plan D-decision) — ≤128 chars (`GUEST_ATTACH_ID_MAX`), displayed on the run row (FR-029) |
| `ordinal` | number | 0-based = count of already-terminal runs for the subject **at creation**, read from the durable `subjects` counter (FR-010; "numbering never reused" edge case) |
| `subjectType`, `subjectNumber`, `repository`, `accountNumericUserId`, `bindingId` | string / number | subject coordinates + routing; run key components |
| `projectId`, `worktreeOption` | string | snapshotted at enqueue (002 FR-028 discipline; 004 will snapshot its prompt beside them) |
| `state` | `pending \| claimed \| starting \| dispatched \| failed \| blocked:<reason> \| unconfirmed \| dead-lettered` | §1; transitions are chain-serialized |
| `stateReason` | string | why the run sits where it does — required on every non-`pending` state, rendered as the row's reason line (FR-074, NFR-108) |
| `attempt` | number | starts 1; incremented by **lease expiry**, **operator retry**, and **resolve→no-session**; carried on the lease and every attempt record (see plan "Attempt counting") |
| `requeuesUsed` | number | 0…`MAX_AUTO_REQUEUES` (3, a module constant — **not** a config field, 003 v1.3.0 / 006 `## Deferred`); incremented only by automatic requeues; reset with `attempt` on dead-letter return (FR-033) |
| `sourceReferences[]` | `SourceReference` (§2.3) | one per joining delivery; capped at `MAX_SOURCE_REFERENCES = 200` (product-owner ruling 2026-09-28 — T-038, raised from plan D11's 20). Overflow deliveries still join and still earn their `run.coalesced` row; what the cap kept off the list is **counted, not hidden**: the row carries `referenceCount` (the total that ever joined), `referencesTruncated`, and `referencesNotRetained` (how many were not retained), and the parser refuses a stored document whose three cannot be reconciled (`referenceCount === length + referencesNotRetained`, `referencesTruncated === referencesNotRetained > 0`) — a row that would render as silently lossy, or falsely complete, is refused rather than projected |
| `lease` | `{ leaseId, attempt, holder, issuedAt, expiresAt, provenance } \| null` | at most one live lease per run; `holder` = the panel's opaque mount id from the claim query (informational, never authorization) (FR-030). `provenance` is `'panel' \| 'migration'` and records **which path minted the lease** as data rather than as a naming convention inside the id (T-040e): the sweep's migration-recovery accounting reads a typed field, and `parseLease` accepts exactly the two id shapes this build mints (`lse-<24 hex>` for a panel claim, `migration-<correlation id>` for the synthetic adoption lease), so a stored id this build could never mint is refused rather than trusted. **The lease is a fencing/consistency token, not a capability** — it authorizes nothing, and the service's bearer token is the only authentication gate |
| `reservation` | `{ dispatchToken, attempt, reservedAt, resultDeadlineAt, consumed } \| null` | minted at reserve, cleared on result/abandon/resolve/requeue; `consumed` is per-attempt-chain (plan D6) (FR-021) |
| `attempts[]` | `DispatchAttempt` (§2.4) | retained for the run's life; bounded by the requeue budget (NFR-107) |
| `session` | `SessionRef` (§2.5) \| null | at most one, ever (FR-028) |
| `verification` | `{ observedAgent: string \| null, expectedAgent: string, ok: boolean, note: string \| null, at: string } \| null` | warn-only, visible on the row, never a state (FR-043) |
| `createdAt`, `updatedAt` | string | RFC 3339 |

### 2.3 SourceReference (element of `run.sourceReferences`)

| Field | Type | Source |
| --- | --- | --- |
| `deliveryId` | string | the joining delivery's unchanged id (FR-013) |
| `kind` | `assignment \| mention \| review` | trigger kind |
| `origin` | `assignment \| body \| comment:<id> \| review` | where it matched, including the comment id (FR-013) |
| `sourceUrl` | string | canonical link |
| `detectedAt` | string | that delivery's detection stamp |
| `excerpt` | string (claim-transport only) | bounded trigger excerpt (≤600 chars at detection) — carried on the **claim** answer for context building; **not** stored on the run (excerpts live on the delivery; the run stores the pointer) |
| `presentAtAuthorization` | boolean | `false` iff the run already held a reservation when this delivery joined; drives FR-015's "may not have been seen by the agent" mark |

### 2.4 DispatchAttempt (element of `run.attempts`)

| Field | Type | Meaning |
| --- | --- | --- |
| `attempt` | number | the attempt number this record is for |
| `dispatchToken` | string \| null | token minted when a reservation was made; `null` for a claim that expired without reserving (FR-020) |
| `reservedAt` | string \| null | reservation stamp; `null` = no reservation |
| `outcome` | `'dispatched' \| 'failed' \| 'abandoned' \| 'expired' \| 'blocked' \| 'unconfirmed' \| null` | `null` while in flight |
| `sessionId` | string \| null | on a dispatched outcome |
| `reason` | string \| null | on failed/abandoned/blocked/expired |
| `resultReportedAt` | string \| null | when the service recorded the outcome (FR-060's `result-reported` flag) |

### 2.5 SessionRef (on the run)

`{ sessionId, attachmentId, dispatchedAt, title, sourceUrl, worktree: { directory, branch } | null }` — OpenChamber stays authoritative; only the pointer is stored (002 Key Entities, unchanged). The observed agent lives on `run.verification`, not here, so the service-side mirror backlog (002 debt: `agentVerified` mirror) stays explicitly out of 003.

### 2.6 `subjects` counter, schema markers, and the durable audit outbox

- `runs.json` document: `{ "schemaVersion": 1, "subjects": Record<subjectKey, number>, "runs": Run[], "auditIntents": [] }` where `subjectKey = github|<account>|<repo>|<subjectType>|<number>` and the value is the **next** ordinal. Written only at run creation; never pruned (an evicted terminal run must not free its ordinal — "numbering is continuous and never reused"). Growth is bounded by distinct subjects that ever produced a run (<10 repositories; measured in hundreds–thousands of ~70-byte entries), documented under NFR-107.
- `state.json`'s `SERVICE_SCHEMA_VERSION` **stays 1**: its meaning is "a format this build understands", and the store gains an additive file, not an incompatible one; bumping it would report two different values for identical stores (upgraded stores keep reading 1). `runs.json` carries its own document `schemaVersion` so a future run-model change has a marker to act on.
- `SERVICE_VERSION` in `service/routes/health.ts` **stays mirrored to `package.json` `0.0.1`** — 003 performs no release bump (AGENTS.md invariants 2 and 5).
- **`auditIntents[]`** (T-037, extended T-040b) is the durable outbox for lifecycle audit rows whose append can span a crash. Three producers write an intent in the *same* `runs.json` write that changed the state the row describes: run creation (`run.created`), migration adoption (`run.migrated`), and the lease/deadline sweep (`dispatch.lease-expired`, `run.dead_lettered`, `dispatch.unconfirmed`). The next reader of the document appends whatever is still owed and retires the intent — so a failed append is **retried, not lost**, which is the only way FR-063's "must not be swallowed" can hold for the sweep, whose trail is the sole record an operator has of an automatic recovery. A sweep intent carries a `sequence` discriminator (`<leaseId>:<attempt>`, or `<attempt>:<deadline>` for the wedge) because one run can be lease-expired three times and a matcher that compared only the event type would retire the second recovery against the first row and never write it. The outbox is parsed fail-closed — an intent that does not fully validate makes the whole outbox unparsable, which quarantines the document rather than silently dropping owed rows — and its structured details refuse any string containing `dtk-`, so the recovery mechanism itself can never become a credential store.

### 2.7 Config delta (`config.json`)

| Field | Type | Bounds | Default | Consumer |
| --- | --- | --- | --- | --- |
| `leaseMs` | number | 30,000–600,000 (FR-031 / spec Assumptions) | 120,000 | claim lease expiry, sweep cadence |
| `resultDeadlineMs` | number | 30,000–600,000 | 120,000 | `starting` → `unconfirmed` deadline, sweep cadence |

Both are additive to `GET/PUT /v1/config` (contract §1: additive within v1), validated fail-closed like the existing fields, and **explicitly not** `requeueBudget` (003 v1.3.0 record + 006 `## Deferred`). Cross-feature note for 006's Phase 4: the Settings tab renders whatever `GET /v1/config` returns; these two rows have a live consumer (the sweep) and are not the inert-field case.

---

## 3. Panel tier — `host.storage`

| Key | Type | Contents / limits |
| --- | --- | --- |
| `mecha-turk:dispatches` | JSON, `schemaVersion: 'dispatch-attempts-1'` | **NEW** — the FR-024 durable attempt record: `{ correlationId, runKey, attempt, dispatchToken, outcome: 'dispatched' \| 'failed', sessionId \| null, reason \| null, recordedAt, acknowledged: boolean }[]`, newest last, capped at `MAX_RECORDED_ATTEMPTS = 50` (evict oldest *acknowledged* first; never evict an unacknowledged record). **Written after `host.startSession()` returns and before the result POST** (FR-024's exact ordering), so every stored record has an outcome — a crash before the record exists is the reservation the service already knows about, and correctly lands in `unconfirmed` (FR-023) rather than in a guess |
| `mecha-turk:ledger` | as shipped | entries keep their shape; new entries carry the **run's** correlation id in the existing `correlationId` field (FR-050). `LEDGER_SCHEMA_VERSION` unchanged (additive field use) |
| `mecha-turk:project`, `:evidence`, `:consent`, `:accounts` | as shipped | untouched (invariant 4: prefix kept, nothing renamed) |

**Wipe semantics**: `:dispatches` is wiped on uninstall like every panel key. Documented consequence (spec `## Assumptions`): after a wipe the panel has nothing to reconcile from, `unconfirmed` runs resolve only through FR-027's operator decision — no re-dispatch, ever.

**Secret posture**: the record contains a `dispatchToken` (authorization artifact, `dtk-…`, passes every secret-shape scan) and zero credentials; `writeStorage` keeps applying `assertRedacted`, and the NFR-106 scan suite gains this key to its scan list (add, never exempt).

---

## 4. Audit row shapes (`audit.ndjson` — extended, not rewritten)

`AuditEntry`'s **shape already satisfies FR-061** (seq, RFC 3339 timestamp, correlationId, eventType, actorSource, entity {kind,id}, decision, reason, redaction metadata, structured details; writer redacts; a redaction refusal blocks the write). 003 adds vocabulary and fixes *which* correlation id rides in it.

### 4.1 Correlation discipline (FR-050–054, FR-062)

| Row family | `correlationId` value | `entity` |
| --- | --- | --- |
| Dispatch lifecycle (`run.*`, `dispatch.*`, `agent.*`) | **the run's** — never a fresh uuid (FR-062) | `{ kind: 'run', id: <run correlationId> }` |
| Delivery rows (`delivery.detected`) | **the run's** — assigned at enqueue (correlation table) | `{ kind: 'delivery', id: <delivery id> }` |
| Non-run rows (poll, checkpoint, scan-window reset, `delivery.recovered`, `consent`, `account.*`, `binding.*`, `config.changed`) | **its own** generated id, plus `details.deliveryIds` where the row concerns deliveries (FR-052) | as shipped |

### 4.2 The sixteen lifecycle event types (spec `## Audit Vocabulary`, verbatim)

| `eventType` | Actor | Written when | `decision` | required `details` |
| --- | --- | --- | --- | --- |
| `run.created` | service | run minted | — | subject tuple, run ordinal, folded delivery identifiers |
| `run.coalesced` | service | delivery joins an open run | `coalesced` | delivery identifier, trigger kind, origin, present-at-authorization |
| `run.migrated` | service | pre-existing row adopted | `adopted` | legacy delivery identifier, state adopted in (+ classification branch for problem-results) |
| `dispatch.claimed` | panel | lease issued | — | lease identifier, attempt, lease expiry, source-reference count |
| `dispatch.reserved` | panel | intent-to-start reported | — | lease identifier, attempt, `dispatchToken`, attachment identifier |
| `dispatch.result` | panel | outcome reported | `dispatched` \| `failed` | attempt, token, session identifier **or** failure reason |
| `dispatch.duplicate-report` | service | repeat of a recorded result | `no-change` | attempt, token, the state it repeated |
| `dispatch.abandoned` | panel | reserved attempt created no session | `no-session` | attempt, token, reason |
| `dispatch.lease-expired` | service | lease expires, no reservation | `requeued` | prior state, attempt before and after, lease identifier, expiry (+ migration-recovery reason when adopted) |
| `dispatch.unconfirmed` | service | result deadline passes | `unconfirmed` | prior state, attempt, token, deadline |
| `dispatch.retry` | operator | retry **or** dead-letter return-to-waiting | `retry` | prior state, attempt before and after, cause reported cleared (reset stated when `priorState = dead-lettered`) |
| `dispatch.resolved` | operator | unconfirmed resolved | `dispatched` \| `no-session` | prior state, note, the guidance the operator was shown |
| `run.blocked` | panel | guard refused the dispatch | `blocked` | blocked reason, prior state, in-panel guidance offered |
| `run.dead_lettered` | service | budget exhausted (or parked) | `dead-lettered` | attempts consumed, reason (+ `requeuesUsed`) |
| `agent.verified` | panel | read-back matches | `verified` | session identifier, observed agent, expected agent |
| `agent.mismatch` | panel | mismatch / unreadable / timeout | `warn` | session identifier, observed agent or null, expected agent, note |

Event types outside this list are unchanged and keep their own identifiers (FR-052). `binding.prompt-updated` (004) will sit under a non-lifecycle `binding.` prefix — the vocabulary's prefixing scheme is why 003's write path must be additive, and it is.

**One addition, justified by FR-003**: the sixteen types each describe a successful transition or a dedicated outcome, so refusals need their own row — `dispatch.refused` (actor `service`, decision `refused`, details: attempted operation, refusal code, prior state, attempt/lease/token reference). It keeps the `dispatch.` prefix (readable as lifecycle at a glance), leaves the sixteen untouched (AC-115 samples those, unchanged), carries the run's correlation id like every lifecycle row (FR-062), and is specified in [contracts/dispatch-authorization.md](./contracts/dispatch-authorization.md) §9, including the scope reading that panel-side no-ops which never reach the service are ledger entries, not service rows.

### 4.3 Transition → row coverage (FR-044, AC-115 — the test matrix)

| Transition | Row | Transition | Row |
| --- | --- | --- | --- |
| (none) → `pending` (created) | `run.created` | delivery joins | `run.coalesced` |
| adoption | `run.migrated` | `pending` → `claimed` | `dispatch.claimed` |
| `claimed` → `starting` | `dispatch.reserved` | `claimed` → `pending` (expiry) | `dispatch.lease-expired` |
| `claimed` → `dead-lettered` | `run.dead_lettered` | `claimed` → `blocked:*` | `run.blocked` |
| `starting` → `dispatched` / `failed` | `dispatch.result` | `starting` → `failed` (abandon) | `dispatch.abandoned` |
| `starting` → `unconfirmed` | `dispatch.unconfirmed` | duplicate result | `dispatch.duplicate-report` |
| `failed` / `blocked:*` → `pending` (retry) | `dispatch.retry` | `unconfirmed` → `dispatched` / `pending` | `dispatch.resolved` |
| `dead-lettered` → `pending` (return) | `dispatch.retry` | verification | `agent.verified` / `agent.mismatch` |

**FR-063 posture**: rows are appended *after* the durable state change; an append failure throws to a catch that (a) logs `warn` with the run named, (b) reports `auditWritten: false` on the response so the panel surfaces a visible warning naming the run, and (c) never rolls the state back. AC-119 simulates the failure against the store double.

---

## 5. Relationships

```
Account (1) ──< RepositoryBinding (N)                 [unchanged]
RepositoryBinding (1) ──< Delivery (N)                 [unchanged, + runCorrelationId on new rows]
Subject counter (1) ── next ordinal                    [NEW, in runs.json]
Delivery (N) ──> Run (1)     [join at enqueue; adopted rows link run → deliveryId only]
Run (1) ──< SourceReference (N ≤ 20)
Run (1) ──< DispatchAttempt (N, bounded by budget)
Run (1) ──> SessionRef (0..1)     Run (1) ──> verification (0..1)
Run (1) ──> Lease (0..1)          Run (1) ──> Reservation (0..1)
Every entity ──> AuditEntry (0..N): run rows share the run's correlationId (FR-050)
```

## 6. Validation scenarios (drive the suites)

1. **Upgrade seed**: a store written in the shipped vocabulary adopts per §1 — zero quarantines, zero window resets, one `run.migrated` per run, `dispatched`-with-problem rows become `failed` and retryable (AC-126, NFR-103).
2. **Dual trigger**: assignment + body mention in one scan ⇒ one delivery pair, **one** run, two source references, one `host.startSession()` (AC-101, SC-101 ×100 trials).
3. **Ordinal continuity**: terminal runs evicted from `runs.json` ⇒ the next run for that subject gets the next ordinal (edge case "numbering never reused").
4. **Lease expiry**: claim → panel dies → sweep ⇒ `pending`, attempt 1→2, `dispatch.lease-expired` with before/after, budget +1 (AC-106).
5. **Budget**: three requeues then `dead-lettered` with `attempts consumed`; a waiting panel closed the whole time changes nothing (AC-108, FR-036).
6. **Reservation wedge**: reserve → no result → deadline ⇒ `unconfirmed`; sweep ticks ×10 leave it untouched; only resolve/reconciliation moves it (AC-107).
7. **Staleness matrix**: reserve on expired lease → `stale-lease`; reserve on live reservation → `already-reserved`; reserve with a session on record → `already-dispatched` naming the session; result identical → duplicate row; result conflicting → refused (AC-109, AC-112).
8. **Crash permutations**: the ten enumerated permutations ⇒ sessions-per-run ≤ 1 except an operator's explicit *no-session* (AC-110, NFR-102, SC-102) — automated, not manual.
9. **Correlation**: one run's chain — created, coalesced, claimed, reserved, result, verified — retrieves from `GET /v1/audit?correlationId=` alone; no lifecycle row carries a fresh uuid (AC-116, AC-117, SC-104/105).
10. **Secrets**: runs, references, attempts, tokens, audit rows, projection, and the panel record scanned ⇒ zero credential occurrences; `dispatchToken` survives redaction byte-identically (AC-120, NFR-106).
11. **Bounded growth**: a run with 201 coalescing deliveries retains the first 200 references in full and records `referencesNotRetained: 1` with `referencesTruncated: true`; every overflow delivery still has its `run.coalesced` row, and a stored document whose counts do not reconcile is refused (AC-129, NFR-107; T-038).
12. **Audit-write failure**: store `appendLine` throws mid-transition ⇒ state stands, warning names the run, service log has the failure (AC-119).
