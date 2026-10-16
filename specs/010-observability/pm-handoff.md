# PM Handoff: 010-observability (lifecycle service-log viewer, issue #53)

- Spec: `specs/010-observability/spec.md` (v1.0.0, **Gate 1 PASS** after 3 passes) · Plan: `specs/010-observability/plan.md` · Tasks: `specs/010-observability/tasks.md` (32 tasks, 4 waves, **Gate 2 PASS WITH CUTS** after 2 passes) · Constitution: `.specify/memory/constitution.md` v1.3.0 (no amendment) · Orchestration state: `specs/010-observability/orchestration.md`
- Branch: `010-observability` (from `origin/main` @ cc19102) · Repo: shaunburdick/mecha-turk · Issue: https://github.com/shaunburdick/mecha-turk/issues/53 (linked to this session)
- Phase: **PR open — awaiting product-owner merge** · Completed: everything through Gate 3 + CI green (PR #57: https://github.com/shaunburdick/mecha-turk/pull/57, linked to session; issue #53 commented) · In progress: none · Blocked: none
- Decisions:
  - Merge and release (if any) are human decisions; no version bump shipped with this feature (release policy: pre-1.0.0, bump only when cutting a release).
  - Full lane per issue #53's recorded product-owner decisions (2026-10-15); precondition (#36 → PR #55/#56) met; approval basis = operator automation instruction + issue decisions; human gate = PR review.
  - 005 amended in place (44 changed lines + changelog `### v1.22.0`, SC-103 six→seven); 002 FR-042 phrase-level fix + `### v1.19.1`; 006/007 left as dated records (rationale in spec `## Amending 005`).
  - Wire: `GET /v1/logs?cursor=&limit=` → `{entries:[{seq,line}], startedAt, intervalMs}`; absent cursor = tail; limit default 200 clamped 1–1000; bad cursor → 422 fail-closed no-echo; auth + 256 000-char guard inherited (`contracts/panel-service.md` gains one row in T031).
  - Gate 1 fixes: 005 FR-016 `2 of 7`; count claim corrected to 44; false "second status-document reader" premise removed + reconciled with 005 row 53/NFR-112; FR-008 exhaustive by category; Open Questions + duplicate inventories cut.
  - Gate 2 fixes: T021 moved into W2 (render-a11y would close red); settings-state conditional → fact; Decision 12 restart clause cut; tabs.ts count comments owned by T014; status-refresh four sites named; T012+T013 land together; [P] on T016/T017; T025 outcome-binding wording.
  - Not doing (nothing may re-enter): log file/rotation/durable retention; panel-side event merge; watch panes; buffer-size or log-view settings dial; new config field/storage key; manifest/capability/SDK/SERVICE_VERSION/version change; push transport; README change.
- Next: product-owner reviews and merges PR #57 (CI green); after merge, the repo's auto-tag/release flow is untouched by this feature (no version bump). Nothing else pending for #53.
- User preferences: operator-run automation; checkpoints reported in-session rather than blocking on confirmation; escalate only genuine product ambiguity (none outstanding).
