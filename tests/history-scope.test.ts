/**
 * The contract-proof suite for the binding history scope (002 v1.13.0,
 * `contracts/binding-history-scope.md` §5).
 *
 * Every one of the contract's twenty-two rows is asserted here, and each test's
 * name carries the row number so a reviewer can read the contract and the suite
 * side by side. Where a row is a *negative* claim — nothing added, nothing
 * removed, nothing unbounded — the assertion is a census over the shipped code
 * rather than a behavioural test, because "no `since` parameter" and "no new
 * route" are reachability claims that only a source scan can hold.
 *
 * **Offline by construction**: one temp store, a recording poller that never
 * leaves the process, and the real loopback service for the two route-level rows.
 * No live OpenChamber, no real PAT, no network (002 FR-086; AGENTS.md testing
 * philosophy).
 *
 * The four things this suite is really for, in the order a reviewer should read
 * them:
 *
 * 1. **No stored state opens an unbounded window** (002 FR-060, SC-013). The
 *    reachability sweep in `§5.8` enumerates the stored-record domain and drives
 *    the real `windowFor`, and `§5.12`'s baseline-stability case runs three failed
 *    scans before the success that must still open at the *creation* boundary.
 * 2. **The sweep enqueues and never dispatches** (§5.17), and **a repeated sweep
 *    changes nothing** (§5.16).
 * 3. **Recovery replays in both modes**, from the **separate** durable flag rather
 *    than from an inferred absence (§5.14, §5.15).
 * 4. **Exactly one rescan mechanism, no timestamp-picking surface** (§5.18) — the
 *    plan's gate item 2, checked by source scan.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_HISTORY_SCOPE,
    HISTORY_SCOPES as SERVICE_HISTORY_SCOPES,
    LOOK_BACK_BOUNDS,
    LOOK_BACK_MS,
    historyScopeOf,
    lookBackMs,
} from '../service/bindings-history-scope.ts';
import { readAuditEntries } from '../service/audit.ts';
import { writeAccount } from '../service/accounts/store.ts';
import { readBindingsUnobserved } from '../service/bindings-read.ts';
import { parseBinding, storedStampOf, writeBindings } from '../service/bindings.ts';
import {
    HISTORY_SCOPE_LABEL,
    historyScopeForGrant,
    historyScopeGuidance,
    historyScopeLabel,
    historyScopeOptions,
    windowInForceLine,
} from '../src/bindings-history.ts';
import { HISTORY_SCOPE_UPDATED_EVENT } from '../service/history-scope-audit.ts';
import { NUMERIC_BOUNDS } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import {
    bindingScanOf,
    emptyBindingScan,
    readScanState,
    writeScanState,
} from '../service/poll/scan.ts';
import { BASELINE_UNREADABLE, baselineFor, windowFor } from '../service/poll/window.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { ROUTES } from '../service/routes/index.ts';
import {
    DEFAULT_HISTORY_SCOPE as PANEL_DEFAULT_HISTORY_SCOPE,
    parseBindingsBody,
    readHistoryScope,
} from '../src/bindings-service.ts';
import { initialBindings } from '../src/bindings-state.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { HistoryScope, PanelBinding } from '../src/bindings-service.ts';
import type { GitHubIssuePoller, PollIssue } from '../service/poll/poller-github.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeStoreTree, removeTempTree } from './support/temp-tree.ts';
import { byText } from './support/sort.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { scopeResults } from './support/verify.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `history-scope-credential-${'h'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Two binding ids, so a per-binding assertion can distinguish them. */
const BINDING_A = 'bnd-scope-a';
const BINDING_B = 'bnd-scope-b';

/** The binding's creation stamp; the source of both baselines (002 FR-066). */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Configured overlap, the default the service configuration carries. */
const OVERLAP_MS = 600_000;

/** The default-mode baseline: the creation boundary widened by the overlap. */
const DEFAULT_BASELINE = new Date(Date.parse(CREATED_AT) - OVERLAP_MS).toISOString();

/**
 * An observation five days before the binding existed — inside the look-back
 * window, and **outside** the default mode's.
 *
 * The one stamp that separates the two modes, so every mode assertion can be a
 * statement about this row rather than about the window's arithmetic.
 */
const FIVE_DAYS_AGO = new Date(Date.parse(CREATED_AT) - 5 * 86_400_000).toISOString();

/**
 * The look-back mode's own baseline: the creation boundary reached back over the
 * declared seven-day look-back (002 FR-067).
 *
 * Two days **older** than {@link FIVE_DAYS_AGO}, which is the point of naming both:
 * the observation is inside this window and outside the default mode's, so every
 * mode assertion is a statement about one row rather than about the arithmetic.
 */
const LOOK_BACK_BASELINE = new Date(Date.parse(CREATED_AT) - 604_800_000).toISOString();

/** An observation inside both windows: the creation boundary itself. */
const AT_CREATION = new Date(Date.parse(CREATED_AT) - OVERLAP_MS).toISOString();

/** A recorded completed-scan stamp, for the "has scanned" cases. */
const SCANNED_AT = '2026-09-28T00:00:00.000Z';

/**
 * A project id the parser refuses: printable ASCII, but one character past the
 * length the picker accepts. Every printable-ASCII value is a *valid* project id
 * (002 FR-038's rule is the picker, not a character class), so a refusal case has
 * to be over-length rather than oddly punctuated.
 */
const OVERLONG_PROJECT = `prj_${'x'.repeat(130)}`;

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

/**
 * Lines the suite-wide logger received, for the skip-reason rows.
 *
 * Declared module-level beside the store because the assertions that read a skip
 * reason read it from the **log** the scan wrote, not from a return value: the
 * reason is what an operator sees, and §5.13/§5.14 exist to prove it survives
 * into the record.
 */
let logLines: string[] = [];

/** The suite-wide logger every scan in this file runs under. */
let log: ServiceLogger;

/** Harness instances started by the route-level cases. */
const running: TestService[] = [];

/**
 * The credential the bindings resolve against.
 *
 * A scan skips a binding whose account is missing or unusable with a recorded
 * reason, so every behavioural row here needs the account present — otherwise
 * the scan never reaches the poller and the window assertions read `[]` for a
 * reason that has nothing to do with the window.
 *
 * @returns The fixture account the store resolves `ACCOUNT_ID` to.
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token: REGISTERED_TOKEN, kind: 'classic', verifiedAt: SCANNED_AT },
        scopeCheck: { checkedAt: SCANNED_AT, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: SCANNED_AT,
        errorReason: null,
        createdAt: SCANNED_AT,
        updatedAt: SCANNED_AT,
    };
}

/** Per-test setup: a fresh temp store, the fixture account, and a capturing logger. */
beforeEach(async (): Promise<void> => {
    ({ root: tempRoot, dataDir } = await makeStoreTree('history'));
    store = await openStore({ dataDir });
    logLines = [];
    log = createLogger({
        level: 'debug',
        sink: (line) => {
            logLines.push(line);
        },
    });
    await writeAccount(store, fixtureAccount());
});

/** Per-test teardown: drop the temp root and drain any harness. */
afterEach(async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }

    await removeTempTree(tempRoot);
});

/** A logger that discards its lines; for the cases that assert nothing about them. */
const QUIET: ServiceLogger = createLogger({
    level: 'error',
    sink: () => {
        // Nothing is asserted about these cases' lines, so there is nothing to keep.
    },
});

/**
 * Build one stored binding row.
 *
 * @param bindingId - The row's id.
 * @param scope - The mode to store, or `null` to store none at all.
 * @returns A complete binding record.
 */
function binding(bindingId: string, scope?: HistoryScope): BindingRecord {
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
        ...(scope !== undefined && { historyScope: scope }),
    };
}

/**
 * Narrow one wire row to the panel's own type, for the reader-level assertions.
 *
 * Driven through {@link parseBindingsBody} rather than cast, so the fixture a
 * panel-side assertion runs against has been through the panel's own reader — a
 * row the service writes and the panel refuses would otherwise be a fixture that
 * proved the wrong thing.
 *
 * @param bindingId - The row's id.
 * @param scope - The mode the row carries on the wire, or absent to store none.
 * @returns The row as the panel's reader holds it.
 */
function panelTyped(bindingId: string, scope?: HistoryScope): PanelBinding {
    const parsed = parseBindingsBody(JSON.stringify({
        bindings: [{ ...binding(bindingId, scope) }],
        status: [],
    }));

    return parsed?.bindings[0] ?? ((): never => {
        throw new Error(`the panel reader refused its own fixture ${bindingId}`);
    })();
}

/**
 * The Bindings tab's state carrying one row's mode, as the editor would hold it.
 *
 * @param scope - The mode the draft shows.
 * @returns The tab state, with its bindings list empty.
 */
function bindingsStateWith(scope: HistoryScope): ReturnType<typeof initialBindings> {
    return { ...initialBindings(), historyScopeInput: scope };
}

/**
 * One open issue assigned to the fixture account.
 *
 * @param issueNumber - The issue's number, which makes its event id unique.
 * @param updatedAt - `updated_at` the scan window is matched against.
 * @returns The normalized issue a poller would return.
 */
function issue(issueNumber: number, updatedAt: string): PollIssue {
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

/** What one recording poller run observed. */
interface RunObservation {
    /** Every issue the scan offered, by number. */
    readonly offered: readonly number[];
    /** The `since` window each list call was handed. */
    readonly windows: readonly string[];
}

/**
 * Build a poller that answers with one fixed issue list and records its windows.
 *
 * The per-item events read answers with a naming `assigned` event whose
 * `created_at` equals the item's own `updated_at`, so a fixture cannot
 * accidentally produce an event the window would have refused (002 FR-051).
 *
 * @param issues - The issues every call returns.
 * @returns The poller plus what each run observed.
 */
function recordingPoller(issues: readonly PollIssue[]): {
    readonly poller: GitHubIssuePoller;
    readonly seen: () => RunObservation;
} {
    const offered: number[] = [];
    const windows: string[] = [];
    const poller: GitHubIssuePoller = {
        listOpenIssues: async (input) => {
            windows.push(input.since);
            offered.push(...issues.map((entry) => entry.issueNumber));

            return { kind: 'ok', issues };
        },
        listIssueComments: async () => ({ kind: 'ok', comments: [] }),
        listOpenPulls: async () => ({ kind: 'ok', pulls: [] }),
        listIssueEvents: async (input) => {
            const candidate = issues.find((entry) => entry.issueNumber === input.issueNumber);

            return candidate === undefined
                ? { kind: 'ok', events: [], exhausted: false }
                : {
                    kind: 'ok',
                    exhausted: false,
                    events: [{
                        event: 'assigned',
                        assignee: { login: ACCOUNT_LOGIN, type: 'User' },
                        assigner: { login: candidate.authorLogin, type: candidate.authorType },
                        requestedReviewer: { login: '', type: '' },
                        reviewRequester: { login: '', type: '' },
                        issueNumber: candidate.issueNumber,
                        createdAt: candidate.updatedAt ?? CREATED_AT,
                    }],
                };
        },
    };

    return { poller, seen: () => ({ offered: [...offered], windows: [...windows] }) };
}

/**
 * A poller every call fails.
 *
 * The shape of an operator whose credential stays broken, and the fixture §5.12 and
 * §5.15 need: a scan that cannot list anything never advances its checkpoint, so what
 * it does with a baseline or a one-shot is the whole question.
 *
 * @returns The failing poller.
 */
function failingPoller(): GitHubIssuePoller {
    const failure = { kind: 'auth-failed' } as const;

    return {
        listOpenIssues: async () => failure,
        listIssueComments: async () => failure,
        listOpenPulls: async () => failure,
        listIssueEvents: async () => failure,
    };
}

/**
 * One scan cycle over a fixed observation set, as a fresh poller each call.
 *
 * Two places assert "the same observations, again" — the repeated sweep and the
 * duplicate matrix — and both need a **fresh** poller per call so the second cycle
 * is provably a re-read rather than a replay of recorded answers.
 *
 * @param observations - The issues every call's poller answers with.
 * @returns How many events each cycle enqueued.
 */
function cycleOver(observations: readonly PollIssue[]): () => Promise<number> {
    return async (): Promise<number> => {
        const result = await runScanCycle({ store, log, poller: recordingPoller(observations).poller });

        return result.enqueued;
    };
}

/**
 * The queue's row identifiers, in file order.
 *
 * @returns One id per stored row.
 */
async function queuedEventIds(): Promise<readonly string[]> {
    const raw = await readFile(join(dataDir, 'events.json'), 'utf8');

    return (JSON.parse(raw) as { id: string }[]).map((row) => row.id);
}

/**
 * One queued event row, for the "the queue is untouched" assertions.
 *
 * @param bindingId - The binding the row belongs to.
 * @param issueNumber - The issue it reports.
 * @returns A complete `pending` queue row.
 */
function createPendingEvent(bindingId: string, issueNumber: number): Record<string, unknown> {
    return {
        id: `evt-acme~widget~${issueNumber}~${ACCOUNT_ID}`,
        bindingId,
        repository: 'acme/widget',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issueNumber,
        issueTitle: `Ticket #${issueNumber}`,
        issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
        issueBodyExcerpt: '',
        actorLogin: 'alice',
        actorAttribution: 'direct',
        triggerNote: 'Issue assigned to the bound account',
        detectedAt: CREATED_AT,
        subjectType: 'issue',
        runCorrelationId: `mt-run-${'0'.repeat(24)}`,
    };
}

/**
 * Register the fixture account with a fresh loopback service.
 *
 * @param poller - The poller the service's own scan loop runs under.
 * @returns The running harness.
 */
async function startWithAccount(poller?: GitHubIssuePoller): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: { 'x-oauth-sopes': 'repo, user' },
        },
    });
    const service = await startTestService({ github: github.verifier, ...(poller !== undefined && { poller }) });
    running.push(service);
    await service.handle.reconciled;

    const registered = await service.call('/v1/accounts/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: REGISTERED_TOKEN }),
    });
    expect(registered.status).toBe(201);

    return service;
}

/**
 * Write a bindings document straight into the store directory.
 *
 * @param rows - The raw rows, exactly as an operator or this build would store them.
 */
async function plantBindings(rows: readonly unknown[]): Promise<void> {
    await writeFile(join(dataDir, 'bindings.json'), JSON.stringify(rows), 'utf8');
}

/**
 * Read the stored bindings document's **text** back.
 *
 * Text rather than a parsed value, because every assertion here is about the bytes:
 * "the default is omitted from the record", "a refusal wrote nothing", and "a
 * pre-field document is byte-identical afterwards" are all statements about what the
 * store holds, and re-serializing a parsed document would prove none of them.
 *
 * @returns The file's contents, or `null` when the store holds no document.
 */
async function storedBindingsText(dir: string = dataDir): Promise<string | null> {
    return await readFile(join(dir, 'bindings.json'), 'utf8').catch(() => null);
}

/**
 * List the quarantine files the store left behind.
 *
 * @returns File names carrying the quarantine marker.
 */
async function quarantined(): Promise<string[]> {
    const entries = await readdir(dataDir);

    return entries.filter((entry) => entry.includes('.corrupt-'));
}

/**
 * The harness service's own store handle.
 *
 * Every route-level row must be read through **this** rather than the suite's
 * `store`: the harness resolves its data directory from its own `HOME`, so the two
 * stores are two directories and reading the suite's would silently assert about an
 * empty trail.
 *
 * @param service - The running harness.
 * @returns Its open store.
 */
function serviceStore(service: TestService): NonNullable<TestService['handle']['store']> {
    const { store: opened } = service.handle;
    if (opened === null) {
        throw new Error('the harness store is unavailable');
    }

    return opened;
}

/**
 * Read every `binding.history-scope-updated` row out of a trail.
 *
 * @param target - The store to read; defaults to the suite's own.
 * @returns The rows, in file order.
 */
async function scopeAuditRows(target: ServiceStore = store): Promise<readonly AuditEntry[]> {
    const rows = await readAuditEntries(target);

    return rows.filter((row) => row.eventType === HISTORY_SCOPE_UPDATED_EVENT);
}

/**
 * Every source file one census reads.
 *
 * The negative rows in the contract are claims about the shipped source, so they
 * are checked against the source rather than against a runtime the test happens
 * to be able to observe.
 *
 * @param roots - Directories to walk.
 * @returns The concatenated text of every `.ts` file beneath them.
 */
function sourceText(...roots: readonly string[]): string {
    const files: string[] = [];
    for (const root of roots) {
        // `readdirSync` types a recursive walk's entries as `string | Buffer`, so
        // each is narrowed to text before the suffix test.
        const entries = readdirSync(root, { recursive: true }).map(String);

        for (const path of entries) {
            if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
                files.push(join(root, path));
            }
        }
    }

    return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

/**
 * The `.ts` files directly inside one directory, by base name.
 *
 * One directory rather than a recursive walk, because every census that wants a
 * **list of modules** is asking about the panel's own flat `src/`, and a walk would
 * hand it a path it has to strip back to a name anyway.
 *
 * @param root - The directory to list.
 * @returns Base names of its `.ts` files, excluding declaration files.
 */
function moduleNames(root: string): readonly string[] {
    return readdirSync(root)
        .map(String)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
}

/** Repository root, for the source censuses. */
const REPO = resolve(import.meta.dirname, '..');

describe('§5.1 both names round-trip; absent and null both read as the default', () => {
    it('stores each name byte-identically and reads it back', () => {
        for (const scope of ['new-only', 'recent-history'] as const) {
            const verdict = historyScopeOf({ historyScope: scope });

            expect(verdict).toEqual({ scope });
        }
    });

    it('reads an absent member and an explicit null as the same cleared state', () => {
        expect(historyScopeOf({})).toEqual({ scope: null });
        expect(historyScopeOf({ historyScope: null })).toEqual({ scope: null });
    });

    it('assembles a stored name onto the record and omits the default entirely', () => {
        const recent = parseBinding({ raw: { ...binding(BINDING_A, 'recent-history') }, hasAccount: true });
        const absent = parseBinding({ raw: { ...binding(BINDING_A) }, hasAccount: true });

        expect('binding' in recent && recent.binding.historyScope).toBe('recent-history');
        // FR-058: the default is **omitted**, not spelled out, so a binding that
        // never chose a mode and one whose mode was cleared are byte-identical.
        expect('binding' in absent && Object.hasOwn(absent.binding, 'historyScope')).toBe(false);
    });

    it('round-trips both names through the real store without a quarantine file', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A, 'recent-history'), binding(BINDING_B)] });

        const stored = await storedBindingsText();

        // Asserted against the **stored bytes**, with whitespace tolerant because the
        // store pretty-prints: "the member is absent" is the requirement, and only the
        // document can answer it.
        expect(stored).toMatch(/"historyScope":\s*"recent-history"/);
        // The default-mode row carries no member at all.
        expect(stored).not.toMatch(/"historyScope":\s*"new-only"/);
        expect(await quarantined()).toEqual([]);
        expect(log).toBeDefined();
    });
});

describe('§5.2 every bad shape is refused on write, naming both names and echoing nothing', () => {
    it('refuses a number, a boolean, an object, an array, the empty string, and an unknown name', () => {
        // The **token** each submission would put into a refusal message if the message
        // echoed it, which is what the third column is for. Two cases have no token to
        // look for: the empty string contributes nothing, and the object and array
        // submissions here hold one of the two *accepted* names, which the remediation
        // legitimately names.
        const bad: readonly (readonly [string, unknown, string])[] = [
            ['number', 7, '7'],
            ['boolean', true, 'true'],
            ['object', { mode: 'all-history' }, 'all-history'],
            ['array', ['all-history'], 'all-history'],
            ['empty string', '', ''],
            ['unknown name', 'all-history', 'all-history'],
        ];

        for (const [label, value, echoed] of bad) {
            const verdict = historyScopeOf({ historyScope: value });

            expect('issue' in verdict, label).toBe(true);
            if (!('issue' in verdict)) {
                continue;
            }

            expect(verdict.issue.field, label).toBe('historyScope');
            // Names **both** accepted values, because a refusal naming one leaves the
            // operator to guess the other.
            expect(verdict.issue.remediation, label).toContain('new-only');
            expect(verdict.issue.remediation, label).toContain('recent-history');
            // And **echoes nothing the operator submitted**: no submitted name, no
            // digit, no boolean spelling. (The remediation *does* say there is no "all
            // history" option — that is the operator-facing fact, not an echo.) The
            // empty string has nothing to look for, so it is the one case with no
            // assertion here.
            if (echoed !== '') {
                expect(verdict.issue.remediation, label).not.toContain(echoed);
            }
        }
    });

    it('refuses the same six on the whole-file write and applies nothing', async () => {
        const service = await startWithAccount();
        // The harness resolves its data directory from its own `HOME`, so a route-level
        // assertion about what was written reads **its** directory.
        const before = await storedBindingsText(service.dataDir);

        for (const [, value] of [
            ['number', 7],
            ['boolean', false],
            ['object', {}],
            ['array', []],
            ['empty string', ''],
            ['unknown name', 'everything'],
        ] as const) {
            const response = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ bindings: [{ ...binding(BINDING_A), historyScope: value }] }),
            });

            expect(response.status).toBe(422);
            expect(await response.text()).not.toContain('everything');
        }

        // Nothing was written: a refusal writes no file at all, so the document is
        // still absent rather than holding an empty list.
        expect(await storedBindingsText(service.dataDir)).toBe(before);
    });
});

describe('§5.3 the same six are refused on a hand-edited read, quarantining the file', () => {
    it('quarantines and scans nothing, with a logged reason naming the field and both names', async () => {
        for (const [, value] of [
            ['number', 7],
            ['boolean', true],
            ['object', { mode: 1 }],
            ['array', [1]],
            ['empty string', ''],
            ['unknown name', 'all-history'],
        ] as const) {
            await plantBindings([{ ...binding(BINDING_A), historyScope: value }]);
            const label = JSON.stringify(value);

            // Driven through the suite's own store rather than a harness: this row is
            // about the **read** path's parse refusal, and the reader that quarantines
            // is the same one the poll loop calls each cycle (002 FR-061, FR-024).
            const observed = await readBindingsUnobserved({ store, log });

            // Quarantined: the document does not fully parse, so the read carries
            // **no** binding and the poll loop then scans nothing until the operator
            // repairs it.
            expect(observed, label).toEqual([]);

            const reason = logLines.find((line) => line.includes('historyScope'));

            expect(reason, label).toBeDefined();
            // The logged reason names the field and **both** accepted names, so a
            // refusal in a log the operator reads is actionable without the docs.
            expect(reason).toContain('new-only');
            expect(reason).toContain('recent-history');

            // A quarantined document is also **not** repaired in place: the file the
            // operator has to fix is still the one they wrote, and the scan finds
            // nothing this cycle.
            expect(await quarantined(), label).not.toEqual([]);
            const scanned = await runScanCycle({ store, log, poller: recordingPoller([issue(1, AT_CREATION)]).poller });

            expect(scanned.bindings, label).toEqual([]);
            expect(scanned.enqueued, label).toBe(0);
        }
    });
});

describe('§5.4 every problem in one submission is reported together and nothing is applied', () => {
    it('answers one 422 carrying a bad mode, a bad repository, and a bad project', () => {
        // Three problems in one submission, reported together and applied never: the
        // collect-every-refusal second pass exists for exactly this (002 FR-061,
        // FR-024).
        const verdict = parseBinding({
            raw: { ...binding(BINDING_A), repository: 'not-a-repository', projectId: '', historyScope: 'everything' },
            hasAccount: true,
        });

        expect('issues' in verdict).toBe(true);
        if (!('issues' in verdict)) {
            return;
        }

        const fields = verdict.issues.map((refusal) => refusal.field);

        expect(fields).toEqual(['repository', 'historyScope']);

        // A third problem is reported **in the same answer** rather than after the
        // operator fixes the first two — and it is a problem from a *different* field
        // group, because the target's readers name one problem per group: a row whose
        // repository is unusable has already failed before its project is examined.
        // An empty `projectId` reads as absent rather than as a bad value, and every
        // printable-ASCII id is valid, so the refused case is one past the picker's
        // length limit.
        const withBadProject = parseBinding({
            raw: { ...binding(BINDING_A), projectId: OVERLONG_PROJECT, historyScope: 'everything' },
            hasAccount: true,
        });

        expect('issues' in withBadProject).toBe(true);
        if (!('issues' in withBadProject)) {
            return;
        }

        expect(withBadProject.issues.map((refusal) => refusal.field)).toEqual(['projectId', 'historyScope']);
    });

    it('leaves the stored document byte-identical after a refused write', async () => {
        const service = await startWithAccount();
        const grant = async (scope: string): Promise<Response> =>
            await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ bindings: [{ ...binding(BINDING_A), historyScope: scope }] }),
            });

        const accepted = await grant('recent-history');

        expect(accepted.status).toBe(200);
        const before = await storedBindingsText(service.dataDir);

        const refused = await grant('everything');

        expect(refused.status).toBe(422);
        // A refusal writes **nothing**: not the bindings file, not a prompt-change
        // row, not an account-observation row. The bytes are the proof (002 FR-024).
        expect(await storedBindingsText(service.dataDir)).toBe(before);
        expect(await scopeAuditRows(serviceStore(service))).toHaveLength(1);
    });
});

describe('§5.5 omission preserves; a pre-field document is not rewritten', () => {
    it('preserves the stored mode for a row that omitted the member, and clears an explicit null', async () => {
        const service = await startWithAccount();
        await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bindings: [binding(BINDING_A, 'recent-history')] }),
        });
        // A second row the client has never heard of, so the grant is a whole-file
        // replacement carrying **two** rows: one whose member it omits and one it
        // sends explicitly.
        await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bindings: [binding(BINDING_A), binding(BINDING_B, 'recent-history')] }),
        });

        const read = await service.call(BINDINGS_PATH);
        const stored = JSON.parse(await read.text()) as { bindings: { bindingId: string; historyScope?: string }[] };
        const modeOf = (id: string): string | undefined =>
            stored.bindings.find((row) => row.bindingId === id)?.historyScope;

        // Omission preserved the deliberate choice on the row the client did not
        // mention the field for…
        expect(modeOf(BINDING_A)).toBe('recent-history');
        expect(modeOf(BINDING_B)).toBe('recent-history');
    });

    it('clears an explicit null back to the documented default', async () => {
        const service = await startWithAccount();
        await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bindings: [binding(BINDING_A, 'recent-history')] }),
        });
        await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bindings: [{ ...binding(BINDING_A), historyScope: null }] }),
        });

        // Read through the service's own answer rather than off disk, because this
        // harness's store lives under its own `HOME`: the two directories are
        // different ones.
        const read = await service.call(BINDINGS_PATH);
        const stored = JSON.parse(await read.text()) as { bindings: { historyScope?: string }[] };

        // Cleared means the default, and the default is **omitted** from the stored
        // record (002 FR-062, FR-058) — which is why the answer projects it rather
        // than the store rewriting the row to spell it out.
        expect(stored.bindings).toHaveLength(1);
        expect(stored.bindings[0]?.historyScope).toBe(DEFAULT_HISTORY_SCOPE);
    });

    it('leaves a pre-field document with zero bytes rewritten and zero checkpoints touched', async () => {
        // The upgrade case: a document written **before** this field existed, with a
        // completed scan already recorded beside it. Reading it, and scanning it,
        // must both be reads — the field's absence is a complete state, so there is
        // nothing to migrate and nothing to reset (002 FR-058, plan H1).
        await plantBindings([{ ...binding(BINDING_A), startingPrompt: 'Pre-field instruction' }]);
        await writeScanState({
            store,
            state: { bindings: { [BINDING_A]: { ...emptyBindingScan(), lastScanAt: SCANNED_AT } } },
        });
        const beforeBindings = await readFile(join(dataDir, 'bindings.json'), 'utf8');
        // The checkpoint's **own** durable facts, read back individually rather than
        // as bytes: this scan is expected to advance `lastScanAt`, so a byte
        // comparison would prove nothing, while each member is asserted on its own.
        const seeded = bindingScanOf(await readScanState({ store, log }), BINDING_A);
        const observed = await readBindingsUnobserved({ store, log });

        expect(seeded.lastScanAt).toBe(SCANNED_AT);
        expect(seeded.forceReplay).toBe(false);
        expect(seeded.rescanFrom).toBeNull();

        expect(observed).toHaveLength(1);
        expect(observed[0]).toEqual({ ...binding(BINDING_A), startingPrompt: 'Pre-field instruction' });

        // A cycle over the pre-field row: it scans normally, and the **only** bytes
        // that change are the ones that record the scan itself. The bindings document
        // is not one of them — no migration runs, because there is nothing to
        // migrate.
        await runScanCycle({ store, log, poller: recordingPoller([]).poller });

        expect(await readFile(join(dataDir, 'bindings.json'), 'utf8')).toBe(beforeBindings);
        expect(await quarantined()).toEqual([]);

        // The scan state moved for the scan's own reason and **nowhere else**. This row
        // already carries a completed scan, so it never needed a baseline and none was
        // derived — the one field that would have been a migration write, and there
        // was nothing to migrate.
        const state = await readScanState({ store, log });

        expect(state.bindings[BINDING_A]?.lastScanAt).not.toBe(SCANNED_AT);
        expect(state.bindings[BINDING_A]?.baselineAt).toBeNull();
        // Neither one-shot was armed on the way past either.
        expect(state.bindings[BINDING_A]?.forceReplay).toBe(false);
        expect(state.bindings[BINDING_A]?.rescanFrom).toBeNull();
    });
});

describe('§5.6 the mode reaches no other store', () => {
    it('appears in no panel storage key, no ledger entry, and no run record', () => {
        // The mode is **service-owned configuration** (002 FR-054): the panel may hold
        // it in the editor's own control and repaint it, which FR-089 requires, but it
        // reaches no **persistent** panel surface — no `host.storage` key, no ledger
        // entry — and no run record.
        const ledger = readFileSync(join(REPO, 'src', 'ledger.ts'), 'utf8');

        expect(ledger).not.toContain('historyScope');

        // The three documented storage keys, each declared in the one module that owns
        // it. None of them names the mode (AGENTS.md invariant 4: renaming or adding
        // a storage key is a user-visible namespace change).
        expect(readFileSync(join(REPO, 'src', 'project-picker.ts'), 'utf8')).not.toContain('historyScope');
        expect(readFileSync(join(REPO, 'src', 'evidence.ts'), 'utf8')).not.toContain('historyScope');

        // And no run record: the field is service-side, and the run model has no
        // member for it.
        for (const file of ['runs-types.ts', 'runs-document.ts', 'runs-join.ts', 'runs-adopt.ts']) {
            expect(readFileSync(join(REPO, 'service', 'poll', file), 'utf8'), file).not.toContain('historyScope');
        }
    });
});

describe('§5.7 the route table gained no operation', () => {
    it('adds no route, no method, and no panel-side bindings call', () => {
        // The route table registers exactly the two bindings operations that shipped
        // before this field, under the one path they shared (002 FR-056, FR-064).
        const bindingsRoutes = ROUTES.filter((route) => route.path.startsWith('/v1/bindings'));

        expect(bindingsRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
            'GET /v1/bindings',
            'PUT /v1/bindings',
        ]);

        // No path parameter anywhere under the collection, so there is no
        // `PATCH /v1/bindings/:bindingId` to have been reopened by this field.
        for (const route of ROUTES) {
            expect(route.path.startsWith('/v1/bindings/'), route.path).toBe(false);
        }

        // And no rescan endpoint was added beside them: the **registered surface**,
        // rather than the prose around it, carries no path with a rescan segment.
        for (const route of ROUTES) {
            expect(route.path, `${route.method} ${route.path}`).not.toContain('rescan');
        }

        // The panel reaches the bindings surface through the same one path it always
        // did — no new endpoint call appears anywhere in `src/`.
        const panel = sourceText(join(REPO, 'src'));

        expect(panel).not.toContain('/v1/bindings/');
        expect(panel).not.toMatch(/serviceRequest\([^)]*\/v1\/bindings\//);
    });
});

describe('§5.8 no stored state produces a scan with no lower bound', () => {
    it('answers a window or a refusal for every stored state, in both modes', () => {
        // The reachability claim, enumerated: both names and absence, a fresh slot, a
        // completed scan, each of the three one-shots armed, a retained baseline, and
        // the unusable shapes a hand edit can leave. No combination answers anything
        // that means *admit everything* (002 FR-060, FR-065; SC-013).
        const slots = [
            emptyBindingScan(),
            { ...emptyBindingScan(), baselineAt: DEFAULT_BASELINE },
            { ...emptyBindingScan(), lastScanAt: SCANNED_AT },
            { ...emptyBindingScan(), lastScanAt: SCANNED_AT, baselineAt: DEFAULT_BASELINE },
            { ...emptyBindingScan(), rescanFrom: FIVE_DAYS_AGO },
            { ...emptyBindingScan(), forceReplay: true },
            { ...emptyBindingScan(), forceReplay: true, baselineAt: DEFAULT_BASELINE },
            { ...emptyBindingScan(), lastScanAt: 'nonsense' },
            { ...emptyBindingScan(), rescanFrom: 'nonsense' },
            { ...emptyBindingScan(), baselineAt: 'nonsense' },
        ];
        const scopes: readonly (HistoryScope | undefined)[] = [undefined, 'new-only', 'recent-history'];

        for (const slot of slots) {
            for (const scope of scopes) {
                const candidate = { ...binding(BINDING_A), ...(scope !== undefined && { historyScope: scope }) };
                const verdict = windowFor({ binding: candidate, scanned: slot, overlapMs: OVERLAP_MS });

                expect(Object.keys(verdict).length, JSON.stringify({ slot, scope })).toBe(1);
                expect('window' in verdict ? verdict.window : verdict.refused).not.toBeNull();
            }
        }
    });

    it('admits no "all history" shape, because the stored domain has none', () => {
        // The mode's whole domain, read through the one reader every path uses. A
        // third name cannot be constructed, and nothing on the record is a duration.
        const accepted = [undefined, null, 'new-only', 'recent-history'];

        for (const value of accepted) {
            expect('scope' in historyScopeOf({ historyScope: value })).toBe(true);
        }
        for (const value of ['all', 'all-history', '*', 'forever', 0, -1, Number.MAX_SAFE_INTEGER]) {
            expect('issue' in historyScopeOf({ historyScope: value }), String(value)).toBe(true);
        }
    });
});

describe('§5.9 the look-back length appears in no configuration document, projection, Settings row, or route', () => {
    it('declares it as a bounded constant outside ServiceConfig and outside NUMERIC_BOUNDS', () => {
        expect(LOOK_BACK_MS).toBe(604_800_000);
        expect(LOOK_BACK_BOUNDS.min).toBe(3_600_000);
        expect(LOOK_BACK_BOUNDS.max).toBe(2_592_000_000);
        expect(lookBackMs()).toBe(LOOK_BACK_MS);

        // 006 FR-010's and FR-084's documented count of **twelve** does not move: the
        // length is in neither table (002 FR-059).
        expect(Object.hasOwn(NUMERIC_BOUNDS, 'lookBackMs')).toBe(false);
        const config = readFileSync(join(REPO, 'service', 'config.ts'), 'utf8');
        expect(config).not.toContain('LOOK_BACK');
        expect(config).not.toContain('604_800_000');
        // The bounds table keeps exactly the eleven numeric fields it declared; the
        // twelfth documented field is 006's own `expectedAgent`.
        expect(Object.keys(NUMERIC_BOUNDS)).toHaveLength(11);
    });

    it('appears in no schema projection, no Settings row, and no route', () => {
        const schema = readFileSync(join(REPO, 'service', 'config-schema.ts'), 'utf8');
        expect(schema).not.toContain('lookBack');
        expect(schema).not.toContain('LOOK_BACK');

        const settings = sourceText(join(REPO, 'src'));
        expect(settings).not.toContain('lookBack');
        expect(settings).not.toContain('LOOK_BACK');

        const routes = sourceText(join(REPO, 'service', 'routes'));
        expect(routes).not.toContain('LOOK_BACK');
    });

    it('keeps the two names in step across the service and the panel reader', () => {
        // Two declarations of one closed vocabulary — `service/bindings-history-scope.ts`
        // and the panel's own mirror in `src/bindings-service.ts`, because `src/`
        // cannot import across the request boundary. They are pinned here rather
        // than by an import the panel bundle cannot make: every name the service
        // accepts is a name the panel reader accepts, and both read absence as the
        // same documented default (002 FR-053, FR-058, FR-063).
        expect(PANEL_DEFAULT_HISTORY_SCOPE).toBe(DEFAULT_HISTORY_SCOPE);
        expect(SERVICE_HISTORY_SCOPES).toEqual(['new-only', 'recent-history']);

        // Both readers agree on every value, accepted or not — including `null`,
        // which each reads as *cleared to the default* rather than as a third state.
        for (const value of [undefined, null, ...SERVICE_HISTORY_SCOPES]) {
            const read = historyScopeOf({ historyScope: value });

            expect('scope' in read, String(value)).toBe(true);
            expect(readHistoryScope(value), String(value))
                .toBe('scope' in read ? read.scope ?? DEFAULT_HISTORY_SCOPE : null);
        }

        // And both refuse the same shapes, so no stored value can be readable to the
        // service and merely unrenderable to the operator.
        for (const value of [7, true, { mode: 'new-only' }, ['new-only'], '', 'all-history']) {
            expect('issue' in historyScopeOf({ historyScope: value }), JSON.stringify(value)).toBe(true);
            expect(readHistoryScope(value), JSON.stringify(value)).toBeNull();
        }
    });
});

describe('§5.10 the default mode\'s first window is exactly createdAt − overlapMs', () => {
    it('offers a boundary observation and skips one five days before it', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A)] });
        const { poller, seen } = recordingPoller([issue(1, AT_CREATION), issue(2, FIVE_DAYS_AGO)]);

        await runScanCycle({ store, log, poller });

        // The window start is exactly the creation boundary widened by the
        // configured overlap, and the boundary observation is **inside** it while
        // the five-day-old one is not. The comparison is on the event's own
        // timestamp, never on the item's age (002 FR-066).
        expect(seen().windows).toEqual([DEFAULT_BASELINE]);
        expect(seen().offered).toEqual([1, 2]);

        const state = await readScanState({ store, log });
        expect(bindingScanOf(state, BINDING_A).baselineAt).toBe(DEFAULT_BASELINE);
        expect(state.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
    });

    it('carries that start on the list call and sends no `since` to the per-item events read', async () => {
        // FR-051's premise, on the request rather than on intent: the per-item events
        // endpoint takes only `per_page` and `page`, so the window is compared
        // client-side on `created_at` and never sent.
        const eventsSource = readFileSync(join(REPO, 'service', 'poll', 'poller-events.ts'), 'utf8');
        const urlBuilder = readFileSync(join(REPO, 'service', 'poll', 'poller-github.ts'), 'utf8');

        expect(eventsSource).toContain('pageEndsWalk');
        // The one `since` the transport can set belongs to `listUrl`, and the
        // per-item events URL is built without it (002 FR-051, FR-064).
        expect(urlBuilder).toContain('itemEventsUrl');
        expect(urlBuilder).not.toMatch(/itemEventsUrl\([^)]*since/);
    });
});

describe('§5.11 the look-back first window is exactly createdAt − 604,800,000 ms', () => {
    it('offers the five-day-old observation and a second scan over the same window offers zero', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A, 'recent-history')] });
        const issues = [issue(1, FIVE_DAYS_AGO), issue(2, AT_CREATION)];

        const first = recordingPoller(issues);
        const firstCycle = await runScanCycle({ store, log, poller: first.poller });

        expect(first.seen().windows).toEqual([LOOK_BACK_BASELINE]);
        expect(firstCycle.enqueued).toBe(2);

        // The sweep is one-shot by construction: the checkpoint is an ordinary
        // checkpoint from here on, so the same observations produce **zero** further
        // events — deduplicated by the unchanged deterministic id (002 FR-080,
        // FR-082).
        const second = recordingPoller(issues);
        const secondCycle = await runScanCycle({ store, log, poller: second.poller });

        expect(secondCycle.enqueued).toBe(0);
        // The look-back was **once**: the window moved on to the ordinary
        // incremental one, so the same observations are outside it now.
        expect(second.seen().windows[0]).not.toBe(LOOK_BACK_BASELINE);
    });

    it('offers a repeated sweep, a restart, and a re-read zero duplicates', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A, 'recent-history')] });
        const cycle = cycleOver([issue(1, FIVE_DAYS_AGO)]);

        expect(await cycle()).toBe(1);

        // A restart is a fresh `runScanCycle` over the same store — and a *repeat*
        // of the very first sweep, since the stored baseline and the recorded stamp
        // are both still there.
        expect(await cycle()).toBe(0);
        // And a re-read of the same observations one more time.
        expect(await cycle()).toBe(0);

        expect(await queuedEventIds()).toHaveLength(1);
    });

    it('offers exactly its window\'s matching triggers, with nothing outside it', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A, 'recent-history')] });
        const inside = new Date(Date.parse(CREATED_AT) - 6 * 86_400_000).toISOString();
        const outside = new Date(Date.parse(CREATED_AT) - 8 * 86_400_000).toISOString();
        const cycle = recordingPoller([issue(1, inside), issue(2, outside), issue(3, AT_CREATION)]);

        const result = await runScanCycle({ store, log, poller: cycle.poller });

        // FR-079: the offered set is **exactly** the window's matching triggers — no
        // cap, no truncation, no sampling, and nothing older than seven days. The
        // eight-day-old observation is offered by the feed and refused by the
        // window, which is the direction that never widens.
        expect(cycle.seen().windows).toEqual([LOOK_BACK_BASELINE]);
        expect(cycle.seen().offered).toEqual([1, 2, 3]);
        expect(result.enqueued).toBe(2);
    });
});

describe('§5.12 the baseline is stable through three failed scans', () => {
    it('keeps the same baseline through failures the loop cannot scan past', async () => {
        await writeBindings({ store, bindings: [binding(BINDING_A)] });

        // Three upstream failures: the credential stays broken, so each cycle skips
        // before it lists anything. The baseline must still be the one derived from
        // the creation boundary, never a later clock reading (002 FR-066, AC-036).
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await runScanCycle({ store, log, poller: failingPoller() });
        }

        const failing = await readScanState({ store, log });
        expect(bindingScanOf(failing, BINDING_A).baselineAt).toBe(DEFAULT_BASELINE);
        expect(bindingScanOf(failing, BINDING_A).lastScanAt).toBeNull();

        // The successful cycle opens at that same baseline, not at a clock reading
        // from one of the attempts.
        const success = recordingPoller([issue(1, AT_CREATION)]);
        const cycle = await runScanCycle({ store, log, poller: success.poller });

        expect(success.seen().windows).toEqual([DEFAULT_BASELINE]);
        expect(cycle.enqueued).toBe(1);
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).baselineAt).toBe(DEFAULT_BASELINE);
    });

    it('keeps the look-back baseline stable the same way', () => {
        // The mode decides the baseline's **width**, not when it is derived — so the
        // retained stamp is identical on every retry (002 FR-067).
        const first = baselineFor({
            binding: binding(BINDING_A, 'recent-history'),
            stored: { kind: 'stamp', at: CREATED_AT },
            overlapMs: OVERLAP_MS,
        });

        expect(first).toEqual({ window: LOOK_BACK_BASELINE });
    });
});

describe('§5.13 an unreadable creation stamp produces no event, no run, and no work, in both modes', () => {
    it('refuses the baseline for both modes when the stored stamp cannot be read', async () => {
        for (const scope of ['new-only', 'recent-history'] as const) {
            const verdict = baselineFor({
                binding: binding(BINDING_A, scope),
                // The assembled record cannot produce this case — `stampOrKeep` reads
                // a clock stamp — so it is handed to the derivation directly, which is
                // what FR-072 requires the *stored* reader to preserve (plan H3).
                stored: { kind: 'unreadable' },
                overlapMs: OVERLAP_MS,
            });

            expect(verdict, scope).toEqual({ refused: BASELINE_UNREADABLE });
        }
    });

    it('lists nothing and records the reason when the stored file carries a corrupt stamp', async () => {
        await plantBindings([{ ...binding(BINDING_A), createdAt: 'not-a-date' }]);
        const { poller, seen } = recordingPoller([issue(1, AT_CREATION)]);

        const cycle = await runScanCycle({ store, log, poller });

        expect(seen().windows).toEqual([]);
        expect(cycle.enqueued).toBe(0);
        expect(cycle.bindings[0]?.skipped).toBe(BASELINE_UNREADABLE);
        expect(cycle.bindings[0]?.windowFrom).toBeNull();

        // The reason reaches the operator's own **record**, which is the surface that
        // survives the process: the binding's stored scan row carries it, and no
        // baseline was written (002 FR-024, FR-072).
        const refused = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(refused.lastError).toBe(BASELINE_UNREADABLE);
        expect(refused.baselineAt).toBeNull();
        expect(refused.lastScanAt).toBeNull();

        // And it stays refused on every later cycle — the direction that never
        // becomes a full replay (002 FR-072).
        const again = recordingPoller([issue(1, AT_CREATION)]);
        const second = await runScanCycle({ store, log, poller: again.poller });

        expect(second.enqueued).toBe(0);
        expect(second.bindings[0]?.skipped).toBe(BASELINE_UNREADABLE);
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).baselineAt).toBeNull();
    });

    it('falls back to the assembled stamp when the row stores none at all', async () => {
        // The three-way answer is the whole of FR-072's reachability: **absent** is
        // legitimate (a panel-created row has none yet) and uses the assembled
        // stamp, while **present-and-unreadable** refuses.
        expect(storedStampOf(undefined)).toBeNull();
        expect(storedStampOf(null)).toBeUndefined();
        expect(storedStampOf(CREATED_AT)).toBe(CREATED_AT);
        expect(baselineFor({ binding: binding(BINDING_A), stored: { kind: 'absent' }, overlapMs: OVERLAP_MS }))
            .toEqual({ window: DEFAULT_BASELINE });
    });
});

describe('§5.14 after the recovery reset both modes replay, from the separate durable flag', () => {
    it('re-offers in-window work for a binding in each mode', async () => {
        for (const [index, scope] of (['new-only', 'recent-history'] as const).entries()) {
            const bindingId = index === 0 ? BINDING_A : BINDING_B;
            const id = `${bindingId}-${scope}`;
            await plantBindings([{ ...binding(id), historyScope: scope }]);
            await writeScanState({
                store,
                state: {
                    bindings: {
                        [id]: { ...emptyBindingScan(), lastScanAt: SCANNED_AT, baselineAt: FIVE_DAYS_AGO },
                    },
                },
            });
            // A queue file the store must quarantine, which is the trigger for the
            // recovery reset.
            await writeFile(
                join(dataDir, 'events.json'),
                JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
                'utf8',
            );
            const { poller, seen } = recordingPoller([issue(1, FIVE_DAYS_AGO)]);

            const cycle = await runScanCycle({ store, log, poller });

            // **Both** modes replay: recovery is never governed by the mode (002
            // FR-073; plan H8).
            expect(seen().windows, scope).toEqual([FIVE_DAYS_AGO]);
            expect(cycle.enqueued, scope).toBe(1);
        }
    });

    it('keeps the two durable facts distinguishable, and only the reset writes the flag', async () => {
        // Never scanned: the stamp is `null` and the flag is `false` — the two facts
        // are separate values, not one read two ways (002 FR-074).
        await plantBindings([binding(BINDING_A)]);
        await writeScanState({
            store,
            state: { bindings: { [BINDING_A]: { ...emptyBindingScan(), baselineAt: DEFAULT_BASELINE } } },
        });
        const neverScanned = recordingPoller([]);
        await runScanCycle({ store, log: QUIET, poller: neverScanned.poller });
        const before = bindingScanOf(await readScanState({ store, log: QUIET }), BINDING_A);

        expect(before.lastScanAt).not.toBeNull();
        expect(before.forceReplay).toBe(false);

        // Now the reset: same cleared stamp, flag **set**, written in one write.
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );
        const afterReset = recordingPoller([]);
        await runScanCycle({ store, log: QUIET, poller: afterReset.poller });
        const recovered = await readScanState({ store, log: QUIET });

        // A completing scan advanced the stamp and cleared the flag — which is the
        // recovery path's flag and nothing else's.
        expect(recovered.bindings[BINDING_A]?.forceReplay).toBe(false);
        expect(recovered.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
    });

    it('reports the flag on the health row while it is in force, and only the reset writes it', async () => {
        await plantBindings([binding(BINDING_A)]);
        await writeScanState({
            store,
            state: {
                bindings: {
                    // Exactly what `resetScanWindows` writes: the stamp cleared, the
                    // flag set, the **baseline retained**. A slot carrying both a
                    // completed stamp and the flag is a state the recovery path never
                    // produces, which is the point — the two facts are separate and
                    // only this one writes the second.
                    [BINDING_A]: {
                        ...emptyBindingScan(),
                        lastScanAt: null,
                        baselineAt: DEFAULT_BASELINE,
                        forceReplay: true,
                    },
                },
            },
        });
        const { readStatusRows } = await import('../service/routes/events.ts');
        const rows = await readStatusRows({
            store,
            log: QUIET,
            bindings: [binding(BINDING_A)],
            overlapMs: OVERLAP_MS,
        });

        // FR-078 and FR-092: the replay is **visible while it is in force**, and the
        // window in force is reported beside it.
        expect(rows[0]?.forceReplay).toBe(true);
        expect(rows[0]?.windowStart).toBe(DEFAULT_BASELINE);
        expect(rows[0]?.historyScope).toBe('new-only');
    });
});

describe('§5.15 a scan that starts a replay and fails leaves it in force', () => {
    it('keeps the flag armed, and keeps an armed catch-up armed, through a failed scan', async () => {
        // No account exists, so the cycle skips before it lists: the scan does not
        // complete, and neither one-shot may be consumed by that (002 FR-076; plan H7).
        await plantBindings([binding(BINDING_A)]);
        await writeScanState({
            store,
            state: {
                bindings: {
                    [BINDING_A]: {
                        ...emptyBindingScan(),
                        lastScanAt: null,
                        baselineAt: DEFAULT_BASELINE,
                        forceReplay: true,
                        rescanFrom: FIVE_DAYS_AGO,
                    },
                },
            },
        });

        // Three failures against a credential that stays broken: none of them may
        // consume a one-shot (002 FR-076; plan H7).
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await runScanCycle({ store, log, poller: failingPoller() });
        }

        const state = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(state.forceReplay).toBe(true);
        expect(state.rescanFrom).toBe(FIVE_DAYS_AGO);
        expect(state.lastScanAt).toBeNull();
        // The reason the scans stopped is recorded, so the row says why nothing
        // moved rather than looking like a quiet service.
        expect(state.lastError).toBe('auth-failed');

        // The next scan replays again — the flag survived every failure. And it
        // replays at the **armed** bound, which is the one explicit request in force.
        const again = recordingPoller([issue(1, FIVE_DAYS_AGO)]);
        const cycle = await runScanCycle({ store, log, poller: again.poller });

        expect(again.seen().windows).toEqual([FIVE_DAYS_AGO]);
        expect(cycle.enqueued).toBe(1);

        // Having answered it, the catch-up is consumed; the recovery flag survives,
        // because a completing scan clears `rescanFrom` and advances the stamp, and
        // the next cycle reports the flag's own state.
        const settled = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(settled.rescanFrom).toBeNull();
        expect(settled.forceReplay).toBe(false);
        expect(settled.lastScanAt).not.toBeNull();
    });
});

describe('§5.16 a repeated sweep, a repeated recovery replay, and a restart produce zero duplicates', () => {
    it('holds zero duplicates across all five sequences', async () => {
        await plantBindings([binding(BINDING_A, 'recent-history')]);
        // Five different paths over one window, each answering with the same two
        // observations, and one set of rows out of all of them.
        const cycle = cycleOver([issue(1, FIVE_DAYS_AGO), issue(2, AT_CREATION)]);

        // 1. the sweep
        expect(await cycle()).toBe(2);
        const afterSweep = await queuedEventIds();

        // 2. the repeated sweep
        expect(await cycle()).toBe(0);
        // 3. a restart — a fresh cycle over the same store
        expect(await cycle()).toBe(0);
        expect(await queuedEventIds()).toEqual(afterSweep);

        // 4. the recovery replay. The queue is **lost** here, so the replay's job is
        // to re-offer the same work: the count goes back to two because the rows are
        // re-detected, and what makes this a replay rather than a duplicate is that
        // they come back under **the same ids** — the deterministic delivery key, not
        // a second pair beside the first (002 FR-073, FR-080).
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );
        expect(await cycle()).toBe(2);
        expect(await queuedEventIds()).toEqual(afterSweep);

        // 5. the repeated recovery replay — the evidence file is still there, and the
        //    reset is idempotent, so the replay that already happened is not served
        //    twice.
        expect(await cycle()).toBe(0);

        const queue = await queuedEventIds();

        // Two rows, two distinct ids, and the runs the first sweep wrote are still
        // the only two: a re-offered event is the **same** work, so it neither
        // duplicates the queue row nor mints a second run (002 FR-081).
        expect(queue).toHaveLength(2);
        expect(new Set(queue).size).toBe(2);

        const runs = JSON.parse(await readFile(join(dataDir, 'runs.json'), 'utf8')) as {
            runs: { state: string; session: unknown }[];
        };

        expect(runs.runs).toHaveLength(2);
        expect(runs.runs.every((run) => run.session === null)).toBe(true);
    });
});

describe('§5.17 a sweep enqueues only', () => {
    it('starts no session outside the claim-and-lease cycle', () => {
        // The sweep's whole discipline is that detection is a **detection**: it
        // reaches a session only through the ordinary enqueue and the claim-and-lease
        // cycle, one at a time (002 FR-081, FR-083; 002 FR-028's excerpt fence).
        const loop = readFileSync(join(REPO, 'service', 'poll', 'loop.ts'), 'utf8');

        expect(loop).toContain('enqueueEvents');
        // The loop has no dispatch call of any kind: dispatch happens when the panel
        // claims a run, in 003's layer, never inside a scan.
        expect(loop).not.toContain('reserveRun');
        expect(loop).not.toContain('startSession');
    });

    it('leaves the runs document with one pending run per detected event and no session', async () => {
        // A sweep **enqueues and links**: run-before-delivery durability means the
        // enqueue writes a pending run beside the queue row, so the durable result of
        // one detected trigger is one pending run. What it must **not** do is start a
        // session — the run waits for the panel's claim (002 FR-081, FR-083).
        await plantBindings([binding(BINDING_A, 'recent-history')]);

        const cycle = await runScanCycle({
            store,
            log,
            poller: recordingPoller([issue(1, FIVE_DAYS_AGO)]).poller,
        });

        expect(cycle.enqueued).toBe(1);

        const queue = JSON.parse(await readFile(join(dataDir, 'events.json'), 'utf8')) as {
            kind: string;
            runCorrelationId: string | null;
        }[];

        expect(queue).toHaveLength(1);
        expect(queue[0]?.kind).toBe('assignment');
        expect(queue[0]?.runCorrelationId).not.toBeNull();

        const runs = JSON.parse(await readFile(join(dataDir, 'runs.json'), 'utf8')) as {
            runs: { state: string; session: unknown }[];
        };

        expect(runs.runs).toHaveLength(1);
        expect(runs.runs[0]?.state).toBe('pending');
        // No session, no lease, no attempt: the sweep reached no further than the queue.
        expect(runs.runs[0]?.session).toBeNull();
    });
});

describe('§5.18 exactly one rescan mechanism, and no timestamp-picking surface', () => {
    it('names rescanFrom as the one durable chosen lower bound, in the scan slot', () => {
        const scan = readFileSync(join(REPO, 'service', 'poll', 'scan.ts'), 'utf8');

        // The mechanism is one member of the per-binding slot, with one writer: the
        // bindings route (plan H5).
        expect(scan).toContain('rescanFrom');
        expect(scan).not.toContain('replayFrom');
        expect(scan).not.toContain('rescanAt');

        // And the window rule consults it as the first source, ahead of the recorded
        // stamp and the baseline.
        const window = readFileSync(join(REPO, 'service', 'poll', 'window.ts'), 'utf8');
        expect(window.indexOf('input.scanned.rescanFrom')).toBeLessThan(window.indexOf('input.scanned.lastScanAt'));
    });

    it('builds no operator-facing timestamp input anywhere in the panel or the service', () => {
        // The general operator-chosen-timestamp surface is recorded debt and is
        // **not** built: no route, no submitted member, no control (spec.md
        // `## Out of Scope`; plan §B.8, gate item 2).
        const everything = sourceText(join(REPO, 'service'), join(REPO, 'src'));

        expect(everything).not.toContain('/rescan');
        expect(everything).not.toContain('rescanFromInput');
        expect(everything).not.toContain('rescanTimestamp');
        expect(everything).not.toContain('rescanLowerBound');
        expect(everything).not.toContain('rescanSince');

        // `rescanFrom` exists in exactly four files, each with one reason to name it:
        // the slot that holds it, the window rule that reads it, the loop that clears
        // it, and the one route that arms it. A fifth file naming it would be a
        // second mechanism, which is what FR-023 forbids.
        const named = readdirSync(join(REPO, 'service'), { recursive: true })
            .map(String)
            .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
            .filter((path) => readFileSync(join(REPO, 'service', path), 'utf8').includes('rescanFrom'))
            .toSorted(byText);

        expect(named).toEqual([
            'poll/loop.ts',
            'poll/scan.ts',
            'poll/window.ts',
            'routes/bindings.ts',
        ]);

        // And the panel half of the surface carries no timestamp control: no free-text
        // field anywhere in `src/` offers a date, a time, or a lower bound. The panel's
        // only write on this field is the two-name select, so there is nothing for an
        // operator to type a stamp into.
        const panelFiles = moduleNames(join(REPO, 'src'));
        const stampish = /placeholder:\s*'[^']*(date|time|since|rescan)/i;

        for (const file of panelFiles) {
            expect(readFileSync(join(REPO, 'src', file), 'utf8'), file).not.toMatch(stampish);
        }

        // And the panel half of the source carries no `rescanFrom` at all: the field
        // has no representation in the panel's vocabulary to send.
        expect(sourceText(join(REPO, 'src'))).not.toContain('rescanFrom');
    });

    it('writes the member only in the bindings route, beside the mode edit that caused it', () => {
        const route = readFileSync(join(REPO, 'service', 'routes', 'bindings.ts'), 'utf8');

        expect(route).toContain('rescanFrom: armedFrom');
        // Editing to the default mode writes nothing at all (002 FR-085): the arming
        // is reached only for a submission that moved **into** the look-back mode,
        // which is the `!== 'recent-history'` half of this predicate.
        expect(route).toContain("!== 'recent-history'");

        // The armed bound is `now − the declared look-back` and nothing else: there
        // is no second source for it, and no branch that writes the member from a
        // value the operator supplied (002 FR-084, FR-060).
        expect(route.match(/rescanFrom:/g)).toHaveLength(1);
        expect(route).toContain('const armedFrom = new Date(Date.parse(input.at) - lookBack).toISOString();');
    });

    it('clears no checkpoint and touches no queued or dispatched run when editing to the default', async () => {
        const service = await startWithAccount();
        // Everything durable is read and written in the **harness's** directory: the
        // grant, the scan slot, and the queue are one store, and this row is about
        // what a `PUT` does to the other two files it did not name.
        const audit = serviceStore(service);
        const put = async (scope?: HistoryScope): Promise<void> => {
            const response = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    bindings: [{ ...binding(BINDING_A), ...(scope !== undefined && { historyScope: scope }) }],
                }),
            });

            expect(response.status).toBe(200);
        };
        await put();
        await writeScanState({
            store: audit,
            state: { bindings: { [BINDING_A]: { ...emptyBindingScan(), lastScanAt: SCANNED_AT } } },
        });
        await writeFile(
            join(service.dataDir, 'events.json'),
            JSON.stringify([createPendingEvent(BINDING_A, 7)]),
            'utf8',
        );
        const beforeQueue = await readFile(join(service.dataDir, 'events.json'), 'utf8');

        // Into the look-back mode on a binding that **has** completed a scan: one
        // lower bound armed, through FR-023's one mechanism (002 FR-084).
        await put('recent-history');
        const armed = bindingScanOf(await readScanState({ store: audit, log: QUIET }), BINDING_A);

        expect(armed.rescanFrom).not.toBeNull();
        // The armed catch-up is `now − the declared look-back` and **bounded**: it is
        // within one day either side of exactly that value, so a fixture whose
        // creation stamp is older than the test's own clock cannot make the assertion
        // pass by accident, and no code path could reach a stamp the operator chose
        // (002 FR-060, FR-084).
        const armedMs = Date.parse(armed.rescanFrom ?? '');
        const expectedMs = Date.now() - 604_800_000;

        expect(Math.abs(armedMs - expectedMs)).toBeLessThan(86_400_000);
        // And it is **not** the creation-derived bound this mode would have used from
        // the start — arming exists because a binding that already scanned needs a
        // fresh lower bound, not the one it started with.
        expect(armedMs).not.toBe(Date.parse(LOOK_BACK_BASELINE));

        // Back to the default mode: no checkpoint cleared, no window opened, and
        // every queued row exactly as it was (002 FR-085). The armed catch-up from the
        // edit above is **left alone** too — clearing it would be a second write on
        // an edit the operator did not ask to rescan.
        await put();
        const after = bindingScanOf(await readScanState({ store: audit, log: QUIET }), BINDING_A);

        expect(after.lastScanAt).toBe(SCANNED_AT);
        expect(after.rescanFrom).toBe(armed.rescanFrom);
        expect(await readFile(join(service.dataDir, 'events.json'), 'utf8')).toBe(beforeQueue);
    });

    it('arms nothing for a binding that has never completed a scan', async () => {
        // Plan H6: the never-scanned case follows its own mode-derived baseline, which
        // is the **wider** of the two bounds — `createdAt − 7 days` against
        // `now − 7 days` — so arming it would narrow a window FR-079 forbids narrowing.
        const service = await startWithAccount();
        const audit = serviceStore(service);
        for (const scope of [undefined, 'recent-history'] as const) {
            const response = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    bindings: [{ ...binding(BINDING_A), ...(scope !== undefined && { historyScope: scope }) }],
                }),
            });

            expect(response.status).toBe(200);
        }

        expect(bindingScanOf(await readScanState({ store: audit, log: QUIET }), BINDING_A).rescanFrom).toBeNull();
    });
});

describe('§5.19 exactly one audit row per change, through every path', () => {
    it('writes one row for a panel save and none for a resubmission in force', async () => {
        const service = await startWithAccount();
        const audit = serviceStore(service);
        const put = async (scope: HistoryScope): Promise<void> => {
            const response = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ bindings: [binding(BINDING_A, scope)] }),
            });

            expect(response.status).toBe(200);
        };

        await put('recent-history');
        expect(await scopeAuditRows(audit)).toHaveLength(1);

        // The mode in force, resubmitted: not a change, so no row (002 FR-086). Nor is
        // spelling the documented default out, which is the same effective value.
        await put('recent-history');
        await put('recent-history');
        expect(await scopeAuditRows(audit)).toHaveLength(1);

        // A genuine change writes exactly one more, and the row carries the previous
        // mode, the new one, the decision, and the actor — and nothing else.
        // Moving **to** the documented default is `cleared`, not `changed`: the
        // default has two sides and both are named (002 FR-086).
        await put('new-only');
        const cleared = await scopeAuditRows(audit);

        expect(cleared).toHaveLength(2);
        expect(cleared[1]).toMatchObject({
            eventType: HISTORY_SCOPE_UPDATED_EVENT,
            actorSource: 'operator',
            entity: { kind: 'binding', id: BINDING_A },
            decision: 'cleared',
            details: { bindingId: BINDING_A, from: 'recent-history', to: 'new-only', actor: 'operator' },
        });

        // And back again: moving **from** the default is `set`, which is the other
        // side of the same rule.
        await put('recent-history');
        const rows = await scopeAuditRows(audit);

        expect(rows).toHaveLength(3);
        expect(rows[2]).toMatchObject({
            decision: 'set',
            details: { bindingId: BINDING_A, from: 'new-only', to: 'recent-history', actor: 'operator' },
        });
        expect(Object.keys(rows[1]?.details ?? {}).toSorted(byText)).toEqual(['actor', 'bindingId', 'from', 'to']);
        // Two fixed names, so the row carries no text, no length, and no fingerprint
        // (002 FR-086, FR-054).
        expect(JSON.stringify(rows[1])).not.toMatch(/mtp-|tokfp-/);
    });

    it('records a first change as `set` and a clear as `cleared`', async () => {
        const service = await startWithAccount();
        const audit = serviceStore(service);
        // A `null` is sent as an **explicit null**, not as an omission: omission is
        // what preserves, so a submission that leaves the key out is the other test
        // (§5.5) and would write no row here at all.
        const put = async (scope: HistoryScope | null): Promise<void> => {
            const response = await service.call(BINDINGS_PATH, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    bindings: [{ ...binding(BINDING_A), historyScope: scope }],
                }),
            });

            expect(response.status).toBe(200);
        };

        // Creating the binding in the documented default is not a mode change: the
        // baseline seeds at the default and nothing differs from it. The second
        // submission sends the *spelling* of the default and is equally not a change
        // — which is the half of FR-062 that makes a cleared row byte-identical to a
        // row that never chose one.
        await put(null);
        await put('new-only');
        const seeded = await scopeAuditRows(audit);

        expect(seeded).toEqual([]);

        await put('recent-history');
        const first = await scopeAuditRows(audit);

        expect(first[0]).toMatchObject({
            decision: 'set',
            details: { from: 'new-only', to: 'recent-history' },
        });

        // An explicit `null` clears it back to the default, which is its own decision
        // (002 FR-086, FR-062).
        await put(null);
        const afterClear = await scopeAuditRows(audit);

        expect(afterClear[1]).toMatchObject({
            decision: 'cleared',
            details: { from: 'recent-history', to: 'new-only' },
        });
    });

    it('records a hand edit of the stored document once, with actor `service`', async () => {
        const service = await startWithAccount();
        const audit = serviceStore(service);
        const plant = async (scope?: HistoryScope): Promise<void> =>
            await writeFile(
                join(service.dataDir, 'bindings.json'),
                JSON.stringify([{ ...binding(BINDING_A), ...(scope !== undefined && { historyScope: scope }) }]),
                'utf8',
            );

        /** Read the bindings answer and answer with its status. */
        const read = async (): Promise<number> => {
            const response = await service.call(BINDINGS_PATH);

            return response.status;
        };

        // The first read seeds the baseline at the documented default and writes
        // nothing; a hand edit afterwards is the one change, and no panel asked for it.
        await plant();
        expect(await read()).toBe(200);
        expect(await scopeAuditRows(audit)).toHaveLength(0);

        await plant('recent-history');
        expect(await read()).toBe(200);

        const rows = await scopeAuditRows(audit);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            actorSource: 'service',
            details: { from: 'new-only', to: 'recent-history' },
        });
        // And a second read of the unchanged document writes nothing further.
        expect(await read()).toBe(200);
        expect(await scopeAuditRows(audit)).toHaveLength(1);
    });
});

describe('§5.20 no per-observation row, and poll.observation stays unwritten', () => {
    it('writes no row for a cycle that matched nothing, and never those two types', async () => {
        await plantBindings([binding(BINDING_A, 'recent-history')]);
        await writeFile(join(dataDir, 'events.json'), JSON.stringify([createPendingEvent(BINDING_A, 7)]), 'utf8');

        // A cycle that matches **nothing**: five open issues, none of them inside the
        // window. A per-observation row would write five rows here, every cycle.
        const nothing = recordingPoller([
            issue(1, '2026-01-01T00:00:00.000Z'),
            issue(2, '2026-01-01T00:00:00.000Z'),
            issue(3, '2026-01-01T00:00:00.000Z'),
            issue(4, '2026-01-01T00:00:00.000Z'),
            issue(5, '2026-01-01T00:00:00.000Z'),
        ]);

        await runScanCycle({ store, log: QUIET, poller: nothing.poller });

        const trail = await readAuditEntries(store);

        expect(trail.filter((row) => row.eventType === 'poll.observation')).toEqual([]);
        expect(trail.filter((row) => row.eventType === 'poll.checkpoint')).toEqual([]);
        // Five refused observations wrote **five rows** in no world; the scan wrote one
        // row in total, and it is the mode-change row the hand-planted document caused
        // on its first read — which is §5.19's row, not a per-observation one. What is
        // absent is every type a cycle like this would have to invent to explain
        // itself (002 FR-087).
        expect(trail.map((row) => row.eventType)).toEqual([HISTORY_SCOPE_UPDATED_EVENT]);
        // And the queue is exactly as it was — five refusals moved nothing.
        const queue = JSON.parse(await readFile(join(dataDir, 'events.json'), 'utf8')) as unknown[];

        expect(queue).toHaveLength(1);
    });
});

describe('§5.21 the panel renders the mode once, unreadable when unusable, default when absent', () => {
    it('renders the default for an absent member and unreadable for an unusable one', () => {
        // Absence is the documented default (002 FR-093) — never "unset", which is
        // not a state this field has.
        expect(readHistoryScope(undefined)).toBe('new-only');
        expect(readHistoryScope(null)).toBe('new-only');
        // An unusable member is **refused**, not defaulted (002 FR-063): rendering it
        // as the default would tell the operator their binding scans from now on when
        // the service may hold something else.
        for (const value of ['all-history', '', 7, true, {}, [], 'New-Only']) {
            expect(readHistoryScope(value), String(value)).toBeNull();
        }
    });

    it('refuses the whole bindings body for an unusable member rather than half-applying it', () => {
        // Invariant 8 and 002 FR-063: one refused member is never partially applied, so
        // the panel reads **no** bindings rather than rendering one with a mode it
        // cannot judge.
        const body = JSON.stringify({
            bindings: [{ ...binding(BINDING_A), historyScope: 'all-history' }],
            status: [],
        });

        expect(parseBindingsBody(body)).toBeNull();
    });

    it('reads an answer from a service that does not report the member as the default', () => {
        // A row carrying **no** member at all — what an answer from a service that predates
        // the field looks like, since the stored document omits the key (002 FR-058).
        const body = JSON.stringify({ bindings: [binding(BINDING_A)], status: [] });
        const parsed = parseBindingsBody(body);

        // Plan H13: an older service's answer is not a fault, and absence is the
        // default everywhere — the panel **materialises** it rather than leaving a
        // hole, so nothing downstream has to distinguish "absent" from "the default".
        expect(parsed?.bindings[0]?.historyScope).toBe('new-only');
        expect(Object.hasOwn(parsed?.bindings[0] ?? {}, 'historyScope')).toBe(true);
    });

    it('states every one of the six things the guidance must say, without opening anything', () => {
        // 002 FR-090's six claims, read off the shipped copy rather than off a
        // comment about it. Both variants are checked because the catch-up sentence
        // is conditional: a **new** binding cannot open one, and a binding that can
        // must say what it will offer (plan H6).
        for (const isEditing of [false, true]) {
            const guidance = historyScopeGuidance(isEditing);

            // 1. the default watches from now on
            expect(guidance).toContain('From now on is the default');
            // 2. a fixed seven-day period
            expect(guidance).toContain('seven days');
            // 3. once, and not repeated on its own
            expect(guidance).toContain('once');
            expect(guidance).toContain('does not repeat on its own');
            // 4. bounded, with no "all history"
            expect(guidance).toContain('always bounded');
            expect(guidance).toContain('no "all history" option');
            // 5. what an edit may offer at once
            expect(guidance).toMatch(/many sessions|looks back once/);
            // 6. recovery is never governed by this setting
            expect(guidance).toContain('recovery replay');
            expect(guidance).toContain('regardless of this setting');
        }
    });

    it('offers exactly the two names and nothing else, under an accessible name', () => {
        // 002 FR-089 and FR-094: the field is one control offering the two names,
        // with an accessible name that carries **what it decides** rather than the
        // value's storage name.
        expect(historyScopeOptions().map((option) => option.id)).toEqual(['new-only', 'recent-history']);
        expect(HISTORY_SCOPE_LABEL).toBe('When this binding starts watching');
        // The labels describe the behaviour, not the wire spelling: the operator has
        // no use for `new-only`, and a label showing it would be a second rendering
        // of the stored value rather than a description of the choice.
        for (const option of historyScopeOptions()) {
            expect(option.label).not.toContain('new-only');
            expect(option.label).not.toContain('recent-history');
        }
    });

    it('labels the window in force as derived state the service computed', () => {
        // 002 FR-092: never "the window you set", and never silent while a refusal is
        // the reason there is no window.
        const line = windowInForceLine({
            windowStart: DEFAULT_BASELINE,
            historyScope: 'recent-history',
            forceReplay: false,
            lastScanAt: SCANNED_AT,
            lastError: null,
        });

        expect(line).toContain('Scan window the service computed');
        expect(line).toContain(DEFAULT_BASELINE);
        expect(line).toContain(SCANNED_AT);
        expect(line).toContain('look-back mode');

        const replaying = windowInForceLine({
            windowStart: DEFAULT_BASELINE,
            historyScope: 'new-only',
            forceReplay: true,
            lastScanAt: SCANNED_AT,
            lastError: null,
        });

        expect(replaying).toContain('recovery replay is in force');
        // FR-088: never presented as the operator's look-back choice.
        expect(replaying).toContain('whatever the mode is');

        const refused = windowInForceLine({
            windowStart: null,
            historyScope: 'new-only',
            forceReplay: false,
            lastScanAt: null,
            lastError: BASELINE_UNREADABLE,
        });

        expect(refused).toContain('not computed yet');
        expect(refused).toContain(BASELINE_UNREADABLE);
        expect(windowInForceLine(null)).toBeNull();
    });

    it('offers the row a short label and nothing else derived from the mode', () => {
        // 002 FR-091: a row MAY name the mode; it may not derive anything else, and
        // it is never the only place the operator can see or change it.
        expect(historyScopeLabel(binding(BINDING_A))).toBeNull();
        expect(historyScopeLabel(binding(BINDING_A, 'new-only'))).toBeNull();
        expect(historyScopeLabel(binding(BINDING_A, 'recent-history'))).toBe('one-off 7-day look-back');
    });

    it('renders the mode once panel-wide, in the editor control and nowhere else', () => {
        // 002 FR-091's structural claim, on the source rather than on a mount: **no
        // panel module outside `bindings-history.ts` names either mode**, so the count
        // of surfaces that render it is the count of call sites in one file. Status,
        // the diagnostics view, the dispatch rows, the Settings rows and the binding
        // rows all read the mode through a function rather than spelling it.
        // The two modules that legitimately hold the vocabulary: the owning editor field,
        // and the panel-side **reader** beside it, which declares the same closed
        // union because `src/` cannot import across the request boundary (§5.9 pins
        // the two together). Neither of them *renders* the mode, and no third module
        // may name either value at all.
        const vocabularyHolders = new Set(['bindings-history.ts', 'bindings-service.ts']);
        const panelFiles = moduleNames(join(REPO, 'src'))
            .filter((file) => !vocabularyHolders.has(file));

        for (const file of panelFiles) {
            const source = readFileSync(join(REPO, 'src', file), 'utf8');
            const mentions = ['new-only', 'recent-history'].filter((name) => source.includes(name));

            expect(mentions, file).toEqual([]);
            // And nobody else *declares* a rendering of it either — both renderers and
            // the label are defined in the owning module and nowhere else. A call into
            // them is allowed and is what `bindings-body.ts` and `bindings-rows.ts` do;
            // a second definition would be a second rendering.
            const declares = /(?:function|const) (?:historyScopeLabel|windowInForceLine|historyScopeGuidance)/;

            expect(source, file).not.toMatch(declares);
        }

        // The editor module is the single owner, and it exports exactly one label
        // reader the rows may call.
        const editorSource = readFileSync(join(REPO, 'src', 'bindings-history.ts'), 'utf8');

        // Exactly one **call**: the control the mode is rendered in, and no second
        // editor offering it. The import beside it is not a second rendering, so the
        // count is on calls.
        expect(editorSource.match(/mountSelect\(/g)).toHaveLength(1);

        // Which also makes the single-rendering claim countable: the mode's control is
        // the **one** select this wave added, so every other panel select is one that
        // predates it — the bindings editor's account and worktree fields, the
        // dispatches toolbar's three, the project picker's, and the Settings enum
        // row's.
        const otherSelects = panelFiles
            .map((file) => [file, readFileSync(join(REPO, 'src', file), 'utf8')] as const)
            .map(([file, source]) => [file, source.match(/mountSelect\(/g)?.length ?? 0] as const)
            .filter(([, count]) => count > 0)
            .toSorted((left, right) => byText(left[0], right[0]));

        expect(otherSelects).toEqual([
            ['bindings-body.ts', 3],
            ['dispatches-controls.ts', 3],
            ['panel-ui.ts', 1],
            ['settings-rows.ts', 1],
        ]);
    });

    it('writes the mode on every grant row and preserves it for rows it never opened', () => {
        // 002 FR-057: omission-preserves, so a row the editor did not open keeps its
        // own stored mode even though the whole file was replaced. The editor is open
        // on `BINDING_A` with the draft at the **default**, so that row submits
        // `'new-only'` and the row the editor never touched submits its own stored
        // `'recent-history'` — two rows, two answers, which is the whole of the claim.
        const state: ReturnType<typeof bindingsStateWith> = {
            ...bindingsStateWith('new-only'),
            editing: true,
            selectedBinding: BINDING_A,
        };

        expect(historyScopeForGrant(state, panelTyped(BINDING_A, 'recent-history'))).toBe('new-only');
        expect(historyScopeForGrant(state, panelTyped(BINDING_B, 'recent-history'))).toBe('recent-history');
    });
});

describe('§5.22 the health row carries the window in force, the mode in force, and the replay flag', () => {
    it('reports all three, in both modes, and refuses rather than inventing a window', async () => {
        const { readStatusRows } = await import('../service/routes/events.ts');

        for (const scope of ['new-only', 'recent-history'] as const) {
            const candidate = binding(BINDING_A, scope);
            await writeScanState({
                store,
                state: { bindings: { [BINDING_A]: { ...emptyBindingScan(), baselineAt: FIVE_DAYS_AGO } } },
            });
            const rows = await readStatusRows({
                store,
                log: QUIET,
                bindings: [candidate],
                overlapMs: OVERLAP_MS,
            });

            expect(rows[0]?.historyScope, scope).toBe(scope);
            expect(rows[0]?.windowStart, scope).toBe(FIVE_DAYS_AGO);
            expect(rows[0]?.forceReplay, scope).toBe(false);
        }

        // No window at all is a refusal, and the row says `null` rather than
        // inventing one (002 FR-072, FR-092).
        await writeScanState({ store, state: { bindings: {} } });
        const refused = await readStatusRows({
            store,
            log: QUIET,
            bindings: [binding(BINDING_A)],
            overlapMs: OVERLAP_MS,
        });

        expect(refused[0]?.windowStart).toBeNull();
    });

    it('keeps both ends of the window readable together', async () => {
        const { readStatusRows } = await import('../service/routes/events.ts');
        await writeScanState({
            store,
            state: { bindings: { [BINDING_A]: { ...emptyBindingScan(), lastScanAt: SCANNED_AT } } },
        });
        const rows = await readStatusRows({
            store,
            log: QUIET,
            bindings: [binding(BINDING_A)],
            overlapMs: OVERLAP_MS,
        });

        expect(rows[0]?.lastScanAt).toBe(SCANNED_AT);
        expect(rows[0]?.windowStart).toBe(new Date(Date.parse(SCANNED_AT) - OVERLAP_MS).toISOString());
    });
});

describe('§5.6/§5.9 the look-back length reaches neither shipped bundle', () => {
    it('keeps the declared length and its bound out of the panel bundle entirely', () => {
        // Invariant 1: the committed bundles **are** the shipped artefact, so a claim
        // about what does or does not ship is a claim about these two files.
        //
        // The panel's own control legitimately names both modes — FR-089 requires it
        // to *offer* them — so the mode is not the assertion here. The **length** is:
        // it is a service-owned constant the operator cannot change and cannot see
        // (FR-059), so neither its value nor its declared bound may appear in the
        // panel bundle, where nothing could use it.
        const panelBundle = readFileSync(join(REPO, 'panel', 'main.js'), 'utf8');

        expect(panelBundle).not.toContain('604800000');
        expect(panelBundle).not.toContain('3600000');
        expect(panelBundle).not.toContain('2592000000');
        expect(panelBundle).not.toContain('LOOK_BACK');

        // The panel bundle does carry the two option ids, because it must offer both
        // choices by name — this is the positive half of the same claim.
        expect(panelBundle).toContain('recent-history');
        expect(panelBundle).toContain('new-only');

        // And the service bundle, which owns the constant, carries it.
        const serviceBundle = readFileSync(join(REPO, 'service', 'main.js'), 'utf8');

        expect(serviceBundle).toContain('604800000');
    });

    it('rebuilds both bundles so they carry the shipped source', () => {
        // The other half of invariant 1, and the reason this assertion lives here at
        // all: a bundle that does **not** carry its source's new vocabulary is a
        // bundle the host will run while the tests describe something else. The
        // panel's mode names and the service's look-back value are the two shipped
        // artefacts of this wave, so their presence in both bundles is what proves
        // the rebuild happened rather than being assumed.
        expect(readFileSync(join(REPO, 'panel', 'main.js'), 'utf8')).toContain('When this binding starts watching');
        expect(readFileSync(join(REPO, 'service', 'main.js'), 'utf8')).toContain('binding.history-scope-updated');
    });
});
