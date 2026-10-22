/**
 * The bounded `commits/{sha}/check-runs` walk and its aggregate verdict (FR-126).
 */

import { API_ORIGIN } from '../github.ts';
import { readCheckRunEntry } from './poller-entries.ts';
import { readEnvelopePage } from './poller-transport.ts';
import type { ListPace, PollFailure, PollerRuntime } from './poller-transport.ts';
import type { PollCheckRun } from './poller-entries.ts';

/** The four conclusions that make a head red, most blocking first (FR-127). */
export type CheckConclusion = 'action_required' | 'failure' | 'timed_out' | 'cancelled';

const FAILING_CONCLUSIONS: readonly CheckConclusion[] = [
    'action_required',
    'failure',
    'timed_out',
    'cancelled',
];

/** How many failing check names one follow-up names (FR-129). */
const MAX_CHECK_NAMES = 10;

/** Content pages one head may cost. */
const MAX_CHECK_PAGES = 2;

/** Credential, coordinates and pace one check-runs walk runs under. */
export interface HeadChecksQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    readonly headSha: string;
    readonly pace: ListPace;
}

/** One head's aggregate verdict, or the class that ended the read. */
export type HeadChecksOutcome =
    | PollFailure
    | {
        readonly kind: 'ok';
        readonly conclusion: CheckConclusion | null;
        readonly names: readonly string[];
        readonly truncated: boolean;
    };

/**
 * Read a conclusion as the four-word failing vocabulary.
 */
function failingOf(value: string | null): CheckConclusion | null {
    return FAILING_CONCLUSIONS.find((conclusion) => conclusion === value) ?? null;
}

/**
 * The most blocking failing conclusion present, or `null` when none is.
 */
export function failingConclusionOf(runs: readonly PollCheckRun[]): CheckConclusion | null {
    for (const conclusion of FAILING_CONCLUSIONS) {
        if (runs.some((run) => run.conclusion === conclusion)) {
            return conclusion;
        }
    }

    return null;
}

/**
 * The failing check names, in the order the list returned them, bounded.
 */
export function failingNamesOf(runs: readonly PollCheckRun[]): readonly string[] {
    return runs
        .filter((run) => failingOf(run.conclusion) !== null)
        .map((run) => run.name)
        .slice(0, MAX_CHECK_NAMES);
}

/**
 * Read one head's check runs, two content pages at most.
 *
 * A second page that fills its cap is truncation: the whole list was not read,
 * so the head produces no row and silence is never read as a passing build.
 */
export async function readHeadChecks(
    runtime: PollerRuntime,
    query: HeadChecksQuery,
): Promise<HeadChecksOutcome> {
    const url = new URL(`${API_ORIGIN}/repos/${query.owner}/${query.name}/commits/${query.headSha}/check-runs`);
    url.searchParams.set('filter', 'latest');

    const runs: PollCheckRun[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
        url.searchParams.set('page', String(page));
        url.searchParams.set('per_page', String(query.pace.perPage));

        const parsed = await readEnvelopePage({
            runtime,
            token: query.token,
            url,
            pace: query.pace,
            envelope: 'check_runs',
            message: 'check-runs response was not an envelope',
            read: readCheckRunEntry,
        });
        if (parsed.kind !== 'ok') {
            return parsed;
        }

        runs.push(...parsed.items);
        if (page === MAX_CHECK_PAGES && parsed.items.length >= query.pace.perPage) {
            return { kind: 'ok', conclusion: null, names: [], truncated: true };
        }

        if (parsed.items.length < query.pace.perPage) {
            break;
        }
    }

    return {
        kind: 'ok',
        conclusion: failingConclusionOf(runs),
        names: failingNamesOf(runs),
        truncated: false,
    };
}
