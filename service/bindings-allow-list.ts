/**
 * The binding allow-list's rule set (002 FR-047, FR-024; plan D5 – D9).
 *
 * `bindings.ts` owns the record, the refusal envelope, and the whole-file
 * grant. This module owns the one field whose semantics are a **rule about
 * who may act**: which values count as a GitHub login, what the field's three
 * states are, and the single membership comparison that answers "may this
 * actor trigger this repository?". It sits beside the validator for the same
 * reason `events-parse.ts` sits beside `events.ts` — one responsibility per
 * file, and a file that can be read on its own.
 *
 * Three properties of this field are worth stating once, because each of them
 * was a decision rather than a default:
 *
 * - **Absent is a complete state**, meaning *any human actor may trigger*. It
 *   is not "any user" and not "nobody", so the key is omitted from the stored
 *   record rather than written as `[]`, `null`, or `''` (002 FR-047, plan D4 —
 *   omission means unset here, the one rule that differs from `startingPrompt`,
 *   because a login list is enumerable and can always be stated).
 * - **An explicitly empty array is a refusal**, not a third value. It has two
 *   plausible readings and this product never picks one silently, so the
 *   remediation names both honest alternatives and says that *disabling the
 *   binding* is how every trigger stops.
 * - **The stored spelling is the submitted spelling**, byte for byte; only the
 *   comparison folds case, because GitHub logins are case-insensitive (plan
 *   D5). Nothing is lowercased, trimmed, or de-duplicated on the way in, so
 *   `['Alice', 'bob']` reads back exactly as it was written.
 *
 * The list is **configuration, and configuration stays in the store**: it never
 * reaches the audit trail, a run record, a projection, the panel, or either
 * shipped bundle. Only the *shape* of the policy (`'open' | 'restricted'`) is
 * ever reported elsewhere (002 NFR-113). The rule set that decides the value
 * and the one comparison that uses it therefore belong together here, and
 * {@link isActorAllowed} is called by exactly one caller — the service's
 * authorization gate (plan D9).
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
 * The literal suffix GitHub puts on a bot or App account's login.
 *
 * `dependabot[bot]` is syntactically outside the published alphabet and is
 * still a login GitHub issues. Plan D7 **accepts** one into the list, where it
 * is inert, and 002 FR-045(c) names the refusal this module deliberately does
 * **not** raise: a bot actor is refused at **authorization**, so
 * accepting the spelling here cannot grant a bot anything — every trigger kind
 * already filters bots at detection, and the one path that could reach the list
 * with a bot-shaped login refuses it regardless of what the list says. Accepting
 * it is therefore strictly more honest than refusing a value GitHub issued: the
 * operator learns the entry was meaningless from the dispatch that did not
 * happen, not from a save error about a login shape.
 */
const BOT_SUFFIX = '[bot]';

/**
 * Decide whether one value is a GitHub login this field may store.
 *
 * A bot or App account's `[bot]` suffix is stripped before the shape is judged,
 * so `dependabot[bot]` is judged on the part GitHub chose from the published
 * alphabet and the length bound still covers the whole submitted value.
 *
 * @param value - Candidate element.
 * @returns `true` when the value is a login GitHub could have issued.
 */
function isGitHubLogin(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }

    const bot = value.toLowerCase().endsWith(BOT_SUFFIX);
    const spelled = bot ? value.slice(0, -BOT_SUFFIX.length) : value;
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
 *
 * @param remediation - What the operator must send instead, naming the shape.
 * @returns The blocking verdict {@link bindingAllowedUsersOf} returns for it.
 */
function refuse(remediation: string): { readonly issue: BindingIssue } {
    return { issue: { field: FIELD, remediation } };
}

/**
 * Read one binding's optional actor allow-list.
 *
 * **Exactly three states, and no fourth**: absent (`users: null`),
 * a non-empty list of logins, and the refusal that stands in for `[]`. A
 * value that is not an array is refused too, and an element that is not a
 * login is refused **once for the whole field** — an operator who typed three
 * logins gets one actionable sentence, not three near-identical ones. There is
 * deliberately no list-length cap: boundedness is already carried by the
 * per-login bound, the binding-count cap in `bindings.ts`, and the transport's
 * own body cap, and an unnamed refusal is one an operator can hit through no
 * fault of their own.
 *
 * No issue in this set ever quotes what was submitted; every
 * remediation names the *shape* an operator must send instead.
 *
 * @param raw - The candidate record, read for its `allowedUsers` member.
 * @returns The stored list (`null` when unset), or the blocking issue.
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
 * Decide whether one actor may trigger under one binding's allow-list.
 *
 * **The one membership comparison in the product**: the
 * authorization gate calls this and nothing else may, so there is exactly one
 * answer to "may this run start a session?". A source scan in the test suite
 * asserts the identifier appears in exactly two files — this one and the
 * gate's.
 *
 * Case-insensitive, because GitHub logins are case-insensitive and the stored
 * spelling is preserved verbatim; only the comparison folds case.
 *
 * **An absent list is the open state**: no policy is configured, so any human
 * actor may trigger. An empty login is nobody, and the open policy does not
 * turn that into permission — the absence of a policy is not permission to
 * attribute work to no one (002 FR-045(b)). A *bot*-shaped login
 * is a separate judgement this module deliberately does not make: it belongs to
 * the exported `isBotAuthor` beside the detection filters, which every trigger
 * kind already applies before an event is created at all (plan D3, D7).
 *
 * @param login - The attributed actor's login, `''` when unreadable.
 * @param allowedUsers - The binding's stored list, or `undefined` when unset.
 * @returns `true` when the actor may trigger this repository.
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
