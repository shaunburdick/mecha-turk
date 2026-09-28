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
 *    `runScanCycle` re-baselines at the bindings' `createdAt` and re-detects
 *    the assignments the lost queue carried (the stamps sit *between* the
 *    creation stamp and the stale window, so the reset is what finds them).
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../extension/service/accounts/store.ts';
import { readAuditEntries } from '../extension/service/audit.ts';
import { writeBindings } from '../extension/service/bindings.ts';
import { createLogger } from '../extension/service/log.ts';
import {
    EVENTS_FILE,
    createEvent,
    enqueueEvents,
    parseStoredEvent,
    readEvents,
} from '../extension/service/poll/events.ts';
import { runScanCycle, windowFor } from '../extension/service/poll/loop.ts';
import { SCAN_STATE_FILE, readScanState } from '../extension/service/poll/scan.ts';
import { openStore } from '../extension/service/store/index.ts';
import type { Account } from '../extension/service/accounts/model.ts';
import type { AuditEntry } from '../extension/service/audit.ts';
import type { BindingRecord } from '../extension/service/bindings.ts';
import type { EventSnapshot, QueuedEvent } from '../extension/service/poll/events.ts';
import type { ServiceLogger } from '../extension/service/log.ts';
import type { GitHubIssuePoller, PollIssue } from '../extension/service/poll/poller-github.ts';
import type { ServiceStore } from '../extension/service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** First fixture binding. */
const BINDING_A = 'bnd-recover-a';

/** Second fixture binding, proving the reset covers *every* slot. */
const BINDING_B = 'bnd-recover-b';

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** Login the fixture issues are assigned to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Binding creation stamp; the re-baselined window opens here. */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Stale window stamp — advanced past the assignments, as the operator's was. */
const SCANNED_AT = '2026-09-27T00:40:38.000Z';

/** Stamp of a completed detection. */
const DETECTED_AT = '2026-09-27T00:41:00.000Z';

/** When the fixture issues were updated: after creation, before the stale window. */
const ASSIGNED_AT = '2026-09-27T00:35:00.000Z';

/** Recovery event name, reused across the assertions (sonarjs: one literal). */
const RECOVERED_EVENT = 'delivery.recovered';

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
        triggers: { assignment: true, mention: false },
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
 * @returns The normalized issue the poller would return.
 */
function assignmentIssue(issueNumber: number): PollIssue {
    return {
        issueNumber,
        title: `Ticket #${issueNumber}`,
        url: `https://github.com/acme/widget/issues/${issueNumber}`,
        state: 'open',
        body: null,
        assignees: [ACCOUNT_LOGIN],
        isPullRequest: false,
        updatedAt: ASSIGNED_AT,
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

describe('event queue round-trip (writer → reader)', () => {
    it('round-trips writer output with issueNumber stored as a number', async () => {
        const { log } = capturingLogger();
        const first = createEvent(fixtureSnapshot(2, 'Flux capacitor needs a resistor.'));
        const second = createEvent(fixtureSnapshot(7, ''));

        const appended = await enqueueEvents({ store, log, incoming: [first, second] });

        expect(appended).toEqual([first, second]);
        const reread = await readEvents({ store, log });
        expect(reread).toEqual([first, second]);
        expect(reread.every((event) => event.state === 'pending')).toBe(true);
        // Assert the bytes, not just the parsed row: JSON numbers are numbers.
        const onDisk = JSON.parse(await readFile(join(dataDir, EVENTS_FILE), 'utf8')) as { issueNumber: unknown }[];
        expect(onDisk.map((row) => row.issueNumber)).toEqual([2, 7]);
        expect(await quarantined()).toEqual([]);
    });

    it('dedupes a replayed event id so a re-detection queues it once', async () => {
        const { log } = capturingLogger();
        const event = createEvent(fixtureSnapshot(2, ''));
        await enqueueEvents({ store, log, incoming: [event] });

        const replayed = await enqueueEvents({ store, log, incoming: [event] });

        expect(replayed).toEqual([]);
        expect(await readEvents({ store, log })).toEqual([event]);
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

describe('quarantined queue recovery', () => {
    it('resets every binding window, audits once, and accepts the next enqueue', async () => {
        await plantScanState({
            bindings: {
                [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null },
                [BINDING_B]: { lastScanAt: SCANNED_AT, lastError: 'auth-failed' },
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
        expect(state.bindings[BINDING_B]).toEqual({ lastScanAt: null, lastError: 'auth-failed' });

        // The next window opens at the binding's creation stamp — the
        // baseline, not the stale stamp that skipped the lost assignments.
        expect(windowFor(fixtureBinding(BINDING_A), state)).toBe(CREATED_AT);

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
        expect(await enqueueEvents({ store, log, incoming: [fresh] })).toEqual([fresh]);
        expect(await readEvents({ store, log })).toEqual([fresh]);
    });

    it('re-baselines the next cycle so the lost assignments are re-detected', async () => {
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

        // Both windows opened at the bindings' creation stamp: only the reset
        // makes ASSIGNED_AT (after creation, before the stale stamp) in-window.
        expect(seenSince).toEqual([CREATED_AT, CREATED_AT]);
        expect(cycle.enqueued).toBe(2);
        const queued = await readEvents({ store, log });
        expect(queued.map((event) => [event.issueNumber, event.state])).toEqual([
            [2, 'pending'],
            [7, 'pending'],
        ]);
        expect(await auditRowsOf(RECOVERED_EVENT)).toHaveLength(1);

        // The cycle completed, so both slots carry a fresh stamp again.
        const after = await readScanState({ store, log });
        expect(after.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
        expect(after.bindings[BINDING_B]?.lastScanAt).not.toBeNull();
    });
});
