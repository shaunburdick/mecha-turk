/** The admission POST: the flat `{text, delivery:"queue"}` body; an unparseable receipt is timeout-grade ambiguity. */

import { STATUS } from '../http.ts';
import { isRecord, readString } from '../json.ts';
import type { EngineClient } from './client.ts';

/** The only delivery mode a follow-up is ever admitted with. */
export const ENGINE_DELIVERY_MODE = 'queue';

const MESSAGE_ID_PREFIX = 'msg_';

const SUCCESS_MIN = STATUS.ok;

const SERVER_FAILURE_MIN = 500;

/** Exclusive top of the success band: only a 2xx answer can carry a receipt. */
const SUCCESS_MAX_EXCLUSIVE = 300;

/** Why an admission is unknowable; credential-free and operator-readable. */
export type UnknownCause = 'timeout' | 'server-failure' | 'malformed-receipt' | 'transport';

export type AdmissionOutcome =
    | { readonly kind: 'admitted'; readonly messageId: string }
    /** The one failure that proves the POST never arrived. */
    | { readonly kind: 'refused' }
    // Ambiguous — the admission may have landed (timeout, 5xx, transport, or no
    // parseable receipt). Never auto-retried: there is no client-id replay to dedupe against.
    | { readonly kind: 'unknown'; readonly cause: UnknownCause }
    | { readonly kind: 'unauthorized' }
    | { readonly kind: 'no-session' }
    | { readonly kind: 'rejected' };

function receiptIdOf(data: unknown): string | null {
    if (!isRecord(data)) {
        return null;
    }

    const id = readString(data.id) ?? '';

    return id.startsWith(MESSAGE_ID_PREFIX) ? id : null;
}

function receiptOf(body: unknown): string | null {
    return isRecord(body) ? receiptIdOf(body.data) : null;
}

function admissionOf(status: number, body: unknown): AdmissionOutcome {
    if (status === STATUS.unauthorized) {
        return { kind: 'unauthorized' };
    }

    if (status === STATUS.notFound) {
        return { kind: 'no-session' };
    }

    if (status >= SUCCESS_MIN && status < SUCCESS_MAX_EXCLUSIVE) {
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

export async function postFollowUpPrompt(input: {
    readonly client: EngineClient;
    readonly sessionId: string;
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
