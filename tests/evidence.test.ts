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
        {
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
        }
        {
            const malformed: readonly (readonly [string, EvidenceInput])[] = [
                ['a non-GitHub issue URL', { ...validInput(), issueUrl: 'https://example.com/issue/12' }],
                ['a non-positive issue number', { ...validInput(), issueNumber: 0 }],
                ['an empty login', { ...validInput(), authenticatedLogin: '  ' }],
                ['an empty correlation id', { ...validInput(), correlationId: '' }],
                ['a timestamp that is not RFC 3339', { ...validInput(), detectedAt: 'yesterday' }],
                ['a non-positive panel generation', { ...validInput(), panelGeneration: 0 }],
            ];

            for (const [shape, input] of malformed) {
                expect(() => buildEvidence(input), shape).toThrow(EvidenceError);
            }
        }
    });
});

describe('evidence serialization', () => {
    it('round-trips through JSON and reads back', () => {
        {
            const evidence = buildEvidence(validInput());
            const stored = parseJsonValue(serializeEvidence(evidence));

            expect(readEvidence(stored)).toEqual(evidence);
        }
        {
            const json = serializeEvidence(buildEvidence(validInput()));
            expect(json).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
            expect(json).not.toMatch(/\bAuthorization\s*:/);
        }
        {
            const evidence = buildEvidence(validInput());
            expect(() => assertEvidenceRedacted(evidence)).not.toThrow();
        }
        {
            const wrongVersion: JsonValue = { ...buildEvidence(validInput()), schemaVersion: 'other' };
            expect(readEvidence(wrongVersion), 'a foreign schema version').toBeNull();

            const partial: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
            delete partial.detectedAt;
            expect(readEvidence(partial), 'a record missing a required field').toBeNull();

            expect(readEvidence('not-an-object'), 'a string').toBeNull();
            expect(readEvidence(), 'an absent value').toBeNull();
            expect(readEvidence(null), 'null').toBeNull();
        }
    });
});

describe('readEvidence validation', () => {
    it('rejects every stored field the contract refuses', () => {
        const mutations: readonly (readonly [string, (stored: Record<string, JsonValue>) => void])[] = [
            ['a field whose type does not match the contract', (stored) => {
                stored.repository = 42;
            }],
            ['an empty string field', (stored) => {
                stored.correlationId = ' '.repeat(3);
            }],
            ['a trigger that is not the configured rule', (stored) => {
                stored.trigger = 'manual';
            }],
            ['an issue id that is not a number', (stored) => {
                stored.issueId = 'issue-12';
            }],
            ['an issue url that is not a GitHub issue URL', (stored) => {
                stored.issueUrl = 'https://example.com/acme/widget/issues/12';
            }],
            ['a fractional panel generation', (stored) => {
                stored.panelGeneration = 1.5;
            }],
            ['a negative panel generation', (stored) => {
                stored.panelGeneration = -1;
            }],
        ];

        for (const [shape, mutate] of mutations) {
            const stored: Record<string, JsonValue> = { ...buildEvidence(validInput()) };
            mutate(stored);
            expect(readEvidence(stored), shape).toBeNull();
        }
    });
});
