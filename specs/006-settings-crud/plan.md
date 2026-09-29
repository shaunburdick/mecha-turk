# Implementation Plan: Settings — Full Service Configuration CRUD

**Branch**: `full-project-plan` (spec + plan artifacts; implementation moves to `006-settings-crud` per `AGENTS.md` git conventions) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md) (v1.3.0, APPROVED — the source of truth; FR/AC numbers below are quoted exactly as written and cross-spec references are always prefixed)

**Input**: Feature specification `specs/006-settings-crud/spec.md` (v1.3.0); predecessors `specs/002-agent-event-extension/{spec,plan,tasks,contracts}` (v1.7.0), `specs/003-dispatch-integrity/{spec,plan,tasks,contracts,data-model}` (v1.3.0), `specs/004-starting-prompt/*` (v1.1.0), `specs/005-panel-ia/{spec,plan,tasks,contracts,data-model,research}` (v1.3.0); constitution `.specify/memory/constitution.md` (v1.3.0); repo directives `AGENTS.md`; scope source `specs/003-dispatch-integrity/pm-handoff.md` §Feature Roadmap row 4 + §Product-owner decisions 2; and the shipped code itself (read for this plan: `service/{config,env,log,main,server,audit,http}.ts`, `service/routes/{config,index,accounts,types}.ts`, `service/poll/{timer,loop,scan,poller-github,events,events-parse,events-write,triggers}.ts`, `service/store/{index,json,ndjson,dir}.ts`, `src/{service-calls,config,agent-verify,relay,redaction}.ts`, `tests/support/*`, `tests/{service-config,service-audit,service-events,service-scan-state,settings-rows,manifest,bundle}.test.ts`, `.gitignore`, `.env.example`, `package.json`).

**Note**: No application code is written in Phases 4–5. Every design decision below is decided and justified; the genuinely open questions this feature raises are in [research.md](./research.md).

## Summary

006 turns 005's read-only Settings tab into the product's **single, honest configuration surface**: eleven fields (thirteen once 003's two land) become editable inside the rows 005 already renders, the service widens **one read** so the panel labels every field from the service's own declaration, and — because the owner's gate answer chose *wire all fields* — **five configuration readers** are added to the service so that every declared take-effect class is a delivered behaviour rather than a label.

Technical approach in one line each:

- **One declaration, read twice** (`service/config.ts`): the bounds table, the level set, the default document, the new `expectedAgent` string rule, and a new `TAKE_EFFECT` class table stay in the module the validator already reads; `GET /v1/config` answers `{ config, fields, source, defaultsApplied }` where `fields` is a **projection** of that same declaration, so a bound cannot move in one place and not the other (FR-020–FR-022).
- **Five consumers, one read per cycle** (`service/poll/`): `runScanCycle` reads the stored configuration **once** at the cycle boundary and threads it to the scan window (`lastScanAt − overlapMs`), the list request (`per_page = perPage`), the bounded jittered backoff (`retry*`), and both trim passes — which is what makes nine fields `next-cycle` with a single, observable read (FR-055, FR-057–FR-059).
- **Two trim passes** (`service/audit-trim.ts`, `service/poll/excerpt-trim.ts`): oldest-first over `audit.ndjson` honouring FR-056's protected set and never renumbering `seq`; payload-text-only over `events.json` terminal rows with a round-trip marker; each appends one `audit.trimmed` row **only when it removed something** (FR-053, FR-073).
- **`logLevel` is `immediate`** (`service/log.ts`, `service/server.ts`, `service/routes/config.ts`): the captured threshold becomes adoptable — once the store opens, and again on an accepted `PUT` with no restart (FR-033, gate answer 3).
- **One save, whole document, audited** (`src/settings-edit.ts`, `src/settings-tab.ts`, `src/service-calls.ts`): a draft built from the last read, one `PUT /v1/config`, the service's own issues rendered verbatim, one `config.changed` row per changed write and per refusal, and a two-step confirmation that states what a lowered retention limit will delete, when, and what survives (FR-040–FR-052, FR-070–FR-074).
- **Configuration authority stated, not implied** (block J): `.env.example` deleted, `.gitignore`'s `!.env.example` negation dropped, no `MECHA_TURK_*` survives, one operator input per field (FR-090–FR-092).

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` (`AGENTS.md` invariant 7) |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` and **committed** (invariant 1) |
| Panel UI primitives | `@openchamber/sdk/ui` — the six-tab shell, rows, buttons, inputs, banners 005 already mounts; SDK pinned `1.24.2` exact (invariant 6), **no re-pin** |
| Service runtime | Node ESM, host-spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE`; `service/main.js` built with `bunx openchamber-guest-bundle --node` and **committed** (invariant 1) |
| Service dependencies | Node stdlib only — no framework, no native modules (006 adds no dependency; the backoff uses `setTimeout`, not a library) |
| Storage (service tier) | JSON + append-only NDJSON under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+fsync+rename). **006 adds no store file**; it rewrites two existing ones (`config.json` on `PUT`, `audit.ndjson` + `events.json` inside a trim pass) and adds one `ServiceStore` method (`writeLines`) that is the NDJSON sibling of the existing atomic `writeJson` |
| Storage (panel tier) | `host.storage` (64 KiB/value, 2 MiB namespace, uninstall-wiped). **006 adds no key and renames no key** (FR-005): the in-progress edit is panel memory in the mounted Settings body, never durable state |
| Testing | vitest `5.0.2`, fully offline: fake host (`tests/support/panel.ts`), DOM helpers (`tests/support/{dom,ui-stubs}.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`). **Injected clock** for backoff/cycle/trim timing, **seeded `audit.ndjson` / `events.json` fixtures** for the trim passes, **captured log sink** for `logLevel`. No live OpenChamber, no PAT, no network (FR-086, `AGENTS.md` testing philosophy) |
| Target platform | OpenChamber desktop and web only (unchanged) |
| Scale | <10 bound repositories, a handful of accounts, one logical service instance, one operator machine; audit trail bounded at `auditMaxEntries` (default 50,000) once FR-055 lands |
| Version | `0.0.1` — **no bump** (invariant 2, FR-087); `SERVICE_VERSION` stays pinned to `package.json` by `tests/service-server.test.ts` (invariant 5) |

### Baseline: which tree this plan is written against

006's spec lists 002 (v1.7.0), 003 (v1.3.0), and 005 (v1.3.0) as **Dependencies** (`spec.md` header), and 003's roadmap sequences Phase 6 as **003 → 004 → 005 → 006**. This plan is therefore written against the tree **as it will be after 003's, 004's, and 005's Phase 6 complete**, and its "already built" section names what each contributes:

| Source | What it contributes that 006 consumes and must not rebuild |
| --- | --- |
| 002 (shipped, live-validated) | loopback transport/auth/body caps, account custody, bindings store, polling/triggers/scan-state, store mechanics (`0700`/`0600`, quarantine), the audit writer's `seq`/redaction chain, `service/config.ts`'s validator and `NUMERIC_BOUNDS`, `GET`/`PUT /v1/config` semantics, `GET /v1/health`, the reserved audit names `config.changed` and `audit.trimmed` |
| 003 (its plan/tasks complete, Phase 6 a prerequisite) | run model + `runs.json`, the 16-row dispatch-lifecycle vocabulary + `dispatch.refused`, correlation discipline (003 FR-052), **`leaseMs` + `resultDeadlineMs` config fields** (30,000–600,000 ms, default 120,000 — 003 plan D9/C14, tasks T-008), frozen legacy delivery rows as migration input, `GET /v1/audit`, `auditWritten: false` surfaced on audit failure (003 FR-063) |
| 004 (its plan/tasks complete, Phase 6 a prerequisite) | `BindingRecord.startingPrompt` + `binding.prompt-updated` audit row (006 never touches prompt state) |
| 005 (its plan/tasks complete, Phase 6 a prerequisite) | the six-tab shell, **`src/settings-tab.ts` + `src/settings-rows.ts`** (read-only rows, one panel-side row declaration pinned to `service/config.ts` by `tests/settings-rows.test.ts`), the arm-then-act confirm idiom, `GET /v1/status` projection, `expectedAgent` re-sourced onto `GET /v1/config`, the emptied manifest `settings` array, `src/tabs.ts` mount-once bodies |

If any predecessor has not completed Phase 6 when 006 starts, the tasks that consume its surface **block** rather than re-implement it: **T-018** and everything after it (005's `settings-tab.ts` / `settings-rows.ts` shell), **T-012** and **T-013** (003's audit vocabulary, its correlation chains, and its frozen delivery rows), **T-026** (005's emptied manifest card under 002 FR-041). Nothing in 006 rebuilds a predecessor's mechanism.

## Constitution Check (v1.3.0) — alignment statement

> **006 aligns with every principle and every security/quality gate of constitution v1.3.0. There are no constitutional violations, therefore no complexity-tracking rows and no exceptions to record.** The feature exists to make constitution **IV (human-visible auditability)** true of the *cause* of a behaviour change (a settings write now leaves a `config.changed` row, and a retention removal leaves an `audit.trimmed` row that names what it took) and **VI (specification and verification before implementation)** executable (every declared take-effect class is backed by an observed test — FR-031). **II (safe autonomy)** supplies the fail-closed write path and the value-free refusal, **III (durable and idempotent)** supplies the trim passes' atomicity/`seq` rules and the overlap dedupe, **I (no secret in any store, log, or rendered surface)** is why the refusal path is value-free *by construction*, and **VII (thin orchestration boundary)** is untouched — the panel still creates no host capability. Re-read after design (below) — alignment unchanged.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Discovery and the GitHub posture are unchanged: no webhook, no GitHub write, no new endpoint (FR-002). The one wire change is a **read** widening recorded in [contracts/](./contracts/), additive within v1 (FR-020) |
| **II. Safe autonomy by default** | Fail closed everywhere: a refused write changes nothing (FR-003, NFR-103); a save with no baseline sends nothing (FR-042); `auth-failed` is never retried (FR-058); the bootstrap pair still refuses to start naming the variable and never its value (FR-090); unknown vocabulary values are refused or passed through verbatim, never mapped to a guess (FR-021) |
| **III. Durable and idempotent work** | A trim never renumbers `seq` and never removes a run's opener or outcome row (FR-055, FR-056); both files are replaced atomically; the widened overlap window is duplicate-free by the deterministic event id (FR-059, 002 FR-019); the backoff produces no catch-up burst (FR-058); the excerpt trim leaves id/state/stamps/correlation untouched (FR-057) |
| **IV. Human-visible auditability** | Two rows, both reserved by 002's data model and never invented: `config.changed` (accepted with `field/from/to/takesEffect`; refused with field names and **no value of any kind**) and `audit.trimmed` (entries removed, seq range, limit reached, minimal references preserved). Each mints its own correlation id and records no run reference (003 FR-052; FR-074). A missing audit row is **surfaced as a visible warning**, never swallowed (FR-070's edge case, AC-139) |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, control plane, or store file; one `ServiceStore` method added beside two existing siblings; the only *removed* file is `.env.example`, a template nothing ever loaded (FR-091) |
| **VI. Specification and verification before implementation** | This plan + [research.md](./research.md) + [data-model.md](./data-model.md) + [contracts/](./contracts/) land before code; SC-101–SC-117 and AC-101–AC-155 are named test tasks, not aspirations; FR-031's "a declared class is a tested claim" is the mechanism that makes the labels executable |
| **VII. Thin orchestration boundary** | FR-004/FR-088: `capabilities[]` stays `["sessions","prompt"]`, `contributes.service` gains no `permissions` key, no host API is added, and a configuration write creates nothing — no project, worktree, session, or agent |
| **Security Std (secrets)** | The configuration document holds no credential-shaped member by construction (`expectedAgent` is refused on the secret-shape rule, FR-100(c)); the refused-write row carries **no submitted value** and records a foreign key only as `<withheld>` (FR-072); the secret-scan suites **gain cases** for the Settings edit surface, never exemptions (NFR-102) |
| **Security Std (unattended dependency)** | Unchanged: polling and dispatch still stop with OpenChamber; a configuration write never triggers a scan, never pauses polling, and never invalidates another tab's projection (FR-047) |
| **Security Std (durable state)** | Durable configuration stays in the service store's `config.json` (operator-backable, `0600`); `host.storage` gains nothing — unsaved edits are panel memory and are deliberately *not* durable (FR-005, FR-089) |
| **Quality gates** | Strict TS + lint, zero suppressions, zero `any` (FR-085); offline suites per task (FR-086); `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (FR-087, invariant 1) |

**AGENTS.md non-negotiable invariants honoured by this plan** — stated individually because each one constrains a different task:

1. **Committed bundles ship.** Every wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` in the **same commit** as their sources (FR-087); `tests/bundle.test.ts` stays green at every boundary.
2. **One document, two roles; no version bump.** `version` stays `0.0.1` — nothing here is a reason to bump it (invariant 2, FR-087); `SERVICE_VERSION` in `service/routes/health.ts` keeps mirroring `package.json` and `tests/service-server.test.ts` keeps pinning them together (invariant 5). No npm `workspaces` reintroduced.
3. **Capabilities stay `sessions` and `prompt`.** `contributes.service` gains no `permissions` key (FR-004); `tests/manifest.test.ts` continues to assert both.
4. **Kebab-case identity.** The panel id stays `mecha-turk` and `host.storage` keys keep their `mecha-turk:` prefixes — **none is added and none renamed** (FR-005); renaming either would be a user-visible storage-namespace reset and is treated as a breaking change.
5. **`SERVICE_VERSION` mirrors `package.json`.** Untouched (FR-087).
6. **SDK pinned exactly** (`@openchamber/sdk` `1.24.2`, no `~`/`^`, no preview). No re-pin (NFR-106); engine floor `>=1.24.0` unchanged.
7. **Zero suppressions, zero `any`.** No `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore` anywhere in 006's diff; the projection types are closed discriminated unions rather than `any`-tolerant records (FR-085, NFR-109).
8. **Fail-closed parsing.** The widened `GET /v1/config` response, the stored-document read, the audit rows, the events rows, and every panel reader refuse malformed input rather than partially applying it (FR-003, FR-028, NFR-103). The service is the only validation gate — the panel applies no range or enum gate of its own (FR-023).
9. **Secrets never leave the service store.** The configuration has no secret member; the refusal path is value-free **by construction** (remediation names the field and its constraint, never the submission — FR-024, FR-072), `appendAudit`'s redaction pass runs over both new row types regardless, and `tests/bundle.test.ts` plus the redaction suites gain Settings-surface cases (NFR-101, NFR-102).
10. **`extension-spike-1` is a wire contract.** Untouched: 006 changes no evidence schema, no ledger shape, no delivery id (FR-005, FR-047).

## Requirement → module mapping (what satisfies what)

| Spec group | Satisfied by (service) | Satisfied by (panel) |
| --- | --- | --- |
| **A. FR-001–FR-005** (authority, GitHub-read-only, fail closed, no capability, one durable file) | constraints asserted by existing + new tests; no route writes to GitHub; `PUT` writes `config.json` and the audit trail and nothing else | out-of-scope guard + static no-GitHub-write scan (FR-002); no-baseline refusal before any request (FR-042); `tests/manifest.test.ts` extended (FR-004); storage-key assertion (FR-005) |
| **B. FR-010–FR-019** (the edit surface in 005's tab) | none — edit surface is panel-only | `src/settings-edit.ts` draft/save state (FR-012, FR-013, FR-015, FR-016), `src/settings-tab.ts` rows + save bar (FR-010, FR-011, FR-014), one-surface assertion (FR-019, FR-081), no-credential-surface assertion (FR-017), keyboard/a11y suite (FR-018) |
| **C. FR-020–FR-029** (one declaration on the wire) | `service/config.ts` projection + `TAKE_EFFECT`; `service/routes/config.ts` GET widening (FR-020, FR-021); validator stays the single gate (FR-023) | projection parser (FR-028), zero-literals scan (FR-022, AC-106), verbatim issue rendering (FR-024, FR-026), unknown-field rule (FR-027), non-HTML rendering (FR-029) |
| **D. FR-030–FR-039** (take-effect) | `TAKE_EFFECT` declaration + one observation test per class (FR-031); `logLevel` adoption (FR-033); `windowFor`/`per_page`/backoff/trim readers (FR-034–FR-036); no `restart` declared (FR-037) | per-field class words from the projection (FR-030), pending marker + Status/Settings split (FR-038), boundary visible in the accessible name (FR-039) |
| **E. FR-040–FR-049** (the write path) | `PUT` whole-file semantics unchanged (FR-040, FR-041); no-op detection (FR-048); write triggers nothing else (FR-047) | one `PUT` (FR-040), draft built from last read (FR-041), refusal body preserved (FR-043), render the service's answer (FR-044), last-writer-wins stated (FR-045), busy gate (FR-046), read issues no write (FR-049) |
| **F. FR-050–FR-059** (retention + five consumers) | `service/audit-trim.ts` (FR-055), protected set (FR-056), `service/poll/excerpt-trim.ts` (FR-057), backoff (FR-058), window + page size (FR-059); `config.changed` rows (FR-070–FR-072) | arm-then-act confirmation content (FR-050–FR-054) composed from the projection, retention copy rules (FR-036) |
| **G. FR-060–FR-064** (refusals and failure states) | distinct envelopes already shipped (`503 storage-unavailable`, `401`, error `code` + correlation id) | four distinct causes, zero inputs, no automatic retry, stale marker, correlation id copyable (FR-060–FR-064) |
| **H. FR-070–FR-074** (audit) | `config.changed` applied/refused rows (FR-070–FR-072), `audit.trimmed` row (FR-073), own correlation id and no run reference (FR-074) | visible warning when the audit append failed (AC-139); correlation id copyable (AC-137) |
| **I. FR-080–FR-089** (composition, non-negotiables, verification) | bundle gate (FR-087), zero-suppression gate (FR-085), offline suites (FR-086) | shell untouched (FR-080), one editable rendering of the document (FR-081, SC-113), no credential control (FR-082), no requeue vocabulary on retry rows (FR-035), no host mutation (FR-088), reachable/readable without the service (FR-089) |
| **J. FR-090–FR-092** (configuration authority) | `service/env.ts` unchanged and asserted (FR-090); no dotenv loader (FR-091) | no `ctx.settings` interval read (FR-092, AC-153) |
| **K. FR-100** (`expectedAgent`) | field + validation + default + projection entry (FR-100(a)–(c)); service serves but never reads it (FR-100(d)) | baseline read through `GET /v1/config` (002 FR-029), `next-dispatch` row words (FR-100(e)), verification observation test (AC-155) |

## Already built vs. changed vs. new

### Already built — do NOT re-touch (002 shipped; 003/004/005 land before this Phase 6)

- **Config semantics**: `service/config.ts`'s `ServiceConfig`, `NUMERIC_BOUNDS`, `LOG_LEVELS`, `DEFAULT_CONFIG`, additive `validateConfig` (every bad field in one pass), `retryOrderIssue`, `unknownFieldIssue` with `<withheld>`, `parseStoredConfig` quarantine contract, `validationResponse`; `service/routes/config.ts`'s whole-file `PUT` (validate **before** any storage access) and `GET`. **006 extends the declaration and the read; it does not re-cut the validator's rules.**
- **Bootstrap environment**: `service/env.ts` — the host-provided pair only, fail-closed, value never echoed. 006 reads it nowhere and changes it not at all (FR-090).
- **Poll scheduling**: `service/poll/timer.ts` already re-reads the interval after every cycle (`currentIntervalMs`) and an armed timer keeps the delay it was given. **`next-cycle` for `intervalMs` is shipped behaviour — the timer is not touched** (FR-032).
- **Loop, triggers, dedupe**: `service/poll/{loop,scan,triggers,poller-entries}.ts`, the deterministic event id in `events-write.ts`, `enqueueEvents`'s dedupe, `MAX_DISPATCHED_EVENTS`'s tail cap, `MAX_LIST_PAGES = 2`.
- **Store mechanics**: `service/store/*` — `0700`/`0600`, quarantine-and-repair reads, atomic `writeJsonAtomic` (temp + fsync + rename), `appendJsonLine`. The trim passes **use** these; they do not add a second IO path.
- **Audit writer**: `service/audit.ts` — `seq` seeded once per store handle, per-store write chain, `redactDeep` over every row. 006 **calls** it and adds two small exports beside it (chain join + entry composition); it never rewrites the writer.
- **Panel substrate**: `src/{redaction,json,ids,storage-write,service-calls,agent-verify,relay}.ts`, `tests/support/*`, `tests/{bundle,manifest,redaction}.test.ts`, the committed-bundle pipeline.
- **005's shell**: `src/tabs.ts` mount-once bodies, the arm-then-act confirm idiom, `src/settings-tab.ts`/`src/settings-rows.ts` read-only rows and their cross-check test, `GET /v1/status` projection, the emptied manifest card. **006 edits inside that shell; it adds no tab, no sub-tab, no drawer** (FR-010).
- **003's dispatch machinery**: run model, leases, tokens, audit vocabulary, correlation discipline. **006 renders none of it and re-implements none of it**; it merely keeps its chains intact when trimming (FR-056).
- **Invariants**: delivery id format, evidence schema `extension-spike-1`, manifest ids/capabilities/panel id, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` `0.0.1`, `SERVICE_SCHEMA_VERSION = 1`, the existing suite (563 tests at 005's baseline; grows with each predecessor) staying green throughout.

### Changed (existing behaviour/shape moves)

| # | Change | Where | Specs |
| --- | --- | --- | --- |
| C1 | `GET /v1/config` answers `{ config, fields, source, defaultsApplied }` instead of `{ config }` — **the only wire change to a read** | `service/routes/config.ts` | 006 FR-020–FR-022; 002 `contracts/panel-service.md` §2.1 annotated, not superseded |
| C2 | Stored-document read tolerates **missing documented keys** (filled from `DEFAULT_CONFIG` and reported in `defaultsApplied`); unknown keys and malformed values still quarantine | `service/config.ts` (`parseStoredConfig`) | 006 FR-100(b) migration impact; NFR-103; 003 tasks T-008's "existing config documents still parse" |
| C3 | `ServiceConfig` gains `expectedAgent: string`; `DEFAULT_CONFIG` gains `project-manager`; validation gains the string rule | `service/config.ts` | 006 FR-100 |
| C4 | Logger threshold stops being a construction constant: `createLogger` returns a controllable logger and `startService` adopts the stored level after the store opens | `service/log.ts`, `service/server.ts`, `service/main.ts` | 006 FR-033, FR-037 |
| C5 | `PUT /v1/config` applies an accepted `logLevel` immediately, detects no-op writes, and appends `config.changed` (or reports `auditWritten: false`) | `service/routes/config.ts` | 006 FR-048, FR-070–FR-072, FR-047 |
| C6 | `runScanCycle` reads the stored configuration **once** at the cycle boundary and threads it through `ScanContext` | `service/poll/loop.ts` | 006 FR-055, FR-057–FR-059 ("one read, once per cycle") |
| C7 | `windowFor(binding, scanned, overlapMs)` returns `lastScanAt − overlapMs` | `service/poll/loop.ts` | 006 FR-059(a); closes **002 FR-019**'s conformance gap |
| C8 | `PAGE_SIZE = 30` replaced by the configured `perPage` (page-full test included); `MAX_LIST_PAGES` stays `2` | `service/poll/poller-github.ts` | 006 FR-059(b); **002 FR-020**'s ceiling is the field's own maximum |
| C9 | List requests gain a bounded, jittered backoff with injectable `sleep`/`random`; `auth-failed` is never retried; exhaustion **retains** `lastScanAt` instead of clearing it | `service/poll/poller-github.ts`, `service/poll/loop.ts` | 006 FR-058; **002 FR-022** |
| C10 | A skipped scan writes `lastScanAt: <prior stamp>` (retain) rather than `null` for the classes FR-058 names; the queue-recovery reset still writes `null` | `service/poll/loop.ts` | 006 FR-058; **002 FR-018/FR-020** |
| C11 | `ServiceStore` gains `writeLines(relativePath, entries)` — the atomic NDJSON sibling of `writeJson`; `audit.ts` exports its chain join and an entry composer | `service/store/index.ts`, `service/store/ndjson.ts`, `service/audit.ts` | 006 FR-055 (atomic replace), FR-073 (row shape) |
| C12 | `events.json` rows gain the absentable `excerptTrimmedAt` marker; the dispatched-tail rule is extracted as one shared terminality predicate | `service/poll/events-parse.ts`, `service/poll/events.ts` | 006 FR-057 |
| C13 | `src/service-calls.ts`'s classifier takes the resource it is describing: a configuration refusal keeps its body, its issue list, and a problem string that names the configuration | `src/service-calls.ts` | 006 FR-043; **005 FR-088** (extended, not forked) |
| C14 | 005's panel-side row declaration is **deleted** and its cross-check test becomes the zero-literals scan; row rendering is projection-driven | `src/settings-rows.ts`, `src/settings-tab.ts`, `tests/settings-rows.test.ts` | 006 FR-022, AC-106; replaces **005 research Q1**'s stand-in |
| C15 | The Settings body gains editable controls, save state, pending markers, error/confirm regions, and the read-only states 005 specified | `src/settings-tab.ts`, `src/panel-state.ts` | 006 FR-010–FR-019, FR-060–FR-064; supersedes **005 FR-070/FR-073** |
| C16 | `.env.example` deleted; `.gitignore`'s `!.env.example` negation dropped (`.env*` rules kept) | repo root | 006 FR-091, AC-151 |

### New

| # | New thing | Where | Specs |
| --- | --- | --- | --- |
| N1 | The field-descriptor projection + `TAKE_EFFECT` class table, derived from the same declaration the validator reads (closed `kind` and class vocabularies, `Record<Field, TakeEffect>` so a field cannot exist without a class) | `service/config.ts` | 006 FR-020, FR-021, FR-030, SC-101 |
| N2 | Audit trim pass: protected-set computation (opener + outcome per run-bearing chain, existing account/binding rows, `policy.decision`/`config.changed`), oldest-first removal under day-window and entry-cap, one atomic write that carries the `audit.trimmed` row | `service/audit-trim.ts` | 006 FR-055, FR-056, FR-053, FR-073; **002 FR-035** |
| N3 | Excerpt trim pass: terminal-row `issueBodyExcerpt` cleared with a round-trip marker, pending/in-flight never touched | `service/poll/excerpt-trim.ts` | 006 FR-057, SC-115 |
| N4 | Backoff computation with injectable clock and jitter source | `service/poll/backoff.ts` | 006 FR-058, SC-116 |
| N5 | Panel draft/save state machine over the projection (draft build, dirty set, save states, arm/confirm, discard) | `src/settings-edit.ts` | 006 FR-012–FR-016, FR-041, FR-046 |
| N6 | Destructive-confirmation content builder (field, both limits, what/when/survivors, raise-deletes-nothing) | `src/settings-confirm.ts` | 006 FR-051–FR-054, SC-108 |
| N7 | Projection reader: fail-closed parse of `fields`/`source`/`defaultsApplied` into closed types | `src/settings-schema.ts` | 006 FR-021, FR-028 |
| N8 | Contract files for the config read/write delta and the confirmation copy | `specs/006-settings-crud/contracts/` | 006 `## Wire Surface Delta` |

## Architecture (decided)

### One declaration, read twice (FR-020–FR-022)

```text
service/config.ts  (single declaration — the validator and the wire both read here)
├── NUMERIC_BOUNDS      { min, max, unit } × 9        (unchanged)
├── LOG_LEVELS          debug|info|warn|error          (unchanged)
├── EXPECTED_AGENT_RULE { maxLength: 80, pattern prose } (NEW, FR-100(c))
├── DEFAULT_CONFIG      + expectedAgent: 'project-manager'
├── TAKE_EFFECT          Record<ServiceConfigField, TakeEffect>  (NEW — closed, exhaustive)
└── configSchema(): readonly FieldDescriptor[]         (NEW — the projection)
```

`configSchema()` is built **from** `NUMERIC_BOUNDS`, `LOG_LEVELS`, `EXPECTED_AGENT_RULE`, `DEFAULT_CONFIG`, and `TAKE_EFFECT` — not from a parallel table. SC-101's proof is a test that mutates one bound in the declaration and asserts the projection's `min`/`max` **and** the validator's remediation string both moved. The wire shape (Phase 4's delegated naming, per FR-020) is a **closed discriminated union**, so the panel's parser can refuse anything outside it:

```jsonc
// GET /v1/config → 200
{
  "config": { "intervalMs": 60000, /* …every documented field… */ "expectedAgent": "project-manager" },
  "fields": [
    { "name": "intervalMs",   "kind": "integer", "unit": "milliseconds", "min": 15000,  "max": 300000,
      "default": 60000, "takesEffect": "next-cycle" },
    { "name": "logLevel",     "kind": "enum",    "unit": null, "values": ["debug","info","warn","error"],
      "default": "info", "takesEffect": "immediate" },
    { "name": "expectedAgent","kind": "string",  "unit": null,
      "format": "letters, digits, and . _ - @ : / (a single token, no spaces)",
      "maxLength": 80, "default": "project-manager", "takesEffect": "next-dispatch" }
  ],
  "source": "stored",                 // 'stored' | 'default' | 'quarantined'
  "defaultsApplied": []               // documented keys the stored document lacked
}
```

- `kind` is exactly `integer | enum | string`; `takesEffect` is exactly `immediate | next-cycle | next-dispatch | restart | none` (FR-021). A `string` entry carries **no** `unit` and **no** numeric bound — `format` is service-authored prose the panel renders as text and builds **no** validation from (FR-014, FR-023).
- `source` makes the quarantine fact visible without a second read (spec edge case *hand-edited `config.json` that fails validation*): `quarantined` renders *the stored configuration was unusable and set aside*, never "your values are current".
- `defaultsApplied` is what lets FR-028's rule be honoured exactly — a pre-upgrade document's missing `expectedAgent` renders as **default**, not as a configured fact (006 v1.3.0 migration impact).
- **Why these two extra members**: FR-020 delegates the mechanism to Phase 4 and the spec's own edge case + migration-impact text require both facts to reach the panel; both are additive, and no existing member is renamed (co-ship assumption, same rule 005's contracts state).

### Five consumers, one read per cycle (FR-055, FR-057–FR-059)

```text
runScanCycle(deps)
  └── config = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log)   // ONE read
        ├── trimAudit({store, log, config, now})          // store open + here (FR-055)
        ├── trimExcerpts({store, log, config, now})       // store open + here (FR-057)
        ├── ScanContext.config ──► windowFor(binding, scanned, config.overlapMs)            // FR-059(a)
        │                          poller.list*(…, { perPage, retry })                      // FR-059(b), FR-058
        └── (interval is read separately by timer.ts after the cycle — unchanged, FR-032)
```

A read failure falls back to `DEFAULT_CONFIG` exactly as `currentIntervalMs` already does, so one bad read degrades to documented defaults rather than to a crash (invariant 8).

**Backoff** (FR-058) lives in `service/poll/backoff.ts` as a pure function plus a driver, so the arithmetic is testable without a transport:

```text
delay(n) = min(retryMaxMs, retryBaseMs × 2^(n−2)) × jitter ∈ [0.5, 1.0]
actual   = max(delay(n), retry-after guidance)      // guidance wins even above retryMaxMs
attempts ≤ retryMaxAttempts, first attempt included
auth-failed → no attempt 2;  exhaustion → last failure returned, checkpoint retained
```

`createGitHubIssuePoller(fetchImpl, { sleep, random })` takes both injectables; tests assert the recorded delays lie inside `[retryMaxMs / 2, retryMaxMs]` (SC-116) with **no real sleeping**. `loop.ts` keeps the skip-reason mapping it has; only the checkpoint write changes (C10).

**The trim passes** are new modules chained onto the writers they must not race:

- `service/audit-trim.ts` joins `audit.ts`'s existing per-store chain, computes the protected set, and performs **one** `store.writeLines(AUDIT_FILE, [...survivors, trimRow])`. The row and the removal land in the same atomic replace, which is the strongest reading of FR-053/FR-055/edge-case *trim pass crashes mid-write*: either the pre-trim trail or the post-trim trail (survivors **plus** their row), never a torn file, never a removal without its record, and never a restart that re-seeds `seq` below a number already used. Composing the row through a new `audit.ts` export keeps `appendAudit`'s redaction pass and `seq` assignment as the only place a row is built.
- `service/poll/excerpt-trim.ts` joins the queue's own chain (a new `events.ts` export beside the existing private `inQueueChain`), clears `issueBodyExcerpt` on terminal rows older than the window, writes `excerptTrimmedAt`, and delegates "is this row terminal?" to **one shared predicate** exported from `events.ts` — the same rule `serializedQueue`'s tail cap already uses, so a future change to what terminal means moves both consumers at once.

### The write path (FR-040–FR-049)

```text
Settings body ── draft = last-read config ∪ projection defaults for missing keys ∪ edits
      │  (no baseline ⇒ no save, named reason, zero requests — FR-042)
      ▼
servicePutConfig({ path: '/v1/config', body })      // src/service-calls.ts, extended not forked
      │  422 ⇒ { ok:false, problem:'service refused the configuration', code:'validation', issues:[…] }
      ▼
PUT /v1/config  ⇒ validate (whole file, additive 422) ⇒ store unavailable? 503 ⇒ no-op? 200, no audit row
                ⇒ write config.json (atomic) ⇒ setLevel(logLevel) ⇒ config.changed row
                ⇒ answer { config, auditWritten }
      ▼
panel renders the returned document (never the submitted one — FR-044)
```

- **No-op detection** compares the validated candidate with the stored document field by field (FR-048); equality ⇒ `200`, *already saved*, **no** audit row.
- **`actorSource`** is `'operator'`: the only writer of `config.json` is a holder of the bearer token acting for the operator — the same convention `service/routes/accounts.ts` already uses for account deletion. `'service'` remains the value for a future service-internal writer; no header discrimination is invented (no new wire surface).
- **Audit failure is visible, not swallowed**: the row append runs after the durable write in a `try/catch` that logs a structured warn and answers `auditWritten: false` (003 FR-063's rule applied here, AC-139).

### The panel edit surface (FR-010–FR-029, FR-038–FR-049, FR-060–FR-064)

```text
src/settings-schema.ts   fields/source/defaultsApplied → closed types (fail closed, FR-028)
src/settings-edit.ts     draft · dirty set · saveState(idle|editing|saving|saved|refused|failed)
                         · pending set (configured ≠ effective, boundary named)   [pure]
src/settings-confirm.ts  arm-then-act content for retention lowering + restore defaults [pure]
src/settings-tab.ts      005's rows + controls + save bar + error region + confirm region
src/service-calls.ts     servicePutConfig — refusal body preserved
```

Everything service-supplied — field names, units, bounds, defaults, accepted values, take-effect classes, remediation prose, echoed key names — renders through `@openchamber/sdk/ui` text nodes (FR-029, NFR-101). The panel applies **no** range/enum gate: `min`/`max`/`values` shape the control and the hint only, and an out-of-range value is sent and refused by the service (FR-023, AC-110).

**Confirmation content** is composed panel-side from the projection plus the trim semantics the spec fixes; it crosses **no wire member**, which is why [contracts/settings-confirmation.md](./contracts/settings-confirmation.md) is labelled a panel-side copy contract.

## Config-field count dynamics: eleven (spec) → thirteen (combined tree)

This is the coordination point most likely to be mis-read, so it is stated as a rule rather than a note.

| Layer | Count | Who owns it |
| --- | --- | --- |
| **006's spec, criterion of record** | **eleven** — `intervalMs`, `logLevel`, `overlapMs`, `perPage`, `retryMaxAttempts`, `retryBaseMs`, `retryMaxMs`, `auditRetentionDays`, `auditMaxEntries`, `excerptRetentionDays`, `expectedAgent` | 006 `## Per-Field Contract`, FR-084, **AC-101** ("eleven rows … and no twelfth field is offered"), SC-102, SC-106 |
| **Combined tree after 003's T-008** | **thirteen** — the eleven **plus** `leaseMs` and `resultDeadlineMs` (30,000–600,000 ms, default 120,000 — 003 plan C14/D9, 003 data-model §2.7) | **003's own amendment** adds the fields; 006 renders them because the panel renders **what the projection carries**, never a hard-coded count (005 research Q2 / 005 plan X5/D9 already fixed this rule) |
| **Mechanism that keeps both true** | the projection is `Object`-derived from `service/config.ts`'s declaration, and the row renderer iterates `fields` | 006 FR-020–FR-022 |

**How the tests stay honest at both counts** (this is what makes AC-101 and SC-106 non-contradictory):

1. `fields.length === Object.keys(DEFAULT_CONFIG).length` — a structural identity, no literal.
2. **For each of 006's eleven names**: a row exists, is editable, and carries name + unit-or-*none* + bounds-or-format + value + class; and `takesEffect` equals 006's declared class. **The 9/1/1 histogram is asserted over exactly these eleven** (AC-104, SC-106 criterion of record).
3. **For every entry in the projection**, a class is declared and a backing observation exists (SC-107) — 003's two are backed by 003's sweep tests.
4. **Row count** = `fields.length`, asserted as **11 against the 006-only fixture** and **13 against the combined fixture** (AC-101 read as "the fields this specification declares, and no undocumented row").

**Take-effect class for 003's two fields**: `next-cycle`. It is the only defensible value in the closed vocabulary — `none` would be the inert-field defect the gate answer removed, `restart` is forbidden by FR-037 for new fields, `immediate` is false (the sweep reads them at its own pass), and `next-dispatch` belongs to verification. "Cycle" is read as *the consumer's own next scheduling boundary* (the sweep tick), and the panel's generic `next-cycle` words are honest for it. Recorded here and in [data-model.md](./data-model.md); **003 may re-declare it in its own amendment** — a class change is a declared, tested change, not an editorial one (FR-037).

**`requeueBudget` stays out** (006 FR-083, gate answer 4): no consumer exists until 003's lease-expiry sweep, and it would arrive as the *fourteenth* field, not the twelfth.

## Cross-feature coordination and interface assumptions

| # | Coordination point | How 006 honours it |
| --- | --- | --- |
| X1 | **003 adds two config fields with live consumers** (`leaseMs`, `resultDeadlineMs`) | 006 adopts 003's bounds and defaults verbatim (30,000–600,000 ms / 120,000), renders them from the projection with no special case, and declares `next-cycle` for both (see the count-dynamics rule above). **006 never hard-codes a row count**; AC-101's eleven is asserted against 006's own fixture and 003's rows are 003's amendment |
| X2 | **005's two Settings-shell stand-ins must be replaced by 006's wire mechanism** | (a) **bounds**: `src/settings-rows.ts`'s panel-side declaration is *deleted* (C14) and `tests/settings-rows.test.ts`'s cross-check is *reversed* into AC-106's zero-literals scan — the stand-in 005 research Q1 decided is retired the moment FR-022 lands; (b) **row count**: rows follow the document/projection (005 D9), and the count criterion of record is **006 AC-101** (005's v1.3.0 amendment already hands it over). Both are explicit tasks — T-017 (the projection reader) and T-018 (the declaration's deletion, the reversed scan, and the derived row-count assertions) — not incidental edits |
| X3 | **002's cleanup rulings** | (a) **006 FR-091** — `.env.example` deletion + `.gitignore` `!.env.example` removal + no dotenv loader + no `MECHA_TURK_*` in any tracked file or bundle: **specs-only in this task**; the file operations are scheduled as **T-025** for Phase 6 with AC-151 as its test. `contracts/token-handoff.md`'s sentence is **already corrected** (it records the 2026-09-28 removal) — T-025 asserts it rather than editing it. (b) **002 FR-042** doc sync is 002's requirement but its Settings claim ("the single configuration input for the whole service configuration … `expectedAgent`") becomes true only when 006 ships the editable surface; **T-029** completes that claim for 006's surface and asserts neither user-facing document instructs `.env`/`MECHA_TURK_*` configuration, extending **005 T-033** rather than repeating it |
| X4 | **Audit trim vs 003's vocabulary and correlation ids** | 003's 16 lifecycle rows + `dispatch.refused` are the content FR-056 protects **by rule, not by list**: for every correlation chain that contains a run-scoped row, the **opener** (earliest `seq`) and the **outcome** (latest run-scoped row) are both marked protected before anything is chosen for removal — so a trim can never leave an outcome without its opener or an opener without its outcome. Account/binding rows are protected while their subject exists; `policy.decision` and `config.changed` are protected outright. Middle observations are exactly what a trim removes, and the `audit.trimmed` row records the `seq` gap that explains them (FR-056's own wording). T-012 seeds a trail carrying **all seventeen** 003 event types and asserts opener/outcome survival per chain |
| X5 | **Excerpt trim vs 003's frozen legacy delivery rows** | **Confirmed coexisting, two different axes.** 003 freezes `state`, `claimedAt`, `dispatchedAt`, `dispatchResult` as *migration input* ("still parsed … still written by nothing"); `issueBodyExcerpt` is a **detection** field that 003's migration never reads, and FR-057 clears only the *text* while preserving id, state, stamps, repository/issue identity, and correlation identifier byte-for-byte. The two are therefore independent: a legacy row adopted by 003 is unaffected by a later text trim, and a trimmed row still projects through 003's migration table. The one real interaction is **terminality**: post-003 deliveries omit `state`, so the trim delegates "terminal?" to the **shared predicate beside `serializedQueue`** (C12) instead of re-reading the rule — if 003 replaces `state === 'dispatched'` with run-based terminality, both consumers move together and the trim never has to import 003's machinery |
| X6 | **The stored-document upgrade path is shared** | 003's T-008 says "existing config documents still parse (additive)" and 006's v1.3.0 migration impact says a pre-`expectedAgent` document must read with `expectedAgent` shown as *default*. **Both need the same mechanism** (C2: missing documented key ⇒ documented default, reported; unknown key or malformed value ⇒ quarantine). 006 implements it generically in `service/config.ts` because its spec owns the migration statement; T-001 is written so that if 003 already shipped it, the task reduces to the `defaultsApplied` reporting. **The whole-file `PUT` rule is unchanged**: an operator document missing a documented key is still refused (FR-100(b), FR-041) |
| X7 | **002 FR-029's baseline fallback vs FR-022's no-default-literal rule** | `GET /v1/config` supplies the default whenever *any* config read succeeded (from `fields`, never from panel source). The only path with no read at all — verification before the first successful config read — needs one fallback constant; 006 keeps `DEFAULT_EXPECTED_AGENT` in `src/config.ts` (it predates this feature), **pins it to `service/config.ts`'s `DEFAULT_CONFIG.expectedAgent` by test**, and names it as the **single, asserted exception** in AC-106's scan. Raised for the product owner in the report; the default is implemented unless overturned |
| X8 | **004's prompt and 005's shell** | A configuration write touches no binding, so `startingPrompt` and `binding.prompt-updated` are untouched (FR-047, FR-082); 005's six-tab shell, mount-once rule, read-state registry, and teardown counts are consumed unchanged (FR-080) |

### Not absorbed by 006 (recorded so nobody adds it by reflex)

005's tab composition, 003's dispatch machinery, and 004's prompt capability are excluded, as are everything 006's own `## Out of Scope` names: the correlation-indexed read API (the other half of the `service/audit.ts:13` **002** T-027 deferral), `MAX_LIST_PAGES`, `MAX_DISPATCHED_EVENTS`, `poll.duplicate` auditing, restore/export of trimmed data, `requeueBudget`, any twelfth-field invention beyond 003's two, any status-projection change, any GitHub write, and any revision precondition on `PUT /v1/config` (gate answer 2).

## Rollout & sequencing (each wave independently green)

Ordering principle: **declaration first, then consumers, then the panel, then the removals** — so every wave leaves `npm run verify` green with the rebuilt bundles committed, and no consumer lands before the declaration that gives it a value.

| Wave | Contents | Why it can land alone | Exit |
| --- | --- | --- | --- |
| **1. Declaration & projection** (service) | C2, C3, N1: `expectedAgent`, read-side backfill + `defaultsApplied`, `configSchema()`, GET widening | No behaviour changes: `PUT` semantics, validation messages, and the poll loop are untouched; a panel that ignores `fields` still works because `config` is unchanged | `npm run verify` + bundles |
| **2. `logLevel` immediate** (service) | C4, C5: controllable logger, startup adoption, apply-on-accept | Self-contained; the only config surface it touches is the one route Wave 1 already opened | `npm run verify` + bundles |
| **3. Poll consumers** (service) | C6–C10, N4: cycle config read, overlap window, `per_page`, backoff, checkpoint retention | Each is a reader of a value Wave 1 declared; the loop's external contract (skip reasons, event ids) is unchanged | `npm run verify` + bundles |
| **4. Trim passes** (service) | C11, C12, N2, N3 + wiring at store open and cycle boundary | Writes only files the passes own; protected-set and marker rules are fully covered by seeded fixtures before anything else runs | `npm run verify` + bundles |
| **5. Config audit rows** (service) | C5 remainder: no-op detection, `config.changed` applied/refused, `auditWritten` | Depends on Waves 1 (validation) and 2 (`setLevel`); completes the service half | `npm run verify` + bundles |
| **6. Projection reaches the panel** | C13, C14, N7: refusal body preserved, stand-in deleted, projection reader | The tab is still read-only at this point (005's behaviour) but now labelled from the wire — an independently valuable step | `npm run verify` + bundles |
| **7. Edit surface** (US1, US2) | C15, N5: draft/save state machine, controls, refusal rendering, pending markers | Needs Waves 1 + 6; no destructive copy yet | `npm run verify` + bundles |
| **8. Destructive confirmation + restore defaults** (US3) | N6 | Pure panel logic on top of Wave 7 | `npm run verify` + bundles |
| **9. Failure states + audit visibility** (US4, US5) | FR-060–FR-064 causes, stale marker, AC-139 warning | Panel-only; can trail Wave 8 | `npm run verify` + bundles |
| **10. Configuration authority** (block J) | C16 + AC-151/AC-153 scans | File removal + tests; no source change, so bundles are unaffected but still rebuilt | `npm run verify` + bundles |
| **11. Proof & docs** (US6) | SC/AC consolidation, zero-literals scan, bundle/secret extensions, 002 FR-042 doc sync | After every behaviour task | `npm run verify` + bundles |

**Parallel opportunities inside a wave**: Wave 3's window/page-size/backoff tasks touch three different call sites and are `[P]` once the shared `ScanContext.config` read exists; Wave 4's two passes are separate modules (`[P]`); Wave 9's cause tests are `[P]`. **Hard dependencies**: T-007 (cycle config read) precedes Wave 3's consumers; T-016 (projection reader) precedes Wave 7's edit surface; Wave 5 needs Waves 1 and 2; Wave 10's `.env.example` removal needs no source task at all.

## Key decisions and rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| D1 | The projection is **derived** from `NUMERIC_BOUNDS`/`LOG_LEVELS`/`DEFAULT_CONFIG`/`TAKE_EFFECT`, not hand-written beside them | SC-101's test then proves *by construction* that the wire and the validator cannot disagree; a second table is the drift FR-022 exists to prevent | a parallel `FIELD_SCHEMA` constant (two sources for the same nine numbers); building the projection in the route (the route would become a second declaration) |
| D2 | `TAKE_EFFECT` is a `Record<ServiceConfigField, TakeEffect>` — exhaustive over the field union | a field cannot be added to `ServiceConfig` without declaring a class, so "a field silently gains no consumer" fails **typecheck**, not review | an optional per-field comment or a lookup with a fallback (`none` by default would re-introduce the inert class) |
| D3 | The read path **backfills missing documented keys** and reports them (`defaultsApplied`); `PUT` stays strict whole-file | 006's own v1.3.0 migration impact requires a pre-upgrade document to read with `expectedAgent` shown as *default*; quarantining it would show the operator **every** value as default and would contradict the spec's "valid document" edge case. `PUT` unchanged keeps FR-041's guard exactly as strong as it is | making `PUT` lenient too (weakens the whole-file rule the spec relies on); serving `config` untyped/`Partial` (violates invariant 8); quarantining pre-upgrade documents (loses the operator's other ten values) |
| D4 | One **atomic** write carries survivors **and** the `audit.trimmed` row | removes the crash window where a removal exists without its record *and* the restart that would re-seed `seq` below an already-used number (FR-055's "never renumbers" + FR-053's "after the removal succeeds" are both satisfied observably) | remove, then `appendAudit` (two-step: a crash between them orphans the record and can renumber on restart) |
| D5 | The trim passes join the **existing** per-store chains (new exports beside `appendAudit`'s chain and `events.ts`'s private chain) | FR-055 requires exactly this serialization; a third chain would race appends | a global lock; running the pass inside the route (FR-047 forbids trimming on write) |
| D6 | Terminality for the excerpt trim is **one shared predicate** beside `serializedQueue` | 006's FR-057 and the existing tail cap must never disagree about what a terminal row is, and this keeps 003's model change in one place (X5) | re-deriving `state === 'dispatched'` inside the trim (two rules to keep in step); importing 003's run state machine (absorbing 003's machinery) |
| D7 | The backoff takes **injected `sleep` and `random`** at poller construction | SC-116 needs recorded delays with no real waiting and no flaky jitter | real timers in tests (slow and flaky); a fixed jitter (violates FR-058) |
| D8 | Checkpoint on exhaustion is **retained, not cleared and not advanced** | FR-058 + 002 FR-018/FR-020: the next successful scan re-covers the failed period through `lastScanAt − overlapMs`, so a rate-limit storm costs one cycle, not a full replay | today's clear-to-replay (silently discards the checkpoint — the defect FR-058 names); advancing (would skip undelivered data) |
| D9 | The confirmation is composed panel-side from the projection; **no wire member** | FR-054 puts it in the arm-then-act idiom; the service already declared everything it needs to say | a `confirmationToken` on `PUT` (a concurrency mechanism the gate rejected in answer 2); server-rendered copy (would move 005's copy rules into the service) |
| D10 | `actorSource: 'operator'` for every `config.write`, decided by the route | the only writer is a bearer-token holder acting for the operator — the convention `routes/accounts.ts` already uses; inventing a header would add wire surface for a distinction nobody can exploit | an `X-Actor` header (new wire surface, unauthenticated claim); `'service'` by default (mislabels the panel) |
| D11 | The AC-151 scan covers **every tracked file except `specs/**`** | the specification corpus *quotes* `MECHA_TURK_*` as the record of what was removed; the requirement's intent is that no **shipped or operator-facing** file carries it | scanning `specs/**` too (the AC would be unsatisfiable while the AC itself exists); scanning only `src/` (would miss a future README instruction) |
| D12 | `logLevel` adoption happens **inside `startService`, right after the store opens** | FR-033 says "once the store is open"; adopting in `runService` after `startService` returns would judge boot-time lines at the wrong threshold | adopting in `main.ts` (too late, and it would need the store handle it does not have) |

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Five consumers in one feature** — the gate's "wire all fields" answer roughly triples the service-side surface | a consumer lands without its observation test, and a class label becomes decorative | the wave structure separates declaration from consumers; **SC-107's "every declared class has an observation" assertion is a named task (006 T-027)** and runs at the final wave; each consumer task carries its own test expectations inline |
| **Trim passes are destructive** | the wrong row removed is unrecoverable (006 `## Out of Scope`: no restore) | protected set computed **by rule** before any removal (FR-056); seeded-fixture tests for opener/outcome/account/binding/decision survival (T-012, AC-146); a pass that removes nothing writes nothing (FR-053); atomic replace (D4) |
| **Audit-trim read cost per cycle** | reading a full trail every boundary is O(cap) work each cycle | see [research.md](./research.md) Q1: the simple spec-shaped full read is the default, the write is skipped whenever nothing is removed, and a config-change/period gate is the documented escape hatch if measurement shows it is needed |
| **Retention knobs now delete** | an operator lowers a limit and loses history they expected to keep | FR-052's confirmation states what/when/survivors **before** the write, names that raising deletes nothing, and names that trimming is irreversible (T-021); the pass runs at the *next boundary*, never inside the save (FR-047) |
| **Checkpoint retention changes replay behaviour** | a skip that used to reset the window now keeps it — could a stuck binding stop re-covering data? | the retained stamp plus `overlapMs` re-covers the failed period (FR-058's own reasoning); the window is widened by the overlap, never truncated; tests assert retention for exhaustion **and** `auth-failed`, and assert the queue-recovery reset still clears (T-010) |
| **`logLevel` adoption touches the one logger every module shares** | a level change could silence the failure lines an operator needs | the threshold is read per entry from mutable state held by the logger itself; `error`/`warn` behaviour under `logLevel: 'error'` is a stated edge case with its own assertion (T-006); no logger is constructed anywhere except `createLogger` |
| **005's stand-in removal could regress bounds rendering** | a row renders without a bound after the declaration is deleted | T-016 renders from the projection and asserts every row still carries name/unit/bounds-or-format/value/class **over the real projection** (AC-101, SC-102) in the same wave that deletes the stand-in |
| **Count drift (11 vs 13)** | a test hard-codes eleven and turns red when 003 lands, or hard-codes thirteen and contradicts AC-101 | the count-dynamics rule above: structural identity assertion + per-name assertions over 006's eleven + row count derived from `fields.length`, with fixtures for both trees |
| **Whole-file `PUT` + `last-writer-wins`** | a second panel's save silently replaces the first | unchanged and *stated*: the panel says a save replaces the whole configuration and names the fields it will change before the operator commits (FR-045, gate answer 2); no revision precondition is added |
| **Refusal path could echo a submitted value** | a secret reaches a durable trail or a rendered surface | the validator's remediation is built from the *declaration*, never the submission (existing rule); the refused row carries field names and `<withheld>` only (FR-072); AC-108/AC-136 scan the rendered refusal **and** the row for the submitted bytes |
| **Committed bundles forgotten** | shipped code ≠ source (invariant 1) | every wave's exit criterion includes `npm run build` + `tests/bundle.test.ts` green; `npm run verify` at every boundary; bundles ride the same commit as their sources |
| **Scope bleed into 005/003/004** | rework, spec conflict | the out-of-scope guard below, restated at the head of [tasks.md](./tasks.md); no task composes a prompt, moves a tab, or adds a run transition |

## Out-of-scope guard (checked at every wave)

No GitHub write of any kind (002 FR-031, 003 FR-002, 006 FR-002). No new tab, sub-tab, drawer, or second configuration surface (FR-010). No change to the six-tab shell, mount-once rule, or teardown discipline (005 FR-013/FR-017, FR-080). No run state, lease, token, transition, or dispatch-lifecycle audit row (003's; FR-074). No prompt composition, validation, or storage (004's; FR-082). No `PATCH`, no per-field endpoint, no partial document, no revision precondition (FR-040, FR-045). No `MAX_LIST_PAGES`, `MAX_DISPATCHED_EVENTS`, or `poll.duplicate` change. No correlation-indexed read API, no restore/export of trimmed data. No `requeueBudget` (FR-083). No status-projection change (FR-019's Status half is 005's). No capability, permission, host API, SDK re-pin, storage key, `SERVICE_VERSION`, or `version` bump (FR-004, FR-005, FR-087). No `host.storage` write of configuration state (FR-005).

## Project structure

### Documentation (this feature)

```text
specs/006-settings-crud/
├── spec.md              # v1.3.0 — APPROVED source of truth (input, unchanged)
├── plan.md              # This file
├── research.md          # Genuinely open questions only
├── data-model.md        # ServiceConfig delta, projection, trim state, upgrade path
├── contracts/
│   ├── README.md        # Index + the `## Wire Surface Delta` checklist
│   ├── config-schema.md # GET widening, PUT refusals, config.changed/audit.trimmed rows
│   └── settings-confirmation.md  # Panel-side copy contract (crosses no wire)
└── tasks.md             # Phase 5 output
```

### Source code (repository root — the real layout this plan changes)

```text
service/
├── config.ts               # CHANGED: +expectedAgent, +TAKE_EFFECT, +configSchema(), read backfill (C2, C3, N1)
├── routes/config.ts        # CHANGED: GET {config, fields, source, defaultsApplied}; no-op; setLevel; config.changed (C1, C5)
├── log.ts                  # CHANGED: controllable threshold (C4)
├── server.ts               # CHANGED: adopt stored logLevel after store open; run both trim passes at store open (C4, N2, N3)
├── main.ts                 # CHANGED: logger construction passes the control through (C4)
├── audit.ts                # CHANGED: +chain-join and +entry-composer exports (C11) — writer otherwise untouched
├── audit-trim.ts           # NEW: FR-055/FR-056 protected-set trim (N2)
├── store/index.ts          # CHANGED: +writeLines (C11)
├── store/ndjson.ts         # CHANGED: +atomic line-file writer (C11)
└── poll/
    ├── loop.ts             # CHANGED: cycle config read, windowFor(overlapMs), checkpoint retention (C6, C7, C10)
    ├── poller-github.ts    # CHANGED: perPage, retry driver, injectables (C8, C9)
    ├── backoff.ts          # NEW: pure backoff arithmetic + delay driver (N4)
    ├── events.ts           # CHANGED: +queue-chain export, +shared terminality predicate (C12)
    ├── events-parse.ts     # CHANGED: +absentable excerptTrimmedAt (C12)
    └── excerpt-trim.ts     # NEW: FR-057 excerpt trim (N3)

src/
├── service-calls.ts        # CHANGED: servicePutConfig + issue extraction (C13)
├── settings-schema.ts      # NEW: projection reader, fail closed (N7)
├── settings-edit.ts        # NEW: draft/dirty/save-state machine (N5)
├── settings-confirm.ts     # NEW: destructive-confirmation content (N6)
├── settings-tab.ts         # CHANGED (005's): controls, save bar, error/confirm regions, read-only states (C15)
├── settings-rows.ts        # CHANGED (005's): panel-side declaration DELETED; projection-driven rows (C14)
└── panel-state.ts          # CHANGED (005's): Settings state slice

tests/
├── service-config.test.ts      # CHANGED: projection, backfill, expectedAgent refusals, no-op
├── service-config-audit.test.ts# NEW: config.changed applied/refused/correlation (SC-109, SC-110)
├── service-trim.test.ts        # NEW: audit trim over seeded trails (SC-114, AC-146)
├── service-excerpt-trim.test.ts# NEW: excerpt trim over seeded queues (SC-115, AC-147)
├── service-backoff.test.ts     # NEW: injected clock/jitter (SC-116, AC-148)
├── service-cycle-config.test.ts# NEW: window/page-size/one-read-per-cycle (SC-117, AC-149, AC-150)
├── settings-rows.test.ts       # CHANGED (005's): cross-check REVERSED into the zero-literals scan (AC-106)
├── settings-edit.test.ts       # NEW: draft/save/discard/pending (AC-122–AC-127)
├── settings-confirm.test.ts    # NEW: arm-then-act content (AC-117–AC-121, SC-108)
├── settings-failures.test.ts   # NEW: four distinct causes, zero inputs (AC-129–AC-134, SC-111)
├── config-authority.test.ts    # NEW: AC-151 / AC-152 / AC-153 scans
└── support/                    # unchanged: fake host, DOM helpers, temp-dir service, fixture GitHub
```

**Structure decision**: no new directory, no new package, no new dependency. Service work stays inside `service/config.ts`, the one route it changes, and **one new module per consumer** (`audit-trim.ts`, `excerpt-trim.ts`, `backoff.ts`) — matching `AGENTS.md`'s one-responsibility-per-module map and keeping the two largest existing modules (`audit.ts` 431 lines, `loop.ts` 490) from growing past reason. Panel work is one module per responsibility beside 005's `settings-*` pair, so the read-only surface 005 shipped stays recognisably 005's.

## Complexity tracking

**No constitutional violations to justify** — the table the template provides is intentionally empty. The feature adds three service modules and three panel modules, no dependency, no capability, no storage file, and no second validation path; every addition is a requirement's consumer rather than an architectural preference.
