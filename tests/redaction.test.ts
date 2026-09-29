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
    it('detects a classic GitHub token', () => {
        expect(findSecretLeak(`the value is ${CLASSIC_TOKEN} in transit`)).toBe('github-token-classic');
    });

    it('detects a fine-grained GitHub token', () => {
        expect(findSecretLeak(FINE_GRAINED_TOKEN)).toBe('github-token-fine-grained');
    });

    it('detects an Authorization header', () => {
        expect(findSecretLeak(AUTH_HEADER)).toBe(AUTH_LABEL);
    });

    it('detects a long bearer credential', () => {
        expect(findSecretLeak(`Bearer ${'c'.repeat(TOKEN_BODY)}`)).toBe('bearer-credential');
    });

    it('leaves ordinary ledger text alone', () => {
        expect(findSecretLeak('poll inspected 12 issues; matched 1')).toBeNull();
    });

    it('ignores short prefixes that are not credentials', () => {
        expect(findSecretLeak('ghp_short')).toBeNull();
    });
});

describe('assertRedacted', () => {
    it('passes clean text', () => {
        expect(() => assertRedacted('ledger', 'generation 2, 4 entries')).not.toThrow();
    });

    it('throws a RedactionError whose message never echoes the secret', () => {
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
    it('replaces secret-shaped material with a labelled placeholder', () => {
        expect(redact(`token=${CLASSIC_TOKEN}`)).toBe('token=[redacted:github-token-classic]');
    });

    it('replaces every token in a string, not just the first', () => {
        const second = `ghp_${'z'.repeat(TOKEN_BODY)}`;
        const redacted = redact(`first=${CLASSIC_TOKEN} second=${second}`);

        expect(redacted).toBe('first=[redacted:github-token-classic] second=[redacted:github-token-classic]');
        expect(redacted).not.toContain(CLASSIC_TOKEN);
        expect(redacted).not.toContain(second);
    });

    it('replaces every bearer credential in a string, not just the first', () => {
        const first = `Bearer ${'c'.repeat(TOKEN_BODY)}`;
        const second = `Bearer ${'d'.repeat(TOKEN_BODY)}`;
        const redacted = redact(`${first} then ${second}`);
        const placeholders = redacted.split('[redacted:bearer-credential]');

        expect(placeholders).toHaveLength(3);
        expect(redacted).not.toContain('cccc');
        expect(redacted).not.toContain('dddd');
    });

    it('keeps clean text unchanged', () => {
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
    it('drops credential-named keys regardless of case', () => {
        const stripped = stripCredentialKeys({
            token: CLASSIC_TOKEN,
            pat: CLASSIC_TOKEN,
            password: 'hunter2',
            secret: 'x',
            apiKey: 'y',
            login: 'mecha-bot',
            count: 3,
        });

        expect(stripped).toEqual({ login: 'mecha-bot', count: 3 });
    });

    it('keeps an unrelated key whose name merely contains a credential word', () => {
        expect(stripCredentialKeys({ tokenCount: 2 })).toEqual({ tokenCount: 2 });
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
