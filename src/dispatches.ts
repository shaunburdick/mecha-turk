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
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Read one page of the dispatch history from the service.
 *
 * A failed or unreadable read keeps the rows the panel already holds — the
 * note explains what went wrong instead of blanking a list the operator was
 * reading — while a successful read replaces them wholesale, records where
 * the answer sits in the set, and drops a selection whose row is gone. The
 * page position itself is the caller's to keep or roll back: this function
 * only ever annotates it with what the answer actually said (FR-042).
 *
 * @param rt - Panel runtime.
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
    if (runs.selectedRun !== null && !answer.rows.some((row) => row.id === runs.selectedRun)) {
        runs.selectedRun = null;
        runs.referencesOpen = false;
        runs.audit = initialAuditHistory();
    }

    // A re-read replaces the rows a confirmation was written against, so any
    // armed control goes back to idle rather than acting on a row that may
    // have moved (T-025).
    runs.pendingAction = null;
    runs.status = 'ready';
    runs.note = '';
    refresh(rt);
}

/**
 * Record the run the operator selected for the open/retry buttons.
 *
 * Unknown ids are ignored rather than stored: the list only offers ids that
 * came from the service, and a stale selection must not silently target some
 * later row.
 *
 * @param rt - Panel runtime.
 * @param id - Row id the list reported.
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
        // trail another run's id fetched, or another row's revealed references
        // (T-025, T-026, FR-048).
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
 *
 * @param rt - Panel runtime.
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
 * @param row - Run to name.
 * @returns The reference every confirmation and outcome note leads with.
 */
function issueRef(row: RunRow): string {
    return `#${row.issueNumber}`;
}

/**
 * The coordinates FR-027 requires both confirmations to show (FR-029).
 *
 * @param row - The run being resolved.
 * @returns `project …, worktree …, attachment …` — what the operator matches
 *   against OpenChamber's own session list.
 */
function guidanceFor(row: RunRow): string {
    return `project ${row.projectId}, worktree ${row.worktreeOption}, attachment ${row.attachmentId}`;
}

/**
 * The return-to-waiting confirmation: what resets, and what is kept.
 *
 * @param row - The parked run.
 * @returns The copy the control shows before it acts (FR-033).
 */
function requeueConfirmCopy(row: RunRow): string {
    return `Confirm: return ${issueRef(row)} to waiting? The attempt count resets to 1 and the automatic `
        + 'requeue budget to 0; source references and every prior attempt record are kept.';
}

/**
 * A resolve confirmation: what the operator is asked to verify, and the
 * warning FR-027 requires before either answer.
 *
 * @param row - The `unconfirmed` run.
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
 * @param result - The refused answer.
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
 * @param rt - Panel runtime, for the one host call this can make.
 * @param row - The run being retried.
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
 * operator clicks the same control again (FR-027, FR-033).
 *
 * @param input - Runtime, the control being armed, and its confirmation copy.
 * @returns `true` when the control was already armed and may act now.
 */
function armControl(input: {
    /** Panel runtime. */
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
 * Post one run operation behind the section's single busy gate (T-025).
 *
 * One flag gates every run operation — retry, return to waiting, resolve — so
 * the operator cannot send two of them at once, and the run state is only ever
 * what the service answers: the list is re-read after the call and the note is
 * written afterwards, so a refresh can never clobber the explanation.
 *
 * @param input - Runtime, path, body, and the copy for an accepted answer.
 */
async function postRunOperation(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** Run-scoped path to POST to. */
    readonly path: string;
    /** Serialized body the contract for that operation requires. */
    readonly body: string;
    /** Note for a 200 answer. */
    readonly success: string;
}): Promise<void> {
    const { dispatches: runs } = input.rt.state;
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
 * Retry the selected run under its own run key (M8, FR-041).
 *
 * Only a run the service accepts is sent — a dispatched or waiting row is
 * refused locally with the same words the table gives it — and a blocked run
 * goes with the evidence {@link causeMembers} could gather, so the audit row
 * says what was actually checked rather than that something was.
 *
 * @param rt - Panel runtime.
 */
export async function retryRun(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.busy) {
        return;
    }

    // The one table decides: it is the same source the button's visibility
    // comes from, so the guard and the control can never disagree (FR-044).
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

/**
 * Return the selected parked run to waiting (FR-033), two clicks apart.
 *
 * @param rt - Panel runtime.
 */
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

/**
 * Resolve the selected `unconfirmed` run one of FR-027's two ways.
 *
 * The state guard is the point: the two resolutions are the *only* paths out
 * of the fail-closed wedge, so they are reachable from that state and from
 * nowhere else, and the second click — never the first — is what posts.
 *
 * @param rt - Panel runtime.
 * @param decision - Which resolution the operator confirmed.
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
            ...(decision === SESSION_CREATED ? { sessionId } : {}),
            guidance: guidanceFor(row),
        }),
        success: decision === SESSION_CREATED
            ? `${issueRef(row)} recorded as dispatched with session ${sessionId}.`
            : `${issueRef(row)} resolved as no session created — it is waiting again.`,
    });
}

/**
 * Confirm FR-027's first resolution: the dispatch did create a session.
 *
 * @param rt - Panel runtime.
 */
export async function resolveSessionCreated(rt: PanelRuntime): Promise<void> {
    await resolveRun(rt, SESSION_CREATED);
}

/**
 * Confirm FR-027's second resolution: the dispatch created no session.
 *
 * @param rt - Panel runtime.
 */
export async function resolveNoSession(rt: PanelRuntime): Promise<void> {
    await resolveRun(rt, 'no-session');
}

/**
 * Record the session id the operator types for the first resolution.
 *
 * @param rt - Panel runtime.
 * @param value - What the field holds now.
 */
export function setSessionInput(rt: PanelRuntime, value: string): void {
    if (rt.disposed) {
        return;
    }

    rt.state.dispatches.sessionInput = value;
}

/**
 * Reveal or hide the selected row's source references (FR-048, AC-120).
 *
 * A view toggle, not a run operation: it sends nothing, changes no row, and
 * costs no budget. Selecting a different row closes it (see
 * {@link selectDispatch}), so the reveal can never show one dispatch's
 * references under another dispatch's selection.
 *
 * @param rt - Panel runtime.
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
 * Copy the selected row's correlation id to the clipboard (FR-049).
 *
 * Every outcome lands on the note line rather than being swallowed: no
 * selection says there is nothing to copy, and a clipboard the frame refuses
 * says so with the cause — an unavailable copy is always a reason, never a
 * silent nothing (FR-003, FR-049).
 *
 * @param rt - Panel runtime.
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
