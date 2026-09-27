/**
 * Consent enforcement for the two credential routes (token-handoff §1.2,
 * SEC-01).
 *
 * `consentVersion` is a **non-secret** integer naming the current copy of
 * `CONSENT_COPY_V1`. It is required in the body of `POST /v1/accounts/verify`
 * and `POST /v1/accounts/:numericUserId/token`, and it is checked **before any
 * GitHub call**: a request without a current version answers
 * `422 consent-required` with nothing persisted and no network traffic.
 *
 * Acceptance records an *occurrence* — `{ version, givenAt }` — in the audit
 * trail, idempotently: the first request carrying a given version writes one
 * row, and every replay of that version writes nothing (contract §1.2 and
 * panel-service §3 invariant 8). A consent row can never contain token bytes
 * because the writer is handed only the version and a timestamp.
 */

import { CONSENT_VERSION } from '../src/consent.ts';
import { nowIso } from '../src/ids.ts';
import { appendAudit, readAuditEntries } from './audit.ts';
import { errorResponse, STATUS } from './http.ts';
import type { HttpResponse } from './http.ts';
import type { ServiceStore } from './store/index.ts';

export { CONSENT_VERSION };

/** The consent version this build of the service enforces. */
export type ConsentCheck =
    | { readonly ok: true; readonly version: number }
    | { readonly ok: false };

/**
 * Validate the `consentVersion` field of a credential-route body.
 *
 * @param body - Parsed request body (already known to be a record).
 * @returns The accepted version, or a refusal when the field is absent, is
 *   not an integer, or is below the current copy version.
 */
export function checkConsent(body: Record<string, unknown>): ConsentCheck {
    const raw = body.consentVersion;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < CONSENT_VERSION) {
        return { ok: false };
    }

    return { ok: true, version: raw };
}

/**
 * Build the `422 consent-required` refusal (contract §4).
 *
 * @returns The response; nothing is persisted and no GitHub call is made.
 */
export function consentRequiredResponse(): HttpResponse {
    return errorResponse(STATUS.validation, {
        code: 'consent-required',
        message: 'consent needs renewing — review and accept the handoff notice again',
    });
}

/**
 * Record the consent occurrence exactly once per version (§1.2 idempotency).
 *
 * @param store - Open store holding the audit trail.
 * @param version - The version the operator accepted.
 * @throws {StorageUnavailableError} When the audit read or append fails, so a
 *   request that cannot record its consent fails instead of proceeding.
 */
export async function recordConsentOccurrence(store: ServiceStore, version: number): Promise<void> {
    const entries = await readAuditEntries(store);
    const recorded = entries.some(
        (entry) => entry.eventType === 'consent' && entry.details.version === version,
    );
    if (recorded) {
        return;
    }

    await appendAudit(store, {
        eventType: 'consent',
        actorSource: 'panel',
        entity: { kind: 'service', id: 'consent' },
        reason: 'operator accepted the handoff consent',
        details: { version, givenAt: nowIso() },
    });
}
