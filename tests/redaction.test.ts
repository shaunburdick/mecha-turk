import { describe, expect, it } from 'vitest';
import {
    assertRedacted,
    findSecretLeak,
    redact,
    stripCredentialKeys,
    RedactionError,
} from '../src/redaction.ts';

/** Length a token body needs before the patterns treat it as real material. */
const TOKEN_BODY = 40;

/** A classic GitHub personal access token shape. */
const CLASSIC_TOKEN = `ghp_${'a'.repeat(TOKEN_BODY)}`;

/** A fine-grained GitHub personal access token shape. */
const FINE_GRAINED_TOKEN = `github_pat_${'b'.repeat(TOKEN_BODY)}`;

/** An Authorization header spelling that must never be persisted. */
const AUTH_HEADER = 'Authorization: Bearer 0123456789abcdef0123456789abcdef';

/** Label {@link findSecretLeak} reports for the Authorization header shape. */
const AUTH_LABEL = 'authorization-header';

describe('findSecretLeak', () => {
    it('detects each shipped secret shape under its own label', () => {
        const detected: readonly (readonly [string, string])[] = [
            [`the value is ${CLASSIC_TOKEN} in transit`, 'github-token-classic'],
            [FINE_GRAINED_TOKEN, 'github-token-fine-grained'],
            [AUTH_HEADER, AUTH_LABEL],
            [`Bearer ${'c'.repeat(TOKEN_BODY)}`, 'bearer-credential'],
        ];

        for (const [text, label] of detected) {
            expect(findSecretLeak(text), label).toBe(label);
        }
    });

    it('leaves ordinary text and short non-credential prefixes alone', () => {
        expect(findSecretLeak('poll inspected 12 issues; matched 1'), 'ordinary text').toBeNull();
        expect(findSecretLeak('ghp_short'), 'a short prefix').toBeNull();
    });
});

describe('assertRedacted', () => {
    it('passes clean text and throws without echoing the secret', () => {
        expect(() => assertRedacted('ledger', 'generation 2, 4 entries')).not.toThrow();

        expect(() => assertRedacted('evidence record', `body ${CLASSIC_TOKEN}`)).toThrow(RedactionError);

        let message = '';
        try {
            assertRedacted('evidence record', `body ${CLASSIC_TOKEN}`);
        } catch (error) {
            message = error instanceof Error ? error.message : '';
        }

        expect(message).not.toContain(CLASSIC_TOKEN);
        expect(message).toContain('github-token-classic');
    });
});

describe('redact', () => {
    it('replaces every secret-shaped run with a labelled placeholder, and keeps clean text whole', () => {
        expect(redact(`token=${CLASSIC_TOKEN}`)).toBe('token=[redacted:github-token-classic]');

        const second = `ghp_${'z'.repeat(TOKEN_BODY)}`;
        const redacted = redact(`first=${CLASSIC_TOKEN} second=${second}`);
        expect(redacted).toBe('first=[redacted:github-token-classic] second=[redacted:github-token-classic]');
        expect(redacted).not.toContain(CLASSIC_TOKEN);
        expect(redacted).not.toContain(second);

        const firstBearer = `Bearer ${'c'.repeat(TOKEN_BODY)}`;
        const secondBearer = `Bearer ${'d'.repeat(TOKEN_BODY)}`;
        const bearers = redact(`${firstBearer} then ${secondBearer}`);
        expect(bearers.split('[redacted:bearer-credential]')).toHaveLength(3);
        expect(bearers).not.toContain('cccc');
        expect(bearers).not.toContain('dddd');

        expect(redact('issue #7 assigned')).toBe('issue #7 assigned');
    });
});

describe('findSecretLeak on global patterns', () => {
    it('reports the same first match on every call', () => {
        const text = `header ${AUTH_HEADER} then ${AUTH_HEADER}`;

        expect(findSecretLeak(text)).toBe(AUTH_LABEL);
        expect(findSecretLeak(text)).toBe(AUTH_LABEL);
        expect(findSecretLeak(text)).toBe(AUTH_LABEL);
    });
});

describe('stripCredentialKeys', () => {
    it('drops credential-named keys regardless of case, and keeps the rest', () => {
        const stripped = stripCredentialKeys({
            token: CLASSIC_TOKEN,
            pat: CLASSIC_TOKEN,
            password: 'hunter2',
            secret: 'x',
            apiKey: 'y',
            login: 'mecha-bot',
            count: 3,
            tokenCount: 2,
        });

        expect(stripped).toEqual({ login: 'mecha-bot', count: 3, tokenCount: 2 });
    });
});

describe('a dispatch token is an authorization artifact, not a credential (AC-120)', () => {
    it('survives redaction byte-identically while a credential beside it is still refused', () => {
        const token = `dtk-${'c'.repeat(32)}`;

        // FR-024 requires the panel to persist the token it was authorized with,
        // so `assertRedacted` must accept it on its own (research §R3)…
        expect(redact(`lease ${token} end`)).toBe(`lease ${token} end`);
        expect(findSecretLeak(`lease ${token} end`)).toBeNull();

        // …while a real credential next to that same token is still refused,
        // and the refusal never echoes the credential.
        expect(() => assertRedacted('dispatch record', `${CLASSIC_TOKEN} ${token}`)).toThrow(RedactionError);
        expect(redact(`${CLASSIC_TOKEN} ${token}`)).toContain(token);
    });
});
