/**
 * The Accounts tab's working state (005 FR-060, FR-064–FR-066; 004 FR-089):
 * the open row, the armed two-step control, and each editable member's draft —
 * the data the service owns and the operator's in-progress actions never
 * share a type.
 */

/** The two operator-editable members of an account record (005 FR-066, 004 FR-082). */
export type AccountMember = 'displayName' | 'startingPrompt';

/**
 * Every member the profile write accepts, in the order the fields mount: one
 * route carries them (`PUT /v1/accounts/:numericUserId`, absent member =
 * unchanged), so a loop over this list is how the tab paints, mounts, and
 * disposes both fields without a second copy of either.
 */
export const PROFILE_MEMBERS: readonly AccountMember[] = ['displayName', 'startingPrompt'];

/**
 * Callbacks the mounted Accounts body invokes: the body paints state and
 * calls back, and every one of these ends in an action `accounts-actions.ts`
 * owns — so the contract sits beside the state it edits rather than with the
 * mount that happens to wire it.
 */
export interface AccountsHandlers {
    readonly selectAccount: (id: string) => void;
    readonly refresh: () => void;
    readonly setDisplayName: (value: string) => void;
    readonly setStartingPrompt: (value: string) => void;
    /**
     * The operator saved the profile — **both** members in one write. One
     * control writes both fields because the product owner ruled it so
     * ("One Save button, both fields", PR #12): the two *inputs* stay
     * separate per member, only the save is shared, and the service's
     * one-pass refusal is split back into the member slots by field name.
     */
    readonly submitProfile: () => void;
    readonly rotateToken: () => void;
    readonly removeAccount: () => void;
}

/** The Accounts tab's working state (005 FR-060, FR-064–FR-066). */
export interface AccountsTabState {
    selected: string | null;
    displayNameRow: string | null;
    /** The display-name field's current text for that row (FR-066). */
    displayNameDraft: string;
    /** The service's refusal for the last display-name write, or `null` (FR-085). */
    displayNameError: string | null;
    startingPromptRow: string | null;
    /** The starting-prompt field's current text for that row (004 FR-089). */
    startingPromptDraft: string;
    /** The service's refusal for the last prompt write, or `null` (004 FR-085). */
    startingPromptError: string | null;
    /**
     * The row whose Remove-account control is armed, or `null`. Two-step
     * because `confirm()` does not exist inside the service frame: the first
     * click arms and names the cascade, the second deletes — and the arm is
     * per row, so the count the confirm step states is that row's own.
     */
    removeArmed: string | null;
    rotateArmed: string | null;
    /** Operator-facing note for this tab; never credential material. */
    note: string;
}

/**
 * Where each member keeps its open row, its draft, and its refusal: one
 * mapping rather than three hand-written branches per call site — the pairing
 * is the invariant, and `AccountMember` above is what makes an unknown member
 * unrepresentable.
 */
const MEMBER_SLOTS = {
    displayName: { row: 'displayNameRow', draft: 'displayNameDraft', refusal: 'displayNameError' },
    startingPrompt: {
        row: 'startingPromptRow',
        draft: 'startingPromptDraft',
        refusal: 'startingPromptError',
    },
} as const;

/**
 * The row one member's field is open on — its own open-row guard (FR-066, 004
 * FR-089). The guard is what stops a draft that outlived a selection from
 * being written to the wrong account: a save may only land when this row and
 * the selected row are one and the same. The numeric id of the row the field
 * was loaded for, or `null`.
 */
export function memberRow(accounts: AccountsTabState, member: AccountMember): string | null {
    return accounts[MEMBER_SLOTS[member].row];
}

/**
 * Read the text one member's field currently holds.
 */
export function memberDraft(accounts: AccountsTabState, member: AccountMember): string {
    return accounts[MEMBER_SLOTS[member].draft];
}

/**
 * Read the service's refusal last rendered on one member's field.
 *
 * @returns The service's own copy, or `null` when nothing was refused.
 */
export function memberRefusal(accounts: AccountsTabState, member: AccountMember): string | null {
    return accounts[MEMBER_SLOTS[member].refusal];
}

/**
 * Render a service refusal on one member's field — or the clear that retires
 * it once the next write lands.
 *
 * The refusal belongs to the field it was answered for: a prompt that could
 * paint itself onto the label's slot would report the wrong field's failure.
 */
export function setMemberRefusal(input: {
    readonly accounts: AccountsTabState;
    readonly member: AccountMember;
    readonly message: string | null;
}): void {
    input.accounts[MEMBER_SLOTS[input.member].refusal] = input.message;
}

/**
 * Point one member's field at a row and load its text from that row (FR-066,
 * 004 FR-089). Selection loads both members from the account the operator
 * opened; removal of that account clears both, because a draft that outlived
 * its row would label — or prompt — whatever account is opened next.
 */
export function setMemberEdit(input: {
    readonly accounts: AccountsTabState;
    readonly member: AccountMember;
    readonly row: string | null;
    readonly value: string;
}): void {
    const slots = MEMBER_SLOTS[input.member];
    input.accounts[slots.row] = input.row;
    input.accounts[slots.draft] = input.value;
    input.accounts[slots.refusal] = null;
}

/**
 * Build the empty Accounts tab working state. Nothing here survives as data
 * the service owns: the list, the display names, the prompts, and the
 * lifecycle states come back from `GET /v1/accounts` on every read, and this
 * slice only says which row the operator has in hand. The state before the
 * first read.
 */
export function initialAccounts(): AccountsTabState {
    return {
        selected: null,
        displayNameRow: null,
        displayNameDraft: '',
        displayNameError: null,
        startingPromptRow: null,
        startingPromptDraft: '',
        startingPromptError: null,
        removeArmed: null,
        rotateArmed: null,
        note: '',
    };
}
