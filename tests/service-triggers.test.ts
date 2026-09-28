/**
 * Slice-2 trigger detection: M6 comment mentions, M7 review requests, and
 * the event-kind round-trip they added to the queue's schema.
 *
 * Three classes of coverage, all driven through the real `runScanCycle`
 * (the same path production takes) plus the detector functions themselves:
 *
 * 1. mention — a human comment carrying `@<login>` queues one event, matched
 *    case-insensitively and bounded so `@octocat-mt2` is not a mention of
 *    `@octocat-mt`; bot authors are skipped outright, and two comments on
 *    one issue are two events (the comment id is in the event id);
 * 2. review — an open PR whose `requested_reviewers` names the bound
 *    account queues one event carrying `headSha`/`baseRef`, and a PR that
 *    asks nobody in particular queues nothing;
 * 3. schema — a `review` row round-trips through the parser with its
 *    nullable fields, a row written *before* M7 (no `headSha`/`baseRef` at
 *    all) still parses as `null` rather than quarantining a healthy queue,
 *    and a row carrying the wrong type still refuses.
 *
 * Each scan also records which feeds the poller was asked for, so the
 * switch wiring itself is asserted: a review-only binding never lists
 * issues or comments, and a binding with the mention switch off never lists
 * comments.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../extension/service/accounts/store.ts';
import { writeBindings } from '../extension/service/bindings.ts';
import { createLogger } from '../extension/service/log.ts';
import { createEvent, parseStoredEvent, readEvents } from '../extension/service/poll/events.ts';
import { runScanCycle } from '../extension/service/poll/loop.ts';
import { isMentionComment, isReviewRequestPull, mentionsLogin } from '../extension/service/poll/triggers.ts';
import { openStore } from '../extension/service/store/index.ts';
import type { Account } from '../extension/service/accounts/model.ts';
import type { BindingRecord, BindingTriggers } from '../extension/service/bindings.ts';
import type { EventSnapshot, QueuedEvent } from '../extension/service/poll/events.ts';
import type { ServiceLogger } from '../extension/service/log.ts';
import type { GitHubIssuePoller, PollComment, PollIssue, PollPull } from '../extension/service/poll/poller-github.ts';
import type { ServiceStore } from '../extension/service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** Binding id the mention fixtures bind. */
const MENTION_BINDING = 'bnd-mention';

/** Binding id the review fixtures bind. */
const REVIEW_BINDING = 'bnd-review';

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** Login the fixtures mention and request reviews from. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Stamp used for every fixture timestamp. */
const STAMP = '2026-09-27T00:35:00.000Z';

/** Repository label every fixture binds. */
const REPO_LABEL = 'acme/widget';

/** OpenChamber project every fixture dispatches to. */
const PROJECT_ID = 'prj_42';

/** The mention token the fixtures type, in every spelling the tests use. */
const MENTION_TOKEN = '@octocat-mt';

/** Title the review fixture's pull request carries. */
const PULL_TITLE = 'Change 3';

/** URL of that pull request. */
const PULL_URL = 'https://github.com/acme/widget/pull/3';

/** Comment id the first mention fixture carries. */
const FIRST_COMMENT_ID = 501;

/** Comment id the second mention fixture carries (same issue, other comment). */
const SECOND_COMMENT_ID = 502;

/** Head SHA the review fixture's pull request reports. */
const HEAD_SHA = 'deadbeefcafe000000000000000000000000beef';

/** Base ref the review fixture's pull request reports. */
const BASE_REF = 'main';

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

/** Logger the store requires; its lines are captured but never asserted. */
let log: ServiceLogger;

/** Lines the capturing logger wrote. */
let logLines: string[];

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-triggers-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    logLines = [];
    log = createLogger({
        level: 'debug',
        sink: (line: string) => {
            logLines.push(line);
        },
    });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build one stored binding with the given trigger set.
 *
 * @param bindingId - Id of the binding.
 * @param triggers - The switches this fixture turns on.
 * @returns A complete active binding.
 */
function fixtureBinding(bindingId: string, triggers: BindingTriggers): BindingRecord {
    return {
        bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPO_LABEL,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        triggers,
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Build the active account every fixture binds.
 *
 * @returns A complete stored account record (the token is a fixture value).
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        credential: { token: 'fixture-token-not-a-real-credential', kind: 'classic', verifiedAt: STAMP },
        scopeCheck: { checkedAt: STAMP, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: STAMP,
        errorReason: null,
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Build one open issue the mention scan resolves titles against.
 *
 * @returns The normalized issue.
 */
function fixtureIssue(): PollIssue {
    return {
        issueNumber: 7,
        title: 'Flux capacitor drifts',
        url: 'https://github.com/acme/widget/issues/7',
        state: 'open',
        body: null,
        assignees: [],
        isPullRequest: false,
        updatedAt: STAMP,
    };
}

/**
 * Build one issue comment.
 *
 * @param input - Comment id, body, and author identity.
 * @returns The normalized comment.
 */
function fixtureComment(input: {
    readonly commentId: number;
    readonly body: string;
    readonly authorLogin?: string;
    readonly authorType?: string;
}): PollComment {
    return {
        commentId: input.commentId,
        issueNumber: 7,
        body: input.body,
        url: `https://github.com/acme/widget/issues/7#issuecomment-${input.commentId}`,
        authorLogin: input.authorLogin ?? 'alice',
        authorType: input.authorType ?? 'User',
        updatedAt: STAMP,
    };
}

/**
 * Build one open pull request.
 *
 * @param input - PR number and the reviewers GitHub reports.
 * @returns The normalized pull request.
 */
function fixturePull(input: {
    readonly pullNumber: number;
    readonly requestedReviewers: readonly string[];
}): PollPull {
    return {
        pullNumber: input.pullNumber,
        title: `Change ${input.pullNumber}`,
        url: `https://github.com/acme/widget/pull/${input.pullNumber}`,
        state: 'open',
        requestedReviewers: input.requestedReviewers,
        headSha: HEAD_SHA,
        baseRef: BASE_REF,
        updatedAt: STAMP,
    };
}

/** A stub poller plus the feed names each call requested, in order. */
interface RecordedPoller {
    /** The poller the cycle is given. */
    readonly poller: GitHubIssuePoller;
    /** Feed names (`issues`/`comments`/`pulls`), in call order. */
    readonly calls: string[];
}

/**
 * Build a poller that answers with fixed feeds and records what was asked.
 *
 * @param feeds - Items each feed returns; an absent feed returns empty.
 * @returns The poller and the feed names it was asked for.
 */
function recordingPoller(feeds: {
    readonly issues?: readonly PollIssue[];
    readonly comments?: readonly PollComment[];
    readonly pulls?: readonly PollPull[];
}): RecordedPoller {
    const calls: string[] = [];
    const poller: GitHubIssuePoller = {
        listOpenIssues: async () => {
            calls.push('issues');

            return { kind: 'ok', issues: feeds.issues ?? [] };
        },
        listIssueComments: async () => {
            calls.push('comments');

            return { kind: 'ok', comments: feeds.comments ?? [] };
        },
        listOpenPulls: async () => {
            calls.push('pulls');

            return { kind: 'ok', pulls: feeds.pulls ?? [] };
        },
    };

    return { poller, calls };
}

/**
 * Run one cycle over the given binding and answer its queued events.
 *
 * @param binding - The binding to scan.
 * @param recorded - The poller feeding that scan.
 * @returns The events the cycle enqueued, in queue order.
 */
async function scan(binding: BindingRecord, recorded: RecordedPoller): Promise<readonly QueuedEvent[]> {
    await writeBindings({ store, bindings: [binding] });
    await writeAccount(store, fixtureAccount());

    const cycle = await runScanCycle({ store, log, poller: recorded.poller });
    expect(cycle.bindings).toHaveLength(1);

    return await readEvents({ store, log });
}

describe('mention detection (M6)', () => {
    it('queues one event per human comment that mentions the account, keyed by comment id', async () => {
        const recorded = recordingPoller({
            issues: [fixtureIssue()],
            comments: [
                fixtureComment({ commentId: FIRST_COMMENT_ID, body: 'cc @OCTOCAT-MT — drift again' }),
                fixtureComment({ commentId: SECOND_COMMENT_ID, body: 'confirmed, please look @OctoCat-Mt' }),
            ],
        });

        const events = await scan(
            fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
            recorded,
        );

        expect(recorded.calls).toEqual(['issues', 'comments']);
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.kind)).toEqual(['mention', 'mention']);
        // The comment id is in the event id: two comments on one issue are two events.
        expect(events.map((event) => event.id)).toEqual([
            `evt-acme~widget~7~${ACCOUNT_ID}~mention~${FIRST_COMMENT_ID}`,
            `evt-acme~widget~7~${ACCOUNT_ID}~mention~${SECOND_COMMENT_ID}`,
        ]);
        // The title resolves against the issue list the same scan read.
        expect(events[0]).toMatchObject({
            issueNumber: 7,
            issueTitle: 'Flux capacitor drifts',
            issueUrl: 'https://github.com/acme/widget/issues/7',
            accountLogin: ACCOUNT_LOGIN,
            state: 'pending',
            headSha: null,
            baseRef: null,
        });
        // The trigger note names the commenter, not just the account.
        expect(events[0]?.triggerNote).toContain('alice');
        expect(events[0]?.issueBodyExcerpt).toBe('cc @OCTOCAT-MT — drift again');
    });

    it('skips bot authors, lookalike handles, and bodies that never mention the account', async () => {
        const recorded = recordingPoller({
            issues: [fixtureIssue()],
            comments: [
                // A `[bot]` login that mentions the account.
                fixtureComment({
                    commentId: 601,
                    body: '@octocat-mt updated the lockfile',
                    authorLogin: 'dependabot[bot]',
                }),
                // A `type: Bot` author with an ordinary-looking login.
                fixtureComment({
                    commentId: 602,
                    body: '@octocat-mt build failed',
                    authorLogin: 'warehouse-runner',
                    authorType: 'Bot',
                }),
                // The account's handle as a prefix of a longer handle.
                fixtureComment({ commentId: 603, body: 'ask @octocat-mt2 instead' }),
                // The handle glued to a preceding character is not a mention.
                fixtureComment({ commentId: 604, body: 'mail octocat-mt@acme.dev' }),
                // The one real mention among the noise.
                fixtureComment({ commentId: 605, body: 'nice @octocat-mt, thanks!' }),
            ],
        });

        const events = await scan(
            fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
            recorded,
        );

        expect(events).toHaveLength(1);
        expect(events[0]?.id).toBe(`evt-acme~widget~7~${ACCOUNT_ID}~mention~605`);
    });

    it('never lists comments when the mention switch is off', async () => {
        const recorded = recordingPoller({ issues: [], comments: [] });

        const events = await scan(
            fixtureBinding(MENTION_BINDING, { assignment: true, mention: false, reviewRequest: false }),
            recorded,
        );

        expect(recorded.calls).toEqual(['issues']);
        expect(events).toEqual([]);
    });
});

describe('mention and review detectors (unit)', () => {
    it('matches the token case-insensitively and bounded on both sides', () => {
        expect(mentionsLogin(`hey ${MENTION_TOKEN.toUpperCase()}`, ACCOUNT_LOGIN)).toBe(true);
        expect(mentionsLogin(`(${MENTION_TOKEN})`, ACCOUNT_LOGIN)).toBe(true);
        expect(mentionsLogin('no handle here', ACCOUNT_LOGIN)).toBe(false);
        expect(mentionsLogin('two words: @ octocat-mt', ACCOUNT_LOGIN)).toBe(false);
        expect(mentionsLogin('@octocat-mt2', ACCOUNT_LOGIN)).toBe(false);
        expect(mentionsLogin('x@octocat-mt', ACCOUNT_LOGIN)).toBe(false);
        expect(mentionsLogin(MENTION_TOKEN, '')).toBe(false);
    });

    it('reads a bot comment as a bot whatever the author field says', () => {
        expect(isMentionComment(fixtureComment({
            commentId: 701,
            body: MENTION_TOKEN,
            authorLogin: 'some-bot[bot]',
        }), ACCOUNT_LOGIN)).toBe(false);
        expect(isMentionComment(fixtureComment({
            commentId: 702,
            body: MENTION_TOKEN,
            authorLogin: 'release-helper',
            authorType: 'Bot',
        }), ACCOUNT_LOGIN)).toBe(false);
        expect(isMentionComment(fixtureComment({ commentId: 703, body: MENTION_TOKEN }), ACCOUNT_LOGIN)).toBe(true);
    });

    it('matches a requested reviewer case-insensitively, and nobody else', () => {
        expect(isReviewRequestPull(fixturePull({ pullNumber: 1, requestedReviewers: ['OCTOCAT-MT'] }), ACCOUNT_LOGIN))
            .toBe(true);
        expect(isReviewRequestPull(fixturePull({ pullNumber: 2, requestedReviewers: ['someone-else'] }), ACCOUNT_LOGIN))
            .toBe(false);
        expect(isReviewRequestPull(fixturePull({ pullNumber: 3, requestedReviewers: [] }), ACCOUNT_LOGIN)).toBe(false);
    });
});

describe('review-request detection (M7)', () => {
    it('queues a review event with the PR head and base captured, and lists no issues', async () => {
        const recorded = recordingPoller({
            pulls: [fixturePull({ pullNumber: 3, requestedReviewers: [ACCOUNT_LOGIN.toUpperCase()] })],
        });

        const events = await scan(
            fixtureBinding(REVIEW_BINDING, { assignment: false, mention: false, reviewRequest: true }),
            recorded,
        );

        // A review-only binding pays for one feed, not three.
        expect(recorded.calls).toEqual(['pulls']);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'review',
            issueNumber: 3,
            issueTitle: PULL_TITLE,
            issueUrl: PULL_URL,
            headSha: HEAD_SHA,
            baseRef: BASE_REF,
            state: 'pending',
        });
        // The id carries the PR number, the account, and the kind.
        expect(events[0]?.id).toBe(`evt-acme~widget~3~${ACCOUNT_ID}~review`);
    });

    it('queues nothing for a pull request that does not ask this account', async () => {
        const recorded = recordingPoller({
            pulls: [fixturePull({ pullNumber: 9, requestedReviewers: ['someone-else'] })],
        });

        const events = await scan(
            fixtureBinding(REVIEW_BINDING, { assignment: false, mention: false, reviewRequest: true }),
            recorded,
        );

        expect(events).toEqual([]);
    });
});

describe('event kind round-trip (nullable Slice-2 fields)', () => {
    it('round-trips a review event with headSha and baseRef intact', () => {
        const snapshot: EventSnapshot = {
            bindingId: REVIEW_BINDING,
            repository: REPO_LABEL,
            accountNumericUserId: ACCOUNT_ID,
            accountLogin: ACCOUNT_LOGIN,
            projectId: PROJECT_ID,
            worktreeOption: 'none',
            kind: 'review',
            headSha: HEAD_SHA,
            baseRef: BASE_REF,
            issue: {
                issueNumber: 3,
                issueTitle: PULL_TITLE,
                issueUrl: PULL_URL,
                issueBodyExcerpt: '',
            },
            triggerNote: 'Pull request #3 requested the bound account\'s review',
            detectedAt: STAMP,
        };
        const event = createEvent(snapshot);

        expect(parseStoredEvent(JSON.parse(JSON.stringify(event)) as unknown)).toEqual(event);
        expect(event.headSha).toBe(HEAD_SHA);
        expect(event.baseRef).toBe(BASE_REF);
    });

    it('reads a row written before M7 — no headSha/baseRef at all — as null', () => {
        const stored: Record<string, unknown> = {
            ...createEvent({
                bindingId: MENTION_BINDING,
                repository: REPO_LABEL,
                accountNumericUserId: ACCOUNT_ID,
                accountLogin: ACCOUNT_LOGIN,
                projectId: PROJECT_ID,
                worktreeOption: 'none',
                kind: 'assignment',
                issue: {
                    issueNumber: 2,
                    issueTitle: 'Ticket #2',
                    issueUrl: 'https://github.com/acme/widget/issues/2',
                    issueBodyExcerpt: '',
                },
                triggerNote: 'Issue assigned to the bound account',
                detectedAt: STAMP,
            }),
        };
        delete stored.headSha;
        delete stored.baseRef;

        const parsed = parseStoredEvent(stored);

        expect(parsed).not.toBeNull();
        expect(parsed?.headSha).toBeNull();
        expect(parsed?.baseRef).toBeNull();
        expect(parsed?.kind).toBe('assignment');
    });

    it('still refuses a row whose Slice-2 fields are not text', () => {
        const event = createEvent({
            bindingId: REVIEW_BINDING,
            repository: REPO_LABEL,
            accountNumericUserId: ACCOUNT_ID,
            accountLogin: ACCOUNT_LOGIN,
            projectId: PROJECT_ID,
            worktreeOption: 'none',
            kind: 'review',
            headSha: HEAD_SHA,
            baseRef: BASE_REF,
            issue: {
                issueNumber: 3,
                issueTitle: PULL_TITLE,
                issueUrl: PULL_URL,
                issueBodyExcerpt: '',
            },
            triggerNote: 'Pull request #3 requested the bound account\'s review',
            detectedAt: STAMP,
        });

        expect(parseStoredEvent({ ...event, headSha: 42 })).toBeNull();
        expect(parseStoredEvent({ ...event, baseRef: ['main'] })).toBeNull();
    });
});
