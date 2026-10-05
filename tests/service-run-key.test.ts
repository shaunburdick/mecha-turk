/**
 * Run identity derivation (003 FR-010, FR-020, FR-029, FR-050 — T-001).
 *
 * The derivations are the whole identity layer of the run model, so they are
 * asserted as *bytes*, not as "some string came back":
 *
 * 1. determinism — the same coordinates must always produce the same key,
 *    correlation id, and token, or the service could not re-derive an id it
 *    already minted (research §R3's reason for a derived rather than random
 *    token);
 * 2. sensitivity — the ordinal, the subject, and the attempt must each change
 *    the bytes, or two runs (or two attempts) would share one identity;
 * 3. shape — the key is FR-010's tuple, the correlation id and token are
 *    single path-safe segments inside the host's attachment-id bound;
 * 4. redaction posture — a `dtk-…` token must pass `assertRedacted`
 *    byte-identically while a GitHub PAT beside it still throws, so the
 *    credential guard stays armed over the panel's durable attempt record
 *    (research §R3, AC-120).
 */

import { describe, expect, it } from 'vitest';
import { RedactionError, assertRedacted, stripCredentialKeys } from '../src/redaction.ts';
import {
    ATTACHMENT_ID_MAX,
    RUN_PROVIDER,
    buildAttachmentId,
    buildCorrelationId,
    buildDispatchToken,
    buildRunKey,
    buildSubjectKey,
} from '../service/poll/run-key.ts';
import type { RunKeyInput } from '../service/poll/run-key.ts';

/** One subject's coordinates, reused by every derivation below. */
const SUBJECT: RunKeyInput = {
    accountNumericUserId: '77331',
    repository: 'acme/widget',
    subjectType: 'issue',
    subjectNumber: 12,
    ordinal: 0,
};

/** A GitHub-shaped personal access token, for the redaction half. */
const PAT = 'ghp_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';

/** A dispatch token minted for attempt 1 of the fixture run. */
const TOKEN = buildDispatchToken(buildRunKey(SUBJECT), 1);

describe('run key (FR-010)', () => {
    it('assembles the documented tuple, provider first, ordinal last', () => {
        {
            expect(buildRunKey(SUBJECT)).toBe(`${RUN_PROVIDER}|77331|acme/widget|issue|12|0`);
        }
        {
            const first = buildRunKey(SUBJECT);
            const second = buildRunKey({ ...SUBJECT });

            expect(first).toBe(second);
            expect(first).toBe(buildRunKey({ ...SUBJECT, ordinal: 0 }));
        }
        {
            const first = buildRunKey({ ...SUBJECT, ordinal: 0 });
            const second = buildRunKey({ ...SUBJECT, ordinal: 1 });

            expect(first).not.toBe(second);
            expect(first.endsWith('|0')).toBe(true);
            expect(second.endsWith('|1')).toBe(true);
        }
        {
            const base = buildRunKey(SUBJECT);
            const variants = [
                buildRunKey({ ...SUBJECT, accountNumericUserId: '99999' }),
                buildRunKey({ ...SUBJECT, repository: 'acme/other' }),
                buildRunKey({ ...SUBJECT, subjectType: 'pull_request' }),
                buildRunKey({ ...SUBJECT, subjectNumber: 13 }),
            ];

            expect(new Set(variants).size).toBe(4);
            expect(variants).not.toContain(base);
        }
        {
            expect(buildSubjectKey({ ...SUBJECT, ordinal: 7 })).toBe('github|77331|acme/widget|issue|12');
            expect(buildRunKey({ ...SUBJECT, ordinal: 7 })).toBe(`${buildSubjectKey(SUBJECT)}|7`);
        }
        {
            expect(() => buildRunKey({ ...SUBJECT, repository: 'acme|widget' })).toThrow(/separator/);
        }
    });

    it('refuses a subject number or ordinal that is not the integer its field names', () => {
        expect(() => buildRunKey({ ...SUBJECT, subjectNumber: 0 })).toThrow(/positive subject number/);
        expect(() => buildRunKey({ ...SUBJECT, subjectNumber: 1.5 })).toThrow(/positive subject number/);
        expect(() => buildRunKey({ ...SUBJECT, ordinal: -1 })).toThrow(/non-negative ordinal/);
    });
});

describe('correlation id and attachment id (FR-050, FR-029)', () => {
    it('is mt-run- plus 24 hex characters: one path-safe segment', () => {
        {
            const correlationId = buildCorrelationId(buildRunKey(SUBJECT));

            expect(correlationId).toMatch(/^mt-run-[0-9a-f]{24}$/);
            expect(correlationId).toMatch(/^[A-Za-z0-9._~-]+$/);
        }
        {
            const zero = buildCorrelationId(buildRunKey({ ...SUBJECT, ordinal: 0 }));
            const one = buildCorrelationId(buildRunKey({ ...SUBJECT, ordinal: 1 }));

            expect(zero).toBe(buildCorrelationId(buildRunKey(SUBJECT)));
            expect(zero).not.toBe(one);
        }
        {
            const correlationId = buildCorrelationId(buildRunKey(SUBJECT));

            expect(buildAttachmentId(correlationId)).toBe(correlationId);
            expect(correlationId.length).toBeLessThanOrEqual(ATTACHMENT_ID_MAX);
            expect(ATTACHMENT_ID_MAX).toBe(128);
        }
        {
            expect(() => buildAttachmentId('mt-run/../../etc')).toThrow(/path-safe/);
            expect(() => buildAttachmentId('')).toThrow(/path-safe/);
            expect(() => buildAttachmentId(`mt-run-${'a'.repeat(ATTACHMENT_ID_MAX)}`)).toThrow(/path-safe/);
        }
    });
});

describe('dispatch token (FR-020)', () => {
    it('is dtk- plus 32 hex characters: one path-safe segment', () => {
        {
            expect(TOKEN).toMatch(/^dtk-[0-9a-f]{32}$/);
            expect(TOKEN).toMatch(/^[A-Za-z0-9._~-]+$/);
        }
        {
            expect(TOKEN).toBe(buildDispatchToken(buildRunKey(SUBJECT), 1));
            expect(TOKEN).not.toBe(buildDispatchToken(buildRunKey(SUBJECT), 2));
            expect(TOKEN).not.toBe(buildDispatchToken(buildRunKey({ ...SUBJECT, ordinal: 1 }), 1));
        }
        {
            expect(() => buildDispatchToken(buildRunKey(SUBJECT), 0)).toThrow(/positive integer/);
            expect(() => buildDispatchToken(buildRunKey(SUBJECT), 1.5)).toThrow(/positive integer/);
        }
        {
            const record = JSON.stringify({ correlationId: 'mt-run-00000000000000000000000a', dispatchToken: TOKEN });

            expect(() => assertRedacted('dispatch record', record)).not.toThrow();
            expect(JSON.parse(record).dispatchToken).toBe(TOKEN);

            expect(() => assertRedacted('dispatch record', `${record} ${PAT}`)).toThrow(RedactionError);
        }
        {
            const kept = stripCredentialKeys({ dispatchToken: TOKEN, token: PAT });

            expect(kept.dispatchToken).toBe(TOKEN);
            expect('token' in kept).toBe(false);
        }
    });
});
