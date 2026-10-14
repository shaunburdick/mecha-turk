/**
 * The admission: `POST /api/session/{id}/prompt` with the flat
 * `{text, delivery:"queue"}` body and nothing else, the `msg_…` receipt, and
 * the closed answer classification — an unparseable receipt is the same
 * ambiguity as a timeout, because it proves nothing about admission
 * (FR-104 span A; FR-105 spans D/E; spec §9).
 */

import { STATUS } from '../http.ts';
import { isRecord, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

/** The only delivery mode a follow-up is ever admitted with (spec §9). */
export const ENGINE_DELIVERY_MODE = 'queue';

/** Prefix the engine's own message ids carry (openapi `Session.Message.ID`). */
const MESSAGE_ID_PREFIX = 'msg_';

/** Lowest status the engine answers an admitted prompt with. */
const SUCCESS_MIN = STATUS.ok;

/** Lowest status that is a server-side failure rather than a refusal. */
const SERVER_FAILURE_MIN = 500;

/** Lowest status outside the success band once 401 and 404 are classified. */
const SUCCESS_MAX = 400;

/** Why an admission is unknowable; credential-free and operator-readable. */
export type UnknownCause = 'timeout' | 'server-failure' | 'malformed-receipt' | 'transport';

/** How an admission request settled. */
export type AdmissionOutcome =
    /** The engine answered 200 with a parseable `msg_…` receipt. */
    | { readonly kind: 'admitted'; readonly messageId: string }
    /** Connection refused: the one failure that proves the POST never arrived. */
    | { readonly kind: 'refused' }
    /**
     * Ambiguous: the admission may have landed (timeout, 5xx, transport, or a
     * 200 with no parseable receipt). Never auto-retried — there is no
     * client-id replay to dedupe against (research §2.7).
     */
    | { readonly kind: 'unknown'; readonly cause: UnknownCause }
    /** The engine answered `401`: no rung, engine-unavailable. */
    | { readonly kind: 'unauthorized' }
    /** The engine answered `404` for the run's session: NO_SESSION. */
    | { readonly kind: 'no-session' }
    /** Any other refusal the engine answered: nothing was admitted. */
    | { readonly kind: 'rejected' };

/** Read the admission receipt out of one `data` member: `msg_…`-shaped only. */
function receiptIdOf(data: unknown): string | null {
    if (!isRecord(data)) {
        return null;
    }

    const id = readString(data.id) ?? '';

    return id.startsWith(MESSAGE_ID_PREFIX) ? id : null;
}

/** Read the admission receipt: `data.id`, and only a `msg_…`-shaped one. */
function receiptOf(body: unknown): string | null {
    return isRecord(body) ? receiptIdOf(body.data) : null;
}

/** Judge one engine reply to the admission POST against the closed table. */
function admissionOf(status: number, body: unknown): AdmissionOutcome {
    if (status === STATUS.unauthorized) {
        return { kind: 'unauthorized' };
    }

    if (status === STATUS.notFound) {
        return { kind: 'no-session' };
    }

    if (status >= SUCCESS_MIN && status <= SUCCESS_MAX) {
        const messageId = receiptOf(body);

        return messageId === null
            ? { kind: 'unknown', cause: 'malformed-receipt' }
            : { kind: 'admitted', messageId };
    }

    if (status >= SERVER_FAILURE_MIN) {
        return { kind: 'unknown', cause: 'server-failure' };
    }

    return { kind: 'rejected' };
}

/**
 * POST one follow-up admission. The body carries the flat top-level `text`
 * and `delivery: "queue"` the engine's schema requires — three sources agree
 * on the flat shape and the offline fake 400s the nested one (research §2.1).
 */
export async function postFollowUpPrompt(input: {
    readonly client: EngineClient;
    readonly sessionId: string;
    /** The composed, budget-checked follow-up message. */
    readonly text: string;
}): Promise<AdmissionOutcome> {
    const answer = await input.client.request(
        'POST',
        `/api/session/${encodeURIComponent(input.sessionId)}/prompt`,
        { text: input.text, delivery: ENGINE_DELIVERY_MODE },
    );
    switch (answer.kind) {
        case 'refused': {
            return { kind: 'refused' };
        }
        case 'timeout': {
            return { kind: 'unknown', cause: 'timeout' };
        }
        case 'transport': {
            return { kind: 'unknown', cause: 'transport' };
        }
        case 'reply': {
            return admissionOf(answer.status, answer.body);
        }
    }
}
