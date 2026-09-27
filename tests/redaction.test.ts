import { describe, expect, it } from 'vitest';
import {
    assertRedacted,
    findSecretLeak,
    redact,
    stripCredentialKeys,
    RedactionError,
} from '../extension/src/redaction.ts';

/** Length a token body needs before the patterns treat it as real material. */
const TOKEN_BODY = 40;

/** A classic GitHub personal access token shape. */
const CLASSIC_TOKEN = `ghp_${'a'.repeat(TOKEN_BODY)}`;

/** A fine-grained GitHub personal access token shape. */
const FINE_GRAINED_TOKEN = `github_pat_${'b'.repeat(TOKEN_BODY)}`;

/** An Authorization header spelling that must never be persisted. */
const AUTH_HEADER = 'Authorization: Bearer 0123456789abcdef0123456789abcdef';

describe('findSecretLeak', () => {
    it('detects a classic GitHub token', () => {
        expect(findSecretLeak(`the value is ${CLASSIC_TOKEN} in transit`)).toBe('github-token-classic');
    });

    it('detects a fine-grained GitHub token', () => {
        expect(findSecretLeak(FINE_GRAINED_TOKEN)).toBe('github-token-fine-grained');
    });

    it('detects an Authorization header', () => {
        expect(findSecretLeak(AUTH_HEADER)).toBe('authorization-header');
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

    it('keeps clean text unchanged', () => {
        expect(redact('issue #7 assigned')).toBe('issue #7 assigned');
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
