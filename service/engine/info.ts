/**
 * The engine identity probe: `GET /api/info`, the pinned version range, and
 * the registry-pid cross-check — every failure fails safe to
 * `engine-unavailable`, never a hard stop (FR-104 span A; FR-105 span D;
 * plan pin 1).
 */

import { STATUS } from '../http.ts';
import { isRecord, readPositiveInt, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

/**
 * The supported `/api/info` version range: the floor is the live-verified
 * point (research §1) and the ceiling is the exclusive major, because a major
 * bump is exactly when route shapes change. One exported constant so
 * re-pinning is one deliberate edit.
 */
export const ENGINE_VERSION_RANGE = { min: '2.0.29', maxExclusive: '3.0.0' } as const;

/** Dot-separated components one comparable version carries. */
const VERSION_COMPONENTS = 3;

/** Why one identity probe refused the engine it reached. */
export type InfoFailure =
    | 'refused'
    | 'timeout'
    | 'transport'
    | 'unauthorized'
    /** A non-200 answer, or a 200 whose body this build cannot read. */
    | 'unreadable'
    /** `/api/info`'s version sits outside {@link ENGINE_VERSION_RANGE}. */
    | 'version-outside-pin'
    /** `/api/info`'s pid disagrees with the registry file's. */
    | 'pid-mismatch';

export type InfoOutcome =
    | { readonly ok: true; readonly version: string }
    | { readonly ok: false; readonly cause: InfoFailure };

/** Compare one pair of dotted version components; `NaN` counts as zero. */
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

/** Compare two dotted version strings componentwise. */
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

/** Whether a version string is inside the pin and shaped enough to compare. */
function versionInPin(version: string): boolean {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return false;
    }

    return compareVersions(version, ENGINE_VERSION_RANGE.min) >= 0
        && compareVersions(version, ENGINE_VERSION_RANGE.maxExclusive) < 0;
}

/** Judge a `200` `/api/info` body against the pin and the registry pid. */
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

/**
 * Probe the engine's identity: the answer must be a readable `/api/info`
 * body whose version is inside the pin and whose pid is exactly the registry
 * file's — the cross-check that stops a re-used or spoofed port from passing
 * as this run's engine (research §2.6).
 */
export async function probeInfo(input: {
    readonly client: EngineClient;
    /** Pid the registry entry named; the answer must agree. */
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
