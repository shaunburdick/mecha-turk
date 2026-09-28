/**
 * The normalized issue evidence record for the extension (contract:
 * schema `extension-spike-1` — see the invariant on wire contracts in
 * AGENTS.md; the record shape is asserted by `tests/evidence.test.ts`).
 *
 * The record is the only provider-derived fact the panel persists for a
 * match: it carries identity, source link, timing, and correlation — never the
 * token, never an Authorization header, and never an unrestricted issue
 * payload. Serialization runs through {@link assertRedacted} so a leak fails
 * loudly instead of being written.
 */

import type { JsonValue } from '@openchamber/sdk';
import { assertRedacted } from './redaction.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { describeError } from './session.ts';

/** Schema version stamped on every evidence record. */
export const EVIDENCE_SCHEMA_VERSION = 'extension-spike-1';

/** Storage key for the most recent evidence record. */
export const EVIDENCE_STORAGE_KEY = 'mecha-turk:evidence';

/** How the spike selects issues; the only trigger this contract defines. */
const TRIGGER = 'configured-match';

/** Canonical GitHub issue URL shape; the same rule writes and reads records. */
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

/** Issue identifier shape; the record stores the issue number as a string. */
const ISSUE_ID_PATTERN = /^\d+$/;

/** Normalized evidence record produced by a configured match. */
export interface SpikeEvidence {
    /** Contract schema version. */
    readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
    /** `owner/name` of the polled repository. */
    readonly repository: string;
    /** Issue number as a stable string identifier. */
    readonly issueId: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** How the issue was selected; always the configured rule for this spike. */
    readonly trigger: typeof TRIGGER;
    /** Login discovered from `GET /user` — the machine identity, never the token. */
    readonly authenticatedLogin: string;
    /** Correlation identifier shared with the ledger entries. */
    readonly correlationId: string;
    /** RFC 3339 detection time. */
    readonly detectedAt: string;
    /** Panel mount generation that observed the match. */
    readonly panelGeneration: number;
}

/** Inputs to {@link buildEvidence}. */
export interface EvidenceInput {
    /** `owner/name` of the polled repository. */
    readonly repository: string;
    /** Matched issue number. */
    readonly issueNumber: number;
    /** Matched issue URL. */
    readonly issueUrl: string;
    /** Login discovered from `GET /user`. */
    readonly authenticatedLogin: string;
    /** Correlation identifier for this observation. */
    readonly correlationId: string;
    /** RFC 3339 detection time. */
    readonly detectedAt: string;
    /** Panel mount generation. */
    readonly panelGeneration: number;
}

/**
 * Raised when an input cannot produce a valid evidence record.
 *
 * Fail-closed by design: an unusable observation is discarded rather than
 * persisted in a degraded shape.
 */
export class EvidenceError extends Error {
    /** Stable machine-readable marker so callers can discriminate. */
    public override readonly name = 'EvidenceError';

    /**
     * @param message - Description of the invalid input; never includes secrets.
     */
    public constructor(message: string) {
        super(message);
    }
}

/**
 * Serialize an evidence record for storage.
 *
 * @param evidence - Record to serialize.
 * @returns Compact JSON, asserted to be free of secret-shaped material.
 */
export function serializeEvidence(evidence: SpikeEvidence): string {
    const json = JSON.stringify(evidence);
    assertRedacted('evidence record', json);
    return json;
}

/**
 * Assert that a record can be persisted without carrying secret material.
 *
 * @param evidence - Record about to be written to `host.storage`.
 * @throws {RedactionError} When the serialized record matches a secret shape.
 */
export function assertEvidenceRedacted(evidence: SpikeEvidence): void {
    assertRedacted('evidence record', serializeEvidence(evidence));
}

/**
 * Build the normalized evidence record for one configured match.
 *
 * @param input - Matched issue, identity, and correlation inputs.
 * @returns The redacted evidence record.
 * @throws {EvidenceError} When an input is missing or malformed.
 */
export function buildEvidence(input: EvidenceInput): SpikeEvidence {
    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
        throw new EvidenceError('issue number must be a positive integer');
    }

    if (!ISSUE_URL_PATTERN.test(input.issueUrl)) {
        throw new EvidenceError('issue URL must be an https GitHub issue URL');
    }

    if (input.authenticatedLogin.trim() === '') {
        throw new EvidenceError('authenticated login must not be empty');
    }

    if (input.correlationId.trim() === '') {
        throw new EvidenceError('correlation id must not be empty');
    }

    if (Number.isNaN(Date.parse(input.detectedAt))) {
        throw new EvidenceError('detectedAt must be an RFC 3339 timestamp');
    }

    if (!Number.isInteger(input.panelGeneration) || input.panelGeneration < 1) {
        throw new EvidenceError('panelGeneration must be a positive integer');
    }

    const evidence: SpikeEvidence = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        repository: input.repository,
        issueId: String(input.issueNumber),
        issueUrl: input.issueUrl,
        trigger: TRIGGER,
        authenticatedLogin: input.authenticatedLogin,
        correlationId: input.correlationId,
        detectedAt: input.detectedAt,
        panelGeneration: input.panelGeneration,
    };

    assertEvidenceRedacted(evidence);

    return evidence;
}

/**
 * Narrow a stored JSON value to a record.
 *
 * @param value - Value read from `host.storage`.
 * @returns The value as a record, or `null` for anything else.
 */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return value;
}

/**
 * Read a non-empty string field from a stored record.
 *
 * @param record - Stored record.
 * @param field - Field name.
 * @returns The value, or `null` when it is missing or not usable text.
 */
function readTextField(record: Record<string, JsonValue>, field: string): string | null {
    const value = record[field];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Read the panel generation from a stored record.
 *
 * @param record - Stored record.
 * @returns The generation, or `null` when it is not a positive integer.
 */
function readGenerationField(record: Record<string, JsonValue>): number | null {
    const { panelGeneration } = record;
    if (typeof panelGeneration !== 'number' || !Number.isInteger(panelGeneration) || panelGeneration < 1) {
        return null;
    }

    return panelGeneration;
}

/** Contract fields read from storage, before the format checks run. */
interface EvidenceFields {
    /** `owner/name` of the polled repository. */
    readonly repository: string;
    /** Issue number as a string. */
    readonly issueId: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** Login discovered from `GET /user`. */
    readonly authenticatedLogin: string;
    /** Correlation identifier shared with the ledger entries. */
    readonly correlationId: string;
    /** RFC 3339 detection time. */
    readonly detectedAt: string;
    /** Panel mount generation that observed the match. */
    readonly panelGeneration: number;
}

/**
 * Read every typed field of a stored evidence record.
 *
 * @param record - Stored record.
 * @returns The fields when every one is present and well-typed, else `null`.
 */
function readEvidenceFields(record: Record<string, JsonValue>): EvidenceFields | null {
    const repository = readTextField(record, 'repository');
    const issueId = readTextField(record, 'issueId');
    const issueUrl = readTextField(record, 'issueUrl');
    const authenticatedLogin = readTextField(record, 'authenticatedLogin');
    const correlationId = readTextField(record, 'correlationId');
    const detectedAt = readTextField(record, 'detectedAt');
    const panelGeneration = readGenerationField(record);

    if (
        repository === null ||
        issueId === null ||
        issueUrl === null ||
        authenticatedLogin === null ||
        correlationId === null ||
        detectedAt === null ||
        panelGeneration === null
    ) {
        return null;
    }

    return { repository, issueId, issueUrl, authenticatedLogin, correlationId, detectedAt, panelGeneration };
}

/**
 * Parse a stored evidence record.
 *
 * Storage is untrusted: every field is checked against the shape
 * {@link buildEvidence} produces — types, formats, and the fixed trigger —
 * rather than cast into the interface, so a hand-edited or partially written
 * value cannot reach the dispatch path as a half-valid record.
 *
 * @param value - Value read from `host.storage`.
 * @returns The record, or `null` when the shape does not match the contract.
 */
export function readEvidence(value?: JsonValue): SpikeEvidence | null {
    const record = asRecord(value);
    if (record?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
        return null;
    }

    const fields = readEvidenceFields(record);
    if (fields === null || record.trigger !== TRIGGER || Number.isNaN(Date.parse(fields.detectedAt))) {
        return null;
    }

    if (!ISSUE_ID_PATTERN.test(fields.issueId) || !ISSUE_URL_PATTERN.test(fields.issueUrl)) {
        return null;
    }

    return { schemaVersion: EVIDENCE_SCHEMA_VERSION, ...fields, trigger: TRIGGER };
}

/**
 * Report an unavailable storage surface on the panel banner.
 *
 * The record's home is the operator's own `host.storage`; when the frame
 * cannot read it, the panel says so instead of silently showing no record.
 *
 * @param rt - Panel runtime whose banner shows the problem.
 * @param cause - The caught storage failure.
 */
function describeStorageFailure(rt: PanelRuntime, cause: unknown): void {
    setStatus(rt, { tone: 'error', title: 'Storage unavailable', body: describeError(cause) });
}

/**
 * Restore the stored evidence record after a remount.
 *
 * The evidence record is written before a dispatch is attempted, so a panel
 * that is closed and reopened must find it again: without this the reopened
 * panel would show a match it can no longer dispatch (S6 lifecycle).
 *
 * @param rt - Panel runtime to restore the record onto.
 */
export async function restoreStoredEvidence(rt: PanelRuntime): Promise<void> {
    let stored: JsonValue | undefined;
    try {
        stored = await rt.host.storage.get(EVIDENCE_STORAGE_KEY);
    } catch (cause) {
        describeStorageFailure(rt, cause);
        return;
    }

    if (rt.disposed) {
        return;
    }

    const evidence = readEvidence(stored);
    if (evidence !== null) {
        rt.state.evidence = evidence;
    }
}
