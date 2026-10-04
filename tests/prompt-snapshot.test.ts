/**
 * The prompt snapshot on the run (004 T-006/T-018; FR-015, FR-019, FR-053,
 * FR-080, FR-086, FR-087, AC-138, AC-142).
 *
 * The snapshot is the property that makes a dispatch reproducible: it is
 * resolved **from the same records that produced the run's `projectId` and
 * `worktreeOption`**, at the same moment, and nothing re-reads them
 * afterwards. Since 004 v1.4.0 that snapshot is the *composed* body — three
 * tiers stacked once, one fingerprint over the body, one source list beside
 * it — so what is asserted here is that:
 *
 * - the resolver stacks the set tiers in order, one blank line apart, and
 *   returns `null` when none is set (FR-080, FR-071);
 * - a binding-only body is byte-identical to the tier text, so its
 *   fingerprint is the shipped single-tier value (FR-086);
 * - a run keeps the text it was queued with across a later edit (AC-138);
 * - a coalescing delivery never replaces the snapshot of the run it joins;
 * - the delivery rows gain **no field at all** — `events.json` for the same
 *   detection is byte-identical with and without a prompt (FR-053);
 * - the run parser refuses a malformed snapshot — including one without its
 *   `sources` or over its own stack bound — instead of half-applying it,
 *   while a row written before this feature parses unchanged (AC-142,
 *   FR-087, AGENTS.md invariant 8).
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
import {
    PROMPT_FINGERPRINT_PATTERN,
    STARTING_PROMPT_MAX_CODE_POINTS,
    composePromptBody,
    promptFingerprint,
    promptStackMaxCodePoints,
    promptTierOf,
    resolvePromptSnapshot,
} from '../service/prompt.ts';
import { PROMPT_SOURCE_ORDER, isPromptSourceList } from '../src/prompt.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { PromptSnapshot } from '../service/prompt.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** Stamp every fixture carries, so no test depends on the clock. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** Binding every fixture detection and snapshot names. */
const BINDING_ID = 'bnd-snapshot';

/** The instruction this suite snapshots. */
const PROMPT_A = 'Reproduce first, then patch.';

/** The same binding's instruction after an operator edit. */
const PROMPT_B = 'Reproduce first, then patch, and say so in the summary.';

/** The global tier's text the resolution cases stack (004 FR-080). */
const GLOBAL_TEXT = 'Global context.';

/** The account tier's text the resolution cases stack (004 FR-080). */
const ACCOUNT_TEXT = 'Account context.';

/** Log sink shared by every reader this suite drives. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'prompt-snapshot-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    LOG_LINES.length = 0;
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/** A binding-shaped record carrying one prompt, as the poll loop holds it. */
function bindingWith(prompt: string): { readonly bindingId: string; readonly startingPrompt: string } {
    return { bindingId: BINDING_ID, startingPrompt: prompt };
}

/**
 * The snapshot the production resolver builds for a binding-only run: the
 * same three-tier entry point `service/poll/loop.ts` calls, with only the
 * binding tier set (004 FR-080, FR-086).
 *
 * @param prompt - The binding tier's text.
 * @returns The composed snapshot; `null` only if the validator refuses it.
 */
function bindingSnapshot(prompt: string): PromptSnapshot | null {
    return resolvePromptSnapshot({ global: null, account: null, binding: bindingWith(prompt) });
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
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
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
    /** The resolved snapshot for this detection, when the run has one. */
    readonly prompt?: PromptSnapshot | null;
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
        ...(call.prompt !== undefined && { prompt: call.prompt }),
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
    it('snapshots the body, fingerprint, length, and sources of the binding in hand', async () => {
        {
            const snapshot = bindingSnapshot(PROMPT_A);
            expect(snapshot).toEqual({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            });
            expect(snapshot?.fingerprint).toMatch(PROMPT_FINGERPRINT_PATTERN);
            // Unset bindings resolve to nothing, and that is a complete answer.
            const unset: { readonly startingPrompt?: string } = {};
            expect(resolvePromptSnapshot({ global: null, account: null, binding: unset })).toBeNull();
        }
    });

    it('keeps a queued run on the text it was queued with after an edit', async () => {
        {
            const first = await enqueueInto({
                store,
                snapshots: [assignment(11)],
                prompt: bindingSnapshot(PROMPT_A),
            });
            // The operator edits the binding; the *next* detection uses the new text.
            const second = await enqueueInto({
                store,
                snapshots: [assignment(12)],
                prompt: bindingSnapshot(PROMPT_B),
            });

            const runs = rawRuns(JSON.parse(second.runs));
            expect(runs).toHaveLength(2);
            expect(runs[0]?.prompt).toEqual({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            });
            expect(runs[1]?.prompt).toEqual({
                text: PROMPT_B,
                fingerprint: promptFingerprint(PROMPT_B),
                length: [...PROMPT_B].length,
                sources: ['binding'],
            });
            // The first write's bytes for the first run never changed afterwards.
            expect(rawRuns(JSON.parse(first.runs))[0]?.prompt).toEqual({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            });
        }
    });

    it('never lets a coalescing delivery replace the run’s own snapshot', async () => {
        {
            await enqueueInto({ store, snapshots: [assignment(12)], prompt: bindingSnapshot(PROMPT_A) });
            const afterJoin = await enqueueInto({
                store,
                snapshots: [{
                    ...assignment(12),
                    kind: 'mention',
                    origin: 'body',
                    actorLogin: 'alice',
                    actorAttribution: 'direct',
                    triggerNote: 'body mention',
                }],
                prompt: bindingSnapshot(PROMPT_B),
            });

            const runs = rawRuns(JSON.parse(afterJoin.runs));
            expect(runs).toHaveLength(1);
            expect(runs[0]?.prompt).toEqual({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            });
            expect(runs[0]?.referenceCount).toBe(2);
        }
    });

    it('adds no field to the delivery rows: the bytes are the pre-004 bytes', async () => {
        {
            const withPrompt = await mkdtemp(join(tmpdir(), 'prompt-events-with-'));
            const withoutPrompt = await mkdtemp(join(tmpdir(), 'prompt-events-without-'));
            try {
                const promptedStore = await openStore({ dataDir: join(withPrompt, 'store') });
                const plainStore = await openStore({ dataDir: join(withoutPrompt, 'store') });

                const first = await enqueueInto({
                    store: promptedStore,
                    snapshots: [assignment(7)],
                    prompt: bindingSnapshot(PROMPT_A),
                });
                const second = await enqueueInto({ store: plainStore, snapshots: [assignment(7)] });

                // The same detection, on two stores: identical bytes, so the
                // snapshot lives on the run and nowhere near the delivery (FR-053).
                expect(first.events).toBe(second.events);
                expect(first.events).not.toContain('prompt');
                expect(first.events).not.toContain(PROMPT_A);
                // The run rows differ by exactly what 004 adds: a snapshot on one,
                // an explicit unset on the other (a pre-004 row parses the same).
                expect(first.runs).toContain(PROMPT_A);
            } finally {
                await rm(withPrompt, { recursive: true, force: true });
                await rm(withoutPrompt, { recursive: true, force: true });
            }
        }
    });

});

describe('T-006 the run parser validates the snapshot (FR-019, FR-028, AC-142)', () => {
    it('parses a row written before this feature, with no prompt member', async () => {
        {
            const document = parseRunsDocument(storedDocumentWith(undefined, false));
            expect(document).not.toBeNull();
            expect(document?.runs[0]?.prompt).toBeNull();
            expect(document?.schemaVersion).toBe(RUNS_SCHEMA_VERSION);
        }
    });

    it('parses an explicit null as unset', async () => {
        {
            const document = parseRunsDocument(storedDocumentWith(null, true));
            expect(document?.runs[0]?.prompt).toBeNull();
        }
    });

    it('parses a well-formed snapshot, and a stacked body up to its own bound', async () => {
        {
            const document = parseRunsDocument(storedDocumentWith({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            }, true));
            expect(document?.runs[0]?.prompt).toEqual({
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
                sources: ['binding'],
            });
            // A three-tier body may legally reach 6,004 code points
            // (FR-085): the stack bound, not the per-tier cap, is the
            // ceiling — exactly at the bound still parses.
            const stacked = 'x'.repeat(6_004);
            const atBound = parseRunsDocument(storedDocumentWith({
                text: stacked,
                fingerprint: promptFingerprint(stacked),
                length: 6_004,
                sources: ['global', 'account', 'binding'],
            }, true));
            expect(atBound?.runs[0]?.prompt).toEqual({
                text: stacked,
                fingerprint: promptFingerprint(stacked),
                length: 6_004,
                sources: ['global', 'account', 'binding'],
            });
        }
    });

    it('refuses the whole document for a present value that is not a snapshot', async () => {
        {
            for (const unusable of [42, true, 'text', [], { text: PROMPT_A }]) {
                expect(parseRunsDocument(storedDocumentWith(unusable, true)), JSON.stringify(unusable)).toBeNull();
            }
        }
    });

    it('refuses a malformed fingerprint, an over-cap text, a wrong length, and a credential', async () => {
        {
            // Every case carries a valid `sources` list so the refusal comes
            // from the rule it names, never from the missing-member rule.
            const cases: readonly unknown[] = [
                // Wrong prefix, wrong digest length, uppercase: none is the format.
                {
                    text: PROMPT_A,
                    fingerprint: 'mtp-zzzz',
                    length: [...PROMPT_A].length,
                    sources: ['binding'],
                },
                {
                    text: PROMPT_A,
                    fingerprint: promptFingerprint(PROMPT_A).slice(0, 30),
                    length: [...PROMPT_A].length,
                    sources: ['binding'],
                },
                // The recorded length disagrees with the recorded text.
                { text: PROMPT_A, fingerprint: promptFingerprint(PROMPT_A), length: 3, sources: ['binding'] },
                // One code point over a binding-only row's stack bound (the
                // per-tier cap), even though text and length agree.
                {
                    text: 'x'.repeat(2_001),
                    fingerprint: promptFingerprint('x'.repeat(2_001)),
                    length: 2_001,
                    sources: ['binding'],
                },
                // Credential-shaped text refused at the save boundary must never
                // have been stored; a hand edit that puts it there is refused too.
                {
                    text: `push with ghp_${'f'.repeat(30)}`,
                    fingerprint: promptFingerprint(`push with ghp_${'f'.repeat(30)}`),
                    length: [...`push with ghp_${'f'.repeat(30)}`].length,
                    sources: ['binding'],
                },
            ];

            for (const snapshot of cases) {
                expect(parseRunsDocument(storedDocumentWith(snapshot, true)), JSON.stringify(snapshot)).toBeNull();
            }
        }
    });

    it('refuses `sources` that are absent, empty, unknown, out of order, or over the bound', async () => {
        {
            const base = {
                text: PROMPT_A,
                fingerprint: promptFingerprint(PROMPT_A),
                length: [...PROMPT_A].length,
            };
            const overBound = 'x'.repeat(6_005);
            const cases: readonly unknown[] = [
                // Absent: no defaulting branch exists to complete it (FR-087).
                base,
                // Present-but-unset disagreements: empty and non-array.
                { ...base, sources: [] },
                { ...base, sources: 'binding' },
                // Unknown, out of order, duplicated.
                { ...base, sources: ['repo'] },
                { ...base, sources: ['binding', 'global'] },
                { ...base, sources: ['global', 'global'] },
                // One code point past the stack bound its own sources name
                // (FR-085, research R-1): 6,004 is the ceiling for three tiers.
                {
                    text: overBound,
                    fingerprint: promptFingerprint(overBound),
                    length: 6_005,
                    sources: ['global', 'account', 'binding'],
                },
            ];

            for (const snapshot of cases) {
                expect(parseRunsDocument(storedDocumentWith(snapshot, true)), JSON.stringify(snapshot)).toBeNull();
            }
        }
    });

    it('quarantines the stored document through the store’s own funnel', async () => {
        {
            await store.writeJson(RUNS_FILE, storedDocumentWith({ text: PROMPT_A }, true));
            const read = await store.readJson(RUNS_FILE, parseRunsDocument);

            expect(read.status).toBe('quarantined');
            if (read.status === 'quarantined') {
                expect(read.quarantinePath).toContain(RUNS_FILE);
            }
        }
    });

});

describe('T-018 the resolver stacks the set tiers once (FR-080, FR-086, FR-087)', () => {
    it('resolves the set tiers in order, or answers null', () => {
        {
            const global = { startingPrompt: GLOBAL_TEXT };
            const account = { startingPrompt: ACCOUNT_TEXT };
            const binding = bindingWith(PROMPT_A);

            const all = resolvePromptSnapshot({ global, account, binding });
            // Body bytes: global + "\n\n" + account + "\n\n" + binding, and
            // nothing else — no tier labels, no extra blank line (FR-084).
            expect(all?.text).toBe(`${GLOBAL_TEXT}\n\n${ACCOUNT_TEXT}\n\n${PROMPT_A}`);
            expect(all?.sources).toEqual(['global', 'account', 'binding']);
            expect(resolvePromptSnapshot({ global, account: null, binding: null })?.sources).toEqual(['global']);
            expect(resolvePromptSnapshot({ global, account: null, binding: null })?.text).toBe(GLOBAL_TEXT);
            expect(resolvePromptSnapshot({ global: null, account, binding })?.sources)
                .toEqual(['account', 'binding']);
            expect(resolvePromptSnapshot({ global: null, account, binding })?.text)
                .toBe(`${ACCOUNT_TEXT}\n\n${PROMPT_A}`);
            expect(resolvePromptSnapshot({ global: null, account: null, binding })?.sources).toEqual(['binding']);
            // No tier set — not even an empty record — answers null: no body,
            // no fingerprint, no fence (FR-071, FR-032).
            expect(resolvePromptSnapshot({ global: null, account: null, binding: null })).toBeNull();
            expect(resolvePromptSnapshot({ global: {}, account: {}, binding: {} })).toBeNull();
        }
        {
            const body = `${GLOBAL_TEXT}\n\n${PROMPT_A}`;
            const stacked = resolvePromptSnapshot({
                global: { startingPrompt: GLOBAL_TEXT },
                account: null,
                binding: bindingWith(PROMPT_A),
            });
            expect(stacked?.fingerprint).toBe(promptFingerprint(body));
            expect(stacked?.fingerprint).toMatch(PROMPT_FINGERPRINT_PATTERN);
            // A binding-only body *is* the tier text, so its fingerprint is
            // the value the shipped single-tier build derived — the golden
            // identity FR-084 and FR-086 pin (research: pure function of the body).
            const bindingOnly = bindingSnapshot(PROMPT_A);
            expect(bindingOnly?.fingerprint).toBe(promptFingerprint(PROMPT_A));
            expect(bindingOnly?.fingerprint).toBe(promptTierOf(bindingWith(PROMPT_A))?.fingerprint);
        }
        {
            const snapshot = resolvePromptSnapshot({
                global: { startingPrompt: GLOBAL_TEXT },
                account: { startingPrompt: ACCOUNT_TEXT },
                binding: bindingWith(PROMPT_A),
            });
            expect(snapshot?.sources).toEqual([...PROMPT_SOURCE_ORDER]);
            expect(snapshot === null ? null : isPromptSourceList(snapshot.sources)).toBe(true);
        }
        {
            expect(composePromptBody({ global: 'g', account: 'a', binding: 'b' })).toBe('g\n\na\n\nb');
            expect(composePromptBody({ global: null, account: null, binding: 'b' })).toBe('b');
            expect(composePromptBody({ global: 'g', account: null, binding: 'b' })).toBe('g\n\nb');
            expect(composePromptBody({ global: null, account: null, binding: null })).toBe('');
        }
        {
            expect(promptStackMaxCodePoints(1)).toBe(STARTING_PROMPT_MAX_CODE_POINTS);
            expect(promptStackMaxCodePoints(2)).toBe(2 * STARTING_PROMPT_MAX_CODE_POINTS + 2);
            expect(promptStackMaxCodePoints(3)).toBe(6_004);
        }
        {
            expect(resolvePromptSnapshot({
                global: { startingPrompt: GLOBAL_TEXT },
                account: null,
                binding: { startingPrompt: `ghp_${'d'.repeat(30)}` },
            })).toBeNull();
            // The members are records read structurally; a value that is not a
            // record is refused rather than quietly read as unset (invariant 8).
            expect(resolvePromptSnapshot({ global: 'not a record', account: null, binding: null })).toBeNull();
        }
    });
});
