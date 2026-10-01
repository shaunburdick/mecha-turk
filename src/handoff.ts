/**
 * The panel's one-shot credential handoff (task T-009, token-handoff §2).
 *
 * Write-through, one shot, no cache, no retry buffer: the token enters this
 * module as a function argument, lives in the module-scoped {@link activeToken}
 * variable for the duration of the request, and is cleared in a `finally`
 * block on **every** exit — success, service refusal, host failure, timeout, or
 * a thrown error (contract §2 step ⑧, failure modes F1–F16). It is never
 * written to `host.storage`, never rendered, and never interpolated into a
 * note: the copy in this file is built from status *codes* only.
 *
 * Order is the contract's: `GET /v1/status` pre-flight so
 * an unwritable store is discovered **before** the token is typed into a
 * request (F10/SEC-08) → `POST /v1/accounts/verify` → map the outcome. (The
 * in-panel consent step that used to sit between the paste and the request
 * was removed by product-owner order on 2026-10-01 — the Accounts section now
 * carries a static disclaimer instead; token-handoff §1.1.) A `HOST_TIMEOUT`
 * re-reads `/v1/status`
 * before the panel declares failure (F4/SEC-05): the service, not the clock,
 * is the authority on whether an account appeared.
 *
 * One refusal is a *positive* signal instead of a failure: the service's 409
 * `duplicate-account` means the pasted token belongs to an account the service
 * already holds, so {@link applyServiceFailure} asks the adoption module to
 * connect it silently (nothing to re-ask — the service already holds the
 * credential) and
 * renders the adopted identity instead of the rotate-the-token copy. Only a
 * failed adoption falls back to the refusal wording.
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import { adoptOnDuplicate, isDuplicateRefusal } from './account-adoption.ts';
import { readScopeMirror, writeAccountMirror } from './account-mirror.ts';
import { rotationRetained } from './accounts-rows.ts';
import {
    HOST_COPY,
    REASON_COPY,
    SERVICE_COPY,
    STORAGE_REFUSAL,
    UNKNOWN_FAILURE,
    connectedLine,
} from './handoff-copy.ts';
import { hostErrorCode, preflightHandoff, rereadStatusAfterTimeout } from './handoff-status.ts';
import { parseJsonObject } from './json.ts';
import { reloadBindingsAfterConnect } from './bindings.ts';
import { accountTokenPath } from './service-calls.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Path the handoff posts to (contract §2.2). */
export const VERIFY_PATH = '/v1/accounts/verify';

/** Success status of `POST /v1/accounts/verify` (contract §2.2). */
const HTTP_CREATED = 201;

/** Success status of the token-replacement route (005 FR-064). */
const HTTP_OK = 200;

/** Status a store-backed route answers with when storage is unusable (F14). */
const HTTP_STORAGE_UNAVAILABLE = 503;

/** The credential in flight; cleared in `finally` on every exit (§2 step ⑧). */
let activeToken: string | undefined;

/** What the panel knows about one handoff attempt. */
export interface HandoffState {
    /** Whether `GET /v1/status` reported `service.storage.writable`. */
    storageWritable: boolean;
    /**
     * Account ids seen in the pre-flight, so F4 can detect a new one.
     */
    knownAccountIds: readonly string[];
    /** Identity rendered as `Connected as <login>` after a success. */
    connected: { readonly numericUserId: string; readonly login: string } | null;
    /** Operator-facing note; never contains credential material. */
    note: string;
    /** Whether a handoff is currently in flight. */
    busy: boolean;
}

/** Input accepted by {@link runHandoff}. */
export interface HandoffInput {
    /** The pasted credential; lives only in this call's scope. */
    readonly token: string;
    /** Optional operator-supplied expected login (FR-009). */
    readonly expectedLogin?: string;
}

/**
 * Create the empty handoff state shown before the first pre-flight.
 *
 * @returns The initial state.
 */
export function initialHandoffState(): HandoffState {
    return {
        storageWritable: false,
        knownAccountIds: [],
        connected: null,
        note: '',
        busy: false,
    };
}

/**
 * Read the credential currently in flight (test seam for F-clear assertions).
 *
 * @returns The active token, or `undefined` when nothing is in flight.
 */
export function currentHandoffToken(): string | undefined {
    return activeToken;
}

/**
 * Apply the storage pre-flight before anything is sent.
 *
 * @param rt - Panel runtime.
 * @returns A refusal reason when the handoff must not be sent, otherwise `null`.
 */
async function handoffGate(rt: PanelRuntime): Promise<string | null> {
    const snapshot = await preflightHandoff(rt);
    if (snapshot === null) {
        return rt.state.handoff.note === '' ? UNKNOWN_FAILURE : rt.state.handoff.note;
    }

    if (!snapshot.storageWritable) {
        rt.state.handoff.note = STORAGE_REFUSAL;

        return STORAGE_REFUSAL;
    }

    return null;
}

function serviceErrorEnvelope(result: GuestRequestResult): { readonly code: string; readonly reason: string | null } {
    const root = parseJsonObject(result.body);
    const error = root?.error as { code?: unknown; reasonClass?: unknown } | undefined;
    const code = typeof error?.code === 'string' ? error.code : '';
    const reason = typeof error?.reasonClass === 'string' ? error.reasonClass : null;

    return { code, reason };
}

/**
 * Parse a credential-route failure envelope into its copy.
 *
 * @param result - The non-2xx response from the service.
 * @returns Operator-facing copy built from the code alone (never a value).
 */
function serviceFailureCopy(result: GuestRequestResult): string {
    const { code, reason } = serviceErrorEnvelope(result);
    if (code === 'credential-rejected' && reason !== null) {
        return REASON_COPY.get(reason) ?? SERVICE_COPY.get(code) ?? UNKNOWN_FAILURE;
    }

    return SERVICE_COPY.get(code) ?? UNKNOWN_FAILURE;
}

/**
 * Handle a `201` verification: render the identity and mirror the account.
 *
 * A success also triggers the Bindings tab's own re-read (see
 * {@link reloadBindingsAfterConnect}), so the accounts dropdown lists the
 * account the service just registered without a manual Refresh.
 *
 * @param rt - Panel runtime.
 * @param result - The service's success response.
 * @returns `true` when the body carried a usable identity.
 */
async function completeHandoff(rt: PanelRuntime, result: GuestRequestResult): Promise<boolean> {
    const root = parseJsonObject(result.body);
    if (root === null) {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return false;
    }

    const { numericUserId } = root;
    const { login } = root;
    if (typeof numericUserId !== 'string' || typeof login !== 'string') {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return false;
    }

    const identity = { numericUserId, login, scopeCheck: readScopeMirror(root.scopeCheck) };
    rt.state.handoff.connected = { numericUserId, login };
    rt.state.handoff.note = connectedLine(login);
    await writeAccountMirror(rt, identity);
    // The service now holds the account, so the Bindings tab's accounts dropdown
    // must list it: re-read both lists behind the handoff (fire-and-forget).
    reloadBindingsAfterConnect(rt);

    return true;
}

/**
 * Handle a failure thrown by `serviceRequest` (host transport codes, F1–F4).
 *
 * @param rt - Panel runtime.
 * @param error - The caught failure.
 */
async function applyHostFailure(rt: PanelRuntime, error: unknown): Promise<void> {
    const code = hostErrorCode(error);
    if (code === null) {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return;
    }

    if (code === 'HOST_TIMEOUT') {
        const snapshot = await rereadStatusAfterTimeout(rt);
        const appeared = snapshot?.accounts.find(
            (account) => !rt.state.handoff.knownAccountIds.includes(account.numericUserId),
        );
        if (appeared !== undefined) {
            await completeHandoff(rt, {
                status: 200,
                body: JSON.stringify({ numericUserId: appeared.numericUserId, login: appeared.login }),
            });

            return;
        }
    }

    rt.state.handoff.note = HOST_COPY.get(code) ?? UNKNOWN_FAILURE;
}

/**
 * Handle a non-2xx answer from the credential route (F5–F15).
 *
 * The 409 `duplicate-account` refusal is the service's own statement that the
 * pasted credential belongs to an account it already holds, so it routes to
 * the silent adoption instead of the failure copy: the account is connected
 * from `GET /v1/accounts`, and the operator sees the adopted identity rather
 * than an instruction to rotate a token that is actually fine. Adoption only
 * needs the service's own answer. A genuinely unreachable service (adoption
 * still fails) keeps the catalogue copy for the code on the note line.
 *
 * @param rt - Panel runtime.
 * @param result - The service's failure response.
 */
async function applyServiceFailure(rt: PanelRuntime, result: GuestRequestResult): Promise<void> {
    if (isDuplicateRefusal(result)) {
        await adoptOnDuplicate(rt);

        return;
    }

    // A refused *rotation* leaves a credential that still stands, so the
    // connected line survives it; only a refused new handoff disconnects.
    if (rt.state.accounts.rotateArmed === null) {
        rt.state.handoff.connected = null;
    }

    rt.state.handoff.note = serviceFailureCopy(result);
    if (result.status === HTTP_STORAGE_UNAVAILABLE) {
        rt.state.handoff.storageWritable = false;
    }
}

/**
 * Send the one-shot credential request (contract §2 step ④).
 *
 * When a row has armed the Rotate-token control, the same paste goes to the
 * existing token-replacement route for that account instead (002 FR-012,
 * 005 FR-064): the pre-flight gate and the one-shot clearing are
 * identical — only the path differs, and `expectedLogin` never travels on a
 * rotation, because the route replaces a credential for an account that is
 * already identified (it accepts no constraint).
 *
 * @param rt - Panel runtime, whose armed row picks the route.
 * @param input - Credential and optional expected login.
 * @returns The service's answer.
 */
async function requestVerification(rt: PanelRuntime, input: HandoffInput): Promise<GuestRequestResult> {
    const rotating = rt.state.accounts.rotateArmed;
    const body: Record<string, unknown> = { token: input.token };
    if (rotating === null && input.expectedLogin !== undefined) {
        body.expectedLogin = input.expectedLogin;
    }

    return await rt.host.serviceRequest({
        method: 'POST',
        path: rotating === null ? VERIFY_PATH : accountTokenPath(rotating),
        body: JSON.stringify(body),
    });
}

/**
 * Settle a rotation the service accepted (005 FR-064).
 *
 * The account's identity does not change when its credential does, so
 * nothing in the panel's mirror or its connected line is rewritten — only
 * the armed row clears, and the note states the retention the confirmation
 * promised. The service's own record (and its audit row) is untouched by
 * this side of the wire.
 *
 * @param rt - Panel runtime.
 * @param numericUserId - Account whose token the service replaced.
 */
function finishRotation(rt: PanelRuntime, numericUserId: string): void {
    const account = rt.state.bindings.accounts.find(
        (candidate) => candidate.numericUserId === numericUserId,
    );
    rt.state.accounts.rotateArmed = null;
    rt.state.accounts.note =
        account === undefined ? 'Token rotated.' : rotationRetained(account.login);
}

/**
 * Run one handoff from paste to result (token-handoff §2).
 *
 * @param rt - Panel runtime.
 * @param input - The pasted credential and optional expected login.
 */
export async function runHandoff(rt: PanelRuntime, input: HandoffInput): Promise<void> {
    activeToken = input.token;
    rt.state.handoff.busy = true;
    try {
        const refusal = await handoffGate(rt);
        if (refusal !== null) {
            rt.state.handoff.note = refusal;

            return;
        }

        const rotating = rt.state.accounts.rotateArmed;
        const result = await requestVerification(rt, input);
        if (rotating !== null && result.status === HTTP_OK) {
            finishRotation(rt, rotating);
        } else if (result.status === HTTP_CREATED) {
            await completeHandoff(rt, result);
        } else {
            await applyServiceFailure(rt, result);
        }
    } catch (error) {
        await applyHostFailure(rt, error);
    } finally {
        activeToken = undefined;
        rt.state.handoff.busy = false;
    }
}
