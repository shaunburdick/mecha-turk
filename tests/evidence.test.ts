import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import {
    buildEvidence,
    serializeEvidence,
    assertEvidenceRedacted,
    readEvidence,
    EvidenceError,
    EVIDENCE_SCHEMA_VERSION,
} from '../src/evidence.ts';
import type { EvidenceInput } from '../src/evidence.ts';
import { parseJsonValue } from '../src/json.ts';

/** Issue number used across the evidence tests. */
const ISSUE_NO = 12;

/** Panel generation recorded with the observation. */
const GENERATION = 3;

/** Number of fields the contract record carries. */
const EVIDENCE_FIELD_COUNT = 9;

/** A valid evidence input for the happy path. */
function validInput(): EvidenceInput {
    return {
        repository: 'acme/widget',
        issueNumber: ISSUE_NO,
        issueUrl: 'https://github.com/acme/widget/issues/12',
        authenticatedLogin: 'mecha-bot',
        correlationId: '0f1c1f0a-0d2e-4a4e-9a0a-1d2b3c4d5e6f',
        detectedAt: '2026-09-26T12:00:00.000Z',
        panelGeneration: GENERATION,
    };
}

describe('buildEvidence', () => {
    it('produces the contract record with camelCase field names', () => {
        const evidence = buildEvidence(validInput());

        expect(evidence).toEqual({
            schemaVersion: EVIDENCE_SCHEMA_VERSION,
            repository: 'acme/widget',
            issueId: '12',
            issueUrl: 'https://github.com/acme/widget/issues/12',
            trigger: 'configured-match',
            authenticatedLogin: 'mecha-bot',
            correlationId: '0f1c1f0a-0d2e-4a4e-9a0a-1d2b3c4d5e6f',
            detectedAt: '2026-09-26T12:00:00.000Z',
            panelGeneration: GENERATION,
        });
        expect(Object.keys(evidence)).toHaveLength(EVIDENCE_FIELD_COUNT);
    });

    it('rejects a non-GitHub issue URL', () => {
        const foreign = { ...validInput(), issueUrl: 'https://example.com/issue/12' };
        expect(() => buildEvidence(foreign)).toThrow(EvidenceError);
    });

    it('rejects a non-positive issue number', () => {
        expect(() => buildEvidence({ ...validInput(), issueNumber: 0 })).toThrow(EvidenceError);
    });

    it('rejects an empty login', () => {
        expect(() => buildEvidence({ ...validInput(), authenticatedLogin: '  ' })).toThrow(EvidenceError);
    });

    it('rejects an empty correlation id', () => {
        expect(() => buildEvidence({ ...validInput(), correlationId: '' })).toThrow(EvidenceError);
    });

    it('rejects a timestamp that is not RFC 3339', () => {
        expect(() => buildEvidence({ ...validInput(), detectedAt: 'yesterday' })).toThrow(EvidenceError);
    });

    it('rejects a non-positive panel generation', () => {
        expect(() => buildEvidence({ ...validInput(), panelGeneration: 0 })).toThrow(EvidenceError);
    });
});

describe('evidence serialization', () => {
    it('round-trips through JSON and reads back', () => {
        const evidence = buildEvidence(validInput());
        const stored = parseJsonValue(serializeEvidence(evidence));

        expect(readEvidence(stored)).toEqual(evidence);
    });

    it('contains no secret-shaped material', () => {
        const json = serializeEvidence(buildEvidence(validInput()));
        expect(json).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
        expect(json).not.toMatch(/\bAuthorization\s*:/);
    });

    it('asserts redaction before it is stored', () => {
        const evidence = buildEvidence(validInput());
        expect(() => assertEvidenceRedacted(evidence)).not.toThrow();
    });

    it('rejects a stored record under a different schema version', () => {
        const stored: JsonValue = { ...buildEvidence(validInput()), schemaVersion: 'other' };
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects a stored record that is missing a required field', () => {
        const partial: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        delete partial.detectedAt;
        expect(readEvidence(partial)).toBeNull();
    });

    it('rejects a stored value that is not an object', () => {
        expect(readEvidence('not-an-object')).toBeNull();
        expect(readEvidence()).toBeNull();
        expect(readEvidence(null)).toBeNull();
    });
});

describe('readEvidence validation', () => {
    it('rejects a field whose type does not match the contract', () => {
        const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        stored.repository = 42;
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects an empty string field', () => {
        const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        stored.correlationId = '   ';
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects a trigger that is not the configured rule', () => {
        const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        stored.trigger = 'manual';
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects an issue id that is not a number', () => {
        const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        stored.issueId = 'issue-12';
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects an issue url that is not a GitHub issue URL', () => {
        const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        stored.issueUrl = 'https://example.com/acme/widget/issues/12';
        expect(readEvidence(stored)).toBeNull();
    });

    it('rejects a panel generation that is not a positive integer', () => {
        const fractional: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        fractional.panelGeneration = 1.5;
        expect(readEvidence(fractional)).toBeNull();

        const negative: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
        negative.panelGeneration = -1;
        expect(readEvidence(negative)).toBeNull();
    });
});
