# Orchestration State — Specs 003–006 Implementation Cycle

**Status**: active — Phase 6 execution
**Created**: 2026-09-28

## Current Wave

- **Feature**: **003 COMPLETE** (45/45 tasks, 1039 tests) and **004 starting-prompt COMPLETE** (16/16 tasks, 6 commits `ba814cb`…`a2cb79f`, verify green at **1135 tests / 69 files**, all pushed; AC record at `specs/004-starting-prompt/ac-status.md`). **Next: feature 005 panel-IA** (34 tasks / 10 waves) in three dispatches — D1 = waves 1–4 (L2 renames + vocabulary guard + service honesty + shell/spike/legacy-settings retirement), D2 = waves 5–7 (Status, Dispatches, Bindings tabs), D3 = waves 8–10 (Accounts, Settings, About + proof suites + docs + final gate). Then 006 settings-CRUD.
- **Cycle**: implementation order 003 → 004 → 005 → 006; one branch, one PR.
  - 003: 36 tasks / 8 waves + 8 review-remediation tasks (T-037…T-044), all in `specs/003-dispatch-integrity/tasks.md`
  - 004: 16 tasks / 4 waves (`specs/004-starting-prompt/tasks.md`) — W2 depends on 003's final gate
  - 005: 34 tasks / 10 waves (`specs/005-panel-ia/tasks.md`)
  - 006: 30 tasks / 11 waves (`specs/006-settings-crud/tasks.md`)

## Branch

- **Implementation branch**: `003-dispatch-integrity` (created 2026-09-28 from `full-project-plan` @ `3aeffbb`)
- **Base for the PR**: `main` (`origin/main` @ `78da590`; branch is strictly ahead)
- Protected: `main`, `master`, `develop` — never commit to them, never force-push, never `--no-verify`.

## Tasks

| Feature | Wave | Tasks | Status |
| --- | --- | --- | --- |
| 003 | W1 run model & migration | T-001…T-006 | complete; commit `561fdf1`; verify green; independent review found blockers |
| 003 | W1 review remediation | T-037 | complete; commit `5d9bc4b`; verify green (643 tests) |
| 003 | W2 claim/lease/sweep | T-007…T-010 + T-038 | complete; commit `13dffdf`; verify green (697 tests); independent reviews found defects |
| 003 | W2 review remediation | T-039 → T-040 → T-041 | complete; commit `033cfeb`; verify green (735 tests) |
| 003 | W3 authorization family | T-011…T-015 | complete; commit `072dfc9`; verify green (849 tests); independent reviews found a High |
| 003 | W3 review remediation | T-042 → T-043 → T-044 | complete; commits `1662fad`, `815af30`, `fe30569`; verify green (876 tests); spec v1.5.0 |
| 003 | W4 history/audit/vocabulary | T-016…T-018 | complete; commit `fd810ca`; verify green (899 tests); pushed |
| 003 | W5 panel dispatch integrity | T-019…T-023 | complete; commits `4b4bfb5`…`ff30d3c`; verify green (953 tests); pushed |
| 003 | W6 honest outcomes + T-045 flake | T-024…T-027, T-045 | complete; commits `f381472`…`eb7f86c`; verify green (**980 tests / 59 files**); pushed |
| 003 | W7 operator surfaces | T-028…T-029 | **next** |
| 003 | W8 proof + docs | T-030…T-036 | blocked by all |
| 004 | W1…W4 | T-001…T-016 | blocked by 003 gate (W2+) |
| 005 | W1…W10 | T-001…T-034 | blocked by 003 (uses its run layer) |
| 006 | W1…W11 | T-001…T-030 | blocked by 003 (T-008 backfill dependency) |

## Decisions

- **2026-09-28 — Single branch + single PR for the whole cycle.** Objective requires one PR; features are sequential-dependency anyway. Branch name `003-dispatch-integrity` is the spec-header-prescribed name; it carries 004/005/006 commits too.
- **2026-09-28 — No GitHub issue existed for this work** (repo only has 3 closed test issues). Created a cycle-tracking issue so the PR can reference it with a closing keyword and the issue can be commented on, per the objective's issue-management rules.
- **2026-09-28 — No CI has ever existed in this repo** (`.github/workflows` absent from all history). To make `gh pr checks --watch` meaningful, a minimal verify workflow (Node ≥ 20.19, `npm ci`, `npm run verify`) will be added to this branch as a small dedicated task before PR open. First run risk is absorbed by the objective's 3-attempt CI budget.
- **2026-09-28 — Wave gate**: `npm run verify` green + rebuilt `panel/main.js`/`service/main.js` committed in the same commit as the sources (AGENTS invariant 1). Commit attribution: `AI_AGENT=opencode OPENCODE_AGENT=<agent> OPENCODE_MODEL=<model>` (hook appends `Generated-By:`).
- **2026-09-28 — Reviews scoped per orchestration skill**: no per-wave reviewer for contained green waves; `code-quality-reviewer` mandatory at (a) security-sensitive/contract waves as they appear, and (b) the pre-PR checkpoint. `security-auditor` only for waves touching auth/secrets.
- **Warnings carried into dispatches**: 003 T-008's additive config read must land with 003 (strict read would quarantine existing `config.json` — 006's backfill comes later). 003's FR-043 doc wording slip is queued as a small doc pass, not implementation. Out-of-scope guards per tasks.md preamble apply to every dispatch.

## Blockers, product rulings & carry-forwards

**No open blockers.** Every entry below is resolved or is a constraint a later wave must carry.

- **2026-09-29 — Wave 3 worker failed twice (resolved by replacement, per product-owner approval).** Session `ses_f14773178ffeKuH2Bo3BEQKDKF` ended two consecutive turns with no report text. Work left on disk, uncommitted: 10 new service modules (`routes/dispatch.ts`, `routes/run-ops.ts`, `routes/run-scope.ts`, `poll/dispatch-authorize.ts`, `poll/dispatch-audit.ts`, `poll/dispatch-block.ts`, `poll/dispatch-report.ts`, `poll/run-operate.ts`, `poll/run-refusal.ts`, `poll/run-chain.ts`), 3 new test suites (`service-run-authorize.test.ts`, `service-run-operations.test.ts`, `service-run-routes.test.ts` = 2,676 lines), edits to `routes/events.ts`/`routes/index.ts`/`tests/service-runs.test.ts`, a rebuilt `service/main.js`. **State: red — `npm run lint` reports 67 errors across the three new test suites** (unused imports/vars, duplicate literals, `max-len`, `no-await-expression-member`, cognitive complexity, nested ternaries, unnecessary assertions, JSDoc alignment); lint fails before typecheck and tests run, so their status is unknown. Nothing ticked, no commit, HEAD still `033cfeb`. Confirmed `idle` before replacement. **Replacement: one fresh `modern-architect-engineer`, single owner, bounded context** (uncommitted files + 67 lint errors + the seven binding constraints), instruction = fix → test → tick → commit → report. The retired session must not be re-entered.

- **2026-09-28 — Wave 1 independent review blockers (RESOLVED in `5d9bc4b`).** T-001…T-006 committed as `561fdf1` (635 tests). Reviews found: contradictory stored run history could be claimed; an absent `runs.json` could adopt post-003 rows as pending; `run.created`/`run.migrated` audit rows could be lost across a crash; run-linked delivery rows were never evicted. All four fixed in T-037; the source-reference overflow policy was deliberately held back for the product ruling below.
- **2026-09-28 — Wave 2 review findings (in remediation, nothing unresolved).** Quality + security reviews of `13dffdf` agreed on one High and several Medium defects. High: the claim leases every pending run with no cap, so an answer over `RESPONSE_BODY_MAX_CHARS` returns `500` **after** the leases are durable — measured at 2 full-reference runs and at 300 single-reference runs — and those runs then burn attempts and the 3-requeue budget to `dead-lettered` (T-039). Medium: `pendingCount` counts state-free post-003 deliveries so it only grows (T-040a); FR-063 has no operator-surfacing mechanism outside the result route (T-040b); a live `dispatchToken` is written into operator-facing `audit.ndjson` (T-040c — **PM ruling: fingerprint, never the value**). Declined: marking response-level redaction of untrusted source text (pre-existing pipeline behavior; carried into Wave 5's render notes) and the advisory-only head-of-line measurements (folded into T-040d as a cheap reordering). The lease-id-derivation concern is **not** a product gate — the lease id is a fencing token, the service's bearer token is the only authentication gate — and T-041 states that in the contract.
- **2026-09-28 — Hard merge constraint.** The panel cannot parse the Wave 2 claim answer (`ClaimedRun[]`, not delivery rows), so the extension claims runs and dispatches nothing until Wave 5's T-021/T-023. The branch must not be installed, tagged, or released mid-wave; T-036's final gate must prove one end-to-end dispatch.
- **2026-09-28 — Wave 5 budget constraint (carry forward).** 200 retained references × a 600-char excerpt is ~120,000 characters against FR-014's 12,000-character per-dispatch limit. Wave 5's bounded context needs an explicit per-item cut rule with visible markers, not per-item bounds alone.
- **2026-09-28 — Wave 3 forward-compat (carry forward).** The run parser refuses any attempt record carrying a session id on a run that is not `dispatched`, and refuses duplicate session ids, so `resolve(session-created)` must write an attempt record with `outcome: 'dispatched'` plus the session id. Reserve must move the run to `starting` in the same write that records the reservation, and result must settle the reservation in the same write, or a run wedges with no recovery path.

- **2026-09-28 — Wave 1 review blockers (RESOLVED).** Four findings from the independent quality + security reviews, all fixed in `5d9bc4b` (T-037): fail-closed session-history parsing plus a claim guard; adoption refused when `runs.json` is absent but post-003 rows exist; durable idempotent `run.created` / `run.migrated` audit intents in `runs.json`; bounded eviction of run-linked delivery rows. **Forward-compat constraint for later waves**: the new parser requires that any attempt record carrying a session id exists only on a `dispatched` run, so Wave 3's `resolve(session-created)` MUST write an attempt record with `outcome: 'dispatched'` and the session id — otherwise the document quarantines on the next read. **Doc debt**: `runs.json` gained an `auditIntents` member not yet described in `data-model.md` §2.2; batch into one doc task with the FR-043 wording slip rather than editing per wave.
- **2026-09-28 — Product-owner ruling: source-reference overflow.** Raise the cap to `MAX_SOURCE_REFERENCES = 200` and mark overflow explicitly: when a join exceeds the cap, the run and its audit row state how many further triggers were not retained, so the operator is never misled and the row is knowingly incomplete rather than silently lossy. Realistic subjects never truncate; pathological ones stay bounded. Recorded as task T-038 and dispatched first in Wave 2.
- **2026-09-28 — Product-owner ruling: push.** Branch `003-dispatch-integrity` published to `origin` (new branch, tracking configured, 0/0 with upstream) with no PR opened. Later waves push as they land; the PR opens only after 004/005/006 and the pre-PR review.
- **2026-09-29 — Product-owner ruling: the dispatch token is not a capability.** Extending the lease-id ruling: `dtk-<sha256(runKey|attempt)>` is derived from inputs the claim answer itself exposes, so secrecy cannot be its guard. T-044 records it as a **non-secret sequencing value** whose guard is the state machine plus the attempt-history spend check. FR-020's derivation is deliberately untouched — changing it would break the plan's R3/D6 reasoning.
- **2026-09-29 — Declined with reason: L-7, throttling the run-scoped routes.** Audit growth from repeated refusals/duplicates is exactly what 006's audit-trim pass exists for (`auditRetentionDays`/`auditMaxEntries`, protected set, `audit.trimmed`); a second mechanism on the route would duplicate it. Carried as a 006 consumer, not a gap.
- **2026-09-29 — T-042(a) interpreted rather than applied literally.** The literal spend check ("any record with a non-null `resultReportedAt`") also refused the legitimate `unconfirmed` reconciliation required by contract §2, plan D7 and AC-111. Implemented reading: exclude the live reservation's own record, scan every other — the cross-chain replay still fires and `reserve` still consults no history. Evidence-backed; reversible in one commit.
- **2026-09-29 — Cross-feature obligation surfaced by Wave 6 (belongs to 006).** `src/agent-verify.ts` still resolves the verification baseline from `ctx.settings['expected-agent']` via `parseExpectedAgent` and mirrors it on `PanelState.expectedAgent`. 002 **v1.7.0 FR-029-as-amended** moves the baseline to `GET /v1/config`'s `expectedAgent`, and **FR-041(a)** retires that settings reader and the mirror outright (the integration card carries zero settings). 003 deliberately left it alone because T-027's brief said "source unchanged", but AC-023's *configured-vs-defaulted provenance* cannot be recorded until the source moves. **006 must own this**: read the baseline from `GET /v1/config`, delete `parseExpectedAgent` + the `PanelState.expectedAgent` mirror, and keep the two-case fail-closed split (missing baseline → `project-manager`, run proceeds, records which baseline was used). Carry into 006's dispatch prompt.
- **2026-09-29 — T-045 root cause was a real service clock race, not a test artifact.** `sweepOnce` resolved its clock locally but handed the *unresolved* input to the document read that triggers first-read adoption; adoption minted the synthetic migration lease with a **later** `nowIso()` sample, so a millisecond tick between the two samples left the pass judging a lease it had just caused to be minted as not yet expired — answering `recoveries: []` cleanly and pushing the migration recovery onto the next boot, which the restart test read as "a live lease was recovered". Reproduced at 4/240 suite runs under 4-worker load, 0/526 single-process (hence the original 1-in-6 appearance). Fixed by threading the resolved stamp into the read and minting `expiresAt = min(legacyClaimedAt, stamp − 1)`; red-first proof, 20/20 consecutive + 240-run soak. Recorded in `data-model.md` §1.
- **2026-09-29 — Operational lesson for every dispatch: one short, non-interactive shell command per call.** Three consecutive Wave 4 dispatches aborted because the worker ran a compound command (`rm -f …; git status …; echo …; ls … | tail -1`) that never completed. Workers must avoid `;` chains, pagers, `--watch`, prompts, and anything that can block; pipe and truncate long output; give explicit timeouts; abandon a stuck call rather than retrying it. Coordination note: the worker had already committed `fd810ca` before hanging, so the aborted turn did not lose work — **always check the commit log before assuming a silent turn failed.** Three consecutive Wave 4 dispatches aborted because the worker ran a compound command (`rm -f …; git status …; echo …; ls … | tail -1`) that never completed. Workers must avoid `;` chains, pagers, `--watch`, prompts, and any command that can block; pipe and truncate long output; give explicit timeouts; abandon a stuck call rather than retrying it. Coordination note: the worker had already committed `fd810ca` before hanging, so the aborted turn did not lose work — always check the commit log before assuming a silent turn failed.

## Verification

- **Last gate:** `npm run verify` green at `fd810ca` — build → lint → typecheck → test, **899 tests / 55 files**; committed `service/main.js` rebuilt with the wave; `panel/main.js` byte-unchanged since Wave 1; zero suppressions, zero `any`. A stray worker scratch file (`tests/race-probe.test.ts`) had been left untracked after an aborted turn and was failing lint with 4 errors; it is not part of any commit and was removed to restore the gate.
- **Commit chain on `003-dispatch-integrity`** (all pushed, 0/0 with `origin`): `561fdf1` → `5d9bc4b` → `13dffdf` → `033cfeb` → `072dfc9` → `1662fad` → `815af30` → `fe30569` → `fd810ca`.
- **Task accounting:** 26 of 44 boxes ticked (T-001…T-018, T-037…T-044); 18 open (T-019…T-036).
- **Reviews:** Waves 1, 2 and 3 each had independent `code-quality-reviewer` + `security-auditor` passes; all findings triaged — fixed (13 tasks), declined with reason (route throttling, response-redaction marking), or recorded as carry-forwards.
- **CI:** none yet — workflow added in the pre-PR task. Local `npm run verify` is the gate at every wave boundary.

## Budget

- Per-wave limits per orchestration skill: 250K input tokens / 20 minutes investigation. PM session budget: write this file at every wave boundary; compress closed ranges.

## Next Action

1. **Dispatch Wave 5** (T-019…T-023) — panel dispatch integrity; first wave to change `panel/main.js`.
2. Review only if the wave is not contained-and-green; then Waves 6, 7, 8.
3. …continue 003 W6–W8 → 004 → 005 → 006 → CI task → pre-PR independent review (`code-quality-reviewer`) → fixes → push + PR linking issue #6 → `gh pr checks --watch` (≤3 fix attempts) → issue comment → COMPLETE.
