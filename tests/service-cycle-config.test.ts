/**
 * The cycle's **one** configuration read and the two consumers it feeds
 * (006 T-007 – T-009; FR-003, FR-055, FR-057 – FR-059; AC-149, AC-150, SC-117).
 *
 * Three properties, each observed rather than asserted from a constant:
 *
 * 1. **One read, once per cycle** — a counting store wrapper proves
 *    `readJson(CONFIG_FILE, …)` runs exactly once no matter how many bindings
 *    the cycle walks, and that an unreadable document degrades to the
 *    documented defaults with one warn line instead of stopping the cycle
 *    (FR-055's "one read, once per cycle"; invariant 8).
 * 2. **The window is widened by the saved overlap** — `since` equals
 *    `lastScanAt − overlapMs`, and the widened replay enqueues **no** second
 *    event for an item the queue already recorded, because the deterministic
 *    event id drops it (AC-149; this is 002 FR-019's conformance gap closing).
 * 3. **The list request carries the configured page size** — `per_page` is
 *    the configured `perPage`, never above the field's own maximum of 30, and
 *    `MAX_LIST_PAGES` still bounds one scan at two pages (AC-150; 002 FR-020).
 * 4. **The cycle observes the global prompt tier** — a `startingPrompt` edited
 *    in `config.json` between two cycles writes exactly one `config.changed`
 *    row with actor `service` and a fingerprinted pair, the arrival fill
 *    writes none, a restart with the file unchanged writes none, and an
 *    append that cannot reach disk warns without costing the cycle anything
 *    (004 FR-088; 006 FR-070, FR-071).
 *
 * Everything runs on temp directories, fixture records, and a fake fetch: no
 * clock of our own, no network, no credential (FR-086).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../service/accounts/store.ts';
import { AUDIT_FILE, readAuditEntries } from '../service/audit.ts';
import { writeBindings } from '../service/bindings.ts';
import { CONFIG_FILE, DEFAULT_CONFIG, NUMERIC_BOUNDS } from '../service/config.ts';
import { isRecord } from '../service/json.ts';
import { createLogger } from '../service/log.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import { createGitHubIssuePoller } from '../service/poll/poller-github.ts';
import { SCAN_STATE_FILE, readScanState } from '../service/poll/scan.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { GitHubIssuePoller, ListPace, PollIssue } from '../service/poll/poller-github.ts';
import type { JsonReadResult, ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** First fixture binding. */
const BINDING_A = 'bnd-cycle-a';

/** Second fixture binding, so "several" is not one. */
const BINDING_B = 'bnd-cycle-b';

/** Third fixture binding. */
const BINDING_C = 'bnd-cycle-c';

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** Login the fixture issues are assigned to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Fixture creation stamp. */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Fixture credential — never a real one, and never expected in a response. */
const FIXTURE_TOKEN = 'fixture-token-not-a-real-credential';

/** Recorded `lastScanAt` the widened window opens from. */
const SCANNED_AT = '2026-09-27T06:00:00.000Z';

/** Saved overlap this suite writes into the configuration (20 minutes). */
const SAVED_OVERLAP_MS = 1_200_000;

/** The window the saved overlap opens: `SCANNED_AT − SAVED_OVERLAP_MS`. */
const WIDENED_SINCE = new Date(Date.parse(SCANNED_AT) - SAVED_OVERLAP_MS).toISOString();

/** Issue update stamp inside the widened window but before the recorded scan. */
const UPDATED_IN_WINDOW = new Date(Date.parse(SCANNED_AT) - 300_000).toISOString();

/** Saved page size AC-150 drives the request with. */
const SAVED_PER_PAGE = 12;

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-cycle-config-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

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
 * Build one active binding with only the assignment trigger on.
 *
 * @param bindingId - Id of the binding.
 * @returns A complete stored binding record.
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
 * Build the active account every fixture binding polls under.
 *
 * @returns A complete stored account record (a fixture token, never a real one).
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token: FIXTURE_TOKEN, kind: 'classic', verifiedAt: CREATED_AT },
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
 * @returns The normalized issue a fake poller answers with.
 */
function assignmentIssue(issueNumber: number, updatedAt: string): PollIssue {
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

/** What one fake-poller call was asked for. */
interface RecordedCall {
    /** `since` window the call opened. */
    readonly since: string | null;
    /** Page size and ladder the cycle carried to the call. */
    readonly pace: ListPace;
}

/**
 * Build a poller that answers with one fixed issue list and records its calls.
 *
 * @param issues - Issues to return on every call.
 * @returns The poller plus what each call was handed.
 */
function recordingPoller(issues: readonly PollIssue[]): {
    readonly poller: GitHubIssuePoller;
    readonly calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    const poller: GitHubIssuePoller = {
        listOpenIssues: async (input) => {
            calls.push({ since: input.since, pace: input.pace });

            return { kind: 'ok', issues };
        },
        // The M6/M7 feeds stay empty: every fixture binding keeps both
        // switches off, so the cycle never asks for them.
        listIssueComments: async () => ({ kind: 'ok', comments: [] }),
        listOpenPulls: async () => ({ kind: 'ok', pulls: [] }),
        // The per-item actor read (002 FR-049) answers the naming event for
        // whichever fixture issue the cycle asks about, with its own stamp so
        // the event is in-window whenever the listing let the candidate through.
        listIssueEvents: async (input) => {
            const candidate = issues.find((issue) => issue.issueNumber === input.issueNumber);
            if (candidate === undefined) {
                return { kind: 'ok', events: [], exhausted: false };
            }

            return {
                kind: 'ok',
                events: [{
                    event: 'assigned',
                    assignee: { login: ACCOUNT_LOGIN, type: 'User' },
                    assigner: { login: candidate.authorLogin, type: candidate.authorType },
                    requestedReviewer: { login: '', type: '' },
                    reviewRequester: { login: '', type: '' },
                    issueNumber: candidate.issueNumber,
                    createdAt: candidate.updatedAt ?? UPDATED_IN_WINDOW,
                }],
                exhausted: false,
            };
        },
    };

    return { poller, calls };
}

/**
 * Wrap a store so the configuration reads can be counted.
 *
 * @param inner - The real store.
 * @param onConfigRead - Called once per `config.json` read.
 * @returns A store whose only difference is that counter.
 */
function countingStore(inner: ServiceStore, onConfigRead: () => void): ServiceStore {
    return {
        ...inner,
        readJson: async <T>(
            relativePath: string,
            validate: (raw: unknown) => T | null,
        ): Promise<JsonReadResult<T>> => {
            if (relativePath === CONFIG_FILE) {
                onConfigRead();
            }

            return await inner.readJson(relativePath, validate);
        },
    };
}

/**
 * Wrap a store so the configuration read fails the way a bad disk would.
 *
 * @param inner - The real store.
 * @returns A store that rejects every `config.json` read and nothing else.
 */
function brokenConfigStore(inner: ServiceStore): ServiceStore {
    return {
        ...inner,
        readJson: async <T>(
            relativePath: string,
            validate: (raw: unknown) => T | null,
        ): Promise<JsonReadResult<T>> => {
            if (relativePath === CONFIG_FILE) {
                throw new Error('configuration unreadable');
            }

            return await inner.readJson(relativePath, validate);
        },
    };
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
 * Build one GitHub-shaped issues-list page, as text.
 *
 * GitHub's own field names are snake_case and the lint rules keep that out of
 * the code this project authors, so the fixture is assembled the way
 * `tests/github.test.ts` assembles its own — string pieces with the numbers
 * and stamps substituted in (the shape `readIssueEntry` consumes).
 *
 * @param count - How many entries the page carries.
 * @param updatedAt - `updated_at` stamp every entry carries.
 * @returns The page body as JSON text.
 */
function issuePage(count: number, updatedAt: string): string {
    const entry = [
        '{"number":ISSUE,"title":"Ticket #ISSUE",',
        '"html_url":"https://github.com/acme/widget/issues/ISSUE",',
        '"state":"open","body":null,',
        '"user":{"login":"alice","type":"User"},',
        '"assignees":[{"login":"LOGIN"}],"updated_at":"STAMP"}',
    ].join('');
    const entries: string[] = [];
    for (let index = 1; index <= count; index += 1) {
        const one = entry
            .replaceAll('ISSUE', String(index))
            .replace('LOGIN', ACCOUNT_LOGIN)
            .replace('STAMP', updatedAt);
        entries.push(one);
    }

    return `[${entries.join(',')}]`;
}

describe('one configuration read per cycle (006 T-007, FR-055)', () => {
    it('reads config.json exactly once, however many bindings the cycle walks', async () => {
        {
            await writeBindings({
                store,
                bindings: [fixtureBinding(BINDING_A), fixtureBinding(BINDING_B), fixtureBinding(BINDING_C)],
            });
            await writeAccount(store, fixtureAccount());
            await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, perPage: SAVED_PER_PAGE });
            const { log } = capturingLogger();
            const { poller, calls } = recordingPoller([assignmentIssue(7, UPDATED_IN_WINDOW)]);
            let configReads = 0;

            const cycle = await runScanCycle({
                store: countingStore(store, () => {
                    configReads += 1;
                }),
                log,
                poller,
            });

            expect(cycle.bindings).toHaveLength(3);
            expect(configReads).toBe(1);
            // The one read is what every consumer ran on: the page size and the
            // ladder the calls received are the stored document's own values.
            expect(calls.map((call) => call.pace.perPage)).toEqual([SAVED_PER_PAGE, SAVED_PER_PAGE, SAVED_PER_PAGE]);
            expect(calls[0]?.pace.retry).toEqual({
                maxAttempts: DEFAULT_CONFIG.retryMaxAttempts,
                baseMs: DEFAULT_CONFIG.retryBaseMs,
                maxMs: DEFAULT_CONFIG.retryMaxMs,
            });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
            await writeAccount(store, fixtureAccount());
            const { log, lines } = capturingLogger();
            const { poller, calls } = recordingPoller([assignmentIssue(7, UPDATED_IN_WINDOW)]);

            const cycle = await runScanCycle({ store: brokenConfigStore(store), log, poller });

            // The cycle never throws and the binding is still walked.
            expect(cycle.bindings).toHaveLength(1);
            expect(lines.some((line) => line.includes('cycle configuration read failed'))).toBe(true);
            // Defaults, not a half-read document: `DEFAULT_CONFIG.perPage` is 30.
            expect(calls[0]?.pace.perPage).toBe(DEFAULT_CONFIG.perPage);
        }
    });
});

describe('the window is widened by the saved overlap (006 T-008, FR-059(a), AC-149)', () => {
    it('opens since at lastScanAt minus overlapMs, and the widened replay queues nothing twice', async () => {
        await writeBindings({ store, bindings: [fixtureBinding(BINDING_A)] });
        await writeAccount(store, fixtureAccount());
        await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, overlapMs: SAVED_OVERLAP_MS });
        const { log } = capturingLogger();
        const issue = assignmentIssue(7, UPDATED_IN_WINDOW);
        const { poller, calls } = recordingPoller([issue]);

        // First cycle: a binding that never scanned replays with no window,
        // and the item lands in the queue.
        await plantScanState({ bindings: { [BINDING_A]: { lastScanAt: null, lastError: null } } });
        const first = await runScanCycle({ store, log, poller });
        expect(first.enqueued).toBe(1);
        expect(calls[0]?.since).toBeNull();

        // Second cycle: the recorded stamp is back, and the saved overlap
        // widens the window onto an item the queue already holds.
        await plantScanState({ bindings: { [BINDING_A]: { lastScanAt: SCANNED_AT, lastError: null } } });
        const second = await runScanCycle({ store, log, poller });

        expect(calls[1]?.since).toBe(WIDENED_SINCE);
        expect(Date.parse(WIDENED_SINCE)).toBeLessThan(Date.parse(SCANNED_AT));
        // The widened window re-observed the item; the deterministic id is
        // what keeps that from becoming a second event (002 FR-019).
        expect(second.enqueued).toBe(0);

        const state = await readScanState({ store, log });
        expect(state.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
    });
});

/**
 * Build the real poller over a fake transport that records its URLs.
 *
 * @param body - Body every request answers with.
 * @returns The poller and the URLs it was asked to fetch.
 */
function realPoller(body: string): {
    readonly poller: ReturnType<typeof createGitHubIssuePoller>;
    readonly requested: URL[];
} {
    const requested: URL[] = [];
    const { log } = capturingLogger();
    const poller = createGitHubIssuePoller({ log }, async (url) => {
        requested.push(new URL(url));

        return new Response(body, { status: 200 });
    });

    return { poller, requested };
}

/**
 * The pace a cycle of this configuration would carry.
 *
 * @param perPage - Configured page size.
 * @returns The pace the loop builds from a stored document.
 */
function paceFor(perPage: number): ListPace {
    return {
        perPage,
        retry: {
            maxAttempts: DEFAULT_CONFIG.retryMaxAttempts,
            baseMs: DEFAULT_CONFIG.retryBaseMs,
            maxMs: DEFAULT_CONFIG.retryMaxMs,
        },
    };
}

describe('the list request carries the configured page size (006 T-009, FR-059(b), AC-150)', () => {
    /** A page that fills a 12-item cap, so paging asks for a second page. */
    const FULL_PAGE = issuePage(SAVED_PER_PAGE, UPDATED_IN_WINDOW);

    it('asks for per_page=12 and stops at two pages, never a third', async () => {
        {
            const { poller, requested } = realPoller(FULL_PAGE);

            const result = await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace: paceFor(SAVED_PER_PAGE),
            });

            expect(result.kind).toBe('ok');
            expect(requested.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
            expect(requested.map((url) => url.searchParams.get('per_page'))).toEqual(['12', '12']);
            expect(NUMERIC_BOUNDS.perPage.max).toBe(30);
            for (const url of requested) {
                expect(Number(url.searchParams.get('per_page'))).toBeLessThanOrEqual(NUMERIC_BOUNDS.perPage.max);
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const { poller, requested } = realPoller(issuePage(SAVED_PER_PAGE - 1, UPDATED_IN_WINDOW));

            const result = await poller.listOpenPulls({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                pace: paceFor(SAVED_PER_PAGE),
            });

            expect(result.kind).toBe('ok');
            expect(requested).toHaveLength(1);
            expect(requested[0]?.searchParams.get('per_page')).toBe(String(SAVED_PER_PAGE));
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const { poller, requested } = realPoller(issuePage(1, UPDATED_IN_WINDOW));

            await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace: paceFor(NUMERIC_BOUNDS.perPage.max),
            });

            expect(requested).toHaveLength(1);
            expect(requested[0]?.searchParams.get('per_page')).toBe('30');
        }
    });
});

/** The vocabulary name 002 reserved for a configuration change (006 FR-070). */
const CONFIG_CHANGED_EVENT = 'config.changed';

/** The global tier's member, whose observation this suite drives (004 FR-081). */
const PROMPT_FIELD = 'startingPrompt';

/** The global tier's text this suite plants; a scan must never find it on disk. */
const TIER_SENTINEL = 'Rotate the deploy keys every quarter, from the vault only.';

/** The only shape a `startingPrompt` `from`/`to` may take in a row (004 FR-088). */
const FINGERPRINT_PAIR = /^(mtp-[0-9a-f]{32}|null)$/;

/** The shape of a *set* tier's side of the pair. */
const FINGERPRINT = /^mtp-[0-9a-f]{32}$/;

/** One `{ field, from, to }` triple as a row carries it (006 FR-071). */
interface ChangeTriple {
    /** Documented field that moved. */
    readonly field: string;
    /** What the row says was in force before. */
    readonly from: unknown;
    /** What the row says was put in force. */
    readonly to: unknown;
}

/**
 * Narrow one `changes` entry to the triple's three members.
 *
 * @param value - One entry as `unknown`, straight off the parsed row.
 * @returns `true` only for a complete triple.
 */
function isChangeTriple(value: unknown): value is ChangeTriple {
    return isRecord(value) && typeof value.field === 'string' && 'from' in value && 'to' in value;
}

/**
 * The `config.changed` rows of one trail read, oldest first.
 *
 * @param trail - Every row the trail held.
 * @returns The configuration rows alone.
 */
function configRows(trail: readonly AuditEntry[]): readonly AuditEntry[] {
    return trail.filter((entry) => entry.eventType === CONFIG_CHANGED_EVENT);
}

/**
 * Read a row's `changes` as triples, without casting anything through `any`.
 *
 * @param row - One stored row, or `undefined`.
 * @returns Every entry that already has the triple's three members.
 */
function changesOf(row: AuditEntry | undefined): readonly ChangeTriple[] {
    const changes = row?.details.changes;

    return Array.isArray(changes) ? changes.filter(isChangeTriple) : [];
}

/**
 * The `audit.ndjson` bytes as they sit on disk — the sentinel scan this
 * property is judged by runs against the **file**, never an in-memory object
 * (004 AC-151).
 *
 * @returns The whole trail, raw text.
 */
async function rawTrail(): Promise<string> {
    return await readFile(join(dataDir, AUDIT_FILE), 'utf8');
}

describe('the cycle observes the global tier (004 FR-088, 006 FR-070, plan N7)', () => {
    it('writes exactly one service row for a hand edit, and none when the file is read again', async () => {
        await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, startingPrompt: TIER_SENTINEL });
        const { log } = capturingLogger();
        const { poller } = recordingPoller([]);

        const cycle = await runScanCycle({ store, log, poller });

        expect(cycle.bindings).toEqual([]);
        const rows = configRows(await readAuditEntries(store));
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.eventType).toBe(CONFIG_CHANGED_EVENT);
        expect(row?.actorSource).toBe('service');
        expect(row?.decision).toBe('applied');
        expect(row?.entity).toEqual({ kind: 'service', id: 'configuration' });
        const [change] = changesOf(row).filter((entry) => entry.field === PROMPT_FIELD);
        expect(change?.from).toBeNull();
        expect(String(change?.from)).toMatch(FINGERPRINT_PAIR);
        expect(String(change?.to)).toMatch(FINGERPRINT);
        expect(row?.details.takesEffect).toEqual({ startingPrompt: 'next-cycle' });
        const raw = await rawTrail();
        expect(raw).not.toContain(TIER_SENTINEL);
        expect(raw).toContain(String(change?.to));
        // The baseline moved with the row: reading the same file again owes
        // nothing, so "exactly one row per change" holds for the second read.
        await runScanCycle({ store, log, poller });
        expect(configRows(await readAuditEntries(store))).toHaveLength(1);
    });

    it('writes none for the arrival fill: an absent member and the blank both read as unset', async () => {
        // (a) A document predating the member — exactly what an upgrade
        // installs — so the read fills it from the default and owes no row.
        const withoutMember = JSON.stringify(
            Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([field]) => field !== PROMPT_FIELD)),
        );
        await writeFile(join(dataDir, CONFIG_FILE), withoutMember, 'utf8');
        const { log } = capturingLogger();
        const { poller } = recordingPoller([]);

        await runScanCycle({ store, log, poller });

        expect(configRows(await readAuditEntries(store))).toEqual([]);
        expect(await readFile(join(dataDir, CONFIG_FILE), 'utf8')).toBe(withoutMember);

        // (b) The blank that fill produces: `""` ≡ `null` ≡ a fresh baseline.
        await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, startingPrompt: '' });

        await runScanCycle({ store, log, poller });

        expect(configRows(await readAuditEntries(store))).toEqual([]);
    });

    it('writes none after a restart with the file unchanged: the trail re-seeds the baseline', async () => {
        await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, startingPrompt: TIER_SENTINEL });
        const { log } = capturingLogger();
        const { poller } = recordingPoller([]);
        await runScanCycle({ store, log, poller });
        expect(configRows(await readAuditEntries(store))).toHaveLength(1);

        // A restart opens a fresh handle: the chain state that recorded the
        // change is gone, and only the trail is left to establish what has
        // already been recorded (no new store file, 004 NFR-129's posture).
        const restarted = await openStore({ dataDir });

        await runScanCycle({ store: restarted, log, poller });

        expect(configRows(await readAuditEntries(restarted))).toHaveLength(1);
        expect(await rawTrail()).not.toContain(TIER_SENTINEL);
    });

    it('warns when the append fails and still advances the baseline', async () => {
        await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, startingPrompt: TIER_SENTINEL });
        const { log, lines } = capturingLogger();
        const { poller } = recordingPoller([]);
        const append = store.appendLine.bind(store);
        store.appendLine = async (path: string, entry: unknown): Promise<void> => {
            if (path === AUDIT_FILE) {
                throw new Error('disk full');
            }

            await append(path, entry);
        };

        await runScanCycle({ store, log, poller });

        expect(lines.some((line) => line.includes('configuration change could not be recorded'))).toBe(true);
        // The warn names the loss, never what the tier says (004 FR-053).
        expect(lines.some((line) => line.includes(TIER_SENTINEL))).toBe(false);
        expect(configRows(await readAuditEntries(store))).toEqual([]);

        // The baseline moved anyway, so the cycle does not retry the lost row
        // on every later read — which is what this second pass proves: with a
        // stale baseline it would seed `null` from the empty trail, differ
        // from the file, and append the row this pass would then succeed at.
        store.appendLine = append;
        await runScanCycle({ store, log, poller });

        expect(configRows(await readAuditEntries(store))).toEqual([]);
    });
});
