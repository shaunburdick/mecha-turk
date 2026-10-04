/**
 * Host-owned project, worktree, and session verification (T007).
 *
 * The panel asks OpenChamber for its own state and records what comes back:
 * three documented list calls, four documented subscriptions, the session
 * lifecycle phases observed during the probe, and every partial failure as a
 * problem. Nothing here creates or mutates a project, worktree, or session.
 */

import type { GuestProjectsSnapshot, GuestSessionsSnapshot, GuestWorktreesSnapshot } from '@openchamber/sdk';
import type { LedgerDetail } from './ledger.ts';
import { describeError } from './session.ts';
import type { PanelHost } from './session.ts';

/** Result of probing one host subscription. */
export interface SubscriptionProbe {
    /** Which documented subscription was probed. */
    readonly surface: 'projects' | 'worktrees' | 'sessions' | 'session-lifecycle';
    /** Whether registration succeeded. */
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

/** How long each subscription probe listens for its replayed snapshot. */
const DEFAULT_PROBE_WAIT_MS = 75;

/** Inputs for {@link verifyHostState}. */
interface VerifyHostInput {
    /** Documented host client. */
    readonly host: PanelHost;
    /** Resolved project id. */
    readonly projectId: string;
    /** Optional probe window override. */
    readonly waitMs?: number;
}

/** Evidence collected from the host about project, worktree, and session state. */
export interface HostVerification {
    /** Project id the panel asked about. */
    readonly projectId: string;
    /** Whether the configured project id exists in `listProjects()`. */
    readonly projectFound: boolean;
    /** Directory of the resolved project, or `null` when unresolved. */
    readonly projectDirectory: string | null;
    /** How many projects the host reports. */
    readonly projectCount: number;
    /** How many worktrees the host reports for the project. */
    readonly worktreeCount: number;
    /** Branch names the host reports for the project's worktrees. */
    readonly worktreeBranches: readonly string[];
    /** How many sessions the host reports for the project. */
    readonly sessionCount: number;
    /** Session ids the host reports for the project. */
    readonly sessionIds: readonly string[];
    /** Results of the four documented subscription probes. */
    readonly probes: readonly SubscriptionProbe[];
    /** Session lifecycle phases observed during verification. */
    readonly lifecyclePhases: readonly string[];
    /** Partial failures and problems; empty when verification was clean. */
    readonly problems: readonly string[];
}

/**
 * Wait for a short, bounded interval.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise resolved after the interval.
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
 * @param subscribe - Registration function from the host client.
 * @param waitMs - How long to listen for the replayed snapshot.
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

/** One subscription probe to attach to the shared collector. */
interface ProbeInput<T> {
    /** Surface name recorded on the probe. */
    readonly surface: SubscriptionProbe['surface'];
    /** Registration function from the host client. */
    readonly subscribe: (listener: (snapshot: T) => void) => Promise<() => void>;
    /** How long to listen for the replayed snapshot. */
    readonly waitMs: number;
}

/** Mutable collector shared by the subscription probes. */
interface ProbeState {
    readonly probes: SubscriptionProbe[];
    readonly teardowns: (() => void)[];
    readonly problems: string[];
    readonly lifecyclePhases: string[];
}

/**
 * Attach one probe to the shared collector.
 *
 * @param input - Surface name, subscribe function, and listen window.
 * @param state - Collector to update.
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
 * @param host - Host client.
 * @param state - Collector to update.
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
 *
 * @param input - Host client, collector, and probe window.
 */
async function probeLifecycle(input: {
    /** Host client. */
    readonly host: Pick<PanelHost, 'onSessionLifecycle'>;
    /** Collector to update. */
    readonly state: ProbeState;
    /** How long to observe for a lifecycle event. */
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
 *
 * @param input - Host client, project id, and listen window.
 * @returns Probes, teardowns, problems, and observed lifecycle phases.
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

/** Snapshots of the three documented list calls. */
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
 *
 * @param input - Host client and project id.
 * @returns List snapshots plus every problem encountered.
 */
async function readLists(input: { host: PanelHost; projectId: string }): Promise<HostLists> {
    const problems: string[] = [];
    let projectFound = false;
    let projectDirectory: string | null = null;
    let projectCount = 0;
    let worktreeCount = 0;
    let worktreeBranches: string[] = [];
    let sessionCount = 0;
    let sessionIds: string[] = [];

    try {
        const projects = await input.host.listProjects();
        const match = projects.projects.find((project) => project.id === input.projectId);
        projectFound = match !== undefined;
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
        projectFound,
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
 *
 * @param input - Host client, resolved project id, and optional probe window.
 * @returns The verification evidence for the ledger.
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
 *
 * @param verification - Verification result.
 * @returns Scalar detail for one `host-verify` ledger entry.
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
