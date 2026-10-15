/** The ownership pre-check: the session's directory must equal the dispatch-reported one before any POST. */

import { STATUS } from '../http.ts';
import { isRecord, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

export type PreCheckFailure =
    | 'refused'
    | 'timeout'
    | 'transport'
    | 'unauthorized'
    | 'unreadable'
    | 'session-404'
    | 'directory-absent'
    | 'location-absent'
    | 'directory-mismatch'
    | 'metadata-absent';

export type PreCheckOutcome =
    | { readonly ok: true }
    | { readonly ok: false; readonly cause: PreCheckFailure };

const refused = (cause: PreCheckFailure): PreCheckOutcome => ({ ok: false, cause });

// Trailing separators trimmed, nothing else — no prefix rule and no symlink
// resolution: either would accept a foreign session under a subdirectory of the run's own checkout.
export function normalizedDirectory(directory: string): string {
    return directory.replace(/[\\/]+$/u, '');
}

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

// An absent dispatch-reported directory refuses before any request: pre-amendment
// dispatches and the operator-confirm path fail safe to the fallback, never to a guess.
export async function preCheckSession(input: {
    readonly client: EngineClient;
    readonly sessionId: string;
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
