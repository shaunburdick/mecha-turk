/** The engine identity probe: version pin and registry-pid cross-check; failures fail safe to `engine-unavailable`. */

import { STATUS } from '../http.ts';
import { isRecord, readPositiveInt, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

// The floor is the live-verified point; the ceiling is the exclusive major — a
// major bump is exactly when route shapes change. One constant, one deliberate re-pin.
export const ENGINE_VERSION_RANGE = { min: '2.0.29', maxExclusive: '3.0.0' } as const;

const VERSION_COMPONENTS = 3;

export type InfoFailure =
    | 'refused'
    | 'timeout'
    | 'transport'
    | 'unauthorized'
    | 'unreadable'
    | 'version-outside-pin'
    | 'pid-mismatch';

export type InfoOutcome =
    | { readonly ok: true; readonly version: string }
    | { readonly ok: false; readonly cause: InfoFailure };

function compareComponent(left: string | undefined, right: string | undefined): number {
    const mine = left === undefined ? 0 : Number(left);
    const theirs = right === undefined ? 0 : Number(right);
    if (Number.isNaN(mine)) {
        return 1;
    }

    if (Number.isNaN(theirs)) {
        return -1;
    }

    return Math.sign(mine - theirs);
}

function compareVersions(left: string, right: string): number {
    const mine = left.split('.');
    const theirs = right.split('.');
    for (let index = 0; index < VERSION_COMPONENTS; index += 1) {
        const verdict = compareComponent(mine[index], theirs[index]);
        if (verdict !== 0) {
            return verdict;
        }
    }

    return 0;
}

function versionInPin(version: string): boolean {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return false;
    }

    return compareVersions(version, ENGINE_VERSION_RANGE.min) >= 0
        && compareVersions(version, ENGINE_VERSION_RANGE.maxExclusive) < 0;
}

function infoOf(body: unknown, expectedPid: number): InfoOutcome {
    if (!isRecord(body)) {
        return { ok: false, cause: 'unreadable' };
    }

    const version = readString(body.version);
    const pid = readPositiveInt(body.pid);
    if (version === null || pid === null) {
        return { ok: false, cause: 'unreadable' };
    }

    if (!versionInPin(version)) {
        return { ok: false, cause: 'version-outside-pin' };
    }

    if (pid !== expectedPid) {
        return { ok: false, cause: 'pid-mismatch' };
    }

    return { ok: true, version };
}

/** The pid cross-check is what stops a re-used or spoofed port from passing as this run's engine. */
export async function probeInfo(input: {
    readonly client: EngineClient;
    readonly expectedPid: number;
}): Promise<InfoOutcome> {
    const answer = await input.client.request('GET', '/api/info');
    switch (answer.kind) {
        case 'refused':
        case 'timeout':
        case 'transport': {
            return { ok: false, cause: answer.kind };
        }
        case 'reply': {
            if (answer.status === STATUS.ok) {
                return infoOf(answer.body, input.expectedPid);
            }

            return { ok: false, cause: answer.status === STATUS.unauthorized ? 'unauthorized' : 'unreadable' };
        }
    }
}
