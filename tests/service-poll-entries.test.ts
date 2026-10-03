/**
 * The poller's three list-feed readers (`service/poll/poller-entries.ts`).
 *
 * These readers are the only place a raw GitHub list body becomes a
 * normalized entry, so what they *refuse* and what they answer when a field is
 * missing is the difference between a dropped observation and a wrong one.
 * `PollIssue` and `PollComment` have been covered at that boundary all along;
 * `PollPull`'s two author members are new (002 FR-045) and are the reason this
 * suite exists, because they are what makes a `subject-author` attribution for
 * the review trigger possible at all.
 *
 * Three properties are asserted, and each exists because of a decision rather
 * than a default:
 *
 * - **`''` when absent**, exactly as the issue and comment readers answer, so
 *   one authorship rule covers all three feeds (002 FR-045).
 * - **The reader does not judge; the trigger does.** A pull request whose `user`
 *   GitHub sent nothing still parses and reads as an unreadable author. The
 *   comment reader drops such an entry outright, because a comment *is* the
 *   action; a pull request's author is only a proxy for a requester, so whether
 *   it is attributable is the trigger's call (002 FR-045(b)).
 * - **No extra request.** The author rides the `user` object the pulls list
 *   already returned, so no endpoint, pagination, or rate cost is added
 *   (research §R8).
 *
 * The bodies are written as the JSON text GitHub answers with rather than as
 * object literals, because `snake_case` keys are a property of the wire and not
 * of this project's vocabulary. Offline and deterministic: pure functions over
 * literal text, no network, no store, no clock.
 */

import { describe, expect, it } from 'vitest';
import { readCommentEntry, readIssueEntry, readPullEntry } from '../service/poll/poller-entries.ts';
import { isBotAuthor } from '../service/poll/attribution.ts';

/** A human author's login the fixtures report. */
const HUMAN_LOGIN = 'alice';

/** The type GitHub reports for that human author. */
const HUMAN_TYPE = 'User';

/** A bot account's login, as GitHub spells one. */
const BOT_LOGIN = 'dependabot[bot]';

/** The type GitHub reports for an ordinary login that is nevertheless a bot. */
const BOT_TYPE = 'Bot';

/**
 * One pulls-list entry with every field the reader requires.
 *
 * @param user - The `user` object as the wire carries it, or a value to test.
 * @returns The raw element, parsed as GitHub's list endpoint answers it.
 */
function pullEntry(user: unknown = { login: HUMAN_LOGIN, type: HUMAN_TYPE }): Record<string, unknown> {
    return JSON.parse(`{
        "number": 3,
        "title": "Change 3",
        "html_url": "https://github.com/acme/widget/pull/3",
        "state": "open",
        "requested_reviewers": [{ "login": "octocat-mt" }],
        "head": { "sha": "deadbeef" },
        "base": { "ref": "main" },
        "updated_at": "2026-09-27T00:35:00.000Z",
        "user": ${JSON.stringify(user)}
    }`) as Record<string, unknown>;
}

/**
 * One issues-list entry with every field the reader requires.
 *
 * @param user - The `user` object as the wire carries it, or a value to test.
 * @returns The raw element, parsed as GitHub's list endpoint answers it.
 */
function issueEntry(user: unknown = { login: HUMAN_LOGIN, type: HUMAN_TYPE }): Record<string, unknown> {
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
function commentEntry(user: unknown = { login: HUMAN_LOGIN, type: HUMAN_TYPE }): Record<string, unknown> {
    return JSON.parse(`{
        "id": 501,
        "issue_url": "https://api.github.com/repos/acme/widget/issues/7",
        "body": "cc @octocat-mt",
        "html_url": "https://github.com/acme/widget/issues/7#issuecomment-501",
        "updated_at": "2026-09-27T00:35:00.000Z",
        "user": ${JSON.stringify(user)}
    }`) as Record<string, unknown>;
}

/** An issues-list entry GitHub sent no `user` object for at all. */
function withoutUser(body: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...body };
    delete copy.user;

    return copy;
}

describe('PollPull authorship (002 FR-045, research §R8)', () => {
    it('reads both author members from the entry `user`, like the other two feeds', () => {
        const pull = readPullEntry(pullEntry());

        expect(pull).toMatchObject({
            pullNumber: 3,
            authorLogin: HUMAN_LOGIN,
            authorType: HUMAN_TYPE,
            requestedReviewers: ['octocat-mt'],
            headSha: 'deadbeef',
            baseRef: 'main',
        });
    });

    it("answers ''/'' for an entry GitHub named no author for, and keeps the entry", () => {
        // The reader does not judge attributability: the pull request is a real
        // observation with an unreadable author, and the trigger — not the feed
        // reader — decides that it is non-actionable (002 FR-045(b)).
        expect(readPullEntry(withoutUser(pullEntry()))).toMatchObject({ authorLogin: '', authorType: '' });

        // A `user` that is not an object answers `''`/`''` rather than failing
        // the entry, and each member is read independently of the other: a
        // `user` carrying only a type has no login but does have a type.
        expect(readPullEntry(pullEntry('octocat-mt'))).toMatchObject({ authorLogin: '', authorType: '' });
        expect(readPullEntry(pullEntry({ type: HUMAN_TYPE }))).toMatchObject({
            authorLogin: '',
            authorType: HUMAN_TYPE,
        });
    });

    it('reads a `type: Bot` author and a `[bot]` login so one predicate can judge both', () => {
        // Both bot signals reach the trigger, so `isBotAuthor` decides on the
        // rule that already exists rather than on a per-feed variant (002
        // FR-045(a)). Neither is read as an empty author, which is what lets the
        // predicate tell a bot apart from nobody.
        const typed = readPullEntry(pullEntry({ login: 'warehouse-runner', type: BOT_TYPE }));
        const suffixed = readPullEntry(pullEntry({ login: BOT_LOGIN, type: HUMAN_TYPE }));

        expect(typed).toMatchObject({ authorLogin: 'warehouse-runner', authorType: BOT_TYPE });
        expect(suffixed).toMatchObject({ authorLogin: BOT_LOGIN, authorType: HUMAN_TYPE });
        expect(isBotAuthor(typed?.authorLogin ?? '', typed?.authorType ?? '')).toBe(true);
        expect(isBotAuthor(suffixed?.authorLogin ?? '', suffixed?.authorType ?? '')).toBe(true);
    });

    it("answers the same ''-when-absent convention as the issue and comment readers", () => {
        // One authorship rule, three feeds: the convention is shared, not three
        // separate "missing" spellings a caller has to remember.
        expect(readIssueEntry(withoutUser(issueEntry()))).toMatchObject({ authorLogin: '', authorType: '' });
        // The comment reader is the exception the module documents: a comment
        // *is* the action, so an unreadable author drops the entry outright.
        expect(readCommentEntry(withoutUser(commentEntry()))).toBeNull();
    });
});
