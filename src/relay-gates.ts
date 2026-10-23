/**
 * The gates between a claim and the host call: refuse first, resolve the project before the reservation (FR-028).
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

export const RELAY_POLL_INTERVAL_MS = 10_000;

export const RELAY_LEDGER_KIND = 'session';

const MAX_BODY_TEXT_CHARS = 1_000;

export const NO_SESSION_PROBLEM = 'no-session';

/**
 * The declared blocked causes this panel ever names (contract §4): a
 * **subset** of the service's five — the two guards this panel can see locally
 * plus the actor-policy gate's answer. `credential` and `policy` are declared
 * so a run's state parses, but no panel guard in this build produces them, so
 * this panel never sends them. `BlockedReason[0]` and
 * {@link ACTOR_NOT_ALLOWED} are two declarations of one word, unavoidable
 * across the extension/service boundary, and `tests/relay-integrity.test.ts`
 * carries the **drift test** that keeps them honest.
 */
export type BlockedReason = 'binding-missing' | 'project-missing' | 'actor-not-allowed';

export const ACTOR_NOT_ALLOWED = 'actor-not-allowed';

/**
 * What one reserve call answered: a union rather than `ReserveAnswer | null`
 * because the **actor-policy gate's** refusal has to travel somewhere — the
 * panel owes the run a `blocked:` report for it, which a bare `null` cannot
 * distinguish from a stale-lease refusal the service merely notes. Every other
 * refusal stays as before: one kind, no failure, the run ends.
 */
export type ReserveOutcome =
    | { readonly kind: 'reserved'; readonly reservation: ReserveAnswer }
    | { readonly kind: 'refused'; readonly failure?: GuardFailure };

/** Why one fail-closed guard refused a dispatch before any host call. */
export interface GuardFailure {
    readonly reason: BlockedReason;
    readonly detail: string;
    readonly guidance: string;
}

export type GuardVerdict =
    | { readonly kind: 'pass'; readonly project: GuestProject }
    | { readonly kind: 'refused'; readonly failure: GuardFailure }
    | { readonly kind: 'interrupted' };

/**
 * Whether the mount is still alive mid-tick.
 *
 * A function call, so the type analyzer never narrows a check past it.
 */
export function stillRunning(rt: PanelRuntime): boolean {
    return !rt.disposed;
}

/**
 * Split one `owner/name` repository label into its reference.
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
 * @returns The text, trimmed to {@link MAX_BODY_TEXT_CHARS}, never empty.
 */
export function boundedText(text: string): string {
    const trimmed = text.trim().slice(0, MAX_BODY_TEXT_CHARS);

    return trimmed === '' ? 'not stated' : trimmed;
}

/**
 * Check a claimed run's guards before any authorization is requested.
 *
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
 */
export async function refuseWithBlocked(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
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

    const because = answer.ok
        ? `not started: ${failure.detail}`
        : `refused by a guard, and the service could not record it: ${answer.problem}.`;
    rt.state.bindings.note = redact(`Run ${run.correlationId} was ${because}`);
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
 * The guidance the same refusal carries when the gate judged a **partial** reference list:
 * `ALLOW_LIST_GUIDANCE` is *false* there — the gate judges the **retained** references and
 * retention stops at the cap, so the reference that would have authorized the run may be among the
 * dropped, and telling an operator to widen a list that cannot widen is useless advice
 * (constitution IV). It therefore states what *can* be done, checked against `dispatches-rows.ts`'s
 * affordance table: a `blocked:<reason>` run offers **Retry and nothing else** — consequences
 * named, no nonexistent control, no login: denied ones ride the service's `detail` verbatim and a
 * permitted one never leaves the service at all.
 */
const TRUNCATED_WINDOW_GUIDANCE = 'this run collected more triggers than the service retains, so the allow-list was '
    + 'judged against an incomplete list: adding a login to allowedUsers cannot clear it, and a retry is refused '
    + 'for the same reason — the run stays parked and costs no attempt or requeue budget';

/**
 * The guard failure for the actor-policy gate's refusal, or `null` for any other. Narrowed on the
 * **code**, never the status: `stale-lease`, `already-reserved` and `cause-not-cleared` are `409`
 * too, and reporting one as a policy denial would announce a verdict the service never reached.
 * The service's message is carried **verbatim** (it names every denied login and its basis,
 * FR-077); the guidance names the **field** restricting the binding, since the permitted set never
 * reaches the panel. The branch is on the refusal's `referenceWindow` word, never the prose — an
 * absent or unknown word takes {@link ALLOW_LIST_GUIDANCE}: unhelpful advice costs an edit, the
 * wrong branch would have them dead-letter a run one login would have dispatched.
 */
export function actorGateFailure(refusal: {
    readonly code: string | null;
    readonly message: string | null;
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
 * Ask the service to authorize this attempt; never throws. Any refusal —
 * stale lease, already reserved, already dispatched, invalid transition — is
 * surfaced on the note line and ends the attempt, which keeps the host call out
 * of reach after any refusal; the **one** refusal that additionally owes a
 * `blocked:` report is the actor-policy gate's, arriving as `failure` for
 * {@link refuseWithBlocked} to post.
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

        return { kind: 'refused', ...(gate !== null && { failure: gate }) };
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

export const DISPOSED_ABANDON_REASON = 'panel closed after reserving, before the host call';

export const RECORD_REFUSED_ABANDON_REASON =
    'host storage refused the dispatch record write, so no session was started';

/** Tell the service a reserved attempt was abandoned before any host call, and record it in the ledger when asked. */
export async function abandonReservation(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
    readonly token: string;
    /** The cause, in the panel's own words. */
    readonly reason: string;
    /** Only the refused-intent path owes a ledger entry (FR-046). */
    readonly requiresLedgerEntry?: boolean;
}): Promise<void> {
    const { rt, run, token, reason, requiresLedgerEntry = false } = input;
    if (requiresLedgerEntry) {
        appendEntryAndPersist(rt, {
            at: nowIso(),
            kind: RELAY_LEDGER_KIND,
            correlationId: run.correlationId,
            detail: {
                correlationId: run.correlationId,
                repository: repositoryLabel(splitRepository(run.repository)),
                issueId: String(run.issueNumber),
                sessionId: null,
                sent: 'skipped',
                failure: boundedText(reason),
            },
        });
    }

    const body = JSON.stringify({
        correlationId: run.correlationId,
        attempt: run.attempt,
        dispatchToken: token,
        reason: boundedText(reason),
    });
    await servicePost({ serviceRequest: rt.host.serviceRequest, path: abandonPath(run.correlationId), body });
}
