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
4. **`specs/005-panel-ia/spec.md` → v1.4.0** with an `## Amendment History` entry recording: the override **store** does not exist in the shipped service (evidence above); FR-057's rendering and marking obligations are satisfied by the derived display; and the per-binding operator override is **deferred** to a successor feature that owns the mention-token store, with the lifting condition that the service must both store *and* consume it. Frame it as recording an unimplemented permission inherited from 002 FR-015, **not** a weakening of FR-057 — the requirement's observable guarantee is unchanged.
5. **Editor scoping (the other T-022 clause):** in **edit mode** the bound-account field is fixed to the selected binding's own account (no free select), so a displayed value and a saved value can never disagree; in **add mode** the select lists the accounts available to bind. Assert that mismatch with a test.

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
- [x] **T-028** [P] [US6] Create `src/about-tab.ts`: product name; panel id `mecha-turk`; the **single version** read from `GET /v1/health` — rendered *not yet read* before the first read and **`unknown (service unreachable)` naming the service as the source** when unreachable, with **no number and no panel-side literal**; the data directory and the statement that it is the thing to back up; the vocabulary mapping in short form; the manual-cleanup posture naming **OpenChamber's own session and worktree surfaces** (the extension has no deletion API); the pre-1.0.0 release posture; and a **read-only Diagnostics** section holding the ledger, the evidence schema version, and the observed-phase record — no prompt text, no fingerprint, no account identifier, no path beyond the data directory, no edit affordance. *Tests* (`tests/about-tab.test.ts`): AC-133 version equals `SERVICE_VERSION` and the panel source carries exactly one version-shaped literal; AC-134 unreachable ⇒ the exact *unknown (service unreachable)* copy with no digits; AC-132 static content retained; Diagnostics renders ledger entries read-only; credential scan. **(FR-074, FR-075, FR-076, FR-077, FR-029, AC-132, AC-133, AC-134, SC-109)**

**Wave 9 boundary**: `npm run verify` green + rebuilt bundles committed.

---

## Wave 10 — Proof (cross-cutting acceptance suites) + documentation (US8, P3)

**Goal**: the spec's measurable outcomes as automated, offline tests, plus the two documents 002 FR-042 puts in scope. Nothing here adds behaviour.

- [x] **T-029** [P] [US8] Finish `tests/vocabulary.test.ts` with the **L1 half**: scan rendered output from all six tabs **and** `README.md` for "Run" as a noun for a work unit and "Repositories" as a noun for bindings, and assert the short mapping list appears in About; assert `test` names and descriptions follow FR-028's layer rule (a test of the Dispatches tab is not a test of `runs-ui.ts`) while wire/domain test subjects keep their names. *Tests*: SC-107, AC-140; the L2/L4 halves from T-003 still pass. **(FR-020, FR-021, FR-028, FR-029, AC-140, SC-107)**
- [x] **T-030** [P] [US8] Rendering and accessibility suite: static scan asserting **no HTML sink** (`innerHTML`, `insertAdjacentHTML`, attribute assembly from source text) anywhere the six tabs render operator- or GitHub-supplied strings, plus DOM assertions with hostile `<img onerror>` titles/logins/reasons; accessible-name assertions for every control and every row-level action (FR-081); tab/body association + keyboard operation + visible focus + no trap + tab labels truncating rather than wrapping (FR-082, NFR-107); state conveyed as **text** as well as colour on every banner/label/refusal (FR-083); every irreversible action observed using the two-step arm-confirm idiom and **no `confirm()`** anywhere (FR-084); no refusal echoing a submitted value and no log-through on a redaction refusal (FR-085). **(FR-080, FR-081, FR-082, FR-083, FR-084, FR-085, NFR-101, NFR-107)**
- [x] **T-031** [P] [US8] Lifecycle suite: teardown counts node/timer/disposer back to pre-mount after visiting every tab (AC-137, NFR-108); activating the active tab performs **zero** service reads and opening/switching/refreshing mutates nothing else (FR-014, NFR-104); exactly one relay loop across a mid-flight switch with no second `startSession` (AC-136, SC-108); a failed read retains the last successful content **marked stale** or states plainly that there is none (FR-019, NFR-111); disposal is idempotent and no handle is disposed twice. **(FR-014, FR-017, FR-018, FR-019, AC-136, AC-137, SC-108, NFR-104, NFR-108, NFR-111)**
- [x] **T-032** [P] [US8] Containment, upgrade, and posture suite: secret scans extended over the new surfaces (Status rows, Dispatches rows, Accounts rows, `displayName`, About's Diagnostics) ⇒ **zero credential occurrences, no exemptions** (NFR-102, AC-129); prompt-exactly-once re-asserted here as the cross-tab authority (SC-105); **upgrade loses nothing** — seed a store in the retired `pending | in-flight | dispatched` vocabulary plus bindings, accounts (pre-`displayName`), and a ledger, boot the upgraded panel/service, and assert every row renders through 003's migration table, no quarantine file, no key reset, no bytes rewritten (FR-005, NFR-103); offline guarantee — the whole suite runs with no live host, no real token, no network (FR-086, AC-138); bundle shapes + both bundles contain no secret and ship with their sources (FR-087, AC-139); **no capability added** and manifest identity byte-unchanged (FR-004, FR-079); **no GitHub write** import anywhere (FR-002); **no project/worktree/session/agent mutation** call (FR-089); audit vocabulary untouched — no new/removed/renamed event type (FR-027); **no `host.storage` key added or renamed** and the active tab absent from storage (FR-025); **L3 paths unchanged** — the route table answers `/v1/events*` and the status document still carries `repositories` (FR-023, FR-026). **(FR-002, FR-004, FR-005, FR-023, FR-025, FR-026, FR-027, FR-079, FR-086, FR-087, AC-138, AC-139, NFR-102, NFR-103)**
- [x] **T-033** [US8] Documentation sync (002 FR-042, 005 FR-020/FR-029): update `README.md` and `specs/002-agent-event-extension/quickstart.md` to the shipped surface — the six tabs and their vocabulary, the prerequisites section on Status (superseding the walkthrough's "there is no in-panel setup checklist in this MVP" sentence), the Dispatches list with paging/filter/affordances, the Settings tab as the configuration surface including the agent-verification baseline the card no longer carries, and the Accounts add form as the expected-login supply surface; reproduce the vocabulary mapping table in `README.md` in full and in About in short form; final-pass `AGENTS.md`'s module map for every renamed/added module. Assert neither document instructs `.env`/`MECHA_TURK_*` configuration, presents an unlabelled `specs/001-agent-event-orchestrator/` path, or names a retired tab. **(FR-020, FR-029, 002 FR-042, AC-140)**
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
