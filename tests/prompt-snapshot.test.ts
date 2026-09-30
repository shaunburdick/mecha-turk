/**
 * The prompt snapshot on the run (004 T-006; FR-015, FR-019, FR-053,
 * AC-138, AC-142).
 *
 * The snapshot is the property that makes a dispatch reproducible: it is taken
 * from **the same binding object that produced the run's `projectId` and
 * `worktreeOption`**, at the same moment, and nothing re-reads the binding
 * afterwards. So what is asserted here is that:
 *
 * - a run keeps the text it was queued with across a later edit (AC-138);
 * - a coalescing delivery never replaces the snapshot of the run it joins;
 * - the delivery rows gain **no field at all** — `events.json` for the same
 *   detection is byte-identical with and without a prompt (FR-053);
 * - the run parser refuses a malformed snapshot instead of half-applying it,
 *   while a row written before this feature parses unchanged (AC-142).
 *
 * Offline: a temp store per test, fixed stamps, no network and no timers.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../service/log.ts';
import {
    EVENTS_FILE,
    createEvent,
    enqueueEvents,
} from '../service/poll/events.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { RUNS_SCHEMA_VERSION, parseRunsDocument } from '../service/poll/runs-parse.ts';
import { RUNS_FILE, emptyRunsDocument } from '../service/poll/runs.ts';
import { PROMPT_FINGERPRINT_PATTERN, promptFingerprint, promptSnapshotOf } from '../service/prompt.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** Stamp every fixture carries, so no test depends on the clock. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** Binding every fixture detection and snapshot names. */
const BINDING_ID = 'bnd-snapshot';

/** The instruction this suite snapshots. */
const PROMPT_A = 'Reproduce first, then patch.';

/** The same binding's instruction after an operator edit. */
const PROMPT_B = 'Reproduce first, then patch, and say so in the summary.';

/** Log sink shared by every reader this suite drives. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'prompt-snapshot-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    LOG_LINES.length = 0;
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/** A binding-shaped record carrying one prompt, as the poll loop holds it. */
function bindingWith(prompt: string): { readonly bindingId: string; readonly startingPrompt: string } {
    return { bindingId: BINDING_ID, startingPrompt: prompt };
}

/** Build an assignment fixture for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: 'body excerpt',
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** What one enqueue of this suite performs. */
interface EnqueueCall {
    /** The store to enqueue into. */
    readonly store: ServiceStore;
    /** The detections to enqueue. */
    readonly snapshots: readonly EventSnapshot[];
    /** The scanning binding's snapshot, when it has one. */
    readonly prompt?: ReturnType<typeof promptSnapshotOf>;
}

/**
 * Enqueue snapshots through the production path, optionally with a prompt.
 *
 * @param call - The store, the detections, and the snapshot to carry.
 * @returns The `events.json` and `runs.json` texts this store now holds.
 */
async function enqueueInto(call: EnqueueCall): Promise<{ readonly events: string; readonly runs: string }> {
    await enqueueEvents({
        store: call.store,
        log: LOGGER,
        incoming: call.snapshots.map(createEvent),
        ...(call.prompt === undefined ? {} : { prompt: call.prompt }),
    });

    return {
        events: await readFile(join(call.store.dataDir, EVENTS_FILE), 'utf8'),
        runs: await readFile(join(call.store.dataDir, RUNS_FILE), 'utf8'),
    };
}

/** Every stored run of one document, raw, so a test can tamper with one. */
function rawRuns(raw: unknown): Record<string, unknown>[] {
    const document = raw as { readonly runs?: readonly unknown[] };
    return (document.runs ?? []).map((entry) => entry as Record<string, unknown>);
}

/** A valid stored document with one run whose `prompt` member is replaced. */
function storedDocumentWith(prompt: unknown, present: boolean): unknown {
    const planned = applyEnqueue({
        document: emptyRunsDocument(),
        deliveries: [createEvent(assignment(1))],
        now: STAMP,
    });
    const raw = JSON.parse(JSON.stringify(planned.document)) as Record<string, unknown>;
    const [row] = rawRuns(raw);
    if (row === undefined) {
        throw new Error('the fixture produced no run');
    }

    if (present) {
        row.prompt = prompt;
    } else {
        delete row.prompt;
    }

    return raw;
}

describe('T-006 the snapshot is taken at detection and never re-read (FR-015, AC-138)', () => {
    it('snapshots the text, fingerprint, and length of the binding in hand', () => {
        const snapshot = promptSnapshotOf(bindingWith(PROMPT_A));
        expect(snapshot).toEqual({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        });
        expect(snapshot?.fingerprint).toMatch(PROMPT_FINGERPRINT_PATTERN);
        // Unset bindings snapshot to nothing, and that is a complete answer.
        const unset: { readonly startingPrompt?: string } = {};
        expect(promptSnapshotOf(unset)).toBeNull();
    });

    it('keeps a queued run on the text it was queued with after an edit (AC-138)', async () => {
        const first = await enqueueInto({
            store,
            snapshots: [assignment(11)],
            prompt: promptSnapshotOf(bindingWith(PROMPT_A)),
        });
        // The operator edits the binding; the *next* detection uses the new text.
        const second = await enqueueInto({
            store,
            snapshots: [assignment(12)],
            prompt: promptSnapshotOf(bindingWith(PROMPT_B)),
        });

        const runs = rawRuns(JSON.parse(second.runs));
        expect(runs).toHaveLength(2);
        expect(runs[0]?.prompt).toEqual({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        });
        expect(runs[1]?.prompt).toEqual({
            text: PROMPT_B,
            fingerprint: promptFingerprint(PROMPT_B),
            length: [...PROMPT_B].length,
        });
        // The first write's bytes for the first run never changed afterwards.
        expect(rawRuns(JSON.parse(first.runs))[0]?.prompt).toEqual({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        });
    });

    it('never lets a coalescing delivery replace the run’s own snapshot', async () => {
        await enqueueInto({ store, snapshots: [assignment(12)], prompt: promptSnapshotOf(bindingWith(PROMPT_A)) });
        const afterJoin = await enqueueInto({
            store,
            snapshots: [{
                ...assignment(12),
                kind: 'mention',
                origin: 'body',
                triggerNote: 'body mention',
            }],
            prompt: promptSnapshotOf(bindingWith(PROMPT_B)),
        });

        const runs = rawRuns(JSON.parse(afterJoin.runs));
        expect(runs).toHaveLength(1);
        expect(runs[0]?.prompt).toEqual({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        });
        expect(runs[0]?.referenceCount).toBe(2);
    });

    it('adds no field to the delivery rows: the bytes are the pre-004 bytes', async () => {
        const withPrompt = await mkdtemp(join(tmpdir(), 'prompt-events-with-'));
        const withoutPrompt = await mkdtemp(join(tmpdir(), 'prompt-events-without-'));
        try {
            const promptedStore = await openStore({ dataDir: join(withPrompt, 'store') });
            const plainStore = await openStore({ dataDir: join(withoutPrompt, 'store') });

            const first = await enqueueInto({
                store: promptedStore,
                snapshots: [assignment(7)],
                prompt: promptSnapshotOf(bindingWith(PROMPT_A)),
            });
            const second = await enqueueInto({ store: plainStore, snapshots: [assignment(7)] });

            // The same detection, on two stores: identical bytes, so the
            // snapshot lives on the run and nowhere near the delivery (FR-053).
            expect(first.events).toBe(second.events);
            expect(first.events).not.toContain('prompt');
            expect(first.events).not.toContain(PROMPT_A);
            // The run rows differ by exactly what 004 adds: a snapshot on one,
            // an explicit unset on the other (a pre-004 row parses the same).
            expect(second.runs).toContain('"prompt": null');
            expect(first.runs).toContain(PROMPT_A);
        } finally {
            await rm(withPrompt, { recursive: true, force: true });
            await rm(withoutPrompt, { recursive: true, force: true });
        }
    });
});

describe('T-006 the run parser validates the snapshot (FR-019, FR-028, AC-142)', () => {
    it('parses a row written before this feature, with no prompt member (AC-142)', () => {
        const document = parseRunsDocument(storedDocumentWith(undefined, false));
        expect(document).not.toBeNull();
        expect(document?.runs[0]?.prompt).toBeNull();
        expect(document?.schemaVersion).toBe(RUNS_SCHEMA_VERSION);
    });

    it('parses an explicit null as unset', () => {
        const document = parseRunsDocument(storedDocumentWith(null, true));
        expect(document?.runs[0]?.prompt).toBeNull();
    });

    it('parses a well-formed snapshot', () => {
        const document = parseRunsDocument(storedDocumentWith({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        }, true));
        expect(document?.runs[0]?.prompt).toEqual({
            text: PROMPT_A,
            fingerprint: promptFingerprint(PROMPT_A),
            length: [...PROMPT_A].length,
        });
    });

    it('refuses the whole document for a present value that is not a snapshot', () => {
        for (const unusable of [42, true, 'text', [], { text: PROMPT_A }]) {
            expect(parseRunsDocument(storedDocumentWith(unusable, true)), JSON.stringify(unusable)).toBeNull();
        }
    });

    it('refuses a malformed fingerprint, an over-cap text, a wrong length, and a credential', () => {
        const cases: readonly unknown[] = [
            // Wrong prefix, wrong digest length, uppercase: none is the format.
            { text: PROMPT_A, fingerprint: 'mtp-zzzz', length: [...PROMPT_A].length },
            { text: PROMPT_A, fingerprint: promptFingerprint(PROMPT_A).slice(0, 30), length: [...PROMPT_A].length },
            // The recorded length disagrees with the recorded text.
            { text: PROMPT_A, fingerprint: promptFingerprint(PROMPT_A), length: 3 },
            // One code point over the cap, even though text and length agree.
            {
                text: 'x'.repeat(2_001),
                fingerprint: promptFingerprint('x'.repeat(2_001)),
                length: 2_001,
            },
            // Credential-shaped text refused at the save boundary must never
            // have been stored; a hand edit that puts it there is refused too.
            {
                text: `push with ghp_${'f'.repeat(30)}`,
                fingerprint: promptFingerprint(`push with ghp_${'f'.repeat(30)}`),
                length: [...`push with ghp_${'f'.repeat(30)}`].length,
            },
        ];

        for (const snapshot of cases) {
            expect(parseRunsDocument(storedDocumentWith(snapshot, true)), JSON.stringify(snapshot)).toBeNull();
        }
    });

    it('quarantines the stored document through the store’s own funnel', async () => {
        await store.writeJson(RUNS_FILE, storedDocumentWith({ text: PROMPT_A }, true));
        const read = await store.readJson(RUNS_FILE, parseRunsDocument);

        expect(read.status).toBe('quarantined');
        if (read.status === 'quarantined') {
            expect(read.quarantinePath).toContain(RUNS_FILE);
        }
    });
});
