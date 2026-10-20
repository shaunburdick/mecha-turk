# Implementation Plan: Wider event detection

**Branch**: `issue-mt-run-dcc1b0700c157011f3c87b15-kinetic-condor` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md) (v1.0.0)

**Input**: `specs/011-event-detection/spec.md`; GitHub issue #61; constitution v1.3.0; `AGENTS.md`; the shipped poller, follow-up, parser, composition and panel modules.

**Gate status**: Wave 1 completed with this handoff. Implementation is included in the same commit because the issue was dispatched as one lane with an approved brief.

## Summary

Two additive detections on existing polling surfaces:

1. **Re-requested review** — the review-request scan already reads the naming `review_requested` row to resolve its actor. That row's own integer id and `created_at` now ride the actor answer, and a tracked pull turns the observation into a `~followup~review~<eventId>` row instead of the deduplicating `~review` trigger — but only when the row is strictly newer than the reference that established the run.
2. **Inline review comments** — one `pulls/comments` list per mention-enabled binding per cycle feeds two existing detectors: the mention matcher (new origin `review-comment`) and the tracked-subject follow-up builder (new role `review-comment`). The feed fails open so its outage cannot suppress conversation-feed detection.

No new operation, store, manifest field, capability, configuration field or UI control. Ids are deterministic and extend the existing family.

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript 6.0.3 strict; zero suppressions, zero `any` |
| Service runtime | Node ESM, stdlib only; `service/main.js` rebuilt and committed |
| Panel runtime | IIFE; `panel/main.js` rebuilt and committed |
| GitHub reads | One added: `GET /repos/{owner}/{repo}/pulls/comments`, `since`-windowed, newest-updated first |
| Test strategy | Offline vitest: fake pollers, temp stores, fake host; no live instance or PAT |
| Version posture | `package.json` 0.4.1 unchanged; `SERVICE_VERSION` unchanged; SDK pin unchanged |

## Approach

| Spec group | Modules | Proof |
| --- | --- | --- |
| FR-001–FR-003 (review follow-up) | `service/poll/poller-events.ts` (`id`, `CandidateActor.eventId`, `eventAt`), `tracking.ts` (`establishedAt`), `triggers-review.ts` (strict-newer branch), `follow-up.ts` (`reviewFollowUp`), `events-write.ts` (`FollowUpReviewSnapshot`) | AC-001–AC-004, AC-014 |
| FR-004–FR-008, FR-012 (review-comment feed) | `poller-entries.ts` (`PollReviewComment`, `readReviewCommentEntry`), `poller-github.ts` (`listReviewComments`), `triggers.ts` (one call, fail-open), `review-comment-mention-events.ts`, `follow-up.ts` (`reviewCommentFollowUp(s)`), `mentions-login.ts` (shared token match) | AC-005–AC-010, AC-013 |
| FR-009 (parse/compose everywhere) | `events-parse.ts`, `events-write.ts`, `events.ts`, `runs-types.ts`, `runs-parts-parse.ts`, `runs-join.ts`, `engine-compose.ts`, `events-enqueue-audit.ts`, `src/follow-up.ts`, `src/dispatches-detail.ts` | AC-011, AC-013 |
| FR-010–FR-011 (idempotency, no new surface) | Existing queue dedupe and run document; no new file or operation | AC-004, AC-012 |

### Key decisions

- **`PollItemEvent.id` is optional and strict.** Only a positive safe integer is carried; the actor answer exposes `eventId: number | null`, so a fixture cannot manufacture a follow-up key. The same answer carries the row's `created_at`, compared against `TrackedSubject.establishedAt` so the overlap window's re-read of the establishing request stays the deduped `~review` trigger.
- **The follow-up reuses the feed kind.** `kind: 'review'` names the pulls feed; `kind: 'mention'` names the comments feed. The role lives in the id, exactly as `head` and `comment` already do. Widening `EventKind` would make both shipped parsers refuse the row.
- **Review comments use their own discriminator segment.** GitHub numbers conversation and review comments independently, so `~mention~review~<id>` and `~followup~review-comment~<id>` prevent collisions. The mention's segment also maps to the run-document origin `review-comment:<id>`, so it folds into a run rather than linking to nothing.
- **The added feed fails open.** A list failure logs `review-comment feed could not be listed; this cycle detects none` with the failure class and is treated as an empty list. This is a deliberate change from the scan's usual first-failure-ends posture: the feed is additive, and failing the cycle would suppress detection the operator already paid for. Required by FR-008 and AC-007.
- **Module names follow the export rule.** `service/poll/mentions-login.ts` exports `mentionsLogin` (re-exported from `triggers.ts` for existing imports), and `service/poll/review-comment-mention-events.ts` exports the detector, satisfying `llm-core/filename-match-export`.

## Constitution Check (v1.3.0)

- **I**: Outbound polling only; no push transport, no panel request.
- **II**: No new authority. Follow-ups join an existing session; mentions pass the existing authorization path; no implicit project and no auto-approval.
- **III**: Deterministic ids, existing dedupe, no new store file or schema version.
- **IV**: Audit names the specific reason for all four follow-up kinds; the failed feed is logged with its class.
- **V**: One in-budget read; no infrastructure or capability.
- **VI**: Every acceptance criterion is offline.
- **VII**: The panel reads and prompts only; detection stays in the service poll.
- **Invariants**: committed bundles rebuilt (1); manifest untouched (2); capabilities untouched (3); storage keys untouched (4); `SERVICE_VERSION` untouched (5); SDK pin untouched (6); zero suppressions/`any` (7); parsers fail closed or fail soft per entry (8); secrets untouched (9); event/NDJSON contract additive, no existing id moves (10).

**No violations and no exceptions.**

## Files

```text
service/poll/
├── mentions-login.ts                     # NEW — the shared bounded @login token match
├── review-comment-mention-events.ts      # NEW — review-comment mention detection
├── follow-up.ts                          # reviewFollowUp, reviewCommentFollowUp(s)
├── triggers.ts                           # fail-open second feed, re-export
├── triggers-review.ts                    # tracked pull → follow-up branch
├── events-write.ts                       # snapshot variants and discriminators
├── events-parse.ts                       # FollowUpKind, tails, discriminator parsing
├── events.ts                             # re-exports
├── events-enqueue-audit.ts               # followUpReasonOf
├── engine-compose.ts                     # movement text and pull-shaped handling
├── poller-entries.ts                     # PollReviewComment, readReviewCommentEntry
├── poller-events.ts                      # id, eventAt, CandidateActor.eventId
├── poller-github.ts                      # listReviewComments
├── tracking.ts                           # establishedAt on TrackedSubject
├── runs-types.ts                         # review-comment origin
├── runs-parts-parse.ts                   # origin validation
├── runs-join.ts                          # mention id → review-comment origin
src/
├── follow-up.ts                          # composition for four kinds
└── dispatches-detail.ts                  # panel parser for four kinds
tests/
├── follow-up-lifecycle.test.ts           # review-request and review-comment follow-ups
├── service-triggers.test.ts              # review-comment mentions, fail-open
├── service-poll-entries.test.ts          # reader mapping/refusals, event id
└── service-events.test.ts                # id minting/round-trip
panel/main.js, service/main.js            # rebuilt bundles
```

## Verification

`npm run verify` green on 2026-10-20: build, lint, `tsc --noEmit`, and 120 vitest files / 1 598 tests. No test requires a live instance or network.

## Risks

- **Fail-open masks a persistent outage.** Mitigated by the warn line carrying the failure class; the cycle's other detections still run, and the audit/scan discipline is unchanged elsewhere.
- **Two events for one review comment** when it both mentions the account and moves a tracked pull. This mirrors the shipped conversation-comment behaviour; the ids keep them distinct and the queue dedupes each independently.
- **Review-request event id absence** (fixture or older wire shape) falls back to `~review`, preserving pre-011 behaviour rather than losing the observation.
- **Cross-clock comparison (FR-001, accepted residual).** The strict-newer test compares GitHub's `created_at` against the service's `detectedAt`. If the service clock trails GitHub's by more than the gap between the row's creation and the scan that established the run, the establishing row can be judged newer once on the next cycle and mint exactly one duplicate follow-up; if the service clock leads, a genuine re-request created inside the skew is coalesced as the deduped `~review` and does not prompt. The error is bounded to one duplicate, or to one missed re-request surfaced as the existing trigger, and a key immune to it would need stored request state (FR-011 forbids a new persisted member).
