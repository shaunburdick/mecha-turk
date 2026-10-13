/**
 * Host-owned project, worktree, and session verification (T007): three
 * documented list calls, four documented subscriptions, the session phases
 * observed during the probe, and every partial failure recorded as a problem
 * — nothing here creates or mutates a project, worktree, or session.
 */

import type { GuestProjectsSnapshot, GuestSessionsSnapshot, GuestWorktreesSnapshot } from '@openchamber/sdk';
import type { LedgerDetail } from './ledger.ts';
import { describeError } from './session.ts';
import type { PanelHost } from './session.ts';

export interface SubscriptionProbe {
    readonly surface: 'projects' | 'worktrees' | 'sessions' | 'session-lifecycle';
    readonly registered: boolean;
    /**
     * Whether the subscription delivered something while the probe listened.
     *
     * The three snapshot surfaces replay their current state on registration;
     * `session-lifecycle` is an event stream that replays only when the host
     * has seen a lifecycle event before. A silent listener is therefore only a
     * failure when {@link SubscriptionProbe.replayExpected} says it is.
     */
    readonly snapshotReplayed: boolean;
    /**
     * Whether this surface is documented to replay on registration.
     *
     * `false` for `session-lifecycle`: registration is the only guarantee the
     * host makes, so "nothing replayed" is a fresh host, not a broken probe.
     */
    readonly replayExpected: boolean;
    /** Failure description when registration failed; never secret material. */
    readonly error: string | null;
}

const DEFAULT_PROBE_WAIT_MS = 75;

interface VerifyHostInput {
    readonly host: PanelHost;
    readonly projectId: string;
    readonly waitMs?: number;
}

export interface HostVerification {
    readonly projectId: string;
    readonly projectFound: boolean;
    readonly projectDirectory: string | null;
    readonly projectCount: number;
    readonly worktreeCount: number;
    readonly worktreeBranches: readonly string[];
    readonly sessionCount: number;
    readonly sessionIds: readonly string[];
    readonly probes: readonly SubscriptionProbe[];
    readonly lifecyclePhases: readonly string[];
    readonly problems: readonly string[];
}

/**
 * Wait for a short, bounded interval.
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** Deliberately empty teardown used when a subscription never registered. */
function noop(): void {
    // Nothing to release: registration failed before anything was acquired.
}

/**
 * Register a subscription briefly, capture its replayed snapshot, then leave.
 *
 * The documented subscriptions replay their current state on registration, so
 * a short listen is enough to prove the subscription works without holding one
 * of the host's 32 per-frame slots for the rest of the panel's life.
 *
 * @returns The captured snapshot (or `null`), any registration error, and a teardown.
 */
async function probeSubscription<T>(
    subscribe: (listener: (snapshot: T) => void) => Promise<() => void>,
    waitMs: number,
): Promise<{ readonly snapshot: T | null; readonly error: string | null; readonly teardown: () => void }> {
    let captured: T | null = null;
    let release: () => void;

    try {
        release = await subscribe((snapshot) => {
            captured = snapshot;
        });
    } catch (cause) {
        return { snapshot: null, error: describeError(cause), teardown: noop };
    }

    await delay(waitMs);

    return { snapshot: captured, error: null, teardown: release };
}

interface ProbeInput<T> {
    readonly surface: SubscriptionProbe['surface'];
    readonly subscribe: (listener: (snapshot: T) => void) => Promise<() => void>;
    readonly waitMs: number;
}

interface ProbeState {
    readonly probes: SubscriptionProbe[];
    readonly teardowns: (() => void)[];
    readonly problems: string[];
    readonly lifecyclePhases: string[];
}

/**
 * Attach one probe to the shared collector.
 */
async function addProbe<T>(input: ProbeInput<T>, state: ProbeState): Promise<void> {
    const probe = await probeSubscription(input.subscribe, input.waitMs);
    state.teardowns.push(probe.teardown);
    state.probes.push({
        surface: input.surface,
        registered: probe.error === null,
        snapshotReplayed: probe.snapshot !== null,
        replayExpected: true,
        error: probe.error,
    });
    if (probe.error !== null) {
        state.problems.push(`${input.surface}: ${probe.error}`);
    }
}

/**
 * Register the lifecycle listener, recording the probe when registration fails.
 *
 * @returns The teardown for the registered listener, or `null` on refusal.
 */
function registerLifecycleListener(
    host: Pick<PanelHost, 'onSessionLifecycle'>,
    state: ProbeState,
): (() => void) | null {
    try {
        return host.onSessionLifecycle((event) => {
            state.lifecyclePhases.push(event.phase);
        });
    } catch (cause) {
        const message = describeError(cause);
        state.probes.push({
            surface: 'session-lifecycle',
            registered: false,
            snapshotReplayed: false,
            replayExpected: false,
            error: message,
        });
        state.problems.push(`session-lifecycle: ${message}`);
        return null;
    }
}

/**
 * Observe `host.onSessionLifecycle` for one probe window, then release it.
 *
 * The host replays a lifecycle event only when it has seen one before, so a
 * fresh host stays silent for the whole window. Registration is therefore the
 * only guarantee this surface makes (`replayExpected: false`); the probe still
 * records whether an event arrived while it listened.
 */
async function probeLifecycle(input: {
    readonly host: Pick<PanelHost, 'onSessionLifecycle'>;
    readonly state: ProbeState;
    readonly waitMs: number;
}): Promise<void> {
    const { host, state, waitMs } = input;
    const stop = registerLifecycleListener(host, state);
    if (stop === null) {
        return;
    }

    await delay(waitMs);
    state.teardowns.push(stop);
    state.probes.push({
        surface: 'session-lifecycle',
        registered: true,
        snapshotReplayed: state.lifecyclePhases.length > 0,
        replayExpected: false,
        error: null,
    });
}

/**
 * Register every documented subscription, capture replays, then release them.
 */
async function probeSubscriptions(input: { host: PanelHost; projectId: string; waitMs: number }): Promise<ProbeState> {
    const state: ProbeState = { probes: [], teardowns: [], problems: [], lifecyclePhases: [] };
    const { host, projectId, waitMs } = input;

    await probeLifecycle({ host, state, waitMs });
    const projects: ProbeInput<GuestProjectsSnapshot> = {
        surface: 'projects',
        subscribe: (listener) => host.onProjects(listener),
        waitMs,
    };
    const worktrees: ProbeInput<GuestWorktreesSnapshot> = {
        surface: 'worktrees',
        subscribe: (listener) => host.onWorktrees(projectId, listener),
        waitMs,
    };
    const sessions: ProbeInput<GuestSessionsSnapshot> = {
        surface: 'sessions',
        subscribe: (listener) => host.onSessions(projectId, listener),
        waitMs,
    };
    await addProbe(projects, state);
    await addProbe(worktrees, state);
    await addProbe(sessions, state);
    await delay(waitMs);

    for (const teardown of state.teardowns) {
        teardown();
    }

    return state;
}

interface HostLists {
    readonly projectFound: boolean;
    readonly projectDirectory: string | null;
    readonly projectCount: number;
    readonly worktreeCount: number;
    readonly worktreeBranches: string[];
    readonly sessionCount: number;
    readonly sessionIds: string[];
    readonly problems: string[];
}

/**
 * Read the three documented list APIs, recording partial failures.
 */
async function readLists(input: { host: PanelHost; projectId: string }): Promise<HostLists> {
    const problems: string[] = [];
    let isProjectFound = false;
    let projectDirectory: string | null = null;
    let projectCount = 0;
    let worktreeCount = 0;
    let worktreeBranches: string[] = [];
    let sessionCount = 0;
    let sessionIds: string[] = [];

    try {
        const projects = await input.host.listProjects();
        const match = projects.projects.find((project) => project.id === input.projectId);
        isProjectFound = match !== undefined;
        projectDirectory = match?.directory ?? null;
        projectCount = projects.projects.length;
    } catch (cause) {
        problems.push(`listProjects: ${describeError(cause)}`);
    }

    try {
        const worktrees: GuestWorktreesSnapshot = await input.host.listWorktrees(input.projectId);
        worktreeCount = worktrees.worktrees.length;
        worktreeBranches = worktrees.worktrees.map((tree) => tree.branch);
    } catch (cause) {
        problems.push(`listWorktrees: ${describeError(cause)}`);
    }

    try {
        const sessions: GuestSessionsSnapshot = await input.host.listSessions(input.projectId);
        sessionCount = sessions.sessions.length;
        sessionIds = sessions.sessions.map((session) => session.id);
    } catch (cause) {
        problems.push(`listSessions: ${describeError(cause)}`);
    }

    return {
        projectFound: isProjectFound,
        projectDirectory,
        projectCount,
        worktreeCount,
        worktreeBranches,
        sessionCount,
        sessionIds,
        problems,
    };
}

/**
 * Verify host-owned project, worktree, and session state (T007).
 *
 * Calls every documented list and subscription API, records whether each
 * subscription registered and replayed, observes session lifecycle phases for
 * a short window, and never mutates local state. Failures are recorded as
 * problems instead of being retried through an undocumented path.
 */
export async function verifyHostState(input: VerifyHostInput): Promise<HostVerification> {
    const waitMs = input.waitMs ?? DEFAULT_PROBE_WAIT_MS;
    const lists = await readLists(input);
    const subscriptions = await probeSubscriptions({ host: input.host, projectId: input.projectId, waitMs });
    const problems = [...lists.problems, ...subscriptions.problems];

    return {
        projectId: input.projectId,
        projectFound: lists.projectFound,
        projectDirectory: lists.projectDirectory,
        projectCount: lists.projectCount,
        worktreeCount: lists.worktreeCount,
        worktreeBranches: lists.worktreeBranches,
        sessionCount: lists.sessionCount,
        sessionIds: lists.sessionIds,
        probes: subscriptions.probes,
        lifecyclePhases: subscriptions.lifecyclePhases,
        problems,
    };
}

/**
 * Flatten a verification result into ledger detail values.
 */
export function summarizeHostVerification(verification: HostVerification): LedgerDetail {
    const registered = verification.probes.filter((probe) => probe.registered);
    const replayed = verification.probes.filter((probe) => probe.snapshotReplayed);
    const failed = verification.probes.filter(
        (probe) => !probe.registered || (probe.replayExpected && !probe.snapshotReplayed),
    );

    return {
        projectFound: verification.projectFound,
        projectId: verification.projectId,
        projectDirectory: verification.projectDirectory,
        projectCount: verification.projectCount,
        worktreeCount: verification.worktreeCount,
        worktreeBranches: verification.worktreeBranches.join(','),
        sessionCount: verification.sessionCount,
        sessionIds: verification.sessionIds.join(','),
        lifecyclePhases: verification.lifecyclePhases.join(','),
        probesRegistered: registered.length,
        probesReplayed: replayed.length,
        failedProbeSurfaces: failed.map((probe) => probe.surface).join(','),
        problems: verification.problems.join(' | '),
    };
}
