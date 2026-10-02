/**
 * The Accounts tab's working state (005 FR-060, FR-064–FR-066).
 *
 * The account *list* lives with the bindings it is read alongside
 * (`BindingsTabState.accounts`, because the two are fetched by one read);
 * this module holds only what the Accounts tab is **doing** to a row — which
 * one is open, which two-step control is armed, and the display-name draft —
 * so the data the service owns and the operator's in-progress actions never
 * share a type.
 *
 * It is its own module rather than another slice of `panel-state.ts` for the
 * same reason `dispatch-page.ts` is one: the shared state module is at its
 * file-length cap, and a tab's working state with its own constructor is a
 * single responsibility.
 */

/** The Accounts tab's working state (005 FR-060, FR-064–FR-066). */
export interface AccountsTabState {
    /** The row the operator selected (numeric id), or `null`. */
    selected: string | null;
    /** The row whose display-name field is open, or `null` (FR-066). */
    displayNameRow: string | null;
    /** The display-name field's current text for that row (FR-066). */
    displayNameDraft: string;
    /** The service's refusal for the last display-name write, or `null` (FR-085). */
    displayNameError: string | null;
    /**
     * The row whose Remove-account control is armed (FR-055, FR-065), or
     * `null`.
     *
     * Two-step because `confirm()` does not exist inside the service frame:
     * the first click arms and names the cascade, the second deletes. The arm
     * is per row, so the count the confirm step states is that row's own.
     */
    removeArmed: string | null;
    /** The row whose Rotate-token control is armed (FR-064), or `null`. */
    rotateArmed: string | null;
    /** Operator-facing note for this tab; never credential material. */
    note: string;
}

/**
 * Build the empty Accounts tab working state (005 FR-060, FR-064–FR-066).
 *
 * Nothing here survives as data the service owns: the list, the display
 * names, and the lifecycle states come back from `GET /v1/accounts` on every
 * read, and this slice only says which row the operator has in hand.
 *
 * @returns The state before the first read.
 */
export function initialAccounts(): AccountsTabState {
    return {
        selected: null,
        displayNameRow: null,
        displayNameDraft: '',
        displayNameError: null,
        removeArmed: null,
        rotateArmed: null,
        note: '',
    };
}
