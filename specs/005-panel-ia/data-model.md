# Data Model: Panel IA — Six Tabs

**Feature**: `specs/005-panel-ia` · **Spec**: v1.4.0 · **Date**: 2026-09-28 (§1.4 added 2026-09-30 at Phase 6, wave 8)

Scope: what changes in the **panel runtime state**, in the **status projection document**, in the **dispatch-list read**, and in the **account record** — plus the `mecha-turk:` storage keys this feature touches and the state it deliberately does **not** persist. Entities 005 *renders but does not own* (run, binding, prerequisite, diagnostic) are summarised with a pointer to the predecessor that defines them.

Nothing here rewrites a stored value: 005 FR-005 forbids quarantining, discarding, or reinterpreting anything an earlier version wrote.

---

## 1. Panel runtime state (`src/panel-state.ts`)

### 1.1 What is removed

| Member today | Fate | Why |
| --- | --- | --- |
| `Repositories.activeTab: 'spike' \| 'repos'` | **Deleted** (not renamed) | FR-012: one activation field on the runtime; FR-011: `repaintReposSection` and both `hidden` writes go with it |
| `Repositories` (the combined tab-state interface) | **Dissolved** into per-tab slices | its members belong to three different tabs after the split; one combined blob is the old two-tab IA in type form |
| `PanelRuntime.pendingPhase: LifecyclePhase` | **Deleted** | the *Record phase* writer is retired with the spike surface (FR-011, Gate Question 2) |
| `PanelUi.{dispatch, verify, phaseSelect, mark}` handles | **Deleted** | *Start session* (003 FR-035 conformance, 005 FR-018/FR-044), *Verify host state* and *Record phase* retire with the spike body |
| `PanelUi.poll` (the *Poll now* button) | **Deleted** from the control row | retired with the spike body; its refresh role becomes the Status tab's explicit refresh (Clarification row 8, FR-014) |
| `PanelState.settings` as a **configuration source** | **Retained as a raw snapshot, no longer parsed** | 002 AC-021: no reader may take any of the six card ids from `ctx.settings` |
| `PanelState.config: SpikeConfig \| null` (settings-derived branch) | **Simplified** | the legacy single-repo branch disappears; the derived-binding context survives only while a consumer needs it, and the settings-derived branch is deleted outright |

### 1.2 What is added or reshaped

```ts
/** The shell's single navigation state (FR-012). Exactly one is active. */
type TabId = 'status' | 'dispatches' | 'bindings' | 'accounts' | 'settings' | 'about';

/** Mounted onto the runtime — never onto a tab-state slice. */
interface PanelRuntime {
    // …existing members…
    activeTab: TabId;                       // FR-012; NOT persisted (FR-015)
    tabMounted: Set<TabId>;                 // FR-013: mount on first activation, keep mounted
    tabLastRead: Map<TabId, string | null>; // FR-014: when this tab was last read; null = never
    bindings: BindingsTabState;             // was PanelState.repos   (FR-024)
    dispatches: DispatchesState;            // was Repositories.runs  (FR-024, FR-042)
}
```

| State | Fields | Constraints / validation |
| --- | --- | --- |
| **`TabId`** | six literal members in order `status, dispatches, bindings, accounts, settings, about` | a closed union; FR-010's order is the mount order and the strip order. An unknown id can never arrive — the shell constructs it — so there is no passthrough branch |
| **`activeTab`** | `TabId`, initialised `'status'` | **not written to `host.storage`** (FR-015, FR-025). A fresh mount always opens on Status (AC-131) |
| **`tabMounted`** | `Set<TabId>`, empty at mount | grows on first activation only; teardown clears it after disposing each body (FR-017, NFR-108) |
| **`tabLastRead`** | `Map<TabId, string \| null>` | written by a landed read or an explicit refresh **only**; an activation writes nothing (FR-014, NFR-104) |
| **read state (per tab)** | `'idle' \| 'loading' \| 'loaded' \| 'error'` + `note` + `staleSince` | a failed read keeps the last successful payload **and marks it stale** (FR-019, NFR-111); an empty result is never rendered as a successful empty result |
| **`BindingsTabState`** | `bindings[]`, `accounts[]`, `statusRows[]`, `repoInput`, `accountSelection`, `repoProjectSelection`, `triggerAssignment`, `triggerMention`, `triggerReviewRequest`, `worktreeSelection`, `selectedBinding`, `removeAccountArmed`, `note` | unchanged in meaning from today's `Repositories` minus `activeTab` and minus `runs` (FR-024). Draft fields are cleared only by an explicit submit or cancel — never by a tab switch (006's unsaved-edit expectation, FR-013's mount-once) |
| **`DispatchesState`** | `rows`, `status`, `note`, `selectedDispatch`, `agentNotice`, **`filters`**, **`page`** | §3 below |
| **`AccountsTabState`** *(added Phase 6, T-024/T-026)* | `selected`, `displayNameRow`, `displayNameDraft`, `displayNameError`, `removeArmed`, `rotateArmed`, `note` | The Accounts tab's **working** state only, in its own module `src/accounts-state.ts` (the shared state file is at its length cap). The account **list** stays `BindingsTabState.accounts` because one read fetches both; every field here is per-selection working state — it resets when another row opens, and no `host.storage` key is added (FR-025) |

### 1.3 Retained, deliberately

`ledger`, `evidence`, `match`, `handoff`, `projects` (picker), `projectSelection`, `bindingsActive`, `login`, `connected`, `busy`, `status` (banner), `relay`, `expectedAgent` — all keep their names and meanings. `expectedAgent`'s **source** changes (§5), not its slot on the runtime.

---

## 2. Status projection (`GET /v1/status`) — the one entity 005 materially changes

Three members stop being literals. Field names are **not** renamed (FR-026: the `repositories` member keeps its name).

### 2.1 `polling` — computed (FR-031)

| Field | Type after 005 | Rule |
| --- | --- | --- |
| `intervalMs` | `number` | the effective configuration value the scheduler is running with (unchanged) |
| `nextPollAt` | `string \| null` | the scheduled stamp **while polling runs**; `null` while it does not. Never a literal |
| `paused` | `boolean` | `true` **only** when the loop is genuinely not running |
| `pausedReason` | `string` | `''` while polling runs; otherwise one of the **closed vocabulary** `config-incomplete \| no-active-bindings \| store-unavailable \| stopping`. A reason outside the vocabulary is passed through **verbatim**, never mapped to a guess (FR-003) |

Source: a read-only view over `service/poll/timer.ts` + `service/poll/loop.ts` (`running`, `nextPollAt`) plus the config/store reads the route already does. The timer and loop are read, not modified.

**Transition table the view must express:**

| Condition | `paused` | `nextPollAt` | `pausedReason` |
| --- | --- | --- | --- |
| loop running, ≥1 active binding, store usable | `false` | future RFC 3339 stamp | `''` |
| loop stopped, no active binding | `true` | `null` | `no-active-bindings` |
| loop stopped, no account / unparseable config | `true` | `null` | `config-incomplete` |
| store unusable | `true` | `null` | `store-unavailable` |
| service shutting down | `true` | `null` | `stopping` |
| timer has not fired yet (long scan / suspended machine) | `false` | **past** stamp | `''` — the panel renders it as *overdue*, never substitutes the interval |

### 2.2 `repositories[]` — one row per stored binding (FR-032)

| Field | Type | Rule |
| --- | --- | --- |
| `bindingId`, `repository`, `projectId`, `accountLogin` | `string` | identity, as `readStatusRows` already builds them |
| `active` | `boolean` | `state === 'active'` |
| `lastScanAt` | `string \| null` | last completed scan |
| `lastError` | `string \| null` | last machine skip/error reason |
| `pendingCount` | `number` | pending + in-flight for that binding |
| `readable` | `boolean` (**new**) | `false` when the row could not be read — **the row appears with an unreadable marker; it is never omitted** (an omitted binding reads as a deleted one) |

The array is built from the **same** `readStatusRows` the Bindings tab reads, so the two surfaces cannot disagree about a binding. Member name stays `repositories` (FR-026); the panel renders it under the heading **Bindings**.

### 2.3 `agentPin` — widened (FR-033)

```jsonc
"agentPin": {
  "expectedAgent": "project-manager" | null,       // unchanged shape; value now comes from GET /v1/config (§5)
  "lastVerification": { "observedAgent": string, "expectedAgent": string,
                        "ok": boolean, "at": string }   // most recent outcome the service holds
                | { "available": false, "reason": "no-service-mirror" }   // explicit NOT AVAILABLE marker
                | null                                                      // only when nothing has ever been verified
}
```

`null` never means "ok". Where the service holds no mirror, the marker names that the outcome lives on the dispatch row and in the audit trail, and Status points at it rather than inventing it.

### 2.4 Rate block — unchanged in shape, honest in value (FR-034)

`remaining`, `limit`, `resetAt` stay `null` until measured and the panel renders **not measured yet**; `usedLastHour` renders the real count. A pre-poll budget is never rendered as `0`, `unlimited`, or a full bar.

### 2.5 Unchanged members

`service.{status, uptimeMs, dataDir, schemaVersion, storage.writable}`, `surface.supported`, and every account row field except the addition of nothing — account rows in *status* keep their current shape (005 FR-062's richer row is the **Accounts tab**'s DTO, not the status document's).

---

## 3. Dispatch-list read state (`GET /v1/events` + the panel's page state)

### 3.1 Wire answer (full detail in [contracts/dispatch-list.md](./contracts/dispatch-list.md))

```jsonc
{ "events": [ /* RunHistoryRow[] — 003's projection, unchanged field-for-field */ ],
  "page": { "limit": 25,
            "nextCursor": "…" | null,
            "hasMore": true,
            "total": 137 | null,             // null = the service cannot honestly supply one
            "snapshotAt": "2026-09-28T12:00:00Z",
            "filter": { "bindingId": "bnd_…" | null, "state": "failed" | null } } }
```

- **Order**: newest-detected-first, tiebroken by `id` descending — deterministic, so a cursor is stable.
- **`total`** is `null`, never a page size wearing a total's hat (NFR-112).

### 3.2 Panel page state

```ts
interface DispatchListPage {
    /** Cursor that produced each visited page; index 0 is the first page (cursor null). */
    cursorStack: (string | null)[];
    /** Which entry of cursorStack the operator is on; survives a refresh within the mount. */
    pageIndex: number;
    /** Operator-selectable page size; default 25, selectable 10 | 25 | 50 | 100 (FR-042). */
    limit: 10 | 25 | 50 | 100;
    /** From the last answer. */
    hasMore: boolean;
    total: number | null;          // null → the tab says "total unavailable"
    snapshotAt: string | null;     // the label the service put on the page
    /** null = no filter. Both are server-side (FR-043). */
    filters: { bindingId: string | null; state: string | null };
}
```

**State transitions of the page state:**

| Event | Effect |
| --- | --- |
| first read | `cursorStack = [null]`, `pageIndex = 0`, answer fills `hasMore/total/snapshotAt` |
| **Next** | push `nextCursor`, `pageIndex++`, read with it |
| **Previous** (≥ page 1) | `pageIndex--`, read with `cursorStack[pageIndex]` |
| **explicit refresh** | re-read with `cursorStack[pageIndex]` — position is preserved, not reset (FR-042) |
| filter change | **reset** `cursorStack = [null]`, `pageIndex = 0` (a filter and a page must describe the same set) |
| page-size change | same reset |
| read fails | `status = 'error'`; previous `rows` retained and **marked stale** (FR-019); page state untouched so a retry resumes where the operator was |
| answer says `hasMore: false` | **Next** disabled, not hidden-without-explanation |

### 3.3 Dispatch row projection

The row the panel renders is **003's `RunHistoryRow`** (defined in 003's `contracts/run-history-audit.md` §1) passed through the state→affordance table. 005 adds **no field** to the projection; it only *reads* it:

| Rendered element | Source field |
| --- | --- |
| subject line (`#n title`) | `issueNumber`, `issueTitle` |
| repository / binding | `repository`, `bindingId` |
| trigger | `kind` |
| state badge + reason line | `state`, `stateReason` (projected through 003's non-destructive migration table for any pre-003 stored row; the raw `pending \| in-flight \| dispatched` token is never rendered) |
| attempt | `attempt` |
| target project / worktree | `projectId`, `worktreeOption` |
| session pointer | `session` |
| verification warning | `verification` (warn-only, never a blocker) |
| "+N more reasons" + reveal | `sourceReferences[]`, `referenceCount`, `referencesTruncated`, `presentAtAuthorization` (post-authorization references marked) |
| copyable correlation id | `correlationId` (= `id`) |
| affordance | **derived**: `f(state)` from the single table in plan.md — never stored, never predicted |

A `state` the panel does not recognise renders `unknown state: <raw>` with **no** affordances (FR-003, FR-041).

---

## 4. Account record and DTO

### 4.1 `Account` (service store, `accounts.json`)

| Field | Type | Change |
| --- | --- | --- |
| `numericUserId` | `string` | unchanged — the durable key (002 FR-009) |
| `login` | `string` | unchanged — a GitHub rename updates this only |
| `expectedLogin` | `string \| null` | unchanged — supplied by the Accounts add form (005 FR-006) |
| `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `createdAt`, `updatedAt` | unchanged | custody untouched |
| **`displayName`** | **`string \| null`, default `null`** | **NEW (FR-066)**. Free text, bounded, validated like every other operator string, **refused on a credential shape** |

Validation rules for `displayName`:

- **Absent key or `null`** → renders as the GitHub `login`. Absence is valid and is the default for every existing account (so the upgrade writes nothing — FR-005).
- **Non-text present value** → refused (`422 validation`, `field: 'displayName'`, remediation naming the field, never the value).
- **Credential-shaped value** → refused with the field named and the shape's remediation, previous value stays in force (FR-066, FR-085; AC-130).
- **Display only**: never identity, never a durable key, never the binding's account reference, never the agent pin (FR-066). A login rename updates `login` and **must not** clobber `displayName` (AC-128).

### 4.2 `AccountDto` (credential-free by construction)

Adds exactly one optional member: `displayName: string | null`. The existing type-level guard in `tests/service-accounts.test.ts` (`'credential' extends keyof AccountDto ? never : true`) is retained and the new member is covered by the same suite (FR-067, AC-129).

### 4.3 Write operation

`PUT /v1/accounts/:numericUserId/display-name` → `200 { account: AccountDto }`. See [contracts/account-display-name.md](./contracts/account-display-name.md). It can change **nothing but** `displayName` and `updatedAt`.

---

## 5. `expectedAgent` — source change, not a shape change

| | Before 005 | After 005 |
| --- | --- | --- |
| Source | `ctx.settings['expected-agent']` via `parseExpectedAgent` | `GET /v1/config` → `expectedAgent` (006 FR-100's field), read per verification |
| Field absent (all builds until 006) | n/a | fall back to documented default `project-manager`, run **proceeds to verification**, outcome records `provenance: 'configured' \| 'defaulted'` (002 FR-029's two-case split) |
| Observed agent differs / unreadable | warns | **unchanged** — warns; only an observed problem blocks |
| Slot on the runtime | `PanelState.expectedAgent: string` | **unchanged slot**; provenance travels with the verification report, not into the runtime |

> **Pointer note (005 T-011a, recorded here so §1.3/§5 do not read as still true):** the slot was *deleted* with the card-settings path — `PanelState.expectedAgent` no longer exists; `src/prerequisites.ts` names `DEFAULT_EXPECTED_AGENT` and `src/agent-verify.ts` reads the baseline from `GET /v1/config` per verification.

005's Settings tab renders an `expectedAgent` row **only if `GET /v1/config` carries the field** — which it does not until 006 FR-100 lands. Rendering a row for a field the document does not hold would be inventing a value (FR-003).

---

## 6. `host.storage` (`mecha-turk:`) — touched and deliberately untouched

| Key | 005 disposition |
| --- | --- |
| `mecha-turk:project` | **Read and written as today** — but its *role* narrows: after the legacy settings path retires it is the **only** source of the resolved project id, and it remains UI state, explicitly **not** a configuration source (002 FR-013/FR-014). Name unchanged (FR-025) |
| `mecha-turk:evidence` | **Unchanged** — read at mount for restore, written by the same path (FR-005) |
| `mecha-turk:ledger` | **Unchanged shape**; its *reader* relocates to About's read-only Diagnostics (FR-075) and its live *phase writer* for the observed-phase record is retired with the spike surface — the existing entries are still read, never rewritten |
| `mecha-turk:dispatches` | **Unchanged** (003's durable attempt record; 005 only reads the surface that displays it) |
| **active tab** | **Deliberately NOT persisted** (FR-015, FR-025, Clarification row 9). No key is added. A fresh mount opens on Status; a wiped `host.storage` loses nothing durable |
| **dispatch filters / page position** | **Deliberately NOT persisted** — they are per-mount working state. Position survives a refresh *within* the mount (§3.2), not across a reopen |
| **last-read stamps** | **Deliberately NOT persisted** — a stamp that survives a reopen would claim a read the current mount never made |

No key is renamed; the panel id `mecha-turk` is unchanged; nothing 005 does can constitute a storage-namespace reset (invariant 4).

---

## 7. Entities 005 renders but does not own

| Entity | Owner | 005's relationship |
| --- | --- | --- |
| **Run** (run key, ordinal, attempt, states, lease, token, correlation id) | 003 | rendered as a **dispatch row**; the L4 identifiers are retained verbatim (FR-022) |
| **Binding** (`BindingRecord`, incl. `startingPrompt`) | 002 + 004 | rendered and edited through the existing whole-file grant; 005 adds no field and no endpoint (FR-050) |
| **Prerequisite** (met / not-met / not-checkable + remediation) | 003 FR-071–FR-073 | **placement only** — rendered on Status (FR-037) with its unmet notice at panel top |
| **Diagnostic** (ledger entry, evidence schema version, observed-phase record) | 002 + spike era | read-only in About (FR-075); the live writer is deleted (FR-011); no diagnostic is editable or deleted |
| **Config field declaration** (bounds, unit, default, enum) | `service/config.ts` (006 adds the wire projection) | mirrored once in `src/settings-rows.ts` and **pinned by a cross-check test** — see [research.md](./research.md) Q1 |
