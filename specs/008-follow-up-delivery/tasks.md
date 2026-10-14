# Tasks: follow-up cross-session delivery (B+ park + auto-rearm)

**Input**: Design documents from `/specs/008-follow-up-delivery/` — [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md)

**Prerequisites**: plan.md (required), spec.md (required — Gate 1 closed pass-with-cuts, decision-closed), research.md, challenge-ledger.md, pm-handoff.md

**Tests**: Included — required by the amendment itself: AC-050/AC-051 (as amended) are fake-host assertions, and the repo's testing philosophy demands every deterministic behaviour run offline. Every test task names the regression it catches; each must fail without the source change it accompanies.

**Organization**: Four waves, each closed by `npm run verify` (invariant: a green suite is the floor). Branch `008-follow-up-delivery`, stacked on `chore/sdk-2.3.1` @ 51dcb2d (PR #49). Nothing under `service/`, no route, capability, config field, persisted field, or state name is added anywhere.

## Format: `[ID] [P?] Description (FR/AC served)`

- **[P]**: Can run in parallel (different files, no dependencies)

---

## Wave 1 — Test support (blocking prerequisite for every panel assertion)

**Purpose**: the fake host must be able to *push* host facts and *switch* the current session mid-test, because AC-050/AC-051's re-arm and race assertions are exactly those movements.

- [ ] T001 Extend the fake host in `tests/support/panel.ts` with a lifecycle-push and session-switch harness: capture `onSession` / `onSessionLifecycle` / `onReady` listener registrations so a test can emit a `SessionSnapshot` (id + `busy`), a `SessionLifecycleEvent` (`started` / `completed` / `failure`), and the `ready.session` snapshot (T002's second idle source) into the panel at any moment; make the lifecycle double honour the bridge's late-subscriber replay — a listener registered after events were emitted receives the last event the bridge saw (research.md §2.3) — so the replay fact is assertable; switch the current session between the re-arm observation and the prompt; and keep the existing `prompt` / `openSession` call-log overrides working for the zero-calls assertions (AC-050 re-arm race, AC-051 raced busy — offline, no new dependency)

**Checkpoint**: Wave 1 closed — `npm run verify` green with no `src/` change.

---

## Wave 2 — Panel implementation (FR-104, FR-105 as amended)

**Purpose**: B+ delivery: waiting state, auto-rearm, every-prompt re-verification, transient-only ladder, raced-busy, migration — and the test rewrite that proves each.

- [ ] T002 Add the current session's busy/idle tracking: extend `rt.state.relay` in `src/panel-state.ts` with the busy/idle fact beside the existing `currentSessionId`, and feed it in `src/follow-up.ts` from `onSession` / `ready.session` snapshots (`busy: false` is an idle fact) and `onSessionLifecycle` phases (`completed` → idle, `started` → busy, `failure` → neither) — idle is observed, never assumed (FR-104; research.md §2.3, §2.5)
- [ ] T003 `src/follow-up.ts` — the B+ delivery gate: delete `navigateToSession` and the navigation-intent record from the delivery path; a follow-up whose target is not the current session performs **no** `host.openSession`, **no** `host.prompt`, consumes no retry budget, and parks nothing — it stays due/waiting in the existing vocabulary (`session-busy`); delivery is one `host.prompt({ text, send: true })` with zero navigation when the target is current and observed idle; **pin the waiting-path write count**: exactly one durable record write and one ledger entry on the *transition* into waiting, and none for the ticks that follow while the target stays non-current — a due non-current follow-up is re-offered every relay tick (`src/relay.ts`), so per-tick settlement writes would flood the operator's ledger with one entry per tick for the whole waiting window (FR-104; constitution IV; AC-050 "different current session" / "already current" spans)
- [ ] T004 `src/follow-up.ts` — every-prompt pre-prompt re-verification: immediately before **every** prompt (first attempt, re-armed attempt, retry) re-verify the target is still current; on the waiting/re-armed path a mismatch means no prompt, no navigation, no budget consumed, nothing parked — back to the waiting state; on the retry path a mismatch stops the delivery with `navigation-refused` and parks, zero prompts, no second navigation (FR-104, FR-105; AC-050 "Re-arm race" incl. serialization deferral, AC-050 "Retry re-verification")
- [ ] T005 `src/follow-up.ts` — the transient-only ladder and the raced-busy outcome: retry membership is `HOST_UNAVAILABLE` / `HOST_TIMEOUT` / `HOST_REJECTED` / transport failure only (the `host-unavailable` reason); `NO_SESSION`, an over-budget composition, and `navigation-refused` park on the first refusal consuming no ladder attempt; a raced `SESSION_BUSY` (thrown or settled `sent: 'skipped'`) is an observed-busy outcome — waiting state, attempt number unchanged, no ladder budget, never parked; update `classifyHostError` / `classifyPromptAnswer` and their now-false doc comments (FR-105; AC-051 all four Givens)
- [ ] T006 `src/dispatch-record.ts` — the migration and the comment that dies with it: read-time normalization in the record reader — a follow-up record carrying `parked: true` with reason `session-busy` reads as re-armed into the waiting state (`parked: false`, reason and `attempt` history intact, next attempt due now), re-derivable from the two existing fields, adding no persisted field or store; replace the doc comment at ~`:78` ("The session was mid-turn; a retryable refusal, never a queue") with the waiting-state wording the amendment mandates (FR-105 migration clause; challenge-ledger M6)
- [ ] T007 `src/relay.ts` — arming and ordering: register/release the lifecycle observation with the relay arm beside `trackCurrentSession`; deliver re-armed follow-ups in **detection order** (FIFO through the run's follow-up window order) under the existing one-per-tick serialization — no delivery while a dispatch attempt is in flight; on an idle transition where the target is current and follow-ups are outstanding, poke one immediate `pollRelay(rt)` through the same in-flight/`busy` guards (no second timer); update the stale "no navigation when the target is already current" comment at arming (FR-104 ordering + re-arm clauses)
- [ ] T008 Rewrite the FR-104/FR-105 section of `tests/follow-up-lifecycle.test.ts` (the "delivery and the park" block) to AC-050/AC-051 as amended, driving the T001 harness — one assertion per amended clause: zero `openSession` and zero prompts with a non-current target, `session-busy` waiting on the run row, record stays due, and **N relay ticks while the target is non-current produce exactly one record/ledger write — the transition into waiting — and zero further ledger entries**; current + idle → prompted exactly once into the run's own session, at-most-once record written; **FIFO: two outstanding follow-ups re-armed by one observation deliver in detection (window) order across ticks — one per tick, first-detected first**; re-arm race (operator switches to a different idle session before the prompt, including via serialization deferral) → zero prompts into the non-target session, nothing parked, no budget consumed, back to waiting, delivered exactly once later; retry re-verification → zero prompts into the non-target session, no second navigation, stops `navigation-refused`; raced busy → no further prompt attempts, no ladder attempt consumed, nothing parked, next idle delivers exactly once; mid-turn → no attempt at all; transient ladder retries then parks; `NO_SESSION` / over-budget park on the first refusal with no ladder attempt; `DISABLED` refusal parks as `host-unavailable`; migration: a pre-amendment `parked, session-busy` record re-arms with attempt history intact and re-parks at once on an exhausted ladder (by design) (AC-050, AC-051; FR-104, FR-105)
- [ ] T009 Update the remaining suites that encode pre-amendment behaviour — `tests/follow-up-reoffer.test.ts`, `tests/relay-arming.test.ts`, and any assertion in `tests/dispatches*.test.ts` / `tests/relay-integrity.test.ts` the grep for `openSession` / `session-busy` / ladder-park shows: re-offer semantics are unchanged (cleared park keeps attempt history), but busy/no-longer-current paths now wait instead of retrying (AC-050, AC-051; FR-105's re-offer clause stands byte-identical)
- [ ] T010 **Wave 2 close**: `npm run verify`, then `npm run build`; commit `src/` changes together with the rebuilt `panel/main.js` and `service/main.js` in one commit (invariant 1), Conventional Commit with the `Generated-By` trailer, git-safety preflight before the commit

**Checkpoint**: Wave 2 closed — amended AC-050/AC-051 green offline; bundles committed with source.

---

## Wave 3 — Surfaces and site (FR-036 vocabulary, FR-042 doc-drift gate)

**Purpose**: the waiting state renders through the vocabulary that already exists; the two false site passages stop being false. 005 is untouched (spec §7).

- [ ] T011 Assert (and fix only if a surface misreports) that the waiting state renders through the existing vocabulary: a record with `delivered: false, parked: false, reason: 'session-busy'` counts as **waiting** in `followUpRowView` and in the Status queue's `waitingFollowUps` line, appears on no parked list, and mints no new label, affordance, or reason word (`src/dispatches-detail.ts`, `src/status-tab.ts` — assertions in the existing dispatches/status suites; FR-036, FR-104, spec §7)
- [ ] T012 `site/src/pages/use.astro` `:144-149` — rewrite the follow-up row example so it stops presenting a mid-turn **park**: mid-turn (or a non-current target) is waiting, never parked; the example line becomes a surviving-park cause (e.g. `follow-ups: 1 delivered · 2 waiting · parked: the host refused or timed out`) (spec §3.9; FR-042)
- [ ] T013 `site/src/pages/use.astro` `:151-157` — rewrite the *parked follow-up* paragraph: mid-turn is never a park and never ladder-consuming; the park causes that survive are no session open, a navigation unissuable or a target no longer current at a retry, over-budget, and host refused or timed out — the ladder is spent only by transient host errors (spec §3.9; FR-042; FR-105)

**Scope note (PM, 2026-10-13)**: T012 and T013 also cover `site/src/pages/use.astro:113-117` — the paragraph two spans below companion 9 that still claimed delivery moves the view — **delivered in wave 4 by PM instruction**; spec §3.9 now carries all three spans byte-exact.
- [ ] T014 **Wave 3 close**: `npm run verify` (the root suite's `docs-sync`, `vocabulary`, and `prose-budget` read `use.astro` as text — all must stay green), `npm run build` and bundle commit if T011 changed `src/` (invariant 1)

**Checkpoint**: Wave 3 closed — site and panel surfaces agree with the amended requirements.

---

## Wave 4 — Conforming edits to `specs/002-agent-event-extension/` (v1.17.0 → v1.18.0)

**Purpose**: the delivered package contains the amendment's in-place rewrites, byte-precise. All tasks edit `specs/002-agent-event-extension/spec.md` unless noted, and run in sequence (same file). The "old" spans below are quoted byte-exact in the amendment at the section named; apply each edit only where the old bytes exist, and match the "new" text byte-for-byte.

- [ ] T015 Replace the FR-104 navigation span (spec.md ~:468) with the amendment's §2.1 new text; everything after the span — composition bounds, measure-before-call guard, FR-027 authorization clause — stands byte-identical (§2.1)
- [ ] T016 Rewrite FR-105's full text (spec.md ~:470) to the amendment's §2.2 new text, including the transient-only classification, the raced-busy outcome, the closed five-word union, the closed-panel clause, the "no new state name" clause, and the migration clause (§2.2)
- [ ] T017 Replace the AC-050 navigation/busy span (spec.md ~:616) with the amendment's §2.3 new span; the remainder (FR-027 reading, `followUpsFrom` window, measure-never-truncate) stands byte-identical (§2.3)
- [ ] T018 Replace the AC-051 retry-shrink span (spec.md ~:617) with the amendment's §2.4 new span; the re-offer assertions stand byte-identical (§2.4)
- [ ] T019 Apply companions 1–4: FR-037's follow-up clause (~:270, keeping the `(constitution VII)` citation in the new clause — recorded choice), the edge case (~:207), User Story 7 scenario 2 (~:152), and the `## Out of Scope` row (~:691) (§3.1–§3.4)
- [ ] T020 Apply companion 5: NFR-001's follow-up leg (~:521) — the detection-armed clock with the observed-target-busy exclusion and the human-visible waiting duration, per the closed Q1 decision (§3.5, §5)
- [ ] T021 Apply companions 6–8: the v1.16.0 rationale paragraph (~:22), the `## Clarifications` Q&A (~:818), and the `:8` Status-line historical marker inserted immediately after "(FR-104, FR-105)" — the marker text exactly as §3.8 states it (conditional on either option, though B+ is mandated) (§3.6–§3.8)
- [ ] T022 Take the 002 header to v1.18.0 (`Version`, `Last Updated`, `Status` line) and add the single v1.18.0 entry to `specs/002-agent-event-extension/changelog.md` in 003's amendment pattern: rationale, requirement-by-requirement record (FR-104, FR-105, AC-050, AC-051, the nine companions), principles reviewed, requirements explicitly unchanged (detection FR-101/102/103, terminal FR-106, run-join FR-100, FR-028 budget, FR-027 authorization, NFR-002 at-most-once), migration impact (pre-amendment `session-busy` parks re-arm from existing fields; no storage key, schema, or capability changes; `package.json` version does not move — releases are the product owner's call), approval status (Gate 1 pass-with-cuts; B+ and the NFR-001 clock decided by the product owner 2026-10-13, issue #48)
- [ ] T023 Rewrite the false view-switch sentence in `specs/002-agent-event-extension/quickstart.md` §10 (~:107, "delivering a follow-up may switch your view to the session and closes the panel, which the run's ledger records why") so it states v1.18.0's behaviour: under B+ delivery never navigates — a follow-up for a session that is not on screen waits visibly and is delivered when the operator opens the session and it is idle; same byte-precision discipline as the other conforming spans, and the same constraint: `tests/prose-budget.test.ts` pins the walkthrough at 76 lines (`REDUCED.walkthrough`), so the edit must keep the measured line count or update that pin in the same change with the pin's own documented justification (FR-042 doc-drift gate; the sibling of the §3.9 site rewrite)
- [ ] T024 **Byte-precision audit**: for each of the thirteen spans (FR-104, FR-105, AC-050, AC-051 + nine companions) diff the delivered text against the amendment's `New` text; grep-audit that no stale phrasing survives where the amendment replaced it (`queue-until-free`, "retries under the declared ladder" as a busy claim, "retryable refusal, never a queue", mid-turn as a park or ladder cause in `site/src/pages/use.astro` — including `:113-117`, the third delivered span (wave 4, PM instruction) — and in `specs/002-agent-event-extension/quickstart.md`), that the reason-word union still counts exactly five, that 002's requirement count is unchanged (FR-104/FR-105 rewritten in place; zero additions), and that nothing outside the named spans moved (the nine old quotes are byte-exact against v1.17.0)
- [ ] T025 **Wave 4 close**: `npm run verify` (suites that read `specs/` and `site/` as text must stay green), then commit the conforming edits and changelog with the preflight + `Generated-By` conventions (docs commit, no bundle rebuild needed — no `src/` change)

**Checkpoint**: all waves closed — the delivered package contains the conforming edits, the panel implements B+, the site no longer contradicts v1.18.0.

---

## Dependencies & Execution Order

- **Wave 1** (T001): no dependencies; blocks every assertion in Wave 2.
- **Wave 2** (T002–T009): T002 first (state slot the gate and verification read); T003–T007 build on it in file order (`follow-up.ts` tasks T003→T005 sequence cleanly; T006 and T007 are independent files once T003's gate exists); T008/T009 follow the source changes they assert. T010 closes the wave.
- **Wave 3** (T011–T013): depends on Wave 2 (the surfaces render what the record now carries); T012 and T013 are one file, run in sequence; T014 closes the wave.
- **Wave 4** (T015–T023): runs only after Wave 3 — 002's spec of record must never precede the branch's shipped bundles; T015–T023 all edit `specs/002-agent-event-extension/` and run in sequence; T024 audits; T025 closes.
- **Parallel opportunities**: T001 vs nothing (solo wave); T006/T007 vs T003–T005 once T002 lands (different files).

## Implementation Strategy

1. Wave 1 → verify (harness only, no behaviour change).
2. Wave 2 → verify + build + commit bundles with source (the feature lands).
3. Wave 3 → verify (+ conditional bundle commit) — surfaces and site agree.
4. Wave 4 → verify + docs commit — the spec of record matches what shipped.
5. Stop at any checkpoint to validate: every AC-050/AC-051 assertion is offline and binary; the conforming-edit audit is byte-diffable against [spec.md](spec.md) §2–§3.

## Notes

- Every task names the FR/AC it serves; a task with nothing behind it was cut (none found — the amendment's §6 "Not doing" is excluded by construction: no new route, state, capability, affordance, or 005 edit).
- Test discipline: each rewritten/added assertion must fail without the source change it accompanies (the busy-ladder and navigate-then-prompt assertions of the old suite are exactly such failures against the new code — rewrite, do not delete, until the replacement assertion exists).
- Comment discipline (issue #41): `src/follow-up.ts` is a rewrite, so its comment count must not rise; the two named comment deaths (`dispatch-record.ts:78`, `relay.ts` arming's navigation sentence) are part of T006/T007.
