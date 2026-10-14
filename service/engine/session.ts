/**
 * The ownership pre-check: `GET /api/session/{id}` must show the
 * dispatch-reported directory under exact-equality normalization and carry
 * `metadata.openchamber`, or the delivery is refused as `engine-unavailable`
 * before any POST — misdelivery across a shared data directory is the risk
 * this refuses (FR-104 span A; plan pin 2).
 */

import { STATUS } from '../http.ts';
import { isRecord, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

/** Why one ownership pre-check refused the session it asked about. */
export type PreCheckFailure =
    | 'refused'
    | 'timeout'
    | 'transport'
    | 'unauthorized'
    /** A non-200 answer or a body this build cannot read. */
    | 'unreadable'
    /** The engine answered `404`: it holds no session with this id. */
    | 'session-404'
    /** The run's store record carries no dispatch-reported directory at all. */
    | 'directory-absent'
    /** The session record carries no `location.directory`. */
    | 'location-absent'
    /** The session's directory is not the dispatch-reported one. */
    | 'directory-mismatch'
    /** The session record carries no `metadata.openchamber`. */
    | 'metadata-absent';

export type PreCheckOutcome =
    | { readonly ok: true }
    | { readonly ok: false; readonly cause: PreCheckFailure };

/** The refusal that names one failed precondition. */
const refused = (cause: PreCheckFailure): PreCheckOutcome => ({ ok: false, cause });

/**
 * Normalize a directory for exact comparison: trailing separators trimmed,
 * nothing else — no prefix rule and no symlink resolution, because either
 * would accept a foreign session living under a subdirectory of the run's own
 * checkout (plan pin 2).
 */
export function normalizedDirectory(directory: string): string {
    return directory.replace(/[\\/]+$/u, '');
}

/** Judge a `200` session-record body against the dispatch-reported directory. */
function ownershipOf(body: unknown, directory: string): PreCheckOutcome {
    if (!isRecord(body)) {
        return refused('unreadable');
    }

    const { data } = body;
    if (!isRecord(data)) {
        return refused('unreadable');
    }

    const locationDirectory = isRecord(data.location) ? readString(data.location.directory) : null;
    if (locationDirectory === null) {
        return refused('location-absent');
    }

    if (normalizedDirectory(locationDirectory) !== normalizedDirectory(directory)) {
        return refused('directory-mismatch');
    }

    if (!isRecord(data.metadata) || !('openchamber' in data.metadata)) {
        return refused('metadata-absent');
    }

    return { ok: true };
}

/**
 * Pre-check ownership of the run's session. An absent dispatch-reported
 * directory refuses **before any request**: a pre-amendment dispatch, the
 * operator-confirm path, or a host that reported none all fail safe to the
 * fallback rather than comparing against a guess (plan pin 2).
 */
export async function preCheckSession(input: {
    readonly client: EngineClient;
    readonly sessionId: string;
    /** The dispatch-reported directory, `undefined` when the run carries none. */
    readonly directory: string | undefined;
}): Promise<PreCheckOutcome> {
    if (input.directory === undefined || input.directory === '') {
        return refused('directory-absent');
    }

    const answer = await input.client.request('GET', `/api/session/${encodeURIComponent(input.sessionId)}`);
    switch (answer.kind) {
        case 'refused':
        case 'timeout':
        case 'transport': {
            return refused(answer.kind);
        }
        case 'reply': {
            if (answer.status === STATUS.notFound) {
                return refused('session-404');
            }

            if (answer.status !== STATUS.ok) {
                return refused(answer.status === STATUS.unauthorized ? 'unauthorized' : 'unreadable');
            }

            return ownershipOf(answer.body, input.directory);
        }
    }
}
