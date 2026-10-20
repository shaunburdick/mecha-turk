# Tasks: Wider event detection

**Input**: [spec.md](spec.md), [plan.md](plan.md), GitHub issue #61

**Prerequisites**: spec and plan approved with the PM handoff.

**Tests**: Included — every detection and refusal has an offline assertion, and each test fails without its source change.

**Organization**: Three waves, each closed by `npm run verify`.

## Wave 1 — Poller and readers

- [x] T001 `service/poll/poller-events.ts` — add optional `PollItemEvent.id`, read only a positive safe integer, and carry `eventId` on the actor answer (FR-003; AC-009)
- [x] T002 `service/poll/poller-entries.ts` + `poller-github.ts` — add `PollReviewComment`, `readReviewCommentEntry` (fail-soft per entry) and `listReviewComments` on the existing transport (FR-004, FR-012; AC-008, AC-010)
- [x] T003 `service/poll/mentions-login.ts` — extract the bounded token match and re-export it from `triggers.ts`, so the new feed uses one rule (FR-007)

## Wave 2 — Detection

- [x] T004 `service/poll/follow-up.ts` — `reviewFollowUp` (event-id tail) and `reviewCommentFollowUp` / `reviewCommentFollowUps` (comment-id tail, tracked subject) (FR-001, FR-006; AC-001, AC-006)
- [x] T005 `service/poll/triggers-review.ts` + `tracking.ts` — a tracked pull with a readable event id **strictly newer than the run-establishing reference** emits the follow-up; untracked, id-less, or not-newer requests keep the deduped `~review` (FR-001–FR-003; AC-001–AC-003, AC-014)
- [x] T006 `service/poll/review-comment-mention-events.ts` — mention detection with origin `review-comment`, window and attribution unchanged (FR-005, FR-007; AC-005)
- [x] T007 `service/poll/triggers.ts` — one `pulls/comments` call per mention-enabled cycle; on failure log the class, use an empty list and continue the conversation feed (FR-004, FR-008; AC-007, AC-010)

## Wave 3 — Identity, composition, panel and proof

- [x] T008 `service/poll/events-write.ts` + `events-parse.ts` + `events.ts` — snapshot variants and discriminators for both new follow-up roles and the review-comment mention origin; widened `FollowUpKind` (FR-009; AC-001, AC-005)
- [x] T009 `service/poll/runs-types.ts`, `runs-parts-parse.ts`, `runs-join.ts`, `engine-compose.ts`, `events-enqueue-audit.ts` — accept the widened kinds, compose the movement text, map the review-comment mention id to its source-reference origin, and name the audit reason (FR-009; AC-011, AC-013); `run-history-project.ts` required no change
- [x] T010 `src/follow-up.ts`, `src/dispatches-detail.ts` — panel composition and fail-closed parser accept all four kinds (FR-009; AC-011)
- [x] T011 Tests — `tests/follow-up-lifecycle.test.ts` (review requests incl. the establishing-row case, inline mentions untracked and tracked), `tests/service-triggers.test.ts` (inline mention, fail-open log and class, feed-count switch), `tests/service-poll-entries.test.ts` (reader and id), `tests/service-events.test.ts` (id minting/round-trip) (AC-001–AC-010, AC-013, AC-014)
- [x] T012 **Wave close** — `npm run verify`; rebuild `panel/main.js` and `service/main.js`; commit source and bundles together (AC-012)

## Verification record

- `npm run verify` — 2026-10-20: build, lint, typecheck, **120 files / 1 598 tests** green (1 592 at the initial Wave 1 commit).
- Bundle rebuild included in the same commit, per `AGENTS.md` invariant 1.
