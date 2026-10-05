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
| FR-094 | the dispatch row names the attributed actor; a `direct` reference renders the login alone with **no basis clause**, and a legacy `subject-author` reference renders a **historical** basis clause — attributed under the rule in force when the row was written — that does **not** claim GitHub lacks the field; each source reference in the reveal carries its own; a gate-refused run names the **denied** login | `src/dispatches-rows.ts`, `src/run-actor.ts` |
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

---

# Amendment record — 005 v1.16.0 (2026-10-05): the Status tab's refresh cadence (GitHub issue #20)

> **This section is a dated Phase-4 record added on 2026-10-05.** Everything above it is the plan of
> 2026-09-28 and is retained as written, as is the v1.11.0 record above. The v1.16.0 amendment is
> **panel-side only**: it adds no wire surface, no route, no member, and no contract edit, and it
> amends no other specification. `specs/002-agent-event-extension/contracts/panel-service.md` is
> **not edited** — the cadence is not a retry loop, so §1's rule stands uncontradicted.
>
> **The three product-owner decisions are fixed and not re-litigated here:** Status tab only; the
> period is the effective `polling.intervalMs` the document reports rather than a fixed 60 s; and
> every activation reads while a repeating tick runs only while Status is active. Everything below
> is how the panel implements them, and what it had to decide that the requirements did not settle.

## D.1 Scope of 005's half

| Requirement | What 005 builds | Where |
| --- | --- | --- |
| FR-100 §1 | one `setInterval` armed from the interval the last landed document reported, disarmed the moment another tab activates, cleared by the tab's disposer, idempotent for an unchanged period | `src/status-tab.ts`, `src/tabs.ts`, `src/panel-state.ts` |
| FR-100 §2 | nothing new — the existing `phase === 'loading'` guard in `loadStatus` **is** the in-flight rule, and it is left exactly as it was | `src/status-tab.ts` (unchanged guard) |
| FR-100 §3 | the interval-less window: no arm at mount, no default, no fallback to the configured interval, and the tab says so | `src/status-tab.ts`, `src/status-lines.ts` |
| FR-100 §4 | nothing new — the period is read from the document and never from the last read's outcome, which is what makes a backoff unreachable rather than merely forbidden | `src/status-tab.ts` |
| FR-101 | one worded cadence statement beside the refresh control, identical after a tick and after a press | `src/status-lines.ts`, `src/status-tab.ts` |
| FR-014, FR-019, FR-030, FR-039 | re-cut / extended in the spec at v1.16.0; **no new rendering** beyond the cadence line | `src/tabs.ts`, `src/status-tab.ts` |

## D.2 Module map delta (005's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `src/panel-state.ts` | `STATUS_TAB` (the one id two modules must agree on) and two runtime slots, `statusRefreshTimer` + `statusRefreshMs`, written only by the arm/stop pair | FR-100, FR-101 |
| `src/status-tab.ts` | `armStatusRefresh` / `stopStatusRefresh`; the arm after a landed read and before the repaint; the clear in `disposeStatusTab`; `StatusTabUi.cadenceLine` | FR-100, FR-101, NFR-108 |
| `src/tabs.ts` | `activate()`'s re-activation exception for Status, its read on switching **to** Status, and its disarm on switching away | FR-014 (re-cut), FR-100 |
| `src/status-lines.ts` | `cadenceLine` — the one statement, and its interval-less value | FR-101, NFR-112 |

**No new module.** The cadence is two functions and one line of copy in modules that already own
those jobs, and `AGENTS.md`'s module map and `tests/vocabulary.test.ts`'s assertion that every
`src/` file is listed both stay true without an edit.

## D.3 Key decisions — the refresh cadence (added 2026-10-05)

> Numbered `D19…D23` to continue this plan's own `D1…D12` and the v1.11.0 block's `D13…D18`.

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D19** | **The tick's body is a parameter of `armStatusRefresh`, not a call to `loadStatus`.** `loadStatus` arms the timer and the timer calls `loadStatus`, so naming the read inside the arming makes the two mutually referential; the arm is told what the timer runs. | FR-100's tick *is* `loadStatus` — nothing else would satisfy "a tick that fires during an in-flight read is a no-op" without reimplementing the guard — but the arming rule (idempotent, refused for a hidden or torn-down tab, re-armed on a changed period) is a property of the **timer**, not of the read, and taking the body as an argument says so at the signature. It also keeps the arming readable without a forward declaration or a lint suppression, which invariant 7 forbids. | Calling `loadStatus` directly from the timer callback: two mutually referential functions, which the analyzer flags as use-before-define in whichever order they are written, and the only resolutions are a reorder that fails in the other direction or a suppression. |
| **D20** | **One arming site: inside `loadStatus`, after the slice lands and before the repaint.** Ordering is load-bearing rather than incidental — the repaint is what renders the cadence statement, so arming after it would show the *previous* period for one frame, and a changed interval would briefly claim a period the document no longer reports (FR-101, NFR-112). | FR-100 §3 says the tick is armed *from the document*, and one site is what makes "at most one tick" a property rather than a convention: every path that could arm goes through the same idempotent arm. | Arming from `activate()` as well as from the read, which would arm a tick before the activation read has landed — arming on the *previous* document's interval, and therefore briefly refreshing on a period the service may have changed (FR-100 §1's "not pinned to the interval it was armed with"). |
| **D21** | **Two runtime slots for one fact, both written only by the arm/stop pair**, rather than deriving "is a tick armed?" from the timer handle inside the copy layer. | `statusLines.cadenceLine` takes a **number or `null`** and never sees a handle, which keeps it a pure function of one number — the same discipline the rest of `status-lines.ts` follows, and the reason a test can assert the copy without a runtime. The cost is one invariant (the two move together), and it is stated on both slots and enforced by the pair being the only writer. | Passing the `PanelRuntime` into the copy layer so it could read `statusRefreshTimer !== null`, which turns a pure function into one that knows about the runtime and cannot be asserted from its own inputs. |
| **D22** | **The cadence statement renders in the tab's own toolbar row, beside `Refresh status` and the read-state line — not in the Polling block.** | FR-101 puts it wherever the tab carries it, and the Polling block is the one place the two intervals are compared (FR-039); a third number there would be a third thing an operator has to tell apart. Beside the control the copy names in its interval-less form is also where the operator looks when the sentence says "use `Refresh status`". | A row in the Polling block, which reads as though the *service's* scheduler had a third cadence and competes with the effective-vs-configured comparison. |
| **D23** | **The interval-less copy names the cause of the ignorance — *no interval has been read*** — rather than only stating the fact. | FR-101 requires the tab to say it is not refreshing itself and name `Refresh status`; saying **why** costs one clause and is what turns the line from an unexplained silence into an answer, and it is the one clause that stays true across every state the line renders in (nothing read yet, a refused read, a document the parser refused, a hidden tab). | Naming a specific cause per state, which would mean the line lies whenever the state changed between the read and the paint — the same fabrication NFR-112 forbids in the number. |

## D.4 Constitution alignment (v1.3.0) — re-read for this amendment

| Principle / gate | How the cadence satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Untouched, and the source of the whole resolution: the period rides a contract the service already publishes (`polling.intervalMs`), so the amendment needs **no** new wire surface and edits **no** contract file. |
| **II. Safe autonomy by default** | **Strengthened, not weakened.** The panel claims *less* about itself when it does not know: no invented interval, no fallback to the configured value, and *not refreshing* rather than a plausible number. A missing, stale, or ambiguous authorization is a stop condition; a missing interval is treated the same way. |
| **III. Durable and idempotent work** | A repeated **read** creates no work and no durable state. The in-flight guard makes a repeated read idempotent in the only sense available here: one request at a time, and a missed tick missed rather than queued. |
| **IV. Human-visible auditability** | The principle this amendment serves most directly. FR-101 requires the tab to *say* that it refreshes itself and on what period, and FR-100 §4 keeps a failing tick rendered exactly as a manual read fails — last document kept, marked stale, cause named, retry offered, stamp unmoved. |
| **V. Minimal, self-hosted deployment** | No new process, dependency, capability, permission, container, or SDK re-pin; one `setInterval` in a panel that already runs one. |
| **VI. Specification and verification before implementation** | Why the behaviour is asserted against a **driven clock** clause by clause rather than described, and why `005 SC-114` enumerates eight cases instead of one. |
| **VII. Thin orchestration boundary** | No host capability, no host call, no new host API. The tick calls the same documented `host.serviceRequest()` the mount read already calls. |
| **Quality gates** | Strict TS + lint, zero suppressions, zero `any` (FR-088, NFR-109); offline suite per task; `npm run verify` at the wave boundary; the rebuilt `panel/main.js` committed with its source (FR-087, invariant 1). |

**`AGENTS.md` invariants — how the cadence touches each of the ten.** (1) committed bundles ship, and
the rebuilt `panel/main.js` is in this change; (2) **no `version` bump** — a bump is a product-owner
release decision (FR-087); (3) `capabilities[]` untouched, `contributes.service` gains no
`permissions`; (4) kebab-case identity and every `mecha-turk:` key untouched — the tick reads
`GET /v1/status`, which the tab already read, and touches no `host.storage` (FR-025, invariant 9);
(5) `SERVICE_VERSION` untouched; (6) SDK pin untouched; (7) zero suppressions and zero `any` — which
is why D19 exists, because the alternative was a forward declaration or a disable; (8) **fail
closed** — an unreadable document still refuses the whole document rather than partially applying it,
so the interval-less window is reached only by a genuine refusal; (9) secrets never leave the service
store, and the cadence reads the same credential-free projection the tab already renders;
(10) **`extension-spike-1` untouched**.

## D.5 Flagged items (Phase-5 findings — recorded, not decided in code)

1. **The unparseable-`intervalMs` case resolves through the fail-closed parser, so it is
   indistinguishable from a transport refusal on the tab.** `005 AC-151` anticipates "a status read
   that **succeeds** but carries an unparseable `polling.intervalMs**" rendering as *loaded, with its
   values and no cause claimed*. The shipped parser refuses the **whole document** over an
   unreadable required member (invariant 8, FR-003), so that state is unreachable: a document with an
   unreadable interval is a document that did not parse. **Chosen:** keep the parser fail-closed and
   discharge the case as *the document is refused* — which satisfies every observable in FR-100 §3
   and `005 SC-114`(f) (no tick, no period, `Refresh status` live, the tab says it is not refreshing)
   and keeps invariant 8 intact. **Rejected:** widening `StatusPollingView.intervalMs` to
   `number | null` and relaxing the parser, which would let a service answer with a half-readable
   status document and render the rest of it as though it were whole. **If the owner prefers
   AC-151's literal reading**, the parser's `polling` block needs the same treatment and the
   spec's `### Wire Surface Delta` row amended to say so.
2. **The cadence sentence is new operator-facing copy.** Its exact wording is a product decision the
   specification deliberately left open ("for example *re-reads every 60 seconds*"). **Chosen, after
   `npm run shot` caught the first attempt on the same tab:** *This tab re-reads itself every 60
   seconds.* / *This tab is not refreshing itself — no interval has been read, so it refreshes only
   when you ask. Use Refresh status.* Recorded here so a copy review can change it without re-reading
   the implementation, and so `tests/status-refresh.test.ts` is where the assertion moves.

   The first attempt rendered the armed branch as ***This tab re-reads itself every 60,000 ms*** and
   is superseded by the wording above. Visual verification caught it for three reasons, all of which
   are properties of *where* a number appears rather than of the number: `intervalText()`'s `en-US`
   grouping exists because the Polling block's `Effective interval 60,000 ms` is a **data row** whose
   `ms` declares the unit, and the same tab was therefore showing one duration two ways (`8h 2m 13s`
   from `formatUptime` in a row, `60,000 ms` in a sentence); FR-101 names *re-reads every 60 seconds*
   as its example; and it degraded worst at the top of the range, where an operator at the validated
   maximum read *every 300,000 ms* where the human form is *every 5 minutes*. The period is now
   rendered in words by a **period-shaped** formatter in `status-lines.ts` — whole minutes at or above
   two minutes, whole seconds below, and the machine form only for a period too short to say in
   seconds, because rounding that into prose would invent a duration. **`formatUptime()` was not
   reused**: its shape is uptime's (it always emits at least a seconds part, and always emits minutes
   once hours are present), so it answers `1m 0s` for 60 000 and `5m 0s` for 300 000 — trailing `0s`
   inside a sentence, and no better than the digits it replaces. **The Polling block's own
   `Effective interval` / `Configured interval` rows are unchanged and out of scope**: their `ms`
   declares a unit on a data row, which is exactly what that rendering is for.

## D.6 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| Two timers survive because two paths armed | One arming site (D20) and an idempotent arm for an unchanged period; `tests/status-refresh.test.ts` asserts the timer count is `pre-mount + 1` across three leave-and-return rounds |
| A hidden Status tab repaints itself under the operator's hands | `armStatusRefresh` refuses for a non-Status active tab and `activate()` disarms on the way out, both before any repaint (D20) |
| The cadence becomes a retry loop with a backoff | The period is read from the document and from nothing else; the test asserts the request-log gaps are exactly one interval each across three refused ticks |
| The interval-less window shows a plausible number | `cadenceLine` takes `number | null` and the copy has no branch that can invent a value; the test scans every rendered string for six candidate periods |
| A tick fires while a read is in flight and stacks a request | `loadStatus`'s existing guard, unmodified; the test holds a read open across a period boundary and asserts one request |
| The other five tabs acquire a cadence by accident | `activate()`'s read and disarm are both keyed on `STATUS_TAB`; the test asserts the whole panel's request count is unmoved across three periods on Bindings, and re-activation reads nothing on all five |

## D.7 Out-of-scope guard for the issue-#20 block (checked at every task)

No service-side change, no new route, no new status member, no request shape, and no edit to
`specs/002-agent-event-extension/contracts/panel-service.md`. No cadence on any other tab. No
automatic retry of anything. No count-down, no pause/resume control, no per-tab refresh toggle, and
no settings field. No version bump, no capability, no permission, no SDK re-pin, no `host.storage`
key, and no change to the other five tabs' behaviour.

## D.8 Phase-6 task block for this amendment

The execution list is this feature's own: `T-037 … T-041` in
[`tasks.md`](./tasks.md) §"Issue #20 block — the Status tab's refresh cadence (added 2026-10-05)".

# Amendment record — 005 v1.17.0 (2026-10-05, replayed after main's v1.16.0): the zero-account binding gate (GitHub issue #18)

> **This section is a dated Phase-4 record added on 2026-10-05.** Everything above it is the plan of
> 2026-09-28 plus the v1.11.0 record, and is retained as written. The v1.16.0 amendment is
> **additive** (block L, `FR-120` – `FR-124`, `SC-114`, `005 AC-154` – `005 AC-156`) and is
> **panel-side only**: no wire member, route, status or error code, stored document, `host.storage`
> key, or contract under `specs/002-agent-event-extension/contracts/` moves, and `FR-124` says so
> rather than leaving it to be re-opened.
>
> **The change is one control's `disabled` predicate and seven strings**, two of which are carried
> over verbatim. No new state member, no new wire, no service file, no new tab, no new route, no new
> capability, no version bump. What Phase 4 has to settle is therefore narrow and entirely about
> **placement**: where the reason line lives, how the gate learns that the account read
> *completed*, how a module `const` becomes a function of state, and how FR-123's three refusal
> strings are made to agree by construction rather than by review.
>
> **Reconciled 2026-10-05, after the owner's ruling on this section's own §K.5 item 1.**
> `FR-122`'s closed empty-text table went from **two rows to three**, so the pre-read and unread
> frame is answered **in copy**: where the accounts read has not succeeded, the empty text says the
> account list is **not known** and names *Refresh*. **Only `D21`, `D25`, the truth tables, the
> counts, and `K.5`–`K.8` move.** `D19`, `D20`, `D22`, `D23`, `D24`, `D26` stand as written —
> FR-120's bar on a pre-read gate is **untouched**, and the third row *consumes* D20's read-success
> conjunct rather than replacing it.
>
> **The counts this record is written against** — checked against `spec.md` v1.16.0 and
> `changelog.md`'s approval status, and the numbers every cross-reference below uses:
>
> | | Count | Where it comes from |
> | --- | --- | --- |
> | Requirements added | **five** — `FR-120` – `FR-124` | spec block L |
> | Empty-text rows | **three** (one predicate, three outcomes) | FR-122's table |
> | Success criteria added | **one** — `005 SC-115` | spec `## Success Criteria` |
> | Acceptance criteria added | **three** — `005 AC-154`, `005 AC-155`, `005 AC-156` | spec `## Acceptance Criteria` |
> | Clarification rows | **five** — **49 – 53**; the owner's **decisions** are at **49, 50, 51 and 53**, while **row 59** is the scope-boundary and known-divergence record, not a decision | spec `## Clarifications` |
> | Ratified product-owner decisions | **five** | `changelog.md` approval status, v1.16.0 |
> | `### Edge Cases` bullets for this block | **four** | spec `### Edge Cases` |
> | `## Out of Scope` entries added | **four**, all tagged `(v1.16.0)` | spec `## Out of Scope` |
> | Residuals | **one** — FR-124's `usable`-versus-`exists` divergence, recorded as a decision rather than deferred | FR-124, clarification row 59 |
>
> **A note on the two figures that are easy to conflate.** *Three* is the count of FR-122's
> **empty-text strings** and of FR-123's **refusal strings**; *seven* is the count of string
> constants the new module carries in total, of which **two are carried over verbatim**
> (`EMPTY_TEXT_WITH_ACCOUNT` **is** the retained `LIST_EMPTY`; `PICK_ACCOUNT_REFUSAL` **is** the
> retained `ACCOUNT_NOTE`), so the genuinely new copy is **five**. Both figures are correct and they
> count different things — the seven is a module inventory, the three is a per-requirement table.

## K.1 Scope of 005's half

| Requirement | What 005 builds | Where |
| --- | --- | --- |
| FR-120 | *New binding* gains **one** extra disable condition — the panel's **successfully read** account list is **empty in any lifecycle state** — conjunctive with the read-state condition already there, and barred from firing on a failed or not-yet-started read | `src/bindings-editor.ts` (`repaintBindingActions`, the `newBinding` line only), predicate owned by `src/bindings-accounts.ts` |
| FR-121 | one worded line **under the list's toolbar**, on its **own handle**, **text** and never the disabled attribute or colour alone, naming Accounts, adding **no control**, **not** the tab's action-note channel, **absent** when the gate does not hold | `src/bindings-accounts.ts` (the string and the mount/repaint/dispose trio), `src/bindings-body.ts`, `src/bindings-ui.ts` |
| FR-122 | the list's empty text becomes a **three-row closed table** — one predicate, *whether the accounts read has succeeded*, three outcomes, three rows — selected at mount and on every repaint; the third row is selected by the **read-success conjunct alone, never `accounts.length`** | `src/bindings-accounts.ts` (`emptyBindingsText`, three constants), `src/bindings-body.ts` (mount), `src/bindings-ui.ts` (repaint) |
| FR-123 | the add form's refusal becomes a **total three-case dispatch**, with FR-121's own constant serving row 1; the picker's placeholder is reworded to a constant that **does not vary by case**, and the field's `disabled` is untouched | `src/bindings-accounts.ts` (`accountSelectionRefusal`, `ACCOUNT_PICKER_PLACEHOLDER`), `src/bindings-draft.ts` (consumes the dispatch), `src/bindings-body.ts` (the placeholder) |
| FR-124 | nothing to build — **recorded** as the scope boundary, including the `usable`-versus-`exists` divergence the block deliberately does not close | this section; the out-of-scope guard in K.7 |
| `005 SC-115` / `005 AC-154` / `005 AC-155` / `005 AC-156` | the fixture matrix (both gate directions, FR-123's refusal cases, the unreadable read), the placeholder's string equality, the **three read-state fixtures** for AC-156 — mounted-at-`idle`, in flight, and failed-after-a-successful-empty-read — and the **two copy scans** with their **three** positive fixtures between them | `tests/bindings-accounts.test.ts` (new), `tests/bundle.test.ts` (one case), `tests/visual-tooling.test.ts` (one case, D26) |

**Not 005's**: the service's `exists`-not-`state` permissiveness (`service/routes/bindings.ts`,
`service/bindings.ts`), which FR-124 records as correct and closed; the account picker's `usable`
filter, which stays as it is; 003's authorization gate; and 006's Settings surface.

## K.2 Module map delta (005's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `src/bindings-accounts.ts` (**new**, leaf) | the seven strings; the gate predicate and its **named read-success conjunct**; the empty-text selector's three branches; the three-case refusal dispatch; the reason line's mount, repaint and disposer | FR-120 – FR-123 |
| `src/bindings-editor.ts` | `repaintBindingActions`: the `newBinding` line's `disabled` gains the gate and **only** the gate. The `add`, `cancel`, `toggle` and `removeSelected` lines are **untouched** | FR-120 |
| `src/bindings-body.ts` | the reason line mounts inside the list block directly after `createToolbar`; `LIST_EMPTY` (line 79) is **deleted** in favour of `emptyBindingsText(rt.state.bindings)` at the `mountList` call (line 184); the picker placeholder (line 212) becomes the imported constant; the reason handle joins the pane and the disposer | FR-121, FR-122, FR-123 |
| `src/bindings-ui.ts` | `BindingsPane` gains **exactly one** member; `repaintBindingsPane` gains **exactly two** lines — the reason repaint, and `emptyText` on the existing `bindingsList.update({ … })` | FR-121, FR-122 |
| `src/bindings-draft.ts` | `ACCOUNT_NOTE` (line 74) is **deleted**; `draftAccount` assigns `accountSelectionRefusal(bindings)` to `bindings.note` | FR-123 |

**Net shape**: one new leaf module and four small edits — the largest, `bindings-ui.ts`, gains one
documented interface member and two call lines (`emptyBindingsText`'s third branch costs no extra
line at either call site: both already call the selector, which is the point of having one). Two
module constants are deleted (`LIST_EMPTY`, `ACCOUNT_NOTE`) and **seven** live in the new module, of
which **two are those same strings carried over verbatim** (`EMPTY_TEXT_WITH_ACCOUNT` is
`LIST_EMPTY`; `PICK_ACCOUNT_REFUSAL` is `ACCOUNT_NOTE`), so the block's genuinely new copy is
**five** strings. Nothing else moves — and specifically **no new read and no new state member**,
because the third row is answered from the read state the panel already holds.

## K.3 Key decisions — the zero-account gate (added 2026-10-05)

> Numbered `D19…D26` to continue this plan's own `D1…D18` series.

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D19** | **The reason line mounts in the list block immediately after `createToolbar(pane)`** — DOM order `status → note → list grid → toolbar → reason → selected-row detail` — as a **wrapper `div` carrying `hidden`** with a `mountText` line inside it, and is reached through **one new `BindingsPane` member** (`newBindingReason`) repainted by one call in `repaintBindingsPane`. The wrapper's `hidden` follows the gate **and** the text is `''` when it does not hold. | "Under the list's control row" is the requirement's own phrase, and `createToolbar` is the row it names; mounting there puts the line beside the control it explains instead of inside an editor the operator cannot open. The wrapper is the codebase's own idiom for a block that comes and goes (`detailBox`, `editorBox`, `agentNoticeBox` — all `div` + `hidden` + a handle), and it needs no SDK capability beyond `mountText`. Setting **both** `hidden` and the text means neither a visual nor a DOM reading of the line can be satisfied by a present-and-blank element, which is what `005 AC-154`'s "absent entirely" asks for. | Mounting it in the editor block (the operator has not been able to open it — the requirement forbids precisely this); writing it to `rt.state.bindings.note` (FR-121's channel rule: that line reports what an action *did*); a node created and removed per repaint (two places to forget — the painter and `bindings-body.ts`'s disposer — against FR-017's one dispose path). |
| **D20** | **The gate reads accounts-read completion from `BindingsTabState.status === 'ready'`.** It is a conjunction, not a length test: `blocked ⇔ status === 'ready' ∧ accounts.length === 0`. **No new state member is added**, and the read-success conjunct is **named as its own intermediate** — one predicate, `accountsRead(bindings)`, that `accountGate` composes and that `emptyBindingsText` (D21) selects on directly. | **`status` already *is* the accounts-read completion flag**: `src/bindings.ts:192` sets it to `'ready'` only when `fetchBindings` **and** `fetchAccounts` both returned a list, and `:171` sets it to `'loading'` before either await. So `'idle'` is not-yet-started, `'loading'` is in flight, `'error'` is a failed read, and none of the three can satisfy the conjunction — which is exactly FR-120's prohibition, satisfied by construction rather than by a guard clause. It also survives the one case a naive `length === 0` gets wrong: `loadBindings` deliberately **keeps** the previous account list when a read fails (`:186–190`), so a failed read after a successful empty one would otherwise fire the gate on stale state. **Naming the conjunct rather than inlining the comparison is what lets FR-122's third row be a *selector* instead of a second guess** — D21 reads one named fact, not a re-derived one. | `accounts.length === 0` alone (fires on `idle`, `loading` and `error` — i.e. presents the absence of an answer as the absence of accounts, and is a fail-open default on a missing fact); a new `accountsRead: boolean` member (a second source for a fact `status` already carries, free to disagree with it); a generation counter or a `lastAccountsReadAt` stamp (a mechanism for a distinction `status` already makes). |
| **D21** | **`bindings-body.ts`'s `LIST_EMPTY` is deleted; `emptyBindingsText(bindings)` in `src/bindings-accounts.ts` is the live value**, handed to `mountList` at mount and to `bindingsList.update({ items, emptyText })` on every repaint. It has **three branches, in this order**, and reuses D20's named intermediate rather than re-deriving the read state:<br>**1.** `accountsRead(bindings) === false` → `EMPTY_TEXT_NOT_KNOWN` — *"No binding yet — the account list is not known. Refresh to read it."* — **regardless of `accounts.length`**<br>**2.** `accountsRead(bindings)` and `accounts.length === 0` → `EMPTY_TEXT_NO_ACCOUNTS`<br>**3.** `accountsRead(bindings)` and `accounts.length ≥ 1` → `EMPTY_TEXT_WITH_ACCOUNT`, the existing `LIST_EMPTY` verbatim | FR-122's table is now **three rows over one predicate** — *whether the accounts read has succeeded* — with three outcomes, and the requirement states the property that makes it worth writing as a table at all: **the gate is a conjunction over that same predicate**, so the row and the control's state are derived from one fact and **cannot disagree**. That guarantee is only real if the selector reads the **same** conjunct D20's gate reads, which is why branch 1 tests `accountsRead` and *not* the length. It is load-bearing in one specific case: a failed read after a successful read of an **empty** list leaves `accounts.length === 0` on the panel's own state (`bindings.ts:186–190`), so a length-keyed selector — the obvious two-line implementation — renders *add an account* over an unanswered read and asserts an absence it never established. FR-122's third row also names only **Refresh**, which FR-120's accounts gate never disables, so the row cannot contradict **that** gate in any of the three branches. **Corrected 2026-10-05**: this line once read *"nothing gates on the accounts read"*, which Phase 6 disproved — Refresh is gated by the **in-flight read window** (`status === 'loading'`), so the row's advice is momentarily unavailable while a read is loading. That overlap is **accepted and bounded** (005 clarification row 61, `005 AC-157` asserts `Refresh.disabled === (status === 'loading')`); the string is unchanged and Refresh is deliberately **not** ungated, which would be a read-behaviour change belonging to its own requirement. `ListHandle.update` already accepts `emptyText` in this codebase (`dispatches-ui.ts:419`), so this needs no SDK capability and no new handle. | A **length-keyed** selector — `accounts.length === 0 ? NO_ACCOUNTS : WITH_ACCOUNT`, with no read-state branch (renders *add an account* over a stale-empty failed read; it is the trap this ruling closed, and §K.5 item 1's reasoning is why); gating on `!accounts.some(usable)` (the widening FR-120 forbids by name, and it would also make branch 2 and the service's `exists` rule disagree); keeping the `const` and branching at the two call sites (two derivations of one fact — the drift FR-122 exists to prevent); rendering the third row as a separate element above the list (the empty text is the list's own `emptyText` prop, and a second copy would render twice); swapping the string by re-mounting the list (loses the list's handle identity for a copy decision). |
| **D22** | **All three refusals dispatch from `accountSelectionRefusal(bindings): string`** in `src/bindings-accounts.ts` — a total three-case `if`, ordered *none exist → some `usable` → otherwise* — and **`ACCOUNT_REQUIRED_REASON` is one exported constant used both by the toolbar line (FR-121) and by case 1**. `bindings-draft.ts` assigns the result to `bindings.note`; the tab's note channel stays exactly where the operator is when they press *Add binding*. | FR-123 makes the table **total**, so a dispatch is the only shape that cannot grow a fourth, unwritten case: a case the requirement does not have would have to be added to the `if` before it could render, and `005 AC-154`'s fixtures assert all three. Sharing case 1's **constant** — rather than re-spelling it — is FR-123's own instruction and FR-091's one-rendering intent made structural. The refusal stays on `note` because FR-121 reserves the toolbar line for the gate and FR-123 says the refusal stays put. | One constant per case written into `draftAccount` (three spellings in a reader that is about reading a draft, and a copy block that drifts); deriving the refusal from the picker view's `disabled` (a second implementation of the `usable` predicate, in the one place FR-062's `usable` already answers it); a new `note` sub-channel (the requirement names the existing one, and a second note line is a second thing to keep in step). |
| **D23** | **The new surface is a new leaf module, `src/bindings-accounts.ts`**, composed by `bindings-body.ts` (mount), `bindings-ui.ts` (repaint), `bindings-editor.ts` (the button's `disabled`) and `bindings-draft.ts` (the refusal) — the shape `bindings-actors.ts` and `bindings-prompt.ts` already have, and D13's reasoning applied again. | `bindings-body.ts` is 478 lines and its own header records that it was split out **because the mount had outgrown the file-length cap**; adding a mount, a handle, a disposer and a second derived string to it is the thing the split exists to prevent. `bindings-editor.ts` is the editor's **derived field views** — and its header is explicit that it absorbed the worktree view only *because* `bindings-ui.ts` is at its cap, i.e. by file-length necessity rather than by responsibility; a **list-level** control predicate and its copy are not an editor field view. `bindings-draft.ts` must **consume** the refusal, not own the strings, or D22's single dispatch is two dispatches. The name follows the two precedents: the module is named for the thing it owns (the tab's **accounts** side), which also puts it inside `tests/bindings-ui.test.ts`'s existing `src/bindings*` vocabulary sweep with no change to that sweep. | `src/bindings-gate.ts` — **rejected on a real collision**: "gate" in this repository means the **dispatch authorization** gate (`src/relay-gates.ts`, 003's actor gate, `tests/bindings-gate-serialization.test.ts`), and a second gate with a different meaning under a `bindings-` prefix would be read as the other one; adding to `bindings-body.ts` (D23's first clause); a `bindings-editor.ts` helper (blurs a derived-views module with a control gate). |
| **D24** | **The placeholder becomes the imported constant `ACCOUNT_PICKER_PLACEHOLDER` in place**, inside `mountAccountSelect` — **not** a repaint-path value and **not** a conditional. The field's `disabled` next to it is untouched. | `005 AC-155` requires the same string in all three states and calls the fix "a reword and **not** a conditional"; the repaint path for the picker (`bindings-ui.ts:181`) never carried a placeholder even before this amendment, so a conditional would mean *adding* a repaint channel to express a case the requirement says does not exist. Keeping `disabled` as it is implements FR-123's "wording, never its presence" with no edit at all. | A conditional placeholder (a fourth string the requirement forbids, and one that would make the field's hint and the refusal name different states again); also adding the placeholder to `accountFieldView` (that view is a pure projection of state consumed by two call sites, and the placeholder is a mount-time constant). |
| **D25** | **Two copy scans — and now three positive fixtures between them** — plus a **bundle** case. The **state-keyed** scan runs over the empty text in every read state and forbids the withdrawn instruction; its positive fixtures are **two**: AC-154's **one-account** fixture, whose second-row text *does* contain `select New binding`, and **AC-156's mounted-at-`idle`** fixture — the state the third row governs, and the one in which, before this ruling, the empty text *did* carry it. The **phrase-keyed** scan is AC-155's alone: it forbids the **string** `Select a verified account`, scoped to the Bindings surfaces, and its positive fixture is an **Accounts-tab** account whose `verifiedAt` row still renders. The bundle case asserts the shipped `panel/main.js` carries `Select an active account` and **not** `Select a verified account`. | AC-154 asks for a scan **over the strings this block governs** in the state being rendered and names the one-account fixture; AC-156 asks for the same claim about the third row and names **its own** positive fixture — and the two are different states, because the withdrawn instruction appeared in two different states before the fix. One matcher over the empty text with **two** positive fixtures discharges both without either criterion's fixture being made to do the other's work. Running it against **mounted props** (the mount-journal shape `tests/bindings-actors.test.ts` uses, which the new suite copies as that suite copied its own helpers) rather than the source is what makes the claim true — a string can sit in the source and never reach the DOM. AC-155's scan stays **separate and stays a phrase match**: merging it with the state-keyed one would make the Accounts-tab `verifiedAt` fixture prove a claim about the empty text, and widening *it* to the word *verified* would forbid FR-062's correct, required row — which is why AC-156's *"This criterion's scan is … separate from `005 AC-155`'s"* is a requirement and not a style note. | One merged scan (the two scopes differ — state-keyed over the empty text, phrase-keyed over the placeholder — and merging makes each fixture prove the other's claim); three scans where the state-keyed one would do (a scan per row would fragment one property into three, and the point is that **one** predicate governs all three); a source-only scan (cannot see what rendered, and would pass on a string the mount never paints); asserting absence by `expect(strings).not.toContain(…)` with no positive fixture (passes vacuously the moment the branch disappears, which is how this defect survived). |
| **D26** | **One bounded tooling change: `tools/visual/shot.js` gains `--scene <name>`**, backed by a `scenes` delta in `fixtures.json` merged over the base document by `fixtures.js`. A scene run captures **one** tab at the two widths and writes `panel-<tab>-<scene>.png` / `-narrow.png`, **reusing that tab's existing wide/narrow sentinel colours** so no probe colour, index, or diff rule changes. `no-accounts` sets `accounts: { accounts: [] }`. | The changelog records that a **screenshot** found the v1.14.0 defect this branch exists to end, and the default fixture has two accounts **and a binding** — so under the shipped fixture **none** of FR-122's three rows renders at all: the empty text is invisible (there is a binding) and the reason line is correctly absent. Without a scene, the visual check can only prove the correction did **not** leak into the live-control case; with it, `no-accounts` is the frame in which the **reason line** appears over a full list — `idle` at mount, before the fixture's answers land, is **not** capturable, and an empty-text row needs `no-accounts-no-bindings` — so the scenes cover what the default capture never reaches: the **reason line over a full list** (`no-accounts`) and an **empty-text row** (`no-accounts-no-bindings`). The **third** row is covered by `005 AC-156`'s read-state fixtures instead, because `idle` resolves before any capture is taken. Reusing the tab's own colours and distinct filenames keeps `AGENTS.md`'s "every image is decoded and proven current" machinery untouched: a scene run is its own process, so the per-width freshness chain starts empty and `verifyDelivered` refuses any frame carrying a probe colour. | Adding a whole second fixture document and a per-scene capture step with new sentinel colours (changes the 14-colour budget and its index arithmetic — the machinery AGENTS.md documents as proof); asserting the new copy only from tests and skipping the visual gate entirely (leaves an 80-character sentence's wrapping at 560px unverified, on the tab the rail shows first); editing `fixtures.json`'s accounts to empty by default (breaks the Accounts and Status captures that the six-tab sweep depends on). |
### The one predicate, three rows: the gate and the empty text together

FR-122's **consistency rule** is that all three rows are selected by *one* predicate — **whether the
accounts read has succeeded** — and that the gate is a **conjunction over that same predicate**, so
the row and the control's state derive from one fact and cannot disagree. This table is that claim,
and it is what `005 AC-154` (both gate directions), `005 AC-156` (all three read states) and the
state-keyed scan in D25 assert, row by row. **The first row is the state in which the withdrawn
instruction used to render** — the mounted-at-`idle` frame AC-156 names as its **positive** fixture —
while AC-154's one-account fixture is the positive one for the retained third row; that is why D25
carries two positive fixtures for one matcher.

| Predicate: the accounts read… | `accounts.length` | Gate (FR-120) | *New binding* | FR-121's line | FR-122's row | Read states |
| --- | --- | --- | --- | --- | --- | --- |
| has **not** succeeded | **any** — `0`, stale `0`, or `≥ 1` | cannot hold — barred by name | disabled, by the read-state condition | **absent** | `No binding yet — the account list is not known. Refresh to read it.` | `idle`, `loading`, `error` (incl. failed-after-successful-empty) |
| has succeeded | `0` | **holds** | disabled | **present** | `No binding yet — add an account on the Accounts tab first.` | `ready` + empty |
| has succeeded | `≥ 1` | does not hold | **enabled** | absent | `No binding yet — select New binding to add one, or refresh.` | `ready` + accounts |

Read the *New binding* column top to bottom and the property is visible without prose: **whenever
*New binding* is disabled, the text names *Refresh* or the Accounts tab and never *New binding*;
whenever the text names *New binding*, the read succeeded with at least one account and the control
is live.** That is FR-122's requirement stated as a consequence of the selector's *shape*, which is
why D21 reads D20's named conjunct rather than re-deriving `status` or branching on length — the
guarantee is structural, not a promise a review has to keep re-making.

The non-empty list renders its rows and **none** of these three strings appears (FR-122's own scope
rule).

### The three refusals, as a truth table

| `accounts` | `usable` accounts | `accountSelectionRefusal` | Picker |
| --- | --- | --- | --- |
| `0` | — | `Add an account on the Accounts tab before binding a repository.` — **`ACCOUNT_REQUIRED_REASON`, the same constant FR-121 paints** | empty, disabled, placeholder `Select an active account` |
| `≥ 1` | `0` | `No active account — fix or replace an account on the Accounts tab.` | empty, disabled, same placeholder |
| `≥ 1` | `≥ 1` | `Pick the account this repository polls under.` — unchanged, and actionable | populated, enabled |

**Two consequences recorded rather than smoothed over.** `draftAccount` first looks the selection
up by id, so a **stale** selection (an account removed while the form was open) reaches the refusal
with `accounts.length ≥ 1`. It lands in the second row when nothing is `usable` — honest, since
there is nothing to pick — and in the third row when something is — also honest, because there
*is* something to pick and the operator re-picks. FR-123's table is closed and total over
"no account is selected", which is the state the refusal is about; the stale-selection path is a
different question the same sentence answers truthfully, so no fourth case is invented.

**The third row does not make FR-123's first row reachable pre-read**, which is worth stating
because it is the one place the new branch could have looked like a second refusal path. In all
three pre-read states the editor's own *Add binding* is disabled by the same read-state condition,
so no submission reaches `draftAccount` at all. FR-123 row 1 therefore stays reachable **only** where
it always was — the gate holds (`ready` + empty) and the editor was already open — and D22's three
cases and `ACCOUNT_REQUIRED_REASON`'s two positions are unaffected by the third row.

## K.4 Constitution alignment (v1.3.0) — carried forward, re-read for this amendment

> The v1.11.0 and v1.14.0 entries record the same review. **Three principles bear directly on this
> amendment and one of them is the reason FR-120 has the shape it has.**

| Principle / gate | How this amendment satisfies it |
| --- | --- |
| **II. Safe autonomy by default** | **The principle this amendment serves most sharply, and the one the owner's ruling on the third row turns on.** Its text — *"a missing, stale, or ambiguous authorization is a stop condition, not permission to guess"* — is why the gate keys on **accounts at all** rather than on `usable`: the service deliberately accepts a binding against an account that merely **exists**, because a binding is meant to outlive its account's health, and a panel that forbade it would convert that considered permissiveness into a prohibition on the account state the service treats as most reusable. The same principle is why the gate is a **conjunction over a read-state fact and a list-length fact** (D20) **and why FR-122's third row exists rather than a pre-read gate**: an account list the panel could not read is *missing evidence*, and rendering *there are no accounts* over it would be the guess II names — so where the gate cannot be evaluated, the **copy** states the absence of knowledge instead and the gate stays silent. The refusal copy obeys the same law — with accounts present and none `active`, the panel says what must be **fixed**, and never asks for a choice it cannot offer. |
| **IV. Human-visible auditability** | The reason is **text**, never the disabled attribute or colour alone, because *"operators must be able to explain why"* an action is unavailable — FR-083's rule, now applied to the control rather than to a row. The third row extends the same obligation to the frame where **no** explanation can be given: it says *the account list is not known* and names *Refresh*, which is the truthful answer, and it keeps each string in its own channel so the failed read's cause and retry are reported once, by the channel that owns them (FR-019, FR-121). The refusal names the remediation instead of echoing a submitted value (FR-085), and the note channel it uses is the one that already reports what an action did. |
| **VI. Specification and verification before implementation** | Why this is **five** requirements (`FR-120` – `FR-124`), **one** success criterion (`005 SC-115`), **three** acceptance criteria (`005 AC-154` – `005 AC-156`), **five** clarification rows (**49 – 53**), **two** copy scans with **three** positive fixtures, and the truth table above — rather than a copy ticket. AC-154 asserts **both** gate directions and the unreadable read, because a suite holding only the zero-account fixture cannot distinguish a gate from a constant; **AC-156 asserts the pre-read frame's three states, and asserts FR-120's bar and the copy's truthfulness in the same breath** so neither can be satisfied by a change that breaks the other; D25's fixtures are what stop a scan from passing vacuously. **The strongest evidence that the property is real and not promised is structural**: the third row exists *because* the gate and the row share one predicate, so the property is a consequence of the selector's shape and a test asserts it rather than a review promising it. |
| **I. Contract-first** | Served by touching no contract: no wire member, route, status or error code, or stored document moves (FR-124), and `specs/005-panel-ia/contracts/` has nothing to record — this is rendered copy and one control's `disabled` state, neither of which crosses a boundary. |
| **III. Durable and idempotent work** | Untouched: a disabled control and rendered strings are display state and create no work, no checkpoint, and no retry. |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, permission, or SDK re-pin; no new route. |
| **VII. Thin orchestration boundary** | Satisfied and, if anything, tightened: the copy **names** the Accounts tab and deliberately **adds no control** to reach it (FR-010: one route to a capability), so no host call, no host API, and no second path is introduced. |
| **Quality gates** | Strict TS + lint, zero `any`, zero suppressions (invariant 7); the new module is a **leaf** importing only the SDK and types, so no cycle is introduced; `npm run verify` before every commit; committed bundles rebuilt with every source change (invariant 1). |

**`AGENTS.md` invariants — how this amendment touches the ten.** (1) **committed bundles ship**:
every wave that touches `src/` ends with `npm run build`, which regenerates **both** committed
bundles — `panel/main.js` (IIFE) and `service/main.js` (ESM) — and **both ship in the same commit as
their sources**. No `service/*.ts` changes here, so the service bundle's rebuild is expected to be
**byte-identical**, which is itself the check that no service code moved (invariant 1 names both,
and `npm run verify` runs the build first). (2) **no `version` bump** — a bump is a product-owner
release decision. (3) `capabilities[]` untouched, `contributes.service` gains no `permissions`.
(4) kebab-case identity and every `mecha-turk:` key untouched — the reason is derived, never stored
(FR-025). (5) `SERVICE_VERSION` untouched. (6) SDK pin `1.24.2` untouched, **no re-pin**; the only
SDK calls added are `mountText` and an `emptyText` member on an `update`, both already in use in
this codebase. (7) **zero suppressions, zero `any`** — the gate is a predicate over two typed
members and needs no cast. (8) **fail closed** — **this is the invariant FR-120's prohibition
exists to serve**: settings, bindings, event rows and service DTOs in this product parse through
validators that refuse malformed input rather than partially applying it, and a **failed or
not-yet-started account read is exactly that case**. Treating "I could not read the accounts" as
"there are no accounts" would apply a **fail-open default to a missing fact** and would do it on
the control that creates work; D20 makes the read state a conjunct of the gate, so the tab's
existing failed-read channel (its own cause and a retry, FR-019) is the only thing that can render
in that state. **FR-122's third row is this same invariant applied to copy instead of to a control**:
where the read has not succeeded, the honest statement is an absence of *knowledge*, and the
sentence says exactly that rather than borrowing the gate's wording — which is also why it **does
not restate** the failed read's cause or retry (FR-121's channel rule keeps every string in its own
channel). (9) secrets never leave the service store — no credential member exists on anything
this renders, and the new strings name no account. (10) **`extension-spike-1` untouched** — the
Diagnostics record keeps reading the evidence schema version and nothing here touches it.

## K.5 Flagged items (Phase-4 findings — decided at the gate, recorded here)

1. **The pre-read and post-failure frames showed the unchanged empty text while the control was
   disabled in them — RESOLVED BY RULING 2026-10-05** (`## Clarifications` row 60, `005 AC-156`, and
   the replacement `### Edge Cases` bullets): answered **in copy, never by starting the gate early**.
   Struck as *open*, kept as *reasoning* — the reasoning is **load-bearing** and is why D21's branch 1
   is keyed the way it is.
   - **The finding as raised.** At mount (`status === 'idle'`), while a read is in flight, and after
     a **failed** read — including one that followed a successful read of an empty list — FR-120 bars
     the gate, so the empty text fell through to the *unchanged* row, which names *New binding*
     while the read-state condition has that button disabled. Under the two-row table that was
     implementable exactly as specified, and it was raised rather than left for Phase 6 to choose
     quietly.
   - **What the owner chose.** **Fix (a): a third row in FR-122's closed table, selected by whether
     the accounts read has succeeded.** `No binding yet — the account list is not known. Refresh to
     read it.` It states an absence of **knowledge** rather than of accounts, names only *Refresh* —
     which FR-120's accounts gate never disables; its momentary unavailability during an in-flight
     read is the separate overlap **accepted and bounded** at 005 clarification row 61 — and **FR-120's bar is explicitly not weakened** — the     gate does not start firing; the copy starts telling the truth. Implemented as D21 branch 1 and
     asserted by `005 AC-156` in all three read states.
   - **Why the finding's reasoning had to survive the ruling.** Fix (b) — letting the gate fire
     before the read succeeded — was **rejected**, and this is the evidence that made it
     rejectable: `loadBindings` **deliberately retains the previous accounts list** when a read fails
     (`src/bindings.ts:186–190`), so a failed read after a successful read of an **empty** list
     leaves `accounts.length === 0` on the panel's own state. A pre-read gate, and equally a
     length-keyed selector, would tell an operator with a **broken service** that they have no
     accounts — asserting an absence from evidence that has not arrived, which is the guess
     constitution **II** names and FR-120 bars by name. That single fact is now stated in FR-122's
     own text as load-bearing, and it is why D21 branch 1 tests the **read-success conjunct alone**
     and never `accounts.length`. **A reader who later "simplifies" the selector to a length test
     reintroduces the defect the ruling closed**, which is why this paragraph stays.
2. **The stale-selection path reaches the refusal with accounts present** (K.3's second table). Both
   landing rows read truthfully; recorded so that a future reader does not mistake it for an
   unhandled fourth case. **Unmoved by the third row** — it concerns `draftAccount`'s lookup and
   FR-123's table, neither of which the empty text touches — and K.3 now also records that in all
   three pre-read states *Add binding* is disabled, so the third row creates **no** new path to a
   refusal.
3. **`005 AC-155`'s scan scope is a phrase, and the plan fixes its scope to the Bindings surfaces.**
   The spec requires the scope to be "stated explicitly" and the scan to be non-vacuous against an
   Accounts-tab `verifiedAt` row; D25 implements both. If a later feature puts the withdrawn
   phrase on a *third* tab, this suite will not catch it — accepted deliberately, because widening
   it to the word *verified* would forbid FR-062's correct row. A future panel-wide sweep is a
   vocabulary-suite concern (`tests/vocabulary.test.ts`), not this block's. **Unmoved, and
   deliberately kept unmoved by AC-156**, which states in its own text that its state-keyed scan is
   *separate* from AC-155's and that the string-not-word distinction is "undisturbed".

## K.6 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| The gate fires on an unread account list and tells an operator with a broken service that they have no accounts | D20's conjunction over `status === 'ready'`; AC-154's unreadable-read fixture; **AC-156 asserts the gate does not fire in all three pre-read states**, and the *stale list after a failed read* case is asserted too (it is the one a naive `length === 0` gets wrong, in the gate and in the selector alike) |
| **A length-keyed selector** renders the *add an account* row over a stale-empty failed read — the trap the owner's ruling closed, reintroduced by simplification | D21 branch 1 tests `accountsRead(bindings)` and **never** `accounts.length`; the selector reuses D20's **named intermediate** rather than re-deriving `status`; the stale case is an explicit AC-156 fixture; K.5 item 1 keeps the reasoning on the page |
| The third row's sentence implies an absence of accounts, or restates the failed read's own cause | asserted by **string equality** on the exact spec wording, and the state-keyed scan forbids **both** the withdrawn instruction and any *account-count claim* in it (`No accounts`, `0 accounts`, `none`); the failed read's cause and retry stay in the action-note channel (FR-019, FR-121's channel rule) and are asserted **separately**, so neither string is ever judged against the other's obligation |
| The corrected empty text leaks into the case where *New binding* is live — the failure FR-122's retained row exists to prevent | one selector, all three rows asserted; AC-154's one-account fixture asserts the **unchanged** string **and** the reason line's absence |
| The three refusal strings drift, and the toolbar line and the first refusal case become two spellings of one reason | D22: one dispatch, one exported constant for case 1; all three asserted from the same function; K.3 records that the third row adds no fourth path |
| The reason line becomes a standing nag in a state it has nothing to say about | `hidden` **and** empty text when the gate does not hold; asserted in the one-account and two-non-`active` fixtures **and in all three of AC-156's pre-read states**, and asserted **absent** — not blank |
| The scan passes vacuously once the offending branch leaves the suite | D25's three positive fixtures: the one-account empty text **does** contain `select New binding`, the **mounted-at-`idle`** fixture is the same state in which the pre-fix code rendered it, and an Accounts-tab row **does** render a last-verified stamp |
| The two scans get merged, and AC-155's phrase scope widens into a ban on the word *verified* | D25 keeps them separate by construction and says why; AC-156's own text repeats the requirement; a merge or a widened scope fails AC-155's Accounts-tab `verifiedAt` fixture |
| The change to the shipped artifact goes unverified because the default fixture never renders a governed string | `tests/bundle.test.ts` gains a case over the committed `panel/main.js`, now covering **all three** empty-text rows' worth of behaviour through the placeholder and the reason line; D26's scenes make the reason line capturable at 720px and 560px. **Corrected 2026-10-05 after Phase 6 disproved this row's own premise**: it previously claimed the `no-accounts` scene was *"the only screenshot in which any empty-text row renders at all, since the default fixture carries a binding"*. That holds only of a window **no capture can photograph** — `no-accounts` empties `accounts` alone, so the fixture's three bindings still render, and a capture is taken after boot, by which point `status` is `ready` and the *not-known* row is gone. What the scenes actually photograph is: `no-accounts` → the **reason line over a full list**, which is the frame the gate belongs in; `no-accounts-no-bindings` → an **empty list beside the same reason line**, rendering `No binding yet — add an account on the Accounts tab first.`, which is the **only** way an empty-text row reaches a camera. **Keep the reasoning, or the second scene gets deleted**: a reader who trusts the old premise sees `no-accounts` as already covering the empty-text row and removes the scene that uniquely provides it. A premise no capture can test is not evidence, and the empty-text rows are copy this amendment governs || The new module is read as the dispatch authorization gate | D23's name (`bindings-accounts`) and the recorded collision with `src/relay-gates.ts` / `tests/bindings-gate-serialization.test.ts` |

## K.7 Out-of-scope guard for the issue-#18 block (checked at every task)

No service, route, wire member, status or error code, stored document, `host.storage` key, or
contract change (FR-124). No change to `PUT /v1/bindings`' validation, to `hasAccount`, or to the
`usable`-versus-`exists` divergence — that divergence is **recorded as a decision, not a backlog
item** (FR-124, clarification row 59). No gate on the editor's *Add binding*, *Cancel*, *Toggle* or
*Remove* controls: `newBinding` alone changes, and gating `add` as well would make FR-123's first
refusal case unreachable and strand an already-open editor. **No gate that fires before the accounts
read has succeeded, and no gate keyed on `usable`** — FR-120's bar is untouched, and FR-122's third
row was chosen *because* the frame is answered in copy rather than by starting the gate early
(clarification row 60); a pre-read gate is out of scope by name, not merely by omission. **No fourth
empty-text row**: FR-122's three rows partition one predicate with three outcomes, so a state that
fits none is a **new predicate**, which is a spec amendment rather than a task. No navigation
control, link, or button to the Accounts tab from anywhere (FR-010, FR-039) — *Refresh* is named in
the third row and is already on the toolbar. No use of `rt.state.bindings.note` for the reason, and
no restating of the failed read's cause or retry inside the empty text (FR-019, FR-121's channel
rule). No new tab, no change to the six-tab shell, no `activeTab` persistence. No new state member
on `BindingsTabState`, and **no second read** — the third row is answered from the read state the
panel already holds. No version bump, no capability, no permission, no SDK re-pin, no storage key, no
prompt or allow-list behaviour (004's and 002's fields are untouched). No account-state vocabulary
change — *active* is already one of FR-062's six values, and no seventh word is introduced for it.

## K.8 Phase-6 task block for this amendment

Phase 5 has written the execution list: [`tasks.md` §"Issue #18 block
(2026-10-05)"](./tasks.md), task ids **`K-1 … K-12`**, in four waves.

| Task | Covers | Acceptance criteria |
| --- | --- | --- |
| `K-1` | `npm ci` — the toolchain install; **`node_modules` is absent in this worktree**, so every gate below needs it first | — (prerequisite for all) |
| `K-2` | the new leaf `src/bindings-accounts.ts`: the seven strings, `accountsRead`, `accountGate`, `emptyBindingsText`'s **three** branches, `accountSelectionRefusal` — pure, no DOM | `005 AC-154`, `005 AC-156` |
| `K-3` | **the single-named-predicate assertion** — FR-122's consistency rule as a source scan with named exemptions | `005 AC-156`, FR-120, clarification row 60 |
| `K-4` | the mounted half of the same module: the reason line's wrapper, mount, repaint and disposer (D19) | `005 AC-154` (the line present **and** absent) |
| `K-5` | the mount in `bindings-body.ts`, the pane member and repaint in `bindings-ui.ts`, and `emptyText` on **both** paths (D19, D21) | `005 AC-154`, `005 AC-156`, `005 SC-115` |
| `K-6` | `repaintBindingActions`' `newBinding` line (FR-120's gate, conjunctive, no pre-read fire, the read-state conjunct read through **D20's named `accountsRead`** rather than a second literal `status` test — **corrected 2026-10-05**, the line first shipped as a literal and K-3's scan is scoped to the accounts module, so it could not see it) | `005 AC-154`, `005 AC-156` |
| `K-7` | `bindings-draft.ts`'s refusal dispatch (D22) | `005 AC-154` (both refusal cases) |
| `K-8` | the picker placeholder, reworded in place and **not** made conditional (D24) | `005 AC-155` |
| `K-9` | the fixture matrix — zero / one / two-non-`active` / one-`active`-unselected / unreadable, **plus AC-156's three read states** (mounted-at-`idle`, in flight, failed-after-a-successful-empty-read) — the **two** copy scans with their **three** positive fixtures, and the `tests/bundle.test.ts` case | `005 AC-154`, `005 AC-155`, `005 AC-156` |
| `K-10` | D26's `--scene` plus `tests/visual-tooling.test.ts` | D26 |
| `K-11` | `npm run shot` at 720px and 560px — the default fixture (the correction did **not** leak into the live-control case), the `no-accounts` scene (**the reason line over a full list**), and the `no-accounts-no-bindings` scene (**the frame in which an empty-text row renders at all**, and therefore the visual evidence for the row this amendment governs). **Corrected 2026-10-05**: this row previously called `no-accounts` *"the frame in which the **third row** becomes visible at all (`idle` at mount, before the fixture's answers land)"*, which holds only of a window no capture can photograph — a capture is taken after boot, so `status` is `ready` and the *not-known* row is gone. The third row's truth is asserted by `005 AC-156`'s read-state fixtures instead, and the **second** scene, not `no-accounts`, is what puts an empty-text row on screen | `005 SC-115`, `005 AC-156`, AC-139 |
| `K-12` | `npm run verify` + `npm run build`, **both** bundles committed with their sources, and the **byte-identical `service/main.js`** as the proof no service code moved | AC-139 (invariant 1), FR-124 |
Ordering constraints Phase 5 must honour: **`K-1` precedes every other task** — four modules import
the new leaf and none of them compiles without it; **`K-2` precedes `K-3` – `K-12`**, because every
later task consumes the module; **`K-3` precedes `K-5` and `K-6`**, since it is what pins the one
predicate both of them call; and **`K-9` – `K-11` follow `K-5` – `K-8`**, because their fixtures and
captures assert the gate, the line, the selector, the refusal, and the placeholder those tasks make
live. **No task in this block is `[P]`**: the three waves share `src/bindings-accounts.ts` and one
test file, so every pair has a file or a fixture in common, and marking parallelism here would
produce merge-shaped work rather than parallelism. The **only** genuinely independent work is the
visual tooling (`K-10`), and it is worth nothing until the panel renders the strings (`K-5` – `K-8`),
so it is sequenced rather than parallelised.
