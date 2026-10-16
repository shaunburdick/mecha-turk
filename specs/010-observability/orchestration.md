# Orchestration: 010-observability (lifecycle service-log viewer, issue #53)

- **Current Wave**: not started — Wave 1 ready to dispatch (see Next Action)
- **Branch**: `010-observability` (from origin/main @ cc19102) · Repo: shaunburdick/mecha-turk
- **Tasks**: `tasks.md` is the canonical record — 32 tasks, 15 `[P]`.
  - W1 (service: ring + `GET /v1/logs`): T001–T007 — pending
  - W2 (panel: 7th tab, reader, cadence): T008–T018 + T021 (T021 moved in at Gate 2 — render-a11y would close red) — pending
  - W3 (seven-tab sweep: tests, tools, site, docs, visual evidence): T019, T020, T022–T030 — pending
  - W4 (contract row + closing audit): T031–T032 — pending
- **Decisions**:
  - 2026-10-15 Full lane per issue #53's recorded product-owner decisions; approval basis = operator automation instruction + issue decisions; human gate = PR review.
  - 2026-10-15 Gate 1 PASS after 3 challenger passes (spec v1.0.0; 005 amended 44 lines + changelog v1.22.0; 002 FR-042 phrase fix + v1.19.1).
  - 2026-10-16 Gate 2 PASS WITH CUTS after 2 passes (plan + 32-task list; T021 relocated to W2; two "count comments" wording cuts applied).
  - Execution shape: one `modern-architect-engineer` session per wave (serial inside a wave; `[P]` noted but not dispatched concurrently in one worktree — correctness over wall-clock), `npm run verify` at every wave close, bundles rebuilt with source each wave (invariant 1).
- **Blockers**: none
- **Verification**: Gate 1 PASS (challenger session, 3 passes) · Gate 2 PASS WITH CUTS (2 passes) · no code yet, no test run yet
- **Budget**: per-wave limits from the orchestration skill (250k input / 20 min); handoff at boundary. This session: spec phases done, entering implementation — if this session approaches the limit, stop at a wave boundary and resume from this file alone.
- **Next Action**: dispatch W1 (T001–T007) to `modern-architect-engineer`; on green `npm run verify` + build + commit, mark T001–T007 done in `tasks.md`, update this file, then dispatch W2. Gate 3 (spec-challenger diff challenge) before any PR; PR is a human decision.
- **Post-PR**: PR body must carry what changed / why / what was removed / what was declined + ai-attribution trailer; comment on issue #53 with the PR link; keep issue link on session.
