/**
 * The global prompt tier's **rule** on the configuration surface (004 FR-081,
 * FR-083; 006 FR-040, FR-041).
 *
 * Split out of [`config.ts`](./config.ts) for the same reason
 * [`config-agent.ts`](./config-agent.ts) was: that file owns the document —
 * types, defaults, assembly, and the store read — and this one owns the one
 * rule the prompt tier is checked against at *its* save boundary. There is
 * still exactly one rule set: the checking below is a call into the shipped
 * [`validateStartingPrompt`](./prompt.ts), never a second implementation, so
 * the bindings write, the configuration write, and the account profile write
 * cannot drift apart (004 FR-083 — one validator, three call sites).
 *
 * Two things this wrapper adds to the shared rule, both on the
 * configuration surface's own terms:
 *
 * - **Absence is a refusal.** The shared validator reads an absent or `null`
 *   member as *unset* — which is right for a binding or an account record,
 *   where absence is a complete state — but `PUT /v1/config` is a
 *   whole-document replacement, so an absent or non-string member is refused
 *   like any other missing or mistyped field (006 FR-041).
 * - **The voice is this surface's.** The shared rule already reports under
 *   `field: 'startingPrompt'` and never echoes the submission; the one
 *   remediation added here (for a non-string member) names the *configuration*
 *   spelling of "unset" — the empty string — rather than the bindings'
 *   absent-or-null one.
 *
 * Nothing in this module quotes the submitted value: an issue is built from
 * the declaration alone, so a `422` can never become a reflection oracle for a
 * pasted instruction (004 FR-003, AC-133).
 */

import { validateStartingPrompt } from './prompt.ts';
import type { ConfigIssue } from './config.ts';

/**
 * Check the global prompt tier against the one validator all three tiers
 * share.
 *
 * @returns Zero or one issue, for the additive list `collectIssues`
 *   assembles.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export function startingPromptIssue(value: unknown): readonly ConfigIssue[] {
    if (typeof value !== 'string') {
        return [
            {
                field: 'startingPrompt',
                remediation: 'set startingPrompt to a string; leave it empty for an unset global tier',
            },
        ];
    }

    const verdict = validateStartingPrompt(value);

    return verdict.ok ? [] : [verdict.issue];
}
