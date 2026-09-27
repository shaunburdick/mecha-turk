/**
 * The normalized issue evidence record for the spike (contract:
 * `specs/001-agent-event-orchestrator/contracts/openchamber.md`).
 *
 * The record is the only provider-derived fact the panel persists for a
 * match: it carries identity, source link, timing, and correlation — never the
 * token, never an Authorization header, and never an unrestricted issue
 * payload. Serialization runs through {@link assertRedacted} so a leak fails
 * loudly instead of being written.
 */

import type { JsonValue } from '@openchamber/sdk';
import { assertRedacted } from './redaction.ts';

/** Schema version stamped on every evidence record. */
export const EVIDENCE_SCHEMA_VERSION = 'extension-spike-1';

/** Storage key for the most recent evidence record. */
export const EVIDENCE_STORAGE_KEY = 'mecha-turk-spike:evidence';

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
    readonly trigger: 'configured-match';
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

    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(input.issueUrl)) {
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
        trigger: 'configured-match',
        authenticatedLogin: input.authenticatedLogin,
        correlationId: input.correlationId,
        detectedAt: input.detectedAt,
        panelGeneration: input.panelGeneration,
    };

    assertEvidenceRedacted(evidence);

    return evidence;
}

/**
 * Parse a stored evidence record.
 *
 * @param value - Value read from `host.storage`.
 * @returns The record, or `null` when the shape does not match the contract.
 */
export function readEvidence(value?: JsonValue): SpikeEvidence | null {
    if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }

    const candidate = value as Record<string, JsonValue>;
    if (candidate.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
        return null;
    }

    const required: readonly (keyof SpikeEvidence)[] = [
        'repository',
        'issueId',
        'issueUrl',
        'trigger',
        'authenticatedLogin',
        'correlationId',
        'detectedAt',
        'panelGeneration',
    ];
    for (const field of required) {
        if (!(field in candidate)) {
            return null;
        }
    }

    return candidate as unknown as SpikeEvidence;
}
