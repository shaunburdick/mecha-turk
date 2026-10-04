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
 * - **The profile is written as one atomic whole** (FR-066, FR-085; 004
 *   FR-082): the display name and the account tier are never applied
 *   optimistically — one `Save changes` control carries **both** members in
 *   one body (owner ruling, PR #12: "One Save button, both fields"), a
 *   refusal renders at the field it was answered for with the service's own
 *   remediation, and the stored values stay in force; a success is answered
 *   with an authoritative re-read rather than a locally invented value. The
 *   service's one-pass refusal is split back into the two member slots by
 *   **known field name**, because the panel's envelope carries only the
 *   composed `message`.
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
import { PROFILE_MEMBERS, memberRow, setMemberEdit, setMemberRefusal } from './accounts-state.ts';
import type { PanelRuntime, AccountsTabState } from './panel-state.ts';

/** What a removal with a forced cascade answers when the service still refuses. */
const BINDINGS_REFUSAL =
    'The service refused: bindings still reference this account — remove them first.';

/** What the note says when nothing is selected to remove. */
const NOTHING_SELECTED = 'Select the account to remove first.';

/**
 * Record one working-state patch the Accounts body just made.
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
 * Arm the Remove-account control for one row.
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
 * Delete the armed account and leave its bindings disabled.
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
 * Arm — or disarm — the Rotate-token control for one row.
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

/** What one profile write's success note calls the two members it carries. */
const PROFILE_TITLE = 'Display name and starting prompt';

/** What the open-row guard's remediation calls the two members it protects. */
const PROFILE_NOUN = 'display name and starting prompt';

/** The guard's own copy: both drafts belong to the row that loaded them. */
const ROW_GUARD = `Select the account again before saving its ${PROFILE_NOUN}.`;

/**
 * Where a new `field: remediation` pair begins in a composed `message`.
 *
 * `validationResponse` joins the pairs with `; `, so a new pair starts at a
 * `; ` immediately followed by an identifier and a colon. The lookahead is
 * the whole rule, and it is deliberately *not* "split on every `; `" or
 * "split on every colon": a remediation may contain `; ` of its own ("set
 * startingPrompt to a string; leave it empty…") and `: ` of its own
 * ("…credential-shaped material (matched shape: PAT)"), and neither marks a
 * field — only the service's own `field: ` prefix does.
 */
const MESSAGE_SEGMENT = /; (?=[A-Za-z_][A-Za-z0-9_]*: )/;

/** The service's copy per member once a refusal has been split; `null` when unnamed. */
export type ProfileRefusal = Readonly<Record<AccountMember, string | null>>;

/**
 * Split one refusal back into the member slots it names (owner ruling, PR #12).
 *
 * The panel's generic error envelope carries only `problem`, `code`, and
 * `message` — **no `issues` array** — so the service's own composition is
 * the only structure left to read back, and it is read back by **known field
 * name**, never by position and never by any colon in sight. A segment that
 * names neither member — the `body` refusal, an unexpected key, or a
 * non-validation message with no field shape at all — is appended to **both**
 * slots, so a reason is never dropped on its way to the operator.
 *
 * Every character a slot receives is the service's own copy (already redacted
 * by the caller), so nothing here can echo a submitted value back.
 *
 * @param message - The service's `message`, exactly as it arrived.
 * @returns Each member's reason, or `null` for a member the refusal did not name.
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
 *
 * @param input - The runtime, the row, and both members' on-screen text.
 * @returns The service's own answer for that one write.
 */
async function putProfile(input: {
    /** Runtime whose host surface the write runs on. */
    readonly rt: PanelRuntime;
    /** GitHub numeric user id of the row being edited. */
    readonly numericUserId: string;
    /** The display name exactly as the field holds it. */
    readonly displayName: string;
    /** The account tier exactly as the field holds it. */
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
 * @param accounts - The Accounts tab's working state.
 * @param numericUserId - The row the write is about to touch.
 * @returns `true` when the save must not run at all.
 */
function staleProfileRow(accounts: AccountsTabState, numericUserId: string): boolean {
    return accounts.selected !== numericUserId
        || PROFILE_MEMBERS.some((member) => memberRow(accounts, member) !== numericUserId);
}

/**
 * Paint one refused write's reasons onto the two member slots.
 *
 * A blank `message` carries no reason at all, so the problem line stands in
 * for it — a refusal that rendered nothing would leave the operator with a
 * save that silently did nothing. Each slot then takes the half that named
 * it; a member the refusal did not name keeps whatever its own field already
 * said, because this answer had nothing against it and it must not inherit
 * the other member's reason.
 *
 * @param input - The tab's working state, and the service's answer.
 */
function paintProfileRefusal(input: {
    /** The Accounts tab's working state. */
    readonly accounts: AccountsTabState;
    /** The service's refusal for the write. */
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
 * (005 FR-085's "the next save retires the refusal").
 *
 * @param accounts - The Accounts tab's working state.
 */
function clearProfileRefusals(accounts: AccountsTabState): void {
    for (const member of PROFILE_MEMBERS) {
        setMemberRefusal({ accounts, member, message: null });
    }
}

/**
 * Write **both** operator-editable members of one account's profile, in one
 * body, from the one `Save changes` control (004 FR-082, 005 FR-066, AC-130,
 * AC-150; owner ruling, PR #12: "One Save button, both fields").
 *
 * **The write is atomic — this is a feature, not a bug.** The service reads
 * the whole body in one additive pass and *any* issue refuses all of it, so a
 * refusal at either member writes **nothing**: one bad value fails both
 * fields together. That is exactly the nothing-half-written guarantee the two
 * single-member saves each had (005 contract §2, invariants 4–6), now visible
 * across two fields — and it is why the refusal is split *per member* below
 * rather than rendered whole on both.
 *
 * The service stays the only validator: nothing here checks a
 * draft, so a refusal is always the service's own, and the answer for a
 * member the service did not name is left untouched rather than cleared or
 * borrowed from the other field. Both drafts stay exactly as typed, both
 * stored members stay in force, and a success is confirmed by re-reading the
 * list — the service is the authority on what it stored, and the panel never
 * paints a value it invented.
 *
 * @param rt - Panel runtime.
 * @param input - The row being written and both members' on-screen text.
 */
export async function saveProfile(
    rt: PanelRuntime,
    input: {
        /** GitHub numeric user id of the row being written. */
        readonly numericUserId: string;
        /** The display name exactly as its field holds it. */
        readonly displayName: string;
        /** The account tier exactly as its field holds it. */
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
