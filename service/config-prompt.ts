/**
 * The global prompt tier's rule on the configuration surface (004 FR-081,
 * FR-083; 006 FR-040, FR-041).
 */

import { validateStartingPrompt } from './prompt.ts';
import type { ConfigIssue } from './config.ts';

/**
 * Check the global prompt tier against the one validator all three tiers
 * share.
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
