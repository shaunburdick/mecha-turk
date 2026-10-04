/**
 * The one string configuration field: its declaration and its validation rule
 * (006 FR-100(c), contract §4).
 *
 * Split out of [`config.ts`](./config.ts) for the same reason
 * [`config-schema.ts`](./config-schema.ts) was: that file owns the document —
 * types, bounds, defaults, assembly, and the store read — and this one owns the
 * single free-text field's *rule*. **One declaration, read twice** is
 * preserved: [`config-schema.ts`](./config-schema.ts) projects
 * {@link EXPECTED_AGENT_RULE} onto the wire and `config.ts` validates against
 * it, so a bound cannot move in one place and not the other (006 FR-020 –
 * FR-022, SC-101).
 *
 * The rule's shape since 006 v1.5.0 / 002 v1.10.0: **empty is a value**. It is
 * the documented *no baseline configured* the product owner ordered — *"Default
 * Agent pin should default to blank, not everyone is going to use
 * project-manager"* — so validation refuses a *missing* member (the
 * whole-document rule is untouched) and accepts a blank one, while every other
 * rule still applies to a non-blank value.
 */

import { findSecretLeak } from '../src/redaction.ts';
import type { ConfigIssue } from './config.ts';

/**
 * The one string field's rule, in the same declaration style as the bounds
 * (006 FR-100(c), contract §4).
 *
 * `format` is the service-authored prose the wire carries as a descriptor's
 * `format` member — rendered as text by the panel, never compiled into a
 * second validator. `pattern` is the validator's own gate: one
 * token of letters, digits, and `. _ - @ : /`, so a pasted credential (or
 * anything containing a space or control character) never reaches the store.
 */
export const EXPECTED_AGENT_RULE = {
    /** Host ceiling for an agent name (002 research §R4, `GUEST_SESSION_AGENT_MAX`). */
    maxLength: 80,
    /**
     * Allowed characters, rendered verbatim on the field's row.
     *
     * The empty value is named because it is a real answer: it means *no
     * baseline configured*, which is the documented default (FR-100(b)(c)).
     */
    format: 'letters, digits, and . _ - @ : / (a single token, no spaces); empty means no baseline',
    /** The charset gate itself; the hyphen sits last so it reads literally. */
    pattern: /^[A-Za-z0-9.@/_:-]+$/,
} as const;

/**
 * Check the one string field against its rule (006 FR-100(c)).
 *
 * The answers arrive in a fixed order — not a string, over the length ceiling,
 * empty (accepted), outside the charset, credential-shaped — and each
 * remediation is built from the declaration, never from the submission, so a
 * `422` can never become a reflection oracle for a pasted token.
 *
 * **Empty is not an error.** An absent or non-string member still is: the
 * whole-document rule (FR-040, FR-041, FR-100(b)) is unchanged, so a `PUT`
 * that leaves the key out is refused while a `PUT` that sends `""` is a
 * deliberate statement that no baseline is configured.
 *
 * @param value - Candidate value as the document carried it.
 * @returns Zero or one issue.
 */
export function expectedAgentIssue(value: unknown): readonly ConfigIssue[] {
    if (typeof value !== 'string') {
        return [
            {
                field: 'expectedAgent',
                remediation: 'set expectedAgent to a string; leave it empty for no baseline',
            },
        ];
    }

    const text = value.trim();

    if (text.length > EXPECTED_AGENT_RULE.maxLength) {
        return [
            {
                field: 'expectedAgent',
                remediation: `set expectedAgent to at most ${EXPECTED_AGENT_RULE.maxLength} characters`,
            },
        ];
    }

    // Empty after trim: the documented *no baseline configured*, so there is
    // nothing to test the charset or the secret shape against (FR-100(c)).
    if (text === '') {
        return [];
    }

    if (!EXPECTED_AGENT_RULE.pattern.test(text)) {
        return [
            {
                field: 'expectedAgent',
                remediation: 'set expectedAgent to letters, digits, and . _ - @ : / with no spaces',
            },
        ];
    }

    if (findSecretLeak(text) !== null) {
        return [{ field: 'expectedAgent', remediation: 'set expectedAgent to an agent name, not a credential' }];
    }

    return [];
}
