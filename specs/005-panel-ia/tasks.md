# Tasks: Panel IA — Six Tabs (005)

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md), [contracts/](./contracts/) — all Phase-4 outputs; [spec.md](./spec.md) v1.4.0 is the source of truth (FR/AC numbers below are quoted as written — v1.4.0 is the record-only FR-057 amendment and changed no requirement text).

**Bar**: six tabs, every one honest, nothing that worked yesterday worse. Tests are offline and deterministic per `AGENTS.md`: fake host (`tests/support/panel.ts`), DOM helpers (`tests/support/{dom,ui-stubs}.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`) — **no live OpenChamber, no PAT, no network** (FR-086). `[P]` = parallel-safe (different files, no dependency). **`npm run verify` runs at every wave boundary, and any wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` committed in the same commit (invariant 1).**

**Baseline**: 005's Phase 6 runs **after 003's and 004's Phase 6** (the spec lists both as Dependencies; the roadmap sequences 003 → 004 → 005 → 006). Tasks below never rebuild a predecessor's mechanism — see "What's already built". Re-derive the rename inventory from the tree at execution time (`ls src/runs* src/repos* tests/runs* tests/repos*`); the lists here were measured on the pre-003/004 tree and are the shape, not the guarantee.

## What's already built — do NOT re-touch

- **002 shipped and live-validated**: loopback server/auth/body-caps (`server.ts`, `http.ts`, `auth.ts`, `pipeline.ts`), consent, throttles, account custody + verify + rotate + hardened delete (`accounts/`, `routes/{accounts,verify,credential}.ts`), bindings (`bindings.ts`, `routes/bindings.ts`), polling/triggers/windows/rate budget (`poll/{poller-github,poller-entries,triggers,loop,timer,scan}.ts`), store 0700/0600 + quarantine funnel (`store/*`), audit writer seq/redaction chain (`audit.ts` — **005 writes no audit row of its own**, FR-027), config document + validator (`config.ts`, `routes/config.ts`), `routes/health.ts` (**`SERVICE_VERSION` and its pin stay exactly as they are**), `routes/status.ts`'s *shape* (005 changes three members' **contents**, not the document's structure), panel ledger/evidence/redaction/session/storage-write/project-actions/agent-verify mechanics, `tests/support/*`, `tests/bundle.test.ts`, `tests/manifest.test.ts`.
- **003 lands first (its plan/tasks are the specification for it)**: run model + `runs.json`, eight-state dispatch vocabulary and its non-destructive migration table, lease/claim/reserve/result, retry / resolve / requeue semantics and the refusal matrix, the 16-row dispatch-lifecycle audit vocabulary, `GET /v1/audit`, the `RunHistoryRow` projection, `src/relay.ts`'s reconcile→claim→reserve→report tick, `src/dispatch-record.ts`, `src/reconcile.ts`, `src/prerequisites.ts`, `src/audit-view.ts`, `src/project-picker.ts`'s "not listed?" guidance, state labels + reasons + `canRetry` in `src/runs-rows.ts`, `leaseMs`/`resultDeadlineMs` in `service/config.ts`. **005 renders all of it and must not re-implement a single transition (FR-044, FR-027).**
- **004 lands first**: `service/prompt.ts`, `BindingRecord.startingPrompt`, snapshot-at-detection, omission-preserves at the PUT route, fingerprint-on-audit scalars, `binding.prompt-updated`. **005 renders the field; it does not compose, validate, or store a prompt (FR-051, FR-052).**
- **Invariants**: delivery id format, evidence schema `extension-spike-1`, manifest ids/capabilities/panel id, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` `0.0.1` (**no bump**), `SERVICE_SCHEMA_VERSION = 1`, the existing 563-test suite (stays green throughout), every `mecha-turk:` storage key (FR-025).

## Out-of-scope guard (check before any task feels like "just one more")

No GitHub write of any kind (FR-002, 002 FR-031, 003 FR-002). **No `PUT /v1/config` call and no Settings write path** (FR-070 — 006's edit surface; no disabled-looking control either). **No new run state, transition, refusal, or audit row** (003's; FR-027). **No prompt composition, validation, or storage** (004's; FR-051). **No wire path renamed** — `/v1/events*`, the `repositories` status member, `/v1/bindings`, `/v1/accounts`, `/v1/health`, `/v1/status`, `/v1/config` all keep their names and member names (FR-023, FR-026). **No `host.storage` key added or renamed**, panel id unchanged, active tab deliberately not persisted (FR-015, FR-025). **No capability, permission, host API, or SDK re-pin** (FR-004, FR-079). **No version bump** (FR-087). **No project/worktree/session/agent created, deleted, or mutated by the panel** (FR-089). No service-side `agentVerified` mirror, retention/export, policy profiles, dedupe eviction, webhook, work-completion tracking, or automatic cleanup (005 `## Out of Scope`). No `Rule:` framing-line task (005's spec carries no FR/AC for it).

---

## Wave 1 — L2 rename A: `src/repos*.ts` → `src/bindings*.ts` (mechanical, atomic)

**Goal**: the source speaks *Bindings* before any restructure touches it. Independent test: `npm run verify` green with **zero behaviour change** — the same suite, the same count, the same results.

- [x] **T-001** [US5] Perform the `repos*` → `bindings*` rename as **one atomic commit**: `git mv src/repos.ts src/bindings.ts`, `src/repos-ui.ts → src/bindings-ui.ts`, `src/repos-rows.ts → src/bindings-rows.ts`, `src/repos-service.ts → src/bindings-service.ts`, `src/repos-mount.ts → src/bindings-mount.ts`; `git mv tests/repos-mount.test.ts tests/bindings-mount.test.ts`, `tests/repos-removal.test.ts tests/bindings-removal.test.ts`; sweep every importer and every surface identifier per plan.md's inventory (`ReposSection → BindingsSection`, `ReposPane → BindingsPane`, `ReposPaneHandlers → BindingsPaneHandlers`, `RepositoriesStatus → BindingsStatus`, `PanelState.repos → .bindings`, `initialRepos → initialBindings`, `mountRepositoriesPane/mountReposSection/repaintReposSection/createRepositoriesHandlers → …Bindings…`) and the DOM marker `data-mount="mountRepositoriesPane"` → `data-mount="mountBindingsPane"` with its `tests/bundle.test.ts` assertion; update `AGENTS.md`'s module-map rows for the renamed files. **No operator-facing copy changes** (L1 lands with the surface in Waves 5–9 — plan.md §Four-layer rename). *Tests*: full suite green at identical count; `npm run build`; both bundles committed with the sources; `git status` shows the moves as renames. **(FR-024, FR-028)**

**Wave 1 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 2 — L2 rename B: `src/runs*.ts` → `src/dispatches*.ts` (mechanical, atomic)

**Goal**: the second half of the four-layer rename. Independent test: same as Wave 1.

- [x] **T-002** [US5] Perform the `runs*` → `dispatches*` rename as **one atomic commit**: `git mv src/runs.ts src/dispatches.ts`, `src/runs-ui.ts → src/dispatches-ui.ts`, `src/runs-rows.ts → src/dispatches-rows.ts`, `src/runs-service.ts → src/dispatches-service.ts`; `git mv tests/runs.test.ts tests/dispatches.test.ts`; sweep importers and surface identifiers (`RunsState → DispatchesState`, `RunsStatus → DispatchesStatus`, `initialRuns → initialDispatches`, `RUNS_HEADING/RUNS_EMPTY_TEXT/RUNS_EMPTY_STATUS/RUNS_SELECT_HINT → DISPATCHES_*`, `runsStatusText → dispatchesStatusText`, `runRows/runRow → dispatchRows/dispatchRow`, `loadRuns → loadDispatches`, `selectRun/openRun → selectDispatch/openDispatch`); **retain** every L4 identifier (`RunRow`, `runKey`, `runOrdinal`, `attempt`, `retryRun`, `retryPath`, `runs.json`, the `run.` audit prefix) per FR-022; update `AGENTS.md`'s module-map rows. **No operator-facing copy changes.** *Tests*: full suite green at identical count; `npm run build`; both bundles committed. **(FR-024, FR-022, FR-028)**
- [x] **T-003** [P] [US5] Create `tests/vocabulary.test.ts` — the **L2/L4 guard** (the L1 half arrives in T-029): assert no `src/repos*.ts` and no `src/runs*.ts` module file exists; assert every `src/**` import resolves to an existing file (so a missed sweep is a test failure, not a typecheck surprise); assert the **retained allow-list still contains its members** (`RunRow`, `runKey`, `attempt`, `retryRun`, `runs.json`, `run.`) so the guard cannot be satisfied by over-renaming into L4; assert `AGENTS.md`'s module map lists every file `src/` actually contains. *Tests*: the guard fails if any renamed file is reverted; passes on the Wave-2 tree. **(FR-021, FR-024, FR-028)**

**Wave 2 boundary**: `npm run verify` green + rebuilt bundles committed. *From here on, every wave writes in the product's vocabulary.*

---

## Wave 3 — Service read-surface honesty (the three wire deltas)

**Goal**: the documents stop contradicting the machine. Independent test: drive a running loop and a stopped one through the same route and get different, correct answers; page a 250-row history; save a display name.

- [x] **T-004** [P] [US1] Honesty for `GET /v1/status` per [contracts/status-projection.md](./contracts/status-projection.md): create `service/poll/view.ts` — a **read-only** view exposing `running`, `nextPollAt`, and the shutdown/stopped flags from `service/poll/timer.ts` + `service/poll/loop.ts` **without modifying either** — and rework `service/routes/status.ts`'s `buildStatusBody`: `polling.paused/nextPollAt/pausedReason` computed from that view (closed vocabulary `config-incomplete | no-active-bindings | store-unavailable | stopping`, anything else passed through verbatim), `repositories` built from the existing `readStatusRows` with a new `readable` flag and the member name **kept as `repositories`**, `agentPin.lastVerification` widened to the outcome object / `{ available: false, reason: 'no-service-mirror' }` / `null`, `PAUSED_REASON` literal deleted. *Tests* (`tests/service-status.test.ts`): SC-101 running ⇒ `false`/future stamp/`''`, stopped+no binding ⇒ `true`/`null`/`no-active-bindings` (AC-102, AC-103); SC-102 zero/one/five bindings each rowed (AC-104); unreadable binding rowed with `readable: false`, never omitted (AC-105); out-of-vocabulary reason passthrough; `lastVerification` never an "ok"-shaped object when nothing verified (AC-106); pre-poll rate renders `null`s not zeros (AC-107); response still contains `repositories`, credential scan clean. **(FR-031, FR-032, FR-033, FR-034, FR-026)**
- [x] **T-005** [P] [US2] Paging + filters for `GET /v1/events` per [contracts/dispatch-list.md](./contracts/dispatch-list.md): add `limit` (default 25, accepted 10/25/50/100), `cursor` (opaque, composite `detectedAt desc, id desc` boundary), `bindingId` (exact; unknown id ⇒ empty set, not 404), `state` (exact token, `blocked` family, or `blocked:<reason>`; unknown ⇒ `422 validation`) in `service/routes/events.ts`, answering `{ events, page: { limit, nextCursor, hasMore, total: number|null, snapshotAt, filter } }`; keep `recentRuns()` as the unpaged primitive and keep the path, member names, and order. *Tests* (`tests/service-events.test.ts` extended): 250 rows page 100+100+50 with no dup/gap (AC-121); filter × page compose across all pages; `state=blocked` returns both family members; `state=bogus` and `limit=7` answer `422` with remediation and change nothing; order stable under identical `detectedAt`; `total: null` never reads as the page size; `503`/`401` unchanged. **(FR-042, FR-043, FR-003, FR-023)**
- [x] **T-006** [P] [US4] `displayName` per [contracts/account-display-name.md](./contracts/account-display-name.md): add `displayName: string | null` (default `null`) to `Account` and `AccountDto` in `service/accounts/model.ts` with its six-step validator (type → trim → empty/`null` clears → ≤80 code points → credential-shape refusal → no control characters), wire `toAccountDto`, and add `PUT /v1/accounts/:numericUserId/display-name` in `service/routes/accounts.ts` (registered in `routes/index.ts`, literal before parameterised). The body must carry `displayName` — absent ⇒ `422`, never a silent no-op. *Tests* (`tests/service-accounts.test.ts` extended): DTO type guard still refuses a `credential` key; credential-shaped value refused naming the field with **zero characters of the submitted value** and the stored value unchanged (AC-130); deep-compare shows only `displayName`/`updatedAt` changed; a pre-field store reads as `null` with **zero bytes rewritten** (FR-005); login rename leaves `displayName` intact (AC-128); credential scan over `GET /v1/accounts` (AC-129). **(FR-066, FR-067, FR-005)**

**Wave 3 boundary**: `npm run verify` green + rebuilt bundles committed. Contracts for all three deltas are already written — this wave makes the code match them.

---

## Wave 4 — The six-tab shell, the spike retirement, and the legacy settings retirement (US5, P2)

**Goal**: one tab strip, six bodies, no spike surface, no card settings. Independent test (spec US5): mount against the fake host and assert exactly six tabs with Status active, no `hidden` switch anywhere, and a clean teardown.

- [x] **T-007** [US5] Restructure `src/panel-state.ts`: add `type TabId = 'status' | 'dispatches' | 'bindings' | 'accounts' | 'settings' | 'about'`; lift `activeTab` onto `PanelRuntime` (initial `'status'`, **never written to storage**) and add `tabMounted: Set<TabId>` + `tabLastRead: Map<TabId, string | null>`; dissolve `Repositories` into `BindingsTabState` (rename `PanelState.repos → .bindings`) and `DispatchesState` (rename `RunsState`, and add `filters: { bindingId: string | null; state: string | null }` + `page: { cursorStack, pageIndex, limit, hasMore, total, snapshotAt }` per data-model §3.2); delete `Repositories.activeTab`, `ReposSection`, and `PanelRuntime.pendingPhase`. *Tests*: constructors return Status active with an empty mount set; no tab slice carries an `activeTab`; page state resets on filter/limit change and survives a failed read. **(FR-012, FR-015, FR-024, FR-042, FR-043)**
- [x] **T-008** [US5] Create `src/tabs.ts`: mount the six items through `mountTabs` in FR-010's order; `activate(rt, id)` that is a **no-op when already active and performs no service read**; first-activation mount registry calling that tab's mounter exactly once; `noteRead(rt, id, at)` written only by a landed read or an explicit refresh; `associateTabs()` stamping `id="oc-tab-<id>"` on each `role="tab"` button and `role="tabpanel"` + `aria-labelledby` on each body, invoked **after mount and after every `tabs.update()`**; `disposeTabs(rt)` disposing every mounted body in a fixed order independent of the active tab. *Tests* (`tests/tabs.test.ts`): six labels in order, Status active; activation idempotence (zero service calls on re-activation — FR-014, NFR-104); a body mounts once and stays mounted (FR-013); **the association survives two `update()` calls** (FR-016, FR-082); roving tabindex + arrow keys reach all six; dispose clears the registry. **(FR-010, FR-011, FR-013, FR-014, FR-016, FR-017, FR-082)**
- [x] **T-009** [US5] Rewire `src/app.ts` + `src/panel-ui.ts`: mount the shell as the panel's first element under a **root notice region** (for the unmet-prerequisite, unsupported-surface, and storage-blocked notices that FR-036/FR-037 require *outside* their sections); map the six tab bodies onto the existing mounts (Dispatches/Bindings/Accounts initially wrap today's boards and the handoff group; Status/Settings/About mount their **static content only** — which FR-078 requires anyway — until Waves 5 and 9 fill the reads); **delete `repaintReposSection` and both `hidden` writes**; make `teardown` walk the tab registry. *Tests*: SC-103 — a suite-level scan asserts **no code path sets `hidden` on a spike-era container**; AC-101 six tabs with Status active; AC-131 reopening after switching to Bindings opens on Status; AC-137 node/timer/disposer counts return to pre-mount after visiting every tab. **(FR-011, FR-012, FR-015, FR-017, FR-019, AC-101, AC-131, AC-137, SC-103)**
- [x] **T-010** [US5] Retire the spike surface and relocate what survives: delete the *Start session* button and its `startDispatch` handler wiring, the *Observed phase* select, the *Record phase* button and `markPhase`, the *Verify host state* button and `verifyHost`, and the *Poll now* button (its refresh role becomes the Status tab's explicit refresh in T-012); move the ledger list into About's read-only Diagnostics body, the token-handoff group into the Accounts body (T-025 makes it complete), and the project picker into the Bindings body (T-022 completes it). **Do not move `startRelayPolling`'s arm site** — the loop stays root-owned on the Dispatches tab's behalf. *Tests*: the built bundle contains no `Start session` and no `Record phase` string (FR-018, FR-044, FR-011); AC-136 — a tab switch during an in-flight dispatch leaves **exactly one** relay loop and no second `host.startSession` (also pinned by T-019); the ledger's existing entries still read (FR-005). **(FR-011, FR-018, FR-044, FR-075, AC-136)**
- [x] **T-011** [US5] Retire the legacy card-settings path (002 FR-041 / 002 AC-021, 005 PM note 3): empty `contributes.integration.settings` in `package.json` (absent or empty — **zero** settings); delete `parseSpikeConfig`, `resolveProjectId`, `parseExpectedAgent` from `src/config.ts` and **every reader of the six card ids** from `ctx.settings` (`repository`, `expected-login`, `project-id`, `worktree-option`, `poll-interval-ms`, `expected-agent`); source `expectedAgent` from `GET /v1/config` with 002 FR-029's two-case split (absent/unreadable ⇒ documented default `project-manager`, run proceeds, outcome records `provenance: 'defaulted'`); source the resolved project id from `mecha-turk:project` alone; retire the now-unreachable legacy single-repo poll controls. Written so a manifest already emptied by 002's close-out simply passes. *Tests*: 002 AC-021's static scan — the panel source contains **no reader that takes any of the six ids from `ctx.settings`**; `tests/manifest.test.ts` asserts zero settings while `capabilities[]`, the card's `token` block, `contributes.service`, and the panel id stay byte-identical; `tests/config.test.ts` updated to the surviving readers; the verification test asserts the defaulted-baseline provenance (002 AC-023). **(002 FR-041, 002 AC-021, 002 FR-029, 005 FR-004, FR-079, FR-005, AC-141)**

**Wave 4 boundary**: `npm run verify` green + rebuilt bundles committed. *The panel now has six tabs, no spike surface, and no card settings.*

---

## Wave 5 — Status tab (User Story 1, P1) + User Story 7 (P2) — L1 copy begins here

**Goal**: the first thing the operator reads is true. Independent test (US1): fake host + temp-dir store with one healthy account, one rate-limited account, one binding scanning and one skipped — every element renders from the document, and no literal survives.

- [x] **T-012** [US1] Create `src/status-tab.ts`: render every element 002 FR-036 requires and 005 FR-030 places here — service health, uptime, data directory, store schema version, storage writability; one row per account with connection state and **rate honesty** (`not measured yet` for null budget fields, real `usedLastHour`); one row per binding rendered under the heading **Bindings** (last scan, pending count, skip/error reason, `readable: false` ⇒ *unreadable*, never omitted); the polling block with the effective interval and a real next-poll stamp rendered **overdue** when it is in the past; the agent pin as *not checkable by the panel* / *not available*, never "ok"; the **blocking notice** when `storage.writable === false` naming the handoff consequence; the **unsupported-surface notice** (FR-036) that suppresses every other tab's "it is operating" claim; the **effective-vs-configured interval** pair with the difference named when they differ (FR-039); the tab's read state (loading / loaded+stamp / failed+cause+retry, stale content marked stale) and its explicit refresh with a `lastRead` stamp (FR-014, FR-019). *Tests* (`tests/status-tab.test.ts`): fixtures for running, paused, degraded, unsupported, and unreachable — each renders its own copy and **no zeros, empty lists, or reassuring summaries built from a failed read**; AC-106, AC-107, AC-108, AC-109; hostile service strings render as text (FR-080). **(FR-030, FR-034, FR-035, FR-036, FR-039, FR-014, FR-019)**
- [x] **T-013** [US7] Place 003's prerequisites on Status: mount `src/prerequisites.ts`'s section with each prerequisite's own state and remediation, the Default Agent pin reading *not checkable by the panel* and naming the first dispatch as what checks it, any **checkable + unmet** item **also** raising a visible notice in the root notice region, and met-and-checkable items never nagging; add the Status → Bindings-picker link for a binding in the *project not registered* state (FR-038, without duplicating 003's guidance). *Tests* (`tests/status-tab.test.ts` extended): met / unmet / not-checkable fixtures; AC-110 notice + section both present; AC-111 no notice when everything is met; no new host capability used (FR-004). **(FR-037, FR-038)**
- [x] **T-014** [P] [US1] Status edge cases: a read that fails entirely keeps static content and names the service as the source of what is unknown; `degraded` + `schemaVersion: null` + `storage.writable: false` says exactly that instead of rendering an empty account list; an out-of-vocabulary `pausedReason` renders **verbatim**; zero bindings renders an honest empty. *Tests*: the five fixtures above, each asserting the refusal-to-invent rule (FR-003, NFR-112). **(FR-003, FR-019, FR-031, FR-032)**

**Wave 5 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 6 — Dispatches tab (User Story 2, P1)

**Goal**: what happened, and what to do about it. Independent test (US2): run-history fixtures covering **every** state in 003's `## Dispatch State Model` — each renders a label plus a reason, the affordance matches the table, and a 100-row fixture pages.

- [x] **T-015** [US2] Create the paged list client in `src/dispatches-service.ts`: build `GET /v1/events?limit=&cursor=&bindingId=&state=` from the page state, parse `{ events, page }` **fail-closed** (an unparseable body reads as *unreadable*, never a partial list), and own the `cursorStack`/`pageIndex`/`limit`/`filters` transitions from data-model §3.2 (filter or limit change resets to page 1; explicit refresh resumes at `cursorStack[pageIndex]`; failed read leaves page state untouched). *Tests*: parser accepts a full page answer and refuses a malformed one; stack push/pop/reset rules; filter echo is what the tab shows as active. **(FR-042, FR-043, FR-003)**
- [x] **T-016** [US2] Replace `canRetry` with the single **state→affordance table** in `src/dispatches-rows.ts`: label + `stateReason` line for every 003 state; *Retry* offered only from `failed` and from `blocked:*` whose cause has cleared (disabled with the unresolved project named otherwise, consuming no budget); **absent** with its own reason from `pending` (*already waiting for a panel*), `claimed`, `starting`, `dispatched`, and `unconfirmed`; *Resolve* instead of Retry on `unconfirmed`, naming the project, worktree option, and attachment id; *Return to waiting* on `dead-lettered`; **unknown state** renders `unknown state: <raw>` with no affordances; the pre-003 stored vocabulary renders through 003's migration table and never as a raw token; verification outcome rendered as a **warning** naming the observed agent, never a blocker; source-reference subtitle with "+N more reasons" and the post-authorization reference marked; tone map where failure is never success-toned. *Tests* (`tests/dispatches.test.ts`): **one fixture per state from one table** so a new 003 state fails this test until given a label and an affordance (SC-104); AC-113, AC-114, AC-119, AC-120; hostile reason/title render as text. **(FR-041, FR-044, FR-045, FR-047, FR-048)**
- [x] **T-017** [US2] Create `src/dispatches-ui.ts`: the paged body — range line showing which range is showing with `total` or *total unavailable*; **Previous/Next**; page-size select (10/25/50/100, default 25); binding and state filters with the active filters **visible at all times**; the empty-filtered state saying *the filter matched nothing* with an offer to clear it (never *there are no dispatches*); row detail listing every source reference with kind, origin, link, and detection time; the correlation id **copy affordance** with an explicit reason when copying is unavailable; accessible names that name their row (*Retry dispatch for #412 in owner/name*). *Tests* (`tests/dispatches-paging.test.ts`): AC-121 — 250 fixture rows page through with every row reachable and none dropped at a boundary; AC-122 — filtered-empty copy + clear offer; AC-115/AC-120 detail content; accessible-name assertions (FR-081). **(FR-042, FR-043, FR-048, FR-049, FR-081, AC-121, AC-122)**
- [x] **T-018** [US2] Rewire the actions in `src/dispatches.ts`: **one list read path** and **one action dispatch path**; *Retry* (from `failed`/cleared `blocked:*`), *Resolve* with 003's two explicit confirmations stating what is being verified and warning that a session may exist, *Return to waiting* stating **before it happens** that the attempt count resets; every response rendered from **the service's own verdict** with its distinct refusal reason (already waiting / already dispatched / unconfirmed / guard refused) and **no optimistic row flip**; the single `busy` gate blocks a second activation on the same row; the correlation id copies from the row. *Tests*: AC-114–AC-118 each driven against the loopback service; a refused retry leaves the row byte-identical to the last read; double-activation runs exactly one action. **(FR-044, FR-045, FR-046, FR-049, FR-084, FR-085)**
- [x] **T-019** [P] [US2] Relay-ownership assertion (`tests/app.test.ts` extended): the loop is armed from the root, a switch Dispatches → Bindings → Dispatches mid-flight neither duplicates nor abandons it, no session is claimed or started twice, and teardown stops it. **(FR-018, AC-136, SC-108)**

**Wave 6 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 7 — Bindings tab (User Story 3, P1)

**Goal**: bind a repository and see exactly what it will do. Independent test (US3): a full create/enable/disable/edit cycle round-trips through `GET`/`PUT /v1/bindings`, exactly one element carries the prompt, and a credential-shaped prompt is refused with its remediation.

- [x] **T-020** [US3] Complete the CRUD surface in `src/bindings.ts` + `src/bindings-ui.ts`: add form and row list as **one surface**; create/enable/disable/remove through the existing whole-file `GET`/`PUT /v1/bindings` with **no per-binding `PATCH`**; enable/disable read back from the service's own answer (never an optimistic local change); a binding disabled because its account was removed renders disabled **with that reason**; a rejected submission leaves every other binding **byte-identical** and says so. *Tests* (`tests/bindings-removal.test.ts` + `tests/bindings-mount.test.ts` extended): AC-125 refused submission ⇒ deep-compare every other binding unchanged; the whole-file round trip; no `PATCH` call exists anywhere in `src/`. **(FR-050, FR-054, FR-058, AC-125)**
- [x] **T-021** [US3] Render 004's starting prompt **exactly once**: one field in the binding editor labelled as the starting prompt for dispatches from this repository, fed from `GET /v1/bindings`'s `startingPrompt` and **never** from an audit fingerprint; the row summary shows **presence and length only** — never the text and never the fingerprint; a service refusal renders as a field-level refusal with its remediation, leaves the previously stored prompt in force, and is never reported as saved; the save sends the field **explicitly when the operator cleared it** and **omits it when untouched** (004 FR-014's omission-preserves). *Tests* (`tests/bindings-prompt.test.ts` new): SC-105 — a rendered-element count across **all six tabs** fails at 0 *and* at 2 (AC-123); AC-124 credential-shaped refusal with the previous prompt intact; clear-vs-untouched body shapes asserted byte-for-byte. **(FR-051, FR-052, AC-123, AC-124, SC-105)**
- [x] **T-022** [US3] Complete the binding editor per FR-053: repository (`owner/name`), bound account (drawn from the Accounts list — **only** accounts a binding refers to), target project through 003's picker with its *not listed?* guidance reachable **inside the picker** (the binding stays recoverable until a registered project is chosen; the extension still never creates a project), the three triggers independently toggleable, the mention-token override defaulting to `@<login>` of the bound account and **visibly marked as an override** when it differs, the worktree option, the binding's state, created/updated stamps, and its per-binding scan line (fresh binding ⇒ *not scanned yet*, pending 0). *Tests* (`tests/bindings-ui.test.ts`): AC-112 — the three manual registration routes are named and the binding stays recoverable; the override marking appears only when it differs; the scan line's fresh/scan/skip states; the static scan still finds zero project-create calls (FR-089). **(FR-038, FR-053, FR-056, FR-057, AC-112)**
- [x] **T-023** [P] [US3] Bindings-surface sweep: L1 copy moves to *Bindings*/*binding* throughout the tab, and the tab carries **no service tuning** (interval, retry, retention, log level — Settings owns those) and **no account surface** beyond the selection a binding needs. *Tests*: the copy assertion for this tab; a static assertion that no config field name appears in the bindings modules. **(FR-020, FR-059)**

**Wave 7 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Post-dispatch-2 defect (PM review of T-011)

- [x] **T-035** **Restore the integration card's connectivity/identity diagnostic (002 FR-011(b)).** Evidence: before T-011a, `ensureIdentity` had two production callers — `src/app.ts:126` and `src/app.ts:236` — and T-011a's legacy-path retirement removed both, so the card now delivers only the identity badge while 002 FR-011(v1.7.0) defines it as having **two** products: (a) the connected-login identity badge *and* (b) one read-only connectivity/identity diagnostic. Rewire `ensureIdentity` back into the connection path where it was, keeping every other part of T-011's retirement intact — the legacy single-repo poll arming, `parseSpikeConfig`, `resolveProjectId`, `parseExpectedAgent`, `PanelState.expectedAgent`, and the six card settings ids stay gone. The `/user` read may happen where it did before; do not let the restoration re-introduce a poll start. *Tests*: the diagnostic runs on connect and reports its outcome; no legacy arming path is reachable; the AC-021 static scan still proves no reader takes a card id from `ctx.settings`.

## PM ruling on T-022 / FR-057 (recorded 2026-09-30, applies to T-022 as written)

The dispatched worker reported a genuine conflict and chose no option. Evidence it gathered: `BindingRecord` has no mention-token member; `service/poll/triggers.ts` calls `mentionsLogin(body, binding.accountLogin)`; `grep` finds no `mentionToken` anywhere in `service/` or `src/`; an extra `PUT` member is **silently dropped** by `assembleBinding`; 005's own `data-model.md` §7 says "005 adds no field and no endpoint (FR-050)"; and 002 FR-015 says the token "**MAY** be overridden per repository" — a permission the shipped store never exercised.

**Ruling: render what the service actually matches, record the gap as a deferral, and do not add an inert field.**

1. **T-022 renders the mention token in force**: `@${binding.accountLogin}` — precisely the value `mentionsLogin` matches on — defaulting to `@<login>` of the bound account.
2. **The override marker fires when that rendered value differs from the bound account's current `@login`** (upstream rename drift, or any future stored override), which is exactly FR-057's operative purpose: *an operator who has never seen the field must be able to tell that a binding matches on something other than its own login*.
3. **No service field is added in 005.** A stored override would have to be consumed by `mentionsLogin` to be honest, and 005 adds no binding field by its own approved data-model. An unconsumed field is the inert-setting failure mode 006 exists to eliminate.
4. **`specs/005-panel-ia/spec.md` → v1.4.0** with an changelog.md entry recording: the override **store** does not exist in the shipped service (evidence above); FR-057's rendering and marking obligations are satisfied by the derived display; and the per-binding operator override is **deferred** to a successor feature that owns the mention-token store, with the lifting condition that the service must both store *and* consume it. Frame it as recording an unimplemented permission inherited from 002 FR-015, **not** a weakening of FR-057 — the requirement's observable guarantee is unchanged.
5. **Editor scoping (the other T-022 clause):** in **edit mode** the bound-account field is fixed to the selected binding's own account (no free select), so a displayed value and a saved value can never disagree; in **add mode** the select lists the accounts available to bind. Assert that mismatch with a test.

## Truth-repair batch (raised by 005's final-gate worker; PM triaged 2026-09-30)

- [x] **T-036** **Three statements in the tree are now false; fix them, not the tests that expose them.** (a) **`/v1/health` does not exist.** 005 FR-074, `AGENTS.md`'s service map and the dispatch brief name it, but the registered route is **`/health`** (`service/routes/health.ts`, 002 `contracts/panel-service.md` §2.1, 005 `contracts/about-version.md` §0 — while that same contract's §37 says `/v1/health`). The panel correctly reads `/health` and pins `HEALTH_PATH === healthRoute.path`. **Correct the prose to the real path everywhere it is claimed** (005 spec FR-074, `AGENTS.md`, `about-version.md` §37) — do **not** add an alias route, which would invent a second health surface to satisfy a typo. (b) **README:217 "There is no editor for this field yet" and quickstart:94 "Until the panel grows a field for it" are false** — 005 T-021 shipped the binding editor's `startingPrompt` field — and `tests/bundle.test.ts` currently **enforces the false sentence** ("promises no panel editor before 005"). Update both documents to state that the field lives in the Bindings editor, and amend 004's bundle assertion to assert the *current* truth (004 ships no editor in its own window; 005 owns the field) rather than the retired promise. (c) Leave the four retained "the run" sentences as they are — `run` is an L4 domain term and service refusal copy renders verbatim per 005 FR-027 — but record that reading in `specs/005-panel-ia/ac-status.md`'s notes so the pre-PR review does not re-open it. *Tests*: the health path is pinned in one place, the docs-scan tests pass, and `bundle.test.ts`'s prompt assertion now states the shipped truth.

## Wave 8 — Accounts tab (User Story 4, P1)

**Goal**: know which accounts can poll, and fix the ones that cannot — without moving a credential. Independent test (US4): fixture DTOs covering all six lifecycle states and all four connection states; the DTO carries no credential member; rotation retains history; the delete confirmation names the cascade.

- [x] **T-024** [US4] Create `src/accounts-rows.ts` + the Accounts body in `src/accounts-ui.ts`: each row renders display name (falling back to `login`), GitHub login, numeric user id, lifecycle state (`pending_handoff`, `verifying`, `active`, `rejected`, `revoked`, `error`), connection state, last verified stamp, the four-capability scope matrix (ok / missing / unknown), the `errorReason` when `state` is `error`, and the number of bindings the account backs; `rejected`/`revoked`/`error` render as first-class states with reason **and remediation**, and `pending_handoff` is distinguishable from `error` + `interrupted-handoff` while offering the **same** remediation; every binding bound to an unusable account shows that consequence on its own row; **no token input read-back, no scope editing, no token inspection anywhere**. *Tests* (`tests/accounts-ui.test.ts` extended): all six lifecycle × four connection fixtures render their own copy; AC-129 — the DTO renders with no credential member and the secret scan gains a case rather than an exemption; hostile login/title render as text. **(FR-062, FR-063, FR-067, FR-068, FR-069, AC-129)** — *landed with the body in `src/accounts-tab.ts`, not `src/accounts-ui.ts`: that module holds the handoff render adapter and is near the file-length cap, so the body is its own module (AGENTS.md module map records it).*
- [x] **T-025** [US4] Relocate the handoff flow **without redesigning it**: the same consent gate, the same storage pre-flight, the same two-step refusal that leaves the previous token in force, mounted in the Accounts tab's add path; consent already given is **not re-requested by navigating**; the consent text is byte-unchanged; `storage.writable === false` keeps the token input disabled with the reason visible (matching T-012's blocking notice); and the add form gains **exactly one** optional, non-credential input — *expected GitHub login* — submitted as the existing `expectedLogin` member, absent/empty meaning no constraint. *Tests* (`tests/handoff-dom.test.ts`, `tests/consent.test.ts` extended): AC-141 — empty input ⇒ stored `expectedLogin: null` and the flow otherwise identical to today's; a non-empty mismatch ⇒ rejected fail-closed with 002 FR-009's reason and no token echo; the manifest declares no `expected-login` setting; consent accepted once is not asked again (002 FR-008). **(FR-006, FR-035, FR-060, FR-061, AC-141, AC-108)** — *the stored-null half lands in `tests/service-verify.test.ts` (the panel-side half asserts the member is absent), and the manifest half is `tests/manifest.test.ts`'s existing zero-settings assertion.*
- [x] **T-026** [US4] Display name, rotation, and removal: the row's display-name edit affordance calling `PUT /v1/accounts/:numericUserId/display-name`, rendering the service's refusal verbatim with its remediation and **never** applying an optimistic value; the rotation confirmation stating that every checkpoint, delivery, dispatch, and audit record is retained; the two-step **Remove account** that arms on the first click and states *N bindings will be disabled* before anything happens (zero ⇒ says zero), with the second click deleting and leaving those bindings **disabled with that reason**, never deleted. *Tests* (`tests/accounts-ui.test.ts` + `tests/bindings-removal.test.ts` extended): AC-126 arm state changes nothing and names the cascade; AC-127 removed account's bindings present, disabled, each stating the reason; AC-128 display name survives a login rename; AC-130 credential-shaped display name refused by field with the previous value in force; the arm-confirm idiom is reused, `confirm()` is never introduced (FR-084). **(FR-055, FR-064, FR-065, FR-066, AC-126, AC-127, AC-128, AC-130)** — *landed with the rotation wiring in `tests/handoff-dom.test.ts` (the paste routes to `POST /v1/accounts/:id/token` once a row arms it) and the control's removal from the Bindings tab asserted in `tests/bindings-ui.test.ts`.*

**Wave 8 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 9 — Settings tab and About tab (User Story 6, P2)

**Goal**: version, backup location, and configuration without hunting. Independent test (US6): fixture config + fake host; About's version equals `SERVICE_VERSION`; Settings renders rows with no input control.

- [x] **T-027** [P] [US6] Create `src/settings-rows.ts` + `src/settings-tab.ts`: the single row declaration (field name, unit, bounds/default/enum set, take-effect statement) **cross-checked against `service/config.ts`'s `NUMERIC_BOUNDS`/`DEFAULT_CONFIG`/`LOG_LEVELS` by a test that fails on drift** (research Q1's decided default); the tab renders **one row per field `GET /v1/config` actually carries** — FR-071's ten fully, 003's `leaseMs`/`resultDeadlineMs` with their value plus *bounds and take-effect not declared by this build*, and an `expectedAgent` row only if the document carries it; each row states value, unit, and whether a change takes effect immediately, at the next cycle, or not at all without the write path (FR-072's honest words); the tab states it is **read-only in this release and that editing arrives with feature 006**, names no version for 006, offers **no input control and no disabled-looking control**; Status's effective interval and Settings's configured interval each keep owning their own value (FR-039); with the service unreachable the tab keeps its static content and names what could not be read (FR-078). *Tests* (`tests/settings-rows.test.ts`): the service cross-check; AC-135 — rows render with value/unit/bounds and **zero input controls**; AC-132 unreachable ⇒ static content + named cause; an unparseable field renders *unreadable* with its remediation and **never a default as though configured**; a document field absent from the declaration still renders rather than vanishing (research Q2). **(FR-070, FR-071, FR-072, FR-073, FR-078, FR-039, AC-132, AC-135)**
- [x] **T-028** [P] [US6] Create `src/about-tab.ts`: product name; panel id `mecha-turk`; the **single version** read from `GET /v1/health` — rendered *not yet read* before the first read and **`unknown (service unreachable)` naming the service as the source** when unreachable, with **no number and no panel-side literal**; the data directory and the statement that it is the thing to back up; the vocabulary mapping in short form; the manual-cleanup posture naming **OpenChamber's own session and worktree surfaces** (the extension has no deletion API); the pre-1.0.0 release posture; and a **read-only Diagnostics** section holding the ledger, the evidence schema version, and the observed-phase record — no prompt text, no fingerprint, no account identifier, no path beyond the data directory, no edit affordance. *Tests* (`tests/about-tab.test.ts`): AC-133 version equals `SERVICE_VERSION` and the panel source carries exactly one version-shaped literal; AC-134 unreachable ⇒ the exact *unknown (service unreachable)* copy with no digits; AC-132 static content retained; Diagnostics renders ledger entries read-only; credential scan. **(FR-074, FR-075, FR-076, FR-077, FR-029, AC-132, AC-133, AC-134, SC-109)** — *partly superseded by 005 v1.6.0 (2026-10-01 design-feedback scrub): About now renders name · version · description · repository link with the Diagnostics record behind a disclosure, and the panel-id line, data-directory line, vocabulary mapping, cleanup posture, and release posture are removed from it (FR-075 and FR-077 rewritten; `src/vocabulary.ts` deleted with the mapping block). The version rules, the *unknown (service unreachable)* copy, the credential scan, and the read-only record are unchanged.*

**Wave 9 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 10 — Proof (cross-cutting acceptance suites) + documentation (US8, P3)

**Goal**: the spec's measurable outcomes as automated, offline tests, plus the two documents 002 FR-042 puts in scope. Nothing here adds behaviour.

- [x] **T-029** [P] [US8] Finish `tests/vocabulary.test.ts` with the **L1 half**: scan rendered output from all six tabs **and** `README.md` for "Run" as a noun for a work unit and "Repositories" as a noun for bindings, and assert the short mapping list appears in About; assert `test` names and descriptions follow FR-028's layer rule (a test of the Dispatches tab is not a test of `runs-ui.ts`) while wire/domain test subjects keep their names. *Tests*: SC-107, AC-140; the L2/L4 halves from T-003 still pass. **(FR-020, FR-021, FR-028, FR-029, AC-140, SC-107)** — *v1.6.0: the "short mapping list appears in About" half is gone with the page's scrub, so the L1 scan's exemption list is now **empty** (every string the six tabs hand the SDK is scanned) and the mapping assertion lives on `README.md` only.*
- [x] **T-030** [P] [US8] Rendering and accessibility suite: static scan asserting **no HTML sink** (`innerHTML`, `insertAdjacentHTML`, attribute assembly from source text) anywhere the six tabs render operator- or GitHub-supplied strings, plus DOM assertions with hostile `<img onerror>` titles/logins/reasons; accessible-name assertions for every control and every row-level action (FR-081); tab/body association + keyboard operation + visible focus + no trap + tab labels truncating rather than wrapping (FR-082, NFR-107); state conveyed as **text** as well as colour on every banner/label/refusal (FR-083); every irreversible action observed using the two-step arm-confirm idiom and **no `confirm()`** anywhere (FR-084); no refusal echoing a submitted value and no log-through on a redaction refusal (FR-085). **(FR-080, FR-081, FR-082, FR-083, FR-084, FR-085, NFR-101, NFR-107)**
- [x] **T-031** [P] [US8] Lifecycle suite: teardown counts node/timer/disposer back to pre-mount after visiting every tab (AC-137, NFR-108); activating the active tab performs **zero** service reads and opening/switching/refreshing mutates nothing else (FR-014, NFR-104); exactly one relay loop across a mid-flight switch with no second `startSession` (AC-136, SC-108); a failed read retains the last successful content **marked stale** or states plainly that there is none (FR-019, NFR-111); disposal is idempotent and no handle is disposed twice. **(FR-014, FR-017, FR-018, FR-019, AC-136, AC-137, SC-108, NFR-104, NFR-108, NFR-111)**
- [x] **T-032** [P] [US8] Containment, upgrade, and posture suite: secret scans extended over the new surfaces (Status rows, Dispatches rows, Accounts rows, `displayName`, About's Diagnostics) ⇒ **zero credential occurrences, no exemptions** (NFR-102, AC-129); prompt-exactly-once re-asserted here as the cross-tab authority (SC-105); **upgrade loses nothing** — seed a store in the retired `pending | in-flight | dispatched` vocabulary plus bindings, accounts (pre-`displayName`), and a ledger, boot the upgraded panel/service, and assert every row renders through 003's migration table, no quarantine file, no key reset, no bytes rewritten (FR-005, NFR-103); offline guarantee — the whole suite runs with no live host, no real token, no network (FR-086, AC-138); bundle shapes + both bundles contain no secret and ship with their sources (FR-087, AC-139); **no capability added** and manifest identity byte-unchanged (FR-004, FR-079); **no GitHub write** import anywhere (FR-002); **no project/worktree/session/agent mutation** call (FR-089); audit vocabulary untouched — no new/removed/renamed event type (FR-027); **no `host.storage` key added or renamed** and the active tab absent from storage (FR-025); **L3 paths unchanged** — the route table answers `/v1/events*` and the status document still carries `repositories` (FR-023, FR-026). **(FR-002, FR-004, FR-005, FR-023, FR-025, FR-026, FR-027, FR-079, FR-086, FR-087, AC-138, AC-139, NFR-102, NFR-103)**
- [x] **T-033** [US8] Documentation sync (002 FR-042, 005 FR-020/FR-029): update `README.md` and `specs/002-agent-event-extension/quickstart.md` to the shipped surface — the six tabs and their vocabulary, the prerequisites section on Status (superseding the walkthrough's "there is no in-panel setup checklist in this MVP" sentence), the Dispatches list with paging/filter/affordances, the Settings tab as the configuration surface including the agent-verification baseline the card no longer carries, and the Accounts add form as the expected-login supply surface; reproduce the vocabulary mapping table in `README.md` in full and in About in short form; final-pass `AGENTS.md`'s module map for every renamed/added module. Assert neither document instructs `.env`/`MECHA_TURK_*` configuration, presents an unlabelled `specs/001-agent-event-orchestrator/` path, or names a retired tab. **(FR-020, FR-029, 002 FR-042, AC-140)** — *v1.6.0: the mapping table is reproduced in `README.md` **in full only** — About's short form went with the 2026-10-01 scrub (FR-029), and both documents' About descriptions were re-synced to name · version · description · repository link.*
- [x] **T-034** Final gate: `npm run verify` green (build → lint → typecheck → test); `panel/main.js` + `service/main.js` rebuilt and **committed with their sources**; `SERVICE_VERSION` still `0.0.1` and still pinned to `package.json` by `tests/service-server.test.ts`; **zero** suppressions and **zero** `any` introduced; `git status` clean of unintended files; record per-AC status for **AC-101–AC-141** in the commit/PR body with the `Generated-By` attribution trailer. **(FR-087, FR-088, SC-110)**

**Wave 10 boundary**: `npm run verify` — this is the release candidate gate for 005's Phase 6.

---

## Dependencies & execution order

```
Wave 1 (T-001)  ──blocks──▶ Wave 2 (T-002 → T-003) ──blocks──▶ Wave 3 (T-004 ∥ T-005 ∥ T-006)
                                                                     │
                                                                     ▼
                                        Wave 4 (T-007 → T-008 → T-009 → T-010 → T-011)
                                                                     │
                    ┌────────────────────────────────────────────────┤
                    ▼                                                ▼
   Wave 5 (T-012 → T-013 → T-014 ‖ Status)        Wave 6 (T-015 → T-016 → T-017 → T-018, T-019 ∥)
                    │                                                │
                    └──────────────► Wave 7 (T-020 → T-021 → T-022, T-023 ∥) ◄──────┘
                                                     │
                                     Wave 8 (T-024 → T-025 → T-026)
                                                     │
                                     Wave 9 (T-027 ∥ T-028)
                                                     │
                                     Wave 10 (T-029…T-032 ∥, T-033 → T-034)
```

- **Parallel-safe within a wave**: T-003 (test-only, after the renames); T-004 ∥ T-005 ∥ T-006 (three different service modules: `status.ts`+`poll/view.ts`, `events.ts`, `accounts/*`); T-014 (status edge fixtures, after T-012); T-019 (test-only); T-023 (bindings copy sweep, after T-020–T-022); T-027 ∥ T-028 (`settings-*` vs `about-tab`); T-029 ∥ T-030 ∥ T-031 ∥ T-032 (four separate suites); T-033 after every behaviour task.
- **Hard dependencies**: T-002 needs T-001 (both sweep `panel-state.ts`/`panel-ui.ts`/`app.ts` — ordered so each commit is green); T-007 needs T-001+T-002 (it dissolves the renamed types); T-008 needs T-007 (`TabId` lives on the runtime); T-009 needs T-008; T-010 needs T-009; T-011 needs T-010 (the legacy verdict's surface must be gone first — plan D12); T-012 needs T-004 (its data) and T-009 (its body); T-013 needs T-012; T-015 needs T-005; T-016 needs T-015's DTO; T-017 needs T-016; T-018 needs T-017; T-021 needs T-020; T-022 needs T-020; T-025 needs T-024; T-026 needs T-024+T-025; T-027/T-028 need T-009 (their bodies); T-029–T-032 need every behaviour task; T-034 needs all.
- **Story coverage**: US1 → W3 (T-004), W5 (T-012, T-014); US2 → W3 (T-005), W6 (T-015–T-019); US3 → W7 (T-020–T-023); US4 → W3 (T-006), W8 (T-024–T-026); US5 → W1, W2, W4; US6 → W9 (T-027, T-028); US7 → W5 (T-013); US8 → W10 (T-029–T-034).
- **MVP slice if delivery is cut**: Wave 1 + Wave 2 + Wave 3 + Wave 4 + T-012 + T-015…T-018 — the rename, the honest status, the shell, and the dispatch list are the four things the feature exists for; **but no wave boundary ships without `npm run verify` green and both bundles rebuilt and committed.**

## Requirement → task coverage (traceability)

FR numbers are quoted exactly as written in `spec.md` v1.3.0; cross-spec requirements are prefixed (`002 FR-…`).

| Requirement(s) | Tasks |
| --- | --- |
| FR-001 (authority) | T-034; out-of-scope guard at the head of this file |
| FR-002 (GitHub read-only) | T-032 |
| FR-003 (fail closed) | T-005, T-014, T-015, T-016, T-027, T-030 |
| FR-004 (no capability) | T-011, T-032 |
| FR-005 (no loss on upgrade) | T-006, T-010, T-032 |
| FR-006 (expected-login supply surface) | T-025 |
| FR-010, FR-012 (six tabs, one activation field) | T-007, T-008, T-009 |
| FR-011 (SDK primitive; spike retired not hidden) | T-008, T-009, T-010 |
| FR-013 (mount on first activation) | T-008 |
| FR-014 (idempotent activation, last-read stamp) | T-008, T-012, T-031 |
| FR-015 (opens on Status, not persisted) | T-007, T-032 |
| FR-016 (keyboard + accessible association) | T-008, T-030 |
| FR-017 (teardown disposes all six) | T-008, T-009, T-031 |
| FR-018 (exactly one relay loop) | T-010, T-019, T-031 |
| FR-019 (per-tab read state, stale marking) | T-012, T-014, T-031 |
| FR-020 (L1 vocabulary) | T-012, T-016, T-017, T-023, T-024, T-027, T-028, T-029, T-033 |
| FR-021 (mapping table normative) | T-003, T-029 |
| FR-022 (L4 retained) | T-002, T-003, T-029 |
| FR-023 (wire paths retained) | T-032 |
| FR-024 (L2 renames) | T-001, T-002, T-003, T-007 |
| FR-025 (no storage key change) | T-032 |
| FR-026 (`repositories` member kept, rendered Bindings) | T-004, T-012, T-032 |
| FR-027 (audit vocabulary unchanged) | T-032 |
| FR-028 (test naming follows the layer rule) | T-001, T-002, T-029 |
| FR-029 (mapping in README + About) | T-028, T-033 |
| FR-030 (every 002 FR-036 element on Status) | T-012 |
| FR-031 (polling computed) | T-004, T-014 |
| FR-032 (`repositories` rows) | T-004, T-014 |
| FR-033 (agentPin widened) | T-004, T-012 |
| FR-034 (rate honesty) | T-004, T-012 |
| FR-035 (storage-blocked notice) | T-012, T-025 |
| FR-036 (unsupported surface) | T-009, T-012 |
| FR-037 (prerequisites on Status) | T-013 |
| FR-038 (picker guidance placement + Status link) | T-013, T-022 |
| FR-039 (Status/Settings value ownership) | T-012, T-027 |
| FR-040 (sole dispatch list) | T-017, T-032 |
| FR-041 (labels, reasons, migration projection, unknown state) | T-016 |
| FR-042 (pagination) | T-005, T-015, T-017 |
| FR-043 (server-side filters) | T-005, T-015, T-017 |
| FR-044 (state-accurate retry) | T-016, T-018 |
| FR-045 (return to waiting) | T-016, T-018 |
| FR-046 (refusal renders, no optimistic flip) | T-018 |
| FR-047 (verification warning) | T-016 |
| FR-048 (multi-reference reveal) | T-016, T-017 |
| FR-049 (one read, one action path, busy gate, copy) | T-018 |
| FR-050 (whole-file CRUD, no PATCH) | T-020 |
| FR-051 (prompt rendered exactly once) | T-021 |
| FR-052 (prompt refusal) | T-021 |
| FR-053 (editor field list) | T-022 |
| FR-054 (enable/disable read back) | T-020 |
| FR-055 (cascade visible before it happens) | T-026 |
| FR-056 (project-missing recoverable) | T-022 |
| FR-057 (mention-token override) | T-022 |
| FR-058 (one surface, byte-identical refusal) | T-020 |
| FR-059 (no tuning, no surplus accounts) | T-023 |
| FR-060 (create/read/rotate/remove) | T-025, T-026 |
| FR-061 (handoff relocated not redesigned) | T-025 |
| FR-062 (row field list) | T-024 |
| FR-063 (first-class bad states + binding consequence) | T-024 |
| FR-064 (rotation retains history) | T-026 |
| FR-065 (two-step removal, disabled not deleted) | T-026 |
| FR-066 (displayName) | T-006, T-026 |
| FR-067 (credential-free by construction) | T-006, T-024, T-032 |
| FR-068 (pending_handoff vs interrupted-handoff) | T-024 |
| FR-069 (no token read-back) | T-024 |
| FR-070 (Settings read-only in 005) | T-027 |
| FR-071 (rows with value/unit/bounds) | T-027 |
| FR-072 (honest take-effect) | T-027 |
| FR-073 (states read-only; names 006, not a version) | T-027 |
| FR-074 (version from `GET /v1/health`, no literal) | T-028, T-034 |
| FR-075 (About content + read-only Diagnostics) | T-010, T-028 |
| FR-076 (no credential/path exposure) | T-028, T-032 |
| FR-077 (manual-cleanup posture) | T-028, T-033 |
| FR-078 (render without the service) | T-027, T-028 |
| FR-079 (identity unchanged) | T-011, T-032 |
| FR-080 (non-HTML path) | T-030 |
| FR-081 (accessible names incl. row actions) | T-017, T-030 |
| FR-082 (association, keyboard, narrow width) | T-008, T-030 |
| FR-083 (state as text) | T-030 |
| FR-084 (two-step arm-confirm everywhere) | T-018, T-026, T-030 |
| FR-085 (refusals name cause, never echo) | T-018, T-021, T-026, T-030 |
| FR-086 (offline only) | T-032 |
| FR-087 (bundles, pin, pre-1.0.0) | every wave boundary, T-034 |
| FR-088 (zero suppressions/`any`, one dispatch path) | T-034 |
| FR-089 (no project/session mutation) | T-022, T-032 |
| 002 FR-029, 002 FR-041, 002 FR-042, 002 AC-021, 002 AC-023 | T-011, T-033 |
| 003 FR-041, 003 FR-042 (retry validity), 003 FR-033 (return to waiting), 003 FR-070–FR-074 (guidance, prerequisites, labels) | rendered by T-013, T-016, T-018, T-022 — **behaviour is 003's; 005 adds no transition** |
| 004 FR-010–FR-014, 004 FR-024, 004 FR-050–FR-054 (the field 005 renders) | T-021, T-032 |
| 006 FR-001, 006 FR-011, 006 FR-014, 006 FR-021, 006 FR-100 (what lands on this shell later) | T-027 (row structure designed to carry 006's controls in place; **no edit surface in 005**) |

## Non-functional requirement → task coverage

| Requirement | Tasks |
| --- | --- |
| NFR-101 (rendering safety) | T-030; per-tab rendering assertions in T-012, T-016, T-024, T-027, T-028 |
| NFR-102 (secret containment) | T-006, T-024, T-032 |
| NFR-103 (durability and preservation) | T-006, T-032 |
| NFR-104 (idempotency of read) | T-008, T-031 |
| NFR-105 (offline determinism) | T-032; every task's own test gate |
| NFR-106 (compatibility: unchanged pin, floor, capabilities) | T-011, T-032, T-034 |
| NFR-107 (accessibility) | T-008, T-030 |
| NFR-108 (teardown completeness) | T-009, T-031 |
| NFR-109 (code quality: zero suppressions/`any`, one dispatch path) | T-034; enforced at every wave boundary |
| NFR-110 (release discipline: bundles, pin, pre-1.0.0) | every wave boundary, T-034 |
| NFR-111 (observability: failed reads visible) | T-012, T-031 |
| NFR-112 (honest defaults) | T-012, T-014, T-016, T-027, T-030 |

## Acceptance criterion → task coverage (AC-101 – AC-141, quoted as written)

| Acceptance criterion | Tasks |
| --- | --- |
| AC-101 (six tabs, Status active) | T-008, T-009 |
| AC-102, AC-103 (honest `polling`) | T-004 |
| AC-104, AC-105 (`repositories` rows, unreadable marked) | T-004, T-014 |
| AC-106 (agent pin never "ok") | T-004, T-012 |
| AC-107 (rate not `0 of 0`) | T-004, T-012 |
| AC-108 (storage-blocked notice + disabled input) | T-012, T-025 |
| AC-109 (unsupported surface) | T-012 |
| AC-110, AC-111 (prerequisite notice / no nag) | T-013 |
| AC-112 (not-listed? routes, recoverable) | T-022 |
| AC-113 (every state labelled + affordance table) | T-016 |
| AC-114 (`pending`: Retry absent) | T-016, T-018 |
| AC-115 (`unconfirmed`: Resolve names what to check) | T-016, T-018 |
| AC-116 (`blocked:project-missing`: disabled + named) | T-016, T-018 |
| AC-117 (return to waiting states the reset) | T-016, T-018 |
| AC-118 (refused retry renders its reason, row unchanged) | T-018 |
| AC-119 (verification warning, not a blocker) | T-016 |
| AC-120 (three references, post-authorization marked) | T-016, T-017 |
| AC-121 (250 dispatches all reachable) | T-005, T-017 |
| AC-122 (filter matched nothing + clear) | T-017 |
| AC-123 (prompt exactly once; row shows presence/length) | T-021, T-032 |
| AC-124 (credential-shaped prompt refused, previous kept) | T-021 |
| AC-125 (invalid submission ⇒ others byte-identical) | T-020 |
| AC-126 (arm states the cascade, deletes nothing) | T-026 |
| AC-127 (removed account ⇒ bindings disabled with reason) | T-026 |
| AC-128 (login rename leaves `displayName`) | T-006, T-026 |
| AC-129 (no credential member; scan without exemption) | T-006, T-024, T-032 |
| AC-130 (credential-shaped display name refused) | T-006, T-026 |
| AC-131 (reopen ⇒ Status) | T-007, T-009 |
| AC-132 (Settings/About render without the service) | T-027, T-028 |
| AC-133 (About version = `package.json`, one literal) | T-028, T-034 |
| AC-134 (unreachable ⇒ *unknown (service unreachable)*) | T-028 |
| AC-135 (Settings rows, no input control) | T-027 |
| AC-136 (one relay loop across a switch) | T-010, T-019, T-031 |
| AC-137 (teardown counts return to pre-mount) | T-009, T-031 |
| AC-138 (suite runs offline) | T-032 |
| AC-139 (bundles rebuilt + committed with sources) | every wave boundary, T-034 |
| AC-140 (no "Run"/"Repositories" nouns in panel or README) | T-029, T-033 |
| AC-141 (`expectedLogin` empty ⇒ null; manifest declares none) | T-011, T-025, T-032 |

## Success criterion → task coverage

| SC | Tasks |
| --- | --- |
| SC-101 / SC-102 (zero literals, zero fixed empties) | T-004 |
| SC-103 (six tabs, no `hidden` on a spike container) | T-009 |
| SC-104 (one table drives every state) | T-016 |
| SC-105 (prompt exactly once, fails at 0 and 2) | T-021, T-032 |
| SC-106 (250 rows page through) | T-005, T-017 |
| SC-107 / SC-111 (vocabulary, one path per capability) | T-029 |
| SC-108 (one loop, zero orphans, zero timers) | T-019, T-031 |
| SC-109 (About version = `package.json`, one literal) | T-028, T-034 |
| SC-110 (`npm run verify` green before every commit) | every wave boundary, T-034 |
| SC-112 (unknown/unmeasured/not-checkable distinguishable) | T-012, T-014, T-016, T-027, T-030 |

## Test expectations summary (per task's own gate)

Fail-first where behaviour changes (status literals, the paging/filter answer, `canRetry` → the affordance table, the prompt's exactly-once count, the settings cross-check), golden literals for anything that must stay byte-identical (consent text, migration projection, `SERVICE_VERSION`, manifest identity), offline only (fake host / loopback service on temp dirs / DOM helpers), **no `sleep`-based timing** (drive the poll view and the page state with injected stamps; the relay test instruments the fake host's call log rather than waiting on a clock), a planted sentinel scanned for in every refusal path, and **zero suppressions** — a red lint or a red test is fixed, never muted.


> **2026-10-01 — test consolidation note (spec amended for change efficiency).**
> Every named test file still exists: **no file was renamed or deleted**, so the
> paths in this document remain valid. What changed is granularity — the suite
> went **1441 → 532 tests** by dropping copy-only pins and folding scenario
> `it()`s into table-driven proofs. A task that names a specific `it()` should
> be read as naming the *case* inside its merged proof; the `// case:` comment
> in the file locates it. `crash-permutations.test.ts`,
> `dispatch-end-to-end.test.ts`, and `redaction.test.ts` are untouched.

---
---

## Issue #9 block — the actor allow-list's rendering (added 2026-10-03)

**Task ids `C-1 … C-6`. The task text, its gate, and the wave graph live in the consolidated list** at
[`002-agent-event-extension/tasks.md` §"Issue #9 block (2026-10-03)"](../002-agent-event-extension/tasks.md),
which is the single source of truth for all three amended features. This block is a locality index
and nothing more — do not fork a task from it.

| Task | Surface | One line |
| --- | --- | --- |
| **C-1** | `src/bindings-service.ts` | `PanelBinding.allowedUsers?`; the entry reader **refuses all three unusable shapes** — non-array, non-text element, and explicitly empty array; the member is sent explicitly on every row and the key omitted when unset *(task text corrected 2026-10-03 to name the empty-array refusal; the task of record is 002 `tasks.md` §C-1)* |
| **C-2** | `src/bindings-actors.ts` (**new**, beside `src/bindings-prompt.ts`) | the one editor field with its three-state guidance, the row **count**, the worded absent-policy warning, and the refusal slot |
| **C-3** | `src/bindings-grant.ts` | the member rides every row of the whole-file write; the "nothing changed" refusal note keeps its allow-list slot |
| **C-4** | `service/routes/{events,status}.ts`, `src/status-document.ts`, `src/status-lines.ts`, `src/status-tab.ts` | `actorPolicy` on each `repositories[]` row; the parser **refuses the whole document** on an out-of-vocabulary *or absent* value, because NFR-113 forbids the two defaults an absent member would invite; Status's counted line with its zero case, its unreachable case, and no login and no repository name *(task text corrected 2026-10-03 to state what an absent member does; the task of record is 002 `tasks.md` §C-4)* |
| **C-5** | `src/dispatches-rows.ts` | each source reference's actor; a `direct` reference renders **no basis clause**, and a legacy `subject-author` reference renders a **historical** one — attributed under the rule in force when the row was written — that does not claim GitHub lacks the field (FR-094 as re-cut at 005 v1.13.0; supersedes "where it is a proxy — its basis in the panel's own words"); the refused run names the denied login; Retry's validity comes from the existing table |
| **C-6** | `tests/bindings-actors.test.ts` (new), `tests/status-tab.test.ts`, `tests/dispatches.test.ts`, the string scan | **005 AC-142 – AC-146**, the exactly-once count, and the *protected/restricted/secure* scan |

**Phase 5 gate flag for this block** (decided for planning only; see
[plan.md §C.5](./plan.md) and [`002/pm-handoff.md` §Flagged](../002-agent-event-extension/pm-handoff.md)
§Flagged #2): **the empty-list round trip.** 005 FR-090 ("the panel MUST NOT pre-emptively accept
input the service would refuse") and 005 AC-142 ("submitting `[]` is refused by the service" **and**
"the panel contains no second control") cannot all hold unless the panel either submits `[]` — and
can then never remove a list — or omits the key. **Chosen:** omit the key, and discharge AC-142's
`[]` case against the service plus the panel's own refusal-rendering path. **One confirmation
requested** from the product owner (research §Q3).

---

---

## Issue #20 block — the Status tab's refresh cadence (added 2026-10-05)

**Spec**: [spec.md](./spec.md) v1.16.0 — `FR-014` (as re-cut), `FR-019` (as re-cut), `FR-030`, `FR-039`,
`FR-100`, `FR-101`, `NFR-104` (as re-cut), `NFR-108`, `NFR-111`, `NFR-112`, `005 SC-114`,
`005 AC-150`, `005 AC-151`, `005 AC-152`. **Plan**: [plan.md](./plan.md) §D — **this block's
decisions are D19 … D23** and its flagged items are D.5.

**Bar**: the Status tab keeps its own answer current without being asked, says in words that it is
doing so and on what period, and never shows a period no document reported. **The panel holds no
default for the cadence** and falls back to nothing — not to 60 000 ms, not to the service default,
not to the configured interval. Tests are offline and driven by a fake clock (`vi.useFakeTimers` over
`setInterval`/`clearInterval`/`Date`), with the production `tabSpecs` mounted against the fake host
and the fake DOM.

- [x] **T-037** [US1] **Runtime slots and the one id two modules must agree on** — `src/panel-state.ts`:
  export `STATUS_TAB` (the one `TabId` that owns a cadence, named rather than spelled at each
  comparison because `status-tab.ts` and `tabs.ts` both test against it and a mismatch is a cadence
  that arms for a hidden tab), and add `statusRefreshTimer` + `statusRefreshMs` to `PanelRuntime`,
  both initialised to `null` and documented as one fact in two slots written only by the arm/stop
  pair. Replace the `activeTab: 'status'` literal in `createPanelRuntime` with the constant.
  *Tests*: none of its own — a slot declaration has no behaviour; its first assertion is T-039's.
  *(FR-100, FR-101, NFR-112)*
- [x] **T-038** [US1] **The tick, its lifecycle, and the copy** — `src/status-tab.ts` +
  `src/status-lines.ts`: add `armStatusRefresh` / `stopStatusRefresh` following `relay.ts`'s
  `startRelayPolling` / `stopRelayPolling` precedent exactly — `setInterval`, `.unref()` when
  present, idempotent arm, and a clear on teardown — with the tick's body passed in rather than
  named (plan D19, because the read arms the timer and the timer calls the read); arm from **inside**
  `loadStatus`, after the slice lands and before the repaint, on `view.polling.intervalMs` and on
  nothing else (plan D20); clear in `disposeStatusTab` so the tick is one of the timers FR-017's
  disposers release; add `cadenceLine` to `StatusTabUi` and render it in the toolbar row beside
  `Refresh status` and the read-state line (plan D22), with its interval-less value naming the cause
  of the ignorance (plan D23) and **no branch that can invent a period**. **Leave `loadStatus`'s
  `phase === 'loading'` guard exactly as it is** — it is FR-100 §2's in-flight rule and must not be
  weakened. *Tests*: the copy assertions are T-039's rendering half; the lifecycle assertions are
  T-039's clock half. *(FR-100, FR-101, FR-019, FR-014, NFR-108, NFR-111, NFR-112)*
- [x] **T-039** [US8] **The driven-clock suite** — `tests/status-refresh.test.ts` (new), covering
  **all eight `005 SC-114` clauses** and `005 AC-150` – `AC-152`: **(a)** one read at activation and
  one more per period, asserted at 59 s / 60 s / 180 s and from the request log's gaps;
  **(b)** the whole panel's request count unmoved across three periods while it sits on Bindings;
  **(c)** re-activation issues zero requests on each of the other five tabs, per tab, with a
  non-vacuity assertion that one of them really does read at activation;
  **(d)** after teardown the timer count is back to its pre-mount value and three further periods
  move no read — asserted **from Status and from another tab**, because NFR-108 counts both;
  **(e)** a later `intervalMs: 30_000` re-arms and the old period stops firing;
  **(f)** the refused read, the document the fail-closed parser refuses over an unreadable
  `intervalMs` (plan D.5 #1), a configured interval that disagrees with the effective one, and a
  failed `GET /v1/config` — none arms a tick, none renders a period (the test scans every rendered
  string for six candidate numbers), and `Refresh status` reads on demand in all of them;
  **(g)** three refused ticks leave **one** stale marker naming only the latest cause, the stamp
  unmoved, the button live, and the request-log gaps exactly one interval each;
  **(h)** a tick during an in-flight read issues one request, and the button press is refused by the
  same guard. Plus the statements FR-101 makes: the armed copy carries the period, and it is identical
  after activation, after a tick, and after a press. *Tests*: the suite is the gate; it is proved
  non-vacuous by mutation (dropping the idempotent arm, dropping the disarm, hard-coding the period,
  dropping the period from the copy, dropping the interval-less copy, and forgetting the disposer's
  clear each fail at least one case). *(FR-100, FR-101, FR-014, FR-019, `005 SC-114`, `005 AC-150`,
  `005 AC-151`, `005 AC-152`, NFR-105, NFR-108, NFR-111, NFR-112)*
- [x] **T-040** [US5] **Activation is where the cadence's lifetime is driven** — `src/tabs.ts`:
  split `activate()`'s single `id === rt.activeTab` early return so that (i) leaving Status calls
  `stopStatusRefresh` **before** anything else runs, so the window between the click and the next
  repaint is one in which a backgrounded tab can still read; (ii) re-activating the already-active
  tab stays a pure no-op on the five tabs that own no cadence and reads on **Status**; and (iii)
  switching *to* Status reads immediately. Re-cut the module docblock's "activation is idempotent"
  bullet to state the exception and its two reasons. *Tests*: T-039's clauses (b), (c), and (d).
  *(FR-014 as re-cut, FR-100, NFR-104)*
- [x] **T-041** [US8] **Final gate** — `npm run verify` green (build → lint → typecheck → test) with
  **zero** suppressions and **zero** `any` introduced; the rebuilt `panel/main.js` **committed with
  its sources** (invariant 1); `SERVICE_VERSION` still `0.0.1`; `contracts/panel-service.md`
  **unmodified** and no other feature's document touched; `git status` clean of unintended files;
  per-clause status for `005 SC-114` and `005 AC-150` – `AC-152` in the commit body with the
  `Generated-By` attribution trailer. *(FR-087, FR-088, NFR-109, NFR-110)*

**Wave boundary**: `npm run verify` green + rebuilt bundle committed.

### Requirement → task coverage (this block)

| Requirement | Tasks |
| --- | --- |
| FR-014 (as re-cut at v1.16.0), NFR-104 (as re-cut) | T-038, T-039, T-040 |
| FR-019 (as re-cut: a failing tick is a failing read) | T-038, T-039 |
| FR-030 (the Polling block's effective interval is also the panel's period) | T-038, T-039 |
| FR-039 (no fallback to the configured interval; not a configuration field) | T-039 |
| FR-100 (lifecycle, in-flight guard, the interval-less window, cadence ≠ retry) | T-037, T-038, T-039, T-040 |
| FR-101 (the worded cadence statement) | T-038, T-039 |
| NFR-105 (offline determinism), NFR-108 (teardown completeness), NFR-111 (observability), NFR-112 (honest defaults) | T-037, T-038, T-039 |
| `005 SC-114` (a) – (h) | T-039 |
| `005 AC-150`, `005 AC-151`, `005 AC-152` | T-039 |
| FR-087, FR-088, NFR-109, NFR-110 (release discipline) | T-041 |
---

## Issue #18 block — the zero-account binding gate, and the reason copy that must be true either way (added 2026-10-05)

**Task ids `K-1 … K-12`.** [plan.md §K.3](./plan.md) (amendment record — 005 v1.17.0) is the design of
record: `D19`–`D26` and the truth table in §K.3. [spec.md](./spec.md) v1.16.0 block L is the
requirement of record: `FR-120` – `FR-124`, `005 SC-115`, `005 AC-154` – `005 AC-156`, Clarification
rows **49 – 53** (decisions at 49, 50, 51, 53; row 59 is the scope/divergence record).

**Bar**: with **zero accounts at all**, *New binding* is disabled, one worded line under the list's
toolbar says so, and the list's empty text stops instructing the operator to press the control the
same fix disables. Five requirements, **five** ratified decisions, **three** empty-text rows over one
predicate, **four** Edge Cases bullets, **four** `## Out of Scope` entries, **one** residual (FR-124's
`usable`-versus-`exists` divergence). **Panel-side only** (FR-124): no service, route, wire member,
status or error code, stored document, `host.storage` key, or contract moves.

**This block deviates from the C-block's convention, deliberately.** The issue #9 block is a locality
index pointing at `002-agent-event-extension/tasks.md`, because three features shared one task list.
**Issue #18 touches one feature and one panel tab**, so the full task text lives here, in the
directory whose `spec.md` and `plan.md` own it. Nothing is forked from the C-block.

### The one structural requirement — read this before writing the selector

FR-122's **consistency rule** is only real if the **gate** and the **empty-text selector** consume the
**same named predicate**: D20's `accountsRead(bindings)`. Two separately-written tests of
`status === 'ready'` can drift, and a **length-keyed** selector reintroduces the defect Clarification
row 60 closed — `loadBindings` deliberately **retains the previous accounts list** when a read fails
(`src/bindings.ts:186–190`), so a failed read after a successful read of an **empty** list leaves
`accounts.length === 0` and a length test would tell an operator with a **broken service** that they
have no accounts. **K-4 exists for this alone** and carries a source-level assertion, not a comment.

### Dependencies

`K-1` → everything. `K-2` → `K-3`, `K-4`. `K-3` + `K-4` → `K-5`. `K-5` → `K-6`, `K-7`, `K-8`.
`K-6`, `K-7`, `K-8` → `K-9`. `K-9` → `K-10`, `K-11`. `K-10`, `K-11` → `K-12`.

### Wave K-a — the shared module and its three branches

**Goal**: the tab's account-side derivations exist as one leaf, with the predicate named once.
Independent test: `emptyBindingsText` and `accountGate` over the §K.3 truth table, and a source scan
proving both read the one predicate.

- [ ] **K-1** `npm ci` — the toolchain install, before anything else. **`node_modules` is absent in
  this worktree**, so `npm run verify`, `npm run build`, `npm test` and `npm run shot` all fail with
  a missing-binary error until this runs. Node ≥ 24.15 per `engines.node`; bun arrives via `bunx` at
  build time. No source change, no commit of its own. *Gate*: `npx vitest run --reporter=dot` reaches
  the existing suite and it is green before any task below starts, so a later red is this block's.
- [ ] **K-2** Create **`src/bindings-accounts.ts`** — the new leaf (D23). It imports only
  `@openchamber/sdk/ui` and types, so **no cycle** is introduced; it is composed by `bindings-body.ts`,
  `bindings-ui.ts`, `bindings-editor.ts` and `bindings-draft.ts`, never the reverse. Contents:
  - the **seven string constants** — `ACCOUNT_REQUIRED_REASON` (FR-121's line, and FR-123's refusal
    row 1: **one** constant, two positions), `EMPTY_TEXT_NO_ACCOUNTS`, `EMPTY_TEXT_WITH_ACCOUNT`
    (**the retained `LIST_EMPTY`, verbatim**), `EMPTY_TEXT_NOT_KNOWN` (FR-122's third row),
    `ACCOUNT_PICKER_PLACEHOLDER`, `NO_ACTIVE_ACCOUNT_REFUSAL`, `PICK_ACCOUNT_REFUSAL` (**the retained
    `ACCOUNT_NOTE`, verbatim**);
  - **`accountsRead(bindings)`** — the single named read-success predicate (D20);
  - **`accountGate(bindings)`** — `blocked ⇔ accountsRead(bindings) ∧ accounts.length === 0`,
    consumed by `K-6`;
  - **`emptyBindingsText(bindings)`** — D21's **three** branches, in order: branch 1 tests
    `accountsRead` and **never** `accounts.length`; branch 2 the empty list; branch 3 the retained
    string;
  - **`accountSelectionRefusal(bindings)`** — D22's total three-case dispatch, ordered *none exist →
    some `usable` → otherwise*, returning `ACCOUNT_REQUIRED_REASON` for case 1;
  - each constant's docblock naming the requirement it serves and, where it is retained copy, the
    string it replaces.
  **Do not** mount, repaint, or read a DOM handle in this task — the derived half is pure and is
  provable without a browser. *Tests* (`tests/bindings-accounts.test.ts`, created here, pure cases
  first): the §K.3 truth table row by row for `accountGate` and `emptyBindingsText` — `idle` /
  `loading` / `error` ⇒ the *not-known* string with **any** `accounts.length`, including the stale
  `0`; `ready` + `0` ⇒ the *add an account* string; `ready` + `≥ 1` ⇒ the retained string;
  `accountSelectionRefusal`'s three rows; `ACCOUNT_REQUIRED_REASON` returned by **both** call sites is
  the **same string value**, asserted by identity as well as by text. **(FR-120, FR-122, FR-123)**
- [ ] **K-3** **The single-named-predicate assertion — this task's whole content.** FR-122's
  consistency rule is a claim about *shape*, so it is asserted at the source level, in the same suite:
  1. **`emptyBindingsText` and `accountGate` consume one predicate.** Read
    `src/bindings-accounts.ts` and assert there is exactly **one** occurrence of a
    `status === 'ready'` comparison across the module, that it sits in `accountsRead`, and that
    **neither** `accountGate` **nor** `emptyBindingsText` compares `bindings.status` itself. Two
    copies of the comparison fail this; so does moving the gate's test inline.
  2. **The selector is not length-keyed.** Assert `emptyBindingsText`'s source contains **no**
    `accounts.length` test *before* its `accountsRead` branch — the stale-empty case would render the
    wrong row otherwise. Behaviourally, the table-driven stale fixture in `K-2` already covers it;
    this assertion is what stops a later "simplification".
  3. **The gate is not pre-read** and not `usable`-keyed: `accountGate` returns `blocked: false` for
    `idle`, `loading`, and `error` with an empty list, and for `ready` with accounts that are all
    `usable: false`.
  Written as a scan with **named exemptions in data** (the shape `tests/bindings-actors.test.ts` uses
  for AC-146), so a widening fails **with the offender's name** rather than a bare `false`. No
  suppression, no `any` (invariant 7). *Gate*: the assertion fails against a selector whose branch 1
  reads `accounts.length === 0` instead of `accountsRead(bindings)` — prove it by trying that edit
  and watching it go red, then reverting. **(FR-122's consistency rule, FR-120, clarification row 60)**
- [ ] **K-4** The mounted half of the same module (D19), still no caller changed: `mountAccountReason`
  appends a `div` carrying `hidden` and a `mountText` line **into the list block, directly after
  `createToolbar(pane)`** — DOM order `status → note → list grid → toolbar → reason → selected-row
  detail`; `repaintAccountReason` sets `hidden` from `accountGate` **and** clears the text when the
  gate does not hold, so "absent" survives a DOM reading and not only a visual one; `disposeAccountReason`
  releases both. The wrapper is the codebase's own idiom (`detailBox`, `editorBox`, `agentNoticeBox`)
  and needs no SDK capability beyond `mountText`. *Tests*: mount into the DOM double and assert the
  line's position is immediately after the toolbar and **before** the selected-row detail; assert
  `hidden` **and** empty text when the gate does not hold; assert dispose releases both. **No button,
  link, or any other control is added anywhere on the tab** (FR-121) — asserted by counting the
  mounted primitives on the list block. **(FR-121, FR-120)**

**Wave K-a boundary**: `npm run verify` green; `npm run build`; the rebuilt bundles committed with the
sources. *The derivations exist and the consistency rule is asserted.*

---

### Wave K-b — the three callers, each with the test that proves it

**Goal**: the gate, the reason line, the placeholder and the refusal are live on the tab. Independent
test: mount the tab in each of the §K.3 states and read the props the operator would meet.

- [ ] **K-5** Wire the **mount and the repaint** (`src/bindings-body.ts`, `src/bindings-ui.ts`):
  `mountBindingsBody` mounts the reason line after the list toolbar and adds its handle to `BindingsPane`
  (**exactly one** new member) and to the disposer; `mountBindingsBoard` calls
  `emptyBindingsText(rt.state.bindings)` at the `mountList` call and `LIST_EMPTY` (line 79) is
  **deleted**; `repaintBindingsPane` gains **exactly two** lines — the reason repaint, and `emptyText`
  on the existing `bindingsList.update({ … })` (`ListHandle.update` already accepts it; see
  `src/dispatches-ui.ts:419`). *Tests* (`tests/bindings-accounts.test.ts` extended, DOM double +
  mount journal): zero accounts ⇒ the reason line reads FR-121's sentence as **text** while *New
  binding* is disabled — FR-083's "text, not colour or the attribute alone"; one account ⇒ the line is
  **absent** (hidden **and** empty, not present-and-blank) and the empty text is the retained string;
  **both directions**, because a constant that is always on or always off passes a one-sided suite;
  the empty text reaches `emptyText` on the **repaint** path and not only at mount; no control is
  added to the toolbar, the list, or anywhere on the tab. **(FR-121, FR-122, AC-154, SC-114)**
- [ ] **K-6** **The gate** (`src/bindings-editor.ts`): `repaintBindingActions`'s `newBinding` line
  gains the gate **conjunctively** — `disabled: bindings.status !== 'ready' || accountGate(bindings).blocked`
  — and the `add`, `cancel`, `toggle` and `removeSelected` lines are **untouched**. The gate is
  `accountGate`, the shared predicate: **no second comparison of `status`** here (K-3 asserts it).
  Gating `add` as well is forbidden (K.7). *Tests*: zero accounts ⇒ `newBinding.disabled === true`;
  **one** account ⇒ `false`; **two accounts, neither `active`** ⇒ `false` (the gate is zero-*at-all*,
  not zero-*usable*, FR-120); `idle` / `loading` / `error` with an empty list ⇒ `true` by the read-state
  condition **alone**, with the reason line absent and no *no-accounts* string (AC-156's three read
  states); the other four controls' `disabled` are byte-identical to before this change. **(FR-120, FR-124, AC-154, AC-156)**
- [ ] **K-7** **The refusal dispatch** (`src/bindings-draft.ts`): delete `ACCOUNT_NOTE` (line 74) and
  have `draftAccount` assign `accountSelectionRefusal(bindings)` to `bindings.note` — **the add form's
  existing note channel**, which is where the operator is when they press *Add binding* (FR-121's
  channel rule reserves the toolbar line for the gate). *Tests*: accounts present and **none**
  `usable`, none selected ⇒ the refusal is `No active account — fix or replace an account on the
  Accounts tab`, **never** the old *Pick the account…*; **at least one** `active`, none selected ⇒ the
  **unchanged** *Pick the account this repository polls under.*, because there is something to pick;
  zero accounts with the editor already open ⇒ FR-123's row 1, asserted as the **same string value**
  as the toolbar line's; the refusal never echoes anything submitted (FR-085); in all three pre-read
  states *Add binding* is disabled, so **no** pre-read submission reaches `draftAccount` and the third
  row creates no new refusal path. **(FR-123, FR-085, AC-154)**
- [ ] **K-8** **The placeholder** (`src/bindings-body.ts`, `mountAccountSelect`): `Select a verified
  account` becomes the imported `ACCOUNT_PICKER_PLACEHOLDER` — `Select an active account` — **in
  place**, as a mount-time constant that **does not vary by case** and is **not** added to the
  repaint path. The field's `disabled` beside it is **untouched**: FR-123 governs the placeholder's
  **wording, never its presence**, so the picker stays disabled when its option list is empty. *Tests*:
  two accounts neither `active` ⇒ placeholder `Select an active account` **by string equality** (a
  placeholder is a constant, and equality is the stronger assertion a scan could replace), option
  list empty, field disabled; **one** account that **is** `active` ⇒ the **same** placeholder, which
  is what makes the fix a reword and **not** a conditional; **zero** accounts with the editor open ⇒
  the same placeholder and the picker still disabled. **(FR-123, AC-155)**

**Wave K-b boundary**: `npm run verify` green; `npm run build`; rebuilt bundles committed. *The tab
says true in every state of §K.3's truth table.*

---

### Wave K-c — the copy scans, each proved non-vacuous

**Goal**: no string on this tab instructs the operator to press a control that is disabled in the state
rendering it, and the withdrawn placeholder is gone — with each claim proved able to fail.

- [ ] **K-9** **The two copy scans and their three positive fixtures** (`tests/bindings-accounts.test.ts`,
  against **mounted props** via the mount journal `tests/bindings-actors.test.ts` uses — a string can
  sit in the source and never reach the DOM):
  1. **The state-keyed scan over the empty text**, forbidding the withdrawn `select New binding`
     instruction (and `select` / `click` / `press` / `choose` for anything the operator cannot
     currently do), run over **every** read state. **Two positive fixtures**, because the instruction
     appeared in two states before the fix: AC-154's **one-account** fixture — whose empty text
     **does** contain `select New binding`, proving the matcher can find what it forbids — and AC-156's
     **mounted-at-`idle`** fixture, the state the third row governs and the one where the pre-fix code
     rendered it. Also assert the third row's string by equality, that it asserts **no account count**
     (no *no accounts*, *0 accounts*, *none*), and that it names **only Refresh** — which nothing
     gates on the accounts read.
  2. **AC-155's phrase-keyed scan, kept separate and kept a phrase**: forbids the **string**
     `Select a verified account` across the Bindings surfaces, proved non-vacuous by an
     **Accounts-tab** fixture that still renders an account's `verifiedAt` stamp — because the rule
     forbids the **string**, not the word, and a scan banning *verified* panel-wide would forbid
     FR-062's correct, unchanged row. **The two scans must not be merged**: merging would make the
     Accounts-tab fixture prove a claim about the empty text, and widening the second would forbid
     `verifiedAt`. Assert both separations explicitly, in data, with named exemptions so a widening
     fails with the offender's name.
  3. **`tests/bundle.test.ts`**: one case over the committed `panel/main.js` asserting it carries
     `Select an active account` and **not** `Select a verified account` — the shipped artifact, not
     only the source. **Exemptions are asserted to still carry their word**, so an exemption that
     quietly stopped existing cannot leave a scan proving nothing.
  *Gate*: each of the three fixtures makes its scan fail when the string is put back, and passes as
  written. **(AC-154, AC-155, AC-156, FR-122, FR-123, SC-114)**

**Wave K-c boundary**: `npm run verify` green.

---

### Wave K-d — verification, bundles, and the visual check

**Goal**: prove the shipped artifact, not just the tree.

- [ ] **K-10** `tools/visual/shot.js` gains `--scene <name>` (D26): a `scenes` delta in
  `fixtures.json` merged over the base document by `fixtures.js`, where `no-accounts` sets
  `accounts: { accounts: [] }`. A scene run captures **one** tab at **both** widths and writes
  `panel-<tab>-<scene>.png` / `-narrow.png`, **reusing that tab's existing wide/narrow sentinel
  colours** — so no probe colour, index arithmetic, or diff rule changes, and `AGENTS.md`'s
  "every image is decoded and proven current" machinery is untouched (a scene run is its own process,
  so the per-width freshness chain starts empty). *Tests* (`tests/visual-tooling.test.ts`): the flag is
  advertised and rejects an unknown scene name; the delta merges **over** the base document (a scene
  that omits a route leaves it answering); `no-accounts` yields an **empty** account list; a scene run
  writes both widths and `verifyDelivered` accepts them. **(D26)**
- [ ] **K-11** **The visual check.** `npm run shot bindings` on the **default** fixture — which has two
  accounts **and a binding**, so *none* of FR-122's three rows renders and the reason line is
  correctly absent: this proves the correction did **not** leak into the live-control case. Then
  `npm run shot bindings --scene no-accounts --out screenshots/no-accounts` — the frame in which the
  **third row** becomes visible at all (`idle` at mount, before the fixture's answers land), and the
  reason line appears once the empty read succeeds. **Decided: yes, a Bindings capture belongs in
  verification** — this change is operator-visible on the tab the rail shows first, an 80-character
  sentence's wrapping at **560px** is exactly what a screenshot catches, and the defect class this
  block exists to end was found by a screenshot. Assert the reason line and the third-row empty text
  are legible and unwrapped at 720px and 560px, and that `panel-bindings.png` (default) still shows
  the gate **live**. Images land in git-ignored `screenshots/` and are never committed. **(FR-121, FR-122, AC-139, AGENTS.md §Visual verification)**
- [ ] **K-12** **Ship it**: `npm run verify` green (build → lint → typecheck → test); `npm run build`
  regenerating **both** committed bundles — `panel/main.js` (IIFE) **and** `service/main.js` (ESM) —
  and **both committed in the same commit as their sources** (invariant 1). **The service bundle MUST
  be byte-identical**: no `service/*.ts` changes here, so `git diff --stat service/main.js` is empty
  and that emptiness is the proof no service code moved (invariant 1 names both bundles, and a
  changed service bundle means something outside this block's scope did). Re-read the out-of-scope
  guard: no wire, route, store, storage key, capability, permission, SDK re-pin, or version bump; the
  `usable`-versus-`exists` divergence **untouched** (FR-124, the block's one residual). Confirm
  zero suppressions and zero `any` (invariant 7) and that every new string renders through the
  non-HTML path (FR-080). Commit message per `AGENTS.md` (Conventional Commits, `Generated-By`
  trailer via `git-agent-commit`; branch `issue-18-no-bindings-without-account`, **not** `main`).
  **(AC-139, FR-124, invariant 1, invariant 7)**

**Wave K-d boundary**: `npm run verify` green, both bundles committed with their sources, screenshots
in git-ignored `screenshots/`.

### Acceptance criterion → task coverage (this block only)

| Criterion | Tasks |
| --- | --- |
| `005 AC-154` (zero-account gate, its reason, FR-122's table, both refusal cases, the unreadable read, the copy scan) | K-2, K-5, K-6, K-7, K-9 |
| `005 AC-155` (placeholder equality in three states; the phrase-keyed scan) | K-8, K-9 |
| `005 AC-156` (the third row in all three read states; gate and FR-121's line **absent** in each; no account-count claim; the mounted-at-`idle` positive fixture) | K-2, K-3, K-5, K-6, K-9 |
| `005 SC-115` (answer both questions from the Bindings tab alone; no string instructs pressing a disabled control) | K-5, K-9, K-11 |
| AC-139 (bundles rebuilt and committed with sources; `npm run verify` green) | every wave boundary, K-12 |
| FR-122's **consistency rule** (one predicate, three rows, gate and selector cannot disagree) | **K-3** (the assertion), K-2 (the code it pins) |

### Out-of-scope guard for this block (check before any task feels like "just one more")

No service, route, wire member, status or error code, stored document, `host.storage` key, or contract
change (FR-124). No change to `PUT /v1/bindings`' validation, to `hasAccount`, or to the
`usable`-versus-`exists` divergence — **recorded as a decision, not a backlog item** (FR-124,
clarification row 59; the block's **one** residual). No gate on *Add binding*, *Cancel*, *Toggle* or
*Remove*: `newBinding` alone changes. **No gate that fires before the accounts read has succeeded, and
no `usable`-keyed gate** — FR-120's bar is untouched and the third row was chosen *because* the frame
is answered in copy rather than by starting the gate early (clarification row 60). **No fourth
empty-text row**: the three rows partition one predicate, so a state fitting none is a **new
predicate** — a spec amendment, not a task. No navigation control, link, or button to Accounts from
anywhere (FR-010, FR-039); *Refresh* is named in the third row and already on the toolbar. No use of
`rt.state.bindings.note` for the reason, and no restating of the failed read's cause or retry inside
the empty text (FR-019, FR-121's channel rule). No new state member and **no second read** — the
third row is answered from read state the panel already holds. No version bump, capability,
permission, or SDK re-pin. No prompt or allow-list behaviour touched.

### Phase 5 note on the earlier gate flag

This block introduces **no** gate flag. The C-block's empty-list round trip (005 FR-090 vs `005
AC-142`) is untouched by issue #18, and the issue #18 question this section *had* — the pre-read and
unread frame — was **resolved by the owner's ruling of 2026-10-05** (clarification row 60, `005
AC-156`), recorded as resolved-but-reasoning-retained in [plan.md §K.5 item 1](./plan.md).