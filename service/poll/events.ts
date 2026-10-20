/**
 * The service-side event queue (MVP tasks M1/M2): scan findings wait in
 * `events.json` until the panel relays them, deduped by the deterministic
 * event id, and a dispatch is terminal.
 */

import { basename, join } from 'node:path';
import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { PromptSnapshot } from '../prompt.ts';
import type { ServiceStore } from '../store/index.ts';
import { EVENTS_FILE, followUpKindOf, parseStoredEvents } from './events-parse.ts';
import { recordEnqueueAudits } from './events-enqueue-audit.ts';
import { applyEnqueue } from './runs-join.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { readScanState, serializeScan, writeScanState } from './scan.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { BindingScanState } from './scan.ts';

/** Store file holding the event queue (declared beside the row schema). */
export { EVENTS_FILE, subjectTypeOf } from './events-parse.ts';

/**
 * Re-exported: the chain every queue mutation serializes on has exactly one
 * import path, so a rewriting pass (006's excerpt trim) joins the *same* slot
 * an enqueue does instead of keeping a second chain that could race it.
 */
export { inQueueChain };

/** How many dispatched events stay in the file for dedupe and history. */
export const MAX_DISPATCHED_EVENTS = 500;

/** Re-exported: this module stays the one import path for the queue's readers. */
export { followUpKindOf, parseStoredEvent } from './events-parse.ts';
export { parseStoredEvents };

/** Row types re-exported alongside them for the routes and the scan loop. */
export type { EventKind, EventState, FollowUpKind, SubjectType } from './events-parse.ts';
export type { QueuedEvent };
// The attribution basis is declared in `attribution.ts` and re-exported by the
// row's own module, so the queue keeps one import path for it too (002 FR-044).
export type { ActorAttribution } from './events-parse.ts';

/** Re-exported: this module stays the one import path for the queue's writer. */
export { buildEventId, createEvent } from './events-write.ts';
export type {
    AssignmentEventSnapshot,
    EventSnapshot,
    FollowUpCommentSnapshot,
    FollowUpHeadSnapshot,
    FollowUpReviewCommentSnapshot,
    FollowUpReviewSnapshot,
    MentionBodyEventSnapshot,
    MentionEventSnapshot,
    MentionOrigin,
    MentionReviewCommentSnapshot,
    ReviewEventSnapshot,
} from './events-write.ts';

/**
 * The one rule for *this legacy row is finished*, shared by the
 * dispatched-tail cap and 006's excerpt retention pass so the two can never
 * disagree about a row. Terminal is exactly the shipped `dispatched` state:
 * such a row answers `409` to a retry, so neither its tail position nor its
 * payload is reachable again. A row with no `state` — everything 003
 * enqueues — is **not** terminal here: its truth lives on the run, and the
 * excerpt pass reads the linked run itself rather than asking this to guess.
 */
export function isDispatchedTerminal(event: QueuedEvent): boolean {
    return event.state === 'dispatched';
}

/**
 * Serialize the queue into the file's canonical array form.
 *
 * The pending and in-flight events always come forward; the dispatched tail
 * is bounded so the file stays small no matter how long the operator works.
 */
function serializedQueue(events: readonly QueuedEvent[], retainedRunIds?: ReadonlySet<string>): QueuedEvent[] {
    const retained = retainedRunIds === undefined
        ? events
        : events.filter((event) => event.state !== undefined
            || event.runCorrelationId === undefined
            || retainedRunIds.has(event.runCorrelationId));
    const live = retained.filter((event) => !isDispatchedTerminal(event));
    const dispatched = retained.filter((event) => isDispatchedTerminal(event)).slice(-MAX_DISPATCHED_EVENTS);

    return [...live, ...dispatched];
}

/**
 * Quarantine passes this process has already recovered, keyed per store
 * handle by the quarantined file's *name*. A corrupt `events.json` renames
 * to exactly one file name, so keying on the name ties the recovery to the
 * loss rather than to the reader that noticed: the live quarantine, the
 * evidence scan, the panel's claim and any relay read can all spot the same
 * loss without resetting the windows (or writing the audit row) more than
 * once in one process.
 */
const recoveredQuarantines = new WeakMap<ServiceStore, Set<string>>();

/**
 * Claim one quarantine observation for recovery.
 */
function claimQuarantinePass(store: ServiceStore, quarantinePath: string): boolean {
    const handled = recoveredQuarantines.get(store) ?? new Set<string>();
    recoveredQuarantines.set(store, handled);
    if (handled.has(basename(quarantinePath))) {
        return false;
    }

    handled.add(basename(quarantinePath));

    return true;
}

/**
 * Clear every binding's `lastScanAt` and **record that this was a recovery**
 * (002 FR-073, FR-074). The flag is written here and nowhere else, because a
 * cleared stamp alone is indistinguishable from *never scanned*. What it
 * does to the window is nothing — the binding's baseline governs and covers
 * everything the lost queue carried (plan H8) — but it makes recovery
 * legible: never governed by the mode, precedence over a sweep, and
 * tellable to the operator (FR-078, FR-092; constitution IV). `baselineAt`
 * is left untouched: recomputing it from a later clock would shrink the very
 * window the recovery exists to re-open.
 */
async function resetScanWindows(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<number> {
    return await serializeScan(async () => {
        const state = await readScanState(input);
        const bindings: Record<string, BindingScanState> = {};
        let cleared = 0;
        for (const [bindingId, slot] of Object.entries(state.bindings)) {
            const next: BindingScanState =
                slot.lastScanAt === null && slot.forceReplay ? slot : { ...slot, lastScanAt: null, forceReplay: true };
            cleared += next === slot ? 0 : 1;
            bindings[bindingId] = next;
        }

        if (cleared > 0) {
            await writeScanState({ store: input.store, state: { bindings } });
        }

        return cleared;
    });
}

async function recordQueueRecovery(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly quarantinePath: string;
    /** Bindings whose scan window was cleared. */
    readonly bindingsReset: number;
}): Promise<void> {
    try {
        await appendAudit(input.store, {
            eventType: 'delivery.recovered',
            actorSource: 'service',
            entity: { kind: 'delivery', id: EVENTS_FILE },
            decision: null,
            reason: 'events queue quarantined — scan windows reset',
            correlationId: newCorrelationId(),
            details: { quarantinePath: input.quarantinePath, bindingsReset: input.bindingsReset },
        });
    } catch (cause) {
        // Same posture as a detection row: the window reset is already
        // durable, so a failed audit append is logged rather than thrown
        // back into the read that observed the quarantine.
        input.log.warn('queue recovery audit row could not be appended', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 *
 * The quarantine consumed the evidence file, so this is the only moment the
 * repair can run: clear every binding's scan window — the lost assignments
 * are re-detected on the next pass, and the deterministic event ids keep that
 * replay duplicate-free — then leave one audit row saying so.
 */
async function recoverQuarantinedQueue(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly quarantinePath: string;
}): Promise<void> {
    if (!claimQuarantinePass(input.store, input.quarantinePath)) {
        return;
    }

    const bindingsReset = await resetScanWindows(input);
    input.log.info('scan windows reset after the event queue was quarantined', { bindingsReset });
    await recordQueueRecovery({ ...input, bindingsReset });
}

/** Store file name prefix every quarantined copy of the queue keeps. */
const QUARANTINE_EVIDENCE_PREFIX = `${EVENTS_FILE}.corrupt-`;

/**
 * Recover a queue loss this process never saw happen. The quarantine
 * *renames* the file, so a restarting service finds `events.json` simply
 * absent — no read reports `quarantined` again and the reset would never run
 * — so any `events.json.corrupt-*` entry in the store directory stands in for
 * the observation. The first absent read recovers from it, held to one reset
 * and one audit row per loss per process by the per-store claim set, and
 * deterministic event ids keep the re-detection duplicate-free even when a
 * later process repeats it.
 */
async function recoverFromEvidence(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<void> {
    const entries = await input.store.listDir('.');
    for (const entry of entries) {
        if (entry.startsWith(QUARANTINE_EVIDENCE_PREFIX)) {
            await recoverQuarantinedQueue({ ...input, quarantinePath: join(input.store.dataDir, entry) });
        }
    }
}

/**
 * Read the queue through the quarantine funnel. Every queue reader — the
 * relay routes, the panel's claim, and the scan's own enqueue — passes this
 * one function, so a lost queue always triggers the scan-window recovery,
 * whichever reader gets there first: a file that has to be quarantined
 * right now, or the evidence an earlier process left behind when the file
 * is already gone.
 */
async function readQueue(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<QueuedEvent[]> {
    const result = await input.store.readJson(EVENTS_FILE, parseStoredEvents);
    if (result.status === 'ok') {
        return result.value;
    }

    if (result.status === 'quarantined') {
        input.log.warn('stored event queue was unusable and has been set aside', {
            quarantinePath: result.quarantinePath,
        });
    }

    // A quarantine with a path is the live observation, and the recovery runs
    // under that path's name. A `null` path means a concurrent reader won the
    // rename race — the evidence sits in the directory under *its* name, which
    // is exactly what the evidence scan looks for, so that case joins the
    // `absent` one instead of claiming a recovery it cannot name.
    if (result.status === 'quarantined' && result.quarantinePath !== null) {
        await recoverQuarantinedQueue({ ...input, quarantinePath: result.quarantinePath });
    } else {
        // `absent` (or a quarantine whose path another reader holds): an
        // earlier reader renamed the file away, and its evidence stands in
        // for the observation.
        await recoverFromEvidence(input);
    }

    return [];
}

/**
 * Read the queue, best-effort: a quarantined or failed read is answered as
 * an empty list with a log line (never fail-stuck), and a quarantined read
 * has already run the scan-window recovery before it answers.
 */
export async function readEvents(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<QueuedEvent[]> {
    try {
        return await readQueue(input);
    } catch (cause) {
        input.log.warn('event queue read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return [];
    }
}

/** Perform one serialized enqueue, preserving run-before-delivery durability. */
async function enqueueWithinChain(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly incoming: readonly QueuedEvent[];
    readonly prompt?: PromptSnapshot | null;
    readonly observedHeads?: ReadonlyMap<string, string>;
}): Promise<readonly QueuedEvent[]> {
    const existing = await readQueue(input);
    const known = new Set(existing.map((event) => event.id));
    const fresh = input.incoming.filter((event) => {
        if (known.has(event.id)) {
            return false;
        }

        known.add(event.id);
        return true;
    });
    const seeds = input.observedHeads ?? new Map<string, string>();
    // A pass whose only effect is recording a seed still owes its write: the
    // seed is what stops the *next* cycle from emitting a push follow-up for a
    // head that already existed at dispatch (002 FR-103(b)). The events file is
    // only rewritten when something actually appended, so a seed-only cycle
    // cannot reorder a healthy queue for nothing.
    if (fresh.length === 0 && seeds.size === 0) {
        return [];
    }

    const document = await readRunsDocument(input);
    const outcome = applyEnqueue({
        document,
        deliveries: fresh,
        now: nowIso(),
        ...(input.prompt !== undefined && { prompt: input.prompt }),
        ...(seeds.size > 0 && { observedHeads: seeds }),
    });
    // The engine member is written here, in the same chain write that appends the row:
    // a fresh row is never observable with the member absent, so no reader can attempt it beside the pass.
    const intentAtMs = Date.now();
    const appended: readonly QueuedEvent[] = fresh.map((event) => {
        const runCorrelationId = outcome.links.get(event.id);
        const linked = runCorrelationId === undefined ? event : { ...event, runCorrelationId };

        return followUpKindOf(event.id) === null
            ? linked
            : { ...linked, engine: { state: 'unknown', intentAtMs, cause: 'intent' } };
    });
    const persistedRuns = await writeRunsDocument({ ...input, document: outcome.document });
    if (appended.length === 0) {
        // Nothing reached the queue, so the queue file is already correct and
        // rewriting it could only put it in a different order than the one the
        // operator's rows are in.
        await readRunsDocument(input);

        return [];
    }

    const persistedIds = new Set(persistedRuns.runs.map((run) => run.correlationId));
    await input.store.writeJson(
        EVENTS_FILE,
        serializedQueue([...existing, ...appended], persistedIds),
    );
    // Creation audits are backed by intents in runs.json; draining after both
    // durable state writes closes the crash window without changing audit row
    // vocabulary or rolling back either state file.
    await readRunsDocument(input);
    await recordEnqueueAudits({ ...input, outcome, appended });

    return appended;
}

/**
 * Append events with delivery-id deduplication and one atomic run/queue chain.
 */
export async function enqueueEvents(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly incoming: readonly QueuedEvent[];
    /**
     * The scanning binding's prompt snapshot (004 FR-015), carried beside the
     * events the same binding produced `projectId`/`worktreeOption` for.
     *
     * **No field is added to the delivery rows** — the text persists in
     * exactly two places, the binding and this run snapshot — so
     * `buildEventId`, dedupe, and the NDJSON event contract are untouched.
     */
    readonly prompt?: PromptSnapshot | null;
    /**
     * The head SHA each tracked pull request was observed carrying this cycle,
     * keyed by the ordinal-free subject key of a `pull_request` subject (002
     * FR-103). Read for exactly one purpose: the run that has no seed yet
     * records the head it observed, so the following cycle compares against a
     * real value. A run that already holds a seed is not touched, because the
     * seed is the **dispatch-time baseline** — re-basing it would lose the
     * from → to pair a later follow-up has to name.
     */
    readonly observedHeads?: ReadonlyMap<string, string>;
}): Promise<readonly QueuedEvent[]> {
    return await inQueueChain(async () => await enqueueWithinChain(input));
}

