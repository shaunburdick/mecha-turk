/**
 * The Accounts tab's writes (005 FR-064–FR-066): two-step removal that states
 * its cascade first (FR-055, FR-065), rotation that retains history (FR-064),
 * and the one Save that writes both profile members atomically (FR-066,
 * FR-085; 004 FR-082; owner ruling PR #12).
 */

import { loadBindings, stillMounted } from './bindings.ts';
import { removeAccountMirror } from './account-mirror.ts';
import { redact } from './redaction.ts';
import { refresh } from './panel-ui.ts';
import { accountProfilePath, accountRemovePath, serviceDelete, servicePut } from './service-calls.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import type { AccountMember } from './accounts-state.ts';
import { PROFILE_MEMBERS, memberRow, setMemberEdit, setMemberRefusal } from './accounts-state.ts';
import type { PanelRuntime, AccountsTabState } from './panel-state.ts';

const BINDINGS_REFUSAL =
    'The service refused: bindings still reference this account — remove them first.';

const NOTHING_SELECTED = 'Select the account to remove first.';

/**
 * Record one working-state patch the Accounts body just made.
 *
 * A field's draft is working state, not data: it is loaded when a row opens
 * and written only through the profile write, so a repaint that lands
 * mid-edit cannot make the field disagree with what a save would send.
 */
export function editAccounts(rt: PanelRuntime, patch: Partial<AccountsTabState>): void {
    if (rt.disposed) {
        return;
    }

    Object.assign(rt.state.accounts, patch);
    refresh(rt);
}

/**
 * Arm the Remove-account control for one row.
 *
 * The first click changes no data: it only puts the cascade statement on the
 * row, so the count the operator reads is the count the delete will act on.
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
 * Delete the armed account and leave its bindings disabled.
 *
 * Runs only after {@link armAccountRemoval} has stated the cascade; the
 * `force=1` query is that statement's confirmation, not a bypass of the
 * service's guard (see `accountRemovePath`). A refusal renders its own copy
 * and changes nothing — the account and every binding stay as they were.
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
 * Arm — or disarm — the Rotate-token control for one row.
 *
 * The arm is what makes the paste field above the list a rotation rather than
 * a second account: {@link `handoff.ts`} reads it to pick the route, and the
 * armed row carries the retention statement until the operator completes or
 * cancels it. Clicking the armed control again cancels without sending.
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

const PROFILE_TITLE = 'Display name and starting prompt';

const PROFILE_NOUN = 'display name and starting prompt';

const ROW_GUARD = `Select the account again before saving its ${PROFILE_NOUN}.`;

/**
 * Where a new `field: remediation` pair begins in a composed `message`.
 * `validationResponse` joins the pairs with `; `, so a new pair starts at a
 * `; ` immediately followed by an identifier and a colon. That lookahead is the
 * whole rule — deliberately *not* "split on every `; `" or on every colon,
 * because a remediation may contain both and neither marks a field: only the
 * service's own `field: ` prefix does.
 */
const MESSAGE_SEGMENT = /; (?=[A-Za-z_][A-Za-z0-9_]*: )/;

export type ProfileRefusal = Readonly<Record<AccountMember, string | null>>;

/**
 * Split one refusal back into the member slots it names (owner ruling, PR #12).
 * The generic envelope carries only `problem`, `code`, and `message` — **no
 * `issues` array** — so the service's own composition is the only structure
 * left to read, and it is read back by **known field name**, never by position
 * and never by any colon in sight. A segment naming neither member is appended
 * to **both** slots, so a reason is never dropped on its way to the operator.
 * Every character a slot receives is the service's own already-redacted copy,
 * so nothing here can echo a submitted value back.
 */
export function splitProfileRefusal(message: string): ProfileRefusal {
    const segments = message.split(MESSAGE_SEGMENT).map((text) => ({
        member: PROFILE_MEMBERS.find((member) => text.startsWith(`${member}: `)) ?? null,
        text,
    }));
    const slotOf = (member: AccountMember): string | null => {
        const reason = segments
            .filter((segment) => segment.member === member || segment.member === null)
            .map((segment) => segment.text)
            .join('; ');

        return reason === '' ? null : reason;
    };

    return { displayName: slotOf('displayName'), startingPrompt: slotOf('startingPrompt') };
}

/**
 * Put both members to the account profile write.
 *
 * The route has always taken the two members together (absent = unchanged),
 * so the wire did not change when the owner ruled "One Save button, both
 * fields" (PR #12) — only the panel stopped sending one member at a time.
 */
async function putProfile(input: {
    readonly rt: PanelRuntime;
    readonly numericUserId: string;
    readonly displayName: string;
    readonly startingPrompt: string;
}): Promise<ServiceErrorResult> {
    return await servicePut({
        serviceRequest: input.rt.host.serviceRequest,
        path: accountProfilePath(input.numericUserId),
        body: JSON.stringify({ displayName: input.displayName, startingPrompt: input.startingPrompt }),
    });
}

/**
 * Whether either of the two drafts no longer belongs to the row on screen.
 *
 * One write carries both fields, so **one** stale row stops them both: a
 * draft that outlived its selection would edit the wrong account (FR-066's
 * open-row guard, 004 FR-089's per-account field).
 *
 * @returns `true` when the save must not run at all.
 */
function staleProfileRow(accounts: AccountsTabState, numericUserId: string): boolean {
    return accounts.selected !== numericUserId
        || PROFILE_MEMBERS.some((member) => memberRow(accounts, member) !== numericUserId);
}

/**
 * Paint one refused write's reasons onto the two member slots. A blank
 * `message` carries no reason at all, so the problem line stands in for it — a
 * refusal that rendered nothing would leave the operator with a save that
 * silently did nothing. Each slot then takes the half that named it; a member
 * the refusal did not name keeps whatever its own field already said, because
 * this answer had nothing against it and it must not inherit the other
 * member's reason.
 */
function paintProfileRefusal(input: {
    readonly accounts: AccountsTabState;
    readonly answer: Extract<ServiceErrorResult, { readonly ok: false }>;
}): void {
    const { accounts, answer } = input;
    const stated = answer.message !== null && answer.message.trim() !== ''
        ? answer.message
        : `The service refused: ${answer.problem}`;
    const refusal = splitProfileRefusal(redact(stated));
    for (const member of PROFILE_MEMBERS) {
        const reason = refusal[member];
        if (reason !== null) {
            setMemberRefusal({ accounts, member, message: reason });
        }
    }
}

/**
 * Retire both members' refusals after a write the service accepted.
 *
 * The accepted write covered **both** fields, so both answers are current
 * (the next save retires the refusal).
 */
function clearProfileRefusals(accounts: AccountsTabState): void {
    for (const member of PROFILE_MEMBERS) {
        setMemberRefusal({ accounts, member, message: null });
    }
}

/**
 * Write **both** operator-editable members of one account's profile, in one body, from the one
 * `Save changes` control (004 FR-082, 005 FR-066/AC-130/AC-150; owner ruling PR #12: "One Save
 * button, both fields"). **The write is atomic — a feature, not a bug:** the service reads the
 * whole body in one additive pass and *any* issue refuses all of it, so a refusal at either member
 * writes **nothing** — the nothing-half-written guarantee 005 contract §2 invariants 4–6 gave each
 * single-member save. The service stays the only validator: unnamed members are left untouched,
 * drafts stay as typed, and a success is confirmed by re-reading — the panel never paints a value
 * it invented.
 */
export async function saveProfile(
    rt: PanelRuntime,
    input: {
        readonly numericUserId: string;
        readonly displayName: string;
        readonly startingPrompt: string;
    },
): Promise<void> {
    const { accounts, bindings } = rt.state;
    if (staleProfileRow(accounts, input.numericUserId)) {
        // The guard is about the **row**, so it is stated on both fields:
        // neither member is writable while the selection is stale.
        for (const member of PROFILE_MEMBERS) {
            setMemberRefusal({ accounts, member, message: ROW_GUARD });
        }
        refresh(rt);

        return;
    }

    const target =
        bindings.accounts.find((candidate) => candidate.numericUserId === input.numericUserId) ?? null;
    const answer = await putProfile({ rt, ...input });
    if (rt.disposed) {
        return;
    }

    if (!answer.ok) {
        paintProfileRefusal({ accounts, answer });
        refresh(rt);

        return;
    }

    clearProfileRefusals(accounts);

    accounts.note =
        target === null ? `${PROFILE_TITLE} saved.` : `${PROFILE_TITLE} saved for ${target.login}.`;
    refresh(rt);
    await loadBindings(rt);
}
