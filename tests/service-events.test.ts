/**
 * Event-queue round-trip and quarantine-recovery tests (MVP fix, 2026-09-27).
 *
 * Root cause pinned here: the writer emits `issueNumber` as a **number** and
 * the reader used to demand *text* for every required field, so the queue's
 * own output failed validation. `events.json` was quarantined on first read,
 * the pending assignments vanished with the file, and the scan windows had
 * already advanced past the assignments — so nothing re-detected them. Three
 * test classes close that family of bugs:
 *
 * 1. writer → reader round-trip through a real `ServiceStore` (the class that
 *    was missing), including the stored bytes, so `issueNumber` staying a
 *    number is asserted on disk;
 * 2. the parser boundary — a numeric issue number is accepted, a missing,
 *    string, or zero one still quarantines;
 * 3. recovery — a planted quarantined queue clears every binding's
 *    `lastScanAt` (through the serialized scan-state write), leaves exactly
 *    one `delivery.recovered` audit row, accepts the next enqueue, and a full
 *    `runScanCycle` then opens every window with no `since` filter and
 *    re-detects the assignments the lost queue carried — including issues
 *    last updated *before* the binding existed (product decision,
 *    2026-09-28: the first scan is a replay, and a recovery reset rides the
 *    same path);
 * 4. the restart state — the quarantine *renames* the file, so a service that
 *    restarts after the loss finds `events.json` absent and the evidence
 *    file beside it; that evidence stands in for the observation, while a
 *    plain empty queue must never reset anything (the operator's real data
 *    directory is in exactly this state);
 * 5. first-scan replay — a binding the loop has never scanned lists every
 *    open issue (no `since` filter), the recorded stamp arms the incremental
 *    window from the second cycle on, and a replay never duplicates rows the
 *    queue still holds, pending or dispatched.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../service/accounts/store.ts';
import { readAuditEntries } from '../service/audit.ts';
import { writeBindings } from '../service/bindings.ts';
import { createLogger } from '../service/log.ts';
import {
    EVENTS_FILE,
    buildEventId,
    createEvent,
    enqueueEvents,
    parseStoredEvent,
    readEvents,
} from '../service/poll/events.ts';
import { runScanCycle, windowFor } from '../service/poll/loop.ts';
import { SCAN_STATE_FILE, readScanState } from '../service/poll/scan.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { GitHubIssuePoller, PollIssue } from '../service/poll/poller-github.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** First fixture binding. */
const BINDING_A = 'bnd-recover-a';

/** Second fixture binding, proving the reset covers *every* slot. */
const BINDING_B = 'bnd-recover-b';

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** Login the fixture issues are assigned to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Binding creation stamp; no longer a window source (kept for a complete record). */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Stale window stamp — advanced past the assignments, as the operator's was. */
const SCANNED_AT = '2026-09-27T00:40:38.000Z';

/** Stamp of a completed detection. */
const DETECTED_AT = '2026-09-27T00:41:00.000Z';

/** When the fixture issues were updated: after creation, before the stale window. */
const ASSIGNED_AT = '2026-09-27T00:35:00.000Z';

/** A stamp before the binding existed — the first scan must replay it (product decision, 2026-09-28). */
const PRE_BINDING_AT = '2026-09-26T23:50:00.000Z';

/** The loop's skip reason for a credential the custody cannot use. */
const SKIP_REASON = 'auth-failed';

/** Recovery event name, reused across the assertions (sonarjs: one literal). */
const RECOVERED_EVENT = 'delivery.recovered';

/** Planted evidence file name — a quarantine the store renamed away. */
const EVIDENCE_FILE = `${EVENTS_FILE}.corrupt-1790556047808-fixture`;

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-events-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build a logger that records every line it is asked to write.
 *
 * @returns The logger plus the lines it captured.
 */
function capturingLogger(): { readonly log: ServiceLogger; readonly lines: string[] } {
    const lines: string[] = [];
    const log = createLogger({
        level: 'debug',
        sink: (line: string) => {
            lines.push(line);
        },
    });

    return { log, lines };
}

/**
 * Build the writer's inputs for one assignment detection.
 *
 * @param issueNumber - Issue number the detection carries.
 * @param excerpt - Issue body excerpt (`''` is a legal stored value).
 * @returns A complete event snapshot.
 */
function fixtureSnapshot(issueNumber: number, excerpt: string): EventSnapshot {
    return {
        bindingId: BINDING_A,
        repository: 'acme/widget',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Ticket #${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: excerpt,
        },
        triggerNote: 'Issue assigned to the bound account',
        detectedAt: DETECTED_AT,
    };
}

/**
 * Build one stored binding row.
 *
 * @param bindingId - Id of the binding.
 * @returns A complete active binding with the assignment trigger on.
 */
function fixtureBinding(bindingId: string): BindingRecord {
    return {
        bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Build the active account both bindings poll under.
 *
 * @returns A complete stored account record (the token is a fixture value).
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        credential: { token: 'fixture-token-not-a-real-credential', kind: 'classic', verifiedAt: CREATED_AT },
        scopeCheck: { checkedAt: CREATED_AT, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: CREATED_AT,
        errorReason: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Build one open issue assigned to the fixture account.
 *
 * @param issueNumber - Issue number to report.
 * @param updatedAt - `updated_at` stamp the window is matched against.
 * @returns The normalized issue the poller would return.
 */
function assignmentIssue(issueNumber: number, updatedAt: string = ASSIGNED_AT): PollIssue {
    return {
        issueNumber,
        title: `Ticket #${issueNumber}`,
        url: `https://github.com/acme/widget/issues/${issueNumber}`,
        state: 'open',
        body: null,
        authorLogin: 'alice',
        authorType: 'User',
        assignees: [ACCOUNT_LOGIN],
        isPullRequest: false,
        updatedAt,
    };
}

/** A stub poller plus the scan windows each call was handed. */
interface RecordedPoller {
    /** The poller the cycle is given. */
    readonly poller: GitHubIssuePoller;
    /** `since` value of each call, in call order. */
    readonly seenSince: (string | null)[];
}

/**
 * Build a poller that answers with one fixed issue list and records its windows.
 *
 * @param issues - Issues to return on every call.
 * @returns The poller and the windows it was asked to open.
 */
function recordingPoller(issues: readonly PollIssue[]): RecordedPoller {
    const seenSince: (string | null)[] = [];
    const poller: GitHubIssuePoller = {
        listOpenIssues: async (input) => {
            seenSince.push(input.since);

            return { kind: 'ok', issues };
        },
        // The M6/M7 feeds stay empty here: this fixture's bindings keep both
        // switches off, so the cycle never asks for them.
        listIssueComments: async () => ({ kind: 'ok', comments: [] }),
        listOpenPulls: async () => ({ kind: 'ok', pulls: [] }),
    };

    return { poller, seenSince };
}

/**
 * Write one queue document straight into the store directory.
 *
 * @param rows - Rows to plant as the `events.json` array.
 */
async function plantQueue(rows: readonly unknown[]): Promise<void> {
    await writeFile(join(dataDir, EVENTS_FILE), JSON.stringify(rows), 'utf8');
}

/**
 * Write one scan-state document straight into the store directory.
 *
 * @param value - The document to plant.
 */
async function plantScanState(value: unknown): Promise<void> {
    await writeFile(join(dataDir, SCAN_STATE_FILE), JSON.stringify(value), 'utf8');
}

/**
 * List the quarantine files the store left in the data directory.
 *
 * @returns File names carrying the quarantine marker.
 */
async function quarantined(): Promise<string[]> {
    const entries = await readdir(dataDir);

    return entries.filter((entry) => entry.includes('.corrupt-'));
}

/**
 * Read the `eventType` rows of one kind out of the audit trail.
 *
 * @param eventType - Event vocabulary name to keep.
 * @returns The matching audit rows, in file order.
 */
async function auditRowsOf(eventType: string): Promise<readonly AuditEntry[]> {
    const rows = await readAuditEntries(store);

    return rows.filter((row) => row.eventType === eventType);
}

/**
 * Plant a queue row no writer could produce: `issueNumber` as text.
 *
 * This is the shape that must still quarantine after the fix — the inverse of
 * the bug, where the legal numeric value was the one being refused.
 *
 * @returns The unusable row.
 */
function unusableRow(): unknown {
    return { ...createEvent(fixtureSnapshot(2, 'the row the writer never writes')), issueNumber: '2' };
}

/**
 * Plant quarantine evidence with no `events.json` beside it.
 *
 * This is what a restart after a loss finds: the quarantine renamed the file
 * away, so no read can ever report `quarantined` again.
 */
async function plantEvidence(): Promise<void> {
    await writeFile(join(dataDir, EVIDENCE_FILE), JSON.stringify([unusableRow()]), 'utf8');
}

/**
 * Build one delivery row in the **shipped** vocabulary: the writer's own
 * detection bytes plus the four lifecycle stamps the shipped build wrote.
 *
 * @returns The row as an upgraded `events.json` already holds it.
 */
function shippedRow(): Record<string, unknown> {
    return {
        ...createEvent(fixtureSnapshot(2, '')),
        state: 'pending',
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
    };
}

describe('event queue round-trip (writer → reader)', () => {
    it('round-trips writer output with issueNumber stored as a number', async () => {
        const { log } = capturingLogger();
        const first = createEvent(fixtureSnapshot(2, 'Flux capacitor needs a resistor.'));
        const second = createEvent(fixtureSnapshot(7, ''));

        const appended = await enqueueEvents({ store, log, incoming: [first, second] });

        expect(appended.map((event) => event.id)).toEqual([first.id, second.id]);
        expect(appended.every((event) => event.runCorrelationId?.startsWith('mt-run-') ?? false)).toBe(true);
        const reread = await readEvents({ store, log });
        expect(reread).toEqual(appended);
        // A row 003 enqueued carries no legacy lifecycle state at all: its
        // truth lives on the run the enqueue pass links it to (T-004).
        expect(reread.every((event) => !('state' in event))).toBe(true);
        expect(reread.every((event) => !('claimedAt' in event))).toBe(true);
        // Assert the bytes, not just the parsed row: JSON numbers are numbers.
        const onDisk = JSON.parse(await readFile(join(dataDir, EVENTS_FILE), 'utf8')) as { issueNumber: unknown }[];
        expect(onDisk.map((row) => row.issueNumber)).toEqual([2, 7]);
        expect(await quarantined()).toEqual([]);
    });

    it('dedupes a replayed event id so a re-detection queues it once', async () => {
        const { log } = capturingLogger();
        const event = createEvent(fixtureSnapshot(2, ''));
        const appended = await enqueueEvents({ store, log, incoming: [event] });

        const replayed = await enqueueEvents({ store, log, incoming: [event] });

        expect(replayed).toEqual([]);
        expect(await readEvents({ store, log })).toEqual(appended);
        expect(await quarantined()).toEqual([]);
    });
});

describe('parseStoredEvent (the issueNumber boundary)', () => {
    it('accepts the writer\'s numeric issueNumber as stored', () => {
        const event = createEvent(fixtureSnapshot(2, ''));
        const stored = JSON.parse(JSON.stringify(event)) as unknown;

        expect(parseStoredEvent(stored)).toEqual(event);
    });

    it('still refuses a missing, text, or non-positive issueNumber', () => {
        const event = createEvent(fixtureSnapshot(2, ''));
        const withoutNumber: Record<string, unknown> = { ...event };
        delete withoutNumber.issueNumber;

        expect(parseStoredEvent(withoutNumber)).toBeNull();
        expect(parseStoredEvent({ ...event, issueNumber: '2' })).toBeNull();
        expect(parseStoredEvent({ ...event, issueNumber: 0 })).toBeNull();
        expect(parseStoredEvent({ ...event, issueNumber: 2.5 })).toBeNull();
    });
});

describe('delivery row shapes (003 run layer, T-004)', () => {
    it('writes no lifecycle state onto a new row, and does carry its subject type', () => {
        const row = createEvent(fixtureSnapshot(2, ''));
        const stored = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

        expect('state' in stored).toBe(false);
        expect('claimedAt' in stored).toBe(false);
        expect('dispatchedAt' in stored).toBe(false);
        expect('dispatchResult' in stored).toBe(false);
        expect(JSON.stringify(row)).not.toContain('"state":');
        expect(stored.subjectType).toBe('issue');
        const review = createEvent({
            ...fixtureSnapshot(3, ''),
            kind: 'review',
            headSha: 'deadbeefcafe000000000000000000000000beef',
            baseRef: 'main',
        });
        expect(review.subjectType).toBe('pull_request');
    });

    it('parses an old-shape (shipped) row and a new-shape row alike', () => {
        const oldShape = shippedRow();
        const newShape = JSON.parse(JSON.stringify(createEvent(fixtureSnapshot(7, '')))) as unknown;

        expect(parseStoredEvent(oldShape)).toEqual(oldShape);
        expect(parseStoredEvent(newShape)).toEqual(newShape);
        expect(parseStoredEvent(oldShape)?.state).toBe('pending');
        expect('state' in (parseStoredEvent(newShape) ?? {})).toBe(false);
    });

    it('parses a pre-M7 row: no PR coordinates, all four lifecycle stamps', () => {
        const preM7 = shippedRow();
        delete preM7.headSha;
        delete preM7.baseRef;

        const parsed = parseStoredEvent(preM7);

        expect(parsed).not.toBeNull();
        expect(parsed?.headSha).toBeNull();
        expect(parsed?.baseRef).toBeNull();
        expect(parsed?.state).toBe('pending');
        expect(parsed?.dispatchResult).toBeNull();
    });

    it('refuses a state from the run vocabulary: the layers never mix', () => {
        expect(parseStoredEvent({ ...shippedRow(), state: 'claimed' })).toBeNull();
        expect(parseStoredEvent({ ...shippedRow(), state: 'blocked:project-missing' })).toBeNull();
        expect(parseStoredEvent({ ...shippedRow(), state: 'in-flight', claimedAt: 7 })).toBeNull();
        expect(parseStoredEvent({ ...shippedRow(), runCorrelationId: '' })).toBeNull();
        expect(parseStoredEvent({ ...shippedRow(), kind: 'unknown-trigger' })).toBeNull();
    });

    it('keeps delivery ids byte-identical to the shipped format (FR-012, AC-104)', () => {
        const base = { repository: { owner: 'acme', name: 'widget' }, issueNumber: 12, accountNumericUserId: '77331' };

        expect(buildEventId(base)).toBe('evt-acme~widget~12~77331');
        expect(buildEventId({ ...base, discriminator: '~mention~body' })).toBe('evt-acme~widget~12~77331~mention~body');
        expect(buildEventId({ ...base, discriminator: '~mention~4242' })).toBe('evt-acme~widget~12~77331~mention~4242');
        expect(buildEventId({ ...base, discriminator: '~review' })).toBe('evt-acme~widget~12~77331~review');
        expect(createEvent(fixtureSnapshot(2, '')).id).toBe('evt-acme~widget~2~77331');
    });
});

describe('quarantined queue recovery', () => {
    it('resets every binding window, audits once, and accepts the next enqueue', async () => {
        await plantScanState({
            bindings: {
                [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null },
                [BINDING_B]: { lastScanAt: SCANNED_AT, lastError: SKIP_REASON },
            },
        });
        await plantQueue([unusableRow()]);
        const { log } = capturingLogger();

        expect(await readEvents({ store, log })).toEqual([]);
        expect(await quarantined()).toHaveLength(1);

        // Both slots cleared through the serialized scan-state write; the
        // recorded skip reason survives, only the window moves.
        const state = await readScanState({ store, log });
        expect(state.bindings[BINDING_A]).toEqual({ lastScanAt: null, lastError: null });
        expect(state.bindings[BINDING_B]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });

        // The next window opens with no `since` filter at all — the reset
        // replays every open issue, not the stale stamp that skipped them.
        expect(windowFor(fixtureBinding(BINDING_A), state)).toBeNull();

        const recovered = await auditRowsOf(RECOVERED_EVENT);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
            actorSource: 'service',
            entity: { kind: 'delivery', id: EVENTS_FILE },
            reason: 'events queue quarantined — scan windows reset',
        });

        // A healthy follow-up read repairs nothing twice: one quarantine, one row.
        expect(await readEvents({ store, log })).toEqual([]);
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);

        // The queue is usable again immediately.
        const fresh: QueuedEvent = createEvent(fixtureSnapshot(7, ''));
        const appended = await enqueueEvents({ store, log, incoming: [fresh] });
        expect(appended.map((event) => event.id)).toEqual([fresh.id]);
        expect(appended[0]?.runCorrelationId).toMatch(/^mt-run-/);
        expect(await readEvents({ store, log })).toEqual(appended);
    });

    it('replays the next cycle so the lost assignments are re-detected', async () => {
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A), fixtureBinding(BINDING_B)] });
        await writeAccount(store, fixtureAccount());
        await plantScanState({
            bindings: {
                [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null },
                [BINDING_B]: { lastScanAt: SCANNED_AT, lastError: null },
            },
        });
        await plantQueue([unusableRow()]);
        const { log } = capturingLogger();
        const { poller, seenSince } = recordingPoller([assignmentIssue(2), assignmentIssue(7)]);

        const cycle = await runScanCycle({ store, log, poller });

        // Both windows opened with no `since` filter — only the reset puts
        // them there, so every open issue (ASSIGNED_AT or older) is in-window.
        expect(seenSince).toEqual([null, null]);
        expect(cycle.enqueued).toBe(2);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => [event.issueNumber, event.state])).toEqual([
            [2, undefined],
            [7, undefined],
        ]);
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);

        // The cycle completed, so both slots carry a fresh stamp again.
        const after = await readScanState({ store, log });
        expect(after.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
        expect(after.bindings[BINDING_B]?.lastScanAt).not.toBeNull();
    });

    it('recovers from quarantine evidence when the queue file is already gone', async () => {
        await plantScanState({
            bindings: {
                [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null },
                [BINDING_B]: { lastScanAt: SCANNED_AT, lastError: SKIP_REASON },
            },
        });
        await plantEvidence();
        const { log } = capturingLogger();

        expect(await readEvents({ store, log })).toEqual([]);
        expect(await quarantined()).toEqual([EVIDENCE_FILE]);

        const state = await readScanState({ store, log });
        expect(state.bindings[BINDING_A]).toEqual({ lastScanAt: null, lastError: null });
        expect(state.bindings[BINDING_B]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });
        expect(windowFor(fixtureBinding(BINDING_A), state)).toBeNull();
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);

        // One loss, one recovery: a second read in this process stays quiet.
        expect(await readEvents({ store, log })).toEqual([]);
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);

        const fresh = createEvent(fixtureSnapshot(2, ''));
        const appended = await enqueueEvents({ store, log, incoming: [fresh] });
        expect(appended.map((event) => event.id)).toEqual([fresh.id]);
        expect(appended[0]?.runCorrelationId).toMatch(/^mt-run-/);
        expect(await readEvents({ store, log })).toEqual(appended);
    });

    it('leaves the windows alone when the queue file is simply absent', async () => {
        await plantScanState({
            bindings: { [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null } },
        });
        const { log } = capturingLogger();

        expect(await readEvents({ store, log })).toEqual([]);

        const state = await readScanState({ store, log });
        expect(state.bindings[BINDING_A]).toEqual({ lastScanAt: SCANNED_AT, lastError: null });
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(0);
    });

    it('replays every open assignment from evidence alone, pre-binding issue included', async () => {
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
        await writeAccount(store, fixtureAccount());
        await plantScanState({
            bindings: { [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null } },
        });
        await plantEvidence();
        const { log } = capturingLogger();
        // Issue 1 was assigned before the binding existed — the replay must
        // find it (product decision, 2026-09-28); issue 2 is the lost queue's row.
        const { poller, seenSince } = recordingPoller([
            assignmentIssue(1, PRE_BINDING_AT),
            assignmentIssue(2, ASSIGNED_AT),
        ]);

        const cycle = await runScanCycle({ store, log, poller });

        expect(seenSince).toEqual([null]);
        expect(cycle.enqueued).toBe(2);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => [event.issueNumber, event.state])).toEqual([
            [1, undefined],
            [2, undefined],
        ]);
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);
    });
});

describe('first-scan replay (product decision, 2026-09-28)', () => {
    it('enqueues issues assigned before the binding existed on the very first cycle', async () => {
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
        await writeAccount(store, fixtureAccount());
        // No scan-state file at all: a binding the loop has never scanned.
        const { log } = capturingLogger();
        const { poller, seenSince } = recordingPoller([
            assignmentIssue(1, PRE_BINDING_AT),
            assignmentIssue(2, ASSIGNED_AT),
        ]);

        const cycle = await runScanCycle({ store, log, poller });

        expect(seenSince).toEqual([null]); // no `since` param: a full replay
        expect(cycle.enqueued).toBe(2);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => [event.issueNumber, event.state])).toEqual([
            [1, undefined],
            [2, undefined],
        ]);

        // The completed scan arms the incremental window for the next cycle.
        const after = await readScanState({ store, log });
        expect(after.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
    });

    it('skips an untouched issue once the incremental window is armed', async () => {
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
        await writeAccount(store, fixtureAccount());
        const { log } = capturingLogger();

        const first = recordingPoller([assignmentIssue(1, PRE_BINDING_AT)]);
        const firstCycle = await runScanCycle({ store, log, poller: first.poller });
        expect(firstCycle.enqueued).toBe(1);

        // Second cycle: the same untouched issue plus one the queue has never
        // seen — both last updated before the recorded stamp, so the window
        // (not merely dedupe) is what keeps issue 9 out.
        const second = recordingPoller([assignmentIssue(1, PRE_BINDING_AT), assignmentIssue(9, PRE_BINDING_AT)]);
        const cycle = await runScanCycle({ store, log, poller: second.poller });

        expect(second.seenSince[0]).not.toBeNull();
        expect(cycle.enqueued).toBe(0);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => event.issueNumber)).toEqual([1]);
    });

    it('never duplicates rows the queue still holds after a recovery reset', async () => {
        // The state a recovery reset leaves behind: every window cleared
        // (`lastScanAt: null`) while the queue — restored, or rebuilt by an
        // earlier replay — still carries rows. Dedupe by deterministic id is
        // the only guard, for pending AND dispatched rows alike.
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
        await writeAccount(store, fixtureAccount());
        await plantScanState({ bindings: { [BINDING_A]: { lastScanAt: null, lastError: null } } });
        const { log } = capturingLogger();
        const [pending] = await enqueueEvents({
            store,
            log,
            incoming: [createEvent(fixtureSnapshot(2, ''))],
        });
        if (pending === undefined) {
            throw new Error('pending fixture was not enqueued');
        }
        const dispatched: QueuedEvent = {
            ...createEvent(fixtureSnapshot(3, '')),
            state: 'dispatched',
            dispatchedAt: DETECTED_AT,
            dispatchResult: 'ses_fixture',
        };
        await plantQueue([pending, dispatched]);
        const { poller, seenSince } = recordingPoller([
            assignmentIssue(1, PRE_BINDING_AT), // never queued → the replay finds it
            assignmentIssue(2, PRE_BINDING_AT), // pending row → deduped
            assignmentIssue(3, PRE_BINDING_AT), // dispatched row → deduped
        ]);

        const cycle = await runScanCycle({ store, log, poller });

        expect(seenSince).toEqual([null]);
        expect(cycle.enqueued).toBe(1);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => [event.issueNumber, event.state])).toEqual([
            [2, undefined],
            [1, undefined],
            [3, 'dispatched'],
        ]);
        expect(new Set(queued.map((event) => event.id)).size).toBe(3);
    });
});
