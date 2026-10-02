# Implementation Plan: Dispatch Integrity & Recovery

**Branch**: `full-project-plan` (spec artifacts; implementation moves to `003-dispatch-integrity` per `AGENTS.md` git conventions) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md) (v1.3.0, APPROVED — normative body unchanged from v1.0.0)

**Input**: Feature specification `specs/003-dispatch-integrity/spec.md` (v1.3.0); scope source `specs/003-dispatch-integrity/pm-handoff.md`; constitution `.specify/memory/constitution.md` v1.3.0; repo directives `AGENTS.md`; predecessor `specs/002-agent-event-extension/spec.md` (v1.7.0) + `tasks.md` (debt list and close-out defect record); and the shipped code itself (read for this plan: `service/poll/{events,events-parse,events-write,loop,scan,timer}.ts`, `service/routes/{events,index,health}.ts`, `service/audit.ts`, `service/store/index.ts`, `src/{relay,panel-dispatch,session,ledger,runs-service,runs-rows,redaction,ids}.ts`).

**Note**: No application code is written in Phases 4–5. Every design decision below is decided and justified; the genuinely open technical questions this feature raises are in [research.md](./research.md).

## Summary

Feature 002 shipped a working loop with seven recorded defects; five are conformance failures against requirements 002 already states. This plan repairs them by inserting a **run layer** between the delivery (deduped, unchanged id) and the dispatch (one `host.startSession()` call): the service becomes the owner of runs, leases, single-use dispatch tokens, the eight-state dispatch vocabulary, and the sixteen-entry dispatch-lifecycle audit vocabulary (plus one FR-003 refusal row — see data-model §4.2); the panel becomes a lease-respecting, reconciliation-before-claim executor that persists each outcome durably before it reports it. A second session for one run becomes impossible **by construction** (FR-028) rather than unlikely, and every state transition carries an audit row naming prior state, new state, actor, and reason (FR-044).

Technical approach in one line each:

- **Service** (`service/poll/`, `service/routes/`): a new `runs.json` document beside the unchanged-shape `events.json`; run key + correlation id derived by hashing the run key; coalescing at enqueue; lease-issuing claim; `reserve → result/abandon/blocked` authorization family; a boot-plus-periodic expiry sweep (`claimed` → `pending` on lease expiry only; `starting` → `unconfirmed` on result deadline); retry / dead-letter requeue / operator resolve; run-history projection; a correlation-filtered audit read route.
- **Panel** (`src/`): reserve-before-`startSession()`; a durable per-attempt record in `host.storage` written between the host call and its result report; mount-time reconciliation before the first claim; attempt-scoped handled-list rules; guard refusals reported as `blocked:*` instead of "dispatched"; multi-reference bounded excerpt; readable labels/reasons for every state; the "not listed?" picker guidance; the first-run prerequisites section; an audit-history view for one run.
- **Nothing else moves**: no GitHub write, no status projection change, no rename, no per-row affordance restructuring, no settings or prompt work — those are 005's, 006's, and 004's.

## Scope discretion (required by the spec's Status line)

The spec at v1.3.0 lets Phase 4 either plan the whole amended document or scope to v1.0.0 and leave each recorded delta to its own feature. **This plan scopes to 003's own normative body — the requirement text, which is byte-identical from v1.0.0 through v1.3.0 — and implements none of the recorded extensions:**

| Amendment | What it records | Disposition in this plan |
| --- | --- | --- |
| v1.1.0 (004) | prompt snapshot/fingerprint scalars on the run row, `dispatch.reserved`/`dispatch.result`, and the `binding.prompt-updated` audit type | **004's work.** 003 designs the run history row and the audit write path additively so the fields slot in without a rename or a re-cut (no field is closed; `binding.` is outside the `dispatch./run./agent.` lifecycle prefixes). |
| v1.2.0 (005) | the one supersession: the `Status` wire row; plus placement of FR-015's reveal, FR-033/FR-041's per-row affordances, FR-053's copy control, the rename | **005's work.** 003 does not touch `service/routes/status.ts`'s polling block, does not build the tab IA, and does not rename anything. 003 ships the semantics those features will render. |
| v1.3.0 (006) | the requeue budget is **not** a configuration field | Honoured: `MAX_AUTO_REQUEUES = 3` is a module constant, never a config field. |

Cross-feature notes this plan records for later Phases 4 (not work here): (a) FR-031's configurable lease/result-deadline bounds become two new `ServiceConfig` fields, which 006's Settings tab will render (they have live consumers — the sweep — so they are not the inert-field case 006 rejected); (b) 005's Dispatches tab consumes 003's state vocabulary and refusals verbatim.

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` (`AGENTS.md` invariant 7) |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` and **committed** (invariant 1) |
| Service runtime | Node ESM, host-spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE`; `service/main.js` built with `bunx openchamber-guest-bundle --node` and **committed** (invariant 1) |
| Service dependencies | Node stdlib only — no framework, no native modules (unchanged; 003 adds no dependency) |
| Storage (service tier) | JSON + append-only NDJSON under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename). 003 adds **one** file: `runs.json`; `events.json`, `audit.ndjson`, `scan-state.json`, `config.json`, `state.json` evolve in place |
| Storage (panel tier) | `host.storage` (64 KiB/value, 2 MiB namespace, uninstall-wiped). 003 adds one key: `mecha-turk:dispatches` (the FR-024 durable attempt record); existing keys `:project`, `:evidence`, `:ledger` keep their meaning (invariant 4) |
| Testing | vitest `5.0.2`, fully offline: fake host (`tests/support/panel.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`). No live OpenChamber, no PAT, no network (AGENTS.md testing philosophy) |
| Target platform | OpenChamber desktop and web only (unchanged); SDK pinned `@openchamber/sdk` `1.24.2` exact (invariant 6; NFR-110 — **no re-pin in 003**) |
| Scale | <10 bound repositories, one logical service instance, one operator machine (FR-004) |
| Detection latency | reservation adds at most one round trip per dispatch; p95 ≤ 2 × poll interval (NFR-101, SC-110) |

## Constitution Check (v1.3.0) — alignment statement

> **003 aligns with every principle and every security/quality gate of constitution v1.3.0. There are no constitutional violations, therefore no complexity-tracking rows and no exceptions to record.** The feature exists to make constitution III (durable and idempotent work) and IV (human-visible auditability) true of the shipped loop; II (safe autonomy) supplies the fail-closed posture; VI (specification and verification) is why the crash-permutation set is an automated task (NFR-102). Re-read after design (below) — alignment unchanged.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Discovery stays outbound polling over the same adapter; the panel↔service boundary becomes a versioned contract set ([contracts/](./contracts/)); webhooks stay a future adapter (002 FR-010/NFR-010 standing) |
| **II. Safe autonomy by default** | Fail-closed everywhere ambiguity exists: stale/superseded/consumed authorizations refused (FR-022), `unconfirmed` never auto-expires (FR-023), claim eligibility is the service's alone (FR-037), every refusal names its cause and writes an audit row (FR-003) |
| **III. Durable and idempotent work** | Runs/leases/tokens live in the service store; single-use tokens + the impossibility requirement (FR-028) make a second session unconstructable; coalescing kills the dual-trigger duplicate (FR-011); the lease-expiry sweep recovers stranded claims (FR-032); migration loses nothing (FR-005, NFR-103) |
| **IV. Human-visible auditability** | The spec's sixteen-entry dispatch-lifecycle vocabulary (plus the FR-003 refusal row), run correlation id on every lifecycle row (FR-062), prior/new state + actor + reason on every transition (FR-044), and an in-product correlation-filtered audit read (FR-053, FR-064) |
| **V. Minimal, self-hosted deployment** | No new process, container, dependency, or control plane; one new store file; stdlib-only service unchanged |
| **VI. Spec before implementation** | This plan + [research.md](./research.md) + [data-model.md](./data-model.md) + [contracts/](./contracts/) land before code; the crash-permutation suite, the migration suite, and the vocabulary suite are named tasks, not aspirations |
| **VII. Thin orchestration boundary** | The host still owns projects/worktrees/sessions/agents; no host capability, API, or permission is added (NFR-110); the panel still creates sessions only through `host.startSession()`/`openSession()`/`listProjects()` |
| **Security Std (secrets)** | PATs never leave the service store (unchanged); new run record, source references, audit rows, and the panel attempt record are credential-free by construction and scanned by the existing suites, which gain cases (NFR-106, AC-120) — never exemptions |
| **Security Std (unattended dependency)** | Unchanged: dispatch still requires the panel mounted; the service's sweep keeps polling/queue work honest while OpenChamber runs |
| **Security Std (durable state)** | Runs and the dispatch-lifecycle audit live in the service store (0600/0700), not `host.storage`; the panel's attempt record is explicitly a reconciliation aid, never an audit home (FR-024 + 002 FR-034) |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any`; offline contract/unit suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (invariants 1, 7) |

**AGENTS.md non-negotiable invariants honoured by this plan** — (1) committed bundles ship: every wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` in the same commit; (2) one document, two roles: no `version` bump in 003 (a bump is a release decision; if one occurs, `service/routes/health.ts` `SERVICE_VERSION` and `tests/service-server.test.ts` move with it); (3) `capabilities[]` stays `["sessions","prompt"]`, `contributes.service` gains no `permissions` key; (4) kebab-case identity unchanged — panel id `mecha-turk`, `host.storage` keys keep the `mecha-turk:` prefix (`:dispatches` is added, nothing renamed); (5) `SERVICE_VERSION` mirrors `package.json` (untouched); (6) SDK pin untouched; (7) zero suppressions, zero `any`; (8) fail-closed parsing — every new reader (`runs.json`, the widened delivery parser, the run-history DTO, the attempt record) refuses malformed input instead of partially applying it; (9) secrets never leave the service store — the dispatch token is an authorization artifact, not a credential, and is named `dispatchToken` so the credential-key guard (`stripCredentialKeys`'s `^token$`) never strips it from the panel record while secret-shape scans still pass; (10) `extension-spike-1` evidence schema and the delivery id format are compatibility surfaces and do not change (FR-012, AC-104).

## Requirement → module mapping (what satisfies what)

| Spec group | Satisfied by (service) | Satisfied by (panel) |
| --- | --- | --- |
| **A. FR-001–005** (authority, GitHub-read-only, fail-closed, single instance, upgrade) | FR-005 one-shot adoption pass (`service/poll/runs-adopt.ts`); FR-003 refusals + audit on every route in `service/routes/dispatch.ts`; FR-002/FR-004 are constraints checked by existing + new tests | FR-003 panel-side refusal copy (`src/relay.ts`); FR-002 enforced by the existing static no-GitHub-write scan, extended over new modules |
| **B. FR-010–017** (runs, coalescing, delivery id, source refs, excerpt, audit) | run key/correlation derivation (`service/poll/run-key.ts`); coalescing inside `enqueueEvents` (`service/poll/events.ts`) + `runs.ts`; `run.created`/`run.coalesced`/`run.migrated` rows (`service/audit.ts` vocabulary); delivery id untouched (`events-write.ts` `buildEventId`) | multi-reference bounded excerpt (`src/session.ts` `buildBoundedContext`, FR-014); primary label + reason-count on the run row (`src/runs-rows.ts`, FR-015's reveal control is 005's) |
| **C. FR-020–028** (single-use authorization, impossibility) | `reserve`/`result`/`abandon` routes + token mint/consume (`service/routes/dispatch.ts`, `service/poll/runs.ts`); refusal matrix (FR-022); deadline → `unconfirmed` (`service/poll/sweep.ts`) | reserve-before-`startSession()` + durable attempt record + reconcile-before-claim (`src/relay.ts`, new `src/dispatch-record.ts`, `src/reconcile.ts`); attach id = correlation id (`src/session.ts`, FR-029) |
| **D. FR-030–037** (leases, sweep, budget, handled list, eligibility) | lease-issuing claim (`service/poll/events.ts` `claimRuns`); boot + periodic sweep; `MAX_AUTO_REQUEUES` dead-letter park; claim eligibility filter (FR-037); retry validity (FR-041) | handled list keyed `correlationId#attempt`, cleared only per FR-034 (`src/relay.ts`); refuses anything not offered claimed (FR-035); closed panel burns nothing is service-side (FR-036) |
| **E. FR-040–044** (honest outcomes) | problem-result → `failed` (not `dispatched`); `blocked:<reason>` report path; `dispatch.retry`/`run.blocked` rows; verification row write | failure tone/label (`src/runs-rows.ts`), blocked guard reports instead of "drained", verification report (`src/agent-verify.ts` → new route) |
| **F. FR-050–054** (one correlation id) | service mints the run's correlation id once (hash of run key) and persists exactly what it has; detection rows carry it; audit read with `correlationId` filter (`service/routes/audit.ts`) | panel never mints: claim echo only (`src/relay.ts`, `src/ledger.ts` entries); audit history view (`src/audit-view.ts`) |
| **G. FR-060–065** (audit vocabulary, row shape, visibility, retention) | the 16 `run./dispatch./agent.` event types written at their transition points + `dispatch.refused`; `AuditEntry` already has the FR-061 shape — 003 adds vocabulary + correlation discipline (FR-062) + visible failure (FR-063) | FR-063 warning surfacing when a report or audit-backed write failed (`src/relay.ts`, `src/panel-actions.ts`); FR-043 visible verification outcome on the row |
| **H. FR-070–075** (operator surfaces) | none (all panel-side) | "not listed?" in the picker (`src/project-picker.ts`, FR-070); prerequisites section (`src/prerequisites.ts`, FR-071–073); state labels + reasons (`src/runs-rows.ts`, FR-074); FR-075 is a no-op here (rename is 005's) |

## Already built vs. changed vs. new

### Already built — do NOT re-touch (002 shipped, live-validated)

- **Service transport/security**: loopback server, bearer auth, body/size caps, route table mechanics (`service/server.ts`, `service/http.ts`, `service/auth.ts`, `service/pipeline.ts`), consent (`service/consent.ts`), throttles (`service/throttle.ts`).
- **Credential custody + accounts**: `service/accounts/`, `service/routes/{accounts,verify,credential}.ts`, `service/github.ts` verify path.
- **Bindings**: `service/bindings.ts`, `service/routes/bindings.ts`.
- **Polling/discovery**: `service/poll/{poller-github,poller-entries,triggers,loop,timer}.ts` trigger detection, windows, rate budget, checkpoints-as-scan-state; `service/pipeline.ts` normalization.
- **Store/audit mechanics**: `service/store/*` (0700/0600, atomic writes, quarantine funnel), `service/audit.ts` writer (seq chain, redaction pass, `AuditEntry` shape — 003 *adds vocabulary rows through it*, does not rewrite it).
- **Config/health/status**: `service/config.ts`, `service/routes/{config,health,status}.ts` — **`status.ts`'s hardcoded polling block is untouched (005)**.
- **Panel**: token handoff + consent (`src/handoff*.ts`, `src/consent*.ts`), accounts mirror, bindings UI (`src/repos*.ts`), evidence (`src/evidence.ts`), redaction (`src/redaction.ts`), ledger mechanics (`src/ledger.ts` write path — entries keep their shape; only the correlation id they *carry* changes), project resolution, agent verification mechanics (`src/agent-verify.ts` openSession read-back — 003 adds the report, not the read-back), lifecycle mount bookkeeping.
- **Invariants**: delivery id format (`buildEventId`), evidence schema `extension-spike-1`, manifest (except nothing), SDK pin, bundles' build pipeline, existing 563-test suite stays green.

### Changed (existing behaviour/shape moves)

| # | Change | Where | Specs |
| --- | --- | --- | --- |
| C1 | Claim flips `pending → in-flight` with a stamp → claims **runs** with a lease (id, attempt, issue, expiry, holder) | `service/poll/events.ts`, `service/routes/events.ts` | FR-030, FR-037 |
| C2 | Result route marks the event dispatched for `{sessionId\|problem}` → run-scoped, token+attempt body, idempotent duplicate audited, stale refused; a problem result becomes `failed` | `service/routes/events.ts` → `service/routes/dispatch.ts` | FR-022, FR-040, wire delta |
| C3 | Retry (`in-flight → pending`, `dispatched → 409`) → run-scoped retry from `failed`/`blocked:*`, distinct refusals, attempt++, audit row | `service/routes/events.ts` | FR-041 |
| C4 | `GET /v1/events` projects queue rows → projects runs (state, correlation id, run key, ordinal, attempt, source references, attachment id, project, worktree option, lease expiry, session ref, verification outcome, state reason) | `service/routes/events.ts` | wire delta, FR-005 |
| C5 | Enqueue dedupes on delivery id only → enqueue dedupes **and coalesces into/creates runs** inside one chain; detection audit carries the run's correlation id | `service/poll/events.ts`, `service/poll/loop.ts` | FR-011, FR-016, FR-017, FR-050 |
| C6 | Delivery row lifecycle fields → delivery rows keep their legacy `state` untouched (projection input only, never rewritten) and **new** rows omit it; `runCorrelationId` + `subjectType` added as absentable fields | `service/poll/events-parse.ts`, `events-write.ts` | FR-005, FR-010, FR-012; 005 FR-005 |
| C7 | Panel relay: claim → immediately `startSession` → report → claim now: reconcile → claim → guards → **reserve** → persist outcome → report → verify | `src/relay.ts`, `src/app.ts` (mount order) | FR-021, FR-024, FR-025, FR-035 |
| C8 | Handled list: flat per-mount event ids → keyed `correlationId#attempt`, cleared only on terminal state or a new service-issued lease+attempt | `src/relay.ts`, `src/panel-state.ts` | FR-034 |
| C9 | Attach id `issue-<n>` → derived from the run's correlation id (identity derivation), displayed on the run row | `src/session.ts` | FR-029 |
| C10 | Bounded context: one issue excerpt (4,000 total / 1,200 body) → per-reference excerpts, ≤4,000 per source item, ≤12,000 per dispatch, visible truncation markers, all references included | `src/session.ts` | FR-014 |
| C11 | Guard refusals (binding/project) reported as `{problem}` → reported as `blocked:<reason>` with `run.blocked` audit; run never "dispatched" | `src/relay.ts` → new route | FR-042 |
| C12 | Ledger entries carry `eventId` as correlation → carry the run's correlation id (service-minted, echoed) | `src/relay.ts`, `src/panel-actions.ts` | FR-050, FR-051, FR-062 |
| C13 | Run row states/tones `pending \| in-flight \| dispatched` + `canRetry = state !== 'dispatched'` → eight-state vocabulary with label + reason line; retry offered only where the service accepts it | `src/runs-rows.ts`, `src/runs-service.ts` | FR-074, FR-041 |
| C14 | `expectedAgent`-style config untouched, but the config document gains `leaseMs` + `resultDeadlineMs` (bounded 30,000–600,000 ms, default 120,000) with the sweep as their consumer | `service/config.ts`, `service/routes/config.ts` | FR-031; cross-note for 006 |

### New

| # | New thing | Where | Specs |
| --- | --- | --- | --- |
| N1 | Run document `runs.json` (runs, per-subject ordinal counters, bounded) + its fail-closed parser | `service/poll/runs.ts`, `runs-parse.ts` | FR-010, FR-011, NFR-107 |
| N2 | Run key / correlation id / dispatch-token / attachment derivation (all hashes of the run key or its pair with the attempt) | `service/poll/run-key.ts` | FR-010, FR-020, FR-050, FR-029 |
| N3 | One-shot, non-destructive adoption of pre-existing queue rows via the migration table | `service/poll/runs-adopt.ts` | FR-005, NFR-103, AC-126 |
| N4 | Lease-expiry + result-deadline sweep: runs once at boot **before the server accepts a claim**, then on its own unref'd timer at `min(lease, deadline)/2`; dead-letters on budget exhaustion | `service/poll/sweep.ts`, armed from `service/main.ts` | FR-032, FR-033, FR-023 |
| N5 | Operations: **Reserve**, **Abandon**, **Block report** (`service/routes/dispatch.ts`) and **Verification report**, **Resolve**, **Requeue** (dead-letter → waiting), **Retry** widened (`service/routes/run-ops.ts`) — two modules so each stays inside the file-length gate | registered in `routes/index.ts` | FR-021, FR-026, FR-042, FR-043, FR-027, FR-033, FR-041 |
| N6 | Audit read: `GET /v1/audit?correlationId=&limit=&cursor=` — credential-free, read-only, paginated | `service/routes/audit.ts` | FR-053, FR-064 |
| N7 | Dispatch-lifecycle audit vocabulary: the spec's 16 event types written at their transitions + the `dispatch.refused` row (FR-003), correlation discipline per row | every transition site + `service/audit.ts` (vocabulary constants) | FR-060–063, AC-115, AC-116 |
| N8 | Panel durable attempt record `mecha-turk:dispatches` (written between the host call and its report) | `src/dispatch-record.ts` | FR-024 |
| N9 | Mount-time reconciliation before the first claim; bounded, idempotent, warns on bounded failure | `src/reconcile.ts`, `src/app.ts` | FR-025, AC-111 |
| N10 | Operator resolutions for `unconfirmed` (two explicit choices, confirmation copy, audit) | `src/relay.ts` actions + `src/runs.ts` action wiring | FR-027 |
| N11 | "Not listed?" picker guidance (three manual add-project routes), binding stays recoverable | `src/project-picker.ts` (+ repos UI wiring) | FR-070, AC-121 |
| N12 | First-run prerequisites section: six prerequisites, `met \| not-met \| not-checkable`, per-item remediation, unmet→visible notice | `src/prerequisites.ts` + `src/panel-ui.ts`/`src/app.ts` | FR-071–073, AC-122 |
| N13 | In-product audit history for one run (select a run → read its rows under the correlation id) | `src/audit-view.ts` + `src/runs.ts` actions | FR-053, AC-117, SC-105 |
| N14 | Automated crash-permutation suite + migration suite + vocabulary suite (offline) | `tests/crash-permutations.test.ts`, `tests/service-migration.test.ts`, `tests/audit-vocabulary.test.ts`, `tests/service-sweep.test.ts`, `tests/reconcile.test.ts`, `tests/prerequisites.test.ts` | NFR-102, SC-101/102/104, AC-110, AC-115 |

**Per-requirement headline split** (the tables above expand it): already built = the transport, custody, polling, store, config, and panel-UI substrate every requirement below sits on; changed = C1–C14; new = N1–N14. Group A's FR-001/002/004 are conformance-verified rather than built (they are posture), FR-003 is changed+new (refusals exist, their audit discipline is new), FR-005 is new. Group H is entirely new panel work except FR-075 (no-op).

## Architecture (decided)

### The run model on the wire and at rest

```
delivery (events.json — unchanged id, immutable observed fact, + runCorrelationId on new rows)
   │  coalesce at enqueue (FR-011): join the subject's open run, else create next ordinal
   ▼
run (runs.json — runKey, correlationId = mt-run-sha256(runKey)[0:24], ordinal, state,
     attempt, requeuesUsed, sourceReferences[], lease?, reservation?, attempts[],
     session?, verification?, stateReason, attachmentId)
   │
   │  claim (lease) → reserve (single-use dispatchToken) → startSession → result/abandon
   ▼
audit.ndjson — 16 lifecycle types, entity = run, correlation = the run's id (FR-061/062)
```

- **Run key** (FR-010): `github|<accountNumericUserId>|<owner/name>|<issue|pull_request>|<number>|<ordinal>`. Ordinal is 0-based per FR-010's literal definition ("the number of already-terminal runs for that subject"), counted from a durable per-subject counter in `runs.json` — **not** from the live run set, because terminal runs are evicted by the bounded history and "numbering is continuous and never reused" (edge case) would then break.
- **Correlation id** (FR-050): `mt-run-<sha256(runKey) hex[0:24]>` — path-safe, single segment, re-derivable by the service, matches the attach-id convention 001's contract established. Minted only by the service; the panel echoes (FR-051).
- **Attachment id** (FR-029): the correlation id itself (identity derivation). One copyable string locates the audit chain *and* the session in OpenChamber's list; distinct per ordinal, which fixes the shipped `issue-<n>` collision between two runs for one issue. ≤128 chars (`GUEST_ATTACH_ID_MAX`) ✓.
- **Dispatch token** (FR-020): `dtk-<sha256(`${runKey}|${attempt}`) hex[0:32]>` — single path-safe segment, minted **at reservation**, never at claim, single-use. The name `dispatchToken` is used on the wire, in the panel record, and in audit details so `stripCredentialKeys`' `^token$` rule never strips it while secret-shape scans stay clean (research §R3).
- **Attempt counting (the reading this plan adopts)**: `attempt` starts at 1; **claim** issues a lease carrying the current attempt (the diagram's `claim (+attempt)` annotation = the claim is made *under* an attempt); **lease expiry** and **operator retry** are the incrementing events (FR-032's "attempt before and after" and FR-041's "increment" are only meaningful if the expiry/retry is the increment — this is why the audit details read 1→2 rather than 2→2). The automatic requeue budget is a **separate counter** (`requeuesUsed`, cap 3) so an operator retry never inflates or resets it; only an expired claim-without-reservation increments it (gate question 3, FR-036).
- **State machine**: exactly the spec's eight states and transitions (table in [data-model.md](./data-model.md)); `blocked:<reason>` is a prefix family validated as prefix + non-empty reason.

### Wire operations (delta against 002's contract)

Full request/response shapes, status codes, and the error catalog additions are in [contracts/](./contracts/). Summary: Claim (path kept, now run-shaped), **Reserve** (new), Result (kept path, addressed by run, body gains `dispatchToken` + `attempt`), **Abandon** (new), **Retry** (semantics widened), **Resolve** (new), **Requeue** (new — FR-033's return-to-waiting), **Block report** (new), **Verification report** (new), Run history (projection widened), **Audit read** (new), Status (untouched — 005).

Three operations the spec's `## Wire Surface Delta` table does not *name* but its own normative text requires are added here, which is the table's own preamble delegating "exact field names, status codes, and error-code additions" to Phase 4:

1. **Block report** — `run.blocked`'s actor is the **panel** (audit vocabulary) and FR-042 requires the guard refusal to *hold the run* in `blocked:<reason>`; only a panel→service report can do that.
2. **Verification report** — `agent.verified`/`agent.mismatch` are **panel**-actor rows and the service owns `audit.ndjson` (002 FR-033/035); FR-043 requires the outcome on the run row, which is a service projection.
3. **Requeue** — FR-033 requires an explicit operator action returning a dead-lettered run to waiting with the attempt reset, reachable through the existing select-then-act idiom (the per-row affordance is 005's).

Paths stay under `/v1/events*` with the same suffixes the panel already posts to where they exist (additive-within-v1, per contract §1 versioning and 005's confirmed L3 retention): the *namespace* of `:id` becomes the run's correlation id, which is a deliberate semantic change called out in the contract — panel and service ship as one committed bundle (invariant 1), so no versioned client exists to break.

### Panel dispatch sequence (the new relay tick)

```
mount  → reconcile(): for each stored attempt with an outcome and no acknowledgement
              → re-POST result/abandon (idempotent; duplicate → exactly one audit row)
              → bounded total time; bounded failure → visible warning (never silent)
              → then startRelayPolling()            [FR-025: before the FIRST claim]
claim  → GET /v1/events/pending?holder=<mountId>    → runs in pending, each with a lease
for each claimed run:
   guards (binding present+active, project resolves)      → refused → POST .../blocked
   reserve(correlationId, leaseId, attempt)               → dispatchToken + expiry
                                                          (refusals: stale/already-reserved/
                                                           already-dispatched → no host call)
   persist attempt record (token, outcome pending)        [FR-024 ordering: durable first]
   host.startSession({... attachmentId = correlationId, data.correlationId, bounded excerpt })
   persist outcome (sessionId | failure reason) — BEFORE the report  [FR-024]
   POST .../dispatched (sessionId | problem) → acknowledged := true
   POST .../verification (agent read-back)                 [FR-043, warn-only]
   handled[correlationId#attempt] := true                  [FR-034]
```

Ordering that makes the impossible-by-construction property true (FR-028): *claim is offered only from `pending`; `startSession` happens only with a live lease, an unconsumed token whose attempt is the run's current attempt, and no recorded session; the service enforces all five conditions server-side at reserve and refuses everything else before the panel could act* (the panel independently refuses, so either side alone fails closed).

### Sweep (recovery)

- **Boot**: run once in `service/main.ts` before the HTTP server starts accepting requests, so a restart recovers stranded claims before the first claim is served (FR-032; edge case "panel killed while the service is also restarting" → the row notes the recovery followed a restart).
- **Periodic**: unref'd timer at `min(leaseMs, resultDeadlineMs) / 2` (default 60 s), independent of the poll interval, because a configured 300 s poll interval must not push the lease sweep past "at least once per lease duration".
- **Rules per tick**: `claimed` + no reservation + lease expired → requeue (`attempt++`, `requeuesUsed++`, `dispatch.lease-expired` row; budget exhausted → `dead-lettered` + `run.dead-lettered`); `starting` + no result + deadline passed → `unconfirmed` + `dispatch.unconfirmed` (never back to waiting, never auto-expires — FR-023); nothing else is touched (FR-036: a `pending` run burns nothing). Only the service's clock is read (NFR-112).

## Migration & rollout strategy (what happens to in-flight events across the upgrade)

**One-shot, non-destructive adoption, executed at the first `runs.json` read of the upgraded service** (before the sweep and before any claim), per the spec's migration table:

| Stored row (written by the shipped build) | Becomes | What happens next |
| --- | --- | --- |
| `pending` | run `pending` (attempt 1, no lease) | dispatched normally on the first claim after the upgrade; **no attempt consumed by the upgrade itself** (FR-036) |
| `in-flight`, no reservation recorded | run `claimed` with an **already-expired lease** | the boot sweep requeues it **once** — `attempt 1→2` — audited as a **migration recovery** (`dispatch.lease-expired`, reason names the adoption), *not* a normal expiry, and **not charged against the automatic requeue budget** (the budget bounds crashed-panel loops; a one-shot migration cannot loop — recorded as this plan's reading of the table's "migration recovery, not a normal expiry" clause) |
| `in-flight` with a reservation recorded | run `starting`, subject to the result deadline | vacuous for rows the shipped build can write (no reservation op exists) but implemented and unit-tested from a synthetic row, so the table is honoured in full |
| `dispatched` with a session id in the result | run `dispatched` | terminal, carried through unchanged |
| `dispatched` with a problem string in the result | run `failed` | **classified, not guessed**: a result matching the shipped panel's closed problem vocabulary (`binding-missing-at-dispatch`, `no-session`, `bootstrap-failed`, `session-create-failed`, and `resolveProject`'s three strings) → `failed` and retryable; anything else → treated as a session id → `dispatched`, because ambiguity is a stop condition and the safe direction for an unrecognised value is *never re-dispatch* (FR-003, constitution II). The branch taken is recorded in the `run.migrated` row's details so the classification is auditable |

**Non-destructive guarantees** (FR-005, NFR-103, AC-126): legacy delivery rows are **never rewritten** — their `state` stays byte-identical (005 FR-005's "projects through the migration table rather than being rewritten in place"); linkage for adopted rows lives on the run side (`run.sourceReferences[].deliveryId`) and in the one `run.migrated` row each. No file is quarantined (both delivery shapes parse), no binding's `scan-state.json` window is touched, no `host.storage` key is cleared, no audit row is removed. The existing quarantine-recovery path (window reset + `delivery.recovered`) is unchanged and remains reachable for genuine corruption — it is simply never triggered by the upgrade.

**Rollout mechanics**: panel and service ship together in one commit (invariant 1 — bundles rebuilt), so the run-shaped claim and the run-keyed result path never meet a mismatched peer; `version` stays `0.0.1` (bump is a release decision, invariant 2); `SERVICE_SCHEMA_VERSION` stays `1` (the store-level marker's meaning — "a format this build understands" — is unchanged by an additive file; `runs.json` carries its own document `schemaVersion`, see [data-model.md](./data-model.md)). Upgrade validation is a named test: seed a store in the shipped vocabulary, start the service against it, assert every row adopted, every window intact, zero quarantine files, one `run.migrated` per run, and the pre-existing `dispatched`-with-problem row rendering `failed` and retryable (AC-126).

**In-flight panel across the upgrade**: a panel built by 003 never meets a pre-003 service (same bundle). An operator upgrading with the service running simply gets the new service; the old panel's `evt-…` result posts would 404 — impossible while the bundle ships both halves together; this is stated in the contract as the co-ship assumption.

## Key decisions and rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Two stores: `events.json` (deliveries, shape unchanged) + new `runs.json` | FR-012 puts the run link *on the delivery*; keeping the delivery file's top-level shape means the upgrade cannot quarantine it, and the run model gets one atomic home | one merged file (rewrites the delivery file wholesale; a parse regression then loses both layers at once) |
| D2 | Write order inside the enqueue chain: `runs.json` first, then `events.json` | a crash between them leaves a run missing one reference — self-healing on re-detect (delivery id absent → re-enqueued → coalesces) — whereas the reverse order leaves an orphan delivery pointing at a missing run | parallel/one-file writes (no cross-file failure story) |
| D3 | Per-subject ordinal counter lives in `runs.json` | terminal runs are evicted; counting live/retained runs would reuse ordinals after eviction, violating "numbering is continuous and never reused" | deriving ordinals from `run.created` audit rows (retention-trimmed → reuse) |
| D4 | Lease granted at claim; token minted **only** at reservation | matches FR-021/FR-022 exactly; a claim-issued token would be minted for attempts that never intend to dispatch (and would collide after FR-033's attempt reset) | token-per-claim (violates the reservation-before-authorization order) |
| D5 | `requeuesUsed` separate from `attempt` | gate Q3: only an *expired claim* consumes the budget — a retry increments `attempt` without consuming budget; one counter cannot express both | deriving budget from `attempt` (operator retries would silently exhaust the automatic budget) |
| D6 | FR-033 reset clears attempt **and** attempt-scoped token consumption, preserving attempt-history rows | `token = f(runKey, attempt)` (FR-020) plus "reset the attempt count" (FR-033) would otherwise re-derive a consumed token, which FR-022 would then refuse forever — making the mandated resolution action dead-end. The reset is an explicit, audited operator action; history rows survive (constitution IV) | adding an epoch to the token derivation (violates FR-020's "derived from that pair") |
| D7 | Staleness axes differ: **reserve** is bound by the lease (expired → `stale-lease`, AC-109); **result/abandon** are bound by the token (unknown / consumed-with-a-different-outcome / superseded by a newer attempt → refused; identical repeat → `dispatch.duplicate-report`) | a result authorizes nothing new — the session it reports already exists or doesn't — so AC-111's reconciliation (remount after lease expiry) must succeed while AC-109's *late authorization* still fails. The wire delta itself says the result body carries token + attempt, not a lease | lease-time-stamping results (strands every reconciliation into `unconfirmed`, contradicts US3/AC-111) |
| D8 | Adopted-`dispatched` classification: shipped problem vocabulary → `failed`, else `dispatched` | the shipped route stored `sessionId ?? problem` in one string; the problem set is closed in this repo, and the fail-closed direction for anything unrecognised is "assume a session exists" (never a second session) | shape-guessing session ids (a problem string that looks id-like would become terminal-dispatched… and an id that looks problem-like would become re-dispatchable — the catastrophic direction) |
| D9 | Lease + result deadline as `ServiceConfig` fields (30,000–600,000 ms, default 120,000) | FR-031 *requires* configurable bounds with a stated default; unlike the requeue budget they have a live consumer (the sweep), so they are not the inert-field case | hand-editing `config.json` (not "configurable" in any operator-meaningful sense); env vars (removed by 006 FR-092) |
| D10 | Audit history is a panel view over the new `GET /v1/audit` route | FR-053 demands retrieval "through an operator-reachable surface, without file access, credential-free" — the bearer token is service-side, so the raw route alone is not operator-reachable | pointing operators at `audit.ndjson` (file access, explicitly excluded); deferring to 005 (005's own wire table says "audit read: as specified by 003") |
| D11 | Source-reference list capped (20 refs), overflow still audited per delivery, run row shows a truncation flag | FR-013 (one per delivery) vs NFR-107 (bounded) can only both hold with a visible bound; 20 × 600-char trigger excerpts = 12,000 = exactly 002 FR-028's dispatch budget | unbounded list (violates NFR-107); dropping overflow deliveries silently (violates FR-016) |
| D12 | Prerequisite truth table: Default Agent = **not checkable**; zero bindings ⇒ "registered project per binding" = met (nothing to satisfy) | FR-072 forbids a reassuring state the panel cannot verify; FR-073 forbids nagging a met checkable item | marking the project prerequisite not-met on a fresh install (nags with nothing actionable) |

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Migration misclassifies a legacy `dispatchResult` (D8) | worst case: a second session, or a stuck row | closed problem vocabulary + fail-closed default + the branch recorded in `run.migrated`; upgrade suite asserts both classes (AC-126) |
| Attempt/token/reset tension (D6) resolved wrongly | a resolution path that dead-ends or a token reused | unit suite covers reserve → consume → dead-letter → reset → reserve again; contract test asserts a consumed token is refused *within* a chain |
| Sweep vs. claim race (a lease expiring while a claim is in flight) | double claim | all queue+run mutations serialize on the existing single `inQueueChain` extended to cover `runs.json`; the sweep is a chain task like every other mutation |
| Boot sweep ordering (served before sweep completes) | a stranded claim served with an expired lease | sweep awaited in `service/main.ts` **before** the server binds; test asserts a pre-seeded `in-flight` row is requeued before any claim answers |
| Panel dies between `startSession` and record write | run stuck `unconfirmed` | this is the spec's designed outcome (FR-023) — operator resolves using project + worktree + attachment id (FR-027/FR-029); documented, tested as permutation 4 |
| New config fields surprise 006's enumerated Settings list | 006 renders 10 fields, config has 12 | recorded here and in 003's cross-feature notes; both fields have bounds and consumers, 006's Phase 4 renders what `GET /v1/config` returns |
| Round-trip latency (NFR-101) from the reserve step | dispatch slower | exactly one added call, made *before* the (up to minutes-long) `startSession`; SC-110 asserted by counting round trips in the relay test, not wall-clock |
| `events.json` growth with run-linked new rows (NFR-107) | store bloat | legacy eviction stays; new rows evict with their run's terminal state; reference cap (D11); attempt history bounded by the requeue budget |
| Audit rows lagging state on write failure (FR-063) | traceability gap | deliberate: state is not rolled back, the failure is logged **and** surfaced to the panel as a visible warning naming the run (AC-119 tests the simulated failure) |
| Scope bleed into 004/005/006 | rework, spec conflict | the scope-discretion table above; the out-of-scope guard in [tasks.md](./tasks.md); no task touches `status.ts`'s polling block, renames, prompts, or settings UI |
| Committed bundles forgotten | shipped code ≠ source (invariant 1) | every wave's exit criterion includes `npm run build` + `bundle.test.ts` green; `npm run verify` at wave boundaries |

## Out-of-scope guard (checked at every wave)

No GitHub write of any kind (FR-002; AC-128). No change to `service/routes/status.ts`'s polling block or the status projection (005). No runs-list interval cadence and no per-row action restructure (005) — 003 only makes the *semantics* of retry/resolve correct through the existing select-then-act idiom. No rename of copy, modules, or routes (005's four-layer mapping). No starting prompt (004). No settings CRUD UI (006). No policy profiles, retention/export, dedupe-index eviction, webhook adapter, multi-instance leases, work-completion tracking, or automatic cleanup (003 `## Out of Scope`). Promotion of verification to blocking stays out (FR-043).

## Project structure

### Documentation (this feature)

```text
specs/003-dispatch-integrity/
├── plan.md                 # this file (/speckit.plan)
├── research.md             # Phase 0: settled-by-reference + the four open questions, decided
├── data-model.md           # Phase 1: entities, state delta, store/ledger impact, audit rows
├── contracts/
│   ├── README.md           # index + supersession pointers (002 contract §2.4)
│   ├── claim-lease.md      # claim operation + lease semantics + claim eligibility
│   ├── dispatch-authorization.md   # reserve / result / abandon / blocked / retry / resolve / requeue / verification
│   ├── reconciliation.md   # mount-time reconciliation + idempotency + bounds
│   └── run-history-audit.md# run projection + correlation-filtered audit read
├── quickstart.md           # validation walkthrough (Phase 1 output)
├── tasks.md                # Phase 5 output (/speckit.tasks)
└── checklists/requirements.md   # pre-existing Phase-3 checklist (untouched)
```

### Source code (repository root — the real layout this plan changes)

```text
service/
├── poll/
│   ├── events.ts           # CHANGED: chain covers runs.json; enqueue coalesces; claim → lease; retry → run-scoped
│   ├── events-parse.ts     # CHANGED: delivery fields absentable; legacy state preserved, never rewritten
│   ├── events-write.ts     # CHANGED: new rows carry runCorrelationId + subjectType; buildEventId UNCHANGED
│   ├── runs.ts             # NEW: run CRUD on the single queue chain (join/create/requeue/dead-letter)
│   ├── runs-parse.ts       # NEW: Run document + validator (fail closed)
│   ├── runs-adopt.ts       # NEW: one-shot migration-table adoption
│   ├── run-key.ts          # NEW: run key, correlation id, token, attachment derivation
│   ├── sweep.ts            # NEW: lease + deadline sweep (boot + periodic)
│   └── loop.ts             # CHANGED: detection rows carry the run's correlation id (audit helper only)
├── routes/
│   ├── events.ts           # CHANGED: claim / history / retry (run-shaped)
│   ├── dispatch.ts         # NEW: reserve, result, abandon, blocked (the authorization family)
│   ├── run-ops.ts          # NEW: retry, requeue (dead-letter return), resolve, verification
│   ├── audit.ts            # NEW: GET /v1/audit with correlation filter
│   └── index.ts            # CHANGED: register the new routes
├── config.ts               # CHANGED: leaseMs + resultDeadlineMs (bounds + defaults)
├── main.ts                 # CHANGED: boot sweep before server start; sweep timer lifecycle
└── main.js                 # REBUILT + committed (invariant 1)

src/
├── relay.ts                # CHANGED: reconcile → claim → guard → reserve → persist → report → verify
├── reconcile.ts            # NEW: mount-time outstanding-attempt reporting (bounded, warns)
├── dispatch-record.ts      # NEW: mecha-turk:dispatches read/write (FR-024 ordering)
├── session.ts              # CHANGED: attach id = correlation id; multi-reference bounded context
├── panel-state.ts          # CHANGED: handled list keyed by correlationId#attempt; reconcile state
├── service-calls.ts        # CHANGED: path helpers for the new operations + audit read
├── runs-service.ts         # CHANGED: run DTO + strict parser (eight states)
├── runs-rows.ts            # CHANGED: labels, reasons, tones, retry validity per state
├── runs.ts                 # CHANGED: actions — retry / resolve / requeue / audit history
├── project-picker.ts       # CHANGED: "not listed?" guidance (FR-070)
├── prerequisites.ts        # NEW: six prerequisites, three states, remediation lines
├── audit-view.ts           # NEW: one run's audit history under its correlation id
├── agent-verify.ts         # CHANGED: report outcome to the service (warn-only unchanged)
├── app.ts                  # CHANGED: mount order — reconcile before startRelayPolling
└── main.js (panel/)        # REBUILT + committed (invariant 1)

tests/                      # offline: fake host, loopback service on temp dirs, fixture GitHub
├── service-runs.test.ts        service-sweep.test.ts        service-migration.test.ts
├── service-audit-read.test.ts  audit-vocabulary.test.ts     crash-permutations.test.ts
├── reconcile.test.ts           relay-integrity.test.ts      prerequisites.test.ts
└── (extended) service-events.test.ts, service-runs.test.ts, runs.test.ts, relay-arming.test.ts,
    session.test.ts, project-picker.test.ts, ledger.test.ts, bundle.test.ts, service-server.test.ts
```

**Structure decision**: no new directories, no new packages, no new dependencies. Service-side run logic sits beside the queue it extends (`service/poll/`), service-side operations get their own route module because `service/routes/events.ts` is already near the file-length gate, and panel-side 003 work is one module per responsibility (reconcile, record, prerequisites, audit view), matching the existing one-responsibility-per-module map in `AGENTS.md`.

## Complexity tracking

**None.** The constitution check passed without violations, so there are no violations to justify.
