/**
 * The poller's four feed readers: the three list feeds
 * (`service/poll/poller-entries.ts`) and one item's event list
 * (`service/poll/poller-events.ts`).
 *
 * These readers are the only place a raw GitHub body becomes a normalized row, so
 * what they *refuse* and what they answer when a field is missing is the
 * difference between a dropped observation and a wrong one. `PollIssue` and
 * `PollComment` have been covered at that boundary all along.
 *
 * Three properties are asserted, and each exists because of a decision rather
 * than a default:
 *
 * - **`''` when absent**, exactly as the issue and comment readers answer, so
 *   one authorship rule covers every feed — including the events feed, whose
 *   `assigner` / `review_requester` are `simple-user` members carrying `login`
 *   and `type` like every other actor (002 FR-045).
 * - **The reader does not judge; the trigger does.** An event row whose actor is
 *   a bot still parses; whether it is attributable is the caller's judgement to
 *   make (002 FR-045(b), FR-052). What the reader *does* refuse is a row it
 *   cannot measure at all: no kind word, or no readable `created_at`.
 * - **No `actor` member exists, and no `pull_request` member is read.** `actor`
 *   is the person who *generated* an event, not the person who performed the
 *   act, so the normalized shape has no such member and the substitution is
 *   unreachable rather than merely unused (002 FR-049). The review kind already
 *   knows its subject is a pull request from the feed that detected it, so
 *   `issue.pull_request` would be a second source for a fact already held.
 *
 * The bodies are written as the JSON text GitHub answers with rather than as
 * object literals, because `snake_case` keys are a property of the wire and not
 * of this project's vocabulary. Offline and deterministic: pure functions over
 * literal text, no network, no store, no clock.
 */

import { describe, expect, it } from 'vitest';
import { readCommentEntry, readIssueEntry, readPullEntry } from '../service/poll/poller-entries.ts';
import { isBotAuthor, isAttributableAuthor } from '../service/poll/attribution.ts';
import { readItemEventEntry } from '../service/poll/poller-events.ts';

/** A human author's login the fixtures report. */
const HUMAN_LOGIN = 'alice';

/** The type GitHub reports for that human author. */
const HUMAN_TYPE = 'User';

/** A bot account's login, as GitHub spells one. */
const BOT_LOGIN = 'dependabot[bot]';

/** The type GitHub reports for an ordinary login that is nevertheless a bot. */
const BOT_TYPE = 'Bot';

/** The `created_at` every events fixture reports (FR-051's stamp). */
const EVENT_STAMP = '2026-09-27T00:35:00.000Z';

/**
 * One pulls-list entry with every field the reader requires.
 *
 * @returns The raw element, parsed as GitHub's list endpoint answers it.
 */
function pullEntry(): Record<string, unknown> {
    return JSON.parse(`{
        "number": 3,
        "title": "Change 3",
        "html_url": "https://github.com/acme/widget/pull/3",
        "state": "open",
        "requested_reviewers": [{ "login": "octocat-mt" }],
        "head": { "sha": "deadbeef" },
        "base": { "ref": "main" },
        "updated_at": "2026-09-27T00:35:00.000Z",
        "user": { "login": "${HUMAN_LOGIN}", "type": "${HUMAN_TYPE}" }
    }`) as Record<string, unknown>;
}

/** The `user` object a healthy entry carries. */
const HUMAN_USER = { login: HUMAN_LOGIN, type: HUMAN_TYPE };

/**
 * One issues-list entry with every field the reader requires.
 *
 * @param user - The `user` object as the wire carries it, or a value to test.
 * @returns The raw element, parsed as GitHub's list endpoint answers it.
 */
function issueEntry(user: unknown = HUMAN_USER): Record<string, unknown> {
    return JSON.parse(`{
        "number": 7,
        "title": "Flux capacitor drifts",
        "html_url": "https://github.com/acme/widget/issues/7",
        "state": "open",
        "body": null,
        "assignees": [{ "login": "octocat-mt" }],
        "updated_at": "2026-09-27T00:35:00.000Z",
        "user": ${JSON.stringify(user)}
    }`) as Record<string, unknown>;
}

/**
 * One issue-comments-list entry with every field the reader requires.
 *
 * @param user - The `user` object as the wire carries it, or a value to test.
 * @returns The raw element, parsed as GitHub's endpoint answers it.
 */
function commentEntry(user: unknown = HUMAN_USER): Record<string, unknown> {
    return JSON.parse(`{
        "id": 501,
        "issue_url": "https://api.github.com/repos/acme/widget/issues/7",
        "body": "cc @octocat-mt",
        "html_url": "https://github.com/acme/widget/issues/7#issuecomment-501",
        "updated_at": "2026-09-27T00:35:00.000Z",
        "user": ${JSON.stringify(user)}
    }`) as Record<string, unknown>;
}

/** A list entry GitHub sent no `user` object for at all. */
function withoutUser(body: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...body };
    delete copy.user;

    return copy;
}

/**
 * An issue entry whose `user` member is absent.
 *
 * Absent rather than `null`, because the module's rule is that a missing actor
 * and a null one are different spellings a caller has to choose between; the
 * fixture says which one it means.
 *
 * @returns The entry.
 */
function anonymousIssueEntry(): Record<string, unknown> {
    return withoutUser(issueEntry());
}

/**
 * A comment entry whose `user` member is absent, for the same reason.
 *
 * @returns The entry.
 */
function anonymousCommentEntry(): Record<string, unknown> {
    return withoutUser(commentEntry());
}

/**
 * Build one event-list row **as the wire carries it**, so `snake_case` keys are
 * a property of GitHub's JSON rather than of this project's vocabulary.
 *
 * @returns The raw element, parsed.
 */
function wireEventRow(input: {
    /** Kind word; `''` answers an empty one. */
    readonly kind?: string;
    /** The member to leave out entirely. */
    readonly omit?: 'event' | 'created_at';
    /** Stamp to report; anything unparseable exercises the refusal. */
    readonly stamp?: string;
    /** `event` member as JSON text, or `null` for the `null` the schema allows. */
    readonly event?: 'null';
    /** `actor` member as JSON text. */
    readonly actor?: string;
    /** `assigner` member as JSON text. */
    readonly assigner?: string;
    /** `assignee` member as JSON text. */
    readonly assignee?: string;
    /** `issue` member as JSON text. */
    readonly issue?: string;
}): Record<string, unknown> {
    const stamp = input.stamp ?? EVENT_STAMP;
    const members: Record<string, string> = {};
    if (input.omit !== 'event') {
        members.event = JSON.stringify(input.kind ?? 'assigned');
    }
    if (input.omit !== 'created_at') {
        members.created_at = JSON.stringify(stamp);
    }
    const named = {
        actor: input.actor,
        assigner: input.assigner,
        assignee: input.assignee,
        issue: input.issue,
    };
    for (const [key, value] of Object.entries(named)) {
        if (value !== undefined) {
            members[key] = value;
        }
    }

    const body = Object.entries(members)
        .map(([key, value]) => `"${key}": ${value}`)
        .join(', ');

    return JSON.parse(`{ ${body} }`) as Record<string, unknown>;
}

/**
 * One `assigned` event row, as the per-item events feed answers it.
 *
 * The `issue.pull_request` member is present on purpose: FR-049 names it as a
 * member this read may look at, and the test below asserts the reader does not
 * — the candidate's own listing already says whether it is a pull request, so
 * carrying a second source for that fact would be one more thing to disagree.
 *
 * @returns The raw element, parsed as GitHub's endpoint answers it.
 */
function assignedRow(): Record<string, unknown> {
    return wireEventRow({
        actor: '{ "login": "automation-app", "type": "Bot" }',
        assigner: `{ "login": "${HUMAN_LOGIN}", "type": "${HUMAN_TYPE}" }`,
        assignee: `{ "login": "octocat-mt", "type": "${HUMAN_TYPE}" }`,
        issue: '{ "number": 7, "pull_request": { "url": "https://api.github.com/repos/acme/widget/pulls/7" } }',
    });
}


describe('the three list feeds keep their authorship convention (002 FR-045)', () => {
    it("answers the same ''-when-absent convention on issue and comment readers", () => {
        // One authorship rule, three feeds: the convention is shared, not three
        // separate "missing" spellings a caller has to remember.
        expect(readIssueEntry(anonymousIssueEntry())).toMatchObject({ authorLogin: '', authorType: '' });
        // The comment reader is the exception the module documents: a comment
        // *is* the action, so an unreadable author drops the entry outright.
        expect(readCommentEntry(anonymousCommentEntry())).toBeNull();
    });

    it('reads a `type: Bot` author and a `[bot]` login so one predicate can judge both', () => {
        // Both bot signals reach the trigger, so `isBotAuthor` decides on the
        // rule that already exists rather than on a per-feed variant (002
        // FR-045(a)). Neither is read as an empty author, which is what lets the
        // predicate tell a bot apart from nobody.
        const typed = readIssueEntry(issueEntry({ login: 'warehouse-runner', type: BOT_TYPE }));
        const suffixed = readIssueEntry(issueEntry({ login: BOT_LOGIN, type: HUMAN_TYPE }));

        expect(typed).toMatchObject({ authorLogin: 'warehouse-runner', authorType: BOT_TYPE });
        expect(suffixed).toMatchObject({ authorLogin: BOT_LOGIN, authorType: HUMAN_TYPE });
        expect(isBotAuthor(typed?.authorLogin ?? '', typed?.authorType ?? '')).toBe(true);
        expect(isBotAuthor(suffixed?.authorLogin ?? '', suffixed?.authorType ?? '')).toBe(true);
    });

    it('reads a pull request with no author member at all (002 FR-045 as re-cut at v1.12.0)', () => {
        // FR-045's sentence requiring `PollPull`'s author members is **struck**:
        // the review kind's actor comes from the naming `review_requested`
        // event's `review_requester`, so the proxy those fields existed for is
        // gone and they are gone with it. A hand-edited entry that still carries
        // a `user` is simply not read — an unknown member is ignored, not
        // honoured, and never widens the row.
        const pull = readPullEntry(pullEntry());

        expect(pull).toMatchObject({
            pullNumber: 3,
            requestedReviewers: ['octocat-mt'],
            headSha: 'deadbeef',
            baseRef: 'main',
        });
        expect(Object.keys(pull ?? {})).not.toContain('authorLogin');
        expect(Object.keys(pull ?? {})).not.toContain('authorType');
    });
});

describe('the per-item events reader (002 FR-049, FR-051)', () => {
    it('reads exactly the named members, and no `actor`', () => {
        const event = readItemEventEntry(assignedRow());

        expect(event).toEqual({
            event: 'assigned',
            assignee: { login: 'octocat-mt', type: HUMAN_TYPE },
            assigner: { login: HUMAN_LOGIN, type: HUMAN_TYPE },
            requestedReviewer: { login: '', type: '' },
            reviewRequester: { login: '', type: '' },
            issueNumber: 7,
            createdAt: EVENT_STAMP,
        });

        // The wire row above **does** carry an `actor` — an automation account,
        // which is exactly the case where `actor` and `assigner` differ. The
        // normalized shape drops it, so no later step can substitute the
        // generator for the performer (002 FR-049).
        const keys = Object.keys(event ?? {});
        expect(keys).not.toContain('actor');
        expect(keys).toContain('assigner');
    });

    it("answers ''/'' for a `null` actor member, and refuses a row it cannot measure", () => {
        // The `null` case FR-052 is specified against: the member exists and
        // carries nothing, so the reader keeps the row and says the actor is
        // unreadable rather than dropping the row or inventing an identity.
        expect(readItemEventEntry(wireEventRow({ assigner: 'null' })))
            .toMatchObject({ assigner: { login: '', type: '' } });

        // A row with no kind word, no stamp, or an unparseable stamp cannot be
        // windowed or compared, so it is skipped — the page survives.
        expect(readItemEventEntry(wireEventRow({ omit: 'event' }))).toBeNull();
        expect(readItemEventEntry(wireEventRow({ omit: 'created_at' }))).toBeNull();
        expect(readItemEventEntry(wireEventRow({ kind: '' }))).toBeNull();
        expect(readItemEventEntry(wireEventRow({ stamp: 'not-a-date' }))).toBeNull();
        expect(readItemEventEntry('not-a-row')).toBeNull();
    });

    it('carries an unrecognized kind word through rather than coercing it (FR-050)', () => {
        // The schema carries no enum, so GitHub may add a word this build has
        // never seen. It must be carried and never matched — a new kind is
        // ignored, not treated as one this build knows.
        expect(readItemEventEntry(wireEventRow({ kind: 'head_ref_deleted' })))
            .toMatchObject({ event: 'head_ref_deleted' });
    });

    it('judges a bot actor with the one existing predicate (FR-045(a))', () => {
        const bot = readItemEventEntry(wireEventRow({
            assigner: `{ "login": "warehouse-runner", "type": "${BOT_TYPE}" }`,
        }));
        const suffixed = readItemEventEntry(wireEventRow({
            assigner: `{ "login": "${BOT_LOGIN}", "type": "${HUMAN_TYPE}" }`,
        }));

        // One judgement, four trigger kinds: no second spelling of "is a bot"
        // exists for the events feed, so the two feeds cannot disagree (002
        // FR-045(a), 003 FR-080).
        expect(isAttributableAuthor(bot?.assigner.login ?? '', bot?.assigner.type ?? '')).toBe(false);
        expect(isAttributableAuthor(suffixed?.assigner.login ?? '', suffixed?.assigner.type ?? '')).toBe(false);
        expect(isAttributableAuthor(HUMAN_LOGIN, HUMAN_TYPE)).toBe(true);
    });
});
