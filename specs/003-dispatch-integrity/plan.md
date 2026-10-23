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
claim  → GET /v1/events/pending?holder=<mountId>&limit=1
                                                     [at most one claim per relay interval, FR-081]
for each claimed run (the answer carries one, FR-081):
   guards (binding present+active, project resolves)      → refused → POST .../blocked
   persist the PLACEHOLDER (unknown, dispatchToken null,  [FR-024: durable before the reservation]
                            authorizedAt null, lease id, project, worktree option)
   reserve(correlationId, leaseId, attempt)               → dispatchToken + expiry
                                                          (service verdict: delete the placeholder,
                                                           no host call; unreadable/absent answer:
                                                           keep it — the service may have reserved)
   fill the token + authorizedAt into that record          [no host call while the token is absent]
   host.startSession({... attachmentId = correlationId, data.correlationId, bounded excerpt })
   resolve the record in place (sessionId | failure) — BEFORE the report  [FR-024]
   POST .../dispatched (sessionId | problem) → acknowledged := true
   POST .../verification (agent read-back)                 [FR-043, warn-only]
   handled[correlationId#attempt] := true                  [FR-034]
```

Ordering that makes the impossible-by-construction property true (FR-028): *claim is offered only from `pending`, at most one run per relay interval (FR-081); `startSession` happens only with a live lease, an unconsumed token whose attempt is the run's current attempt, a record carrying that token, and no recorded session; the service enforces all five conditions server-side at reserve and refuses everything else before the panel could act* (the panel independently refuses, so either side alone fails closed).

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

---

# Amendment record — 003 v1.8.0 (2026-10-03): the actor allow-list gate

> **This section is a dated Phase-4 record added on 2026-10-03.** Everything above it is the plan of
> 2026-09-28 and is retained as written. The v1.8.0 amendment is **additive** (block I,
> FR-076 – FR-080, NFR-113, NFR-114, SC-112, AC-130 – AC-133) and re-cuts no existing requirement,
> renames no audit row, adds no audit event type, and changes no state, no lease, no token, and no
> wire path.
>
> **The actor identity and the per-binding `allowedUsers` field are
> [`002-agent-event-extension`](../002-agent-event-extension/plan.md)'s (002 v1.11.0); the panel
> rendering is [`005-panel-ia`](../005-panel-ia/plan.md)'s (005 v1.11.0).** What is missing and only
> this document can supply is the **decision** — the one place that answers *"may this run start a
> session at all?"*, which is word for word what `service/poll/dispatch-authorize.ts` already exists
> for.

## B.1 Scope of 003's half

| Requirement | What 003 builds | Where |
| --- | --- | --- |
| FR-076 | the gate **is** the authorization decision: inside the one `operateRun` chain task, after `judgeReserve` returns `null`, before any token is derived; the binding's stored `allowedUsers` read at that moment; **no second membership comparison anywhere** | `service/poll/dispatch-authorize.ts` |
| FR-077 | one verdict, one refusal code (`actor-not-allowed`), one `dispatch.refused` row carrying every denied login and its basis; nothing written to the run | `service/poll/dispatch-authorize.ts`, `service/poll/run-refusal.ts`, `service/poll/dispatch-audit.ts` |
| FR-078 | the refusal **blocks, never burns**: a fifth declared `blocked:` cause through the existing block report, no attempt and no requeue budget consumed, never touched by the sweep, retryable once the cause clears — and the retry re-checks the **live** policy | `service/poll/dispatch-block.ts`, `service/poll/run-operate.ts`, `src/relay-gates.ts` |
| FR-079 | a required, **value-free** `actorPolicy` detail (`'open' \| 'restricted'`) on `dispatch.reserved` and `dispatch.result`, written from the same read that made the decision | `service/poll/dispatch-audit.ts`, `service/poll/runs-types.ts` |
| FR-080 | bots can never be authorized and the gate adds **no** second bot predicate; a stored run carrying a bot-shaped or absent actor is **refused** | `service/poll/dispatch-authorize.ts` |
| NFR-113 | no policy in the trail: the **shape** only, never which logins are permitted | the `B-6` scan |
| NFR-114 | the gate costs nothing on the happy path | `B-7` |

**Not 003's**: the actor members and the field itself (002's), the `SourceReference` members' *semantics*
(002 FR-043/FR-044 — 003's `SourceReference` clause consumes them), and every rendered string (005's).

## B.2 Module map delta (003's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `service/poll/dispatch-authorize.ts` | `judgeActorPolicy` after `judgeReserve`; `run.actorPolicy` set on the admitted path; the read of the live binding | FR-076 – FR-080 |
| `service/poll/run-refusal.ts` | `actor-not-allowed` in `RunRefusalCode` | FR-077 |
| `service/routes/run-answer.ts` (status map) | the code → **409** | FR-077 |
| `service/poll/dispatch-audit.ts` | the `dispatch.refused` detail set for this code; `actorPolicy` on `reservedRow` and `resultRow` | FR-077, FR-079 |
| `service/poll/dispatch-block.ts` | `BLOCKED_REASONS` four → five | FR-078 |
| `service/poll/run-operate.ts` | the service-corroborated blocked-cause set widens to `{ binding-missing, actor-not-allowed }` | FR-078 |
| `service/poll/runs-types.ts`, `runs-parse.ts`, `runs-join.ts` | `SourceReference.actorLogin` / `.actorAttribution` (absentable, validated); `Run.actorPolicy: 'open' \| 'restricted' \| null` | FR-077, FR-079 |
| `service/poll/run-history-project.ts` | project `actorPolicy` and each reference's actor + basis; never a permitted login | FR-079, NFR-113 |
| `src/relay-gates.ts` | `BlockedReason` gains the cause; a `409 actor-not-allowed` reserve is reported through the **existing** block report, and `host.startSession()` is never called | FR-078 |
| `src/dispatches-service.ts`, `src/dispatches-rows.ts` | the DTO's new members; the new cause's label, reason, and retry validity | FR-078, 005 FR-044 |
| `contracts/dispatch-authorization.md` | §1 refusal row, §4 the fifth cause, §9 the gate's refusal, the error-code table | FR-077 – FR-079 |
| `contracts/run-history-audit.md` | the projection's new members | FR-079 |
| `contracts/claim-lease.md` | **unchanged**, with a dated note saying so | — |

## B.3 Key decisions — actor allow-list gate (added 2026-10-03)

> Numbered `D13…D20` to continue this plan's own `D1…D12` series rather than restating it; 002's and
> 005's amendments use their own `D`-series for the same reason.

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D13** | **The gate reads the bindings document inside the chain task, once, per reserve.** | FR-076 requires the *live* policy at the moment of authorization so an operator's edit takes effect on the next dispatch without a re-scan or a restart. The only reader that can give that is `service/bindings-read.ts`. The read is one small JSON file, bounded by dispatch rate rather than by request rate, and it is **off the hot path** relative to the multi-minute `host.startSession()` that follows. | A cached read invalidated on `writeBindings` (satisfies NFR-114's letter, but `ServiceStore` exposes no `stat`, so a hand-edited `bindings.json` would never be seen until restart — a worse staleness hole than the one read it saves); reading the policy from the run's snapshot (that is exactly the "decided at enqueue" behaviour FR-076 refuses, and it would make a tightened list take effect only on new runs). **Flagged** — see B.5. |
| **D14** | **The admitted predicate is `∃ r ∈ run.sourceReferences : isActorAllowed(r.actorLogin, binding.allowedUsers)`.** With no `allowedUsers` the run is admitted; a reference whose actor is absent, empty, or bot-shaped is a **refusal regardless of the policy**, because 002 FR-045(b) guarantees such a reference can only come from a hand edit and constitution II makes that a stop condition. | FR-077, ratified at the gate. The two rejected alternatives both wedge permanently, because a `blocked:*` run is non-terminal and new deliveries **join** it (FR-011): refusing when *any* reference is disallowed means a stranger's comment disables every dispatch on that issue forever; judging only the opening reference means a stranger's comment opens a run that an allowed user's later mention can then never authorize. Zero references under a restricted policy is a denial (no allowed actor can be shown); under an open policy it is admitted. | The two wedging rules above; and "the majority wins", which is not a policy anyone can state in one sentence. |
| **D15** | **A policy the gate cannot read is a denial, with the cause in the message.** An absent binding id, a quarantined bindings document, and a document whose validation failed all answer `actor-not-allowed` with a message naming which of those it was. | FR-076 says the service reads the live binding table; a gate that answers "allowed" when the table is unreadable would be fail-open, which constitution II and 002 FR-024 both forbid, and it would be the *only* fail-open path in the operation. `run-refusal.ts`'s existing guarantee — each refusal carries its own distinct reason — makes one code with four honest messages fit the declared vocabulary. | A new refusal code `binding-unreadable` (FR-078 declares **one** new code; a second is a wire addition no requirement asks for, and it would widen the closed `dispatch.refused` vocabulary for a case the panel cannot act on differently); treating an unreadable table as open (fail-open). |
| **D16** | **The gate sets `run.actorPolicy` on the admitted path and nowhere else.** `null` means "no authorization recorded yet" (an adopted or freshly enqueued run). | FR-079 requires the detail written "from the same read that made the decision", and 003's `### Key Entities` requires the run to *snapshot* the policy so a later read never has to re-derive it. Both audit rows therefore read the snapshot rather than re-reading the binding, which is also what makes the two rows provably agree. | Re-reading the binding in each audit-row builder (two reads, two chances to disagree, and `dispatch.result` happens after an operator could have changed the list — the row would then describe a policy that was not the one in force); storing the policy on the run at **enqueue** (the snapshot would then predate the decision, which is what FR-076 exists to avoid). |
| **D17** | **Retry corroboration widens the *service-corroborated* set, not the block-report vocabulary alone.** `run-operate.ts`'s `CORROBORATED_BLOCKED_REASON` becomes a two-member set, and the policy cause is re-evaluated with the **same predicate** `judgeActorPolicy` uses. | FR-078 requires the retry path to "re-check the live policy … exactly as it re-checks the live binding table for `blocked:binding-missing`". The shipped code already has exactly that mechanism for exactly that cause; widening a one-member constant is the smallest change that satisfies the requirement, and reusing the predicate is what makes "cannot be retried into a dispatch this gate would refuse again" true rather than aspirational. It also needs **no new state**: the denied actor is re-derived from the run's own references. | A stored `deniedLogins` on the run (a second copy of a fact the references already hold, and it would go stale the moment the operator edits the list); treating the policy cause as panel-reported only (that would let a retry be authorized without any policy check at all). |
| **D18** | **No new audit `eventType`.** The gate reuses `dispatch.refused` and adds one detail key to two existing rows. | `AGENTS.md` invariant 10 makes a vocabulary row a compatibility surface, and 003 has already paid that tax twice (`binding.prompt-updated` at v1.1.0, `agent.uncompared` at v1.7.0). A detail key is additive; a row is a surface. | A `dispatch.policy-refused` row (the same tax a third time, for no new information — the decision is `refused` either way). |
| **D19** | **The claim answer is unchanged.** The two new members ride the **run** and its **history projection**, not the relay's claim answer. | FR-076 forbids a second membership comparison, so the panel has nothing to decide from a claim; the audit rows are built service-side from the run in hand, so nothing needs the claim to carry an actor. Minimal diff on a wire surface that 003's own contract governs, and one fewer member in the answer that had to be byte-bounded. | Adding `actorLogin`/`actorAttribution` to `ClaimedRun`'s references (additive, but nothing reads them, and 003's `claim-lease.md` is explicitly **unchanged** by this amendment). |
| **D20** | **The panel maps the refusal; the service decides.** `src/relay-gates.ts` gains the fifth `BlockedReason` and, on a `409 actor-not-allowed` reserve, posts the **existing** block report with the service's own message as the `detail`. | FR-078 requires the block report and forbids a new operation; the panel already reports every other guard refusal through it. FR-076 separately forbids a panel-side pre-check, so this is a **reporter**, not a checker. | A panel-side guard mirroring `relay-gates.ts`'s existing membership pattern (003's own clarification row 21 rejects it: two implementations of one rule, and a check the requester performs on itself is a request for permission, not a grant); mutating the run on the refusal inside the reserve (breaks §1's "nothing is minted before the verdict", which every existing verdict depends on). |

## B.4 Constitution alignment (v1.3.0) — carried forward, re-read for this amendment

> The v1.8.0 entry records the same review; this table restates it for the gate rather than
> re-litigating it. **No principle is weakened.**

| Principle / gate | How the gate satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | The provider limitation that forces proxy attribution is recorded as a contract limitation ([`002/research.md`](../002-agent-event-extension/research.md) §R8), not papered over. No new feed, no webhook, no second API call. |
| **II. Safe autonomy by default** | The principle this gate serves. It does not weaken it in the one place it could — the **absent** list. Absence is *visible* (005 FR-092/FR-093 render it with a worded warning and a counted Status line), and the gate itself fails **closed** on an unreadable policy (D15). II forbids ambiguity, not openness. |
| **III. Durable and idempotent work** | Unchanged and unstrained: no extra round trip on any authorized path (NFR-114, `B-7`), and the actor is not part of the delivery identifier (002 FR-046), so a changed list cannot manufacture duplicate work. |
| **IV. Human-visible auditability** | The principle that **decided the gate's location**. One row, the exact cause, every denied login, each one's basis, and nothing dropped in a poll loop at 03:00 (SC-112). |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, or permission; no new store file; no new route. |
| **VI. Specification and verification before implementation** | Why this is four acceptance criteria and a scan, not a code change. |
| **VII. Thin orchestration boundary** | No host capability, no host call, no change to the `host.startSession()` framing. |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any` (invariant 7); offline suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (invariant 1). |

**`AGENTS.md` invariants — how the gate touches each of the ten.** (1) committed bundles ship;
(2) **no `version` bump** — a bump is a product-owner release decision, and this is a feature, not
a release; (3) `capabilities[]` untouched, `contributes.service` gains no `permissions`;
(4) kebab-case identity and every `mecha-turk:` key untouched; (5) `SERVICE_VERSION` untouched, still
pinned by `tests/service-server.test.ts`; (6) SDK pin untouched; (7) zero suppressions, zero `any` —
the predicate's input is `string | undefined` narrowed by the reader, never `any`;
(8) **fail closed** — the load-bearing one here: an unreadable policy, an absent actor, and a
bot-shaped actor are all denials (D14, D15); (9) secrets never leave the service store — a login is
public identity, not a secret, but the **permitted set** is configuration and must reach no trail,
record, projection, or bundle (NFR-113); (10) **`extension-spike-1` is a wire contract** — untouched,
and so is the delivery id format (002 FR-046).

## B.5 Flagged items (Phase-5 findings — decide at the gate, not in code)

1. **NFR-114's letter does not match the shipped code.** It reads *"The gate reads the binding table
   the authorization path already reads"* — but `reserveDispatch` today reads `config.json` and the
   run document, and **no** bindings document. So reading the live policy is, strictly, *a service
   store read that is not already made on that path*. **Decision adopted**: read it (D13), because
   the requirement's stated purpose — p95 unchanged, no extra round trip, no network — is met, and
   because the alternative (a `writeBindings`-invalidated cache) trades one JSON read for a
   permanent staleness hole the store API cannot close. **Recommended owner wording for a future
   amendment**: replace "the binding table the authorization path already reads" with "one read of the
   bindings document, which the authorization path does not otherwise make, off the hot path".
2. **The refusal code for an unreadable bindings document.** One code with an honest message (D15)
   rather than a new code. No requirement text changes either way; the choice is only which wire
   vocabulary the panel must recognise.
3. **A stale `stateReason` may name a now-permitted login.** After the operator adds a denied login
   to the list, the historical `run.blocked` row and the run's `stateReason` still name it. This is
   **allowed and intended**: NFR-113 forbids recording which logins the policy *permits*, and a
   row naming a denial that was true when written is a true statement about a past decision —
   the same posture 003 v1.7.0 recorded for the `agent.mismatch` rows it did not rewrite. The `B-6`
   scan is therefore written against a fixture whose permitted set is disjoint from everything the
   trail names, plus a second case asserting the *next* reserve's rows carry only the shape.

## B.6 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| A second membership comparison creeps in (the panel, the poll loop, the claim) | the `B-6` one-comparison source scan asserts the helper's identifier appears in exactly two files (002 plan D9); FR-076 forbids the others in requirement text |
| The verdict is placed before `judgeReserve` and pre-empts `already-dispatched` / `stale-lease` | `B-2` places it **after**, and `B-6`'s matrix re-asserts both existing verdicts on their own paths (003 AC-130) |
| A coalesced run's authorization becomes order-dependent | `D14`'s predicate is a set quantifier over retained references, so it does not depend on join order; `B-6` drives a three-reference run in both join orders |
| Widening `BLOCKED_REASONS` breaks the runs document's own parser | the parser validates `blocked:<reason>` as prefix + non-empty kebab reason, so the fifth value parses unchanged; `B-4` asserts the block report accepts it and **refuses a sixth** |
| The permitted list leaks into a log, a projection, or a bundle | the `B-6` NFR-113 scan runs over every audit-writing path, the run record, the projection, `GET /v1/audit`, and both committed bundles; the existing secret suites **gain cases**, never exemptions |
| NFR-114's latency promise is asserted and then quietly broken | `B-7` counts round trips and asserts counts, never wall-clock (NFR-112), on the authorized path and on the refused path |

## B.7 Out-of-scope guard for the issue-#9 block (checked at every task)

No detection-time filtering of the allow-list — detection records the actor and decides nothing
(002 FR-043; a filtered event leaves no audit row, which constitution IV forbids). No panel-side
pre-check (D20). No enforcement anywhere but `dispatch-authorize.ts`. No audit event type (D18). No
change to any existing state, lease, token, verdict, or refusal code. No change to the claim
contract (D19). No migration, shim, legacy default, or upgrade criterion. No team-, organisation-, or
role-based rule; no per-actor priority, rate, or quota. No bot admission. No recording of the
permitted set anywhere.

## B.8 Phase-6 task block for this amendment

The consolidated execution list lives in
[`002-agent-event-extension/tasks.md`](../002-agent-event-extension/tasks.md) §"Issue #9 block
(2026-10-03)"; 003's own tasks are `B-1 … B-7`.

---

### v1.13.0 amendment plan — 2026-10-22 (GitHub issue #72)

Appended to 003's task series as `T-046 … T-049`; no new phase, no service task. The decisions this amendment forces:

1. **Where the record's writes sit — recut at v1.15.0; this text supersedes the original ordering, which put the write *after* the reservation.** In `src/relay.ts`'s `tryDispatch`, after the guards and **before** `reserveRun`, the panel writes the **placeholder**: outcome `unknown`, `dispatchToken: null`, `authorizedAt: null`, the claim's `leaseId`, and the run's project and worktree option. After the reserve answers it **fills** the token and `authorizedAt` into that same record, and `host.startSession()` is unreachable while the record lacks the token. The invariant is *there is no moment at which the service holds a reservation this panel has not durably recorded* (FR-024); the superseded order left the reserve-to-record window untraced, and that window is one reading of the #207 failure. The `stillRunning` check stays where it is: a disposed panel abandons rather than filling a record it will never use. The budget and worktree floors sit inside `startRunSession`, so a **filled** record can exist for an attempt they then refuse — that path resolves the record to the failed outcome it reports, and a torn-down panel over-warns (contract §1). Decisions **D21–D24** carry the details.
2. **`dispatch-record.ts` is one writer surface over one key — recut at v1.15.0: document v3.** `recordDispatchIntent` writes only a placeholder (`unknown`, null token, null stamp); `fillDispatchToken` writes the token and `authorizedAt` into that record; `deleteDispatchIntent` removes it on a service refusal and on FR-045's never-authorized verdict; `recordDispatchOutcome` keeps taking `RecordedOutcome`, so the union still makes "record before you report" a type error when violated, and its read-back stays the runtime guard (the union itself is reviewed, not tested — invariant 7 forbids a negative test). The document is **`dispatch-attempts-3`**: `dispatchToken` is `string | null`, where `null` means the panel has not durably recorded a token — not that no reservation exists; `authorizedAt` stays nullable; `readDispatchRecord` still accepts `dispatch-attempts-1` and `dispatch-attempts-2`, because every row in them already carries a token. `dispatch-attempts-2` is **not** widened with a nullable token: an older build's reader would refuse the malformed member and lose the whole document, which is the fail-closed-downgrade trap a new version avoids (D22).
3. **The outcome replaces, never appends.** Both halves of one attempt share `(correlationId, attempt)`; appending would leave an `unknown` record beside its resolved twin, and reconciliation would report the attempt twice. `appendAttempt` becomes an upsert on that pair; `authorizedAt` survives the replacement and `recordedAt` moves to the outcome write. `appendAttempt` and `acknowledgeAttempt` must return the document's `followUps` unchanged — both currently return `{ schemaVersion, attempts }` and drop them, which is the pre-existing defect this amendment must not double.
4. **Fail closed, with a per-cause reason — recut at v1.15.0: the two failure points differ.** If the **placeholder** cannot be written, the panel requests no reservation and calls no abandon: nothing was authorized, so nothing can be lost, and the run waits for lease expiry (FR-046). If the **fill** cannot be written after a successful reserve, the panel calls `abandonReservation` and returns without a host call. `abandonReservation`'s hardcoded reason is not shared: the disposed path keeps *"panel closed after reserving, before the host call"*, and the refused-fill path passes the storage refusal. That abandonment is recorded in the panel's ledger, the way the block-refusal path records its outcome — the panel's promise is its own act; the service's answer decides whether the run is `failed` or is left to FR-023's deadline.
5. **An unknown record is never reported.** `reconcile.ts`'s re-report loop filters to resolved outcomes; unknown records go to the warning only — unless `settledAt` is already set, in which case they go nowhere. `reportBody` gains no branch for them, because the panel has no fact to send.
6. **The settle read pages, and settlement is durable.** In the same bounded pass, an unknown attempt at *n* is settled when `GET /v1/audit?correlationId=&limit=200&cursor=` — walked to exhaustion by `nextCursor`, **not** through `AUDIT_ROW_LIMIT`, which is the audit view's display cap — returns `dispatch.result` or `dispatch.abandoned` with `details.attempt === n`, or a `dispatch.resolved` whose `seq` is greater than the `dispatch.reserved` row naming *n*. A non-numeric attempt reference is not evidence. The verdict writes `settledAt` on the record — the outcome stays `unknown` — and a settled record is evicted as though acknowledged and never surfaced again, so a trail trim cannot resurrect the warning. `dispatch.unconfirmed` is not evidence; a failed read or a budget that stops the walk leaves the warning saying the panel could not check (FR-045). *v1.15.0:* the same read can instead prove the attempt was **never authorized** — a `dispatch.lease-expired` or `run.dead_lettered` row whose `details.leaseId` is the record's — and that deletes the record silently **only while it holds no token** (a filled record is not deleted; it warns — D23); the absence of a `dispatch.reserved` row is never evidence (D23).
7. **The acknowledging write can carry the outcome.** When `recordDispatchOutcome` fails but the result report lands 2xx, `acknowledgeDispatch` takes the resolved outcome and writes it with `acknowledged: true` in one read-modify-write on the key it already owns, so no acknowledged record is left `unknown`. If that write also fails, the record stays unacknowledged and the settle read resolves it on the next mount (over-warn, never a false resolution).
8. **The warning rides the existing channel.** It uses the reconciliation banner (`setStatus` + note) rather than a new panel surface, names the run first so truncation can only shorten the reasons, names the project, worktree option, and attachment identifier held on the record, states the two resolutions as what the run's row offers **once it is `unconfirmed`** (005 FR-044), says so when the row is not available to be read, and does not block the other attempts' re-reports. Its copy is not pinned; its required content is FR-025's.
9. **Nothing on the service side moves.** No route, DTO, audit row, state, lease, token, or `unconfirmed` semantics; the service is never told `unknown`. The only files are `src/dispatch-record.ts`, `src/relay.ts`/`src/relay-attempt.ts`, `src/relay-gates.ts`, `src/reconcile.ts`, `src/service-calls.ts` (`auditPath` gains the `limit`/`cursor` query the route already accepts), and their tests.

---

### v1.14.0 amendment plan — 2026-10-23 (Gate 3 conformance)

Appended to `T-046` and `T-048`; no new phase, no service task. Gate 3's two material findings are fixed in the spec, and the code fix is bounded to the same panel files as v1.13.0:

1. **The reservation is the record's identity.** `DispatchAttemptRecord` gains `leaseId: string | null`, taken from `run.lease.leaseId` in the claim answer that `tryDispatch` already holds, and `recordDispatchIntent` requires it. The record's key stays `(correlationId, attempt)`; the writer compares `leaseId` within that key: a match is an idempotent success (no write), and a different lease id replaces the record with the new cycle's — never `false`. The fail-closed `false` return is narrowed to a read or persist failure, which is exactly FR-046's case. `leaseId` reads `null` on a `dispatch-attempts-1` row.
2. **The settle anchor is the reservation, not the attempt.** `reconcile.ts`'s `reservedSeqOf` matches `dispatch.reserved` on `details.attempt` **and** `details.leaseId === record.leaseId`; a result or abandonment needs `seq >` that anchor, as a `dispatch.resolved` already did. The token is deliberately not the anchor: `buildDispatchToken` hashes `runKey|attempt`, so it repeats across cycles. **The separate `unanchored` verdict is cut** (Gate 3 round 3): a no-anchor read and an anchor-with-no-outcome both leave the record unsettled, so the verdict collapses into `no-evidence` — one branch and one copy path — while FR-045's requirement that the no-anchor case say the panel could not check is what the merged branch renders.
3. **The banner bounds the details, not the runs.** `warningBody` composes the run list (every unsettled run with its verdict) first and never truncates it — the run list is never a truncation target; each run's detail line is bounded on its own after the list, and a cut is marked and points at that run's row in Dispatches. The bound may only ever shorten details.
4. **The warning says what the panel loaded, not what it could not read.** `app.ts` awaits `loadDispatches` before `reconcileDispatchAttempts`, so a missing row means the read had finished and the loaded page/filter did not hold it — not that the read was still running. The detail line therefore says the run's row is **not in the list this panel loaded** and points at the run's row in Dispatches; "the panel could not check" is kept for its own facts — a failed audit read or a budget that stopped the walk.
5. **One attempt, one record, without exception.** The outcome writer keys on the record carrying **its own lease id**. When no record carries it, the writer looks at `(correlationId, attempt)`: nothing there (the record was evicted) is real evidence and is appended; a record there under a **different** lease is a **superseded** reservation, and no second record is persisted — the newer cycle owns the attempt. The outcome is still reported to the service and the panel's ledger already holds it; the service's spent-token rule governs a late report. Storing it would re-report forever with a token the service refuses, and an applied stale report would carry an earlier cycle's session into a later attempt. `withOutcomeRecord` loses its append-when-the-triple-misses branch. *v1.15.0:* between the placeholder and the outcome the attempt's one record may be a **placeholder** with a null token, and it may be **gone by design** — deleted after a refused reserve or after FR-045's never-authorized verdict (D22, D23). The rule that no attempt ever holds two records is unchanged; the delete is the second way to satisfy it.
6. **The Gate 3 cuts.** `acknowledgeAttempt` is deleted (dead since `acknowledgeDispatch` was rewritten); `abandonReservation` writes its ledger entry only on the path FR-046 names — *v1.15.0:* the refused **fill**, because a refused placeholder now never reaches an abandon — and not on the disposed path; the `unanchored` settle verdict collapses into `no-evidence` (item 2); `ac-status.md` keeps requirement ids and status only, dropping its third verbatim copy of test titles; and the `ContextFields`/`isCompleteContext` mapped-type guard is deleted in favour of five plain reads, each refusing the row on its own. Nothing else moves: no route, DTO, audit `eventType`, storage key, or capability.

---

### v1.15.0 amendment plan — 2026-10-23 (corrective: one claim per relay interval, and the record before the reservation)

> **Supersedes** the write ordering in v1.13.0 item 1 and the v2 document in item 2, and the parts of
> v1.14.0 item 5 that implied the attempt always holds a record; both are recut above, not merely
> annotated, because an implementer codes against them. **Panel-only**: no service file, route, wire
> member, audit `eventType`, storage key, capability, or config field moves. The claim's `limit`
> parameter already exists (`service/routes/events.ts` `claimLimitOf`, `1…MAX_CLAIMED_RUNS`), so
> asking for `limit=1` needs no service change — and the service stays unaware of the pacing, because
> FR-081 is a rule about this panel's demand, not a second lease protocol.

#### P.1 The two windows the v1.14.0 code leaves

| Window | What happens today | What v1.15.0 does |
| --- | --- | --- |
| **A batch** | One claim leases up to 50 runs; the panel dispatches them in sequence. A run the panel never reaches still holds a lease, and a panel death burns its attempt and requeue budget to `dead-lettered` (FR-036's harm, reachable for the tail of the batch). #207 was leased 3 ms after #209 and reserved 64 ms after #209's session existed. | A tick claims **one** run (`?limit=1`), never twice, and not until a relay interval has passed since the previous claim — whichever entry point ran the tick (D21). |
| **B** | The attempt record is written after the reserve answers and before the host call. Between the answer and the write the service holds a reservation with no durable panel trace; #207's reserve was answered and the panel stopped before any record existed. | The **placeholder** is written before the reservation and **filled** after the answer; the host call is unreachable until the token is durably recorded (D22). |

#### P.2 Decisions (D21–D24, continuing this plan's series)

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D21** | **Pacing is measured from the previous claim, in `src/relay.ts`, on runtime state.** `pollRelay(rt, { now })` reads the clock once (injectable, the same seam `reconcileDispatchAttempts` uses) and claims only when `rt.state.relay.lastClaimAtMs === null` or `now − lastClaimAtMs >= RELAY_POLL_INTERVAL_MS`. The stamp records the moment the claim was **issued**, whether it succeeded or not, because it measures demand on the service rather than success; the request asks for `limit=1`. The stamp lives on `Relay` (→ `initialRelay()`), i.e. **in memory, per mount, never in `host.storage`**: a remount starts at `null` and its first tick after reconciliation claims immediately, because the durable facts of a previous mount are its **leases and its record**, not a pacing stamp — a reloaded panel has nothing in flight to pace against, and carrying the stamp across a reload would leave work waiting on a timer that no longer exists. | `pollRelay` has **three entry points** — the arming poll `startRelayPolling` issues, the `RELAY_POLL_INTERVAL_MS` timer, and the session-lifecycle poke — and the arming function itself is reached from three call sites (connection, mount-time bindings, every later read or grant). A guard on "one per tick entry point" would be three guards, would have to be repeated at three arming sites, and would still let two claims run microseconds apart when a poke and the timer coincide. Measuring at the claim is the only place every path passes through. A skipped tick still refreshes the follow-up view and delivers one follow-up: pacing gates the **claim**, not the tick, so it costs no follow-up latency. | A service-side rate limit (a service change, and it would put one panel's cadence into a shared durable store); "one dispatch per tick" alone (a tick can be poked mid-dispatch — `inFlight` prevents overlap but not adjacency, which is exactly #207); sleeping inside the tick (blocks follow-up delivery and adds a second timer); storing the stamp in `host.storage` (a wiped or foreign stamp would silently stop claims, and it is not evidence). |
| **D22** | **One writer surface, three writes, document v3.** In `src/dispatch-record.ts`, all through `updateDispatchRecord` (one chain per key): `recordDispatchIntent` writes the placeholder — `outcome: 'unknown'`, `dispatchToken: null`, `authorizedAt: null`, the claim's `leaseId`, the run's `projectId` and `worktreeOption`; `fillDispatchToken` writes the token and `authorizedAt` (the panel's fill stamp) into that record and moves `recordedAt`, idempotently for the same token; `deleteDispatchIntent` removes the record at `(correlationId, attempt, leaseId)` only while it still holds no token (a filled record is never removed). `dispatchToken` becomes `string \| null`; the reader accepts `dispatch-attempts-3` (token may be null) and still reads `dispatch-attempts-1`/`-2` (token required, because those documents always carry one). **`null` means the panel has not durably recorded a token** — the service may still hold a reservation, and only FR-045's evidence decides authorization; no surface may read a null token as "not authorized". The fill is a writer of its own rather than a parameter of the intent writer: the token does not exist before the answer, and one writer accepting `string \| null` could be called with `null` after it does. | Three writes on one document need one chain, one reader, and one validation rule, or the second writer drifts. A separate schema version is the fail-closed answer to a nullable member: an older build refuses a v3 document **whole**, while widening v2 would make its reader refuse the malformed member and lose every attempt in the document — the downgrade trap the spec records as a stated cost. | Widening `dispatch-attempts-2` (old reader refuses the whole document, losing records it could still read); recording the placeholder in `relay-attempt.ts` (the record's whole surface belongs to one module, and `relay-attempt.ts` owns the host call); deriving "authorized" from `authorizedAt !== null` (it is the panel's fill stamp, not proof the service authorized); a fourth outcome kind for "placeholder" (the null token already states the only fact that differs, and `RecordedOutcome` must stay the ordering guard). |
| **D23** | **A never-authorized placeholder is deleted on the service's recovery verdict, never on an absent anchor.** `judgeEvidence` returns `settled` when the `dispatch.reserved` row carrying the attempt **and** the record's `leaseId` has a later `dispatch.result`/`dispatch.abandoned`, or a later `dispatch.resolved`; otherwise `never-authorized` **only for a record whose `dispatchToken` is `null`** when the same read holds a `dispatch.lease-expired` or `run.dead_lettered` row whose `details.leaseId` is the record's; a **filled** record beside that verdict is a contradiction the panel does not resolve — the service writes that verdict only when its reservation was `null` — so it takes `no-evidence` and is surfaced with the could-not-check wording; otherwise the existing `unconfirmed` label (still not evidence) or `no-evidence`. `never-authorized` deletes the record silently — no warning, no report — and a failed delete leaves the record and its warning (over-warn, never a false resolution). | The sweep is the only writer of both verdict rows, and it writes them only for a run whose `reservation === null` and `state === 'claimed'` (`expireLease`'s precondition; the budget-exhausted park runs after that same check). So the row proves the opposite of authorization — the run was recovered with no reservation under that lease. The **absence** of a `dispatch.reserved` row proves nothing: the reservation is durable before its audit row (a failed append answers `200` with `auditWritten: false` and still hands back the token), the claim row has the same failure mode, and retention trims the middle of a chain. Both verdict rows already carry `details.leaseId`, so this needs no service change. **The token guard is not a convenience**: a filled record beside a verdict naming its lease cannot have been produced by that lease's cycle, so acting on it would delete the panel's only token on a mis-ordered or partial read, and the panel cannot prove the contradiction away. | Deleting a filled record on the same verdict (resolves the contradiction toward *nothing was authorized*, which is the fail-open direction, and the token is the only trace the panel holds); deleting when the read holds no `dispatch.reserved` row (proves nothing — the same fail-open direction); inferring from the run's state through `GET /v1/events` (a second read, a second clock, and the run row may be filtered); a panel timer as the verdict (FR-045 forbids settling on anything but the service's evidence); treating `dispatch.unconfirmed` as the verdict (it names no lease and the run still needs the operator). |
| **D24** | **The cap keeps an unsettled placeholder, and the trimmed-verdict residue is stated rather than fixed.** `trimToCap` keeps its rule — evict the oldest record that is **acknowledged or settled**, never one that is both unacknowledged and unsettled — so a placeholder (unacknowledged, unsettled, unknown) is never a victim while its verdict row survives: deletion or settlement is what makes it removable. If the verdict row was trimmed before the read, the record stays, warns, and is un-evictable; the operator's `dispatch.resolved` (which settles it) is the way out. Protecting the verdict from retention is a service change and out of scope. | The cap's purpose is to bound the document, not to decide whether a reservation might exist; evicting the one record reconciliation needs is the failure direction constitution III forbids. The residue is a real cost of a panel-only amendment, so it is named instead of hidden. | Excluding placeholders from the cap's count (silently drops the record reconciliation exists for); evicting an unsettled placeholder first (a lost "a reservation may exist" fact); a service-side retention exemption for the two verdict rows (out of scope here, recorded in FR-045). |

#### P.3 Files and artifacts this amendment touches

| Artifact | Change |
| --- | --- |
| `src/relay.ts` | the claim gate (D21) and the placeholder → reserve → fill → host ordering (D22); it consumes `ReserveOutcome`'s new `indeterminate` kind so an unreadable, absent, or disposed answer is not mistaken for a refusal |
| `src/relay-gates.ts` | `reserveRun` distinguishes a service verdict (an error envelope with a code) from no verdict and returns `indeterminate` for the latter; `abandonReservation` keeps its per-cause reason and gains no new sentence |
| `src/dispatch-record.ts` | v3 reader (1/2/3), nullable token, `fillDispatchToken`, `deleteDispatchIntent` (null-token records only), fill/delete idempotence (D22) |
| `src/reconcile.ts` | the `never-authorized` verdict and the silent delete of a null-token record only (a filled record warns); the delete-failure over-warn (D23) |
| `src/panel-state.ts` | `Relay.lastClaimAtMs: number \| null`, `null` in `initialRelay()` |
| `src/service-calls.ts` | `pendingClaimPath()` returns the claim route with `?limit=1` (beside `auditPath`, which already builds a query); `EVENTS_PENDING_PATH` stays the bare route |
| `contracts/reconciliation.md` | §1 recut to placeholder → reserve → fill → host → outcome with v3, the null-token rule, the two refusal cases and the delete; §2's loop and settle predicate gain the verdict-row delete; §3's unknown row and §4's invariants 5–6 recut to match |
| `contracts/claim-lease.md` | the `limit` row and §Semantics name the pacing (`limit=1`, one claim per relay interval) and state that the service does not enforce it — the parameter is unchanged |
| `data-model.md` | §2.2's lease row records the one-run-per-interval claim; §3's `mecha-turk:dispatches` row moves to v3 with the placeholder lifecycle, the nullable token, and the delete |
| `ac-status.md` | AC-134/AC-135 re-cut and unimplemented; AC-156/AC-157 new and unimplemented; AC-106/AC-110/AC-127/AC-133 notes |
| `tasks.md` | the `## v1.15.0` block (`T-050 … T-059`) |

#### P.4 Constitution alignment (v1.3.0) — re-read for this amendment

| Principle | How the amendment satisfies it |
| --- | --- |
| **III. Durable and idempotent work** | Both decisions remove a window in which the two halves disagree about what exists. A reservation can no longer exist without a durable panel record (D22), and one dispatch's reservation can no longer be minted into another dispatch's unfinished window (D21). The delete is keyed on the reservation, so it can never remove a record for a different cycle. |
| **IV. Human-visible auditability** | The runs a claim does not offer stay `pending`, unleased and attempt-untouched — visible and explained rather than burned. An authorized attempt is surfaced whether or not its token was filled, and a record is deleted only on a verdict the operator can read in the trail **and only while it never held a token**; a failed read or a budget stop deletes nothing and says so. No new row, no new `eventType`. |
| **II. Safe autonomy by default** | A refused placeholder stops **before** the reservation is requested, so there is nothing to abandon and nothing to wedge; an unreadable or absent reserve answer keeps the record (the service may hold a reservation) rather than deleting evidence; an older build refuses a v3 document whole instead of half-applying it. |
| **VI. Specification and verification** | FR-081's reason is written into the requirement so a later "optimisation" cannot restore the batch; both decisions are acceptance criteria (AC-156, AC-157) and automated permutations (NFR-102), not manual checks. |
| **V, VII** | Untouched: no new process, dependency, route, capability, host call, or permission. |

**`AGENTS.md` invariants** — (1) every wave ends with `npm run build` and both bundles committed; (4) `mecha-turk:dispatches` keeps its name; (5) no version bump, so `SERVICE_VERSION` is untouched; (7) zero suppressions, no `any`; (8) the v3 reader refuses a malformed document whole, and a null token is a **value** with one meaning, never an error swallowed into a default; (10) no audit `eventType` and no wire member changes.

#### P.5 Out-of-scope guard for this amendment

No service change, no new route, no wire member, no audit `eventType`, no storage-key change, no config field, no capability. No retention change to protect the verdict rows (FR-045 names it out of scope). No timeout on `host.startSession()` and no re-read of Dispatches when a result deadline passes (#72 actions B and C stay out; 005 v1.23.0 owns action D). No change to the reserve/result refusal matrix, the token derivation, the states, or `unconfirmed` semantics.
