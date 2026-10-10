/**
 * The Dispatches section's actions (M8): read the history, open the issue, retry.
 *
 * The service owns the queue; this module reads its credential-free
 * projection (`GET /v1/events`, all states, newest detected first, capped at
 * 100) and requeues one non-dispatched run through
 * `POST /v1/events/:id/retry`. Nothing here dispatches: a retry only returns
 * the run to `pending`, and the relay's own loop is what starts it again.
 *
 * Every action is fail-quiet in the panel's own idiom — a refused call lands
 * on the section's note line (with the service's envelope code where one
 * exists), never as an exception that could take the panel down. The list
 * re-reads after a retry so the row the operator just acted on shows the
 * state the service actually stored, and only then is the outcome note
 * written, so a refresh can never clobber the explanation.
 */

import { initialAuditHistory } from './audit-view.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { runAffordance, selectedRun } from './dispatches-rows.ts';
import { reofferableFollowUps } from './dispatches-detail.ts';
import type { ParkedFollowUp } from './dispatches-detail.ts';
import { loadDispatchRecord, reofferFollowUpDelivery } from './dispatch-record.ts';
import { dispatchListPath, parseDispatchListBody } from './dispatches-list.ts';
import { BLOCKED_PREFIX } from './dispatches-service.ts';
import { recordDispatchPageMeta } from './dispatch-page.ts';
import { requeuePath, resolvePath, retryPath, serviceGet, servicePost } from './service-calls.ts';
import { describeError, resolveProject } from './session.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import type { PanelRuntime, RunPendingAction } from './panel-state.ts';
import type { RunRow } from './dispatches-service.ts';

/**
 * Whether the mount still runs; a function call the analyzer never narrows.
 *
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
    return !rt.disposed;
}

/**
 * Read one page of the dispatch history from the service.
 *
 * A failed or unreadable read keeps the rows the panel already holds — the
 * note explains what went wrong instead of blanking a list the operator was
 * reading — while a successful read replaces them wholesale, records where
 * the answer sits in the set, and drops a selection whose row is gone. The
 * page position itself is the caller's to keep or roll back: this function
 * only ever annotates it with what the answer actually said.
 */
export async function loadDispatches(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    if (rt.disposed || runs.status === 'loading') {
        return;
    }

    runs.status = 'loading';
    refresh(rt);

    const result = await serviceGet({
        serviceRequest: rt.host.serviceRequest,
        path: dispatchListPath(runs),
    });
    if (!stillMounted(rt)) {
        return;
    }

    if (!result.ok) {
        runs.status = 'error';
        runs.note = redact(`Dispatch list not loaded: ${result.problem}.`);
        refresh(rt);

        return;
    }

    const answer = parseDispatchListBody(result.body);
    if (answer === null) {
        runs.status = 'error';
        runs.note = 'The service answered a dispatch list the panel could not read — refresh to retry.';
        refresh(rt);

        return;
    }

    runs.rows = answer.rows;
    runs.page = recordDispatchPageMeta(runs.page, answer.page);
    if (runs.selectedRun !== null && answer.rows.every((row) => row.id !== runs.selectedRun)) {
        runs.selectedRun = null;
        runs.referencesOpen = false;
        runs.audit = initialAuditHistory();
    }

    // A re-read replaces the rows a confirmation was written against, so any
    // armed control goes back to idle rather than acting on a row that may
    // have moved.
    runs.pendingAction = null;
    runs.status = 'ready';
    runs.note = '';
    // The panel's own record of what happened to this history's follow-ups
    // rides beside the history (002 FR-105): a parked follow-up's reason is a
    // fact about the row the operator is reading, and re-reading storage on
    // every repaint is not a price that fact is worth. A record this build
    // cannot read keeps the last list it held — blanking it would hide parked
    // reasons that are still true.
    const record = await loadDispatchRecord(rt);
    if (record.ok) {
        runs.followUpRecords = record.document.followUps ?? [];
    }

    refresh(rt);
}

/**
 * Record the run the operator selected for the open/retry buttons.
 *
 * Unknown ids are ignored rather than stored: the list only offers ids that
 * came from the service, and a stale selection must not silently target some
 * later row.
 */
export function selectDispatch(rt: PanelRuntime, id: string): void {
    const { dispatches: runs } = rt.state;
    if (rt.disposed) {
        return;
    }

    if (runs.rows.some((row) => row.id === id)) {
        runs.selectedRun = id;
        // A confirmation armed against one run must not outlive the selection
        // it was written for, and neither may a session id typed for it, the
        // trail another run's id fetched, or another row's revealed references.
        runs.pendingAction = null;
        runs.sessionInput = '';
        runs.referencesOpen = false;
        runs.audit = initialAuditHistory();
    }

    refresh(rt);
}

/**
 * Open the selected run's issue in the operator's browser.
 *
 * A host refusal lands on the runs note like every other action's failure —
 * an explicit outcome rather than a silently swallowed one — and the row
 * keeps its URL visible in the issue itself either way.
 */
export async function openDispatch(rt: PanelRuntime): Promise<void> {
    const row = selectedRun(rt.state.dispatches);
    if (row === null) {
        return;
    }

    try {
        await rt.host.openUrl(row.issueUrl);
    } catch (cause) {
        rt.state.dispatches.note = redact(`The issue could not be opened: ${describeError(cause)}.`);
        refresh(rt);
    }
}

/** Note shown when a dispatched run is asked for a retry (the local guard's copy). */
const ALREADY_DISPATCHED_NOTE =
    'The service refused: this dispatch was already dispatched; there is nothing left to retry.';

/** FR-027's two explicit resolutions, as the resolve body names them. */
type ResolveDecision = 'session-created' | 'no-session';

/** FR-027's first resolution: the dispatch did create a session (contract §8). */
const SESSION_CREATED: ResolveDecision = 'session-created';

/** Extra members a retry body carries when the run sits in a blocked state. */
interface CauseMembers {
    /** Whether the panel reports the blocking cause cleared (contract §6). */
    readonly causeCleared?: boolean;
    /** What was actually checked — audited as evidence, never as proof. */
    readonly causeReport?: string;
}

/**
 * The operator's own reference to one run: `#<issue number>`.
 *
 * @returns The reference every confirmation and outcome note leads with.
 */
function issueRef(row: RunRow): string {
    return `#${row.issueNumber}`;
}

/**
 * The coordinates FR-027 requires both confirmations to show.
 *
 * @returns `project …, worktree …, attachment …` — what the operator matches
 *   against OpenChamber's own session list.
 */
function guidanceFor(row: RunRow): string {
    return `project ${row.projectId}, worktree ${row.worktreeOption}, attachment ${row.attachmentId}`;
}

/**
 * The return-to-waiting confirmation: what resets, and what is kept.
 *
 * @returns The copy the control shows before it acts.
 */
function requeueConfirmCopy(row: RunRow): string {
    return `Confirm: return ${issueRef(row)} to waiting? The attempt count resets to 1 and the automatic `
        + 'requeue budget to 0; source references and every prior attempt record are kept.';
}

/**
 * The re-offer confirmation: what the panel clears, and what it buys.
 *
 * The ladder is **not** refreshed — `reofferFollowUpRecords` leaves `attempt`
 * alone, because a reset would re-spend a bound the park had just exhausted.
 * So the re-offer buys one more attempt and a second failure parks the
 * follow-up again at once, which is what the copy has to say (the site's own
 * wording, mirrored here rather than claimed more softly).
 *
 * @param row - The dispatch the control acts on.
 * @param parked - How many parked follow-ups the control will re-offer.
 * @returns The copy the control shows before it acts.
 */
function reofferFollowUpCopy(row: RunRow, parked: number): string {
    const subject = parked === 1 ? 'the parked follow-up' : `the ${parked} parked follow-ups`;

    return `Confirm: re-offer ${subject} for ${issueRef(row)}? The panel clears the parked flag and its cause on its`
        + ' own delivery record, which buys one more attempt: the retry ladder is not refreshed, so a second failure'
        + ' parks it again at once. Every follow-up that already reached the session, and the attempt history, are'
        + ' kept.';
}

/**
 * A resolve confirmation: what the operator is asked to verify, and the
 * warning FR-027 requires before either answer.
 *
 * @param decision - Which of the two resolutions this confirmation leads to.
 * @returns The copy the control shows before it acts.
 */
function resolveConfirmCopy(row: RunRow, decision: ResolveDecision): string {
    const question = decision === SESSION_CREATED ? 'does a session exist' : 'does no session exist';
    const warning = 'A session may still exist and this panel holds no record of it, so check the session list '
        + 'in OpenChamber under that attachment id before you answer.';
    const outcome = decision === SESSION_CREATED
        ? 'Confirming records the run as dispatched with the session id you named.'
        : 'Confirming returns the run to waiting, where it may be dispatched again.';

    return `Verify first: ${question} for ${guidanceFor(row)}? ${warning} ${outcome}`;
}

/**
 * Render a refused operation as the note: the service's own copy, verbatim.
 *
 * The envelope's `message` *is* the verdict — each state refusal words itself
 * distinctly (contract §6) — so the panel reports it rather than paraphrasing
 * it into something the operator has to translate back into the run's state.
 *
 * @returns The redacted note.
 */
function verdictNote(result: Extract<ServiceErrorResult, { readonly ok: false }>): string {
    if (result.message !== null) {
        return redact(result.message);
    }

    return redact(result.code === null ? result.problem : `${result.problem} (${result.code})`);
}

/**
 * What the panel can honestly say about a blocked run's cause (contract §6).
 *
 * Each blocked reason has its own evidence, and the panel never claims more
 * than it checked: the service re-checks the binding table itself, the panel's
 * same-mount project list is the only evidence available for a project the
 * host no longer resolves (the service cannot call host APIs), and any other
 * cause is the operator's assertion on this mount — which is what gets audited.
 *
 * @returns The members to add to the retry body.
 */
async function causeMembers(rt: PanelRuntime, row: RunRow): Promise<CauseMembers> {
    if (!row.state.startsWith(BLOCKED_PREFIX)) {
        return {};
    }

    const cause = row.state.slice(BLOCKED_PREFIX.length);
    if (cause === 'binding-missing') {
        return { causeCleared: true };
    }

    if (cause === 'project-missing') {
        const resolution = await resolveProject(rt.host, row.projectId);

        return resolution.ok
            ? { causeCleared: true, causeReport: `project ${row.projectId} resolves again (checked this mount)` }
            : { causeCleared: false };
    }

    return { causeCleared: true, causeReport: `operator confirmed the ${cause} cause cleared on this mount` };
}

/**
 * Arm one control's confirmation, or report it is already armed.
 *
 * The panel has no dialog primitive, so a state-changing action confirms the
 * way the Remove-account control already does: the first click states what
 * will happen, the second one sends it. Arming writes the copy into the
 * section's note and leaves the row alone — nothing is posted until the
 * operator clicks the same control again.
 *
 * @returns `true` when the control was already armed and may act now.
 */
function armControl(input: {
    readonly rt: PanelRuntime;
    /** Which control the click belongs to; a different arm is replaced. */
    readonly action: RunPendingAction;
    /** The confirmation copy for this control. */
    readonly copy: string;
}): boolean {
    const { dispatches: runs } = input.rt.state;
    if (runs.pendingAction === input.action) {
        return true;
    }

    runs.pendingAction = input.action;
    runs.note = redact(input.copy);
    refresh(input.rt);

    return false;
}

/**
 * Post one run operation behind the section's single busy gate.
 *
 * One flag gates every run operation — retry, return to waiting, resolve — so
 * the operator cannot send two of them at once, and the run state is only ever
 * what the service answers: the list is re-read after the call and the note is
 * written afterwards, so a refresh can never clobber the explanation.
 *
 * @returns The outcome the tab renders once the answer is accepted.
 */
async function postRunOperation(input: {
    readonly rt: PanelRuntime;
    /** Run-scoped path to POST to. */
    readonly path: string;
    /** Serialized body the contract for that operation requires. */
    readonly body: string;
    /** Note for a 200 answer. */
    readonly success: string;
}): Promise<void> {
    const { dispatches: runs } = input.rt.state;
    // The gate lives **here**, in the one dispatch path, rather than only in
    // the callers: each of those checks `busy` before its first `await`, and a
    // second activation that started in the same tick would have passed that
    // check already. Two rapid clicks on one row therefore run exactly one
    // operation (FR-049, AC-118's double-activation half).
    if (runs.busy || !stillMounted(input.rt)) {
        return;
    }

    runs.busy = true;
    runs.pendingAction = null;
    refresh(input.rt);

    const result = await servicePost({
        serviceRequest: input.rt.host.serviceRequest,
        path: input.path,
        body: input.body,
    });
    runs.busy = false;
    if (!stillMounted(input.rt)) {
        return;
    }

    await loadDispatches(input.rt);
    if (!stillMounted(input.rt)) {
        return;
    }

    runs.note = result.ok ? input.success : verdictNote(result);
    refresh(input.rt);
}

/**
 * Retry the selected run under its own run key (M8).
 *
 * Only a run the service accepts is sent — a dispatched or waiting row is
 * refused locally with the same words the table gives it — and a blocked run
 * goes with the evidence {@link causeMembers} could gather, so the audit row
 * says what was actually checked rather than that something was.
 */
export async function retryRun(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.busy) {
        return;
    }

    // The one table decides: it is the same source the button's visibility
    // comes from, so the guard and the control can never disagree.
    if (runAffordance(row).action !== 'retry') {
        runs.note = redact(row.state === 'dispatched' ? ALREADY_DISPATCHED_NOTE : runAffordance(row).reason);
        refresh(rt);

        return;
    }

    const cause = await causeMembers(rt, row);
    if (!stillMounted(rt)) {
        return;
    }

    await postRunOperation({
        rt,
        path: retryPath(row.id),
        body: JSON.stringify({ correlationId: row.correlationId, attempt: row.attempt, ...cause }),
        success: `Requeued ${issueRef(row)} — the next relay poll dispatches it again.`,
    });
}

/** Return the selected parked run to waiting, two clicks apart. */
export async function requeueRun(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.busy) {
        return;
    }

    const affordance = runAffordance(row);
    if (affordance.action !== 'requeue') {
        runs.note = redact(affordance.reason);
        refresh(rt);

        return;
    }

    if (!armControl({ rt, action: 'requeue', copy: requeueConfirmCopy(row) })) {
        return;
    }

    await postRunOperation({
        rt,
        path: requeuePath(row.id),
        body: JSON.stringify({ correlationId: row.correlationId, confirm: true }),
        success: `${issueRef(row)} is waiting again — its attempt count is back to 1.`,
    });
}

/** The note a refused re-offer leaves: nothing changed, and the cause. */
const REFUSED_REOFFER_NOTE =
    'The re-offer did not land: the panel could not read or write its own delivery record, so nothing changed.';

/**
 * The outcome note: what was re-offered, and what it bought.
 *
 * One more attempt, not a fresh ladder: the re-offer clears the park and its
 * cause and leaves the count alone, so a second failure parks it again at
 * once — the same promise the confirmation made.
 *
 * @param row - The dispatch the re-offer acted on.
 * @param parked - How many parked follow-ups it cleared.
 * @returns The note.
 */
function reofferOutcomeCopy(row: RunRow, parked: number): string {
    const subject = parked === 1 ? 'the parked follow-up' : `the ${parked} parked follow-ups`;

    return `Re-offered ${subject} for ${issueRef(row)} — the next relay poll gives it one more attempt, which`
        + ' parks it again at once if it fails.';
}

/**
 * Write the re-offer and report what it did; never throws.
 *
 * The row's parked line is a fact about this dispatch's own record, so the
 * re-read after the write is what lets the section show the re-offer instead of
 * naming a park the operator just cleared — and a record this build cannot read
 * keeps the last list it held, exactly as the list load does.
 */
async function applyReoffer(input: {
    /** Runtime whose dispatches slice and record are written. */
    readonly rt: PanelRuntime;
    /** The dispatch the re-offer acts on. */
    readonly row: RunRow;
    /** The parked follow-ups the control is re-offering. */
    readonly reofferable: readonly ParkedFollowUp[];
}): Promise<void> {
    const { rt, row, reofferable } = input;
    const { dispatches: runs } = rt.state;
    const wasChanged = await reofferFollowUpDelivery({
        rt,
        deliveryIds: reofferable.map((parkedFollowUp) => parkedFollowUp.deliveryId),
    });
    if (!stillMounted(rt)) {
        return;
    }

    const read = await loadDispatchRecord(rt);
    if (read.ok) {
        runs.followUpRecords = read.document.followUps ?? [];
    }

    runs.pendingAction = null;
    runs.note = wasChanged ? reofferOutcomeCopy(row, reofferable.length) : REFUSED_REOFFER_NOTE;
    refresh(rt);
}

/**
 * Re-offer the selected dispatch's parked follow-ups (002 FR-105, AC-051).
 *
 * The park is not an end. A follow-up that spent the retry ladder returns to
 * waiting only through this control, and the durable record stays the
 * at-most-once authority while it does: the re-offer clears the park and its
 * cause and nothing else, so a follow-up that already reached its session is
 * never sent twice and one nobody attempted is never touched. It is a **local**
 * action on the panel's own record — no route, no service request, no run state
 * (FR-107) — which is why it posts nothing and re-reads the record instead.
 *
 * The relay's flags are read before the first `await` for the same reason
 * `postRunOperation` reads `busy` there: a relay tick is the only other writer
 * of the follow-up record, and a re-offer that landed mid-tick would persist a
 * document the tick had already written a delivery outcome into. The two-click
 * confirm narrows that window further, and the refusal is a note rather than a
 * silent nothing either way.
 */
export async function reofferFollowUp(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.busy) {
        return;
    }

    if (rt.state.relay.inFlight || rt.state.relay.dispatching) {
        runs.note = 'A relay tick is in flight — try the re-offer again in a moment.';
        refresh(rt);

        return;
    }

    const reofferable = reofferableFollowUps(row, runs.followUpRecords);
    if (reofferable.length === 0) {
        // Both absences are facts an operator can act on, so the note names them
        // rather than refusing silently: a follow-up nobody attempted is already
        // due, and one that reached its session has nothing to send again.
        runs.note = 'Nothing to re-offer: this dispatch has no parked follow-up. One that has not been attempted is'
            + ' already due, and one that already reached its session has nothing to re-offer.';
        refresh(rt);

        return;
    }

    if (!armControl({ rt, action: 'reoffer-follow-up', copy: reofferFollowUpCopy(row, reofferable.length) })) {
        return;
    }

    await applyReoffer({ rt, row, reofferable });
}

/**
 * Resolve the selected `unconfirmed` run one of FR-027's two ways.
 *
 * The state guard is the point: the two resolutions are the *only* paths out
 * of the fail-closed wedge, so they are reachable from that state and from
 * nowhere else, and the second click — never the first — is what posts.
 */
async function resolveRun(rt: PanelRuntime, decision: ResolveDecision): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.busy) {
        return;
    }

    if (row.state !== 'unconfirmed') {
        runs.note = redact(runAffordance(row).reason);
        refresh(rt);

        return;
    }

    const armed = decision === SESSION_CREATED ? 'resolve-session' : 'resolve-no-session';
    if (!armControl({ rt, action: armed, copy: resolveConfirmCopy(row, decision) })) {
        return;
    }

    const sessionId = runs.sessionInput.trim();
    if (decision === SESSION_CREATED && sessionId === '') {
        runs.note = 'Name the session id to record — find it in the OpenChamber session list under attachment '
            + `${row.attachmentId}.`;
        refresh(rt);

        return;
    }

    await postRunOperation({
        rt,
        path: resolvePath(row.id),
        body: JSON.stringify({
            correlationId: row.correlationId,
            decision,
            ...(decision === SESSION_CREATED && { sessionId }),
            guidance: guidanceFor(row),
        }),
        success: decision === SESSION_CREATED
            ? `${issueRef(row)} recorded as dispatched with session ${sessionId}.`
            : `${issueRef(row)} resolved as no session created — it is waiting again.`,
    });
}

/** Confirm the first resolution: the dispatch did create a session. */
export async function resolveSessionCreated(rt: PanelRuntime): Promise<void> {
    await resolveRun(rt, SESSION_CREATED);
}

/** Confirm the second resolution: the dispatch created no session. */
export async function resolveNoSession(rt: PanelRuntime): Promise<void> {
    await resolveRun(rt, 'no-session');
}

/**
 * Record the session id the operator types for the first resolution.
 */
export function setSessionInput(rt: PanelRuntime, value: string): void {
    if (rt.disposed) {
        return;
    }

    rt.state.dispatches.sessionInput = value;
}

/**
 * Reveal or hide the selected row's source references.
 *
 * A view toggle, not a run operation: it sends nothing, changes no row, and
 * costs no budget. Selecting a different row closes it (see
 * {@link selectDispatch}), so the reveal can never show one dispatch's
 * references under another dispatch's selection.
 */
export function toggleReferences(rt: PanelRuntime): void {
    const { dispatches: runs } = rt.state;
    if (rt.disposed || runs.selectedRun === null) {
        return;
    }

    runs.referencesOpen = !runs.referencesOpen;
    refresh(rt);
}

/**
 * Copy the selected row's correlation id to the clipboard.
 *
 * Every outcome lands on the note line rather than being swallowed: no
 * selection says there is nothing to copy, and a clipboard the frame refuses
 * says so with the cause — an unavailable copy is always a reason, never a
 * silent nothing.
 */
export async function copyCorrelationId(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null) {
        runs.note = 'Nothing to copy: select a dispatch first.';
        refresh(rt);

        return;
    }

    try {
        await rt.host.writeClipboard(row.correlationId);
        if (!rt.disposed) {
            runs.note = `Correlation id ${row.correlationId} copied.`;
        }
    } catch (cause) {
        if (!rt.disposed) {
            runs.note = redact(`The correlation id could not be copied: ${describeError(cause)}.`);
        }
    }

    refresh(rt);
}
