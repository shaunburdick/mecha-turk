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

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GuestRequestResult } from '@openchamber/sdk';

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
    historyScopeLabel,
    historyScopeOptions,
    windowInForceLine,
} from '../src/bindings-history.ts';
import { saveEditedBinding, startEditingBinding, startNewBinding } from '../src/bindings-edit.ts';
import { bindRepository } from '../src/bindings.ts';
import { refresh } from '../src/panel-ui.ts';
import { stopRelayPolling } from '../src/relay.ts';
import type { BindingsPane } from '../src/bindings-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { PanelHost } from '../src/session.ts';
import { HISTORY_SCOPE_UPDATED_EVENT } from '../service/history-scope-audit.ts';
import { NUMERIC_BOUNDS } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import { readEvents } from '../service/poll/events.ts';
import {
    bindingScanOf,
    emptyBindingScan,
    readScanState,
    writeScanState,
} from '../service/poll/scan.ts';
import { answersCatchUp, BASELINE_UNREADABLE, baselineFor, windowFor } from '../service/poll/window.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { ROUTES } from '../service/routes/index.ts';
import {
    DEFAULT_HISTORY_SCOPE as PANEL_DEFAULT_HISTORY_SCOPE,
    parseBindingsBody,
    readHistoryScope,
} from '../src/bindings-service.ts';
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
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';
import {
    stubBindingsPane,
    stubLastProps,
    stubPanelUi,
    stubProjectPickerUi,
} from './support/ui-stubs.ts';
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

/** Panel runtimes a case built, drained of their relay in teardown. */
const armedRuntimes: PanelRuntime[] = [];

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
    // A granted list arms the relay, which is an interval; without this a panel
    // case would leave one running past the test.
    for (const rt of armedRuntimes) {
        stopRelayPolling(rt);
    }
    armedRuntimes.length = 0;

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
 * A bindings service that echoes back exactly what it was sent, recording the
 * bodies.
 *
 * Enough for the panel's own reader to succeed, and **no** other routing: a panel
 * claim here is about the bytes that left, and echoing is what lets the panel's
 * own `parseBindingsBody` run over them.
 *
 * @param bodies - Filled with each whole-file grant's raw request body.
 * @returns The `serviceRequest` the host double hands the panel.
 */
function recordingEchoService(bodies: string[]): PanelHost['serviceRequest'] {
    return async (request): Promise<GuestRequestResult> => {
        if (request.method !== 'PUT') {
            return { status: 404, body: '{}' };
        }

        bodies.push(request.body ?? '{}');
        const sent = JSON.parse(request.body ?? '{}') as { readonly bindings?: readonly unknown[] };

        return { status: 200, body: JSON.stringify({ bindings: sent.bindings ?? [], status: [] }) };
    };
}

/**
 * The `(bindingId, mode)` pairs one whole-file grant actually put on the wire.
 *
 * Read out of the **raw request bodies** the host recorded, so "the member rode
 * the wrong row" is a fact about bytes rather than about what the panel believes
 * it sent.
 *
 * @param bodies - The recorded grant bodies.
 * @param index - Which grant to read; the first by default.
 * @returns One pair per submitted row, in submission order.
 */
function grantedModes(bodies: readonly string[], index = 0): readonly (readonly [string, unknown])[] {
    const submitted = bodies[index] ?? '{}';
    const rows = (JSON.parse(submitted) as {
        readonly bindings?: readonly { bindingId?: unknown; historyScope?: unknown }[];
    }).bindings ?? [];

    return rows.map((row) => [String(row.bindingId), row.historyScope] as const);
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
 * A panel row with its own repository, so two rows can coexist.
 *
 * The editor refuses a save whose repository is already bound to **another** row
 * (005 FR-038), so a two-row grant fixture needs two repositories — a constraint
 * worth honouring rather than working around, since it is the same refusal an
 * operator would meet.
 *
 * @param bindingId - The row's id.
 * @param scope - The mode the row carries on the wire.
 * @param repository - The `owner/name` this row watches.
 * @returns The row as the panel's reader holds it.
 */
function panelRow(bindingId: string, scope: HistoryScope, repository: string): PanelBinding {
    return { ...panelTyped(bindingId, scope), repository };
}

/**
 * A runtime with the Bindings pane registered, in one editor mode.
 *
 * The **real** repaint is what these cases assert, so the runtime is built by the
 * production entry points — `startEditingBinding` / `startNewBinding` set the mode
 * and `refresh` is what the panel itself calls — and the pane is the recording
 * stub from `tests/support/ui-stubs.ts`. A stub is right here precisely because
 * the claim is "the repaint reached this element and said this": the stub records
 * both, and a real mount would only add the SDK's own rendering to the same path.
 *
 * @param input - The mode the editor opens in, and the rows it opens over.
 * @returns The runtime and the mounted pane, which the caller disposes.
 */
function mountedBindingsPane(input: {
    /** Whether the editor opens on an existing row (`true`) or the add form. */
    readonly editing: boolean;
    /** Rows the tab holds; defaults to one row in the default mode. */
    readonly rows?: readonly PanelBinding[];
}): { readonly rt: PanelRuntime; readonly pane: BindingsPane; readonly bodies: string[] } {
    const rows = input.rows ?? [panelTyped(BINDING_A)];
    const bodies: string[] = [];
    const rt = createTestRuntime(fakeHost({ serviceRequest: recordingEchoService(bodies) }));

    rt.state.bindings.status = 'ready';
    rt.state.bindings.bindings = [...rows];
    rt.state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: ACCOUNT_LOGIN, displayName: null, usable: true, scope: 'ok' },
    ];
    rt.state.bindings.editorOpen = true;
    rt.ui = stubPanelUi();
    rt.pickerUi = stubProjectPickerUi();
    // The pane is registered **before** the entry point runs, because that entry
    // point's own `refresh` is the first paint this case asserts on.
    const pane = stubBindingsPane(fakeDom().root);

    rt.bindingsUi = pane;
    rt.state.bindings.selectedBinding = input.editing && rows.length > 0 ? (rows[0]?.bindingId ?? null) : null;
    armedRuntimes.push(rt);

    if (input.editing) {
        startEditingBinding(rt);
    } else {
        startNewBinding(rt);
    }

    return { rt, pane, bodies };
}

/**
 * The guidance a mounted editor currently renders beneath its history-scope
 * control.
 *
 * Read back out of the **pane handle** rather than from the module that produced
 * the string, because "the editor shows the edit-path sentence while editing" is a
 * claim about the repaint reaching this element.
 *
 * @param pane - The mounted pane.
 * @returns The text the guidance line carries right now.
 */
function helpText(pane: BindingsPane): string {
    const painted = stubLastProps(pane.historyScopeHelp);
    const text = painted?.text;

    return typeof text === 'string' ? text : '';
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
 * Reopen the store over the same data directory, as a restarted service would.
 *
 * A **new handle**, not a new poller: the per-handle `WeakMap`s the product keeps
 * in `poll/events.ts` (`recoveredQuarantines`) and `history-scope-audit.ts`
 * (`observationStates`) are what a restart throws away, so a leg that claims to
 * test a restart has to throw them away too — otherwise it is a third repeat of
 * the sweep leg wearing a restart's name.
 *
 * @returns The fresh store over the same directory.
 */
async function restartStore(): Promise<ServiceStore> {
    return await openStore({ dataDir });
}

/**
 * One scan cycle over a fixed observation set, as a fresh poller each call.
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
 * The queue file's text, or `null` when the store holds no queue at all.
 *
 * The absent case is a **state** here, not an error: it is exactly what a service
 * restarting after a quarantine finds, and it is the only observation that sends a
 * reader to the evidence files (`recoverFromEvidence`).
 *
 * @returns The file's contents, or `null` when it is absent.
 */
async function storedQueueText(): Promise<string | null> {
    return await readFile(join(dataDir, 'events.json'), 'utf8').catch(() => null);
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

    it('leaves a pre-field document with zero bytes rewritten and zero checkpoints reset', async () => {
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
        // that change are the ones that record the scan itself — its stamp, and the
        // baseline the retained bound is built from. The bindings document is not
        // one of them: no migration runs, because there is nothing to migrate.
        await runScanCycle({ store, log, poller: recordingPoller([]).poller });

        expect(await readFile(join(dataDir, 'bindings.json'), 'utf8')).toBe(beforeBindings);
        expect(await quarantined()).toEqual([]);

        // The scan state moved for the scan's own reason and **nowwhere else**. This row
        // already carries a completed scan, so no baseline was derived for it — but
        // the scan that completed **retained** the window it opened, because the
        // retained baseline is the widest window the binding has ever scanned from
        // and only a completed scan may widen it (002 FR-073). On an upgraded store
        // that window is the incremental one, which is the only bound this record
        // ever carried.
        const state = await readScanState({ store, log });

        expect(state.bindings[BINDING_A]?.lastScanAt).not.toBe(SCANNED_AT);
        expect(state.bindings[BINDING_A]?.baselineAt)
            .toBe(new Date(Date.parse(SCANNED_AT) - OVERLAP_MS).toISOString());
        // Neither one-shot was armed on the way past either.
        expect(state.bindings[BINDING_A]?.forceReplay).toBe(false);
        expect(state.bindings[BINDING_A]?.rescanFrom).toBeNull();
    });
});

describe('§5.6 the mode reaches no other store', () => {
    it('names no mode in any log line, and no other stored projection', async () => {
        // The census `tasks.md` §D-10 claims and this suite now makes. Two fixed
        // names are not a secret, so nothing here is about confidentiality — it is
        // about **vocabulary**: a log line or a second document carrying the mode
        // would be a place to read the binding's window from, and the whole design
        // is that the window is one computed value reported on one row (002 FR-054).
        await plantBindings([binding(BINDING_A, 'recent-history')]);

        const cycle = cycleOver([issue(1, FIVE_DAYS_AGO)]);

        expect(await cycle()).toBe(1);

        for (const line of logLines) {
            expect(line, line).not.toContain('new-only');
            expect(line, line).not.toContain('recent-history');
        }

        // And `bindings.json` is the **only** store file that names the member: the
        // queue, the scan state, the run document, the config and the audit trail are
        // all covered, by reading the whole directory rather than naming the ones we
        // expect. The mode's third appearance is the health row, which is a *response*
        // and not a file — §5.22 proves that member, and this census proves it reaches
        // nothing else on disk and nothing in the log.
        const stored = await readdir(dataDir);
        const named = stored
            .filter((entry) => entry.endsWith('.json') || entry.endsWith('.ndjson'))
            .filter((entry) => entry !== 'bindings.json')
            .filter((entry) => readFileSync(join(dataDir, entry), 'utf8').includes('historyScope'));

        expect(named).toEqual([]);
    });

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

        // Now the reset: the same cleared stamp and the flag **set**, in one write —
        // asserted *between* the reset and the completing scan that clears it, since
        // a cycle which both sets and clears the flag would pass either way.
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );
        const duringReplay = await readEvents({ store, log: QUIET });
        const armed = bindingScanOf(await readScanState({ store, log: QUIET }), BINDING_A);

        // The read that found the loss is what cleared the stamp and set the flag.
        expect(duringReplay).toEqual([]);
        expect(armed.lastScanAt).toBeNull();
        expect(armed.forceReplay).toBe(true);
        expect(armed.baselineAt).toBe(DEFAULT_BASELINE);

        // The scan that follows completes, which advances the stamp and clears the
        // flag — the recovery path's flag, and no other writer's.
        const afterReset = recordingPoller([]);
        await runScanCycle({ store, log: QUIET, poller: afterReset.poller });
        const recovered = await readScanState({ store, log: QUIET });

        expect(recovered.bindings[BINDING_A]?.forceReplay).toBe(false);
        expect(recovered.bindings[BINDING_A]?.lastScanAt).not.toBeNull();
    });

    it('widens the retained baseline to a catch-up sweep\'s own bound, and re-offers it after a loss', async () => {
        // **Widening**, which is what this case proves: the retained baseline moves
        // to the widest window the binding has ever scanned from, so a later replay
        // re-covers the catch-up's ground instead of dropping it.
        //
        // A binding **younger than the look-back** derives its first baseline from its
        // own creation boundary, so that bound is *later* than the `now − 7 days` an
        // armed catch-up opens. The catch-up then sweeps a five-day-old assignment,
        // and the queue is lost. A replay opening at the un-widened baseline would be
        // **narrower** than the work it must re-cover — and those rows would be gone
        // for good, silently.
        //
        // Precedence — which bound the replay opens at when both are present — is
        // deliberately **not** asserted here: this fixture's baseline and its armed
        // bound are the same stamp after step 2, so the two shapes would be
        // indistinguishable and the case would claim a property it cannot see.
        // §5.15's row is where precedence is proven, with the two bounds different.
        const youngCreatedAt = new Date(Date.now() - 86_400_000).toISOString();
        // Inside the young binding's own creation-boundary window (five minutes
        // before it existed, which the overlap reaches back over), and a week
        // inside the armed catch-up's — so one stamp separates the two bounds.
        const insideYoung = new Date(Date.parse(youngCreatedAt) - 5 * 60_000).toISOString();

        await plantBindings([{ ...binding(BINDING_A), createdAt: youngCreatedAt }]);
        const cycle = cycleOver([issue(1, insideYoung)]);

        // 1. the first scan derives and retains the young binding's own boundary.
        expect(await cycle()).toBe(1);
        const derived = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(derived.baselineAt).toBe(new Date(Date.parse(youngCreatedAt) - OVERLAP_MS).toISOString());

        // 2. an armed catch-up opens **earlier** than that bound — `now − 7 days`
        //    against a binding one day old — and sweeps one row the young binding's
        //    own window never covered.
        const swept = [issue(1, insideYoung), issue(2, FIVE_DAYS_AGO)];

        await writeScanState({
            store,
            state: { bindings: { [BINDING_A]: { ...derived, rescanFrom: FIVE_DAYS_AGO } } },
        });
        const catchUp = await runScanCycle({ store, log, poller: recordingPoller(swept).poller });

        expect(catchUp.enqueued).toBe(1);
        // The completed sweep widened the retained baseline to the armed bound —
        // monotone widening, and the reason a replay can re-cover it (002 FR-073).
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).baselineAt).toBe(FIVE_DAYS_AGO);

        // 3. the queue is lost. The replay must re-offer **both** rows — the ones the
        //    catch-up queued and the one the first scan queued — under their own ids.
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );
        const afterLoss = await runScanCycle({ store, log, poller: recordingPoller(swept).poller });

        expect(afterLoss.enqueued).toBe(2);
        const reoffered = await queuedEventIds();

        expect(reoffered.toSorted(byText)).toEqual([
            `evt-acme~widget~1~${ACCOUNT_ID}`,
            `evt-acme~widget~2~${ACCOUNT_ID}`,
        ]);

        // And the replay left the widened bound where the sweep put it: it opened at
        // that bound, so it could not move it, and the recovery it just performed is
        // now part of what any later replay re-covers (002 FR-073).
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).baselineAt).toBe(FIVE_DAYS_AGO);
    });

    it('keeps an armed catch-up through a replay that never reached its ground', async () => {
        // The whole of plan H7's promise, driven end to end: an operator's explicit
        // seven-day look-back, **consumed by a scan that never looked back seven
        // days**, with nothing recording that it had been asked for.
        //
        // Reachability is structural, not hypothetical. A binding younger than the
        // look-back has a creation-derived baseline *later* than `now − 7 days`, so
        // arming it is the only way the request can be made at all (plan H6 — §5.18
        // proves the route writes exactly this stamp). Lose the queue before the next
        // cycle and the replay outranks the arming (002 FR-073), which is right: lost
        // work is the obligation. But the replay's window is *narrower* than the one
        // the operator asked for, so clearing the arming on completion discards it
        // (002 FR-076, FR-084).
        const youngCreatedAt = new Date(Date.now() - 86_400_000).toISOString();
        // The arming the route writes for a mode edit: `now − 604,800,000 ms`.
        const armedFrom = new Date(Date.now() - 604_800_000).toISOString();
        const insideYoung = new Date(Date.parse(youngCreatedAt) - 5 * 60_000).toISOString();

        await plantBindings([{ ...binding(BINDING_A), createdAt: youngCreatedAt }]);

        // 1. the young binding's first scan, which derives and retains its own
        //    creation boundary and completes.
        const first = recordingPoller([issue(1, insideYoung)]);

        const firstCycle = await runScanCycle({ store, log, poller: first.poller });

        expect(firstCycle.enqueued).toBe(1);
        expect(first.seen().windows).toEqual([new Date(Date.parse(youngCreatedAt) - OVERLAP_MS).toISOString()]);

        // 2. the operator moves it into the look-back mode; the route arms the
        //    bounded catch-up at `now − 7 days`.
        const armed = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(armed.lastScanAt).not.toBeNull();
        await writeScanState({
            store,
            state: { bindings: { [BINDING_A]: { ...armed, rescanFrom: armedFrom } } },
        });

        // 3. the queue is lost before the next cycle can serve it.
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );

        // 4. the replay completes — at the retained baseline, which is a week
        //    **narrower** than the arming, because this binding is one day old.
        const replay = recordingPoller([issue(1, insideYoung), issue(2, armedFrom)]);

        const replayCycle = await runScanCycle({ store, log, poller: replay.poller });

        expect(replayCycle.enqueued).toBe(1);
        expect(replay.seen().windows).toEqual([new Date(Date.parse(youngCreatedAt) - OVERLAP_MS).toISOString()]);

        // The request survives the scan that could not have served it. This is the
        // assertion the defect made unassertable: the completion flag alone would
        // have cleared it here.
        const afterReplay = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(afterReplay.rescanFrom).toBe(armedFrom);
        expect(afterReplay.forceReplay).toBe(false);
        expect(afterReplay.lastScanAt).not.toBeNull();
        // And the replay widened nothing: it opened at the retained baseline.
        expect(afterReplay.baselineAt).toBe(new Date(Date.parse(youngCreatedAt) - OVERLAP_MS).toISOString());

        // 5. the next scan is the one that serves it — at the armed bound, and
        //    clearing only because it reached the ground the arming asked for.
        const served = recordingPoller([issue(2, armedFrom)]);

        const servedCycle = await runScanCycle({ store, log, poller: served.poller });

        expect(servedCycle.enqueued).toBe(1);
        expect(served.seen().windows).toEqual([armedFrom]);

        const settled = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(settled.rescanFrom).toBeNull();
        // The served window widened the retained baseline to the arming, so a later
        // recovery replay re-covers that ground too (002 FR-073).
        expect(settled.baselineAt).toBe(armedFrom);
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

        // The next scan replays again — the flag survived every failure. It replays at
        // the **retained baseline**, not at the armed bound: recovery takes
        // precedence over an armed catch-up, because the replay's job is
        // re-covering lost work and the baseline is the widest window this binding
        // has ever scanned from (002 FR-073; plan H8, corrected 2026-10-05).
        const again = recordingPoller([issue(1, FIVE_DAYS_AGO), issue(2, AT_CREATION)]);
        const cycle = await runScanCycle({ store, log, poller: again.poller });

        expect(again.seen().windows).toEqual([DEFAULT_BASELINE]);
        expect(cycle.enqueued).toBe(1);

        // Having answered the replay, the flag is consumed and the stamp advanced —
        // but the **catch-up request is still armed**. The replay opened at
        // `DEFAULT_BASELINE`, which is *later* than `FIVE_DAYS_AGO`, so it never
        // reached the ground the operator asked for: that ground is a week older
        // than this binding's own creation boundary. Clearing the arming here would
        // discard the request with nothing recording it existed (002 FR-076, FR-084).
        const settled = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(settled.rescanFrom).toBe(FIVE_DAYS_AGO);
        expect(settled.forceReplay).toBe(false);
        expect(settled.lastScanAt).not.toBeNull();
        // The replay's own window could not widen the retained baseline: it opened
        // exactly at it (002 FR-073).
        expect(settled.baselineAt).toBe(DEFAULT_BASELINE);

        // And the scan after it is the one that serves the request — it opens at the
        // armed bound, and completing there is what clears it.
        const served = recordingPoller([issue(2, AT_CREATION), issue(3, FIVE_DAYS_AGO)]);
        const catchUp = await runScanCycle({ store, log, poller: served.poller });

        expect(served.seen().windows).toEqual([FIVE_DAYS_AGO]);
        expect(catchUp.enqueued).toBe(1);
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).rescanFrom).toBeNull();
        // The served window widened the retained baseline to the arming, so a later
        // recovery replay re-covers that ground too (002 FR-073).
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).baselineAt).toBe(FIVE_DAYS_AGO);
    });
});

describe('§5.16 a repeated sweep, a repeated recovery replay, and a restart produce zero duplicates', () => {
    it('holds zero duplicates across all five sequences', async () => {
        await plantBindings([binding(BINDING_A, 'recent-history')]);
        // Five different paths over one window, each answering with the same two
        // observations, and one set of rows out of all of them.
        const observations = [issue(1, FIVE_DAYS_AGO), issue(2, AT_CREATION)];
        const cycle = cycleOver(observations);

        // 1. the sweep
        expect(await cycle()).toBe(2);
        const afterSweep = await queuedEventIds();

        // 2. the repeated sweep
        expect(await cycle()).toBe(0);

        // 3. **a restart**: a genuinely new store handle over the same data
        //    directory, so the per-handle recovery claim sets the product keeps in
        //    `WeakMap`s (`recoveredQuarantines`, `observationStates`) are rebuilt
        //    from nothing. A fresh *poller* is not a restart — it is the sweep leg
        //    again, which is how this leg used to pass without testing anything.
        store = await restartStore();

        expect(await cycleOver(observations)()).toBe(0);
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

        // 5. the repeated recovery replay. The evidence file is still there, and the
        //    claim set is per-handle, so a **second restart** must find the evidence
        //    again and find the loss already recovered: one reset per loss per
        //    process, and a new process starts the claim from nothing (002 FR-073).
        store = await restartStore();

        expect(await cycleOver(observations)()).toBe(0);
        expect(await queuedEventIds()).toEqual(afterSweep);

        // Six legs, and the queue is still two rows with two distinct ids — the runs
        // the first sweep wrote are still the only two, because a re-offered event is
        // the **same** work: it neither duplicates the queue row nor mints a second
        // run (002 FR-081).
        const queue = await queuedEventIds();

        expect(queue).toHaveLength(2);
        expect(new Set(queue).size).toBe(2);

        const runs = JSON.parse(await readFile(join(dataDir, 'runs.json'), 'utf8')) as {
            runs: { state: string; session: unknown }[];
        };

        expect(runs.runs).toHaveLength(2);
        expect(runs.runs.every((run) => run.session === null)).toBe(true);
    });

    it('recovers a loss it never saw from the evidence a previous process left', async () => {
        // The half of "not on restart" that a restart is actually about, on the one
        // path where it is load-bearing.
        //
        // A quarantine **renames** the file, so a service that restarts after the loss
        // finds `events.json` simply absent: no read ever reports `quarantined` again
        // and the reset would never run. Only the `events.json.corrupt-*` evidence in
        // the directory stands in for the observation (`recoverFromEvidence`), and
        // the per-handle claim set is what decides whether this process believes it.
        //
        // The assertions below are the restart-dependent ones: this handle's claim set
        // is empty where the previous one's was not, and a cycle that **cannot list**
        // leaves the two durable facts on disk exactly as the evidence scan left them.
        // Run the same cycle without the restart and the claim set blocks the recovery,
        // so the stamp stays where the completing scan put it and the flag stays
        // `false` — both assertions fail.
        await plantBindings([binding(BINDING_A, 'recent-history')]);
        const observations = [issue(1, FIVE_DAYS_AGO)];

        // 1. **This** process loses the queue: a row the parser refuses. The read
        //    quarantines it — `events.json` is renamed to `events.json.corrupt-*` —
        //    the reset runs, and this handle claims that evidence by name. The cycle's
        //    own replay then re-offers the row and completes, which consumes the flag.
        await writeFile(
            join(dataDir, 'events.json'),
            JSON.stringify([{ id: 'evt-broken', issueNumber: 'not-a-number' }]),
            'utf8',
        );

        expect(await cycleOver(observations)()).toBe(1);
        expect((await quarantined())).toHaveLength(1);
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).forceReplay).toBe(false);

        // 2. The queue goes again and the evidence is the only trace left — the exact
        //    state `recoverFromEvidence` is written for. Nothing is corrupt now; there
        //    is simply no file.
        await rm(join(dataDir, 'events.json'));
        expect(await storedQueueText()).toBeNull();

        // 3. Restart: a new handle over the same directory, so the claim set is gone.
        store = await restartStore();

        // 4. A cycle that cannot list, so nothing completes and what it records is the
        //    recovery rather than a scan: a cleared stamp and the replay flag are on
        //    disk **only** because this fresh handle believed the evidence.
        await runScanCycle({ store, log, poller: failingPoller() });
        const recovered = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(recovered.lastScanAt).toBeNull();
        expect(recovered.forceReplay).toBe(true);

        // 5. And the replay the flag asked for re-offers the lost work under its
        //    **original** id — the same work, not a second row beside the first.
        expect(await cycleOver(observations)()).toBe(1);

        const queue = await queuedEventIds();

        expect(queue).toEqual([`evt-acme~widget~1~${ACCOUNT_ID}`]);
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

        // And the window rule consults it ahead of the recorded stamp — the arming is the
        // most recent explicit request for that binding's next scan. Ahead of the
        // **baseline** it is not: FR-073's replay outranks it (plan H8, corrected
        // 2026-10-05), and §5.15 is the row that proves which of the two wins.
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

    it('writes scan-state from inside the scan-state chain and nowhere else', () => {
        // The chain is what makes the scan-state file safe to read-modify-write at
        // all: the route that arms `rescanFrom`, the recovery reset that clears
        // `lastScanAt`, and the loop's own two writers all take the same task, so no
        // write can land between another writer's read and its write (002 FR-018,
        // FR-076; plan H7).
        //
        // **This is a census and not a race test, deliberately.** With every writer
        // on the one chain the lost update is *unreachable*, so no interleaving this
        // suite could drive would distinguish the two shapes — which is exactly what
        // a reviewer found by reverting the fix and watching all 1431 tests stay
        // green. What the census can prove is the thing the race test cannot: that
        // the loop contributes no writer outside the chain, so the safety is a
        // property of the code rather than of the callers happening not to
        // interleave.
        const loop = readFileSync(join(REPO, 'service', 'poll', 'loop.ts'), 'utf8');
        // One function's own source, up to its closing brace at column 0 — which no
        // nested block in it can produce.
        const body = (marker: string): string => {
            const start = loop.indexOf(marker);
            const end = loop.indexOf('\n}\n', start);

            expect(start, marker).toBeGreaterThan(-1);
            expect(end, marker).toBeGreaterThan(start);

            return loop.slice(start, end);
        };

        // `ensureBaselines` is one `serializeScan` task whose read precedes its write:
        // a `PUT` arming `rescanFrom`, or a recovery reset setting `forceReplay`,
        // between the two cannot be reverted by a stale map written back over it.
        const baselines = body('async function ensureBaselines');

        expect(baselines.match(/serializeScan\(/g) ?? []).toHaveLength(1);
        expect(baselines.indexOf('serializeScan(')).toBeLessThan(baselines.indexOf('readScanState('));
        expect(baselines.indexOf('readScanState(')).toBeLessThan(baselines.indexOf('writeScanState('));

        // And the cycle that calls it reads that file **nowhere of its own**, which is
        // what closes the split between the caller's read and the chain's write.
        const cycle = body('export async function runScanCycle');

        expect(cycle).not.toContain('readScanState(');
        expect(cycle).not.toContain('writeScanState(');

        // Two writers in the loop, both chained: the one-shot clearing and the
        // baseline derivation. A third would be a second mechanism.
        expect(loop.match(/writeScanState\(/g) ?? []).toHaveLength(2);
        expect(loop.match(/serializeScan\(/g) ?? []).toHaveLength(2);
    });

    it('never turns an unreadable arming into a window, and never clears it', async () => {
        // An unreadable `rescanFrom` is the one stuck state this mechanism admits, and
        // **both** halves of its handling are deliberate (002 FR-060, FR-076, FR-084):
        //
        // - it **must not become a window**. The member exists to carry one chosen
        //   lower bound, and a value the clock cannot read is not a bound anybody
        //   chose. Arming off it would fire work the operator never asked for — the
        //   direction FR-065's boundedness exists to prevent, and the one nothing here
        //   can undo afterwards;
        // - it **must not be silently cleared** either. `answersCatchUp` answers
        //   `false` for a stamp it cannot interpret, so a completing scan cannot serve
        //   a request it did not read, and dropping the member would discard that
        //   request with nothing recording it existed — plan H7's failure by a
        //   different route.
        //
        // So it is **permanently pending**. Only the bindings route writes this member
        // and it writes the arithmetic result of the look-back as an ISO stamp, so the
        // state is reachable only from a hand-edited or corrupted store — the same
        // family of cases FR-072's fail-closed refusals already answer for the other
        // two members.
        const garbage = 'not-a-date';
        // Inside the ordinary incremental window this slot scans at, so the cycle below
        // completes and does real work: the stuck member must not wedge the binding.
        const incremental = new Date(Date.parse(SCANNED_AT) - OVERLAP_MS).toISOString();
        const insideWindow = new Date(Date.parse(SCANNED_AT) + 3_600_000).toISOString();

        await plantBindings([binding(BINDING_A, 'recent-history')]);
        await writeScanState({
            store,
            state: {
                bindings: {
                    [BINDING_A]: {
                        ...emptyBindingScan(),
                        lastScanAt: SCANNED_AT,
                        baselineAt: LOOK_BACK_BASELINE,
                        rescanFrom: garbage,
                    },
                },
            },
        });

        // The slot itself: a string is a shape this build accepts (plan H4), so the
        // member survives to be *judged* rather than defaulting, and **no other
        // binding's checkpoint is lost** to it — an unusable *type* refuses the
        // document, an unusable *stamp* is this case.
        expect(await quarantined()).toEqual([]);
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A)).toEqual({
            lastScanAt: SCANNED_AT,
            lastError: null,
            baselineAt: LOOK_BACK_BASELINE,
            forceReplay: false,
            rescanFrom: garbage,
        });

        // The rule, at the rule: no window from it, and no answering of it either.
        const slot = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(windowFor({ binding: binding(BINDING_A, 'recent-history'), scanned: slot, overlapMs: OVERLAP_MS }))
            .toEqual({ window: incremental });
        expect(answersCatchUp({ opened: incremental, armed: garbage })).toBe(false);
        // And not even when the scan opened at the garbage's own value, which is the
        // only shape in which a comparison could mistake one for the other.
        expect(answersCatchUp({ opened: garbage, armed: garbage })).toBe(false);

        // The cycle itself: it scans the ordinary window, enqueues, and advances its
        // own checkpoint — while the unreadable arming is still sitting there.
        const { poller, seen } = recordingPoller([issue(1, insideWindow)]);
        const cycle = await runScanCycle({ store, log, poller });

        expect(seen().windows).toEqual([incremental]);
        expect(cycle.enqueued).toBe(1);

        const afterCycle = bindingScanOf(await readScanState({ store, log }), BINDING_A);

        expect(afterCycle.rescanFrom).toBe(garbage);
        expect(afterCycle.lastScanAt).not.toBe(SCANNED_AT);
        // The baseline did not move either: the completed scan opened at a window
        // *later* than the retained one, and widening only ever goes earlier (002 FR-073).
        expect(afterCycle.baselineAt).toBe(LOOK_BACK_BASELINE);

        // And it is still there on the next cycle — permanent, not deferred.
        await runScanCycle({ store, log, poller: recordingPoller([issue(2, insideWindow)]).poller });
        expect(bindingScanOf(await readScanState({ store, log }), BINDING_A).rescanFrom).toBe(garbage);

        // **Not observable, and asserted as such.** No projection carries this member —
        // the health row reports the window in force, the mode, and the replay flag,
        // and `rescanFrom` is in none of them — and no log line names it. So the
        // operator sees a binding in look-back mode scanning its ordinary incremental
        // window, which is exactly what a *served* look-back looks like: the state is
        // fail-closed and it is in the file, but nothing says it is stuck.
        //
        // Pinned rather than papered over. Closing that gap means a member on the
        // health row, which is a wire contract the panel reads (002 FR-092), so it is
        // a spec decision rather than a test's to make — and until it is made, this
        // assertion is what keeps the gap from closing unnoticed *or* being forgotten.
        const { readStatusRows } = await import('../service/routes/events.ts');
        const rows = await readStatusRows({
            store,
            log: QUIET,
            bindings: [binding(BINDING_A, 'recent-history')],
            overlapMs: OVERLAP_MS,
        });

        expect(Object.hasOwn(rows[0] ?? {}, 'rescanFrom')).toBe(false);
        // Which is the shape an operator would see: look-back mode, and the ordinary
        // incremental window a **served** look-back also leaves behind.
        const projected = rows[0];

        expect(projected?.historyScope).toBe('recent-history');
        expect(projected?.lastError).toBeNull();
        expect(projected?.windowStart)
            .toBe(new Date(Date.parse(projected?.lastScanAt ?? '') - OVERLAP_MS).toISOString());
        expect(logLines.join('\n')).not.toContain('rescanFrom');
        expect(logLines.join('\n')).not.toContain(garbage);
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

    it('states every one of the six things the editor actually shows', async () => {
        // 002 FR-090's six claims, read off what the **mounted editor** renders
        // rather than off a pure function's two branches. Assert 5 is the one that
        // needed this: "offers every matching item inside that window at once,
        // which may be many sessions" is the warning that exists **only** on the
        // edit path — the path that opens a catch-up (002 FR-084; plan H6) — and a
        // suite that loops a pure function over `[false, true]` would pass while
        // the shipped editor showed the add-path sentence on both.
        for (const isEditing of [false, true]) {
            const pane = mountedBindingsPane({ editing: isEditing });
            const guidance = helpText(pane.pane);
            const label = `editing=${String(isEditing)}`;

            // 1. the default watches from now on
            expect(guidance, label).toContain('From now on is the default');
            // 2. a fixed seven-day period
            expect(guidance, label).toContain('seven days');
            // 3. once, and not repeated on its own
            expect(guidance, label).toContain('once');
            expect(guidance, label).toContain('does not repeat on its own');
            // 4. bounded, with no "all history"
            expect(guidance, label).toContain('always bounded');
            expect(guidance, label).toContain('no "all history" option');
            // 5. what an edit will offer — the catch-up warning, and **only** where
            //    a catch-up can open.
            if (isEditing) {
                expect(guidance).toContain('offers every matching item inside that window at once');
                expect(guidance).toContain('may be many sessions');
            } else {
                expect(guidance).toContain('looks back once, from before the binding existed');
                expect(guidance).not.toContain('many sessions');
            }

            // 6. recovery is never governed by this setting
            expect(guidance, label).toContain('recovery replay');
            expect(guidance, label).toContain('regardless of this setting');
        }
    });

    it('repaints the guidance when the editor mode changes under a mounted pane', () => {
        // The other half of FR-090: the editor block is mounted **once** and reused
        // for both modes, so a string chosen at mount time would never change. The
        // add form opens it, a row selection swaps it to edit mode, and the line
        // under the control has to follow — with no second mount.
        const pane = mountedBindingsPane({ editing: false });

        expect(helpText(pane.pane)).toContain('from before the binding existed');

        pane.rt.state.bindings.editing = true;
        refresh(pane.rt);

        expect(helpText(pane.pane)).toContain('may be many sessions');
        expect(helpText(pane.pane)).not.toContain('from before the binding existed');
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

    it('writes the edited row\'s mode on that row alone, and every other row its own', async () => {
        // 002 FR-057 and FR-084, asserted on the **bytes the panel actually sends**.
        //
        // The bug this replaces was invisible from a helper: `rowForGrant` took a
        // bare `HistoryScope`, so a value without a row stamped the edited
        // binding's mode onto every row of the whole-file grant — and the service,
        // reading a mode change on a row nobody opened, armed a bounded catch-up
        // for it. A suite asserting a per-row helper would keep passing after that,
        // because the helper was not on the path.
        const rows = [
            panelRow(BINDING_A, 'new-only', 'acme/widget'),
            panelRow(BINDING_B, 'recent-history', 'acme/other'),
        ];
        const pane = mountedBindingsPane({ editing: true, rows });

        pane.rt.state.bindings.historyScopeInput = 'recent-history';
        pane.rt.state.bindings.selectedBinding = BINDING_A;
        pane.rt.state.bindings.repoInput = 'acme/widget';
        pane.rt.state.bindings.repoProjectSelection = 'prj_42';

        await saveEditedBinding(pane.rt);
        await tick();

        // Two rows, two answers. `BINDING_B` was never opened in the editor, so the
        // grant must not carry the editor's choice onto it — a fabricated mode change
        // there is exactly what arms a catch-up nobody asked for (002 FR-084).
        expect(grantedModes(pane.bodies)).toEqual([
            [BINDING_A, 'recent-history'],
            [BINDING_B, 'recent-history'],
        ]);

        // And the case the bug was actually reported with: the edited row moves
        // *into* the look-back while the other row stays in the default, so the
        // other row's stored mode must survive the whole-file replacement.
        const second = mountedBindingsPane({
            editing: true,
            rows: [panelRow(BINDING_A, 'new-only', 'acme/widget'), panelRow(BINDING_B, 'new-only', 'acme/other')],
        });

        second.rt.state.bindings.historyScopeInput = 'recent-history';
        second.rt.state.bindings.selectedBinding = BINDING_A;
        second.rt.state.bindings.repoInput = 'acme/widget';
        second.rt.state.bindings.repoProjectSelection = 'prj_42';

        await saveEditedBinding(second.rt);
        await tick();

        expect(grantedModes(second.bodies)).toEqual([
            [BINDING_A, 'recent-history'],
            [BINDING_B, 'new-only'],
        ]);
    });

    it('creates one look-back binding without touching the others\' modes', async () => {
        // The add path is the worse half of the same bug: a **new** row has no id
        // the operator could have edited, so a mode that did not name its row would
        // land on every existing binding and re-arm each scanned one.
        const rows = [
            panelRow(BINDING_A, 'recent-history', 'acme/widget'),
            panelRow(BINDING_B, 'new-only', 'acme/other'),
        ];
        const pane = mountedBindingsPane({ editing: false, rows });

        pane.rt.state.bindings.repoInput = 'acme/new-thing';
        pane.rt.state.bindings.repoProjectSelection = 'prj_42';
        pane.rt.state.bindings.accountSelection = ACCOUNT_ID;
        pane.rt.state.bindings.historyScopeInput = 'recent-history';

        await bindRepository(pane.rt);
        await tick();

        const granted = grantedModes(pane.bodies);

        expect(granted).toHaveLength(3);
        // The two existing rows keep what they held; only the new row carries the
        // look-back the operator chose on the add form.
        expect(granted.slice(0, 2).map(([, scope]) => scope)).toEqual(['recent-history', 'new-only']);
        expect(granted[2]?.[1]).toBe('recent-history');
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
