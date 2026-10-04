/**
 * The poller's shared transport: one request, classified (002 FR-007, FR-020,
 * FR-022; 006 FR-058, FR-059).
 *
 * Split out of `poller-github.ts` so that module can stay a **catalogue of
 * endpoints** while this one owns *how a request is made and what a failure
 * means*. Both halves are needed by every feed the scan lists — the issues list,
 * the comments list, the pulls list, and the per-item events read 002 v1.12.0
 * added — and each of them was about to become a second copy of the same request
 * path, the same retry ladder, and the same failure vocabulary.
 *
 * Four properties are load-bearing, and each is a decision rather than a default:
 *
 * - **Transport rules are imported, never restated.** The API origin, headers,
 *   and the shared 15-second abort come from `../github.ts` — the same module the
 *   credential verifier uses — so the two clients cannot drift apart on a header
 *   or a timeout (002 FR-007).
 * - **Upstream text never leaves this module.** A failure is one of four shapes:
 *   `auth-failed`, `rate-limited`, `unavailable`. An upstream body or message is
 *   never carried into one, so nothing that GitHub said can reach a log line, an
 *   audit row, or the panel (SEC-11; 002 NFR-004).
 * - **`auth-failed` stops immediately** and every other class is retried up to
 *   the configured `maxAttempts` **including the first** (006 FR-058). A
 *   credential GitHub refuses is a stop condition, not a transient error
 *   (constitution II); a rate limit honours `retry-after`, and each wait is
 *   reported **before** it starts so an operator can see the delay begin.
 * - **Page 2 is asked for only when page 1 filled its cap**, so a scan cannot
 *   burst its budget (002 FR-020), and a page whose parse fails reports the same
 *   class as a page that could not be fetched — an unreadable body is not a
 *   different kind of problem from an unreachable one.
 */

import { parseJsonText } from '../json.ts';
import {
    API_ORIGIN,
    GITHUB_TIMEOUT_MS,
    isRateLimited,
    requestHeaders,
    retryAfterOf,
    transportDetail,
} from '../github.ts';
import type { FetchLike, UnavailableDetail } from '../github.ts';
import type { ServiceLogger } from '../log.ts';
import { waitForRetry } from './backoff.ts';
import type { RandomFn, RetryPolicy, SleepFn } from './backoff.ts';

/** Shared status constant (the verifier keeps the catalog in `github.ts`). */
const STATUS_UNAUTHORIZED = 401;
/** Shared status constant. */
const STATUS_NOT_FOUND = 404;
/** Shared status constant. */
const STATUS_FORBIDDEN = 403;
/** Shared status constant: primary and secondary GitHub rate limits. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** Pages read per list call; a full first page justifies one more. */
export const MAX_LIST_PAGES = 2;

/**
 * Page size and retry ladder one call runs under.
 *
 * Both values are read from the stored configuration **once per cycle** and
 * carried on every query, which is what makes `perPage` and the three retry
 * knobs `next-cycle` rather than live.
 */
export interface ListPace {
    /** `per_page` this call asks for — the validated `perPage`, never above 30. */
    readonly perPage: number;
    /** The poll-*request* ladder this call may run; never a run retry. */
    readonly retry: RetryPolicy;
}

/**
 * Failure classes a call can answer with.
 *
 * Shared by every outcome the poller produces, so the loop's skip mapping reads
 * one shape: the class escapes, upstream detail never does.
 */
export type PollFailure =
    | { readonly kind: 'auth-failed' }
    | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
    | { readonly kind: 'unavailable'; readonly detail: UnavailableDetail };

/**
 * What a paged read answers with before the public method renames its
 * payload: the normalized items, or the classified failure.
 */
export type PagedList<T> = PollFailure | { readonly kind: 'ok'; readonly items: readonly T[] };

/**
 * The poller's own injectables: where waits are reported, slept, and
 * jittered. Production gets the shared logger, `setTimeout`, and `Math.random`;
 * a test passes a capturing sink and never sleeps at all.
 */
export interface PollerDeps {
    /** Structured logger; every wait is reported through it. */
    readonly log: ServiceLogger;
    /** Injected sleep; production waits, tests record instead. */
    readonly sleep?: SleepFn;
    /** Injected jitter source; tests make every recorded delay deterministic. */
    readonly random?: RandomFn;
}

/** Everything one call is bound to: transport plus the poller's injectables. */
export interface PollerRuntime {
    /** Injectable `fetch`. */
    readonly fetchImpl: FetchLike;
    /** Logger every wait is reported through. */
    readonly log: ServiceLogger;
    /** Injected sleep; the production default waits on a real timer. */
    readonly sleep: SleepFn;
    /** Injected jitter source; the production default is `Math.random`. */
    readonly random: RandomFn;
}

/**
 * The production sleep: a real timer, awaited.
 *
 * Tests pass a recorder instead, so a ladder of waits costs them no time
 * at all (SC-116's "injected clock, no real sleeps").
 *
 * @param milliseconds - How long to wait.
 * @returns A promise that settles after the delay.
 */
const systemSleep: SleepFn = async (milliseconds) => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
};

/**
 * Build the runtime a poller binds its calls to.
 *
 * @param deps - Logger, plus the optional injected `sleep` and `random`.
 * @param fetchImpl - Injectable `fetch`; defaults to the process global.
 * @returns The runtime every call on this poller runs under.
 */
export function pollerRuntime(deps: PollerDeps, fetchImpl: FetchLike): PollerRuntime {
    return {
        fetchImpl,
        log: deps.log,
        sleep: deps.sleep ?? systemSleep,
        random: deps.random ?? (() => Math.random()),
    };
}

/**
 * Build the repository URL one list method pages through.
 *
 * The query parameters a method always sends are set here, and a method that
 * takes a `since` window passes it; a method with no window passes `null` and no
 * such parameter is ever added. The per-item events read does **not** use this
 * helper at all, because it takes no `since` and must not be able to (002
 * FR-051).
 *
 * @param input - Repository coordinates, the path after the repo, the query
 *   parameters the method always sends, and its optional `since` window.
 * @returns The request URL with those query parameters set.
 */
export function listUrl(input: {
    /** Repository owner. */
    readonly owner: string;
    /** Repository name. */
    readonly name: string;
    /** Path after the repository segment. */
    readonly path: string;
    /** Query parameters the method always sends. */
    readonly query: Readonly<Record<string, string>>;
    /** Window start, or `null` when this method takes no window. */
    readonly since: string | null;
}): URL {
    const url = new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/${input.path}`);
    for (const [key, value] of Object.entries(input.query)) {
        url.searchParams.set(key, value);
    }

    if (input.since !== null) {
        url.searchParams.set('since', input.since);
    }

    return url;
}

/**
 * Parse one list page body, skipping entries the shape check refuses.
 *
 * @param input - The body text, the error text when it is not an array
 *   (never upstream text), and the per-entry reader (`null` drops one
 *   malformed entry).
 * @returns The normalized entries.
 * @throws {Error} When the body is not a JSON array.
 */
function parseListPage<T>(input: {
    /** The body text as the response carried it. */
    readonly text: string;
    /** Error text when the body is not an array (never upstream text). */
    readonly message: string;
    /** Per-entry reader; `null` drops one malformed entry. */
    readonly read: (value: unknown) => T | null;
}): T[] {
    const parsed = parseJsonText(input.text);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
        throw new Error(input.message);
    }

    return parsed.value.flatMap((entry) => {
        const item = input.read(entry);
        return item === null ? [] : [item];
    });
}

/**
 * Classify a non-200 answer.
 *
 * @param response - Upstream response.
 * @returns The classified failure.
 */
async function classifyOutcome(response: Response): Promise<PollFailure> {
    if (response.status === STATUS_UNAUTHORIZED || response.status === STATUS_NOT_FOUND) {
        return { kind: 'auth-failed' };
    }

    const rateLimitStatuses = [STATUS_FORBIDDEN, STATUS_TOO_MANY_REQUESTS];
    if (rateLimitStatuses.includes(response.status) && isRateLimited(response)) {
        return { kind: 'rate-limited', retryAfterSeconds: retryAfterOf(response) };
    }

    return { kind: 'unavailable', detail: 'upstream' };
}

/** One page attempt: a usable response, or the classified failure. */
type PageAttempt = { readonly response: Response } | { readonly failure: PollFailure };

/** The request context a wait is performed inside. */
interface WaitContext {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Request URL; only its path reaches the log line. */
    readonly url: URL;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
}

/**
 * Sleep the ladder's next wait, reporting it first.
 *
 * The report happens before the sleep so an operator can see the delay start,
 * and it carries the path, the attempt, the length, and the source — never a
 * header value and never a credential (FR-058's log requirement; 002 FR-007).
 *
 * @param context - The request context the wait belongs to.
 * @param wait - The attempt the wait precedes (the first is never waited for)
 *   and the rate-limit guidance in seconds, or `null`.
 */
async function waitBeforeNextAttempt(
    context: WaitContext,
    wait: { readonly attempt: number; readonly guidanceSeconds: number | null },
): Promise<void> {
    const { runtime, pace, url } = context;
    await waitForRetry({
        policy: pace.retry,
        attempt: wait.attempt,
        guidanceSeconds: wait.guidanceSeconds,
        sleep: runtime.sleep,
        random: runtime.random,
        onWait: (record) => {
            runtime.log.info('poll request waiting before its next attempt', {
                path: url.pathname,
                attempt: record.attempt,
                delayMs: record.delayMs,
                source: record.source,
            });
        },
    });
}

/**
 * Issue one page request, retrying under the configured ladder.
 *
 * `auth-failed` returns immediately — a credential GitHub refuses is a stop
 * condition, not a transient error (constitution II) — and every other class
 * may be attempted up to `retryMaxAttempts` times **including the first**.
 * Each wait is reported before it starts, naming its length and its source,
 * with no header value and no credential in the line.
 *
 * @param input - Transport, poller injectables, credential, URL, and pace.
 * @returns The response, or the failure the last attempt produced.
 */
async function requestPage(input: {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL for this page. */
    readonly url: URL;
    /** Page size and retry ladder for this call. */
    readonly pace: ListPace;
}): Promise<PageAttempt> {
    const policy = input.pace.retry;
    const attempts = Math.max(1, policy.maxAttempts);
    let last: PollFailure = { kind: 'unavailable', detail: 'upstream' };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let response: Response;
        try {
            response = await input.runtime.fetchImpl(input.url.href, {
                method: 'GET',
                headers: requestHeaders(input.token),
                signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
            });
        } catch (error) {
            // Transport failures are classified, never described (SEC-11).
            last = { kind: 'unavailable', detail: transportDetail(error) };
            if (attempt >= attempts) {
                return { failure: last };
            }
            await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds: null });
            continue;
        }

        if (response.ok) {
            return { response };
        }

        last = await classifyOutcome(response);
        if (last.kind === 'auth-failed' || attempt >= attempts) {
            return { failure: last };
        }

        const guidanceSeconds = last.kind === 'rate-limited' ? last.retryAfterSeconds : null;
        await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds });
    }

    return { failure: last };
}

/**
 * Read **one** page of a paged endpoint, without deciding whether to ask for
 * another.
 *
 * Split out of {@link listPages} so both walks over this transport share one
 * request-and-parse path, and one failure classification: the list feeds stop
 * when a page under-fills their cap, while the item-events walk stops when a
 * page falls entirely outside the scan window. Two callers, one
 * page reader.
 *
 * @param input - Transport, poller injectables, the URL for this page, the
 *   pace, and the page reader.
 * @returns The normalized entries, or the page failure's class.
 */
export async function readOnePage<T>(input: {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL for this page, already carrying `page` and `per_page`. */
    readonly url: URL;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
    /** Error text when a body is not an array (never upstream text). */
    readonly message: string;
    /** Per-entry reader; `null` drops one malformed entry. */
    readonly read: (value: unknown) => T | null;
}): Promise<PagedList<T>> {
    const attempt = await requestPage({
        runtime: input.runtime,
        token: input.token,
        url: input.url,
        pace: input.pace,
    });
    if (!('response' in attempt)) {
        return attempt.failure;
    }

    try {
        return {
            kind: 'ok',
            items: parseListPage({
                text: await attempt.response.text(),
                message: input.message,
                read: input.read,
            }),
        };
    } catch {
        return { kind: 'unavailable', detail: 'upstream' };
    }
}

/**
 * Read every page one list call covers.
 *
 * Page 2 is requested only when page 1 filled its cap, so the rate budget
 * never sees a burst; a page that keeps failing under the ladder stops the
 * paging and reports its class alone.
 *
 * @param input - Transport, poller injectables, the URL to page through, the
 *   pace, and the page reader.
 * @returns The normalized items, or the page failure's class.
 */
export async function listPages<T>(input: {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL; the `page` parameter is set per iteration. */
    readonly url: URL;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
    /** Error text when a body is not an array (never upstream text). */
    readonly message: string;
    /** Per-entry reader; `null` drops one malformed entry. */
    readonly read: (value: unknown) => T | null;
}): Promise<PagedList<T>> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        input.url.searchParams.set('page', String(page));
        // FR-059(b): the configured page size, whose own maximum is 30, so
        // 002 FR-020's ceiling is the field's bound and nothing else.
        input.url.searchParams.set('per_page', String(input.pace.perPage));

        const parsed = await readOnePage(input);
        if (parsed.kind !== 'ok') {
            return parsed;
        }

        items.push(...parsed.items);
        if (parsed.items.length < input.pace.perPage) {
            break;
        }
    }

    return { kind: 'ok', items };
}
