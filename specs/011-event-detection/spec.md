# Feature Specification: Wider event detection — re-requested reviews and inline review comments

**Feature ID**: `011-event-detection`

**Feature Branch**: `issue-mt-run-dcc1b0700c157011f3c87b15-kinetic-condor`

**Created**: 2026-10-19

**Last Updated**: 2026-10-19

**Version**: 1.0.0

**Status**: **Approved for implementation** — GitHub issue #61. Wave 1 (this specification, plan and tasks) was dispatched by the PM; implementation landed with the same handoff. Wave 2 is named under `## Deferred` and is not implemented here.

**Dependencies**: Feature 002 `002-agent-event-extension` (v1.19.1 → **amended at v1.19.2 by this specification's changelog note**). 002 remains the production spec of record for triggers, follow-ups and the event id family; this document extends K.1/K.2 in place without renumbering a 002 requirement. Features 003 and 008–010 are read, not amended.

**Input**: GitHub issue #61 — *"Widen event detection so a re-requested review on a tracked pull request becomes a follow-up keyed by the event id, and inline review comments on the `pulls/comments` feed produce mentions and follow-ups."*

**Constitution**: `.specify/memory/constitution.md` **v1.3.0**. No amendment is required; alignment is stated under `## Constitution Alignment`.

**Supporting artifacts (this phase)**: none created — one added GitHub read, no persisted entity or wire operation, the existing offline commands suffice.

---

## Constitution Alignment

- **I — polling-first, contract-first.** The service gains one outbound list read on an endpoint GitHub already serves; nothing pushes, no webhook or long-poll appears, and the panel makes no new request of its own.
- **II — human authority.** Neither change creates, authorizes or claims a session. A review-request follow-up joins an existing recorded session; a review-comment mention remains an ordinary trigger judged by the existing authorization path. Nothing is auto-approved.
- **III — durable, idempotent work.** Ids stay deterministic: the review-request id carries the naming event's own id, and the review-comment ids carry the comment id. Replaying a window therefore produces no duplicate row, and no new store file or schema version is introduced.
- **IV — human-visible auditability.** A detected follow-up records why it was observed, in operator words, for all four follow-up kinds; a failed review-comment feed is logged with its failure class rather than silently treated as empty.
- **V — minimal, self-hosted.** One additional repository-wide read per mention-enabled binding per cycle, inside the existing per-account rate budget and backoff ladder; no new process, service, capability or configuration field.
- **VI — specification and verification before implementation.** Every acceptance criterion below is checkable offline against the fake poller, temp stores and the fake host; no live instance, PAT or network is required.
- **VII — stay inside the harness.** The panel still only reads the service and prompts the host; the added detection is a service-side poll, not a queued send or a second scheduler.

---

## Problem Statement

Tracking already follows comments and head movements on a tracked pull request, but two movements the operator cares about are invisible:

1. A review **re-requested** on a pull that already has a run produces the ordinary `~review` trigger. That trigger is deduplicated by its fixed id, so the second request never reaches the agent — the run already exists and the trigger adds a source reference that is never delivered as a movement.
2. Inline review comments live on `GET /repos/{owner}/{repo}/pulls/comments`, a different feed from the conversation comments the mention scan already lists. A review comment that mentions the bound account, or that moves a tracked pull, is therefore not detected at all.

The fix must keep every existing id stable: an untracked review request still mints `~review`, and a conversation comment's `~mention~<id>` does not move.

## Done when

An operator sees, without a new setting or tab, that (a) a review requested again on a pull the agent is already working reaches that session as a follow-up, and (b) a mention or movement in an inline review comment produces exactly one correctly-typed event — and the scan still keeps working when the review-comment feed is unavailable.

## Functional Requirements

- **FR-001**: **A re-requested review on a tracked pull is a follow-up, not a trigger.** When the review-request scan resolves a candidate actor for a pull request that already has a tracked subject, and the naming `review_requested` row carries a readable event id, the row MUST be emitted as a follow-up with id `~followup~review~<eventId>` — reusing `kind: 'review'` as the feed the detection rode, and writing `subjectType` from the tracked subject.
- **FR-002**: **The existing trigger id is unchanged where no follow-up key exists.** A review request on an untracked pull, or one whose naming row carries no readable event id, MUST still emit the existing `~review` trigger. No existing id changes shape.
- **FR-003**: **The event id comes from the naming row, and only a positive safe integer is usable.** `PollItemEvent.id` is optional; it is populated only when the wire sent a positive safe integer. A missing or unusable id is `null` on the actor answer and selects FR-002's fallback rather than inventing a key. No second read is made to obtain it.
- **FR-004**: **Inline review comments are read once per cycle, per mention-enabled binding.** The service MUST call `GET /repos/{owner}/{repo}/pulls/comments` with the binding's `since` window, newest-updated first, at most once per binding per cycle, and only when the binding's mention trigger is enabled. The read is charged to the same per-account rate budget and bounded backoff ladder as every other poller request, and its entries are parsed fail-soft per entry.
- **FR-005**: **A review comment that mentions the bound account is an ordinary mention event.** It MUST carry `origin: 'review-comment'`, `kind: 'mention'`, `commentId` from the review comment, `subjectType: 'pull_request'`, and id `~mention~review~<commentId>`. The `review` segment is required because GitHub numbers review comments independently from conversation comments: the same integer can name one of each.
- **FR-006**: **A review comment on a tracked pull is a follow-up.** It MUST carry `kind: 'mention'` (the feed family), `followUp: 'review-comment'`, `subjectType` from the tracked subject, and id `~followup~review-comment~<commentId>`. It does not claim that anyone mentioned the account.
- **FR-007**: **The review-comment gates are the existing ones, not a second rule.** Window membership and the shipped attribution predicate (`isAttributableAuthor` / `isBotAuthor`) apply exactly as they do to conversation comments; a bot, an unnamed author, or a comment outside the window yields nothing. No new mention matcher, window, or author rule is introduced. A review comment that both mentions the account and moves a tracked pull produces both its mention and its follow-up, as the conversation-comment path already does.
- **FR-008**: **The review-comment feed fails open within the cycle.** If the list call fails, the service MUST log the failure class and treat the feed as empty for that cycle, then continue with conversation-feed detection and enqueue what it found. The failure MUST NOT fail the binding's scan, retain the checkpoint, or suppress the conversation feed's events: the added feed is additive, and its outage must not cost detection the operator already paid for.
- **FR-009**: **The widened ids parse everywhere they are read.** The service queue parser, follow-up discriminator check, follow-up detector, audit reason, engine composition and the panel's run-row parser MUST all accept `review` and `review-comment` as follow-up kinds and `~mention~review` as a mention origin. A malformed tail is still refused; an unknown kind still makes the row a trigger rather than a follow-up.
- **FR-010**: **Idempotency and distinctness are the existing queue rules.** The same review-comment id, or the same review-request event id, observed twice across cycles, the overlap window, a restart, a replay or a remount MUST produce one delivery; two different event ids or two different comment ids MUST produce two. No new suppression mechanism is added.
- **FR-011**: **No new trigger kind, operation, capability, configuration field, storage key, or persisted file.** The event queue and run document gain no schema version. The manifest, `SERVICE_VERSION`, SDK pin and `package.json` version do not move. The panel gains no control and no direct GitHub request.
- **FR-012**: **A review-comment entry is read only when it can be attributed and named.** The reader requires a positive integer `id`, a pull number from `pull_request_url`, a string `body`, a string `html_url`, and a readable `user.login`; an entry missing any of these is dropped rather than partially applied (`AGENTS.md` invariant 8).

## Acceptance Criteria

- **AC-001**: A tracked pull with a `review_requested` row whose id is `7` emits exactly one follow-up, `evt-<base>~followup~review~7`, with `kind: 'review'` and the tracked `subjectType`; the pulls list and the one actor read are the only requests before FR-106's terminal read.
- **AC-002**: The same request on an untracked pull emits exactly one `~review` trigger and no follow-up.
- **AC-003**: A naming row with no usable id on a tracked pull emits the `~review` trigger, not a follow-up.
- **AC-004**: Event ids `7` and `8` on the same tracked pull produce two distinct follow-up ids across replays; replaying id `7` again produces no second row.
- **AC-005**: A review comment mentioning the bound account emits `evt-<base>~mention~review~<commentId>` with `origin: 'review-comment'`, `subjectType: 'pull_request'`, and the commenter as actor.
- **AC-006**: A review comment on a tracked pull emits `evt-<base>~followup~review-comment~<commentId>` with `kind: 'mention'`; a bot-authored or unnamed-author review comment emits nothing.
- **AC-007**: A failed review-comment list logs `review-comment feed could not be listed; this cycle detects none` with the failure class, and a conversation comment in the same cycle is still enqueued.
- **AC-008**: `readReviewCommentEntry` maps a healthy row and refuses each of: id `0`, string id, unusable `pull_request_url`, missing body, missing URL, absent user.
- **AC-009**: `readItemEventEntry` carries `id` for a positive integer and omits it for `0`, a negative number, a fraction, a string, and `null`.
- **AC-010**: With the mention trigger off, the cycle makes no `pulls/comments` request; with it on, exactly one is made per cycle.
- **AC-011**: The panel parses and composes all four follow-up kinds (`comment`, `head`, `review`, `review-comment`), and the audit row names the specific reason for each; a run row carrying `review-comment` still round-trips through the shipped parser.
- **AC-012**: `npm run verify` is green offline (build, lint, typecheck, all vitest suites).

## Non-Functional Requirements

- **NFR-001**: **Cost stays inside the design point.** One repository-wide review-comment read is added per mention-enabled binding per cycle; it uses the existing `since` window, pagination bound, rate budget, backoff, and conditional-request posture, so NFR-003 of 002 keeps its ~600–1,500 requests/hour design point.
- **NFR-002**: **Replay safety.** Replaying any window 100 times, restarting mid-queue, and remounting the panel produce zero duplicate deliveries for a review-request event id or review-comment id.
- **NFR-003**: **Offline, deterministic verification.** Every criterion is discharged against fake pollers, temp stores and the fake host; no test needs a live OpenChamber, a real PAT, or network.

## Surface Delta

| Surface | Change |
| --- | --- |
| GitHub reads | One added list read: `GET /repos/{owner}/{repo}/pulls/comments` (FR-004) |
| Event ids | Two added follow-up tails, `~followup~review~<eventId>` and `~followup~review-comment~<commentId>`; one added mention discriminator, `~mention~review~<commentId>` |
| Service modules | `mentions-login.ts` extracted, `review-comment-mention-events.ts` added, follow-up/trigger/poller/parser modules extended |
| Panel | Parser and message composition accept the two new follow-up kinds; no UI control or affordance |
| Store / wire operations / manifest / capabilities / configuration | Unchanged |

## Deferred (Wave 2 and later)

- **Team review requests** (`requested_teams`): a team request cannot be attributed to the bound account through `review_requester`/`requested_reviewer` alone, and testing it needs a team fixture the API does not expose to a token with only repository read. Reason: attribution would be a guess, and constitution II forbids guessing authority.
- **Draft → ready gating**: the ready-for-review transition is a different pull-request fact, and the issue does not decide whether it should trigger, follow up, or notify. Reason: a product decision is missing, not an implementation.
- **Tracking-end notification**: 002 FR-106 already stops detection when the item reaches a terminal state; announcing it is a new operator-visible surface that Wave 1 does not need. Reason: scope is notification, not detection, and it would add an affordance.
- **Review submission / changes-requested state**: a whole review is read from a third feed (`pulls/{number}/reviews`) with its own eventual consistency, and the requested behaviour (does a `CHANGES_REQUESTED` re-open work?) is undecided. Reason: new read, new state semantics, no agreed product outcome; the current comment-level detection already covers the inline text.

## Not doing

- Any Wave 2 item above.
- A new trigger kind, a new settings field, a new storage key, or a new route.
- Refactoring unrelated poller, panel or store modules.
- Changing the evidence schema, NDJSON contract, SDK pin, manifest, capabilities or version.
