/**
 * The Accounts tab's writes (005 FR-064, FR-065, FR-066).
 *
 * Three operations, each shaped by a rule that must not be re-derived at the
 * call site:
 *
 * - **Removal is two-step and states its cascade first** (FR-055): arming
 *   changes nothing but the arm; the confirmed delete sends `?force=1`, which
 *   is what makes the service's hardened guard disable the account's bindings
 *   (`state: 'disabled'`, one audit row each) instead of refusing — and the
 *   panel renders exactly that outcome, never a deletion (FR-065).
 * - **Rotation retains everything** (FR-064): the panel sends the existing
 *   token-replacement operation and states the retention *before* the paste;
 *   nothing about the account's history is touched by this side of the wire.
 * - **The display name is never applied optimistically** (FR-066, FR-085):
 *   a refusal renders at the field with the service's own remediation and the
 *   stored value stays in force; a success is answered with an authoritative
 *   re-read rather than a locally invented value. The account tier's starting
 *   prompt (004 FR-082) follows the identical flow through the **same** write
 *   helper: both members ride the one profile `PUT`, each save carrying only
 *   the member it edits, so neither field can clobber the other.
 *
 * The module imports neither the SDK nor the DOM: every control these actions
 * drive is painted from state by [`accounts-tab.ts`](./accounts-tab.ts).
 */

import { loadBindings, stillMounted } from './bindings.ts';
import { removeAccountMirror } from './account-mirror.ts';
import { redact } from './redaction.ts';
import { refresh } from './panel-ui.ts';
import { accountProfilePath, accountRemovePath, serviceDelete, servicePut } from './service-calls.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import type { AccountMember } from './accounts-state.ts';
import { memberRow, setMemberEdit, setMemberRefusal } from './accounts-state.ts';
import type { PanelRuntime, AccountsTabState } from './panel-state.ts';

/** What a removal with a forced cascade answers when the service still refuses. */
const BINDINGS_REFUSAL =
    'The service refused: bindings still reference this account — remove them first.';

/** What the note says when nothing is selected to remove. */
const NOTHING_SELECTED = 'Select the account to remove first.';

/**
 * Record one working-state patch the Accounts body just made (FR-066).
 *
 * A field's draft is working state, not data: it is loaded when a row opens
 * and written only through the profile write, so a repaint that lands
 * mid-edit cannot make the field disagree with what a save would send.
 *
 * @param rt - Panel runtime.
 * @param patch - The fields to update.
 */
export function editAccounts(rt: PanelRuntime, patch: Partial<AccountsTabState>): void {
    if (rt.disposed) {
        return;
    }

    Object.assign(rt.state.accounts, patch);
    refresh(rt);
}

/**
 * Arm the Remove-account control for one row (FR-055).
 *
 * The first click changes no data: it only puts the cascade statement on the
 * row, so the count the operator reads is the count the delete will act on.
 *
 * @param rt - Panel runtime.
 * @param numericUserId - GitHub numeric user id of the row being armed.
 */
export function armAccountRemoval(rt: PanelRuntime, numericUserId: string): void {
    if (rt.disposed) {
        return;
    }

    if (rt.state.accounts.removeArmed !== numericUserId) {
        rt.state.accounts.removeArmed = numericUserId;
    }

    refresh(rt);
}

/**
 * Delete the armed account and leave its bindings disabled (FR-065, AC-127).
 *
 * Runs only after {@link armAccountRemoval} has stated the cascade; the
 * `force=1` query is that statement's confirmation, not a bypass of the
 * service's guard (see `accountRemovePath`). A refusal renders its own copy
 * and changes nothing — the account and every binding stay as they were.
 *
 * @param rt - Panel runtime.
 * @param numericUserId - GitHub numeric user id of the account to delete.
 */
export async function removeAccount(rt: PanelRuntime, numericUserId: string): Promise<void> {
    const { accounts, bindings } = rt.state;
    accounts.removeArmed = null;
    const target =
        bindings.accounts.find((candidate) => candidate.numericUserId === numericUserId) ?? null;
    if (target === null) {
        accounts.note = NOTHING_SELECTED;
        refresh(rt);

        return;
    }

    const result = await serviceDelete({
        serviceRequest: rt.host.serviceRequest,
        path: accountRemovePath(numericUserId),
    });
    if (rt.disposed) {
        return;
    }

    if (!result.ok) {
        accounts.note =
            result.code === 'invalid-transition'
                ? BINDINGS_REFUSAL
                : redact(`The service refused the account removal: ${result.problem}`);
        refresh(rt);

        return;
    }

    await removeAccountMirror(rt, numericUserId);
    if (!stillMounted(rt)) {
        return;
    }

    if (rt.state.handoff.connected?.numericUserId === numericUserId) {
        rt.state.handoff.connected = null;
    }

    if (accounts.selected === numericUserId) {
        accounts.selected = null;
        // Both drafts belonged to the row that just left the list; either one
        // surviving would be written to whatever account opens next (FR-066,
        // 004 FR-089).
        setMemberEdit({ accounts, member: 'displayName', row: null, value: '' });
        setMemberEdit({ accounts, member: 'startingPrompt', row: null, value: '' });
    }

    accounts.note = `Removed the account ${target.login} from the service.`;
    refresh(rt);
    // Re-read so the list loses the removed row *and* the bindings it backed
    // come back from the service in the state the guard actually wrote.
    await loadBindings(rt);
}

/**
 * Arm — or disarm — the Rotate-token control for one row (FR-064).
 *
 * The arm is what makes the paste field above the list a rotation rather than
 * a second account: {@link `handoff.ts`} reads it to pick the route, and the
 * armed row carries the retention statement until the operator completes or
 * cancels it. Clicking the armed control again cancels without sending.
 *
 * @param rt - Panel runtime.
 * @param numericUserId - GitHub numeric user id of the row being armed.
 */
export function toggleRotation(rt: PanelRuntime, numericUserId: string): void {
    if (rt.disposed) {
        return;
    }

    const { accounts } = rt.state;
    if (accounts.rotateArmed === numericUserId) {
        accounts.rotateArmed = null;
        accounts.note = 'Rotation cancelled — nothing was sent.';
    } else {
        accounts.rotateArmed = numericUserId;
        accounts.note = '';
    }

    refresh(rt);
}

/** How each editable member reads in the copy a save reports (FR-066, FR-082). */
const MEMBER_COPY: Readonly<Record<AccountMember, {
    /** What the member is called in a success note. */
    readonly title: string;
    /** What it is called in the open-row guard's remediation. */
    readonly noun: string;
}>> = {
    displayName: { title: 'Display name', noun: 'display name' },
    startingPrompt: { title: 'Starting prompt', noun: 'starting prompt' },
};

/**
 * Put one member to the account profile write (004 FR-082, 005 FR-066).
 *
 * One route for both members, and this save's body names **only** the member
 * being edited — `{ displayName }` or `{ startingPrompt }`. An absent member
 * means unchanged, so neither field can clobber the other, and no per-member
 * endpoint exists to be retired (005 v1.10.0).
 *
 * @param input - The runtime, the member, its row, and the text submitted.
 * @returns The service's own answer for that one write.
 */
async function putProfileMember(input: {
    /** Runtime whose host surface the write runs on. */
    readonly rt: PanelRuntime;
    /** Which profile member this save carries. */
    readonly member: AccountMember;
    /** GitHub numeric user id of the row being edited. */
    readonly numericUserId: string;
    /** The text submitted for that member. */
    readonly value: string;
}): Promise<ServiceErrorResult> {
    return await servicePut({
        serviceRequest: input.rt.host.serviceRequest,
        path: accountProfilePath(input.numericUserId),
        body: JSON.stringify(
            input.member === 'displayName'
                ? { displayName: input.value }
                : { startingPrompt: input.value },
        ),
    });
}

/**
 * Write **one** member of one account's profile — the Accounts tab's single
 * profile-write helper (004 FR-082, 005 FR-066, contract
 * `account-display-name.md` §2).
 *
 * The label's save and the account tier's save are the same operation with a
 * different member, so both land here. The service is the only validator
 * (004 plan D24): nothing in this helper checks the value, so a refusal is
 * always the service's own, rendered at the field it was answered for,
 * verbatim with its remediation and **without** the submitted value (FR-085).
 * The draft stays exactly as typed and the stored member stays in force; a
 * success is confirmed by re-reading the list — the service is the authority
 * on what it stored, and the panel never paints a value it invented.
 *
 * @param rt - Panel runtime.
 * @param input - The member being edited, its row, and the text submitted.
 */
async function saveProfileMember(
    rt: PanelRuntime,
    input: { readonly member: AccountMember; readonly numericUserId: string; readonly value: string },
): Promise<void> {
    const { accounts, bindings } = rt.state;
    const copy = MEMBER_COPY[input.member];
    // The draft may only be written for the row it was loaded for: a field
    // that outlived a selection would edit the wrong account.
    if (
        memberRow(accounts, input.member) !== input.numericUserId
        || accounts.selected !== input.numericUserId
    ) {
        setMemberRefusal({
            accounts,
            member: input.member,
            message: `Select the account again before saving its ${copy.noun}.`,
        });
        refresh(rt);

        return;
    }

    const target =
        bindings.accounts.find((candidate) => candidate.numericUserId === input.numericUserId) ?? null;
    const answer = await putProfileMember({ rt, ...input });
    if (rt.disposed) {
        return;
    }

    if (!answer.ok) {
        setMemberRefusal({
            accounts,
            member: input.member,
            message: redact(answer.message ?? `The service refused: ${answer.problem}`),
        });
        refresh(rt);

        return;
    }

    setMemberRefusal({ accounts, member: input.member, message: null });
    accounts.note =
        target === null ? `${copy.title} saved.` : `${copy.title} saved for ${target.login}.`;
    refresh(rt);
    await loadBindings(rt);
}

/**
 * Write one account's display name through the profile write (FR-066, AC-130).
 *
 * @param rt - Panel runtime.
 * @param input - The row being labelled and the text submitted for it.
 * @returns The shared write's completion — resolved only after the re-read.
 */
export async function saveDisplayName(
    rt: PanelRuntime,
    input: { readonly numericUserId: string; readonly value: string },
): Promise<void> {
    return await saveProfileMember(rt, { ...input, member: 'displayName' });
}

/**
 * Write one account's account-tier starting prompt through the profile write
 * (004 FR-082, FR-089; contract `account-display-name.md` §3).
 *
 * @param rt - Panel runtime.
 * @param input - The row being prompted and the text submitted for it.
 * @returns The shared write's completion — resolved only after the re-read.
 */
export async function saveStartingPrompt(
    rt: PanelRuntime,
    input: { readonly numericUserId: string; readonly value: string },
): Promise<void> {
    return await saveProfileMember(rt, { ...input, member: 'startingPrompt' });
}
