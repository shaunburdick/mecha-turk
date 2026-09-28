/**
 * Correlation and clock helpers shared by the panel and its tests.
 *
 * Correlation identifiers are the spine of the spike's evidence: every ledger
 * entry and evidence record carries one so a poll, a dispatch, and a lifecycle
 * phase can be tied back to a single observation (NFR-007).
 */

/**
 * Create a new correlation identifier.
 *
 * Uses `crypto.randomUUID()`, which the sandboxed iframe provides in secure
 * contexts (localhost or https). The spike fails closed when it is missing
 * rather than inventing an identifier from weaker entropy.
 *
 * @returns A RFC 4122 version 4 identifier.
 * @throws {Error} When no secure-context UUID source is available.
 */
export function newCorrelationId(): string {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
        throw new Error('crypto.randomUUID is unavailable; refusing to record an observation without a correlation id');
    }

    return crypto.randomUUID();
}

/**
 * Read the current time as an RFC 3339 timestamp.
 *
 * @returns The current time in ISO 8601 / RFC 3339 form.
 */
export function nowIso(): string {
    return new Date().toISOString();
}
