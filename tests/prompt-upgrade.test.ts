/**
 * The upgrade runs no migration (004 T-013; FR-018, FR-038, SC-121, SC-128,
 * AC-138, AC-142).
 *
 * An operator upgrades by starting the new build against the old files, so
 * that is exactly what this suite does: it seeds a store written the way the
 * previous release wrote it — bindings with no prompt field, deliveries, runs,
 * audit rows, and a recorded scan window — boots the real loopback service
 * against it, and asserts what the operator would find:
 *
 * - **zero quarantine files** and **zero scan-window resets**: the bindings
 *   file and `scan-state.json` come back byte-identical, so the upgrade read
 *   the store rather than rewriting it;
 * - **the identifiers are untouched**: the same delivery ids, run keys, and
 *   correlation ids before and after the boot;
 * - **the schema marker still says `1`** — there is nothing to compute, which
 *   is the whole point (FR-018: absence is already the correct reading);
 * - **the composed message is the shipped bytes**: a prompt-less run composes
 *   exactly what the previous build composed for that event (SC-121);
 * - **a prompt edited mid-flight changes nothing about a queued run** — the
 *   snapshot it queued with is the snapshot it dispatches with (AC-138).
 *
 * Offline by construction: the seeded binding is `disabled`, so the boot scan
 * cycle skips it (no poller, no network) and its window cannot move.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, readAuditEntries } from '../service/audit.ts';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, enqueueEvents, readEvents, EVENTS_FILE } from '../service/poll/events.ts';
import { SCAN_STATE_FILE } from '../service/poll/scan.ts';
import { readRunsDocument } from '../service/poll/runs.ts';
import { SERVICE_SCHEMA_VERSION, openStore } from '../service/store/index.ts';
import { promptFingerprint, promptSnapshotOf } from '../service/prompt.ts';
import { composeFirstMessage } from '../src/prompt.ts';
import { buildBoundedContext } from '../src/session.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/handoff.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Stamp every seeded row carries, so nothing here waits on a clock. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** Binding, account, and login the pre-004 store names. */
const BINDING_ID = 'bnd-pre004';
const ACCOUNT_ID = '77331';
const LOGIN = 'octocat-mt';

/** The account credential file the shipped store holds. */
const ACCOUNT_FILE = `accounts/${ACCOUNT_ID}.json`;

/** Fixture credential; never real, never printed. */
const CREDENTIAL = `pre004-fixture-credential-${'s'.repeat(24)}`;

/** The one issue this store carries, and the text it carries with it. */
const ISSUE_NUMBER = 7;
const ISSUE_TITLE = 'Fix the flaky test';
const ISSUE_URL = 'https://github.com/acme/widget/issues/7';
const ISSUE_BODY = 'It fails once in ten runs.';

/** The instruction the seeded run snapshots at detection. */
const QUEUED_PROMPT = 'Reproduce first, then patch.';

/** The instruction a later edit plants, which must not reach a queued run. */
const LATE_PROMPT = 'Close it with a comment instead of patching it.';

/** Audit event type one inherited row carries; the upgrade must retain it. */
const SHIPPED_EVENT = 'consent';

/** Failure a harness that came up without a store reports. */
const NO_STORE = 'the harness started without a store';

/** Log sink shared by the seeding handle and the booted service. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;
/** The service this suite boots, drained before the temp root goes. */
let running: TestService | null = null;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-prompt-upgrade-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    running = null;
    LOG_LINES.length = 0;
});

afterEach(async () => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    await rm(tempRoot, { recursive: true, force: true });
});

/** The pre-004 binding: no prompt member anywhere, and `disabled` so no scan runs. */
function pre004Binding(): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'disabled',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/** The pre-004 account credential file, complete so reconciliation re-verifies nothing. */
function pre004Account(): Record<string, unknown> {
    return {
        numericUserId: ACCOUNT_ID,
        login: LOGIN,
        expectedLogin: null,
        verifiedAt: STAMP,
        errorReason: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        credential: { token: CREDENTIAL, kind: 'classic', verifiedAt: STAMP },
        scopeCheck: { checkedAt: STAMP, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
    };
}

/** How many audit rows one store's trail holds. */
async function auditRowsOf(target: ServiceStore): Promise<number> {
    const entries = await readAuditEntries(target);

    return entries.length;
}

/** The one assignment detection this store carries. */
function detection(): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber: ISSUE_NUMBER,
            issueTitle: ISSUE_TITLE,
            issueUrl: ISSUE_URL,
            issueBodyExcerpt: ISSUE_BODY,
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** What the upgrade is forbidden to rewrite. */
interface SeededBytes {
    /** `bindings.json` exactly as the previous release left it. */
    readonly bindings: string;
    /** `events.json` exactly as the previous release left it. */
    readonly events: string;
    /** `scan-state.json` exactly as the previous release left it. */
    readonly window: string;
    /** The run key and correlation id the seed produced. */
    readonly runKey: string;
    readonly correlationId: string;
    /** How many audit rows the seed inherited. */
    readonly auditRows: number;
}

/**
 * Seed a complete pre-004 store, optionally snapshotting a prompt onto the run.
 *
 * @param prompt - The binding's prompt at detection, when the case needs one.
 * @returns The bytes and identifiers the upgrade must not disturb.
 */
async function seedPre004Store(prompt: string | null = null): Promise<SeededBytes> {
    const snapshot = prompt === null ? null : promptSnapshotOf({ startingPrompt: prompt });
    await enqueueEvents({
        store,
        log: LOGGER,
        incoming: [createEvent(detection())],
        ...(snapshot === null ? {} : { prompt: snapshot }),
    });
    await store.writeJson(BINDINGS_FILE, [pre004Binding()]);
    await store.writeJson(ACCOUNT_FILE, pre004Account());
    await store.writeJson(SCAN_STATE_FILE, {
        bindings: { [BINDING_ID]: { lastScanAt: STAMP, lastError: null } },
    });

    await appendAudit(store, {
        eventType: SHIPPED_EVENT,
        actorSource: 'panel',
        entity: { kind: 'service', id: 'mecha-turk' },
        reason: 'service capability granted',
    });

    const document = await readRunsDocument({ store, log: LOGGER });
    const [run] = document.runs;
    if (run === undefined) {
        throw new Error('the seed produced no run');
    }

    return {
        bindings: await readFile(join(dataDir, BINDINGS_FILE), 'utf8'),
        events: await readFile(join(dataDir, EVENTS_FILE), 'utf8'),
        window: await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8'),
        runKey: run.runKey,
        correlationId: run.correlationId,
        auditRows: await auditRowsOf(store),
    };
}

/**
 * Boot the seeded store through the real service and return the instance.
 *
 * @returns The running service, with the boot sweep already settled.
 */
async function bootPre004Store(): Promise<TestService> {
    const service = await startTestService({ dataDir });
    running = service;
    await service.handle.swept;
    await service.handle.reconciled;

    return service;
}

/**
 * The message a dispatch of the seeded run would compose, built exactly the
 * way the relay builds it: the run's own snapshot, the delivery's own text.
 *
 * @param target - The service whose store holds the run.
 * @returns The complete first message.
 */
async function composedMessageFor(target: TestService): Promise<string> {
    const handle = target.handle.store;
    if (handle === null) {
        throw new Error(NO_STORE);
    }

    const document = await readRunsDocument({ store: handle, log: LOGGER });
    const queue = await readEvents({ store: handle, log: LOGGER });
    const [run] = document.runs;
    const delivery = queue[0];
    if (run === undefined || delivery === undefined) {
        throw new Error('the upgraded store lost the run or its delivery');
    }

    const frame = buildBoundedContext({
        repository: run.repository,
        issue: {
            issueNumber: run.subjectNumber,
            title: delivery.issueTitle,
            url: delivery.issueUrl,
            state: 'open',
            body: delivery.issueBodyExcerpt,
            assignees: [LOGIN],
            isPullRequest: run.subjectType === 'pull_request',
        },
        authenticatedLogin: LOGIN,
        correlationId: run.correlationId,
        sources: run.sourceReferences.map((reference) => ({
            origin: reference.origin,
            kind: reference.kind,
            detectedAt: reference.detectedAt,
            url: reference.sourceUrl,
            excerpt: delivery.issueBodyExcerpt,
        })),
    });

    return composeFirstMessage({ prompt: run.prompt?.text ?? null, frame });
}

/**
 * The shipped message for the seeded event, as a literal with one slot.
 *
 * The correlation id is derived by the run key, so it is slotted rather than
 * spelled; everything else — every frame line, both delimiters, the source
 * heading, and the excerpt — is a literal, which is what makes this a golden.
 *
 * @param correlationId - The run's own id, read from the upgraded store.
 * @returns The complete first message the previous build would have sent.
 */
function goldenMessage(correlationId: string): string {
    return [
        'Mecha Turk dispatch (automated — started by the Mecha Turk extension from a detected GitHub event).',
        `Correlation: ${correlationId}`,
        'Repository: acme/widget',
        `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`,
        `URL: ${ISSUE_URL}`,
        `Machine account: ${LOGIN}`,
        'Rule: configured-match — open issue assigned to the authenticated machine account.',
        'Source references: 1',
        '--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---',
        `assignment · assignment · ${STAMP} · ${ISSUE_URL}`,
        ISSUE_BODY,
        '--- END UNTRUSTED ISSUE TEXT ---',
    ].join('\n');
}

describe('T-013 the upgrade runs no migration (FR-018, SC-128, AC-142)', () => {
    it('boots the pre-004 store with no quarantine, no window reset, and no rewrite', async () => {
        const seed = await seedPre004Store();
        const service = await bootPre004Store();
        const entries = await readdir(dataDir);

        // Nothing was set aside, and nothing was repaired on the way in.
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);

        // The bindings file and the scan window come back byte-identical: the
        // upgrade read them, it did not write them (FR-018, SC-128).
        expect(await readFile(join(dataDir, BINDINGS_FILE), 'utf8')).toBe(seed.bindings);
        expect(await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8')).toBe(seed.window);
        // Delivery rows gain no field, so their bytes are the shipped bytes.
        expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(seed.events);

        // The identifiers are untouched: same run key, same correlation id.
        const handle = service.handle.store;
        if (handle === null) {
            throw new Error(NO_STORE);
        }

        const document = await readRunsDocument({ store: handle, log: LOGGER });
        const [run] = document.runs;
        expect(run?.runKey).toBe(seed.runKey);
        expect(run?.correlationId).toBe(seed.correlationId);
        expect(run?.prompt).toBeNull();

        // The schema marker still says 1: there was nothing to compute (FR-018).
        expect(SERVICE_SCHEMA_VERSION).toBe(1);
        expect(handle.schemaVersion).toBe(1);

        // The inherited trail was retained, not restarted.
        expect(await auditRowsOf(handle)).toBeGreaterThanOrEqual(seed.auditRows);
        expect(service.logLines.some((line) => line.includes('.corrupt-'))).toBe(false);
    });

    it('composes the seeded prompt-less run byte-identically to the shipped frame (SC-121)', async () => {
        const seed = await seedPre004Store();
        const service = await bootPre004Store();

        const composed = await composedMessageFor(service);
        expect(composed).toBe(goldenMessage(seed.correlationId));
        // No fence, no blank line, no note about the absence — the block the
        // previous build wrote is the whole of what this one writes.
        expect(composed).not.toContain('OPERATOR STARTING PROMPT');
        expect(composed.startsWith('Mecha Turk dispatch (automated')).toBe(true);
    });

    it('keeps a queued run on its snapshot after the binding’s prompt is edited (AC-138)', async () => {
        await seedPre004Store(QUEUED_PROMPT);
        const service = await bootPre004Store();
        const handle = service.handle.store;
        if (handle === null) {
            throw new Error(NO_STORE);
        }

        const before = await readRunsDocument({ store: handle, log: LOGGER });
        const original = before.runs[0]?.prompt;
        expect(original?.text).toBe(QUEUED_PROMPT);

        // The operator edits the store file — 004 FR-062's documented set path
        // until 005 lands — while the run is still queued.
        const edited = { ...pre004Binding(), startingPrompt: LATE_PROMPT };
        await handle.writeJson(BINDINGS_FILE, [edited]);

        const after = await readRunsDocument({ store: handle, log: LOGGER });
        const queued = after.runs[0]?.prompt ?? null;
        expect(queued?.text).toBe(original?.text);
        expect(queued?.fingerprint).toBe(promptFingerprint(QUEUED_PROMPT));
        expect(queued?.fingerprint).not.toBe(promptFingerprint(LATE_PROMPT));

        // And the retry composes from that snapshot, byte for byte.
        expect(await composedMessageFor(service)).toBe(await composedMessageFor(service));
        expect(await composedMessageFor(service)).toContain(QUEUED_PROMPT);
        expect(await composedMessageFor(service)).not.toContain(LATE_PROMPT);
    });
});
