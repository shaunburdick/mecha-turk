/**
 * The binding allow-list's rule set (002 FR-047, FR-024; plan D5 – D9).
 */

import type { BindingIssue } from './bindings.ts';

/** Longest value accepted as one GitHub login (002 FR-047, research §R9). */
const GITHUB_LOGIN_MAX_CHARS = 39;

/** The shortest login shape: one alphanumeric character. */
const SINGLE_LOGIN = /^[A-Za-z0-9]$/;

/**
 * A login of two or more characters: alphanumeric at **both** ends, with
 * hyphens permitted between them and never doubled.
 *
 * The two rules are separate on purpose. GitHub issues usernames that are
 * alphanumeric runs joined by *single* interior hyphens, so this pattern
 * carries the ends and `includes('--')` carries the "single" part — which also
 * keeps the matcher free of a nested quantifier over operator-supplied text.
 */
const LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/;

/**
 * The literal suffix GitHub puts on a isBot or App account's login:
 * `dependabot[isBot]` sits outside the published alphabet and is still a
 * login GitHub issues. Plan D7 **accepts** one into the list, where it is
 * inert, and 002 FR-045(c) names the refusal this module deliberately does
 * **not** raise: a isBot actor is refused at **authorization** regardless of
 * what the list says, so the operator learns the entry was meaningless from
 * the dispatch that did not happen rather than from a save error.
 */
const BOT_SUFFIX = '[bot]';

/**
 * Decide whether one value is a GitHub login this field may store.
 *
 * A isBot or App account's `[isBot]` suffix is stripped before the shape is judged,
 * so `dependabot[isBot]` is judged on the part GitHub chose from the published
 * alphabet and the length bound still covers the whole submitted value.
 */
function isGitHubLogin(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }

    const isBot = value.toLowerCase().endsWith(BOT_SUFFIX);
    const spelled = isBot ? value.slice(0, -BOT_SUFFIX.length) : value;
    if (spelled.length === 0 || spelled.length > GITHUB_LOGIN_MAX_CHARS) {
        return false;
    }

    return spelled.length === 1
        ? SINGLE_LOGIN.test(spelled)
        : LOGIN_SHAPE.test(spelled) && !spelled.includes('--');
}

/** Field name every refusal on this member uses. */
const FIELD = 'allowedUsers';

/** Remediation for a value that is not an array of logins. */
const NOT_AN_ARRAY_REMEDIATION = 'allowedUsers must be an array of GitHub logins, or omitted so any human '
    + 'actor may trigger this repository';

/**
 * Remediation for an explicitly empty array — the refusal that has to name
 * **both** honest alternatives, because "nobody" is not one of this field's
 * meanings. Disabling the binding is the way to stop *every*
 * trigger, and `state` already models it, so the sentence says so.
 */
const EMPTY_REMEDIATION = 'allowedUsers must name at least one GitHub login: omit the field to let any human '
    + 'actor may trigger this repository, or list the logins who may; to stop every trigger, disable the binding';

/** Remediation for an element that is not a login GitHub could have issued. */
const NOT_A_LOGIN_REMEDIATION = 'allowedUsers must name GitHub logins: at most 39 characters, '
    + 'alphanumeric with single interior hyphens';

/**
 * Build this field's refusal envelope.
 */
function refuse(remediation: string): { readonly issue: BindingIssue } {
    return { issue: { field: FIELD, remediation } };
}

/**
 * Read one binding's optional actor allow-list. **Exactly three states, and
 * no fourth**: absent (`users: null`), a non-empty list of logins, and the
 * refusal that stands in for `[]`; a bad element is refused once for the
 * whole field, so an operator who typed three logins gets one actionable
 * sentence rather than three. No list-length cap, because boundedness
 * already comes from the per-login bound, the binding-count cap and the
 * transport's own body cap. No issue ever quotes what was submitted; each
 * names the *shape* to send instead.
 */
export function bindingAllowedUsersOf(raw: Record<string, unknown>): {
    readonly users: readonly string[] | null;
} | { readonly issue: BindingIssue } {
    const value = raw.allowedUsers;
    if (value === undefined) {
        return { users: null };
    }

    if (!Array.isArray(value)) {
        return refuse(NOT_AN_ARRAY_REMEDIATION);
    }

    if (value.length === 0) {
        return refuse(EMPTY_REMEDIATION);
    }

    const users: string[] = [];
    for (const entry of value) {
        if (!isGitHubLogin(entry)) {
            return refuse(NOT_A_LOGIN_REMEDIATION);
        }

        users.push(entry);
    }

    return { users };
}

/**
 * Decide whether one actor may trigger under one binding's allow-list — the
 * one membership comparison in the product, whose only caller is the
 * authorization gate (a source scan in the test suite asserts that).
 * Case-insensitive, because GitHub logins are and only the comparison may
 * fold case. An absent list is the open state, but an empty login is nobody,
 * and the absence of a policy is not permission to attribute work to no one
 * (002 FR-045(b)). Bot-shaping is `isBotAuthor`'s judgement, deliberately not
 * this module's (plan D3, D7).
 */
export function isActorAllowed(login: string, allowedUsers: readonly string[] | undefined): boolean {
    if (login === '') {
        return false;
    }

    if (allowedUsers === undefined) {
        return true;
    }

    const wanted = login.toLowerCase();

    return allowedUsers.some((candidate) => candidate.toLowerCase() === wanted);
}
