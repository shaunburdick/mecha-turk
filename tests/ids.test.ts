/**
 * The correlation-id mint (005 FR-144; `005 AC-166`, the mint half of
 * `005 AC-162`(b)): native source, same-CSPRNG fallback, refusal only when neither.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { correlationIdMode, newCorrelationId } from '../src/ids.ts';

/** The byte-level UUIDv4 definition FR-144 fixes for both mint paths. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The refusal, pinned as bytes here: a message read from the source would track it. */
const BOTH_ABSENT =
    'crypto.randomUUID is unavailable; refusing to record an observation without a correlation id';

/** A stand-in for the native API, so "the source is still `randomUUID`" is observable. */
const NATIVE_ID = '11111111-1111-4111-8111-111111111111';

/** How many ids one assertion draws, to say "several" rather than "one". */
const ID_COUNT = 8;

/** The frame's real CSPRNG, captured before any test stubs `crypto` away. */
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the mint keeps randomUUID as the source where it exists (FR-144)', () => {
    it('returns exactly what the native API answered', () => {
        vi.stubGlobal('crypto', { randomUUID: () => NATIVE_ID, getRandomValues: realGetRandomValues });

        expect(correlationIdMode()).toBe('randomUUID');
        expect(newCorrelationId()).toBe(NATIVE_ID);
    });

    it('mints UUIDv4 from getRandomValues when randomUUID is unavailable', () => {
        vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });

        expect(correlationIdMode()).toBe('getRandomValues');
        const fallback = Array.from({ length: ID_COUNT }, () => newCorrelationId());
        for (const id of fallback) {
            expect(id).toMatch(UUID_V4);
        }

        expect(new Set(fallback).size).toBe(fallback.length);
    });

    it('mints the identical shape on both paths', () => {
        const native = Array.from({ length: ID_COUNT }, () => newCorrelationId());
        vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });
        const fallback = Array.from({ length: ID_COUNT }, () => newCorrelationId());

        for (const id of [...native, ...fallback]) {
            expect(id).toMatch(UUID_V4);
        }
    });
});

describe('the refusal fires only when neither API exists (005 AC-162 (b))', () => {
    it('throws the pinned message, byte for byte', () => {
        vi.stubGlobal('crypto', undefined);
        expect(correlationIdMode()).toBe('unavailable');

        const messages: string[] = [];
        try {
            newCorrelationId();
        } catch (cause) {
            messages.push(cause instanceof Error ? cause.message : 'the mint threw something that is not an Error');
        }

        expect(messages).toEqual([BOTH_ABSENT]);
    });
});

describe('the mint path has no third entropy source (FR-144)', () => {
    it('contains no Math.random in the module that mints', () => {
        // Comment lines carry the requirement's own prose about the source it
        // refuses; a literal the mint could execute never does (the same
        // comment filter `tests/about-tab.test.ts` runs over its scan).
        const code = readFileSync(resolve(import.meta.dirname, '../src/ids.ts'), 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
            .join('\n');

        expect(code).not.toMatch(/Math\.random/u);
    });
});
