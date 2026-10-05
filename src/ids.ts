/**
 * Correlation and clock helpers shared by the panel and its tests.
 *
 * Correlation identifiers are the spine of the product's evidence: every ledger
 * entry and evidence record carries one so a poll, a dispatch, and a lifecycle
 * phase can be tied back to a single observation (NFR-007).
 */

/**
 * Create a new correlation identifier.
 *
 * Uses `crypto.randomUUID()`, which the sandboxed iframe provides in secure
 * contexts (localhost or https). The panel fails closed when it is missing
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

/**
 * Zero-pad one `Date` getter to two characters.
 *
 * @returns The field as two digits.
 */
function padTwoDigits(part: number): string {
    return String(part).padStart(2, '0');
}

/**
 * Render one stamp as a compact UTC minute (`2026-09-28 09:00`).
 *
 * Absolute rather than relative: two references detected minutes apart must
 * not collapse into the same "2m ago" when the operator is reconstructing
 * which reason fired first, an audit row's timestamp is the same kind of
 * fact, and a binding's created/updated stamps are read the same way.
 *
 * @returns The compact stamp, or the stored text when it is not a time.
 */
export function utcStamp(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
        return iso;
    }

    const value = new Date(at);

    return `${value.getUTCFullYear()}-${padTwoDigits(value.getUTCMonth() + 1)}-${padTwoDigits(value.getUTCDate())}`
        + ` ${padTwoDigits(value.getUTCHours())}:${padTwoDigits(value.getUTCMinutes())}`;
}
