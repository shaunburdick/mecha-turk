/**
 * The Bindings tab's working state (M3) and its empty state.
 *
 * Split out of [`panel-state.ts`](./panel-state.ts) for the file-length gate,
 * and for the reason `accounts-state.ts` is its own module too: a tab's working
 * state with its own constructor is a single responsibility, and the shared
 * state module is at its cap. `panel-state.ts` re-exports both names, so no
 * call site had to change with the move.
 *
 * Two kinds of member live here, and the difference is load-bearing. The
 * **service's** lists — the bindings it holds, the accounts it registered, the
 * per-binding scan rows it projects — are replaced wholesale by a read or a
 * grant and never edited in place. The **draft** fields are the operator's
 * in-progress values, which only the actions in `bindings.ts`,
 * `bindings-edit.ts`, and `bindings-mount.ts` write; a save the service refuses
 * leaves them on screen exactly as they were typed (005 FR-019, FR-085).
 *
 * The two operator-authored values — the starting prompt (004 FR-014) and the
 * actor allow-list (002 FR-047) — each keep a text field, a dirty flag, and the
 * service's own field-level refusal, and every reader and writer of such a trio
 * goes through the module that owns the value rather than touching the flag
 * directly.
 */

import type { BindingStatusRow, PanelAccount, PanelBinding } from './bindings-service.ts';

/** Lifecycle of the Bindings tab's data. */
export type BindingsStatus =
    /** Nothing fetched yet. */
    | 'idle'
    /** A GET /v1/bindings or /v1/accounts is in flight. */
    | 'loading'
    /** Both sources answered. */
    | 'ready'
    /** The host or service refused. */
    | 'error';

/** The event-relay loop's runtime state (M4, widened by 003 T-021). */
export interface Relay {
    /** Timer handle while the loop runs. */
    timer: ReturnType<typeof setInterval> | null;
    /** Whether a relay request is in flight. */
    inFlight: boolean;
    /** RFC 3339 stamp of the last completed poll. */
    lastPollAt: string | null;
    /** Whether a dispatch is being processed right now. */
    dispatching: boolean;
    /**
     * Attempts this mount has already handed to the dispatch path (FR-034),
     * keyed `"<correlationId>#<attempt>"`.
     *
     * A duplicate-suppression convenience, never a durability mechanism and
     * never evidence that a session exists: an entry is only ever *added*, and
     * because the key carries the attempt, the service handing the same run
     * back under a new lease and a new attempt arrives as a different key.
     * Nothing clears an entry — least of all a failed result report, which must
     * never on its own authorize a re-dispatch.
     */
    handled: readonly string[];
    /** Last relay error line, else empty. */
    lastError: string | null;
}

/** The Bindings tab's working state (M3). */
export interface BindingsTabState {
    /** Bindings as GET /v1/bindings answered. */
    bindings: readonly PanelBinding[];
    /** Accounts offered to the binding form. */
    accounts: readonly PanelAccount[];
    /** Where the data stands. */
    status: BindingsStatus;
    /** Operator-facing note; never credential material. */
    note: string;
    /** Draft repository input (`owner/name`). */
    repoInput: string;
    /** Draft account selection (numeric id). */
    accountSelection: string | null;
    /** Draft project selection (id the picker confirmed from the host list). */
    repoProjectSelection: string | null;
    /** Draft assignment trigger. */
    triggerAssignment: boolean;
    /** Draft mention trigger (M6 comment and issue-body scan). */
    triggerMention: boolean;
    /** Draft review-request trigger (M7), on by default for a new binding. */
    triggerReviewRequest: boolean;
    /** Draft worktree option. */
    worktreeSelection: 'none' | 'generated';
    /** The row the operator last clicked, for the enable/disable toggle. */
    selectedBinding: string | null;
    /** Last relay status rows rendered per binding. */
    statusRows: readonly BindingStatusRow[];
    /**
     * Whether the binding editor block is on screen at all (2026-10-01 review).
     *
     * The editor is **not open by default**: the tab entry shows the list, a
     * row click loads that row into the editor and opens it, and **New
     * binding** opens an empty one. `false` at mount, and false again after a
     * save, a cancel, or a refusal to load — the list is the surface the
     * operator returns to.
     */
    editorOpen: boolean;
    /**
     * Whether the form is loaded with `selectedBinding` and its primary
     * control **saves** that row instead of adding one (005 FR-050).
     *
     * Set by the row click that loads a binding into the editor (the Edit
     * affordance the post-install review added, now the row itself) and
     * cleared by a save, a cancel, or a refusal to load — so the draft on
     * screen always describes the row the primary control would write, which
     * is what keeps a displayed value and a saved value the same thing.
     */
    editing: boolean;
    /** The starting-prompt editor field's current text (005 FR-051). */
    startingPromptInput: string;
    /**
     * Whether the operator changed that field on this selection (004 FR-014).
     *
     * Untouched means a save **omits** `startingPrompt` entirely, so the
     * service keeps whatever it holds; a change — clearing the field included —
     * means the save carries the value explicitly.
     */
    startingPromptDirty: boolean;
    /** The service's field-level refusal for the prompt, or `null` (FR-052). */
    startingPromptError: string | null;
    /**
     * The allow-list field's current text, one operator-supplied login per
     * entry (005 FR-090).
     *
     * **The only element that ever holds these logins** (005 FR-091): the row
     * summary reduces them to a count, and Status never carries a login at all
     * (005 NFR-113). Free text the operator supplies — there is no identity
     * picker, because the host exposes no such API (005 FR-004).
     */
    allowedUsersInput: string;
    /**
     * Whether the operator changed that field on this selection.
     *
     * Untouched means the save carries **this binding's stored list**, exactly
     * as it is — which, for a binding that has one, is the array; while a change
     * to empty means the key is **omitted** and the binding returns to open
     * (002 FR-047, contract §2: omission means unset here, the one rule that
     * differs from the prompt's).
     */
    allowedUsersDirty: boolean;
    /** The service's field-level refusal for the allow-list, or `null` (FR-095). */
    allowedUsersError: string | null;
}

/**
 * Build the empty Bindings tab state.
 *
 * @returns The state before the first load.
 */
export function initialBindings(): BindingsTabState {
    return {
        bindings: [],
        accounts: [],
        status: 'idle',
        note: '',
        repoInput: '',
        accountSelection: null,
        repoProjectSelection: null,
        triggerAssignment: true,
        triggerMention: false,
        triggerReviewRequest: true,
        worktreeSelection: 'none',
        selectedBinding: null,
        statusRows: [],
        editorOpen: false,
        editing: false,
        startingPromptInput: '',
        startingPromptDirty: false,
        startingPromptError: null,
        allowedUsersInput: '',
        allowedUsersDirty: false,
        allowedUsersError: null,
    };
}
