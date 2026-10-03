# Carry-forward: Normalized Event Contract v1 → v1.1 → v1.2

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27 · **Amended**: 2026-10-03 for `schemaVersion 1.2` (the actor allow-list, GitHub issue #9)

## What carries forward unchanged

`specs/001-agent-event-orchestrator/contracts/events.md` (v1) remains **the reference record** for the normalized event shape. **Historical-path note (2026-09-28, cleanup review):** that file was removed with the 001 directory in commit `110c0a2` — it is stamped provenance, not a live link; recover it with `git show 110c0a2^:specs/001-agent-event-orchestrator/contracts/events.md`. **This file is its live home**: the v1 semantics below are carried forward here and versioned additively to v1.1, so a reader who wants the event contract needs this file and nothing else. Unchanged semantics (spec FR-025):

- Kinds: `mention`, `issue_assignment`, `review_request`, `review_assignment`.
- Source identity scoped by provider / account / repository / source type.
- Content is **untrusted** and delimiter-bounded before dispatch; comments are re-fetched; deleted/inaccessible content is non-actionable.
- Correlation id on every record.
- The trigger schemas it describes (what each kind means and how it is classified) carry forward as-is; 002 implements them service-side per `research.md` §R6.

001 files that are **evidence, not production contract** stay pointed-at, not copied: `contracts/openchamber.md` (spike manifest/session-verification record; amendments 1–4 still govern naming and the project-picker precedence), `contracts/config.md` (deferred daemon YAML), `contracts/daemon-deferred.md` (unselected boundary). **All three were removed with the 001 directory in commit `110c0a2` (2026-09-28)** — each citation is historical; recover with `git show 110c0a2^:specs/001-agent-event-orchestrator/contracts/<file>`, and read their surviving force in `../plan.md` and `../spec.md`.

## What 002 versions: `schemaVersion 1.1` (additive)

The production `Delivery` record is v1.1 because the production spec adds requirements v1 did not have:

| Addition | Field | Requirement |
| --- | --- | --- |
| Delivery key (dedup identity) | `deliveryKey` | FR-019 — stable key over provider, account, repository, source type, source id, event kind |
| Re-fetch/diff metadata | `content.deleted`, `subject.headSha`, `source.updatedAt` freshness | FR-026 — SHA drift / removal pause |
| Redaction metadata | `content.truncated`, excerpt bounds | FR-028 (≤4,000 chars/item), NFR-004 |
| Run linkage | run key derived outside the record; `correlationId` shared | FR-030 |

**Serialization note**: stored/transported JSON fields are camelCase (`schemaVersion`, `deliveryKey`, …) for the same reason as contract amendment 1 in 001 `contracts/openchamber.md` — the repo lints TS property names with `@typescript-eslint/naming-convention`, and our records are typed in TS. The v1 snake_case example in 001 `events.md` stays untouched as the historical reference; the field mapping is 1:1 (`schema_version`→`schemaVersion`, `account_id`→`accountNumericUserId`, `updated_at`→`source.updatedAt`, …). **Mapping assertion — recorded as a planned fixture, not a live one (checked 2026-09-28, cleanup review).** This document previously named `tests/contract/events-v1-mapping.test.ts` as the fixture that asserts every v1 field maps to exactly one v1.1 field with identical semantics. That path does not exist in the current suite (`tests/contract/` was never created, and no test reads the v1 record), so the sentence is relabelled rather than left to send a reader after a missing file: the mapping above is **documented and normative**, and adding the fixture — or dropping the claim — is Phase 6 work under 002 FR-042's documentation-synchronisation requirement. The v1 record itself is recoverable from git history (`git show 110c0a2^:specs/001-agent-event-orchestrator/contracts/events.md`).

## What 002 versions at `schemaVersion 1.2`: the attributed actor (additive, 2026-10-03)

The production `Delivery` record is v1.2 because 002 v1.11.0 adds the **triggering actor** to the base snapshot every trigger kind shares:

| Addition | Field | Requirement |
| --- | --- | --- |
| The login the event is attributed to | `actorLogin` | FR-043 — a GitHub login, public repository identity, bounded by the module's existing 60-character author bound; credential-free by construction |
| How that attribution was made | `actorAttribution` | FR-044 — the **closed** union `'direct' \| 'subject-author'`, validated on write and on read; an unrecognized value **refuses the record** rather than defaulting to a guess (002 FR-024) |

`actorAttribution` is not cosmetic. It is the difference between a fact and an
inference, and every surface that names the actor must honour it (NFR-011):

- **`'direct'`** — GitHub itself named the author of the text that caused the
  trigger: the comment's author for a comment mention, the issue's author for an
  issue-body mention. This is **causation**; nothing is inferred.
- **`'subject-author'`** — a **documented proxy**. GitHub's issues list exposes
  `assignees` and never who assigned; its pulls list exposes `requested_reviewers`
  and never who requested the review (see `../research.md` §R8 for the reading
  verified against the shipped readers). The event is therefore attributed to the
  **issue or pull-request author**, which is the closest identity the feed names
  and is **not** the identity that acted. Both the `assignment` and the `review`
  kinds use this basis. No other value is legal.

**Four rules that travel with the addition:**

1. **Attribution is mandatory and fail-closed.** Every row this build writes
   carries a readable, non-bot `actorLogin`. The judgement is the existing one —
   `isBotAuthor` (a `[bot]` login suffix **or** `authorType === 'Bot'`) plus the
   unreadable-author check beside it — extended from the mention triggers to
   **all four** kinds, so a bot-authored comment, issue body, assignment, or
   review request is non-actionable and creates no event at all (FR-045). No
   binding field can make one allowed.
2. **The delivery key and the event id are untouched** (FR-046). The identifier
   is simultaneously the delivery's dedupe key, its relay path segment, and the
   reference recorded in existing panel ledgers, audit rows, and the run history,
   so the actor **rides the record and never its identity**: one observation is
   one event before and after this amendment, and under any allow-list (AC-027).
3. **On pre-1.2 rows both members are absentable.** The shipped row carries no
   `schemaVersion` field at all, so this version is a **contract** version and no
   row gains one (plan D1) — adding a stored version would make every
   pre-existing row fail its own check and quarantine the file. An older row
   parses with both members absent, and absence means *no attribution was
   recorded*, never *allowed later*: 003 FR-080 refuses a run whose references
   carry no readable actor, and **no migration is written** (the product owner
   ruled it on 2026-10-03: *"there are no migrations needed as we haven't
   released yet"*).
4. **The actor is a record member of the delivery and of the run's source
   references** (003's `SourceReference`), which is how the panel renders it and
   how the authorization gate reads it. The **permitted** set is a different
   thing entirely and appears **nowhere** in any trail, record, projection, or
   bundle (NFR-113) — see [`binding-allow-list.md`](./binding-allow-list.md).

No v1 or v1.1 member changes shape, nothing is removed, and no wire path changes.

## Dispatch attachment (how a Delivery becomes a session)

Not part of the event schema, documented here so the chain is traceable (FR-005/FR-028):

```
host.startSession({
  providerId: 'mecha-turk',
  id:        attachItemId            // "mt-run-" + runKeyHash[0:24] (deterministic, ≤128)
  title, url, kind: 'issue'|'pull',  // from Delivery.source / Delivery.subject
  text:      bounded excerpt         // ≤12,000 chars incl. delimiters (≤4,000 per source item)
  data:      { correlationId, runKeyHash }   // opaque host payload, ≤16,000 chars; never reaches the model
  projectId, worktree, navigation: 'preserve'
})
```

Source text is wrapped in explicit delimiters with an untrusted-input preamble so it cannot alter policy, credentials, approval requirements, or tool scope (FR-028, constitution Security Standard 3).
