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
import type { PanelRuntime } from './panel-state.ts';

/** How often the relay polls the service, in milliseconds. */
export const RELAY_POLL_INTERVAL_MS = 10_000;

/** Ledger kind the relay records its results under (same kind the spike uses). */
export const RELAY_LEDGER_KIND = 'session';

/** Longest `problem`/`detail`/`guidance` the run-scoped routes accept (1,000). */
const MAX_BODY_TEXT_CHARS = 1_000;

/** Problem recorded when a start made no session and named no cause. */
export const NO_SESSION_PROBLEM = 'no-session';

/** The four-value vocabulary the block report validates (contract §4). */
type BlockedReason = 'binding-missing' | 'project-missing';

/** Why one fail-closed guard refused a dispatch before any host call. */
export interface GuardFailure {
    /** The declared cause, in the service's four-value set. */
    readonly reason: BlockedReason;
    /** What specifically is wrong, bounded before it goes on the wire. */
    readonly detail: string;
    /** The in-panel guidance offered with it (FR-042). */
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
    if (index < 0) {
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
    const binding = rt.state.repos.bindings.find((candidate) => candidate.bindingId === run.bindingId) ?? null;
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
 * `blocked:<reason>` (FR-042) where the operator can see the cause and retry
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

    rt.state.repos.note = answer.ok
        ? redact(`Run ${run.correlationId} was not started: ${failure.detail}`)
        : redact(`Run ${run.correlationId} was refused by a guard, and the service could not record it: `
            + `${answer.problem}.`);
}

/**
 * Ask the service to authorize this attempt; never throws.
 *
 * A refusal — stale lease, already reserved, already dispatched, invalid
 * transition — is surfaced on the note line and returns `null`, which is what
 * keeps the host call out of reach after any refusal (FR-028).
 *
 * @param rt - Panel runtime.
 * @param run - The offered run.
 * @returns The reservation, or `null` when the service refused or the answer
 *   was not an authorization this build can use.
 */
export async function reserveRun(rt: PanelRuntime, run: ClaimedRun): Promise<ReserveAnswer | null> {
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
        return null;
    }

    if (!answer.ok) {
        rt.state.repos.note = redact(`Run ${run.correlationId} was not authorized to start: ${answer.problem}`
            + `${answer.code === null ? '' : ` (${answer.code})`}.`);

        return null;
    }

    const unreadable = `Run ${run.correlationId}: the service's authorization could not be read, so nothing`
        + ' was started.';
    const reserved = parseReserveBody(answer.body);
    if (reserved === null) {
        rt.state.repos.note = unreadable;

        return null;
    }

    if (reserved.correlationId !== run.correlationId || reserved.attempt !== run.attempt) {
        rt.state.repos.note = unreadable;

        return null;
    }

    if (!reserved.auditWritten) {
        rt.state.repos.note = `Run ${run.correlationId} was authorized, but its reservation could not be added to`
            + ' the audit trail — the run is live and the trail is short one row.';
    }

    return reserved;
}

/**
 * Tell the service a reserved attempt was abandoned before any host call.
 *
 * The only way to reach this is the mount closing between the reserve and the
 * start: every guard runs *before* the reserve, so there is no post-reserve
 * guard refusal to report. Reporting it keeps the run out of `unconfirmed`
 * (contract §3, FR-026).
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
