/**
 * The gates between a claim and the host call (003 T-021).
 *
 * Three things live here, and they belong together because a refusal can
 * happen at any of them and every refusal has the same shape: **decide, then
 * stop before `host.startSession()` is reachable** (FR-028's panel half).
 *
 * - **The guards.** A binding the tab no longer holds, a binding that is
 *   disabled, and a project the host no longer lists each refuse the attempt
 *   and report it as `blocked:<reason>` (FR-042) — never as "drained", never
 *   as a dispatch that did not happen.
 * - **The authorization gates.** Reserve, and the abandon that covers the one
 *   gap between a reservation and the host call (the mount closing). A refused
 *   reserve ends the attempt with nothing written and nothing started.
 * - **The shared predicates.** {@link stillRunning} — a function call, so the
 *   type analyzer never narrows a check past it — {@link boundedText}, the
 *   1,000-character bound every run-scoped route enforces on free text, and
 *   {@link RELAY_LEDGER_KIND}, the ledger kind every step of this path records
 *   under.
 *
 * The project is resolved *here*, before the reservation, and handed on: the
 * guard that would refuse it and the dispatch that needs it are the same fact,
 * so resolving it twice could let the two disagree.
 */

import type { GuestProject } from '@openchamber/sdk';
import { repositoryLabel } from './config.ts';
import { nowIso } from './ids.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { redact } from './redaction.ts';
import { abandonPath, blockedPath, reservePath, servicePost } from './service-calls.ts';
import { resolveProject } from './session.ts';
import type { ClaimedRun, ReserveAnswer } from './claim-service.ts';
import { parseReserveBody } from './claim-service.ts';
import type { ReferenceWindow } from './service-envelope.ts';
import type { PanelRuntime } from './panel-state.ts';

/** How often the relay polls the service, in milliseconds. */
export const RELAY_POLL_INTERVAL_MS = 10_000;

/** Ledger kind the relay records its results under (same kind the ledger uses). */
export const RELAY_LEDGER_KIND = 'session';

/** Longest `problem`/`detail`/`guidance` the run-scoped routes accept (1,000). */
const MAX_BODY_TEXT_CHARS = 1_000;

/** Problem recorded when a start made no session and named no cause. */
export const NO_SESSION_PROBLEM = 'no-session';

/**
 * The declared blocked causes this panel ever names (contract §4).
 *
 * A **subset** of the service's five, deliberately: the panel raises the two it
 * can see locally (a binding this tab no longer holds, a project the host no
 * longer lists) and the one the service's actor-policy gate
 * answers with. The other two — `credential` and `policy` — are declared so a
 * run's state parses, but no panel guard in this build produces them, so this
 * panel never sends them.
 *
 * `BlockedReason[0]` and {@link ACTOR_NOT_ALLOWED] are two declarations of one
 * word, which a panel cannot avoid: it cannot import across the extension/service
 * boundary, so the duplication is structural rather than careless. `tests/relay-integrity.test.ts`
 * carries the **drift test** that keeps it honest — the one place the two are
 * read together.
 */
export type BlockedReason = 'binding-missing' | 'project-missing' | 'actor-not-allowed';

/** The wire code the gate refuses with, and the declared cause it parks in. */
export const ACTOR_NOT_ALLOWED = 'actor-not-allowed';

/**
 * What one reserve call answered.
 *
 * A union rather than `ReserveAnswer | null` because the **actor-policy gate's**
 * refusal has to travel somewhere: the panel owes the run a `blocked:` report for
 * it, and a bare `null` cannot distinguish "the service refused a
 * policy this panel must report" from "the service refused a stale lease, which
 * it merely notes". Every other refusal stays exactly as before — one kind, no
 * failure, and the run ends.
 */
export type ReserveOutcome =
    /** The run is authorized to start; the token is live. */
    | { readonly kind: 'reserved'; readonly reservation: ReserveAnswer }
    /** Nothing was authorized; `failure` is set only for the actor-policy gate. */
    | { readonly kind: 'refused'; readonly failure?: GuardFailure };

/** Why one fail-closed guard refused a dispatch before any host call. */
export interface GuardFailure {
    /** The declared cause, in the service's set. */
    readonly reason: BlockedReason;
    /** What specifically is wrong, bounded before it goes on the wire. */
    readonly detail: string;
    /** The in-panel guidance offered with it. */
    readonly guidance: string;
}

/** What the guards decided about one offered run. */
export type GuardVerdict =
    /** Every guard passed; the project the host confirmed rides along. */
    | { readonly kind: 'pass'; readonly project: GuestProject }
    /** A fail-closed guard refused before any authorization was requested. */
    | { readonly kind: 'refused'; readonly failure: GuardFailure }
    /** The mount went away while a guard was checking. */
    | { readonly kind: 'interrupted' };

/**
 * Whether the mount is still alive mid-tick.
 *
 * A function call, so the type analyzer never narrows a check past it.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
export function stillRunning(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Split one `owner/name` repository label into its reference.
 *
 * @param label - The `owner/name` string.
 * @returns The reference.
 */
export function splitRepository(label: string): { readonly owner: string; readonly name: string } {
    const index = label.indexOf('/');
    if (index === -1) {
        return { owner: label, name: '' };
    }

    return { owner: label.slice(0, index), name: label.slice(index + 1) };
}

/**
 * Bound one untrusted or host-supplied string to what the routes accept.
 *
 * `detail` and `guidance` are validated as non-empty on the wire, so an empty
 * input becomes the honest phrase rather than a refusal the operator cannot
 * act on.
 *
 * @param text - Candidate text.
 * @returns The text, trimmed to {@link MAX_BODY_TEXT_CHARS}, never empty.
 */
export function boundedText(text: string): string {
    const trimmed = text.trim().slice(0, MAX_BODY_TEXT_CHARS);

    return trimmed === '' ? 'not stated' : trimmed;
}

/**
 * Check a claimed run's guards before any authorization is requested.
 *
 * @param rt - Panel runtime.
 * @param run - The offered run.
 * @returns The verdict, carrying the confirmed project when it passes.
 */
export async function guardRun(rt: PanelRuntime, run: ClaimedRun): Promise<GuardVerdict> {
    const binding = rt.state.bindings.bindings.find((candidate) => candidate.bindingId === run.bindingId) ?? null;
    if (binding === null) {
        return {
            kind: 'refused',
            failure: {
                reason: 'binding-missing',
                detail: `binding "${run.bindingId}" is no longer in this tab`,
                guidance: 're-create the repository binding, then retry',
            },
        };
    }

    if (binding.state !== 'active') {
        return {
            kind: 'refused',
            failure: {
                reason: 'binding-missing',
                detail: `binding "${run.bindingId}" is disabled`,
                guidance: 'enable the repository binding, then retry',
            },
        };
    }

    const project = await resolveProject(rt.host, run.projectId);
    if (!stillRunning(rt)) {
        return { kind: 'interrupted' };
    }

    if (!project.ok) {
        return {
            kind: 'refused',
            failure: {
                reason: 'project-missing',
                detail: project.problem,
                guidance: 'register the project in OpenChamber, then retry',
            },
        };
    }

    return { kind: 'pass', project: project.project };
}

/**
 * Report one guard refusal as `blocked:<reason>` instead of draining the run.
 *
 * Nothing in the mount can re-open the target — a binding that vanished or a
 * project the host no longer lists — so the service holds the run in
 * `blocked:<reason>` where the operator can see the cause and retry
 * once it clears, rather than the panel pretending the run was dispatched.
 *
 * @param input - Runtime, the offered run, and why the guard refused.
 */
export async function refuseWithBlocked(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** What the guard found. */
    readonly failure: GuardFailure;
}): Promise<void> {
    const { rt, run, failure } = input;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: RELAY_LEDGER_KIND,
        correlationId: run.correlationId,
        detail: {
            correlationId: run.correlationId,
            repository: repositoryLabel(splitRepository(run.repository)),
            issueId: String(run.issueNumber),
            problem: `blocked:${failure.reason}`,
            detail: boundedText(failure.detail),
        },
    });

    const body = JSON.stringify({
        correlationId: run.correlationId,
        leaseId: run.lease.leaseId,
        attempt: run.attempt,
        blockedReason: failure.reason,
        detail: boundedText(failure.detail),
        guidance: boundedText(failure.guidance),
    });
    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: blockedPath(run.correlationId),
        body,
    });
    if (!stillRunning(rt)) {
        return;
    }

    rt.state.bindings.note = answer.ok
        ? redact(`Run ${run.correlationId} was not started: ${failure.detail}`)
        : redact(`Run ${run.correlationId} was refused by a guard, and the service could not record it: `
            + `${answer.problem}.`);
}

/**
 * The guidance an ordinary `actor-not-allowed` refusal carries.
 *
 * Names the **field**, never a login: the permitted set is configuration and
 * never reaches the panel. And it is true: with a
 * complete reference list, an allow-list edit *is* the remedy — the gate
 * re-judges the same list from the live policy on the retry.
 */
const ALLOW_LIST_GUIDANCE = 'add the GitHub logins that may trigger this repository to the binding\'s allowedUsers, '
    + 'then retry this dispatch';

/**
 * The guidance the same refusal carries when the gate judged a **partial**
 * reference list.
 *
 * The whole point of this branch: `ALLOW_LIST_GUIDANCE` is *false* there. The
 * gate judges the run's **retained** references and the run layer stops
 * retaining at the cap, so the one reference that would have authorized the run
 * may be among the dropped ones — no policy, ever, admits it, and the retry
 * re-judges the same truncated list and refuses identically. Telling an operator
 * to widen a list that cannot widen it is telling them to do something useless
 * (constitution IV), which is the defect this branch exists to close.
 *
 * So it says what is true instead, and it says what *can* be done, which is
 * checked against the affordance table in `dispatches-rows.ts`: a
 * `blocked:<reason>` run offers **Retry and nothing else**, and the service
 * re-judges that retry against the same list — so there is no control that
 * clears this run, and naming one that does not exist would be the same defect
 * in a new sentence. What the operator can do is therefore stated as
 * consequences: the run stays parked, it costs no attempt and no requeue budget,
 * and nothing is waiting on them.
 *
 * Names no login — neither a denied one (the service's `detail` carries those,
 * verbatim) nor a permitted one, which never leaves the service at all.
 *
 */
const TRUNCATED_WINDOW_GUIDANCE = 'this run collected more triggers than the service retains, so the allow-list was '
    + 'judged against an incomplete list: adding a login to allowedUsers cannot clear it, and a retry is refused '
    + 'for the same reason — the run stays parked and costs no attempt or requeue budget';

/**
 * The guard failure for the actor-policy gate's refusal, or `null` for any other.
 *
 * Narrowed on the **code**, never on the status: `stale-lease`,
 * `already-reserved`, and `cause-not-cleared` are `409` too, and reporting one
 * of those as a policy denial would be this panel announcing a verdict the
 * service never reached — the drift 003 exists to end.
 *
 * The service's own message is carried **verbatim** (it names every denied login
 * and its attribution basis, FR-077), and the guidance names the **field** that
 * restricts the binding rather than any login: the permitted set is
 * configuration and never reaches the panel.
 *
 * **The guidance branches on the refusal's `referenceWindow` word, never on the
 * message.** The service is the only thing that knows which list its decision
 * saw (it read the run inside its own chain task), so a panel that matched the
 * message would be a second parse of prose this panel is only obliged to copy —
 * reworded upstream, it would silently revert to advice that cannot work. An
 * absent word (an older service) or one this build does not know takes
 * {@link ALLOW_LIST_GUIDANCE}, which is the behaviour that existed before this
 * branch and the safe direction to be wrong in: unhelpful advice costs an
 * operator a wasted edit, whereas the wrong branch would have them dead-letter a
 * run one login would have dispatched.
 *
 * @param refusal - The refusal's own members, as the answer carried them.
 * @returns The failure to report as `blocked:actor-not-allowed`, else `null`.
 */
export function actorGateFailure(refusal: {
    /** The machine code, or `null` when the service sent none. */
    readonly code: string | null;
    /** The service's own copy, or `null` when it sent none. */
    readonly message: string | null;
    /** The window the gate judged, as the envelope words it; `null` when none. */
    readonly referenceWindow: ReferenceWindow | null;
}): GuardFailure | null {
    if (refusal.code !== ACTOR_NOT_ALLOWED) {
        return null;
    }

    return {
        reason: ACTOR_NOT_ALLOWED,
        detail: refusal.message ?? 'nobody who triggered this run is on the binding\'s allow-list',
        guidance: refusal.referenceWindow === 'truncated' ? TRUNCATED_WINDOW_GUIDANCE : ALLOW_LIST_GUIDANCE,
    };
}

/**
 * Ask the service to authorize this attempt; never throws.
 *
 * A refusal — stale lease, already reserved, already dispatched, invalid
 * transition — is surfaced on the note line and ends the attempt, which is what
 * keeps the host call out of reach after any refusal. The **one** refusal
 * that additionally owes a `blocked:` report is the actor-policy gate's,
 * and it arrives as `failure` for {@link refuseWithBlocked} to post.
 *
 * @param rt - Panel runtime.
 * @param run - The offered run.
 * @returns The reservation, or the refusal — carrying the gate's failure when
 *   this refusal is the gate's.
 */
export async function reserveRun(rt: PanelRuntime, run: ClaimedRun): Promise<ReserveOutcome> {
    const body = JSON.stringify({
        correlationId: run.correlationId,
        leaseId: run.lease.leaseId,
        attempt: run.attempt,
    });
    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: reservePath(run.correlationId),
        body,
    });
    if (!stillRunning(rt)) {
        return { kind: 'refused' };
    }

    if (!answer.ok) {
        rt.state.bindings.note = redact(`Run ${run.correlationId} was not authorized to start: ${answer.problem}`
            + `${answer.code === null ? '' : ` (${answer.code})`}.`);

        // The actor-policy gate's refusal is the one this panel *reports* rather
        // than merely notes. The service's answer is the authority,
        // and the block report is this panel's account of it — through the
        // operation every other guard already uses, with no new route and no
        // second membership comparison of its own. The window rides with
        // the code for the same reason: the guidance may only be honest about a
        // truncated list if the decision that saw it says so.
        const gate = actorGateFailure({
            code: answer.code,
            message: answer.message,
            referenceWindow: answer.referenceWindow,
        });

        return { kind: 'refused', ...(gate === null ? {} : { failure: gate }) };
    }

    const unreadable = `Run ${run.correlationId}: the service's authorization could not be read, so nothing`
        + ' was started.';
    const reserved = parseReserveBody(answer.body);
    if (reserved === null) {
        rt.state.bindings.note = unreadable;

        return { kind: 'refused' };
    }

    if (reserved.correlationId !== run.correlationId || reserved.attempt !== run.attempt) {
        rt.state.bindings.note = unreadable;

        return { kind: 'refused' };
    }

    if (!reserved.auditWritten) {
        rt.state.bindings.note = `Run ${run.correlationId} was authorized, but its reservation could not be added to`
            + ' the audit trail — the run is live and the trail is short one row.';
    }

    return { kind: 'reserved', reservation: reserved };
}

/**
 * Tell the service a reserved attempt was abandoned before any host call.
 *
 * The only way to reach this is the mount closing between the reserve and the
 * start: every guard runs *before* the reserve, so there is no post-reserve
 * guard refusal to report. Reporting it keeps the run out of `unconfirmed`
 * (contract §3).
 *
 * @param input - Runtime, the run, and the token the reservation holds.
 */
export async function abandonReservation(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** The single-use token the reservation holds. */
    readonly token: string;
}): Promise<void> {
    const { rt, run, token } = input;
    const body = JSON.stringify({
        correlationId: run.correlationId,
        attempt: run.attempt,
        dispatchToken: token,
        reason: 'panel closed after reserving, before the host call',
    });
    await servicePost({ serviceRequest: rt.host.serviceRequest, path: abandonPath(run.correlationId), body });
}
