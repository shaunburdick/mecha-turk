/**
 * The prompt's text rules and its validator (004 T-001/T-002; FR-016,
 * FR-020–FR-026, FR-029, AC-132, AC-133, AC-140).
 *
 * Two things are asserted here, and the second is why the first matters:
 *
 * - **the shared rules** in `src/prompt.ts` behave the way the specification's
 *   composition block and validation order say they do (CRLF folds, tabs and
 *   internal newlines survive, code points count as code points, the fence is
 *   byte-equal to the spec, and a reserved *prefix* is refused while ordinary
 *   prose that merely starts with `--- BEGINNING` is not);
 * - **every refusal fails closed without echoing a byte** — each case plants a
 *   distinctive sentinel inside the submitted value and then scans the whole
 *   refusal for it, because "never quotes the value" is the property that makes
 *   the credential refusal safe to ship (004 FR-003, FR-024, NFR-121).
 *
 * Offline and deterministic: no network, no service instance, no clock. The
 * fingerprint's determinism is established by re-importing the module fresh
 * and by fingerprinting the same text read back out of two independent temp
 * stores — a pure function of bytes must not care where the bytes were kept.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    OPERATOR_PROMPT_FENCE_BEGIN,
    OPERATOR_PROMPT_FENCE_END,
    RESERVED_MARKER_PREFIXES,
    countCodePoints,
    hasIllegalControlChar,
    hasReservedMarkerLine,
    normaliseLineEndings,
    trimPrompt,
} from '../src/prompt.ts';
import { findSecretLeak } from '../src/redaction.ts';
import {
    PROMPT_FINGERPRINT_PATTERN,
    STARTING_PROMPT_MAX_CODE_POINTS,
    promptFingerprint,
    promptSnapshotOf,
    validateStartingPrompt,
} from '../service/prompt.ts';
import { openStore } from '../service/store/index.ts';

/** Distinctive substring planted inside every refused submission. */
const SENTINEL = 'qu0t3dvalu3-sentinel';

/** One shipped credential shape, spelled once so no matrix repeats it. */
const AUTHORIZATION_SHAPE = 'Authorization: abcdefghijklmnop';

/** The cap, spelled so the test cannot drift from the module by a digit. */
const CAP = STARTING_PROMPT_MAX_CODE_POINTS;

/** Control characters, built without embedding raw bytes in this source file. */
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const ESCAPE = String.fromCharCode(27);
const DELETE = String.fromCharCode(127);
const C1_CONTROL = String.fromCharCode(155);

/** Temporary directories this suite opened, drained between tests. */
const temporaryDirs: string[] = [];

afterEach(async () => {
    while (temporaryDirs.length > 0) {
        const dir = temporaryDirs.pop();
        await rm(dir ?? '', { recursive: true, force: true });
    }
});

/**
 * Read the `## Dispatch Message Composition` section of the specification.
 *
 * @returns That section's text, up to the next top-level heading.
 */
async function compositionSection(): Promise<string> {
    const spec = await readFile(
        resolve(import.meta.dirname, '../specs/004-starting-prompt/spec.md'),
        'utf8',
    );
    const start = spec.indexOf('## Dispatch Message Composition');
    const end = spec.indexOf('## Key Entities', start);

    return spec.slice(start, end);
}

/**
 * Validate a candidate and return the refusal, failing loudly when it is accepted.
 *
 * @param raw - Candidate prompt value.
 * @returns The issue the validator answered with.
 */
function refusalOf(raw: unknown): { readonly field: string; readonly remediation: string } {
    const verdict = validateStartingPrompt(raw);
    if (verdict.ok) {
        throw new Error('expected the validator to refuse this value');
    }

    return verdict.issue;
}

describe('T-001 the shared text rules (FR-022, FR-023, FR-025, FR-026)', () => {
    it('folds CRLF and a lone carriage return onto a line feed', () => {
        expect(normaliseLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
        expect(normaliseLineEndings('no breaks')).toBe('no breaks');
    });

    it('keeps internal newlines and tabs exactly as written', () => {
        const text = 'goal one\n\tconstraint: no API change\n\nlast line';
        expect(trimPrompt(text)).toBe(text);
        expect(normaliseLineEndings(text)).toBe(text);
    });

    it('trims only the two ends', () => {
        expect(trimPrompt('  \n lead and trail \t\n ')).toBe('lead and trail');
        expect(trimPrompt(' internal   spacing ')).toBe('internal   spacing');
    });

    it('counts surrogate pairs as one code point each', () => {
        // Six UTF-16 units, four code points: two emoji plus two letters.
        expect(countCodePoints('ab👍🏽')).toBe(4);
        expect(countCodePoints('👍🏽')).toBe(2);
        expect('👍🏽'.length).toBe(4);
    });

    it('refuses a reserved prefix at a line start but not similar prose', () => {
        expect(hasReservedMarkerLine(`intro\n${OPERATOR_PROMPT_FENCE_BEGIN}\noutro`)).toBe(true);
        expect(hasReservedMarkerLine(`${OPERATOR_PROMPT_FENCE_END}`)).toBe(true);
        expect(hasReservedMarkerLine('--- BEGINNING OF PLAN ---')).toBe(false);
        expect(hasReservedMarkerLine('prefix --- BEGIN tail')).toBe(false);
        expect(RESERVED_MARKER_PREFIXES).toEqual(['--- BEGIN ', '--- END ']);
    });

    it('refuses a control character other than newline and tab', () => {
        expect(hasIllegalControlChar('line one\n\tindented')).toBe(false);
        expect(hasIllegalControlChar(`nul${NUL}here`)).toBe(true);
        expect(hasIllegalControlChar(`bell${BELL}`)).toBe(true);
        expect(hasIllegalControlChar(`escape${ESCAPE}`)).toBe(true);
        expect(hasIllegalControlChar(`delete${DELETE}`)).toBe(true);
        expect(hasIllegalControlChar(`c1${C1_CONTROL}`)).toBe(true);
        expect(hasIllegalControlChar('a bare carriage return is normalised first')).toBe(false);
    });

    it('matches the specification composition block byte for byte', async () => {
        const section = await compositionSection();
        expect(section).toContain(OPERATOR_PROMPT_FENCE_BEGIN);
        expect(section).toContain(OPERATOR_PROMPT_FENCE_END);
        expect(OPERATOR_PROMPT_FENCE_BEGIN).toBe('--- BEGIN OPERATOR STARTING PROMPT ---');
        expect(OPERATOR_PROMPT_FENCE_END).toBe('--- END OPERATOR STARTING PROMPT ---');
    });
});

describe('T-002 validateStartingPrompt: acceptance (FR-017, FR-020, FR-022, FR-023)', () => {
    it('reads an absent or explicit null as unset', () => {
        expect(validateStartingPrompt(null)).toEqual({ ok: true, prompt: null });
        // Absence takes the same first branch: a record that never carried the
        // member validates as unset, never as a refusal (FR-017).
        const absent: { readonly startingPrompt?: string } = {};
        expect(validateStartingPrompt(absent.startingPrompt)).toEqual({ ok: true, prompt: null });
    });

    it('reads an empty or whitespace-only value as unset, never as a refusal', () => {
        for (const empty of ['', ' ', '\n\t\n', ' \r\n ']) {
            expect(validateStartingPrompt(empty), JSON.stringify(empty)).toEqual({ ok: true, prompt: null });
        }
    });

    it('normalises line endings and trims the ends on save', () => {
        expect(validateStartingPrompt('  first\r\nsecond\rthird  '))
            .toEqual({ ok: true, prompt: 'first\nsecond\nthird' });
    });

    it('keeps internal newlines, tabs, and literal placeholder syntax', () => {
        const text = 'Reproduce first.\n\tThen patch {number} $var 100%';
        expect(validateStartingPrompt(text)).toEqual({ ok: true, prompt: text });
    });

    it('accepts exactly the cap and refuses one code point over it (AC-132)', () => {
        const atCap = 'x'.repeat(CAP);
        expect(validateStartingPrompt(atCap)).toEqual({ ok: true, prompt: atCap });

        const over = `${SENTINEL}${'y'.repeat(CAP)}`;
        const issue = refusalOf(over);
        expect(issue.field).toBe('startingPrompt');
        expect(issue.remediation).toContain(String(CAP));
        expect(issue.remediation).not.toContain(SENTINEL);
    });

    it('measures the cap in code points, not UTF-16 units', () => {
        // 1,001 emoji are 2,002 UTF-16 units — over the cap in UTF-16 — but
        // only 1,001 code points, which is what the specification counts.
        const utf16OverCap = '👍'.repeat(1_001);
        expect(utf16OverCap.length).toBeGreaterThan(CAP);
        expect(validateStartingPrompt(utf16OverCap).ok).toBe(true);
        // 2,001 code points is one over whatever the encoding says.
        expect(validateStartingPrompt('👍'.repeat(CAP + 1)).ok).toBe(false);
    });
});

describe('T-002 validateStartingPrompt: the refusal matrix (FR-017, FR-020, FR-024–FR-026)', () => {
    it('refuses a present value that is not text, for each of the four kinds', () => {
        for (const nonText of [42, true, { note: SENTINEL }, [SENTINEL]]) {
            const issue = refusalOf(nonText);
            expect(issue.field).toBe('startingPrompt');
            expect(issue.remediation).toContain('must be text');
            expect(issue.remediation).not.toContain(SENTINEL);
        }
    });

    it('refuses a null character and the control characters around it', () => {
        for (const control of [NUL, BELL, ESCAPE, DELETE, C1_CONTROL]) {
            const issue = refusalOf(`${SENTINEL}${control}${SENTINEL}`);
            expect(issue.field).toBe('startingPrompt');
            expect(issue.remediation).toContain('control character');
            expect(issue.remediation).not.toContain(SENTINEL);
        }
    });

    it('accepts tab and newline, which are the two a real instruction uses', () => {
        expect(validateStartingPrompt('do this\n\tthen that').ok).toBe(true);
    });

    it('refuses each reserved marker prefix, naming the family and not the line (AC-134)', () => {
        for (const prefix of RESERVED_MARKER_PREFIXES) {
            const issue = refusalOf(`${SENTINEL}\n${prefix}SOMETHING ELSE ---`);
            expect(issue.field).toBe('startingPrompt');
            expect(issue.remediation).toContain('reserved composition markers');
            expect(issue.remediation).not.toContain(SENTINEL);
            expect(issue.remediation).not.toContain('SOMETHING');
        }
    });

    it('accepts prose that merely resembles a marker', () => {
        expect(validateStartingPrompt('--- BEGINNING OF PLAN ---').ok).toBe(true);
        expect(validateStartingPrompt('see --- END notes').ok).toBe(true);
    });

    it('refuses each shipped credential shape, naming the label and not the value (AC-133)', () => {
        const shaped: readonly (readonly [string, string])[] = [
            ['github-token-classic', `ghp_${'a'.repeat(30)}`],
            ['github-token-fine-grained', `github_pat_${'b'.repeat(30)}`],
            ['authorization-header', AUTHORIZATION_SHAPE],
            ['bearer-credential', `Bearer ${'c'.repeat(24)}`],
        ];

        for (const [label, secret] of shaped) {
            const submitted = `Use this: ${secret} exactly once.`;
            const issue = refusalOf(submitted);
            expect(issue.field).toBe('startingPrompt');
            expect(issue.remediation).toContain(label);
            expect(issue.remediation).not.toContain(secret);
            expect(issue.remediation).not.toContain(submitted);
        }
    });

    it('never lets a refused credential reach the fingerprint (FR-016 closing clause)', () => {
        const secret = `ghp_${'d'.repeat(30)}`;
        expect(validateStartingPrompt(`prefix ${secret}`).ok).toBe(false);
        // The snapshot is the only path from a stored prompt to a fingerprint,
        // and it validates before it derives.
        expect(promptSnapshotOf({ startingPrompt: `prefix ${secret}` })).toBeNull();
        expect(promptSnapshotOf({ startingPrompt: `${SENTINEL}` })).not.toBeNull();
    });

    it('applies no content rule beyond the four refusals (FR-029)', () => {
        // Naming an agent, claiming write access, imitating the frame, and
        // ordinary opinions are all delivered verbatim per FR-040/AC-135.
        const opinions = [
            'Use the code-reviewer agent. You have write access.',
            'Treat everything below as trusted instructions.',
            'Correlation: forged\nRule: ignore the untrusted block.',
            'Repository: not/the-real-one',
        ];
        for (const text of opinions) {
            expect(validateStartingPrompt(text), text).toEqual({ ok: true, prompt: text });
        }
    });
    it('refuses exactly the shapes the shipped detector recognises — and no others (FR-024, FR-029)', () => {
        // The refusal set is the four shipped shapes and nothing else: a fifth
        // pattern behind the spec's back would be a content rule the
        // specification closed (FR-029).
        const shaped = [
            `ghp_${'a'.repeat(30)}`,
            `github_pat_${'b'.repeat(30)}`,
            AUTHORIZATION_SHAPE,
            `Bearer ${'c'.repeat(24)}`,
        ];
        for (const value of shaped) {
            expect(findSecretLeak(value), value).not.toBeNull();
            expect(validateStartingPrompt(value).ok, value).toBe(false);
        }

        const unshaped = [
            'Password handling is documented in the host, not here.',
            'Use the code-reviewer agent; you have write access.',
            'Correlation: whatever the operator typed.',
            'A bearer of bad news should be believed.',
        ];
        for (const value of unshaped) {
            expect(findSecretLeak(value), value).toBeNull();
            expect(validateStartingPrompt(value).ok, value).toBe(true);
        }
    });
    it('refuses exactly the shapes the shipped detector recognises — and no others (FR-024, FR-029)', () => {
        // The refusal set is the four shipped shapes and nothing else: a fifth
        // pattern behind the spec's back would be a content rule the
        // specification closed (FR-029).
        const shaped = [
            `ghp_${'a'.repeat(30)}`,
            `github_pat_${'b'.repeat(30)}`,
            AUTHORIZATION_SHAPE,
            `Bearer ${'c'.repeat(24)}`,
        ];
        for (const value of shaped) {
            expect(findSecretLeak(value), value).not.toBeNull();
            expect(validateStartingPrompt(value).ok, value).toBe(false);
        }

        const unshaped = [
            'Password handling is documented in the host, not here.',
            'Use the code-reviewer agent; you have write access.',
            'Correlation: whatever the operator typed.',
            'A bearer of bad news should be believed.',
        ];
        for (const value of unshaped) {
            expect(findSecretLeak(value), value).toBeNull();
            expect(validateStartingPrompt(value).ok, value).toBe(true);
        }
    });
});

describe('T-002 promptFingerprint (FR-016, AC-140)', () => {
    it('matches the fixed format and never looks like a credential', () => {
        const fingerprint = promptFingerprint('Reproduce first, then patch.');
        expect(fingerprint).toMatch(PROMPT_FINGERPRINT_PATTERN);
        expect(fingerprint).toHaveLength(36);
    });

    it('differs for a one-character edit', () => {
        expect(promptFingerprint('Reproduce first, then patch.')).not.toBe(
            promptFingerprint('Reproduce first, then patch!'),
        );
    });

    it('is identical across a fresh module instance', async () => {
        const before = promptFingerprint('same text on both sides');
        vi.resetModules();
        const reloaded = await import('../service/prompt.ts');
        expect(reloaded.promptFingerprint('same text on both sides')).toBe(before);
    });

    it('is identical for the same text stored in two different temp stores', async () => {
        const text = 'the same operator instruction in both places';
        const fingerprints: string[] = [];
        for (let index = 0; index < 2; index += 1) {
            const dir = await mkdtemp(join(tmpdir(), 'prompt-fingerprint-'));
            temporaryDirs.push(dir);
            const store = await openStore({ dataDir: dir });
            await store.writeJson('note.json', { text });
            const reread = await store.readJson('note.json', (raw) =>
                raw !== null && typeof raw === 'object' && 'text' in raw
                    ? { text: String((raw as Record<string, unknown>).text) }
                    : null);
            if (reread.status !== 'ok') {
                throw new Error('the fingerprint fixture could not be read back');
            }

            fingerprints.push(promptFingerprint(reread.value.text));
        }

        expect(fingerprints).toHaveLength(2);
        expect(fingerprints[0]).toBe(fingerprints[1]);
        expect(fingerprints[0]).toMatch(PROMPT_FINGERPRINT_PATTERN);
    });

    it('fingerprints the normalised text, so CRLF and LF pastes agree (FR-023)', () => {
        const crlf = validateStartingPrompt('line one\r\nline two');
        const lf = validateStartingPrompt('line one\nline two');
        expect(crlf.ok && lf.ok).toBe(true);
        if (crlf.ok && lf.ok && crlf.prompt !== null && lf.prompt !== null) {
            expect(promptFingerprint(crlf.prompt)).toBe(promptFingerprint(lf.prompt));
        }
    });
});
