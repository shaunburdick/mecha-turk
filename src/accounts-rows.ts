/**
 * The Accounts tab's rows and the selected account's detail (005 FR-062–FR-069).
 *
 * A row is where the operator finds out *whether an account can poll*, so it
 * carries every member FR-062 names — display name (falling back to the
 * login), login, numeric id, lifecycle state, connection state, last
 * verified stamp, the four-capability scope matrix, the error reason when the
 * state is `error`, and how many bindings the account backs — as **text**, so
 * a state is never carried by colour alone (FR-083).
 *
 * Three rules live here rather than at the call site, because a second place
 * they could be got wrong is a second chance to violate them:
 *
 * - **First-class bad states** (FR-063): `rejected`, `revoked`, and `error`
 *   each render their own words plus a remediation, and `pending_handoff` is
 *   told apart from `error` + `interrupted-handoff` while the two share one
 *   remediation line (FR-068) — an operator who has connected something and
 *   has not is never left guessing which of the two they are looking at.
 * - **Nothing credential-shaped** (FR-067, FR-069): the DTO is credential-free
 *   by construction and this module renders strings only — no token, no
 *   scope edit, no read-back.
 * - **Unknown is unknown** (FR-003): a member the DTO did not carry reads
 *   *not reported*, never a plausible default; a state outside the six reads
 *   `unknown state: <raw>` rather than being mapped to a friendly guess.
 *
 * Everything here is a pure function of panel state, so the copy is testable
 * without a DOM.
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { elapsedSince } from './bindings-rows.ts';
import type { BindingsTabState } from './panel-state.ts';
import type { PanelAccount } from './bindings-service.ts';

/**
 * The remediation `pending_handoff` and `error` + `interrupted-handoff` share.
 *
 * FR-068 requires the two states to be distinguishable *and* to offer the
 * same way out, so this line is one constant rather than two spellings.
 */
export const HANDOFF_REMEDIATION = 'Complete or replace the handoff to finish connecting this account.';

/** What one lifecycle state reads as: its words and the way out of it. */
interface LifecycleCopy {
    /** The words the row shows for the state. */
    readonly label: string;
    /** The remediation line, or `null` when the state needs none. */
    readonly remediation: string | null;
}

/**
 * The six lifecycle states FR-062 names, each with its remediation.
 *
 * A `Map` rather than an object literal: the keys are the service's own
 * snake_case vocabulary, and a literal would have to be written against a
 * naming rule it does not choose.
 */
const LIFECYCLE_COPY = new Map<string, LifecycleCopy>([
    ['pending_handoff', { label: 'pending handoff', remediation: HANDOFF_REMEDIATION }],
    ['verifying', { label: 'verifying', remediation: null }],
    ['active', { label: 'active', remediation: null }],
    ['rejected', { label: 'rejected', remediation: 'Rotate the token: this credential was not accepted.' }],
    ['revoked', { label: 'revoked', remediation: 'Rotate the token: this credential was revoked on GitHub.' }],
    ['error', { label: 'error', remediation: 'Rotate the token, or remove the account once nothing needs it.' }],
]);

/** Why an account was stopped short of polling, for the cause line (FR-063). */
const INTERRUPTED_HANDOFF = 'interrupted-handoff';

/** Words for a connection state the DTO did not carry (NFR-112). */
const CONNECTION_UNREPORTED = 'connection not reported';

/** Words for a lifecycle state the DTO did not carry (NFR-112). */
const LIFECYCLE_UNREPORTED = 'state not reported';

/** Words for a verification stamp the DTO did not carry (NFR-112). */
const VERIFIED_UNREPORTED = 'last verified: not reported';

/** Words for a scope matrix the DTO did not carry (FR-010, NFR-112). */
const SCOPE_UNCHECKED = 'scope: not checked';

/** Order the four FR-010 capabilities render in, so two rows read alike. */
const SCOPE_ORDER = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/**
 * Read the label an account row leads with (FR-066).
 *
 * The operator's display name wins when there is one and the GitHub login
 * takes over when there is not, because a name the operator chose is the
 * label they recognise — and the login is still rendered beside it, since
 * `displayName` never becomes identity.
 *
 * @param account - One credential-free account.
 * @returns The title text, verbatim (it renders as text, never as markup).
 */
export function accountTitle(account: PanelAccount): string {
    return account.displayName ?? account.login;
}

/**
 * Read one lifecycle state's words and remediation (FR-063, FR-068).
 *
 * @param account - One credential-free account.
 * @returns The copy to render for its `state`.
 */
export function lifecycleCopy(account: PanelAccount): LifecycleCopy {
    const { state } = account;
    if (state === undefined) {
        return { label: LIFECYCLE_UNREPORTED, remediation: null };
    }

    if (state === 'error' && account.errorReason === INTERRUPTED_HANDOFF) {
        // The same way out as `pending_handoff`, but its own words: an
        // operator must be able to tell the two apart (FR-068).
        return { label: `error (${INTERRUPTED_HANDOFF})`, remediation: HANDOFF_REMEDIATION };
    }

    return LIFECYCLE_COPY.get(state) ?? { label: `unknown state: ${state}`, remediation: null };
}

/**
 * Read one connection state's words (FR-062, NFR-112).
 *
 * @param account - One credential-free account.
 * @returns The connection phrase, including an unreported or unknown one.
 */
export function connectionPhrase(account: PanelAccount): string {
    const { connectionState } = account;
    if (connectionState === undefined) {
        return CONNECTION_UNREPORTED;
    }

    switch (connectionState) {
        case 'connected':
        case 'auth-failed':
        case 'rate-limited':
        case 'offline':
            return connectionState;
        default:
            return `unknown connection state: ${connectionState}`;
    }
}

/**
 * Read the last-verified stamp as elapsed time (FR-062).
 *
 * @param account - One credential-free account.
 * @returns `last verified <when>`, or the not-reported words when absent.
 */
export function verifiedPhrase(account: PanelAccount): string {
    if (account.verifiedAt === undefined) {
        return VERIFIED_UNREPORTED;
    }

    return `last verified ${elapsedSince(account.verifiedAt)}`;
}

/**
 * Read the four-capability scope matrix as one line (FR-062, FR-010).
 *
 * A matrix the DTO did not carry reads *not checked* — never *ok*: an
 * absent matrix is no evidence, and no evidence is not a pass (FR-003).
 *
 * @param account - One credential-free account.
 * @returns The scope phrase.
 */
export function scopePhrase(account: PanelAccount): string {
    const matrix = account.scopeMatrix;
    if (matrix === undefined) {
        return SCOPE_UNCHECKED;
    }

    const verdicts = SCOPE_ORDER.map((capability) => `${capability} ${matrix[capability]}`);

    return `scope: ${verdicts.join(' · ')}`;
}

/**
 * Count the bindings one account backs (FR-062).
 *
 * @param bindings - The Bindings tab's state, which holds the stored list.
 * @param account - The account being counted.
 * @returns How many stored bindings name this account's numeric id.
 */
export function bindingsBacked(bindings: BindingsTabState, account: PanelAccount): number {
    return bindings.bindings.filter(
        (binding) => binding.accountNumericUserId === account.numericUserId,
    ).length;
}

/**
 * Compose one account row (FR-062, FR-083).
 *
 * @param bindings - The Bindings tab's state, for the binding count.
 * @param account - The account to render.
 * @returns The list row, with every FR-062 member in the subtitle.
 */
export function accountRow(bindings: BindingsTabState, account: PanelAccount): ListItem {
    const lifecycle = lifecycleCopy(account);
    const parts = [
        `@${account.login}`,
        `id ${account.numericUserId}`,
        lifecycle.label,
        connectionPhrase(account),
        verifiedPhrase(account),
        scopePhrase(account),
    ];
    if (account.state === 'error' && typeof account.errorReason === 'string') {
        parts.push(`error: ${account.errorReason}`);
    }

    parts.push(`${bindingsBacked(bindings, account)} bindings`);

    return {
        id: account.numericUserId,
        leading: lifecycle.label,
        title: accountTitle(account),
        subtitle: parts.join(' · '),
        meta: String(bindingsBacked(bindings, account)),
    };
}

/**
 * Build the account list rows (FR-062).
 *
 * @param bindings - The Bindings tab's state, which holds accounts and bindings.
 * @returns The rows, in stored order.
 */
export function accountRows(bindings: BindingsTabState): ListItem[] {
    return bindings.accounts.map((account) => accountRow(bindings, account));
}

/**
 * Compose one account's own line, with its remediation (FR-063).
 *
 * The remediation is what separates a first-class bad state from a badge:
 * `rejected`, `revoked`, `error`, and `pending_handoff` each say what to do
 * next, and an account that is fine says nothing at all rather than
 * reassuring the operator (NFR-112).
 *
 * @param bindings - The Bindings tab's state, for the binding count.
 * @param account - The account to describe.
 * @returns The detail line.
 */
export function accountDetail(bindings: BindingsTabState, account: PanelAccount): string {
    const lifecycle = lifecycleCopy(account);
    const parts = [
        `${accountTitle(account)} (@${account.login}, id ${account.numericUserId})`,
        lifecycle.label,
        connectionPhrase(account),
        verifiedPhrase(account),
        scopePhrase(account),
        `${bindingsBacked(bindings, account)} bindings`,
    ];
    if (account.state === 'error' && typeof account.errorReason === 'string') {
        parts.push(`error: ${account.errorReason}`);
    }
    if (lifecycle.remediation !== null) {
        parts.push(`remediation: ${lifecycle.remediation}`);
    }

    return parts.join(' · ');
}
