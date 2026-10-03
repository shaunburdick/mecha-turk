# Implementation Plan: Panel IA — Six Tabs

**Branch**: `full-project-plan` (spec + plan artifacts; implementation moves to `005-panel-ia` per `AGENTS.md` git conventions) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md) (v1.3.0, APPROVED — normative body byte-identical to v1.0.0 except FR-006/AC-141, added at v1.2.0)

**Input**: Feature specification `specs/005-panel-ia/spec.md` (v1.3.0); predecessors `specs/002-agent-event-extension/spec.md` (v1.7.0) + `specs/003-dispatch-integrity/{spec,plan,tasks,contracts}` (v1.3.0) + `specs/004-starting-prompt/{spec,plan,contracts}` (v1.1.0); successor `specs/006-settings-crud/spec.md` (v1.3.0); constitution `.specify/memory/constitution.md` (v1.3.0); repo directives `AGENTS.md`; scope source `specs/003-dispatch-integrity/pm-handoff.md` §Feature Roadmap / §Product-owner decisions; and the shipped code itself (read for this plan: `src/{app,panel-ui,panel-state,repos-mount,repos-ui,bindings-mode,accounts-ui,runs,runs-rows,runs-service,service-calls,lifecycle,config,relay}.ts`, `panel/index.html`, `service/routes/{status,events,health,accounts,config}.ts`, `service/{config,accounts/model}.ts`, `service/poll/{timer,loop}.ts`).

**Note**: No application code is written in Phases 4–5. Every design decision below is decided and justified; the genuinely open questions this feature raises are in [research.md](./research.md).

## Summary

005 replaces the panel's spike-era information architecture with **six tabs — Status, Dispatches, Bindings, Accounts, Settings, About** — and makes three surfaces tell the truth for the first time: the status projection stops reporting literals a running process contradicts, the dispatch list pages and filters past the 100-row wall, and the account/binding/settings surfaces gain real tab homes without a single credential, storage key, or wire path changing.

Technical approach in one line each:

- **Rename first, honestly** (`src/`, `tests/`, `AGENTS.md`): the L2 four-layer rename lands as **two atomic, mechanical waves** — `repos*` → `bindings*`, then `runs*` → `dispatches*` — each a `git mv` plus identifier sweep plus rebuilt bundles, green on its own, **before** any restructure touches those files. L1 copy is deliberately *not* changed in those waves; it changes with the surface that renders it (FR-020, FR-028).
- **Service read-surface honesty** (`service/routes/status.ts`, `service/routes/events.ts`, `service/accounts/`): `polling` computed from the live scheduler, `repositories` projected from the same `readStatusRows` the Bindings tab reads, `agentPin.lastVerification` widened or explicitly *not available*; `GET /v1/events` gains cursor pagination (25 default, 10/25/50/100) and server-side `bindingId`/`state` filters over the retained newest-first order; the credential-free account DTO gains `displayName` with its own write path.
- **The shell** (`src/tabs.ts` + `panel-state.ts` + `app.ts`): one `TabId` on the runtime drives the SDK's `mountTabs`; bodies mount on **first activation** and stay mounted; one dispose path; the spike body, `repaintReposSection`, the manual *Start session* control, and the *Record phase* writer are **deleted**, not hidden.
- **Six bodies**: Status (honest projection + prerequisites + notices), Dispatches (paged list + one state→affordance table over 003's model), Bindings (whole-file CRUD + 004's prompt rendered exactly once + 003's picker guidance), Accounts (credential-free rows + relocated handoff + `displayName` + expected-login input), Settings (read-only rows over `GET /v1/config`), About (single version source + read-only Diagnostics + vocabulary list).
- **Legacy settings retirement** (002 FR-041 / 002 AC-021): the manifest card's `settings` array is emptied and the panel stops reading the six card ids from `ctx.settings`; `expectedAgent` comes from `GET /v1/config` with 002 FR-029's two-case fail-closed split.
- **Nothing else moves**: no new host capability, no storage key, no wire route rename, no audit vocabulary change, no version bump.

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` (`AGENTS.md` invariant 7) |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` and **committed** (invariant 1) |
| Panel UI primitives | `@openchamber/sdk/ui` — `mountTabs` (selection + `role="tablist"`/`role="tab"` + `aria-selected` + roving tabindex + arrow keys), `mountBanner/Button/Select/List/Text`; SDK pinned `1.24.2` exact (invariant 6), **no re-pin** |
| Service runtime | Node ESM, host-spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE`; `service/main.js` built with `bunx openchamber-guest-bundle --node` and **committed** (invariant 1) |
| Service dependencies | Node stdlib only — no framework, no native modules (005 adds no dependency) |
| Storage (service tier) | JSON + append-only NDJSON under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename). **005 adds no file and changes no document shape** except `accounts.json` gaining an optional `displayName` member |
| Storage (panel tier) | `host.storage` (64 KiB/value, 2 MiB namespace, uninstall-wiped). **005 adds no key and renames no key** (FR-025): `mecha-turk:project`, `:evidence`, `:ledger`, `:dispatches` all keep their names |
| Testing | vitest `5.0.2`, fully offline: fake host (`tests/support/panel.ts`), DOM helpers (`tests/support/{dom,ui-stubs}.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`). No live OpenChamber, no PAT, no network (FR-086, `AGENTS.md` testing philosophy) |
| Target platform | OpenChamber desktop and web only (unchanged) |
| Scale | <10 bound repositories, a handful of accounts, one logical service instance, one operator machine |
| Version | `0.0.1` — **no bump** (invariant 2, FR-087); `SERVICE_VERSION` stays pinned to `package.json` by `tests/service-server.test.ts` (invariant 5) |

### Baseline: which tree this plan is written against

005's spec lists 002 (v1.7.0), 003 (v1.3.0), and 004 (v1.1.0) as **Dependencies** (`spec.md` header), and the roadmap sequences Phase 6 as 003 → 004 → 005 → 006. **This plan is therefore written against the tree as it will be after 003's and 004's Phase 6 complete**, and its "already built" section names both halves:

| Source | What it contributes that 005 consumes and must not rebuild |
| --- | --- |
| 002 (shipped, live-validated) | loopback transport/auth/body caps, account custody + verify/rotate/delete, consent + throttles, bindings store, polling/triggers/scan-state, store mechanics, audit writer, config document, `GET /v1/health`, `GET /v1/status` skeleton, panel ledger/evidence/redaction/session/relay substrate |
| 003 (its plan/tasks complete, Phase 6 a prerequisite) | run model + `runs.json`, eight-state vocabulary, lease/claim/reserve/result, retry/resolve/requeue semantics, 16-row dispatch-lifecycle audit vocabulary, `GET /v1/audit`, run-history projection (`RunHistoryRow`), `src/relay.ts` reconcile→claim→reserve→report, `src/dispatch-record.ts`, `src/reconcile.ts`, `src/prerequisites.ts`, `src/audit-view.ts`, `src/project-picker.ts` "not listed?" guidance, state labels/reasons in `src/runs-rows.ts`, `leaseMs`/`resultDeadlineMs` config fields |
| 004 (its plan/tasks complete, Phase 6 a prerequisite) | `BindingRecord.startingPrompt`, `service/prompt.ts` validator + fingerprint, enqueue-time snapshot, omission-preserves at the PUT route, fingerprint-on-audit scalars, `binding.prompt-updated` |
| 006 (spec v1.3.0 approved; **plan not yet written**) | nothing at 005's Phase 6 — 006 lands *on* 005's Settings shell afterwards. Its interface assumptions are recorded explicitly below |

If 003 or 004 has not completed Phase 6 when 005 starts, the tasks that consume their surfaces **block** rather than re-implement them: **T-016** (state vocabulary + the affordance table), **T-018** (003's retry/resolve/requeue operations), **T-021** (004's prompt field), **T-022** (003's picker guidance), **T-027** (`leaseMs`/`resultDeadlineMs` row presence). Nothing in 005 rebuilds a predecessor's mechanism.

## Constitution Check (v1.3.0) — alignment statement

> **005 aligns with every principle and every security/quality gate of constitution v1.3.0. There are no constitutional violations, therefore no complexity-tracking rows and no exceptions to record.** The feature exists to make constitution **IV (human-visible auditability)** true of the panel an operator actually reads and **VI (specification and verification)** true of a surface whose copy previously contradicted its machine; **II (safe autonomy)** supplies the fail-closed rendering posture, **VII (thin orchestration boundary)** is *tightened* by 005 (the manual *Start session* control is removed, not added). Re-read after design (below) — alignment unchanged.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Discovery and the panel↔service boundary are unchanged in shape; the two reads that do change (`GET /v1/status`, `GET /v1/events`) are recorded in [contracts/](./contracts/) and versioned additively within v1 (FR-023: no path renamed) |
| **II. Safe autonomy by default** | FR-003 is the plan's spine: unknown is rendered *unknown*, unmeasured is *not measured yet*, not checkable is *not checkable*, not available is *not available*; every refusal names cause + remediation and never echoes the submitted value (FR-085); filters and unknown states refuse rather than guess |
| **III. Durable and idempotent work** | Nothing durable is rewritten: FR-005 forbids quarantine/reset, 003's non-destructive migration table stays the only projection of pre-003 queue rows, `runs.json`/`events.json`/`audit.ndjson`/`bindings.json` are read-only to 005 except `accounts.json`'s additive `displayName` |
| **IV. Human-visible auditability** | The Dispatches tab is this principle's surface: every 003 state readable with its reason, every correlation id copyable (FR-049), every refusal rendered from the service's verdict (FR-046), the audit vocabulary unchanged and explained by the About tab's short mapping (FR-029, FR-075) |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, or control plane; no new store file; one added HTTP operation (`PUT /v1/accounts/:id/display-name`) on the existing loopback transport |
| **VI. Specification and verification before implementation** | This plan + [research.md](./research.md) + [data-model.md](./data-model.md) + [contracts/](./contracts/) land before code; SC-101…SC-112 are named test tasks, not aspirations; the rename is guarded by an automated vocabulary suite rather than by review goodwill |
| **VII. Thin orchestration boundary** | FR-004/FR-079: `capabilities[]` stays `["sessions","prompt"]`, `contributes.service` gains no `permissions` key, no host API is added; FR-089 keeps project/worktree/session/agent mutation in OpenChamber's own surfaces; **removing the manual dispatch control makes the boundary stricter than today** |
| **Security Std (secrets)** | The Accounts tab renders a DTO incapable of carrying a credential (FR-067, with a type-level test); `displayName` is refused on a credential shape like every operator string (FR-066); the secret-scan suites **gain cases** for the new tabs, never exemptions (NFR-102) |
| **Security Std (unattended dependency)** | Unchanged: dispatch still requires the panel mounted (003's model); Status says so rather than implying autonomy (005 Clarification row 14); the unsupported-surface notice suppresses every "it is running" claim (FR-036) |
| **Security Std (durable state)** | Durable state stays in the service store; `host.storage` keys are untouched and **no key is added** (FR-025) — the active tab is deliberately *not* persisted, so a wiped `host.storage` loses nothing durable (002 FR-034) |
| **Quality gates** | Strict TS + lint, zero suppressions, zero `any` (FR-088); offline suites per task (FR-086); `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (FR-087, invariant 1) |

**AGENTS.md non-negotiable invariants honoured by this plan** — (1) **committed bundles ship**: every wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` in the *same commit* as their sources; (2) **one document, two roles**: no `version` bump in 005 (`0.0.1` stands; a bump is a product-owner release decision) and `SERVICE_VERSION` stays byte-pinned by `tests/service-server.test.ts`; (3) **capabilities stay `sessions` + `prompt`** and `contributes.service` gains no `permissions` key — asserted by the existing `tests/manifest.test.ts`, extended to assert the emptied `settings` array; (4) **kebab-case identity + `mecha-turk:` storage keys unchanged** — the panel id, the manifest ids, and every storage key are byte-identical after 005 (FR-025, FR-079), renaming either would be a user-visible namespace reset and is treated as a breaking change; (5) `SERVICE_VERSION` mirrors `package.json` (untouched); (6) SDK pinned `1.24.2` exactly, **no re-pin**; (7) **zero suppressions, zero `any`**; (8) **fail-closed parsing** — the new panel readers (paged dispatch answer, status document, `AccountDto`, `GET /v1/config` document, Settings row declaration) refuse malformed input rather than partially applying it, and an unknown dispatch state renders *unknown state* with the raw value (FR-041); (9) **secrets never leave the service store** — no credential member exists on any DTO 005 renders; (10) **`extension-spike-1` is a wire contract** — 005 reads the evidence schema version and the ledger in About's read-only Diagnostics and changes neither shape nor version (FR-075).

## Requirement → module mapping (what satisfies what)

| Spec group | Satisfied by (service) | Satisfied by (panel) |
| --- | --- | --- |
| **A. FR-001–FR-006** (authority, GitHub-read-only, fail closed, no capability, no loss, expected-login supply) | constraints checked by existing + new tests; no route writes to GitHub | out-of-scope guard + static no-GitHub-write scan (FR-002); refusal copy discipline (FR-003); `tests/manifest.test.ts` extended (FR-004); upgrade/no-loss suite (FR-005); Accounts add form's optional `expectedLogin` input (FR-006) |
| **B. FR-010–FR-019** (the shell) | none — shell is panel-only | `src/tabs.ts` (FR-010, FR-012, FR-013, FR-014, FR-016), `src/app.ts` mount/teardown (FR-015, FR-017), root-owned relay arm (FR-018), read-state registry (FR-019); spike retirement (FR-011) |
| **C. FR-020–FR-029** (vocabulary) | L3 retention asserted by contract tests (FR-023, FR-026); audit vocabulary untouched (FR-027) | Wave 1/2 rename (FR-024), `tests/vocabulary.test.ts` (FR-020, FR-021, FR-022, FR-028), About short mapping + `README.md` (FR-029), storage-key assertion (FR-025) |
| **D. FR-030–FR-039** (Status) | `service/routes/status.ts`: polling computed (FR-031), `repositories` rows (FR-032), `agentPin` widened (FR-033) | `src/status-tab.ts` (FR-030, FR-034, FR-035, FR-039), `src/prerequisites.ts` placement (FR-037), unsupported-surface notice (FR-036), picker-guidance link (FR-038) |
| **E. FR-040–FR-049** (Dispatches) | `service/routes/events.ts`: cursor pagination (FR-042), server-side filters (FR-043) | `src/dispatches-service.ts` client (FR-042, FR-043), `src/dispatches-rows.ts` state→affordance table (FR-041, FR-044, FR-045, FR-047, FR-048), `src/dispatches.ts` actions + one read/one dispatch path (FR-046, FR-049), sole-list assertion (FR-040) |
| **F. FR-050–FR-059** (Bindings) | none — the whole-file grant already exists (FR-050) | `src/bindings.ts` + `src/bindings-ui.ts` CRUD (FR-050, FR-053, FR-054, FR-058, FR-059), prompt field (FR-051, FR-052), picker guidance placement (FR-038, FR-056), mention-token override (FR-057), cascade arm-confirm (FR-055) |
| **G. FR-060–FR-069** (Accounts) | `service/accounts/` + `service/routes/accounts.ts`: `displayName` field + write route (FR-066), DTO type guard (FR-067) | `src/accounts-ui.ts` rows (FR-062, FR-063, FR-068), relocated handoff (FR-060, FR-061), rotation copy (FR-064), two-step cascade (FR-065), display-name edit (FR-066), no-token surface (FR-069) |
| **H. FR-070–FR-079** (Settings / About) | `GET /v1/health` unchanged and re-tested as the version source (FR-074) | `src/settings-tab.ts` read-only rows (FR-070–FR-073, FR-078), `src/about-tab.ts` (FR-074–FR-077), identity assertions (FR-079) |
| **I. FR-080–FR-089** (rendering, a11y, lifecycle) | none | static non-HTML scan + hostile-string renders (FR-080), accessible-name suite (FR-081), association/keyboard suite (FR-082), text-not-colour suite (FR-083), two-step idiom reused everywhere (FR-084), refusal copy tests (FR-085), offline guarantee (FR-086), bundle gate (FR-087), zero-suppression gate (FR-088), no-mutation scan (FR-089) |

## Already built vs. changed vs. new

### Already built — do NOT re-touch (002 shipped and live-validated; 003/004 land before this Phase 6)

- **Service transport/security**: `service/{server,http,auth,pipeline,consent,throttle,body,log}.ts` — loopback bind, bearer auth with `timingSafeEqual`, body/response caps, route-table mechanics, consent gate, throttles.
- **Credential custody + accounts**: `service/accounts/` (0700/0600 credential files, startup reconcile, `disableBindingsForAccount` hard guard), `service/routes/{accounts,verify,credential}.ts`, `service/github.ts`'s verify path. 005 **adds** `displayName` and its write route; it does not re-cut custody.
- **Bindings**: `service/bindings.ts`, `service/routes/bindings.ts` — whole-file validated grant, capped at 100; `BindingRecord` untouched (FR-026), `startingPrompt` arrives from 004.
- **Polling/discovery**: `service/poll/{poller-github,poller-entries,triggers,loop,timer,scan}.ts`, `service/pipeline.ts` — trigger detection, windows, rate budget, checkpoints-as-scan-state. **The status projection reads `poll/timer.ts` + `poll/loop.ts`; it does not modify them** (FR-031).
- **Store/audit mechanics**: `service/store/*`, `service/audit.ts` (seq chain + redaction pass — 005 writes no audit row of its own, FR-027).
- **Config/health**: `service/config.ts` (bounds + validator), `service/routes/{config,health}.ts`. `GET /v1/health` is **unchanged** and becomes the About tab's version source (FR-074); `SERVICE_VERSION` stays pinned.
- **003's dispatch machinery**: run model, leases, tokens, retry/resolve/requeue/refusal matrix, audit vocabulary, `GET /v1/audit`, `RunHistoryRow`, `src/relay.ts`'s reconcile-first tick, `src/dispatch-record.ts`, `src/reconcile.ts`, `src/prerequisites.ts`, `src/audit-view.ts`, `src/project-picker.ts`'s "not listed?" guidance, `src/runs-rows.ts`'s state labels. **005 renders these; it MUST NOT re-implement them** (FR-044).
- **004's prompt capability**: `service/prompt.ts`, `BindingRecord.startingPrompt`, snapshot-at-detection, omission-preserves, fingerprint scalars. **005 renders the field; it does not compose, validate, or store the prompt itself** (FR-051, FR-052).
- **Panel substrate**: `src/{session,redaction,ledger,evidence,ids,json,storage-write,handoff,consent,agent-verify,service-calls,project-actions}.ts`, `tests/support/*`, `tests/bundle.test.ts`, `tests/manifest.test.ts`, the committed bundle build pipeline.
- **Invariants**: delivery id format, evidence schema `extension-spike-1`, manifest ids/capabilities/panel id, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` `0.0.1`, `SERVICE_SCHEMA_VERSION = 1`, the existing 563-test suite (stays green throughout).

### Changed (existing behaviour/shape moves)

| # | Change | Where | Specs |
| --- | --- | --- | --- |
| C1 | `GET /v1/status`'s `polling` block: literals → computed (`paused`, `nextPollAt`, `pausedReason` from a closed vocabulary with verbatim passthrough) | `service/routes/status.ts` (+ a read-only view over `service/poll/timer.ts`/`loop.ts`) | 005 FR-031; supersedes 003's `## Wire Surface Delta` `Status` row |
| C2 | `GET /v1/status`'s `repositories: []` → one row per stored binding projected from `readStatusRows` (last scan, last error/skip, pending count, active), unreadable bindings marked not omitted; member name stays `repositories` | `service/routes/status.ts` | 005 FR-032, FR-026 |
| C3 | `GET /v1/status`'s `agentPin.lastVerification: null` → most recent verification outcome + stamp, or an explicit *not available* marker; `null` only when nothing has been verified | `service/routes/status.ts` | 005 FR-033 |
| C4 | `GET /v1/events`: `MAX_LISTED_EVENTS = 100` cap with no parameters → cursor pagination (default 25, selectable 10/25/50/100) + server-side `bindingId`/`state` filters over the same newest-first order; the 100 cap becomes the **max page size**; `recentRuns()` stays the unpaged primitive | `service/routes/events.ts` | 005 FR-042, FR-043 |
| C5 | `Account` + `AccountDto` gain `displayName: string \| null` (default `null`), plus `PUT /v1/accounts/:numericUserId/display-name` | `service/accounts/model.ts`, `service/routes/accounts.ts` | 005 FR-066 |
| C6 | Panel runtime: `Repositories { activeTab, … }` dissolved; `activeTab` lifted to the runtime as the shell's single `TabId`; `PanelState.repos` → `.bindings`; `RunsState` → `DispatchesState` with filters + cursor stack; `rt.pendingPhase` removed | `src/panel-state.ts` | 005 FR-012, FR-024, FR-042 |
| C7 | `repaintReposSection()` and the `section.spike.hidden` / `section.repos.pane.hidden` switch **deleted**; one `mountTabs` strip drives six bodies | `src/panel-ui.ts`, `src/app.ts`, new `src/tabs.ts` | 005 FR-011, FR-010 |
| C8 | Manual *Start session* control removed (003 FR-035 conformance); *Observed phase*/*Record phase* writer removed; *Verify host state* and the *Poll now* button retired with the spike body — *Poll now*'s refresh role moves to the Status tab | `src/panel-ui.ts`, `src/panel-dispatch.ts`, `src/panel-actions.ts`, `src/app.ts` | 005 FR-018, FR-044, FR-011, Clarification row 8 |
| C9 | Legacy single-repo settings path retired: manifest `settings` array emptied; `parseSpikeConfig` / `resolveProjectId` / `parseExpectedAgent` and every reader of the six card ids from `ctx.settings` deleted; `expectedAgent` re-sourced from `GET /v1/config` with 002 FR-029's two-case split; project id sourced from `mecha-turk:project` alone | `package.json`, `src/{app,config,bindings-mode,agent-verify}.ts` | 002 FR-041, 002 AC-021, 002 FR-029 |
| C10 | L2 module rename: `src/repos*.ts` → `src/bindings*.ts`, `src/runs*.ts` → `src/dispatches*.ts`, with every importer, every `Repos*`/`Runs*` surface identifier, three test file names, the bundle `data-mount` marker, and `AGENTS.md`'s module map | `src/`, `tests/`, `AGENTS.md` | 005 FR-024, FR-028 |
| C11 | `src/runs-rows.ts`'s `canRetry = row.state !== 'dispatched'` replaced by a state→affordance **table** covering 003's model (Retry only from `failed` + cleared `blocked:*`; Resolve on `unconfirmed`; Return-to-waiting on `dead-lettered`; absent-with-reason elsewhere) | `src/dispatches-rows.ts` | 005 FR-044; 003 FR-041/FR-042 made visible |
| C12 | L1 copy: every operator-facing string moves to **Dispatches**/**Bindings**, including `README.md` and the maintained walkthrough | panel modules, `README.md`, `specs/002-agent-event-extension/quickstart.md` | 005 FR-020, FR-029; 002 FR-042 |

### New

| # | New thing | Where | Specs |
| --- | --- | --- | --- |
| N1 | The six-tab shell: items, single `activeTab`, first-activation mount registry, `lastRead` stamps, read-state registry, tab/body ARIA association re-stamped after every `tabs.update`, one dispose path | `src/tabs.ts` | 005 FR-010–FR-019, FR-082 |
| N2 | Status tab: health/uptime/data dir/schema/storage, per-account rows with rate honesty, per-binding scan rows rendered under heading **Bindings**, polling cadence with overdue stamp, agent-pin honesty, blocking storage notice, unsupported-surface notice, prerequisites section + unmet notice, Status→picker-guidance link, effective-vs-configured interval | `src/status-tab.ts` | 005 FR-030–FR-039, AC-101–AC-111 |
| N3 | Dispatches tab: paged/filtered list client (cursor stack, page index, page size, filters, total-or-unavailable), range line + Previous/Next, empty-filtered state, row detail with source-reference reveal, correlation-id copy | `src/dispatches-service.ts`, `src/dispatches-ui.ts` | 005 FR-041–FR-049, AC-113–AC-122 |
| N4 | Accounts tab: credential-free row rendering (login, id, lifecycle, connection, last verified, scope matrix, error reason, binding count, display name), relocated one-shot handoff, `expectedLogin` input, two-step cascade with count, display-name edit affordance | `src/accounts-ui.ts`, `src/accounts-rows.ts` | 005 FR-006, FR-060–FR-069, AC-126–AC-130, AC-141 |
| N5 | Settings tab (read-only): one row per field `GET /v1/config` carries, each with value, unit/bounds, and an honest take-effect statement; a single panel-side row declaration pinned to `service/config.ts` by a cross-check test; read-without-service states | `src/settings-tab.ts`, `src/settings-rows.ts` | 005 FR-070–FR-073, FR-078, FR-039 |
| N6 | About tab: version from `GET /v1/health`, data directory + backup statement, short vocabulary mapping, manual-cleanup posture, pre-1.0.0 note, read-only Diagnostics (ledger, evidence schema version, observed-phase record) | `src/about-tab.ts` | 005 FR-074–FR-077, FR-029 |
| N7 | Vocabulary suite: L1 scan over rendered output + `README.md`, L2 scan over `src/**` against an explicit retained-allow-list, L4 retention assertions | `tests/vocabulary.test.ts` | 005 FR-020–FR-024, FR-028, SC-107, AC-140 |
| N8 | Contract files for the four wire deltas | `specs/005-panel-ia/contracts/` | 005 `## Wire Surface Delta` |

## Architecture (decided)

### The shell (FR-010–FR-019)

```
panel root (#root)
├── top notice region          ← unmet prerequisites / unsupported surface / storage-blocked (FR-036, FR-037)
├── mountTabs(items × 6)       ← SDK primitive: selection, roving tabindex, arrow keys (FR-011, FR-016)
└── body region                ← exactly one visible; every mounted body stays mounted (FR-012, FR-013)
    ├── Status      (mounted on first activation)
    ├── Dispatches  (…)        ← reports the relay; does not own it (FR-018)
    ├── Bindings    (…)
    ├── Accounts    (…)
    ├── Settings    (…)
    └── About       (…)
```

- **Ownership of the relay loop (FR-018, stated explicitly)**: **the panel root owns the claim → dispatch → report loop on the Dispatches tab's behalf.** It is armed from root-level mount work exactly as it is today (`loadInitialBindings` → `startRelayPolling`) and is never created, destroyed, or duplicated by a tab switch. Rationale: this makes "exactly one loop, unaffected by switching" true *by construction* instead of by lazy-mount bookkeeping — the failure mode FR-018 calls "the single highest-risk regression" simply has no code path that could express it. The alternative (Dispatches-tab ownership with root acting as its agent) is equally conforming per the spec's Assumptions; root ownership is chosen because 003's arming site is already root-level and moving it would *introduce* the very mount/unmount coupling FR-018 exists to prevent.
- **Mount-once, dispose-once**: `src/tabs.ts` holds `mounted: Set<TabId>`; activating an unmounted tab calls that tab's mounter once and records it; activating the active tab is a no-op performing **no service read** (FR-014, NFR-104); `lastRead: Map<TabId, string | null>` is written only by an explicit refresh or a landed read. Teardown walks the registry and disposes in a fixed order independent of which tab was active (FR-017, NFR-108).
- **ARIA association (FR-016, FR-082) — a decided detail**: the SDK's `mountTabs` emits `role="tablist"`, `role="tab"`, `aria-selected`, roving `tabIndex`, and arrow-key navigation, but emits **no** `id`, `aria-controls`, or `tabpanel` association, and its `update()` repaints by `clearNode(track)`. The shell therefore owns the association: an `associateTabs()` helper stamps each tab button with `id="oc-tab-<id>"` (located through the SDK's own `role="tab"` + `data-id` attributes) and each body with `role="tabpanel"` + `aria-labelledby`, and is invoked **after mount and after every `tabs.update()`**. A test asserts the association survives two `update()` calls, so a repaint can never silently break it.
- **The panel root keeps two things that are not tabs**: the top notice region (FR-036/FR-037 require it *outside* their sections) and the banner/read-state framing. Everything else lives in exactly one tab (FR-010: no capability reachable two ways).

### The status projection (FR-031–FR-034)

```
service/poll/timer.ts ─┐
service/poll/loop.ts  ─┼─▶ read-only PollingView ─▶ GET /v1/status.polling
config.json (interval) ┘      { running, nextPollAt, paused, pausedReason }

readStatusRows(store, bindings) ─▶ GET /v1/status.repositories[]   (name retained, FR-026)
account verify/run history      ─▶ GET /v1/status.agentPin.lastVerification | explicit-not-available
rate baseline                   ─▶ { remaining: null, limit: null, resetAt: null, usedLastHour: n }
```

- `paused` is `true` **only** when the loop is genuinely not running; `nextPollAt` is the scheduled stamp while it runs and `null` while it does not; `pausedReason` is empty while it runs and otherwise one of the closed vocabulary `config-incomplete | no-active-bindings | store-unavailable | stopping`, with anything else passed through **verbatim** (FR-031, FR-003).
- The view reads the scheduler's *state*, not a copy of it: the plan adds a small read-only accessor beside `startPollLoop`'s handle (running flag + next scheduled stamp) rather than duplicating scheduling logic inside a route — so a change to the timer cannot leave the status document behind. **The timer and loop are not modified** (FR-031's "computed from", not "reimplemented in").
- `agentPin.lastVerification` widens to `{ observedAgent, expectedAgent, ok, at } | null`, or the explicit *not available* marker when the service holds no mirror (003 records the mirror as backlog) — never a reassuring `null` (FR-033).

### The dispatch list (FR-042, FR-043)

```
GET /v1/events?limit=25&cursor=<opaque>&bindingId=<id>&state=<state>
  → 200 { events: RunHistoryRow[],
          page: { limit, nextCursor, hasMore, total: number|null,
                  snapshotAt, filter: { bindingId: string|null, state: string|null } } }
```

- **Order** stays newest-detected-first with a deterministic tiebreak (`detectedAt` desc, then `id` desc), so the cursor is stable across reads.
- **Cursor** is an opaque page-boundary token encoding the snapshot's last row key; the panel never parses it. `total` is `null` when the service cannot honestly supply one — the tab then says *total unavailable* rather than presenting the page size as a total (FR-042, NFR-112).
- **Filters** are server-side and compose with the page: `bindingId` exact; `state` accepts one of 003's exact state tokens **or** the literal `blocked` matching the whole `blocked:*` family. An unknown token is `422 validation` with `field` + `remediation` — never silently ignored (FR-003).
- **Previous** is served from a panel-side `cursorStack: (string | null)[]` + `pageIndex`, so position survives a refresh within the mount (FR-042; edge case "a refresh returns the operator to the page they were on").

### The single state→affordance table (FR-044, FR-045)

One table, one row per 003 state, is the **only** source of `{ label, tone, reason, affordance }`:

| State | Affordance | Reason line |
| --- | --- | --- |
| `pending` | *none* | `already waiting for a panel` |
| `claimed` | *none* | lease held by the panel |
| `starting` | *none* | dispatch in flight |
| `dispatched` | *none* | session recorded (or problem recorded) |
| `failed` | **Retry** | `stateReason` |
| `unconfirmed` | **Resolve** (two explicit resolutions; names project, worktree option, attachment id) | `stateReason` |
| `blocked:*`, cause cleared | **Retry** (enabled) | `stateReason` + cause |
| `blocked:*`, cause outstanding | **Retry** *disabled* | names the unresolved project/cause; consumes no requeue budget |
| `dead-lettered` | **Return to waiting** (states the attempt reset *first*) | `stateReason` |
| unrecognised | *none* | `unknown state: <raw value>` (FR-003) |

The table is asserted **from one fixture per state**, so a state added to 003 fails the suite until it is given a label and an affordance (SC-104). This is 003 FR-041/FR-042 made visible — the panel calls 003's existing operations and renders the service's verdict (FR-046); it never predicts one.

### The prompt renders exactly once (FR-051)

One field, in the Bindings tab's binding editor, fed from `GET /v1/bindings`'s `startingPrompt` (004 FR-012) — never from an audit fingerprint. The row summary shows **presence and length only**. The editor sends the field **explicitly when the operator cleared it** and **omits it when untouched** (004 FR-014's omission-preserves rule; the spec's edge case makes this a MUST). SC-105/AC-123 count rendered elements carrying prompt text across **all six tabs** and fail at 0 *and* at 2.

**Cross-feature note (004)**: 004's own task T-014 asserts `no startingPrompt key anywhere in panel/main.js` — true for 004's window, because 004 ships no UI. **005 is the feature that breaks that assertion by design**, and 005's proof wave replaces it with the exactly-once assertion (SC-105). Recorded as an interface assumption so the 004 task is not "fixed" backwards.

## Four-layer rename: migration and rollout (FR-020–FR-029)

The rename is the widest *mechanical* change in the cycle (~27 of 39 test files and 28 of 40 `src/` files mention `runs`/`repos` today). It is sequenced so that **each step is a complete, green, buildable commit** and so that the mechanical risk is taken on a *stable* tree, before 005's own restructure adds churn to the same files.

### Layer disposition (the mapping table is normative — this is how it is executed)

| Layer | What moves | When | What deliberately does **not** move |
| --- | --- | --- | --- |
| **L1** copy | Every human-readable string: tab labels, headings, buttons, empty states, notes, banners, accessible names, error messages, `README.md` | **Wave 5 onward** (with the surface that renders it: T-012, T-016, T-017, T-023, T-024, T-027, T-028) and **Wave 10** (scan + docs: T-029, T-033) | Nothing — "Run"/"Repositories" as nouns for a work unit / for bindings are gone by Wave 10 (SC-107, AC-140) |
| **L2** source | `src/repos*.ts → src/bindings*.ts`, `src/runs*.ts → src/dispatches*.ts`; `ReposSection → BindingsSection`, `ReposPane → BindingsPane`, `RepositoriesStatus → BindingsStatus`, `PanelState.repos → .bindings`, `mountRepositoriesPane/repaintReposSection/mountReposSection/createRepositoriesHandlers → …Bindings…`, `RunsState/RunsStatus/initialRuns/RUNS_* → Dispatches…`, the three test file names, the `data-mount` marker, `AGENTS.md`'s module map | **Waves 1–2**, before anything else touches those files | `Repositories.activeTab` (deleted in Wave 4, not renamed); `RunRow` / `runKey` / `runOrdinal` / `attempt` / `retryRun` / `selectedRun`… — identifiers naming the **L4 domain object** are retained per FR-022 |
| **L3** wire | *Nothing.* `/v1/events*`, the `repositories` status member, `/v1/bindings`, `AccountDto`, `/v1/health`, `/v1/status`, `/v1/config` paths and member names | **Not in 005** — confirmed deferred by the product owner 2026-09-28 (Gate Question 1) | `/v1/events*` → `/v1/dispatches*` and `repositories` → `bindings` are a *settled deferral*, not backlog |
| **L4** domain/audit | *Nothing.* `run`, `run key`, `run ordinal`, `attempt`, the `run.` and `binding.` audit prefixes, `runs.json` | **Not in 005** (FR-022, FR-027) | The `run.` audit entity and 003's 16 lifecycle rows are byte-identical after 005 |

### Keeping the tree green

1. **Each sub-rename is one atomic commit**: `git mv` the files → update every importer → sweep the identifiers → update the affected test file names → update `AGENTS.md`'s module map → `npm run build` → `npm run verify` → commit sources **and both rebuilt bundles together** (invariant 1). A half-renamed tree never exists in a commit.
2. **Two sub-renames, not one**: `repos* → bindings*` (Wave 1) and `runs* → dispatches*` (Wave 2) both touch `panel-state.ts`, `panel-ui.ts`, and `app.ts`, so they are **ordered within their waves**, not parallel — but each is independently green, so a stop between them leaves a working tree.
3. **Copy is held back deliberately.** Wave 1/2 rename identifiers and file names **only**; the string `'Runs'` inside `DISPATCHES_HEADING` is still `'Runs'` until the surface that renders it is restructured. This keeps "mechanical rename" and "copy change" as separate, separately-testable risks — and means the L1 vocabulary scan (Wave 10) is the first time a copy assertion can honestly fail.
4. **Storage is not involved.** No `host.storage` key, no panel id, no manifest id changes (FR-025, invariant 4) — there is no namespace reset, no migration, and nothing for an operator to lose.
5. **Renamed-then-deleted is accepted.** A few symbols renamed in Waves 1–2 (`ReposSection`, `repaintReposSection`, `Repositories`) are deleted by Wave 4's spike retirement (T-010). That is deliberate: a mechanical rename on a known-green tree is the cheapest possible place to take the rename's risk, and every wave after Wave 1 writes new code in the product's vocabulary — which is exactly FR-024's point ("leaving `runs` and `repos` in the source … is precisely how the next feature picks up the wrong word").
6. **The rename is guarded, not trusted**: `tests/vocabulary.test.ts` (N7) fails the build if a `repos*`/`runs*` **module file** reappears in `src/`, or if an operator-facing string carries a retired noun.

## Cross-feature coordination and interface assumptions

| # | Coordination point | How 005 honours it |
| --- | --- | --- |
| X1 | **003 owns the dispatch state machine and audit; 005 renders it and gates retry on 003's rules** | The Dispatches tab calls 003's existing operations (`retry`, `resolve`, `requeue`, `verification`) and renders their verdicts. No new transition, no new refusal, no new audit row (FR-027, FR-044, FR-046). The affordance table is a *projection* of 003's `## Dispatch State Model`, asserted against one fixture per state |
| X2 | **004's `startingPrompt` renders once on Bindings (005 FR-051)** | One field in the binding editor, sourced from `GET /v1/bindings`; row shows presence + length only; refusals render 004's field-level remediation and leave the stored prompt in force (FR-052). 004 ships no UI; 005 does not re-validate or compose the prompt |
| X3 | **002 FR-041 / 002 AC-021 — the six card setting ids must not be read from `ctx.settings`** | Wave 4's **T-011** empties `contributes.integration.settings` and deletes `parseSpikeConfig` / `resolveProjectId` / `parseExpectedAgent` and every reader of the six ids. `expectedAgent` is read from `GET /v1/config` (002 FR-029's two-case split: configured value, or documented default `project-manager` **with provenance**). Task written so a manifest already emptied by 002's close-out simply passes |
| X4 | **002 FR-042 — README/quickstart doc sync for the six-tab UI** | Carried by **this feature**: Wave 10's **T-033** updates `README.md` and `specs/002-agent-event-extension/quickstart.md` for the six tabs, the vocabulary table (005 FR-029), the prerequisites section now on Status, the Settings tab as the configuration surface, and the Accounts expected-login input; it asserts neither document instructs `.env`/`MECHA_TURK_*` configuration nor presents an unlabelled `specs/001-agent-event-orchestrator/` path |
| X5 | **003's `leaseMs` / `resultDeadlineMs` config fields** | 005's Settings tab renders **every field `GET /v1/config` actually carries** — never a hard-coded count. The ten fields FR-071 names render fully; 003's two render with their value and *bounds and take-effect not declared by this build* (honest, not hidden). **The row count is 006's concern** (006 renders thirteen: these two + `expectedAgent`), recorded here rather than assumed away |
| X6 | **006's Settings edit surface lands on 005's shell** | 005 ships read-only rows, no disabled-looking control, no write path, and no partial PUT (FR-070). The row **structure** (name / value / unit / bounds / take-effect) is designed to carry 006's controls in place; 006 FR-011 states the transition is explicit and two-way |
| X7 | **004's T-014 "no `startingPrompt` in `panel/main.js`"** | True for 004's window. 005 replaces it with the exactly-once assertion (SC-105). Recorded so no one "repairs" 005 backwards |
| X8 | **006's `GET /v1/config` schema projection (006 FR-020–FR-022)** | 005 does **not** widen the config read (its own `## Wire Surface Delta` says Config is *Unchanged by 005*). Until 006's projection lands, 005 renders bounds/unit/take-effect from a single panel-side declaration that a **cross-check test pins against `service/config.ts`'s `NUMERIC_BOUNDS`/`DEFAULT_CONFIG`** — the copy therefore *cannot drift silently*; the test fails instead. 006 FR-020–FR-022 then move the declaration onto the wire and delete the panel copy. **Confirmation requested** — see [research.md](./research.md) Q1 |

### Not absorbed by 005 (recorded so nobody adds it by reflex)

006's edit surface, 003's dispatch machinery, and 004's prompt capability are explicitly excluded. Also not 005's: the service-side `agentVerified` mirror, retention/export/restore, policy profiles, dedupe-index eviction, the webhook adapter, work-completion tracking, automatic cleanup, and the `Rule:` framing-line cosmetic that 003's and 004's pm-handoffs record as "005's implementation **or later**" — **005's spec carries no FR/AC for it, so this plan carries no task for it**; it stays a known cosmetic until a spec claims it.

## Key decisions and rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Rename **first** (Waves 1–2), copy **later** (Wave 5+) | the mechanical risk is taken on a stable post-003/004 tree, and every subsequent diff is reviewable in correctly-named files; separating rename from copy means each wave's tests assert only what that wave changed | rename last (the rename then has to cover everything 005 wrote, on the least stable tree); rename inline with the IA swap (one unreviewable diff mixing moves and behaviour) |
| D2 | Relay loop owned by the **panel root, on the Dispatches tab's behalf** | makes "exactly one loop, unaffected by switching" structurally true; 003's arming site is already root-level, so tab ownership would *introduce* the mount/unmount coupling FR-018 forbids | Dispatches-tab ownership (equally conforming per the spec's Assumptions, but it moves an existing root-level arm into a lazily-mounted body — a net risk increase) |
| D3 | Bodies mount on **first activation** and never unmount | FR-013's stated reason: the host clears subscriptions on unmount/pause/remove/server-switch, so six eagerly-mounted bodies are six read paths to tear down correctly; mount-once also makes 006's "unsaved edits survive a tab switch" true | eager mount at panel open (six read paths, six teardown obligations); unmount-on-deactivate (loses read state, risks re-reading, breaks 006's unsaved-edit expectation) |
| D4 | ARIA association is **owned by the shell and re-stamped after every `update()`** | the SDK repaints by clearing the track and emits no `id`/`aria-controls`; an association stamped once would silently vanish on the first selection change | depending on the SDK to add association (it does not, and the SDK is pinned); `aria-label` on the body only (valid ARIA, but not the tab↔body association FR-016 requires) |
| D5 | Status reads a **read-only view of the live scheduler**, not a copy | the defect being fixed is a literal contradicting a running process; any state copied into the route can drift the same way | computing `paused` from "has a binding" (a guess), or having the route re-derive scheduling (a second implementation to keep in step) |
| D6 | `GET /v1/events` pagination is **cursor-based with an opaque token**, not offset | the list is newest-first over a mutating file; an offset would drop or duplicate rows at a boundary (the spec's edge case forbids exactly that) | `offset`/`limit` (rows shift under a moving head); keyset on `detectedAt` alone (ties collide; the composite key is the tiebreak) |
| D7 | Filters are **server-side and refuse unknown values** | a client-side filter over a paged read filters a *page*, not a history, and lies about its result (spec's Assumptions); an unknown filter token mapping to "no filter" would silently widen the set (FR-003) | client-side filtering; silently ignoring an unknown `state` |
| D8 | `displayName` gets its **own narrow write route** | the Wire Surface Delta fixes the DTO change but delegates "exact field names, status codes, error codes" to Phase 4; a dedicated `PUT` cannot overwrite custody fields by accident, and FR-006 puts *no* display-name input on the add form ("exactly one optional, non-credential input"), so the value must be settable on the row after creation | folding it into `POST …/token` (couples a label to rotation); a whole-account `PUT` (a mistyped body could clobber `state`/`scopeCheck`) |
| D9 | Settings renders **every field the document carries**, fully for FR-071's ten and honestly-declared-less for any others | FR-003: a field the service holds must never be hidden, and a value must never be rendered as a default; the count is 006's criterion (006 AC-101), not 005's | hard-coding ten rows (would hide 003's two fields once 003 lands); rendering extras as *"field this version does not show"* (006's edge case is about an **unknown** field — `leaseMs` is known, just not declared by 005) |
| D10 | Bounds/unit/take-effect come from **one panel-side declaration pinned by a cross-check test** | 005's own wire delta forbids widening `GET /v1/config`, yet FR-071 demands service-owned bounds; a copy that a test compares against `service/config.ts` **cannot drift** — the failure moves from the operator's eyes to the build | widening the config read in 005 (contradicts 005's `## Wire Surface Delta`, and would collide with 006 FR-020–FR-022); typing the bounds with no pin (guaranteed drift — the exact defect 005 exists to end) |
| D11 | Spike retirement **deletes** rather than archives | FR-011: "a hidden second path to a capability is a second thing that can drift"; the ledger's *reader* survives in About's Diagnostics precisely so `extension-spike-1` still has a surface (Gate Question 2) | keeping the spike pane behind a hidden flag (forbidden by FR-011); dropping Diagnostics entirely (rejected by the product owner — leaves nothing to notice an evidence-schema version change) |
| D12 | Legacy settings retirement ships **with the shell**, not later | once the spike body is gone there is no surface for the legacy configuration verdict, and the manifest card would otherwise declare six settings nothing reads — 002's own cleanup called that "duplicates that pretend otherwise" | retiring the reader but keeping the card fields (002 AC-021 fails); retiring the card first (the panel would then have no project id source until the picker-only rule lands — a broken intermediate) |

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **The L2 rename is wide** (~27/39 test files, 28/40 `src/` files mention `runs`/`repos`) | a missed import breaks typecheck; a missed string breaks the vocabulary suite late | two atomic sub-renames, each `git mv` + sweep + `npm run verify` + bundles in one commit; `tests/vocabulary.test.ts` fails the build on any surviving `repos*`/`runs*` module file or retired noun; the inventory is **re-derived from the tree at execution time** (`ls src/runs* src/repos* tests/runs* tests/repos*`), not from this document |
| **The IA swap touches mount, teardown, and lifecycle at once** | orphan nodes, surviving timers, a duplicated relay loop, or a lost handoff | `src/tabs.ts` owns one registry and one dispose path; NFR-108's count-based teardown test (T-031), AC-137's pre/post counts (T-009), and AC-136's one-loop-across-switches test (T-019, re-asserted in T-031) are named tasks and run at their wave boundaries; the relay arm site is *not moved* (D2) |
| **Deleting the spike surface removes a live control** | an operator loses a capability silently | the removals are enumerated and each is a requirement's consequence, not a cleanup: *Start session* (003 FR-035 conformance, 005 FR-018/FR-044), *Record phase* (005 FR-011 + Gate Question 2), *Verify host state* and the *Poll now* button (retired with the spike body; *Poll now*'s refresh role moves to Status, Clarification row 8). Nothing else is removed |
| **Retiring the legacy settings path breaks the project picker or the poll interval** | the panel can no longer resolve a project or show an interval | project id re-sourced from `mecha-turk:project` only (002 FR-013, 002 FR-014: the picker memory key is UI state, explicitly *not* a configuration source); the interval comes from `GET /v1/status.polling.intervalMs` / `GET /v1/config`, which is where it always lived service-side |
| **`expectedAgent` has no field until 006** | verification could silently compare against nothing | 002 FR-029's two-case split is implemented exactly: field absent/unreadable → documented default `project-manager`, run **proceeds to verification**, outcome records `provenance: 'defaulted'`; only an observed-agent mismatch or unreadable *observed* agent blocks |
| **Settings bounds could drift from the service** | the panel would print a bound the service no longer enforces — the defect class 005 exists to end | D10's cross-check test imports `service/config.ts` and asserts every declared bound/unit/default; the test fails on drift; 006 FR-020–FR-022 then replace the copy with the service's own projection |
| **Row count on Settings is unsettled once 003's fields exist** | AC-135 says "ten rows" while the document may hold twelve | D9: render what the document holds; the count criterion of record is 006 AC-101 (eleven editable rows) per 005's own v1.3.0 amendment; recorded as interface assumption X5 and raised for confirmation |
| **004's bundle assertion (`no startingPrompt in panel/main.js`) turns red** | a reviewer "fixes" 005 backwards | recorded as X7; the proof wave replaces it with SC-105's exactly-once assertion in the same commit that introduces the field |
| **A tab switch mid-dispatch double-claims** | a second session — the catastrophic direction | D2 (loop is root-owned and never touched by a switch) + AC-136's instrumented test asserting one loop and no second `startSession` across switches |
| **Committed bundles forgotten** | shipped code ≠ source (invariant 1) | every wave's exit criterion includes `npm run build` + `tests/bundle.test.ts` green; `npm run verify` at every wave boundary; the bundles ride the same commit as their sources |
| **Scope bleed into 006/003/004** | rework, spec conflict | the out-of-scope guard below, restated at the head of [tasks.md](./tasks.md); no task calls `PUT /v1/config`, invents a run transition, or composes a prompt |

## Out-of-scope guard (checked at every wave)

No GitHub write of any kind (002 FR-031, 003 FR-002, 005 FR-002). No `PUT /v1/config` call and no Settings write path (FR-070 — 006's). No new run state, transition, refusal, or audit row (003's; FR-027). No prompt composition, validation, or storage (004's; FR-051). No wire path renamed — `/v1/events*`, `repositories`, `/v1/bindings`, `/v1/accounts`, `/v1/health`, `/v1/status`, `/v1/config` all keep their names and member names (FR-023, FR-026). No `host.storage` key added or renamed, panel id unchanged (FR-025). No capability, permission, host API, or SDK re-pin (FR-004, FR-079). No version bump (FR-087). No project/worktree/session/agent created, deleted, or mutated by the panel (FR-089). No service-side `agentVerified` mirror, retention/export, policy profiles, dedupe eviction, webhook, work-completion tracking, or automatic cleanup (005 `## Out of Scope`).

## Project structure

### Documentation (this feature)

```text
specs/005-panel-ia/
├── spec.md                 # v1.3.0, APPROVED — the source of truth (Phase 3; untouched by this phase)
├── plan.md                 # this file (/speckit.plan)
├── research.md             # Phase 0: no open research; the two confirmations Phase 4 returns, decided with defaults
├── data-model.md           # Phase 1: panel state, status projection, dispatch page state, storage keys
├── contracts/
│   ├── README.md           # index + supersession pointers + universal rules + co-ship assumption
│   ├── status-projection.md    # the `Status` row — supersedes 003's `## Wire Surface Delta` Status entry
│   ├── dispatch-list.md        # `GET /v1/events` paging + server-side filters
│   ├── about-version.md        # `GET /v1/health` → the About tab's single version source (no route added)
│   └── account-display-name.md # `AccountDto.displayName` + its write operation
├── tasks.md                # Phase 5 output (/speckit.tasks)
└── checklists/             # pre-existing Phase-3 checklists (untouched)
```

`quickstart.md` is **not** produced in Phases 4–5 for this feature: the deliverable set for 005 is the five artifacts above plus [tasks.md](./tasks.md), and every manual validation scenario this feature needs is named as an assertion inside the proof wave's tasks. If the phase gate asks for a walkthrough, it is written then, from the proof wave's scenarios.

### Source code (repository root — the real layout this plan changes)

```text
src/
├── tabs.ts                 # NEW: the six-tab shell (mount, first-activation registry, ARIA association, dispose)
├── panel-state.ts          # CHANGED: activeTab lifted to runtime as TabId; repos → bindings; RunsState → DispatchesState
│                           #           (+ filters, cursor stack, page size); pendingPhase removed; ReposSection → BindingsSection
├── panel-ui.ts             # CHANGED: repaintReposSection DELETED; banner/notice region + refresh plumbing only
├── app.ts                  # CHANGED: mount order (shell → tab bodies → relay arm → teardown walks the registry)
├── status-tab.ts           # NEW: Status body (FR-030–FR-039)
├── settings-tab.ts         # NEW: Settings body, read-only (FR-070–FR-073)
├── settings-rows.ts        # NEW: the row declaration pinned to service/config.ts by a cross-check test
├── about-tab.ts            # NEW: About body + read-only Diagnostics (FR-074–FR-077)
├── dispatches-ui.ts        # NEW: paged/filtered list body, range line, filters, row detail (FR-041–FR-049)
├── accounts-rows.ts        # NEW: account row projection for FR-062's field list
├── repos.ts                → bindings.ts          (Wave 1, git mv)
├── repos-ui.ts              → bindings-ui.ts      (Wave 1)
├── repos-rows.ts            → bindings-rows.ts    (Wave 1)
├── repos-service.ts         → bindings-service.ts (Wave 1)
├── repos-mount.ts           → bindings-mount.ts   (Wave 1)
├── runs.ts                  → dispatches.ts       (Wave 2, git mv)
├── runs-ui.ts               → dispatches-ui.ts    (Wave 2 — then extended into the paged list)
├── runs-rows.ts             → dispatches-rows.ts  (Wave 2 — then the state→affordance table)
├── runs-service.ts          → dispatches-service.ts (Wave 2 — then the paged-answer parser)
├── config.ts                # CHANGED: parseSpikeConfig / resolveProjectId / parseExpectedAgent DELETED (002 AC-021);
│                             #           projectId/expectedAgent/interval readers re-sourced
├── bindings-mode.ts         # CHANGED: no settings-derived branch; expectedAgent from GET /v1/config
├── panel-actions.ts         # CHANGED: legacy poll controls retired with the spike surface
├── accounts-ui.ts           # CHANGED: handoff group relocated into the Accounts tab; rows + displayName edit
├── project-picker.ts        # CHANGED: mounted in the Bindings tab's picker (003's guidance already built)
└── relay.ts / session.ts / agent-verify.ts / ledger.ts / evidence.ts   # CHANGED only where the six-tab mount path touches them

service/
├── routes/status.ts         # CHANGED: polling computed, repositories rows, agentPin widened (C1–C3)
├── routes/events.ts         # CHANGED: cursor pagination + filters; recentRuns() stays unpaged (C4)
├── routes/accounts.ts       # CHANGED: displayName write route + DTO member (C5)
├── accounts/model.ts        # CHANGED: Account.displayName + AccountDto.displayName (C5)
├── poll/view.ts             # NEW: read-only polling view (running / nextPollAt / pausedReason) — reads timer+loop, changes neither
└── main.js                  # REBUILT + committed (invariant 1)

panel/
├── index.html               # UNCHANGED (the shell is built from #root by the SDK primitives)
└── main.js                  # REBUILT + committed (invariant 1)

package.json                 # CHANGED: contributes.integration.settings EMPTIED (002 FR-041). version stays 0.0.1.
AGENTS.md                    # CHANGED: module map rows follow the L2 rename; nothing else moves.

tests/
├── vocabulary.test.ts       # NEW: L1 / L2 / L4 vocabulary suite (N7; T-003 then T-029)
├── tabs.test.ts             # NEW: shell mount, activation, association, teardown (T-008)
├── status-tab.test.ts       # NEW: Status rendering fixtures (running / stopped / degraded / unsupported) (T-012–T-014)
├── service-status.test.ts   # NEW: SC-101/SC-102 honesty assertions against the route (T-004)
├── dispatches-paging.test.ts# NEW: cursor stack, filters, empty-filtered, total-unavailable (T-017)
├── bindings-prompt.test.ts  # NEW: the prompt's exactly-once count + clear/omit body shapes (T-021)
├── bindings-ui.test.ts      # NEW: editor field list, override marking, picker guidance placement (T-022)
├── settings-rows.test.ts    # NEW: row declaration ↔ service/config.ts cross-check + read-without-service (T-027)
├── about-tab.test.ts        # NEW: version source, unreachable service, Diagnostics read-only (T-028)
├── bindings-mount.test.ts   # (was repos-mount.test.ts, git mv in Wave 1)
├── bindings-removal.test.ts # (was repos-removal.test.ts, git mv in Wave 1)
├── dispatches.test.ts       # (was runs.test.ts, git mv in Wave 2; + the one-fixture-per-state table)
└── (extended) bundle.test.ts, manifest.test.ts, service-events.test.ts, service-accounts.test.ts,
    app.test.ts, accounts-ui.test.ts, panel-actions.test.ts, status-lines.test.ts, config.test.ts,
    service-server.test.ts, relay-arming.test.ts, handoff*.test.ts, consent.test.ts
```

**Structure decision**: no new directory, no new package, no new dependency. Panel-side 005 work is one module per responsibility (`tabs`, `status-tab`, `settings-tab`, `settings-rows`, `about-tab`, `dispatches-ui`, `accounts-rows`), matching `AGENTS.md`'s one-responsibility-per-module map; service-side 005 work stays inside the three route modules it changes plus one read-only view module, because `service/routes/status.ts` is where the projection lives and a second status implementation is exactly the drift FR-031 forbids.

## Complexity tracking

**None.** The constitution check passed without violations, so there are no violations to justify.

---

# Amendment record — 005 v1.11.0 (2026-10-03): the actor allow-list's rendering

> **This section is a dated Phase-4 record added on 2026-10-03.** Everything above it is the plan of
> 2026-09-28 and is retained as written. The v1.11.0 amendment is **additive** (block J,
> FR-090 – FR-095, NFR-113, SC-113, AC-142 – AC-146) and re-cuts no existing requirement, renames
> no audit row, adds no wire operation, and touches no existing member's shape.
>
> **The field and its rules are [`002-agent-event-extension`](../002-agent-event-extension/plan.md)'s
> (002 v1.11.0); the gate that enforces them is [`003-dispatch-integrity`](../003-dispatch-integrity/plan.md)'s
> (003 v1.8.0).** What is 005's is **rendering only** — and its centre of gravity is one obligation
> the product owner attached to the fail-open posture: an absent allow-list means *any human may
> trigger*, and that state MUST be **discoverable — visible in the panel and warned about — rather
> than silently implying protection**.

## C.1 Scope of 005's half

| Requirement | What 005 builds | Where |
| --- | --- | --- |
| FR-090 | one field in the binding editor, free text, guidance stating all three of 002 FR-047's states, **no identity picker**, and **no client-side copy of the rule** | `src/bindings-actors.ts` (new), `src/bindings-grant.ts` |
| FR-091 | **one rendering per list value** — the logins appear exactly once panel-wide, in the editor field; a **count** is permitted on a row summary and is not a second rendering | `src/bindings-actors.ts` |
| FR-092 | an absent policy is a **visible worded warning** wherever a binding is listed outside its editor — text not colour alone, not an error, never phrased as *protected* | `src/bindings-actors.ts` |
| FR-093 | Status states **how many** of the listed bindings carry no list, plus one line naming the consequence; a count of **zero** renders as a positive statement; unreachable renders *not available*; no login, no repository name | `service/routes/{status,events}.ts` (the `actorPolicy` member), `src/status-document.ts`, `src/status-lines.ts`, `src/status-tab.ts` |
| FR-094 | the dispatch row names the attributed actor and, where the basis is `subject-author`, the basis in the panel's words; each source reference in the reveal carries its own; a gate-refused run names the **denied** login | `src/dispatches-rows.ts` |
| FR-095 | a refusal splits back to the field, leaves every other binding byte-identical, is never reported as saved, and never echoes the submitted value | `src/bindings-actors.ts`, `src/bindings-grant.ts` |
| NFR-113 | no element presents a binding as **protected / restricted / secure** unless the service said `restricted`; no element presents an absent policy as neutral or healthy | the `C-6` string scan |

**Not 005's**: the field's rules (002's), the gate (003's), and every decision about what a dispatch
may do (003's). 005 renders 003's verdict and never predicts it (FR-046).

## C.2 Module map delta (005's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `service/routes/events.ts` (`readStatusRows`) + `service/routes/status.ts` | each `repositories[]` row gains `actorPolicy` (`'open' \| 'restricted'`), derived from the binding the row is already built from — **never the logins** | FR-093 |
| `src/status-document.ts` | the fail-closed parser gains `actorPolicy` and **refuses** an unrecognized value | FR-093, 005 NFR-112 |
| `src/status-lines.ts`, `src/status-tab.ts` | the counted line, its zero case, its unreachable case, and the pointer at the Bindings tab | FR-093 |
| `src/bindings-service.ts` | `PanelBinding.allowedUsers?`; the entry reader refuses a bad shape; the client-of-record rule | FR-090 |
| `src/bindings-actors.ts` (**new**) | the editor field, its guidance, the row count, the absent-policy warning, the refusal slot | FR-090 – FR-092, FR-095 |
| `src/bindings-grant.ts` | the member rides every row of the whole-file write | FR-090, FR-095 |
| `src/dispatches-rows.ts` | each reference's actor + basis; the refused run's copy | FR-094 |

## C.3 Key decisions — actor allow-list rendering (added 2026-10-03)

> Numbered `D13…D18` to continue this plan's own `D1…D12` series.

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D13** | **A new module `src/bindings-actors.ts`**, mirroring `src/bindings-prompt.ts` exactly: one field, one rendering, the row summary showing presence-and-length only. | 004's prompt and 005's allow-list are the same shape of requirement — *one value, one rendering* — and 004's rule already exists in the codebase, so the allow-list's rendering belongs beside it rather than inside `bindings-editor.ts`, which is a derived-views module and near the file-length gate. | Extending `bindings-prompt.ts` to own two fields (its name and its docblock are about one value; the exactly-once proof would have to reason about two); putting the field in `bindings-editor.ts` (that module is "the editor's derived field views" — a field is not a derived view). |
| **D14** | **An empty editor field is submitted as an **absent key**, never as `[]`.** The panel therefore never manufactures an empty array. | **This is the flagged fork.** Under omission-preserves it would be impossible; under this contract (§2 of `binding-allow-list.md`) an absent key means unset, so "clear the field" is expressible with no sentinel — which is what makes 002 FR-047's own refusal remediation ("remove the field to allow everyone") actionable. `[]` remains reachable only from a hand-edited file or a non-panel client, which is exactly where 002 AC-026 puts it. The alternative — submitting `[]` and having the service refuse it — makes a configured list **impossible to remove**, a worse defect than the one it avoids. | Always submit the parsed array, so an empty text field produces `[]`: the operator then has no way to remove a list at all, and 005 AC-142's "no second control" leaves no affordance to add. **Flagged** in [`002/pm-handoff.md`](../002-agent-event-extension/pm-handoff.md) §Flagged #2 — if the owner prefers this reading, AC-142's "no second control" needs to permit a control inside the field's block that expresses *unset*. |
| **D15** | **The panel renders the count it was given; it never computes a policy verdict.** `actorPolicy` on Status comes from the service; the row's warning is keyed on the **absence of the member**, not on a panel-side membership test. | FR-076 forbids a second membership comparison and FR-090 forbids a client-side copy of the rule. "The field is empty" is a fact about a rendered control, not a policy decision — and the two are the same thing here only because the service refuses `[]`. | The panel deciding "restricted vs open" from the array it already holds (a second implementation of a security rule, in the tier that is least trusted to enforce it). |
| **D16** | **Status names no repository and no login; the count plus the consequence is the whole line.** | 005 FR-039 already forbids Status from presenting a value the Bindings tab owns, and clarification row 42 says so explicitly. Answering "is anything open" by name would make Status a second index of bindings. | Listing the open repositories (a second binding index on two tabs, and the names belong to the Bindings tab). |
| **D17** | **`actorPolicy` is added to `BindingStatusRow`, so it also rides the claim answer's `status` array.** Additive, and the panel's existing `readStatusRows` parser must tolerate it. | `readStatusRows` is the single projection the Status route, the claim answer, and the Bindings tab all read — the same discipline plan D5 already established for the poll view, and the reason the two surfaces cannot disagree about a binding. | A separate `actorPolicies` map on the status document only (a second source for one fact, and the claim's copy would then disagree with Status's). |
| **D18** | **A gate-refused run's copy names the denied login and 003's reason; the panel never predicts the verdict and never offers Retry until the service says the cause cleared.** | FR-094 renders 003's label and reason; FR-046 forbids predicting a service verdict. `blocked:actor-not-allowed` joins the existing state→affordance table, so its retry validity comes from that table rather than from a special case — which is also what makes the table assertion still fail for a cause with no row. | A panel-side pre-check that disables Retry until the operator's own list contains the denied login (a second implementation of the rule, and it would be *wrong* whenever the service's view differs). |

## C.4 Constitution alignment (v1.3.0) — carried forward, re-read for this amendment

> The v1.11.0 entry records the same review; this table restates it for the rendering rather than
> re-litigating it. **No principle is weakened; one is applied harder than before.**

| Principle / gate | How the rendering satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Two reads change, both recorded in [contracts/](./contracts/): `GET /v1/status` gains one member per `repositories[]` row, and the bindings grant gains one member per row. Both additive within v1; no path renamed (FR-023, FR-026). |
| **II. Safe autonomy by default** | The principle this amendment serves most directly, and the place the honest reading had to be written down: the owner chose fail-open, which on its own sits awkwardly with a principle that makes a missing authorization a stop condition. **II forbids ambiguity, not openness.** A binding with no allow-list is not ambiguous once the panel says *"anyone who can open an issue or comment on this repository can start a session"* on the row that lists it and again in a counted line on Status. What II forbids — and what FR-092/NFR-113 exist to prevent — is the panel rendering an open repository as though a control were in force. |
| **III. Durable and idempotent work** | Nothing durable is rewritten; no store file changes shape; no `host.storage` key is added or renamed (FR-025). |
| **IV. Human-visible auditability** | FR-094: the row names the actor, the basis, and a denial, so *"why did this run, and who asked"* is answerable in the product. |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, permission, or SDK re-pin; no new route. |
| **VI. Specification and verification before implementation** | Why this is five acceptance criteria, one NFR, and a string scan rather than a copy decision. |
| **VII. Thin orchestration boundary** | No host capability, no host call, and specifically **no invented GitHub identity picker** — the field is free text the service validates. |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any` (FR-088); offline suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (FR-087, invariant 1). |

**`AGENTS.md` invariants — how the rendering touches each of the ten.** (1) committed bundles ship;
(2) **no `version` bump** — a bump is a product-owner release decision (FR-087); (3) `capabilities[]`
untouched, `contributes.service` gains no `permissions`; (4) kebab-case identity and every
`mecha-turk:` key untouched — the allow-list rides `host.storage` **nowhere**, since it is read from
`GET /v1/bindings` and never persisted (FR-025, invariant 9); (5) `SERVICE_VERSION` untouched;
(6) SDK pin untouched; (7) zero suppressions, zero `any`; (8) **fail closed** — the bindings parser
and the status parser both refuse an unusable member rather than defaulting it (invariant 8, and the
same posture as `bindings-service.ts`'s prompt reader); (9) secrets never leave the service store —
and the stronger, new rule: the **permitted list** reaches no ledger entry, no `host.storage` value,
and no shipped bundle; (10) **`extension-spike-1` untouched** — the Diagnostics record keeps reading
the evidence schema version, and nothing in this feature touches it.

## C.5 Flagged items (Phase-5 findings — decide at the gate, not in code)

1. **The empty-list round trip (D14).** 005 FR-090 says the panel "MUST NOT pre-emptively accept
   input the service would refuse nor pre-emptively reject input it would accept", which reads both
   ways for an empty text field; and 005 AC-142 requires that "submitting `[]` is refused by the
   service" **while also** requiring "no second control". The three cannot all hold unless the panel
   either submits `[]` (and cannot clear a list) or omits the key (and never produces `[]`). **Chosen:**
   omit the key, and discharge AC-142's `[]` case against the **service** plus the panel's own
   refusal-rendering path. **Recommended owner wording**: confirm that reading, or permit one
   affordance inside the field's block that expresses *unset*.
2. **A `[bot]` login the operator has typed** (002 plan D7). Accepted and inert. The field's guidance
   copy is the honest place to say that bot-authored activity never triggers — which is a copy
   decision inside FR-090's existing mandate, not a new requirement. Flagged so it is a deliberate
   line rather than an omission.

## C.6 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| A login string reaches a second surface (Status, a row, Diagnostics, a log) | `C-6`'s exactly-once count across **all six tabs**, failing at 0 **and** at 2, exactly as `SC-105` does for the prompt |
| A copy string says *protected* about an open binding | `C-6`'s scan for *protected* / *restricted* / *secure* across every user-facing string, asserted only about bindings the service reported `restricted` (NFR-113) |
| The absent-policy warning reads as an error and trains operators to dismiss warnings | FR-092 forbids the error framing in requirement text; `C-6` asserts the wording and that it carries text, not colour alone (FR-083) |
| `actorPolicy` drifts from `allowedUsers` because two projections compute it | D17: one projection (`readStatusRows`), read by Status, the claim answer, and the Bindings tab |
| The panel's parser starts accepting a malformed `allowedUsers` | `C-1`'s own gate refuses a non-array and a non-text element (invariant 8) |

## C.7 Out-of-scope guard for the issue-#9 block (checked at every task)

No panel-side policy **check** (only the service decides — 003 FR-076). No identity picker, search, or
typeahead (FR-004, FR-089). No showing the permitted logins anywhere outside the editor field
(FR-091). No second editor, second field, or second control for the list (FR-090, AC-142). No global,
account-level, or shared allow-list; no team- or role-based rule. No `PUT /v1/config` call and no
Settings row for the field (**006 is deliberately not amended**; a per-binding value cannot live in
one global document, and its take-effect boundary is an authorization event, not a cycle boundary).
No new run state, transition, refusal code, or audit row — 005 renders 003's. No migration or
upgrade path for a binding stored without the field. No version bump, no capability, no SDK re-pin,
no storage key.

## C.8 Phase-6 task block for this amendment

The consolidated execution list lives in
[`002-agent-event-extension/tasks.md`](../002-agent-event-extension/tasks.md) §"Issue #9 block
(2026-10-03)"; 005's own tasks are `C-1 … C-6`.
