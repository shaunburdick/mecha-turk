import { describe, expect, it } from 'vitest';
import type { GitHubIssue } from '../src/github.ts';
import { checkMachineIdentity, evaluateIssue, sweepIssues } from '../src/matching.ts';

/** Login used as the authenticated machine account across these tests. */
const MACHINE = 'mecha-bot';

/** Number used for the issue under test. */
const ISSUE_NO = 7;

/**
 * Build a normalised issue with sensible defaults for the rule tests.
 *
 * @param overrides - Fields to change from the default matching issue.
 * @returns A normalised issue.
 */
function matchingIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
        issueNumber: ISSUE_NO,
        title: 'Fix the flaky test',
        url: 'https://github.com/acme/widget/issues/7',
        state: 'open',
        body: null,
        assignees: [MACHINE],
        isPullRequest: false,
        ...overrides,
    };
}

describe('evaluateIssue', () => {
    it('accepts an open issue assigned to the machine account', () => {
        expect(evaluateIssue(matchingIssue(), MACHINE)).toEqual({
            matched: true,
            reason: 'assigned-to-machine-account',
            issueNumber: ISSUE_NO,
        });
    });

    it('compares logins case-insensitively', () => {
        const decision = evaluateIssue(matchingIssue({ assignees: ['Mecha-Bot'] }), 'MECHA-BOT');
        expect(decision).toMatchObject({ matched: true });
    });

    it('rejects pull requests before looking at assignment', () => {
        const decision = evaluateIssue(matchingIssue({ isPullRequest: true }), MACHINE);
        expect(decision).toEqual({
            matched: false,
            reason: 'isPullRequest',
            issueNumber: ISSUE_NO,
        });
    });

    it('rejects issues that are no longer open', () => {
        expect(evaluateIssue(matchingIssue({ state: 'closed' }), MACHINE)).toMatchObject({ reason: 'notOpen' });
    });

    it('rejects issues assigned to somebody else', () => {
        const decision = evaluateIssue(matchingIssue({ assignees: ['someone-else'] }), MACHINE);
        expect(decision).toMatchObject({ reason: 'notAssigned' });
    });

    it('rejects issues with no assignees', () => {
        expect(evaluateIssue(matchingIssue({ assignees: [] }), MACHINE)).toMatchObject({ matched: false });
    });
});

describe('sweepIssues', () => {
    it('collects the single match and counts every rejection', () => {
        const issues = [
            matchingIssue(),
            matchingIssue({ issueNumber: ISSUE_NO + 1, assignees: ['someone-else'] }),
            matchingIssue({ issueNumber: ISSUE_NO + 2, state: 'closed' }),
            matchingIssue({ issueNumber: ISSUE_NO + 3, isPullRequest: true }),
        ];

        const sweep = sweepIssues(issues, MACHINE);

        expect(sweep.inspected).toBe(4);
        expect(sweep.matches).toHaveLength(1);
        expect(sweep.matches[0]?.issueNumber).toBe(ISSUE_NO);
        expect(sweep.rejected).toEqual({ notOpen: 1, isPullRequest: 1, notAssigned: 1 });
    });

    it('returns no matches for an empty window', () => {
        const sweep = sweepIssues([], MACHINE);

        expect(sweep.matches).toEqual([]);
        expect(sweep.inspected).toBe(0);
    });
});

describe('checkMachineIdentity', () => {
    it('accepts any login when no expectation is configured', () => {
        expect(checkMachineIdentity(MACHINE, null)).toEqual({ ok: true });
    });

    it('accepts a matching expectation regardless of case', () => {
        expect(checkMachineIdentity(MACHINE, 'Mecha-Bot')).toEqual({ ok: true });
    });

    it('fails closed when the expectation differs', () => {
        const decision = checkMachineIdentity(MACHINE, 'other-bot');

        expect(decision.ok).toBe(false);
        if (!decision.ok) {
            expect(decision.problem).toContain('does not match');
        }
    });

    it('fails closed when the discovered login is empty', () => {
        expect(checkMachineIdentity('   ', null).ok).toBe(false);
    });
});
