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
 *   re-read rather than a locally invented value.
 *
 * The module imports neither the SDK nor the DOM: every control these actions
 * drive is painted from state by [`accounts-tab.ts`](./accounts-tab.ts).
 */

import { loadBindings, stillMounted } from './bindings.ts';
import { removeAccountMirror } from './account-mirror.ts';
import { redact } from './redaction.ts';
import { refresh } from './panel-ui.ts';
import {
    accountDisplayNamePath,
    accountRemovePath,
    serviceDelete,
    servicePut,
} from './service-calls.ts';
import type { PanelRuntime, AccountsTabState } from './panel-state.ts';

/** What a removal with a forced cascade answers when the service still refuses. */
const BINDINGS_REFUSAL =
    'The service refused: bindings still reference this account — remove them first.';

/** What the note says when nothing is selected to remove. */
const NOTHING_SELECTED = 'Select the account to remove first.';

/**
 * Record one working-state patch the Accounts body just made (FR-066).
 *
 * The display-name draft is working state, not data: it is loaded when a row
 * opens and written only through the narrow route, so a repaint that lands
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
        accounts.displayNameRow = null;
        accounts.displayNameDraft = '';
        accounts.displayNameError = null;
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

/**
 * Write one account's display name through the narrow route (FR-066, AC-130).
 *
 * The refusal renders verbatim at the field with its remediation and the
 * draft stays exactly as typed, so the previously stored name — or the
 * absence of one — is still what the list shows. A success is confirmed by
 * re-reading the list: the service is the authority on what it stored, and
 * the panel never paints a value it invented.
 *
 * @param rt - Panel runtime.
 * @param input - The row being labelled and the text submitted for it.
 */
export async function saveDisplayName(
    rt: PanelRuntime,
    input: { readonly numericUserId: string; readonly value: string },
): Promise<void> {
    const { accounts, bindings } = rt.state;
    // The draft may only be written for the row it was loaded for: a field
    // that outlived a selection would label the wrong account.
    if (accounts.displayNameRow !== input.numericUserId || accounts.selected !== input.numericUserId) {
        accounts.displayNameError = 'Select the account again before saving its display name.';
        refresh(rt);

        return;
    }

    const target =
        bindings.accounts.find((candidate) => candidate.numericUserId === input.numericUserId) ?? null;
    const answer = await servicePut({
        serviceRequest: rt.host.serviceRequest,
        path: accountDisplayNamePath(input.numericUserId),
        body: JSON.stringify({ displayName: input.value }),
    });
    if (rt.disposed) {
        return;
    }

    if (!answer.ok) {
        accounts.displayNameError = redact(answer.message ?? `The service refused: ${answer.problem}`);
        refresh(rt);

        return;
    }

    accounts.displayNameError = null;
    accounts.note =
        target === null
            ? 'Display name saved.'
            : `Display name saved for ${target.login}.`;
    refresh(rt);
    await loadBindings(rt);
}
