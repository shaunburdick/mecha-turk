/**
 * Slice-2 trigger detection: M6 mentions (comments *and* issue bodies), M7
 * review requests, and the event-kind round-trip they added to the queue's
 * schema.
 *
 * Three classes of coverage, all driven through the real `runScanCycle`
 * (the same path production takes) plus the detector functions themselves:
 *
 * 1. mention — a human comment (or a human-authored issue body) carrying
 *    `@<login>` queues one event, matched case-insensitively and bounded so
 *    `@octocat-mt2` is not a mention of `@octocat-mt`; bot authors are
 *    skipped outright, two comments on one issue are two events (the comment
 *    id is in the event id), and an issue-body mention carries the fixed
 *    `~mention~body` suffix so it never collides with a comment mention or
 *    with the same issue's assignment;
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
import { readAuditEntries } from '../service/audit.ts';
import { writeAccount } from '../service/accounts/store.ts';
import { writeBindings } from '../service/bindings.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, parseStoredEvent, readEvents } from '../service/poll/events.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import { readRunsDocument } from '../service/poll/runs.ts';
import { writeScanState } from '../service/poll/scan.ts';
import { isAttributableAuthor } from '../service/poll/attribution.ts';
import {
    isIssueBodyMention,
    isMentionComment,
    isReviewRequestPull,
    mentionsLogin,
} from '../service/poll/triggers.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { BindingRecord, BindingTriggers } from '../service/bindings.ts';
import type { ActorAttribution, EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { GitHubIssuePoller, PollComment, PollIssue, PollPull } from '../service/poll/poller-github.ts';
import type { ServiceStore } from '../service/store/index.ts';
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

/** Title of the fixture issue the mention scans resolve against. */
const ISSUE_TITLE = 'Flux capacitor drifts';

/** URL of that fixture issue. */
const ISSUE_URL = 'https://github.com/acme/widget/issues/7';

/** Login the fixtures attribute their human-authored text to. */
const HUMAN_AUTHOR_LOGIN = 'alice';

/** Author type reported for that fixture author. */
const HUMAN_AUTHOR_TYPE = 'User';

/** Basis an assignment or review request is attributed under (002 FR-044). */
const PROXY_BASIS = 'subject-author';

/**
 * The bot identities the fixtures attribute their bot-authored text to.
 *
 * GitHub marks a bot two ways and both are refused, so both appear here: the
 * `[bot]` login suffix an App account carries, and an ordinary-looking login
 * reported as `type: 'Bot'`.
 */
const BOT_AUTHOR_LOGIN = 'dependabot[bot]';
const TYPED_BOT_LOGIN = 'warehouse-runner';
const BOT_AUTHOR_TYPE = 'Bot';

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

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
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
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

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
        displayName: null,
        startingPrompt: null,
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
 * @param overrides - Fields to change from the default fixture issue.
 * @returns The normalized issue.
 */
function fixtureIssue(overrides: Partial<PollIssue> = {}): PollIssue {
    return {
        issueNumber: 7,
        title: ISSUE_TITLE,
        url: ISSUE_URL,
        state: 'open',
        body: null,
        authorLogin: HUMAN_AUTHOR_LOGIN,
        authorType: HUMAN_AUTHOR_TYPE,
        assignees: [],
        isPullRequest: false,
        updatedAt: STAMP,
        ...overrides,
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
        authorLogin: input.authorLogin ?? HUMAN_AUTHOR_LOGIN,
        authorType: input.authorType ?? HUMAN_AUTHOR_TYPE,
        updatedAt: STAMP,
    };
}

/**
 * Build one open pull request.
 *
 * @param input - PR number, the reviewers GitHub reports, and the author it names.
 * @returns The normalized pull request.
 */
function fixturePull(input: {
    readonly pullNumber: number;
    readonly requestedReviewers: readonly string[];
    readonly authorLogin?: string;
    readonly authorType?: string;
}): PollPull {
    return {
        pullNumber: input.pullNumber,
        title: `Change ${input.pullNumber}`,
        url: `https://github.com/acme/widget/pull/${input.pullNumber}`,
        state: 'open',
        requestedReviewers: input.requestedReviewers,
        // The pulls list names no requester, so the author is the only identity
        // the review trigger can attribute to (002 FR-045, research §R8).
        authorLogin: input.authorLogin ?? HUMAN_AUTHOR_LOGIN,
        authorType: input.authorType ?? HUMAN_AUTHOR_TYPE,
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
    it('queues one event per human comment that mentions the… (+2 cases)', async () => {
        // case: queues one event per human comment that mentions the account, keyed by comment id
        {
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
                issueTitle: ISSUE_TITLE,
                issueUrl: ISSUE_URL,
                accountLogin: ACCOUNT_LOGIN,
                subjectType: 'issue',
                headSha: null,
                baseRef: null,
            });
            // The trigger note names the commenter, not just the account.
            expect(events[0]?.triggerNote).toContain(HUMAN_AUTHOR_LOGIN);
            expect(events[0]?.issueBodyExcerpt).toBe('cc @OCTOCAT-MT — drift again');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: skips bot authors, lookalike handles, and bodies that never mention the account
        {
            const recorded = recordingPoller({
                issues: [fixtureIssue()],
                comments: [
                    // A `[bot]` login that mentions the account.
                    fixtureComment({
                        commentId: 601,
                        body: '@octocat-mt updated the lockfile',
                        authorLogin: BOT_AUTHOR_LOGIN,
                    }),
                    // A `type: Bot` author with an ordinary-looking login.
                    fixtureComment({
                        commentId: 602,
                        body: '@octocat-mt build failed',
                        authorLogin: TYPED_BOT_LOGIN,
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
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: never lists comments when the mention switch is off
        {
            const recorded = recordingPoller({ issues: [], comments: [] });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: true, mention: false, reviewRequest: false }),
                recorded,
            );

            expect(recorded.calls).toEqual(['issues']);
            expect(events).toEqual([]);
        }
    });
});

describe('issue-body mention detection (M6, operator product decision 2026-09-28)', () => {
    it('queues one mention event with the fixed ~mention~bod… (+5 cases)', async () => {
        // case: queues one mention event with the fixed ~mention~body id and a bounded excerpt
        {
            const filler = 'lorem ipsum '.repeat(80);
            const body = `Hey ${MENTION_TOKEN.toUpperCase()} — the flux capacitor drifts.\n${filler}`;
            const recorded = recordingPoller({ issues: [fixtureIssue({ body })] });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
                recorded,
            );

            // The body path rides the issue list; only the comment feed is extra.
            expect(recorded.calls).toEqual(['issues', 'comments']);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                kind: 'mention',
                id: `evt-acme~widget~7~${ACCOUNT_ID}~mention~body`,
                issueNumber: 7,
                issueTitle: ISSUE_TITLE,
                issueUrl: ISSUE_URL,
                actorLogin: HUMAN_AUTHOR_LOGIN,
                actorAttribution: 'direct',
                triggerNote: 'mentioned in issue body',
                subjectType: 'issue',
                headSha: null,
                baseRef: null,
            });
            // The untrusted body is bounded exactly like a comment excerpt (600).
            expect(events[0]?.issueBodyExcerpt).toHaveLength(600);
            expect(events[0]?.issueBodyExcerpt.endsWith('…')).toBe(true);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: queues nothing for lookalikes, bots, unreadable authors, or an empty body
        {
            const recorded = recordingPoller({
                issues: [
                    // The account's handle as a prefix of a longer handle.
                    fixtureIssue({ issueNumber: 11, body: 'ask @octocat-mt2 instead' }),
                    // The handle glued to a preceding character is not a mention.
                    fixtureIssue({ issueNumber: 12, body: 'mail octocat-mt@acme.dev' }),
                    // A `[bot]` author that mentions the account.
                    fixtureIssue({
                        issueNumber: 13,
                        body: '@octocat-mt updated the lockfile',
                        authorLogin: BOT_AUTHOR_LOGIN,
                    }),
                    // A `type: Bot` author with an ordinary-looking login.
                    fixtureIssue({
                        issueNumber: 14,
                        body: '@octocat-mt build failed',
                        authorLogin: TYPED_BOT_LOGIN,
                        authorType: 'Bot',
                    }),
                    // No readable author: fail closed, never dispatch.
                    fixtureIssue({ issueNumber: 15, body: MENTION_TOKEN, authorLogin: '' }),
                    // No body at all.
                    fixtureIssue({ issueNumber: 16, body: null }),
                ],
            });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
                recorded,
            );

            expect(events).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: never reads an issue body when the mention switch is off
        {
            const recorded = recordingPoller({ issues: [fixtureIssue({ body: `please look ${MENTION_TOKEN}` })] });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: true, mention: false, reviewRequest: false }),
                recorded,
            );

            // The issues feed is still listed — for the assignment trigger.
            expect(recorded.calls).toEqual(['issues']);
            expect(events).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: keeps an assignment and a body mention on one issue as two distinct, deduplicable events
        {
            const recorded = recordingPoller({
                issues: [fixtureIssue({ body: `Hey ${MENTION_TOKEN}, please triage`, assignees: [ACCOUNT_LOGIN] })],
            });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: true, mention: true, reviewRequest: false }),
                recorded,
            );

            // Two observations, two ids: the assignment id never gained a suffix.
            expect(events.map((event) => event.kind)).toEqual(['assignment', 'mention']);
            expect(events.map((event) => event.id)).toEqual([
                `evt-acme~widget~7~${ACCOUNT_ID}`,
                `evt-acme~widget~7~${ACCOUNT_ID}~mention~body`,
            ]);

            // A replay (window cleared, as a first scan or recovery reset does)
            // re-detects both observations and dedupes them to the same two rows.
            await writeScanState({ store, state: { bindings: {} } });
            const replayed = await runScanCycle({ store, log, poller: recorded.poller });

            expect(replayed.enqueued).toBe(0);
            expect(await readEvents({ store, log })).toHaveLength(2);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: coalesces a pull-request assignment and review request under the PR subject
        {
            const pullRequest = fixtureIssue({
                issueNumber: 31,
                title: 'Change 31',
                url: 'https://github.com/acme/widget/pull/31',
                isPullRequest: true,
                assignees: [ACCOUNT_LOGIN],
            });
            const recorded = recordingPoller({
                issues: [pullRequest],
                pulls: [{ ...fixturePull({ pullNumber: 31, requestedReviewers: [
                    ACCOUNT_LOGIN] }), title: 'Change 31' }],
            });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: true, mention: false, reviewRequest: true }),
                recorded,
            );

            expect(events.map((event) => event.kind)).toEqual(['assignment', 'review']);
            expect(events.map((event) => event.subjectType)).toEqual(['pull_request', 'pull_request']);
            expect(events.map((event) => event.runCorrelationId)).toEqual([
                events[0]?.runCorrelationId,
                events[0]?.runCorrelationId,
            ]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: keeps a comment mention and a body mention on one issue as two distinct events
        {
            const recorded = recordingPoller({
                issues: [fixtureIssue({ body: `details in the body, ${MENTION_TOKEN}` })],
                comments: [fixtureComment({ commentId: FIRST_COMMENT_ID, body: `cc ${MENTION_TOKEN} — see above` })],
            });

            const events = await scan(
                fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
                recorded,
            );

            expect(events.map((event) => event.id)).toEqual([
                `evt-acme~widget~7~${ACCOUNT_ID}~mention~body`,
                `evt-acme~widget~7~${ACCOUNT_ID}~mention~${FIRST_COMMENT_ID}`,
            ]);
            // The comment mention keeps its own note and its own excerpt.
            expect(events[1]?.triggerNote).toContain(HUMAN_AUTHOR_LOGIN);
            expect(events[1]?.issueBodyExcerpt).toBe(`cc ${MENTION_TOKEN} — see above`);
        }
    });

    it('ignores an issue body the scan window has already passed', async () => {
        // The first cycle stamps the window at "now", which every fixture
        // timestamp (2026-09-27) is older than — the same window the
        // assignment trigger obeys, so an edited body only re-detects when
        // GitHub reports the edit after that stamp.
        await scan(
            fixtureBinding(MENTION_BINDING, { assignment: false, mention: true, reviewRequest: false }),
            recordingPoller({ issues: [fixtureIssue({ body: 'quiet for now' })] }),
        );

        const recorded = recordingPoller({ issues: [fixtureIssue({ body: `now it says ${MENTION_TOKEN}` })] });
        const cycle = await runScanCycle({ store, log, poller: recorded.poller });

        expect(cycle.enqueued).toBe(0);
        expect(await readEvents({ store, log })).toEqual([]);
    });
});

describe('mention and review detectors (unit)', () => {
    it('matches the token case-insensitively and bounded on … (+3 cases)', async () => {
        // case: matches the token case-insensitively and bounded on both sides
        {
            expect(mentionsLogin(`hey ${MENTION_TOKEN.toUpperCase()}`, ACCOUNT_LOGIN)).toBe(true);
            expect(mentionsLogin(`(${MENTION_TOKEN})`, ACCOUNT_LOGIN)).toBe(true);
            expect(mentionsLogin('no handle here', ACCOUNT_LOGIN)).toBe(false);
            expect(mentionsLogin('two words: @ octocat-mt', ACCOUNT_LOGIN)).toBe(false);
            expect(mentionsLogin('@octocat-mt2', ACCOUNT_LOGIN)).toBe(false);
            expect(mentionsLogin('x@octocat-mt', ACCOUNT_LOGIN)).toBe(false);
            expect(mentionsLogin(MENTION_TOKEN, '')).toBe(false);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reads a bot comment as a bot whatever the author field says
        {
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
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reads an issue-body mention the same way — author first, bounded token second
        {
            expect(isIssueBodyMention(fixtureIssue({ body: `hey ${MENTION_TOKEN}` }), ACCOUNT_LOGIN)).toBe(true);
            expect(isIssueBodyMention(fixtureIssue({ body: 'no handle here' }), ACCOUNT_LOGIN)).toBe(false);
            expect(isIssueBodyMention(fixtureIssue({ body: '@octocat-mt2' }), ACCOUNT_LOGIN)).toBe(false);
            expect(isIssueBodyMention(fixtureIssue({ body: MENTION_TOKEN, authorLogin: 'ci-bot[bot]' }), ACCOUNT_LOGIN))
                .toBe(false);
            expect(isIssueBodyMention(fixtureIssue({
                body: MENTION_TOKEN, authorType: 'Bot' }), ACCOUNT_LOGIN)).toBe(false);
            expect(isIssueBodyMention(fixtureIssue({ body: MENTION_TOKEN, authorLogin: '' }), ACCOUNT_LOGIN)).toBe(
                false
            );
            expect(isIssueBodyMention(fixtureIssue({ body: null }), ACCOUNT_LOGIN)).toBe(false);
            expect(isIssueBodyMention(fixtureIssue({ body: MENTION_TOKEN }), '')).toBe(false);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: matches a requested reviewer case-insensitively, and nobody else
        {
            expect(isReviewRequestPull(fixturePull({ pullNumber: 1, requestedReviewers: [
                'OCTOCAT-MT'] }), ACCOUNT_LOGIN))
                .toBe(true);
            expect(isReviewRequestPull(fixturePull({ pullNumber: 2, requestedReviewers: [
                'someone-else'] }), ACCOUNT_LOGIN))
                .toBe(false);
            expect(isReviewRequestPull(fixturePull({ pullNumber: 3, requestedReviewers: [
            ] }), ACCOUNT_LOGIN)).toBe(false);
        }
    });
});

describe('review-request detection (M7)', () => {
    it('queues a review event with the PR head and base capt… (+1 cases)', async () => {
        // case: queues a review event with the PR head and base captured, and lists no issues
        {
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
                subjectType: 'pull_request',
            });
            // The id carries the PR number, the account, and the kind.
            expect(events[0]?.id).toBe(`evt-acme~widget~3~${ACCOUNT_ID}~review`);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: queues nothing for a pull request that does not ask this account
        {
            const recorded = recordingPoller({
                pulls: [fixturePull({ pullNumber: 9, requestedReviewers: ['someone-else'] })],
            });

            const events = await scan(
                fixtureBinding(REVIEW_BINDING, { assignment: false, mention: false, reviewRequest: true }),
                recorded,
            );

            expect(events).toEqual([]);
        }
    });
});

describe('event kind round-trip (nullable Slice-2 fields)', () => {
    it('round-trips a review event with headSha and baseRef … (+2 cases)', async () => {
        // case: round-trips a review event with headSha and baseRef intact
        {
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
                actorLogin: HUMAN_AUTHOR_LOGIN,
                actorAttribution: PROXY_BASIS,
                triggerNote: 'Pull request #3 requested the bound account\'s review',
                detectedAt: STAMP,
            };
            const event = createEvent(snapshot);

            expect(parseStoredEvent(JSON.parse(JSON.stringify(event)) as unknown)).toEqual(event);
            expect(event.headSha).toBe(HEAD_SHA);
            expect(event.baseRef).toBe(BASE_REF);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reads a row written before M7 — no headSha/baseRef at all — as null
        {
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
                    actorLogin: HUMAN_AUTHOR_LOGIN,
                    actorAttribution: PROXY_BASIS,
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
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: still refuses a row whose Slice-2 fields are not text
        {
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
                actorLogin: HUMAN_AUTHOR_LOGIN,
                actorAttribution: PROXY_BASIS,
                triggerNote: 'Pull request #3 requested the bound account\'s review',
                detectedAt: STAMP,
            });

            expect(parseStoredEvent({ ...event, headSha: 42 })).toBeNull();
            expect(parseStoredEvent({ ...event, baseRef: ['main'] })).toBeNull();
        }
    });
});

/** Login an assignment fixture's issue is authored by, distinct from any reviewer. */
const ISSUE_AUTHOR_LOGIN = 'issue-author-login';

/** Login a review fixture's pull request is authored by, distinct from the assignee. */
const PULL_AUTHOR_LOGIN = 'pull-author-login';

/** Audit row prefixes that would mean work was started; none may appear. */
const WORK_EVENT_TYPES = ['dispatch.', 'run.'] as const;

/** The binding every kind in this block binds, with all three switches on. */
const ALL_KINDS = { assignment: true, mention: true, reviewRequest: true } as const;

/**
 * Run one scan and answer everything a caller needs to judge what it produced.
 *
 * "No event, no run, and no work" is three claims about three different
 * stores, so the helper reads all three rather than making each case repeat the
 * plumbing: the queue's events, the run document's runs, and the audit trail.
 *
 * @param binding - The binding to scan.
 * @param recorded - The poller feeding that scan.
 * @returns The events, the runs, and the audit rows the scan wrote.
 */
async function scanAndRead(
    binding: BindingRecord,
    recorded: RecordedPoller,
): Promise<{
    readonly events: readonly QueuedEvent[];
    readonly runs: readonly Run[];
    readonly audit: readonly AuditEntry[];
}> {
    const events = await scan(binding, recorded);
    const document = await readRunsDocument({ store, log });
    const audit = await readAuditEntries(store);

    return { events, runs: document.runs, audit };
}

/** Every trigger note the four kinds produced, in one string for a string scan. */
function notesOf(events: readonly QueuedEvent[]): string {
    return events.map((event) => event.triggerNote).join('\n');
}

describe('002 FR-043–FR-045 attribution at detection (AC-024, AC-025, A-5, A-6)', () => {
    it('attributes all four kinds, with the basis each one can honestly carry', async () => {
        const recorded = recordingPoller({
            issues: [
                fixtureIssue({
                    issueNumber: 7,
                    authorLogin: ISSUE_AUTHOR_LOGIN,
                    assignees: [ACCOUNT_LOGIN],
                    body: `hey ${MENTION_TOKEN}, the drift is back`,
                }),
            ],
            comments: [
                fixtureComment({
                    commentId: FIRST_COMMENT_ID,
                    body: `cc ${MENTION_TOKEN} — confirmed`,
                    authorLogin: HUMAN_AUTHOR_LOGIN,
                }),
            ],
            pulls: [
                fixturePull({
                    pullNumber: 3,
                    requestedReviewers: [ACCOUNT_LOGIN],
                    authorLogin: PULL_AUTHOR_LOGIN,
                }),
            ],
        });

        const { events, runs } = await scanAndRead(fixtureBinding(MENTION_BINDING, ALL_KINDS), recorded);

        // All four kinds, one event each, through the real loop and the real queue.
        expect(events.map((event) => event.kind).sort()).toEqual(['assignment', 'mention', 'mention', 'review']);
        const comment = events.find((event) => event.id.endsWith(`~mention~${FIRST_COMMENT_ID}`));
        const body = events.find((event) => event.id.endsWith('~mention~body'));
        const assignment = events.find((event) => event.kind === 'assignment');
        const review = events.find((event) => event.kind === 'review');

        // The two mention kinds read `direct`: GitHub named the author of the
        // very text that carried the token (002 FR-044).
        expect(comment).toMatchObject({ actorLogin: HUMAN_AUTHOR_LOGIN, actorAttribution: 'direct' });
        expect(body).toMatchObject({ actorLogin: ISSUE_AUTHOR_LOGIN, actorAttribution: 'direct' });

        // The two proxy kinds read `subject-author`, because the list feeds name
        // no actor at all: the assignment's actor is the **issue** author and the
        // review's is the **pull-request** author (002 AC-024).
        expect(assignment).toMatchObject({ actorLogin: ISSUE_AUTHOR_LOGIN, actorAttribution: PROXY_BASIS });
        expect(review).toMatchObject({ actorLogin: PULL_AUTHOR_LOGIN, actorAttribution: PROXY_BASIS });

        // And the attribution reached the run layer, so the trail can say who
        // and on what basis rather than only the queue.
        expect(runs.length).toBeGreaterThan(0);
        expect(events.map((event) => event.runCorrelationId).filter(Boolean)).toHaveLength(events.length);
    });

    it('exposes one attributability predicate, and it refuses bots and nobody (FR-045, plan D3)', () => {
        // The judgement is now a **public** surface because two modules need it:
        // the mention and review detectors here, and the assignment path in
        // `loop.ts`. One name, one rule, four trigger kinds.
        expect(isAttributableAuthor(HUMAN_AUTHOR_LOGIN, HUMAN_AUTHOR_TYPE)).toBe(true);
        // A `[bot]` login and a `type: Bot` author are both refused, by either
        // signal alone — GitHub marks its own accounts both ways.
        expect(isAttributableAuthor(BOT_AUTHOR_LOGIN, HUMAN_AUTHOR_TYPE)).toBe(false);
        expect(isAttributableAuthor(TYPED_BOT_LOGIN, BOT_AUTHOR_TYPE)).toBe(false);
        // An author GitHub would not name is nobody, so it is not attributable.
        expect(isAttributableAuthor('', '')).toBe(false);
        expect(isAttributableAuthor('', HUMAN_AUTHOR_TYPE)).toBe(false);
    });

    it('keeps every delivery id byte-identical whatever the actor (FR-046)', () => {
        // The id is the dedupe key, the relay path segment, and the reference
        // already recorded in panel ledgers, audit rows, and the run history —
        // so the actor rides the row and never its identity (002 FR-046).
        const id = (input: {
            readonly actor: string;
            readonly basis: ActorAttribution;
            readonly kind: EventSnapshot['kind'];
        }): string => {
            const { actor, basis, kind } = input;
            const shared = {
                bindingId: MENTION_BINDING,
                repository: REPO_LABEL,
                accountNumericUserId: ACCOUNT_ID,
                accountLogin: ACCOUNT_LOGIN,
                projectId: PROJECT_ID,
                worktreeOption: 'none',
                issue: {
                    issueNumber: 12,
                    issueTitle: 'Ticket #12',
                    issueUrl: ISSUE_URL,
                    issueBodyExcerpt: '',
                },
                triggerNote: `${kind} fixture`,
                detectedAt: STAMP,
            };
            const attributed = { ...shared, actorLogin: actor, actorAttribution: basis };

            if (kind === 'review') {
                return createEvent({ ...attributed, kind, headSha: HEAD_SHA, baseRef: BASE_REF }).id;
            }

            if (kind === 'mention') {
                return createEvent({ ...attributed, kind, origin: 'comment', commentId: 4242 }).id;
            }

            return createEvent({ ...attributed, kind }).id;
        };

        for (const kind of ['assignment', 'mention', 'review'] as const) {
            const ids = new Set([
                id({ actor: 'alice', basis: PROXY_BASIS, kind }),
                id({ actor: 'bob', basis: PROXY_BASIS, kind }),
                id({ actor: 'carol', basis: 'direct', kind }),
            ]);
            expect(ids.size, `${kind} ids must not vary with the actor`).toBe(1);
        }

        const at = (kind: EventSnapshot['kind']): string => id({ actor: 'alice', basis: PROXY_BASIS, kind });
        expect(at('assignment')).toBe(`evt-acme~widget~12~${ACCOUNT_ID}`);
        expect(at('mention')).toBe(`evt-acme~widget~12~${ACCOUNT_ID}~mention~4242`);
        expect(at('review')).toBe(`evt-acme~widget~12~${ACCOUNT_ID}~review`);
    });

    it('creates no event, no run, and no work for a bot or an authorless subject (AC-025)', async () => {
        const unreadable = { authorLogin: '', authorType: '' };
        const recorded = recordingPoller({
            // An assignment on a bot-authored issue and one GitHub named no
            // author for, each assigned to the bound account.
            issues: [
                fixtureIssue({ issueNumber: 7, authorLogin: BOT_AUTHOR_LOGIN, assignees: [ACCOUNT_LOGIN] }),
                fixtureIssue({ issueNumber: 8, ...unreadable, assignees: [ACCOUNT_LOGIN] }),
                // A bot-authored issue body and a bot-authored comment, both mentioning.
                fixtureIssue({ issueNumber: 9, authorLogin: BOT_AUTHOR_LOGIN, body: `hey ${MENTION_TOKEN}` }),
                fixtureIssue({ issueNumber: 10, ...unreadable, body: `hey ${MENTION_TOKEN}` }),
                fixtureIssue({
                    issueNumber: 11,
                    authorLogin: TYPED_BOT_LOGIN,
                    authorType: BOT_AUTHOR_TYPE,
                    body: `hey ${MENTION_TOKEN}`,
                }),
            ],
            comments: [
                fixtureComment({ commentId: 601, body: `@${ACCOUNT_LOGIN} updated`, authorLogin: BOT_AUTHOR_LOGIN }),
                fixtureComment({ commentId: 602, body: `@${ACCOUNT_LOGIN} updated`, authorType: BOT_AUTHOR_TYPE }),
            ],
            // A review request on a bot-authored pull and one with no author.
            pulls: [
                fixturePull({ pullNumber: 3, requestedReviewers: [ACCOUNT_LOGIN], authorLogin: BOT_AUTHOR_LOGIN }),
                fixturePull({ pullNumber: 4, requestedReviewers: [ACCOUNT_LOGIN], ...unreadable }),
            ],
        });

        const { events, runs, audit } = await scanAndRead(fixtureBinding(MENTION_BINDING, ALL_KINDS), recorded);

        // Nothing was observed as actionable, so there is nothing to work on:
        // no queue row, no run, and no audit row claiming work happened.
        expect(events).toEqual([]);
        expect(runs).toEqual([]);
        const work = audit.filter((row) => WORK_EVENT_TYPES.some((prefix) => row.eventType.startsWith(prefix)));
        expect(work).toEqual([]);
    });

    it('admits no bot event however the binding is configured, and states no causation (AC-025, NFR-011)', async () => {
        const recorded = recordingPoller({
            issues: [
                // The one real human assignment, and a bot-authored duplicate of it.
                fixtureIssue({ issueNumber: 7, authorLogin: ISSUE_AUTHOR_LOGIN, assignees: [ACCOUNT_LOGIN] }),
                fixtureIssue({ issueNumber: 8, authorLogin: BOT_AUTHOR_LOGIN, assignees: [ACCOUNT_LOGIN] }),
            ],
            pulls: [fixturePull({ pullNumber: 3, requestedReviewers: [ACCOUNT_LOGIN], authorLogin: BOT_AUTHOR_LOGIN })],
        });

        // A binding that names a `[bot]` login: accepted into the list and inert
        // (plan D7). It cannot cause a bot event because no bot event is created.
        const binding: BindingRecord = {
            ...fixtureBinding(MENTION_BINDING, ALL_KINDS),
            allowedUsers: [BOT_AUTHOR_LOGIN, ISSUE_AUTHOR_LOGIN],
        };

        const { events, runs } = await scanAndRead(binding, recorded);

        expect(events).toHaveLength(1);
        expect(events[0]?.actorLogin).toBe(ISSUE_AUTHOR_LOGIN);
        expect(runs).toHaveLength(1);

        // No note, row, or audit string claims an actor assigned or requested
        // anything (002 NFR-011): the notes name the *subject* GitHub records,
        // and none of them names the attributed actor as the one who acted.
        const notes = notesOf(events);
        expect(notes).not.toContain(BOT_AUTHOR_LOGIN);
        expect(notes).not.toContain(ISSUE_AUTHOR_LOGIN);
        for (const claim of ['assigned by', 'requested by', 'asked by']) {
            expect(notes.toLowerCase()).not.toContain(claim);
        }
        // The attribution is a *proxy* on the row, and the row says so.
        expect(events[0]?.actorAttribution).toBe(PROXY_BASIS);
    });
});
