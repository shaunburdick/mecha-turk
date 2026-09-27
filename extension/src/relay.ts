/**
 * Panel event relay (M4 re-cut): poll the service for claimed relay events
 * and hand each one to the documented `host.startSession()` dispatch.
 *
 * The loop reuses the spike's dispatch machinery — `resolveProject`,
 * `buildBoundedContext`, `buildStartSessionRequest`, and the start-session
 * summary — but the source of truth is the *binding* the service snapshot
 * carried, not the operator settings: a repository binding is the reason a
 * relay event exists. One-dispatch-per-mount keeps an event id honest
 * across re-polls; the ledger records every attempt.
 *
 * MVP-DEBT: no re-fetch of the issue source between the claim and the
 * dispatch. The service detected the assignment seconds ago; the "source
 * changed" guard of the spike flow is re-built in Slice 2 if the loop turns
 * out to need it.
 */

import type { GuestProject } from '@openchamber/sdk';
import { parseWorktreeOption, repositoryLabel } from './config.ts';
import type { RepositoryRef, WorktreeSelection } from './config.ts';
import { nowIso } from './ids.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { parsePendingBody } from './repos-service.ts';
import type { RelayEvent } from './repos-service.ts';
import { EVENTS_PENDING_PATH, dispatchedPath, serviceGet, servicePost } from './service-calls.ts';
import {
    buildBoundedContext,
    buildStartSessionRequest,
    resolveProject,
    summarizeStartSessionResult,
} from './session.ts';
import type { PanelRuntime } from './panel-state.ts';

/** How often the relay polls the service, in milliseconds. */
export const RELAY_POLL_INTERVAL_MS = 10_000;

/** Ledger kind the relay records its results under (same kind the spike uses). */
const RELAY_LEDGER_KIND = 'session';

/** Problem string recorded when a start made no session and named no cause. */
const NO_SESSION_PROBLEM = 'no-session';

/** Problem string recorded when the binding vanished before the dispatch. */
const BINDING_MISSING_PROBLEM = 'binding-missing-at-dispatch';

/**
 * Whether the mount is still alive mid-tick.
 *
 * A function call, so the type analyzer never narrows a check past it.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillRunning(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Split one `owner/name` repository label into its reference.
 *
 * @param label - The `owner/name` string.
 * @returns The reference.
 */
function splitRepository(label: string): RepositoryRef {
    const index = label.indexOf('/');
    if (index < 0) {
        return { owner: label, name: '' };
    }

    return { owner: label.slice(0, index), name: label.slice(index + 1) };
}

/** One dispatch outcome the panel reports to the service. */
interface DispatchOutcome {
    /** Created session id, when the host made one. */
    readonly sessionId?: string;
    /** Problem text the panel recorded otherwise. */
    readonly problem?: string;
}

/**
 * Report one dispatch result to the service; never throws.
 *
 * @param input - Runtime, the claimed event, and the outcome.
 */
async function reportDispatch(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The claimed event. */
    readonly event: RelayEvent;
    /** The result: a session or a problem. */
    readonly outcome: DispatchOutcome;
}): Promise<void> {
    const { rt, event, outcome } = input;
    const body = JSON.stringify(
        outcome.sessionId === undefined ? { problem: outcome.problem } : { sessionId: outcome.sessionId },
    );

    const report = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: dispatchedPath(event.eventId),
        body,
    });
    if (stillRunning(rt) && !report.ok) {
        rt.state.repos.note = report.problem;
    }
}

/**
 * Append one `session` kind entry carrying a problem, then repaint.
 *
 * @param input - Runtime, event, and the entry detail.
 */
function recordProblemEntry(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The event the entry belongs to. */
    readonly event: RelayEvent;
    /** Scalar detail for the entry. */
    readonly detail: Record<string, string>;
}): void {
    const { rt, event, detail } = input;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: RELAY_LEDGER_KIND,
        correlationId: event.eventId,
        detail,
    });
}

/**
 * Record one blocked event's miss and mark the event dispatched (drained).
 *
 * Nothing in the mount can re-open the target — a binding that vanished or a
 * project the host no longer lists — so the event is terminal, and the
 * problem is recorded on both the ledger and the service queue.
 *
 * @param input - Runtime, event, problem, and the skip note.
 */
async function recordMiss(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The event the cycle could not dispatch. */
    readonly event: RelayEvent;
    /** The blocking problem. */
    readonly problem: string;
}): Promise<void> {
    const { rt, event, problem } = input;
    if (problem === BINDING_MISSING_PROBLEM) {
        rt.state.repos.note = redact(`Event ${event.eventId} has no binding left in this tab — skipped.`);
    }

    recordProblemEntry({
        rt,
        event,
        detail: {
            eventId: event.eventId,
            repository: event.repository,
            issueId: String(event.issueNumber),
            problem,
        },
    });
    await reportDispatch({ rt, event, outcome: { problem } });
}

/** One claimed event paired with the project its binding named. */
interface StartInputs {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The claimed event. */
    readonly event: RelayEvent;
    /** Project the host confirmed. */
    readonly project: GuestProject;
}

/**
 * Build the start-session request one claimed event maps into.
 *
 * @param input - Runtime, event, and resolved project.
 * @returns The request exactly as the host will receive it.
 */
function eventRequestOf(input: StartInputs): ReturnType<typeof buildStartSessionRequest> {
    const { rt, event } = input;
    const worktree: WorktreeSelection = parseWorktreeOption(event.worktreeOption) ?? { kind: 'none' };
    const issue = {
        issueNumber: event.issueNumber,
        title: event.issueTitle,
        url: event.issueUrl,
        state: 'open' as const,
        body: event.issueBodyExcerpt === '' ? null : event.issueBodyExcerpt,
        assignees: [event.accountLogin],
        isPullRequest: false,
    };
    const context = buildBoundedContext({
        repository: event.repository,
        issue,
        authenticatedLogin: event.accountLogin,
        correlationId: event.eventId,
    });

    return buildStartSessionRequest({
        config: {
            repository: splitRepository(event.repository),
            expectedLogin: event.accountLogin,
            projectId: event.projectId,
            worktree,
            pollIntervalMs: RELAY_POLL_INTERVAL_MS,
        },
        // MVP-DEBT: the relay borrows the spike's evidence schema, so the
        // trigger literal stays the spike's; the relay's own framing lives in
        // the PM context line and the ledger entry.
        evidence: {
            schemaVersion: 'extension-spike-1',
            repository: event.repository,
            issueId: String(event.issueNumber),
            issueUrl: event.issueUrl,
            trigger: 'configured-match',
            authenticatedLogin: event.accountLogin,
            correlationId: event.eventId,
            detectedAt: event.detectedAt,
            panelGeneration: rt.state.ledger.panelGeneration,
        },
        issue,
        context,
    });
}

/**
 * Build the request one claimed event maps into and send it to the host.
 *
 * @param input - Runtime, event, and resolved project.
 */
async function startForEvent(input: StartInputs): Promise<void> {
    const { rt, event, project } = input;
    const request = eventRequestOf(input);
    const summary = summarizeStartSessionResult(await rt.host.startSession(request));
    if (!stillRunning(rt)) {
        return;
    }

    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: RELAY_LEDGER_KIND,
        correlationId: event.eventId,
        detail: {
            eventId: event.eventId,
            repository: repositoryLabel(splitRepository(event.repository)),
            projectId: project.id,
            worktreeOption: event.worktreeOption,
            trigger: event.triggerNote,
            ...summary,
        },
    });
    const outcome = summary.sessionId === null
        ? ({ problem: String(summary.failure ?? NO_SESSION_PROBLEM) } as DispatchOutcome)
        : ({ sessionId: String(summary.sessionId) } as DispatchOutcome);
    await reportDispatch({ rt, event, outcome });
}

/** One cycle's dispatch attempt bundle, before the resolution. */
interface TryInputs {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The claimed event. */
    readonly event: RelayEvent;
}

/**
 * Run one event's dispatch attempt, or record the miss that blocked it.
 *
 * @param input - Runtime and the event to try.
 */
async function tryDispatch(input: TryInputs): Promise<void> {
    const { rt, event } = input;
    const binding = rt.state.repos.bindings.find((candidate) => candidate.bindingId === event.bindingId) ?? null;
    if (binding === null) {
        await recordMiss({ rt, event, problem: BINDING_MISSING_PROBLEM });

        return;
    }

    const project = await resolveProject(rt.host, event.projectId);
    if (!stillRunning(rt)) {
        return;
    }

    if (!project.ok) {
        await recordMiss({ rt, event, problem: project.problem });

        return;
    }

    await startForEvent({ rt, event, project: project.project });
}

/**
 * Dispatch one claimed event; never throws.
 *
 * The dispatch guard is one observed handoff per event id per mount, so a
 * re-poll can never double-start the same event, whatever the service did.
 *
 * @param rt - Panel runtime.
 * @param event - The event to dispatch.
 */
export async function dispatchQueuedEvent(rt: PanelRuntime, event: RelayEvent): Promise<void> {
    const dispositioned = rt.state.relay.handled.includes(event.eventId);
    if (rt.disposed || rt.state.relay.dispatching || rt.state.busy || dispositioned) {
        return;
    }

    rt.state.relay.handled = [...rt.state.relay.handled, event.eventId];
    rt.state.relay.dispatching = true;
    rt.state.busy = true;
    refresh(rt);

    try {
        await tryDispatch({ rt, event });
    } finally {
        rt.state.relay.dispatching = false;
        rt.state.busy = false;
        refresh(rt);
    }
}

/**
 * Claim one batch of events from the service.
 *
 * @param rt - Panel runtime.
 * @returns The claimed events, or `null` when the service refused.
 */
async function claimEvents(rt: PanelRuntime): Promise<readonly RelayEvent[] | null> {
    const fetched = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: EVENTS_PENDING_PATH });
    if (!fetched.ok || !stillRunning(rt)) {
        return null;
    }

    const parsed = parsePendingBody(fetched.body);
    if (parsed !== null) {
        rt.state.repos.statusRows = parsed.status;
    }

    return parsed === null ? null : parsed.events;
}

/**
 * One relay tick: claim, dispatch each, and repaint. Never throws.
 *
 * @param rt - Panel runtime.
 */
export async function pollRelay(rt: PanelRuntime): Promise<void> {
    if (rt.disposed || rt.state.relay.inFlight || rt.state.busy) {
        return;
    }

    rt.state.relay.inFlight = true;
    try {
        const claim = await claimEvents(rt);
        if (claim !== null && stillRunning(rt)) {
            for (const event of claim) {
                await dispatchQueuedEvent(rt, event);
            }
        }

        if (stillRunning(rt)) {
            rt.state.relay.lastPollAt = nowIso();
        }
    } finally {
        rt.state.relay.inFlight = false;
        refresh(rt);
    }
}

/**
 * Arm the relay loop: one immediate poll, then the interval.
 *
 * The timer is unref'd, so it never keeps an idle process alive; teardown
 * clears it through {@link stopRelayPolling}.
 *
 * @param rt - Panel runtime.
 */
export function startRelayPolling(rt: PanelRuntime): void {
    if (rt.relayArmed || rt.disposed) {
        return;
    }

    rt.relayArmed = true;
    rt.state.relay.timer = setInterval(() => {
        void pollRelay(rt);
    }, RELAY_POLL_INTERVAL_MS);
    if (typeof rt.state.relay.timer.unref === 'function') {
        rt.state.relay.timer.unref();
    }

    void pollRelay(rt);
}

/**
 * Stop the relay loop.
 *
 * @param rt - Panel runtime.
 */
export function stopRelayPolling(rt: PanelRuntime): void {
    rt.relayArmed = false;
    if (rt.state.relay.timer !== null) {
        clearInterval(rt.state.relay.timer);
        rt.state.relay.timer = null;
    }
}
