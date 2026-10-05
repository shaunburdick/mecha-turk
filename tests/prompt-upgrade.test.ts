/**
 * The upgrade runs no migration (004 T-013; FR-018, FR-038, SC-121, SC-128,
 * AC-138, AC-142), and the feature writes nothing on arrival (T-036; FR-089,
 * AC-131).
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
 * T-036 widens the same boot to **every** document the feature's arrival
 * touches, and reads each one as the bytes on disk rather than as parsed JSON
 * (a re-serialised document deep-compares equal, so a parse would prove
 * nothing about a rewrite):
 *
 * - **`config.json` and the account file predating `startingPrompt`** come
 *   back byte-identical, and the configuration read fills the key the file
 *   lacks from the documented blank, reported as `defaultsApplied:
 *   ['startingPrompt']` — a default, never a configured value (FR-081,
 *   FR-089);
 * - **a stored `null` reads exactly like absence**: the same records, the
 *   same bytes on disk, the same golden message (FR-017, AC-131);
 * - **a stored or submitted number, boolean, object, or array is refused**
 *   with a field-level remediation, never echoed, and never coerced — all
 *   three save paths (`PUT /v1/config`, `PUT /v1/bindings`, the account
 *   profile write) answer `422` with the field named and every file
 *   untouched, and the read path sets the file aside with
 *   `field: remediation` as its whole reason (FR-017, FR-019, AC-131).
 *
 * Offline by construction: the seeded binding is `disabled`, so the boot scan
 * cycle skips it (no poller, no network) and its window cannot move.
 */

import { readFile, readdir } from 'node:fs/promises';

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, readAuditEntries } from '../service/audit.ts';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, enqueueEvents, readEvents, EVENTS_FILE } from '../service/poll/events.ts';
import { SCAN_STATE_FILE } from '../service/poll/scan.ts';
import { readRunsDocument } from '../service/poll/runs.ts';
import { ACCOUNTS_PATH, ACCOUNT_PATH } from '../service/routes/accounts.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { CONFIG_PATH } from '../service/routes/config.ts';
import { SERVICE_SCHEMA_VERSION, openStore } from '../service/store/index.ts';
import { promptFingerprint, resolvePromptSnapshot } from '../service/prompt.ts';
import { composeFirstMessage } from '../src/prompt.ts';
import { buildBoundedContext } from '../src/session.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/handoff.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';

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

/**
 * The fence marker a message carries only when a prompt block is present.
 *
 * A no-tier message must contain none of it — the assertion the pre-004
 * composition oracles share (SC-121, AC-131).
 */
const PROMPT_FENCE_MARKER = 'OPERATOR STARTING PROMPT';

/** Failure a harness that came up without a store reports. */
const NO_STORE = 'the harness started without a store';

/** Log sink shared by the seeding handle and the booted service. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => void LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;
/** The service this suite boots, drained before the temp root goes. */
let running: TestService | null = null;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    tempRoot = await makeTempTree('prompt-upgrade');
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    running = null;
    LOG_LINES.length = 0;
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    await removeTempTree(tempRoot);
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
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
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
    const snapshot = prompt === null
        ? null
        : resolvePromptSnapshot({ global: null, account: null, binding: { startingPrompt: prompt } });
    await enqueueEvents({
        store,
        log: LOGGER,
        incoming: [createEvent(detection())],
        ...(snapshot !== null && { prompt: snapshot }),
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
        {
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
        }
    });

    it('composes the seeded prompt-less run byte-identically to the shipped frame', async () => {
        {
            const seed = await seedPre004Store();
            const service = await bootPre004Store();

            const composed = await composedMessageFor(service);
            expect(composed).toBe(goldenMessage(seed.correlationId));
            // No fence, no blank line, no note about the absence — the block the
            // previous build wrote is the whole of what this one writes.
            expect(composed).not.toContain(PROMPT_FENCE_MARKER);
            expect(composed.startsWith('Mecha Turk dispatch (automated')).toBe(true);
        }
    });

    it('keeps a queued run on its snapshot after the binding’s prompt is edited', async () => {
        {
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
        }
    });

});

/* ------------------------------------------------------------------------- *
 * T-036 — arrival writes nothing (004 FR-018, FR-089, SC-128, AC-131, AC-142)
 * ------------------------------------------------------------------------- */

/** The one member every fixture below withholds: 004's own field name. */
const PROMPT_FIELD = 'startingPrompt';

/** Text no answer about a refused value may contain, in whole or in part. */
const REFUSAL_SENTINEL = 'REFUSED-VALUE-NOT-ECHOED';

/** A stored value of the kind that must never be accepted, only refused. */
const STORED_NON_TEXT = 8_675_309;

/**
 * The configuration document the previous release held: every documented
 * member except the one the file predates (004 FR-081's arrival case).
 *
 * Built from the shipped declaration rather than spelled, so a field added
 * later can only widen this fixture — it can never turn it into an
 * unknown-key quarantine behind the test's back.
 */
const PRE_PROMPT_CONFIG: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG).filter(([field]) => field !== PROMPT_FIELD),
);

/**
 * One value of each kind AC-131 names as refused, plus the text that must
 * never appear in an answer about it: the number and the boolean as
 * themselves, the object and the array by their sentinel.
 */
const NON_TEXT_VALUES: readonly { readonly label: string; readonly value: unknown; readonly forbidden: string }[] = [
    { label: 'number', value: STORED_NON_TEXT, forbidden: String(STORED_NON_TEXT) },
    { label: 'boolean', value: true, forbidden: 'true' },
    { label: 'object', value: { note: REFUSAL_SENTINEL }, forbidden: REFUSAL_SENTINEL },
    { label: 'array', value: [REFUSAL_SENTINEL], forbidden: REFUSAL_SENTINEL },
];

/** The answer `GET /v1/config` gives (006 contract §2.1). */
interface ConfigEnvelope {
    /** The effective document, read member by member. */
    readonly config: Readonly<Record<string, unknown>>;
    /** Where the document came from. */
    readonly source: string;
    /** Documented keys the stored file lacked. */
    readonly defaultsApplied: readonly string[];
}

/** The answer `GET /v1/bindings` gives (004 contract §3). */
interface BindingsAnswer {
    /** The stored bindings, each read without trusting its shape. */
    readonly bindings: readonly Record<string, unknown>[];
}

/** The answer `GET /v1/accounts` gives: the credential-free account DTOs. */
interface AccountsAnswer {
    /** The account records; `startingPrompt` is `null` whenever unset. */
    readonly accounts: readonly Record<string, unknown>[];
}

/** The `422 validation` body every write path answers a refused value with. */
interface ValidationBody {
    /** The error envelope. */
    readonly error: {
        /** The catalog code: `validation`. */
        readonly code: string;
        /** Every `field: remediation` pair, joined. */
        readonly message: string;
        /** The structured issue list, one entry per refused field. */
        readonly issues: readonly { readonly field: string; readonly remediation: string }[];
    };
}

/**
 * Read one store file as the bytes actually on disk.
 *
 * Byte identity is asserted on bytes: a deep-compare of parsed JSON cannot
 * see a document that was rewritten, re-serialised, and compared back
 * (T-036; SC-128 says *byte*-identical, and means it).
 *
 * @param name - Store-relative file name.
 * @returns The file's raw bytes.
 */
async function fileBytes(name: string): Promise<Buffer> {
    return await readFile(join(dataDir, name));
}

/**
 * Write the configuration document the previous release held, and hand back
 * the bytes it went in as.
 *
 * @returns Those bytes, for the arrival comparison after the boot.
 */
async function seedPrePromptConfig(): Promise<Buffer> {
    await store.writeJson(CONFIG_FILE, PRE_PROMPT_CONFIG);

    return await fileBytes(CONFIG_FILE);
}

/**
 * One wire answer read as an untrusted record (never a typed shortcut).
 *
 * @typeParam T - The envelope shape the caller asserts on.
 * @returns The parsed body, as the caller's envelope.
 * @throws {Error} When the route answers anything but `200`.
 */
async function wireGet<T>(service: TestService, path: string): Promise<T> {
    const response = await service.call(path);
    if (response.status !== 200) {
        throw new Error(`${path} answered ${response.status}, expected 200`);
    }

    return await response.json() as T;
}

/**
 * The bindings the booted service serves, as records.
 *
 * @returns Every stored binding row.
 */
async function servedBindings(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const answer = await wireGet<BindingsAnswer>(service, BINDINGS_PATH);

    return answer.bindings;
}

/**
 * The accounts the booted service serves, as credential-free records.
 *
 * @returns Every stored account row.
 */
async function servedAccounts(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const answer = await wireGet<AccountsAnswer>(service, ACCOUNTS_PATH);

    return answer.accounts;
}

describe('T-036 arrival writes nothing (FR-018, FR-089, SC-128, AC-131, AC-142)', () => {
    it('boots a store predating every member and changes no byte of it', async () => {
        const seed = await seedPre004Store();
        const configBytes = await seedPrePromptConfig();
        const accountBytes = await fileBytes(ACCOUNT_FILE);
        const bindingsBytes = await fileBytes(BINDINGS_FILE);
        const eventsBytes = await fileBytes(EVENTS_FILE);
        const windowBytes = await fileBytes(SCAN_STATE_FILE);
        const queued = await readEvents({ store, log: LOGGER });
        const deliveryId = queued[0]?.id;
        if (deliveryId === undefined) {
            throw new Error('the seed queued no delivery');
        }

        const service = await bootPre004Store();

        // Nothing was set aside by the feature's arrival (SC-128).
        const entries = await readdir(dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);

        // Every file comes back as the bytes it went in as — read as bytes,
        // because a re-serialised document would deep-compare equal (FR-018,
        // FR-089: no configuration, bindings, or accounts file is rewritten).
        expect(await fileBytes(CONFIG_FILE)).toEqual(configBytes);
        expect(await fileBytes(ACCOUNT_FILE)).toEqual(accountBytes);
        expect(await fileBytes(BINDINGS_FILE)).toEqual(bindingsBytes);
        expect(await fileBytes(EVENTS_FILE)).toEqual(eventsBytes);
        expect(await fileBytes(SCAN_STATE_FILE)).toEqual(windowBytes);

        // The configuration read fills the key the file predates from the
        // documented blank and reports the fill as a default — never as a
        // configured value, and never by writing it back (FR-081, FR-089).
        const read = await service.call(CONFIG_PATH);
        expect(read.status).toBe(200);
        const envelope = await read.json() as ConfigEnvelope;
        expect(envelope.source).toBe('stored');
        expect(envelope.defaultsApplied).toEqual([PROMPT_FIELD]);
        expect(envelope.config[PROMPT_FIELD]).toBe('');
        expect(await fileBytes(CONFIG_FILE)).toEqual(configBytes);

        // Both record surfaces answer the row the previous release wrote:
        // the member is not invented to stand in for its absence.
        const bindings = await servedBindings(service);
        const accounts = await servedAccounts(service);
        expect(bindings[0]).toEqual(pre004Binding());
        expect(accounts[0]?.startingPrompt).toBeNull();

        // The identifiers are untouched: the same delivery id, run key, and
        // correlation id the seed produced (AC-142).
        const handle = service.handle.store;
        if (handle === null) {
            throw new Error(NO_STORE);
        }

        const document = await readRunsDocument({ store: handle, log: LOGGER });
        const [run] = document.runs;
        expect(run?.runKey).toBe(seed.runKey);
        expect(run?.correlationId).toBe(seed.correlationId);
        expect(run?.sourceReferences[0]?.deliveryId).toBe(deliveryId);
        expect(run?.prompt).toBeNull();

        // The schema marker still says 1: there was nothing to compute, and
        // no released predecessor state to adopt (row 32).
        expect(SERVICE_SCHEMA_VERSION).toBe(1);
        expect(handle.schemaVersion).toBe(1);

        // The seeded no-tier event composes the pre-004 bytes: the frame the
        // previous build wrote, with no fence and no placeholder (AC-131).
        const composed = await composedMessageFor(service);
        expect(composed).toBe(goldenMessage(seed.correlationId));
        expect(composed).not.toContain(PROMPT_FENCE_MARKER);
        expect(composed.startsWith('Mecha Turk dispatch (automated')).toBe(true);

        // The scan window was read, not reset: same bytes, same stamp
        // (SC-128's zero scan-window resets).
        const window = JSON.parse(await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8')) as {
            readonly bindings: Readonly<Record<string, { readonly lastScanAt: string }>>;
        };
        expect(window.bindings[BINDING_ID]?.lastScanAt).toBe(STAMP);
    });

    it('reads a stored null exactly like absence — same records, same bytes, same message', async () => {
        const seed = await seedPre004Store();

        // The two spellings of "unset" the feature accepts, side by side: the
        // member the file predates, and an explicit stored null.
        const absentBinding = pre004Binding();
        const nulledBinding = { ...pre004Binding(), startingPrompt: null };
        const absentAccount = pre004Account();
        const nulledAccount = { ...pre004Account(), startingPrompt: null };
        expect(nulledBinding).not.toEqual(absentBinding);
        expect(nulledAccount).not.toEqual(absentAccount);

        // A stored null resolves exactly like a member the file predates —
        // both spellings answer the same snapshot, and the run the seed
        // queued carries `null`: no tier, no block, no fingerprint (FR-017).
        const absent = resolvePromptSnapshot({
            global: PRE_PROMPT_CONFIG,
            account: absentAccount,
            binding: absentBinding,
        });
        const nulled = resolvePromptSnapshot({
            global: PRE_PROMPT_CONFIG,
            account: nulledAccount,
            binding: nulledBinding,
        });
        expect(nulled).toBeNull();
        expect(nulled).toEqual(absent);

        // *Unset*, not refused — the distinction the null spelling could
        // otherwise hide: with the global tier set, stored nulls on the other
        // two still stack that tier untouched, where a refused tier on either
        // would silence the whole snapshot (FR-028's last resort).
        const globalRecord = { ...PRE_PROMPT_CONFIG, startingPrompt: QUEUED_PROMPT };
        const absentStack = resolvePromptSnapshot({
            global: globalRecord,
            account: absentAccount,
            binding: absentBinding,
        });
        const nulledStack = resolvePromptSnapshot({
            global: globalRecord,
            account: nulledAccount,
            binding: nulledBinding,
        });
        expect(nulledStack).toEqual(absentStack);
        expect(nulledStack?.sources).toEqual(['global']);
        expect(nulledStack?.fingerprint).toBe(promptFingerprint(QUEUED_PROMPT));

        // The store carries the null spelling, and the bytes below are the
        // bytes the boot must not touch.
        await store.writeJson(BINDINGS_FILE, [nulledBinding]);
        await store.writeJson(ACCOUNT_FILE, nulledAccount);
        const configBytes = await seedPrePromptConfig();
        const accountBytes = await fileBytes(ACCOUNT_FILE);
        const bindingsBytes = await fileBytes(BINDINGS_FILE);
        const eventsBytes = await fileBytes(EVENTS_FILE);
        const windowBytes = await fileBytes(SCAN_STATE_FILE);

        const service = await bootPre004Store();

        const entries = await readdir(dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
        // The null is still a null on disk: arrival read it, it did not
        // rewrite it into the absence spelling (or into anything else).
        expect(await fileBytes(BINDINGS_FILE)).toEqual(bindingsBytes);
        expect(await fileBytes(ACCOUNT_FILE)).toEqual(accountBytes);
        expect(await fileBytes(CONFIG_FILE)).toEqual(configBytes);
        expect(await fileBytes(EVENTS_FILE)).toEqual(eventsBytes);
        expect(await fileBytes(SCAN_STATE_FILE)).toEqual(windowBytes);

        // Both surfaces answer the record absence answers — the same two
        // literals the absent case above asserts, so a stored null and an
        // absent member are the same record on the wire.
        const bindings = await servedBindings(service);
        const accounts = await servedAccounts(service);
        expect(bindings[0]).toEqual(pre004Binding());
        expect(accounts[0]?.startingPrompt).toBeNull();

        // …and the composed bytes are the golden the absence case composes:
        // one event, one message, whichever spelling wrote the record.
        const composed = await composedMessageFor(service);
        expect(composed).toBe(goldenMessage(seed.correlationId));
        expect(composed).not.toContain(PROMPT_FENCE_MARKER);
    });

    it('refuses every non-text submitted prompt with a field-level remediation and writes no byte', async () => {
        await seedPre004Store();
        const configBytes = await seedPrePromptConfig();
        const accountBytes = await fileBytes(ACCOUNT_FILE);
        const bindingsBytes = await fileBytes(BINDINGS_FILE);
        const service = await bootPre004Store();
        const profilePath = ACCOUNT_PATH.replace(':numericUserId', () => ACCOUNT_ID);

        for (const { label, value, forbidden } of NON_TEXT_VALUES) {
            // The configuration write is a whole-document replacement: the
            // member must be text, and a refusal never echoes the submission
            // (FR-081, 006 FR-041 — the additive `422` every field answers).
            const configResponse = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ ...PRE_PROMPT_CONFIG, [PROMPT_FIELD]: value }),
            });
            const configBody = await configResponse.text();

            expect(configResponse.status, `${label} must be refused by PUT /v1/config`).toBe(422);
            expect(configBody).not.toContain(forbidden);
            const configFailure = JSON.parse(configBody) as ValidationBody;
            expect(configFailure.error.code).toBe('validation');
            const configIssue = configFailure.error.issues.find((issue) => issue.field === PROMPT_FIELD);
            expect(configIssue, `${label} must name the prompt field`).toBeDefined();
            expect(configIssue?.remediation).toContain(PROMPT_FIELD);

            // The bindings write judges the same value with the same one
            // validator and the same never-echo posture (FR-017, FR-083).
            const bindingsResponse = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                body: JSON.stringify({ bindings: [{ ...pre004Binding(), [PROMPT_FIELD]: value }] }),
            });
            const bindingsBody = await bindingsResponse.text();

            expect(bindingsResponse.status, `${label} must be refused by PUT /v1/bindings`).toBe(422);
            expect(bindingsBody).not.toContain(forbidden);
            const bindingsFailure = JSON.parse(bindingsBody) as ValidationBody;
            expect(bindingsFailure.error.code).toBe('validation');
            const bindingsIssue = bindingsFailure.error.issues.find((issue) => issue.field === PROMPT_FIELD);
            expect(bindingsIssue, `${label} must name the prompt field`).toBeDefined();
            expect(bindingsIssue?.remediation).toContain(PROMPT_FIELD);

            // …and the account profile write, the third of FR-083's three
            // call sites, refuses it under its own field name and remediation
            // (FR-082's closed two-member body).
            const profileResponse = await service.call(profilePath, {
                method: 'PUT',
                body: JSON.stringify({ [PROMPT_FIELD]: value }),
            });
            const profileBody = await profileResponse.text();

            expect(profileResponse.status, `${label} must be refused by the profile write`).toBe(422);
            expect(profileBody).not.toContain(forbidden);
            const profileFailure = JSON.parse(profileBody) as ValidationBody;
            expect(profileFailure.error.code).toBe('validation');
            const profileIssue = profileFailure.error.issues.find((issue) => issue.field === PROMPT_FIELD);
            expect(profileIssue, `${label} must name the prompt field`).toBeDefined();
            expect(profileIssue?.remediation).toContain(PROMPT_FIELD);
        }

        // Nothing was written and nothing was coerced: all three files are
        // still the shipped bytes, and the configuration read still answers
        // the documented blank reported as a default (AC-131's "never
        // coerced, cast, or dropped").
        expect(await fileBytes(CONFIG_FILE)).toEqual(configBytes);
        expect(await fileBytes(ACCOUNT_FILE)).toEqual(accountBytes);
        expect(await fileBytes(BINDINGS_FILE)).toEqual(bindingsBytes);
        const envelope = await wireGet<ConfigEnvelope>(service, CONFIG_PATH);
        expect(envelope.defaultsApplied).toEqual([PROMPT_FIELD]);
        expect(envelope.config[PROMPT_FIELD]).toBe('');
        const bindings = await servedBindings(service);
        expect(bindings[0]).toEqual(pre004Binding());
    });

    it('sets a stored non-text prompt aside with a field-level reason and never coerces it', async () => {
        const seed = await seedPre004Store();
        // Planted the way an operator's hand edit would land it: the value is
        // in the file before the service ever sees it (FR-019).
        await store.writeJson(BINDINGS_FILE, [{ ...pre004Binding(), [PROMPT_FIELD]: STORED_NON_TEXT }]);
        const bindingsBytes = await fileBytes(BINDINGS_FILE);
        const configBytes = await seedPrePromptConfig();
        const accountBytes = await fileBytes(ACCOUNT_FILE);
        const eventsBytes = await fileBytes(EVENTS_FILE);
        const windowBytes = await fileBytes(SCAN_STATE_FILE);

        const service = await bootPre004Store();

        // Nothing coerced into service: the first read of the file — the boot
        // scan cycle's or this one's, whichever reached it first — answers no
        // bindings at all rather than a binding with a number for an
        // instruction (FR-019: the poll loop scans nothing until the operator
        // repairs the file, and no binding is silently dropped).
        expect(await servedBindings(service)).toEqual([]);

        // The refusal is a rename of the shipped bytes, never a rewrite: the
        // set-aside file still holds exactly what the operator stored — the
        // value was refused, not coerced, cast, or dropped (AC-131), and it
        // is the only file set aside (SC-128 counts zeros for *valid*
        // documents; this one is not valid, and is refused closed).
        const entries = await readdir(dataDir);
        const asideNames = entries.filter((entry) => entry.includes('.corrupt-'));
        expect(asideNames).toHaveLength(1);
        const [asideName] = asideNames;
        if (asideName === undefined) {
            throw new Error('the refusal set no file aside');
        }

        expect(await fileBytes(asideName)).toEqual(bindingsBytes);

        // The reason is `field: remediation` and nothing else: the line that
        // carries the quarantine path is scanned only in its `reason` member,
        // because the path's own hex can contain anything (FR-019, AC-141).
        const refusalLine = service.logLines.find((line) => line.includes('stored bindings were unusable'));
        expect(refusalLine, 'the refusal must be logged').toBeDefined();
        const logged = JSON.parse(refusalLine ?? '{}') as { readonly reason?: unknown };
        const reason = String(logged.reason);
        expect(reason).toContain(`${PROMPT_FIELD}: ${PROMPT_FIELD} must be text`);
        expect(reason).not.toContain(String(STORED_NON_TEXT));

        // …and every other document is still the bytes it arrived as.
        expect(await fileBytes(CONFIG_FILE)).toEqual(configBytes);
        expect(await fileBytes(ACCOUNT_FILE)).toEqual(accountBytes);
        expect(await fileBytes(EVENTS_FILE)).toEqual(eventsBytes);
        expect(await fileBytes(SCAN_STATE_FILE)).toEqual(windowBytes);
        expect(SERVICE_SCHEMA_VERSION).toBe(1);

        // The run queued before the edit is untouched by it: no prompt state
        // was invented for the refused binding, and the schema marker is
        // still the one the previous release wrote.
        const handle = service.handle.store;
        if (handle === null) {
            throw new Error(NO_STORE);
        }

        const document = await readRunsDocument({ store: handle, log: LOGGER });
        const [run] = document.runs;
        expect(run?.runKey).toBe(seed.runKey);
        expect(run?.prompt).toBeNull();
        expect(await composedMessageFor(service)).toBe(goldenMessage(seed.correlationId));
    });
});
