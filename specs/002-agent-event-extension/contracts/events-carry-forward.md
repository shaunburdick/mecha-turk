# Carry-forward: Normalized Event Contract v1 → v1.1 → v1.2 → v1.3

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27 · **Amended**: 2026-10-09 for `schemaVersion 1.3` (the follow-up discriminator family, GitHub issue #13 — **additive; no existing id, member, or path changes**) · 2026-10-03 for `schemaVersion 1.2` (the actor allow-list, GitHub issue #9); **amended again the same day at spec v1.12.0** — `actorAttribution`'s producer narrows to `'direct'` only and `subject-author` becomes readable-but-unproduced. **No member is added, removed, renamed, or retyped by any amendment.** The v1.3 addition is the id family alone: **a follow-up adds no row member whatsoever**, because its content is the row's existing bounded excerpt and its seed is an existing member (`QueuedEvent.headSha`).

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

`actorAttribution` is the **provenance** of the attribution, not a decoration on it, and every
surface that names the actor must honour it (NFR-011). **What each value means, and — from
spec v1.12.0 — which value this build writes**, because the two halves of that answer are different
and conflating them is how the contract came to describe a mechanism that does not exist:

- **`'direct'`** — GitHub itself named the identity that **performed the act**. Nothing is
  inferred and nothing stands in. **This is the only value written at v1.12.0, for all four trigger
  kinds**: the comment's author for a comment mention, the issue's author for an issue-body
  mention, the naming `assigned` event's **`assigner`** for an assignment, and the naming
  `review_requested` event's **`review_requester`** for a review request. The last two are read
  from a per-item `GET /repos/{owner}/{repo}/issues/{issue_number}/events`, fetched only for an
  already-detected candidate (002 FR-049, FR-050).
- **`'subject-author'`** — **readable, and no longer written.** It remains a legal value of the
  closed union because rows the shipped build already wrote to `events.json` carry it, and a
  vocabulary a stored file still holds cannot be deleted without invalidating that file; a reader
  MUST accept it and a surface that encounters it MUST render it, because a row the panel cannot
  read hides an **entire** dispatch. **No row written at v1.12.0 may carry it**, no requirement or
  path may introduce a producer for it, and no fallback may reach for it when an actor cannot be
  read — the fallback for an unreadable actor is **no event** (002 FR-052).

  **The superseded rationale, recorded because the contract is where a reader looks first.** This
  section previously read: *"a **documented proxy**. GitHub's issues list exposes `assignees` and
  never who assigned; its pulls list exposes `requested_reviewers` and never who requested the
  review … the event is therefore attributed to the **issue or pull-request author**, which is the
  closest identity the feed names and is **not** the identity that acted. Both the `assignment` and
  the `review` kinds use this basis."* **That was false.** The two **list** feeds the poller calls
  do name no actor; **GitHub does**, one endpoint away, in `assigner` and `review_requester` on the
  item's own event record. The claim was a two-endpoint sample generalized to a provider — see
  `../research.md` §R8, rewritten at v1.12.0, and `../spec.md` changelog.md →
  `### v1.12.0`.

**Four rules that travel with the addition:**

1. **Attribution is mandatory and fail-closed.** Every row this build writes carries a readable,
   non-bot `actorLogin`. The judgement is the existing one — `isBotAuthor` (a `[bot]` login suffix
   **or** the account's `type === 'Bot'`) plus the unreadable-actor check beside it — applied to
   **all four** kinds, so a bot-authored comment, issue body, assignment, or review request is
   non-actionable and creates no event at all (FR-045). **From v1.12.0 the judgement reads the
   `assigner` / `review_requester` member for the two non-mention kinds**, which is the same
   `simple-user` shape the other feeds use, so **no second bot predicate is introduced**. A `null`
   or unreadable actor on those fields yields **no event this cycle** and substitutes nothing — not
   the same row's `actor`, not the issue author, not the `assignee` — and the overlapping scan
   window re-attempts on the next cycle (FR-052). No binding field can make a bot event allowed.
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

**A fifth rule, added at v1.12.0, and it is about the read rather than the record: a stored
`subject-author` row is ordinary.** It parses, it is admitted, the gate reads its `actorLogin`
normally, and every surface renders it with its basis stated — precisely so the correction does not
orphan real stored rows. It is **not** converted to `'direct'`, because a data rewrite would
destroy the one fact a reader needs about it: which rule was in force when the row was written
(NFR-011). No `schemaVersion` member is added for this either, and `SERVICE_SCHEMA_VERSION` stays
`1`.

No v1 or v1.1 member changes shape, nothing is removed, and no wire path changes.

## What 002 versions at `schemaVersion 1.3`: the follow-up discriminator family (additive, 2026-10-09)

The `Delivery` record is v1.3 because 002 v1.16.0 adds a **role** to the existing record rather than a new kind of trigger: a **follow-up** is a delivery whose action is a prompt into an existing session (GitHub issue #13's *"how can it maintain follow up through the lifecycle?"*). **Its identity is the same `evt-` id with a new discriminator, and its row gains no member at all** — the text it carries is the row's existing bounded excerpt, and the head-SHA seed it needs is the row's existing `headSha`. **Every existing id is byte-identical, the base is unchanged, and no trigger row changes**.

| Addition | Form | Requirement |
| --- | --- | --- |
| Timeline-comment discriminator | `~followup~<commentId>` | FR-101 — detected from the repository-wide issues-comments feed the scan already reads, linked by the row's `issue_url`, at zero added requests (FR-102) |
| Head-SHA-change discriminator | `~followup~head~<sha>` | FR-101, FR-103 — detected from the pulls list the scan already reads by comparing `head.sha` against the seed; at most one per subject per cycle |

**Four rules that travel with the addition:**

1. **Collision-free by construction.** The discriminator's first segment is `followup`; no trigger discriminator (`mention`, `review`, or an assignment's absence) can produce it. A comment id is decimal and a SHA is hexadecimal, so the two forms can never be confused with each other either, and **each of the two new tails stays inside `[A-Za-z0-9._~]`** — one URL path segment, no route ambiguity. **The claim is of the tails and not of the id as a whole**, because the shipped writer's own shape is `evt-<owner>~<repo>~<issueNumber>~<accountNumericUserId>` and the `evt-` prefix already carries a hyphen outside that set. The same comment, or the same head, observed across cycles, the overlap window, a restart, a replay, and a remount dedupes to **one** delivery through the queue's **existing** delivery-id deduplication, which is the only suppression mechanism this amendment adds: none.
2. **The actor rides the record and never the identity** (FR-046, unchanged): a follow-up's `actorLogin` is the row's own, `actorAttribution: 'direct'`, judged by the same author judgement every trigger kind uses.
3. **A follow-up is not a trigger and not an authorization.** It enters the allow-list gate nowhere (003 v1.8.0 judges dispatch authorization), it is not a source reference on the run, and it grants no binding field a second membership comparison of its own.
4. **`schemaVersion` is still not a stored member** (the rule 1.2 established, plan D1): the version is a contract version, no row gains one, and an older reader parses a v1.3 row with the follow-up discriminator present but unrecognized as a shape it refuses — which is why the family is *two new forms*, not a new member. `SERVICE_SCHEMA_VERSION` stays `1`.

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

## Follow-up delivery (how a Delivery reaches an existing session)

Not part of the event schema, documented here so the chain is traceable (FR-104, FR-105): a follow-up's message is composed with the same bounds and delimiters as a dispatch's — ≤4,000 characters per source item, ≤12,000 per follow-up, explicit delimiters, untrusted preamble, the run's correlation id — measured **before** any host call and refused rather than truncated when over budget (FR-104, the budget floor 004 FR-085 set). Delivery is `host.prompt({ text, send: true })` into the session the run's dispatch created, after `host.openSession(sessionId)` only when that session is not already the current one, with the intent to navigate recorded durably **before** the call. The panel is the only party that calls the host; the service holds no session address of its own beyond the run's.

**The over-budget arm is a guard, not a reachable path.** The follow-up's frame is the *context's own* header — not a second frame stacked on a dispatch's — so the composed message is sized by the same bounded renderer against the same `CONTEXT_MAX_CHARS` budget, and a composition that shares that budget cannot exceed it. The measurement still runs before every host call and the refusal is still total; what the structure buys is that no shipped composition path can reach it, so the arm is a check on a divergence that would be a defect rather than an expected outcome.
