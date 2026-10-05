/**
 * `GET /v1/status` pre-flight for the one-shot handoff (task T-009).
 *
 * The panel reads the service's own health document **before** it enables the
 * credential input (token-handoff F10/SEC-08) and again after a host timeout
 * (F4/SEC-05): the service, not the clock, is the authority on whether an
 * account appeared. Nothing here ever carries a credential — the pre-flight
 * is the one handoff request that is safe to make at any time.
 */

import { HostRequestError } from '@openchamber/sdk';
import type { GuestRequestResult } from '@openchamber/sdk';
import { HOST_COPY, STATUS_UNREADABLE, UNKNOWN_FAILURE } from './handoff-copy.ts';
import { parseJsonObject } from './json.ts';
import type { PanelRuntime } from './panel-state.ts';

/** HTTP status of a healthy `GET /v1/status` answer (contract §2.1). */
const HTTP_OK = 200;

/** Path the pre-flight and the F4 re-read consult (contract §2.1). */
export const STATUS_PATH = '/v1/status';

/** Shape of the `GET /v1/status` fields the handoff reads. */
export interface StatusSnapshot {
    /** Whether the data directory can serve writes. */
    readonly storageWritable: boolean;
    /** Registered accounts, so a timeout can detect a new one (F4). */
    readonly accounts: readonly { readonly numericUserId: string; readonly login: string }[];
}

/**
 * Parse the status document defensively; a shape it cannot read is `null`.
 *
 * @returns The snapshot, or `null` when the body is not a usable status.
 */
function parseStatus(result: GuestRequestResult): StatusSnapshot | null {
    if (result.status !== HTTP_OK) {
        return null;
    }

    const root = parseJsonObject(result.body);
    if (root === null) {
        return null;
    }

    const service = root.service as { storage?: { writable?: unknown } } | undefined;
    const accounts = Array.isArray(root.accounts) ? root.accounts : [];
    const parsedAccounts = accounts.flatMap((entry: unknown) => {
        const account = entry as { numericUserId?: unknown; login?: unknown };
        return typeof account.numericUserId === 'string' && typeof account.login === 'string'
            ? [{ numericUserId: account.numericUserId, login: account.login }]
            : [];
    });

    return { storageWritable: service?.storage?.writable === true, accounts: parsedAccounts };
}

/**
 * Map a thrown host failure onto its documented copy (panel-service §1).
 *
 * @returns Its code, or `null` when the failure carries no known code.
 */
export function hostErrorCode(error: unknown): string | null {
    if (error instanceof HostRequestError) {
        return error.code;
    }

    if (error !== null && typeof error === 'object' && 'code' in error) {
        const { code } = error;

        return typeof code === 'string' && HOST_COPY.has(code) ? code : null;
    }

    return null;
}

/**
 * Run the `GET /v1/status` pre-flight that gates the token input (F10).
 *
 * @returns The parsed snapshot, or `null` when the service could not answer.
 */
export async function preflightHandoff(rt: PanelRuntime): Promise<StatusSnapshot | null> {
    let snapshot: StatusSnapshot | null = null;
    try {
        snapshot = parseStatus(await rt.host.serviceRequest({ method: 'GET', path: STATUS_PATH }));
    } catch (error) {
        rt.state.handoff.note = HOST_COPY.get(hostErrorCode(error) ?? '') ?? UNKNOWN_FAILURE;
    }

    rt.state.handoff.storageWritable = snapshot?.storageWritable ?? false;
    rt.state.handoff.knownAccountIds = snapshot?.accounts.map((account) => account.numericUserId) ?? [];
    if (snapshot === null && rt.state.handoff.note === '') {
        rt.state.handoff.note = STATUS_UNREADABLE;
    }

    return snapshot;
}

/**
 * Re-read `/v1/status` after a host timeout before declaring failure (F4).
 *
 * @returns The snapshot, or `null` when the re-read itself failed.
 */
export async function rereadStatusAfterTimeout(rt: PanelRuntime): Promise<StatusSnapshot | null> {
    try {
        return parseStatus(await rt.host.serviceRequest({ method: 'GET', path: STATUS_PATH }));
    } catch {
        return null;
    }
}

