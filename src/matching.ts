/**
 * The spike's single issue-matching rule.
 *
 * The rule is deliberately narrow: exactly one configured repository, one
 * event class (an open issue assigned to the authenticated machine account),
 * and a fail-closed identity check. Everything else is rejected with a reason
 * so the ledger can explain why an observation did not become work.
 */

import type { GitHubIssue } from './github.ts';

/** Why an issue was accepted as the configured match. */
export type MatchAcceptReason = 'assigned-to-machine-account';

/** Why an issue was rejected. */
export type MatchRejectReason = 'notOpen' | 'isPullRequest' | 'notAssigned';

/** Outcome of applying the matching rule to one issue. */
export type MatchDecision =
    | { readonly matched: true; readonly reason: MatchAcceptReason; readonly issueNumber: number }
    | { readonly matched: false; readonly reason: MatchRejectReason; readonly issueNumber: number | null };

/** Result of validating the PAT identity against the optional expected login. */
export type IdentityDecision = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Validate the authenticated identity against the optional expected login.
 *
 * The PAT identity is authoritative (FR-002): `expectedLogin` is only a
 * validation constraint and never a substitute for the discovered identity.
 *
 * @param authenticatedLogin - Login returned by `GET /user`.
 * @param expectedLogin - Operator-supplied expectation, or `null` when unused.
 * @returns `ok` when the identity may be used, otherwise the blocking problem.
 */
export function checkMachineIdentity(authenticatedLogin: string, expectedLogin: string | null): IdentityDecision {
    if (authenticatedLogin.trim() === '') {
        return { ok: false, problem: 'authenticated login from GET /user was empty' };
    }

    if (expectedLogin === null) {
        return { ok: true };
    }

    if (authenticatedLogin.toLowerCase() !== expectedLogin.toLowerCase()) {
        return {
            ok: false,
            problem: `authenticated login "${authenticatedLogin}" does not match expected login "${expectedLogin}"`,
        };
    }

    return { ok: true };
}

/**
 * Apply the configured-match rule to one issue.
 *
 * The rule accepts an issue when it is open, is not a pull request, and lists
 * the authenticated machine account among its assignees. Logins are compared
 * case-insensitively because GitHub logins are.
 *
 * @param issue - Normalised issue from the repository poll.
 * @param authenticatedLogin - Login returned by `GET /user`.
 * @returns The decision with a reason for the ledger.
 */
export function evaluateIssue(issue: GitHubIssue, authenticatedLogin: string): MatchDecision {
    if (issue.isPullRequest) {
        return { matched: false, reason: 'isPullRequest', issueNumber: issue.issueNumber };
    }

    if (issue.state !== 'open') {
        return { matched: false, reason: 'notOpen', issueNumber: issue.issueNumber };
    }

    const machine = authenticatedLogin.toLowerCase();
    const assigned = issue.assignees.some((login) => login.toLowerCase() === machine);
    if (!assigned) {
        return { matched: false, reason: 'notAssigned', issueNumber: issue.issueNumber };
    }

    return { matched: true, reason: 'assigned-to-machine-account', issueNumber: issue.issueNumber };
}

/** Outcome of applying the rule to a whole poll window. */
export interface MatchSweep {
    /** Issues that satisfied the rule, unsorted, at most one expected. */
    readonly matches: readonly GitHubIssue[];
    /** Rejection counts keyed by {@link MatchRejectReason}. */
    readonly rejected: Readonly<Record<MatchRejectReason, number>>;
    /** Number of issues inspected. */
    readonly inspected: number;
}

/**
 * Apply the matching rule to every issue of one poll window.
 *
 * @param issues - Issues from the repository poll.
 * @param authenticatedLogin - Login returned by `GET /user`.
 * @returns Matches plus rejection counts for the ledger.
 */
export function sweepIssues(issues: readonly GitHubIssue[], authenticatedLogin: string): MatchSweep {
    const matches: GitHubIssue[] = [];
    const rejected: Record<MatchRejectReason, number> = {
        notOpen: 0,
        isPullRequest: 0,
        notAssigned: 0,
    };

    for (const issue of issues) {
        const decision = evaluateIssue(issue, authenticatedLogin);
        if (decision.matched) {
            matches.push(issue);
        } else {
            rejected[decision.reason] += 1;
        }
    }

    return { matches, rejected, inspected: issues.length };
}
