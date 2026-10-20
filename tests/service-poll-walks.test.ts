/**
 * The two bounded walks the wider detection adds, driven over the real runtime
 * and a fake `fetch`: the reviews backward walk (FR-121) and the check-runs
 * envelope walk (FR-126). The assertions are the request shapes and the
 * walk's own stop and truncation rules; no network, no clock.
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from '../service/log.ts';
import { createGitHubIssuePoller } from '../service/poll/poller-github.ts';
import type { GitHubIssuePoller, ListPace } from '../service/poll/poller-github.ts';

const OWNER = 'acme';
const NAME = 'widget';
const PULL_NUMBER = 7;
const HEAD_SHA = 'deadbeef';
const WINDOW_START = '2026-10-20T00:00:00.000Z';
const STAMP = '2026-10-20T00:05:00.000Z';

const log = createLogger({ level: 'error' });

/** Two items per page keeps every page shape small enough to read. */
const pace: ListPace = { perPage: 2, retry: { maxAttempts: 1, baseMs: 0, maxMs: 0 } };

interface Answer {
    readonly body: string;
    readonly link?: string;
}

/** Drive the real poller over a scripted page answer. */
function driver(answers: readonly Answer[]): {
    readonly poller: GitHubIssuePoller;
    readonly urls: readonly URL[];
} {
    const urls: URL[] = [];
    let index = 0;
    const poller = createGitHubIssuePoller({ log }, async (url) => {
        urls.push(new URL(url));
        const answer = answers[index] ?? { body: '[]' };
        index += 1;

        return new Response(answer.body, {
            status: 200,
            headers: answer.link === undefined ? {} : { link: answer.link },
        });
    });

    return { poller, urls };
}

/** One review body, with a caller-chosen id, state and stamp. */
function review(reviewId: number, state = 'CHANGES_REQUESTED', submittedAt: string | null = STAMP): string {
    return JSON.stringify({
        id: reviewId,
        state,
        submitted_at: submittedAt,
        user: { login: 'alice', type: 'User' },
    });
}

/** One check-run body. */
function checkRun(
    name: string,
    conclusion: string | null,
): { readonly name: string; readonly conclusion: string | null } {
    return { name, conclusion };
}

/** The `Link` header naming one last page. */
function lastLink(page: number): string {
    return `<https://api.github.com/repositories/1/pulls/7/reviews?per_page=2&page=${page}>; rel="last"`;
}

const reviewsQuery = {
    token: 'token',
    owner: OWNER,
    name: NAME,
    pullNumber: PULL_NUMBER,
    windowStart: WINDOW_START,
    pace,
};

const checksQuery = {
    token: 'token',
    owner: OWNER,
    name: NAME,
    headSha: HEAD_SHA,
    pace,
};

describe('the reviews backward walk (FR-121)', () => {
    it('reads the last page named by Link, then the page before it', async () => {
        {
            const { poller, urls } = driver([
                { body: `[${review(1)}]`, link: lastLink(2) },
                { body: `[${review(2)}, ${review(3)}]` },
                { body: `[${review(4)}]` },
            ]);

            const result = await poller.listPullReviews(reviewsQuery);

            expect(result).toEqual({
                kind: 'ok',
                reviews: expect.arrayContaining([
                    expect.objectContaining({ reviewId: 4 }),
                    expect.objectContaining({ reviewId: 2 }),
                    expect.objectContaining({ reviewId: 3 }),
                ]),
                truncated: false,
            });
            expect(urls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2', '1']);
            expect(urls.map((url) => url.searchParams.get('per_page'))).toEqual(['2', '2', '2']);
            expect(urls[0]?.pathname).toBe(`/repos/${OWNER}/${NAME}/pulls/${PULL_NUMBER}/reviews`);
        }
    });

    it('does not stop on an under-filled newest page that is entirely in the window', async () => {
        {
            const { poller, urls } = driver([
                { body: `[${review(1)}]`, link: lastLink(2) },
                { body: `[${review(2)}]` },
                { body: `[${review(3)}]` },
            ]);

            const result = await poller.listPullReviews(reviewsQuery);

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') {
                throw new Error('the walk failed');
            }

            expect(result.reviews.map((row) => row.reviewId)).toContain(3);
            expect(result.truncated).toBe(false);
            expect(urls).toHaveLength(3);
        }
    });

    it('stops on a page that straddles the window start and takes its in-window reviews', async () => {
        {
            const before = '2026-10-19T23:55:00.000Z';
            const { poller, urls } = driver([
                { body: `[${review(1)}]`, link: lastLink(2) },
                { body: `[${review(2, 'CHANGES_REQUESTED', before)}, ${review(3)}]` },
            ]);

            const result = await poller.listPullReviews(reviewsQuery);

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') {
                throw new Error('the walk failed');
            }

            expect(result.reviews.map((row) => row.reviewId)).toEqual([2, 3]);
            expect(result.truncated).toBe(false);
            expect(urls).toHaveLength(2);
        }
    });

    it('records truncation when two in-window content pages are not page 1', async () => {
        {
            const { poller, urls } = driver([
                { body: `[${review(1)}]`, link: lastLink(4) },
                { body: `[${review(2)}, ${review(3)}]` },
                { body: `[${review(4)}, ${review(5)}]` },
            ]);

            const result = await poller.listPullReviews(reviewsQuery);

            expect(result).toEqual({ kind: 'ok', reviews: [], truncated: true });
            expect(urls).toHaveLength(3);
        }
    });

    it('treats a full first page with no usable Link as truncation', async () => {
        {
            const full = driver([{ body: `[${review(1)}, ${review(2)}]` }]);
            expect(await full.poller.listPullReviews(reviewsQuery))
                .toEqual({ kind: 'ok', reviews: [], truncated: true });

            const partial = driver([{ body: `[${review(1)}]`, link: '<https://api.github.com/x>; rel="next"' }]);
            const result = await partial.poller.listPullReviews(reviewsQuery);

            expect(result).toEqual({
                kind: 'ok',
                reviews: [expect.objectContaining({ reviewId: 1 })],
                truncated: false,
            });
        }
    });

    it('delivers an in-window review on page 1 when that is the last page', async () => {
        {
            const { poller, urls } = driver([{ body: `[${review(1)}, ${review(2)}]`, link: lastLink(1) }]);

            const result = await poller.listPullReviews(reviewsQuery);

            expect(result).toEqual({
                kind: 'ok',
                reviews: expect.arrayContaining([
                    expect.objectContaining({ reviewId: 1 }),
                    expect.objectContaining({ reviewId: 2 }),
                ]),
                truncated: false,
            });
            expect(urls).toHaveLength(1);
        }
    });
});

describe('the check-runs walk (FR-126, FR-127)', () => {
    it('asks for filter=latest, pages the envelope, and aggregates one verdict with its names', async () => {
        {
            const { poller, urls } = driver([{
                body: JSON.stringify({
                    total_count: 3,
                    check_runs: [
                        checkRun('build', 'failure'),
                        checkRun('lint', 'timed_out'),
                        checkRun('docs', 'success'),
                    ],
                }),
            }, { body: JSON.stringify({ check_runs: [] }) }]);

            const result = await poller.listHeadChecks(checksQuery);

            expect(result).toEqual({
                kind: 'ok',
                conclusion: 'failure',
                names: ['build', 'lint'],
                truncated: false,
            });
            expect(urls[0]?.pathname).toBe(
                `/repos/${OWNER}/${NAME}/commits/${HEAD_SHA}/check-runs`,
            );
            expect(urls[0]?.searchParams.get('filter')).toBe('latest');
            expect(urls[0]?.searchParams.get('page')).toBe('1');
            expect(urls[0]?.searchParams.get('per_page')).toBe('2');
        }
    });

    it('keeps the fixed conclusion precedence over the returned order', async () => {
        {
            const { poller } = driver([{
                body: JSON.stringify({
                    check_runs: [checkRun('cancel', 'cancelled'), checkRun('gate', 'action_required')],
                }),
            }, { body: JSON.stringify({ check_runs: [] }) }]);

            const result = await poller.listHeadChecks(checksQuery);

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') {
                throw new Error('the walk failed');
            }

            expect(result.conclusion).toBe('action_required');
        }
    });

    it('reads a second page, and truncates when that page fills its cap', async () => {
        {
            const { poller, urls } = driver([
                { body: JSON.stringify({ check_runs: [checkRun('build', 'failure'), checkRun('lint', 'success')] }) },
                { body: JSON.stringify({ check_runs: [checkRun('docs', 'failure'), checkRun('test', 'failure')] }) },
            ]);

            const result = await poller.listHeadChecks(checksQuery);

            expect(result).toEqual({ kind: 'ok', conclusion: null, names: [], truncated: true });
            expect(urls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
        }
    });

    it('produces no verdict for an all-green head or an unreadable conclusion', async () => {
        {
            const { poller } = driver([{
                body: JSON.stringify({ check_runs: [checkRun('build', 'success'), checkRun('docs', 'skipped')] }),
            }, { body: JSON.stringify({ check_runs: [] }) }]);

            expect(await poller.listHeadChecks(checksQuery))
                .toEqual({ kind: 'ok', conclusion: null, names: [], truncated: false });
        }
    });
});
