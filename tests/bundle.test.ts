import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { drainVerifications } from '../src/agent-verify.ts';
import { DISPATCH_STORAGE_KEY } from '../src/dispatch-record.ts';
import { auditItems, parseAuditBody } from '../src/audit-view.ts';
import { findSecretLeak } from '../src/redaction.ts';
import { pollRelay } from '../src/relay.ts';
import { AUDIT_FILE } from '../service/audit.ts';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { CONFIG_FILE } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { EVENTS_FILE, createEvent, enqueueEvents } from '../service/poll/events.ts';
import { resolvePromptSnapshot } from '../service/prompt.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { ACCOUNT_PATH } from '../service/routes/accounts.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { CONFIG_PATH } from '../service/routes/config.ts';
import { EVENTS_PATH } from '../service/routes/events.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceLogger } from '../service/log.ts';
import { byText } from './support/sort.ts';
import { readRuns } from './support/dispatch-corpus.ts';
import { startDispatchLoop } from './support/dispatch-loop.ts';
import { BINDING_ID, REPOSITORY } from './support/fixture-enqueue.ts';
import { PROJECT_ID } from './support/panel.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Repository-relative path of the committed panel bundle. */
const PANEL_BUNDLE_PATH = 'panel/main.js';

/** Bundled panel entry produced by `npm run build`. */
const BUNDLE = resolve(ROOT, PANEL_BUNDLE_PATH);

/** Repository-relative path of the committed service bundle. */
const SERVICE_BUNDLE_PATH = 'service/main.js';

/** Bundled service entry produced by `npm run build`. */
const SERVICE_BUNDLE = resolve(ROOT, SERVICE_BUNDLE_PATH);

/** Panel HTML that loads the bundle. */
const PANEL_HTML = resolve(ROOT, 'panel/index.html');

/** Encoding used when reading the shipped artifacts. */
const UTF8 = 'utf8';

/** Surface name the `GET /v1/audit` answer is scanned under in both scans. */
const AUDIT_READ_SURFACE = 'the audit read';

/** GitHub token shapes that must never appear in shipped artifacts. */
const TOKEN_PATTERNS: readonly RegExp[] = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/];

/** Exports of the committed service bundle, typed without an `any`. */
interface ServiceEntryModule {
    /** Starts the service from the host environment; called only when spawned. */
    readonly runService: (env?: NodeJS.ProcessEnv) => Promise<void>;
}

describe('built panel bundle', () => {
    it('exists where the manifest expects it', () => {
        {
            expect(existsSync(BUNDLE)).toBe(true);
        }
        {
            const bundle = readFileSync(BUNDLE, UTF8);
            expect(bundle.startsWith('(()=>{')).toBe(true);
            expect(bundle.trimEnd().endsWith('})();')).toBe(true);
            expect(bundle).not.toContain('import.meta');
            expect(bundle).not.toMatch(/(^|\n)export\s/m);
            expect(bundle).not.toMatch(/(^|\n)import\s/m);
        }
        {
            const bundle = readFileSync(BUNDLE, UTF8);
            for (const pattern of TOKEN_PATTERNS) {
                expect(bundle).not.toMatch(pattern);
            }
        }
        {
            // The host never compiles TypeScript for the panel either, so an
            // uncommitted bundle would install a shell with nothing behind it.
            const tracked = execFileSync('git', ['ls-files', '--error-unmatch', PANEL_BUNDLE_PATH], {
                cwd: ROOT,
                encoding: UTF8,
            });

            expect(tracked.trim()).toBe(PANEL_BUNDLE_PATH);
        }
        {
            const bundle = readFileSync(BUNDLE, UTF8);

            // The mount-time gate greps the bundle for the pane's marker; the
            // minifier renames identifiers and strips comments, so the marker
            // rides a runtime attribute instead: `data-mount="mountBindingsBody"`.
            expect(bundle).toContain('mountBindingsBody');
            // And a semantic proof that is only true when the pane's code is
            // actually bundled: the empty-list copy the pane itself renders.
            // FR-020: the tab's status line leads with *Bindings*, and the retired
            // noun it used to lead with appears nowhere in the shipped bundle.
            expect(bundle).not.toContain('Repositories: ');
        }
        {
            // 005 FR-123, over the **shipped bytes** rather than the source: the
            // picker names the state the product actually has, and the withdrawn
            // *verified* placeholder — a state `AccountState` does not carry —
            // ships nowhere. Asserted on the artifact because the host never
            // compiles TypeScript, so a fix that reached only `src/` would leave
            // the installed panel still asking for one.
            const bundle = readFileSync(BUNDLE, UTF8);

            expect(bundle).toContain('Select an active account');
            expect(bundle).not.toContain('Select a verified account');
        }
        {
            // FR-121 and FR-122's second row, over the shipped bytes as well: the
            // reason line and the zero-account empty text are copy the operator
            // reads, so their absence from the bundle would be a source-only fix.
            const bundle = readFileSync(BUNDLE, UTF8);

            expect(bundle).toContain('Add an account on the Accounts tab before binding a repository.');
            expect(bundle).toContain('No binding yet — add an account on the Accounts tab first.');
        }
        {
            // FR-122's third row ships too — the pre-read sentence, which is the
            // frame the `no-accounts` visual scene exists to photograph.
            const bundle = readFileSync(BUNDLE, UTF8);

            expect(bundle).toContain('No binding yet — the account list is not known. Refresh to read it.');
        }
        {
            const bundle = readFileSync(BUNDLE, UTF8);

            // FR-011: the spike surface is deleted, not hidden — so what ships
            // carries none of its controls, and the six labels FR-010 names do.
            for (const retired of ['Start session', 'Record phase', 'Observed phase', 'Verify host state']) {
                expect(bundle).not.toContain(retired);
            }

            for (const label of ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About']) {
                expect(bundle).toContain(`"${label}"`);
            }
        }
    });
});

describe('panel html', () => {
    it('loads the bundled script', () => {
        {
            const html = readFileSync(PANEL_HTML, UTF8);
            expect(html).toContain('<script src="main.js"></script>');
        }
        {
            const html = readFileSync(PANEL_HTML, UTF8);
            expect(html).not.toMatch(/(token|secret|password)\s*=/i);
            for (const pattern of TOKEN_PATTERNS) {
                expect(html).not.toMatch(pattern);
            }
        }
    });
});

describe('built service bundle', () => {
    it('exists where the manifest expects it', () => {
        expect(existsSync(SERVICE_BUNDLE)).toBe(true);
    });

    it('is committed to the repository', () => {
        // The host never compiles TypeScript: `service/main.js` ships built, so
        // an uncommitted bundle would install a broken service.
        const tracked = execFileSync('git', ['ls-files', '--error-unmatch', SERVICE_BUNDLE_PATH], {
            cwd: ROOT,
            encoding: UTF8,
        });

        expect(tracked.trim()).toBe(SERVICE_BUNDLE_PATH);
    });

    it('is ESM rather than a classic IIFE', () => {
        const bundle = readFileSync(SERVICE_BUNDLE, UTF8);

        expect(bundle.startsWith('(()=>{')).toBe(false);
        expect(bundle.trimEnd().endsWith('})();')).toBe(false);
        // `--node` keeps Node built-ins external and the entry's exports, both
        // of which are only expressible in module form.
        expect(bundle).toMatch(/^import\s.*from\s+['"]node:/m);
        expect(bundle).toMatch(/^export\s*\{/m);
    });

    it('imports without starting a service', async () => {
        const module: ServiceEntryModule = await import(pathToFileURL(SERVICE_BUNDLE).href);

        // Loading the module must be inert: only a process spawned as
        // `node service/main.js` starts listening (see service-entry.test.ts).
        expect(typeof module.runService).toBe('function');
    });

    it('carries no GitHub token material', () => {
        const bundle = readFileSync(SERVICE_BUNDLE, UTF8);
        for (const pattern of TOKEN_PATTERNS) {
            expect(bundle).not.toMatch(pattern);
        }
    });

    it('ships a service version pinned to the extension package (006 AC-145, invariant 5)', () => {
        const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), UTF8)) as {
            readonly version?: string;
        };
        const health = readFileSync(resolve(ROOT, 'service/routes/health.ts'), UTF8);

        expect(version).toBeDefined();
        expect(health).toContain(`SERVICE_VERSION = '${version}'`);
        // The shipped bytes carry the same number, so a bump that forgot to
        // rebuild would be visible from the artifact itself.
        expect(readFileSync(SERVICE_BUNDLE, UTF8)).toContain(String(version));
    });
});

/* ------------------------------------------------------------------------- *
 * 003 containment and posture scans (T-033: AC-120, AC-128, NFR-106, NFR-109)
 *
 * The scans above prove the *shipped bytes* are clean; these prove the feature's
 * own surfaces are. The record scan drives the real loop with a credential
 * registered in the store beside it, so "zero occurrences" is measured against
 * something that could actually leak rather than against an empty room.
 * ------------------------------------------------------------------------- */

/** Credential registered in the service store while every surface is scanned. */
const REGISTERED_PAT = `ghp_${'scan'.repeat(10)}`;

/** Numeric id of the account that credential belongs to. */
const SCANNED_ACCOUNT_ID = '77331';

/** Login the scanned account carries. */
const SCANNED_LOGIN = 'octocat';

/** Issue the scanned run is about. */
const SCANNED_ISSUE = 73;

/** Stamp the scanned account record carries. */
const SCANNED_STAMP = '2026-09-20T00:00:00.000Z';

/** A concrete dispatch token value, which no shipped artifact may embed. */
const CONCRETE_TOKEN = /\bdtk-[0-9a-f]{32}\b/;

/** Usage patterns of the HTML sinks contract §4 rule 5 forbids. */
const HTML_SINKS: readonly RegExp[] = [
    /\.innerHTML\b/,
    /insertAdjacentHTML\s*\(/,
    /\.outerHTML\b/,
    /\.insertAdjacentText\s*\(/,
    /\bdocument\.write\s*\(/,
];

/** Source directories the static scans walk. */
const SOURCE_DIRS: readonly string[] = ['src', 'service'];

/** Modules allowed to talk to GitHub's REST API; every one of them reads. */
/**
 * The modules allowed to name GitHub's REST API at all (FR-002, FR-031).
 *
 * Every one of them is a **reader**: the panel's shape reader, the service's
 * credential verifier, and the poller's two halves — the endpoint catalogue and
 * the transport that builds and classifies every request they issue. The split
 * at 002 v1.12.0 added `poller-transport.ts` beside `poller-github.ts`, and it is
 * named here because a module that builds a URL is a gateway whether or not it
 * also lists endpoints; leaving it out would have let a genuine write land in a
 * module the scan had stopped covering.
 */
const GITHUB_GATEWAYS: ReadonlySet<string> = new Set([
    'src/github.ts',
    'service/github.ts',
    'service/poll/poller-github.ts',
    'service/poll/poller-transport.ts',
]);

/** A reference to GitHub's REST API, however the module spells it. */
const GITHUB_API = /api\.github\.com|API_ORIGIN|`\/repos\//;

/** A non-GET HTTP method literal: the shape every GitHub write would take. */
const GITHUB_WRITE_METHOD = /\bmethod:\s*['"](POST|PUT|PATCH|DELETE)['"]/;

/**
 * 003's own modules, named so the scan cannot quietly stop covering them.
 *
 * The walk is dynamic — every `.ts` under {@link SOURCE_DIRS} is read — and
 * this list is the assertion that the newest additions are inside it (AC-128's
 * "covers every new module").
 */
/** `src/dispatches-rows.ts`, named once so no list below repeats the literal. */
const DISPATCHES_ROWS_MODULE = 'src/dispatches-rows.ts';

const DISPATCH_MODULES: readonly string[] = [
    'src/relay.ts',
    'src/relay-gates.ts',
    'src/relay-attempt.ts',
    'src/dispatch-record.ts',
    'src/claim-service.ts',
    'src/reconcile.ts',
    'src/prerequisites.ts',
    'src/audit-view.ts',
    DISPATCHES_ROWS_MODULE,
    'src/dispatches-service.ts',
    'src/service-calls.ts',
    'src/session.ts',
    'service/poll/run-key.ts',
    'service/poll/runs.ts',
    'service/poll/claim.ts',
    'service/poll/claim-bounds.ts',
    'service/poll/claim-project.ts',
    'service/poll/sweep.ts',
    'service/poll/sweep-loop.ts',
    'service/poll/dispatch-authorize.ts',
    'service/poll/dispatch-report.ts',
    'service/poll/dispatch-block.ts',
    'service/poll/run-operate.ts',
    'service/poll/run-refusal.ts',
    'service/poll/run-verify.ts',
    'service/poll/runs-audit.ts',
    'service/poll/runs-adopt.ts',
    'service/routes/dispatch.ts',
    'service/routes/run-ops.ts',
    'service/routes/run-answer.ts',
    'service/routes/audit.ts',
];

/**
 * 004's own modules, named so the static scans cannot quietly stop covering
 * them (AC-143's "new assertions", AC-144's "the panel never touches the
 * binding field") — plus every `service/` module the layered-prompt work
 * introduced or touched, so the suppression and `any` gate below is never
 * blind on a module these commits added.
 *
 * The walk is dynamic — every `.ts` under {@link SOURCE_DIRS} is read — so
 * this list is the assertion that the newest additions are inside it.
 */
/**
 * The one suppression shape invariant 7 permits: scoped to the line below, and
 * carrying the reason.
 *
 * A bare `eslint-disable`, a file-wide `/* eslint-disable … *\/` block, and a
 * missing reason are all still failures here. The ESLint layer enforces the
 * same three properties repo-wide (`no-unlimited-disable`,
 * `disable-enable-pair`, `require-description`); keeping the check here as well
 * is what attaches the guarantee to the prompt pipeline specifically, which is
 * where a quietly suppressed check would cost the most.
 */
const LINE_SCOPED_DISABLE = /eslint-disable-next-line\s+[\w@/-]+\s+--\s+\S/u;

const PROMPT_MODULES: ReadonlySet<string> = new Set([
    'src/prompt.ts',
    'src/prompt-wire.ts',
    'src/context-blocks.ts',
    'src/session.ts',
    'src/claim-service.ts',
    'src/relay-attempt.ts',
    'src/dispatches-service.ts',
    DISPATCHES_ROWS_MODULE,
    'src/run-state.ts',
    'service/prompt.ts',
    'service/prompt-audit.ts',
    'service/bindings.ts',
    'service/bindings-read.ts',
    'service/routes/bindings.ts',
    'service/poll/runs-parse.ts',
    'service/poll/claim-project.ts',
    'service/poll/run-history-project.ts',
    'service/poll/dispatch-audit.ts',
    'service/config-prompt-observe.ts',
    'service/account-prompt-audit.ts',
    'service/config-schema.ts',
    'service/accounts/model.ts',
    'service/accounts/store.ts',
    'service/routes/accounts.ts',
    // Every other module the layered-prompt commits introduced or touched
    // under `service/`: the tier validators, the configuration observer and
    // its audit lanes, the profile write, and the routes/cycle files they
    // wired through. Named here because a module this list omits is a module
    // the suppression and `any` scan below never reads (T-035's blind spot).
    'service/audit-trim.ts',
    'service/config-audit.ts',
    'service/config-prompt.ts',
    'service/config.ts',
    'service/poll/cycle-config.ts',
    'service/poll/loop.ts',
    'service/poll/timer.ts',
    'service/routes/account-profile.ts',
    'service/routes/config.ts',
    'service/routes/index.ts',
    'service/routes/verify.ts',
]);

/** One file the static scans read. */
interface ScannedFile {
    /** Repository-relative path, for the failure message. */
    readonly path: string;
    /** File text, scanned as written. */
    readonly text: string;
}

/**
 * Read every source module once, plus the panel entry.
 *
 * @returns The path and text of each `.ts` file under {@link SOURCE_DIRS}.
 */
function scanSources(): readonly ScannedFile[] {
    const files: ScannedFile[] = [];
    for (const dir of SOURCE_DIRS) {
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map(String);
        for (const entry of entries) {
            if (!entry.endsWith('.ts')) {
                continue;
            }

            files.push({ path: `${dir}/${entry}`, text: readFileSync(resolve(ROOT, dir, entry), UTF8) });
        }
    }

    files.push({ path: 'panel/main.ts', text: readFileSync(resolve(ROOT, 'panel/main.ts'), UTF8) });

    return files;
}

/**
 * Read one service answer as the text an operator's client would see.
 *
 * @returns The response text.
 * @throws {Error} When the route answers anything but `200`.
 */
async function answerText(loop: DispatchLoop, path: string): Promise<string> {
    const response = await loop.service.call(path);
    if (response.status !== 200) {
        throw new Error(`${path} answered ${response.status}, expected 200`);
    }

    return await response.text();
}

/** The account record the scanned credential lives in (002 data model). */
function scannedAccount(): Record<string, unknown> {
    return {
        numericUserId: SCANNED_ACCOUNT_ID,
        login: SCANNED_LOGIN,
        expectedLogin: null,
        verifiedAt: SCANNED_STAMP,
        errorReason: null,
        createdAt: SCANNED_STAMP,
        updatedAt: SCANNED_STAMP,
        credential: { token: REGISTERED_PAT, kind: 'classic', verifiedAt: SCANNED_STAMP },
        scopeCheck: { checkedAt: SCANNED_STAMP, results: Object.fromEntries(
            ['metadata', 'issues', 'pull-requests', 'contents'].map((capability) => [capability, 'ok']),
        ) },
        state: 'active',
        connectionState: 'connected',
    };
}

describe('003 records carry no credential (AC-120, NFR-106)', () => {
    it('scans runs, references, attempts, audit rows, the history, the panel record, and the view', async () => {
        const loop = await startDispatchLoop();
        try {
            // A real credential sits in the store while the surfaces are read,
            // so a leak anywhere in the chain would be visible.
            await loop.store.writeJson(`accounts/${SCANNED_ACCOUNT_ID}.json`, scannedAccount());
            await loop.enqueue({ issueNumber: SCANNED_ISSUE });
            const rt = loop.mount();
            await pollRelay(rt);
            await drainVerifications(rt);

            const runs = await readRuns(loop.store);
            const run = runs[0];
            if (run === undefined) {
                throw new Error('the scanned run was not created');
            }

            const auditText = await answerText(
                loop,
                `${AUDIT_PATH}?correlationId=${encodeURIComponent(run.correlationId)}`,
            );
            const historyText = await answerText(loop, EVENTS_PATH);
            const auditBytes = await readFile(resolve(loop.service.dataDir, AUDIT_FILE), UTF8);
            const record = loop.panelStorage.get(DISPATCH_STORAGE_KEY) ?? null;
            const rows = parseAuditBody(auditText) ?? [];
            const surfaces: readonly (readonly [string, string])[] = [
                [RUNS_FILE, await readFile(resolve(loop.service.dataDir, RUNS_FILE), UTF8)],
                [AUDIT_FILE, auditBytes],
                ['the run history projection', historyText],
                [AUDIT_READ_SURFACE, auditText],
                ['the panel dispatch record', JSON.stringify(record)],
                ['the audit view', JSON.stringify(auditItems({
                    status: 'ready',
                    correlationId: run.correlationId,
                    rows,
                    note: '',
                }))],
            ];

            for (const [name, text] of surfaces) {
                expect(text, `${name} carried the registered credential`).not.toContain(REGISTERED_PAT);
                expect(findSecretLeak(text), `${name} carried credential material`).toBeNull();
            }

            // A live authorization value never reaches the retained trail: the
            // row records a fingerprint, the panel record is not the trail
            // (T-040c, FR-061).
            expect(auditBytes, 'audit.ndjson carried a dispatch token value').not.toMatch(CONCRETE_TOKEN);
        } finally {
            await loop.shutdown();
        }
    });
});

describe('NFR-109 no HTML sink on a shipped artifact or a new field', () => {
    it('keeps both committed bundles free of HTML sinks', () => {
        {
            for (const bundle of [BUNDLE, SERVICE_BUNDLE]) {
                const text = readFileSync(bundle, UTF8);
                for (const sink of HTML_SINKS) {
                    expect(text, `${bundle} must not use ${sink.source}`).not.toMatch(sink);
                }
            }
        }
        {
            const sources = scanSources();
            const rendered = [
                DISPATCHES_ROWS_MODULE, 'src/audit-view.ts', 'src/prerequisites.ts', 'src/dispatches-ui.ts'];
            for (const path of rendered) {
                const file = sources.find((candidate) => candidate.path === path);
                expect(file, `${path} was not scanned`).toBeDefined();
                for (const sink of HTML_SINKS) {
                    expect(file?.text, `${path} must not use ${sink.source}`).not.toMatch(sink);
                }
            }
        }
    });
});

describe('AC-128 the no-GitHub-write scan covers every module (FR-002)', () => {
    it('reads every source module, including every 003 addition', () => {
        {
            const files = scanSources();
            expect(files.length).toBeGreaterThan(60);

            const paths = new Set(files.map((file) => file.path));
            for (const module of DISPATCH_MODULES) {
                expect(paths.has(module), `${module} was not scanned`).toBe(true);
            }
        }
        {
            // The scan has to bite before it can be believed.
            expect(GITHUB_API.test('const url = new URL(API_ORIGIN + "/repos/acme/widget/issues")')).toBe(true);
            expect(GITHUB_API.test('const path = `/repos/` + owner + `/issues`')).toBe(true);

            const outsiders = scanSources()
                .filter((file) => GITHUB_API.test(file.text) && !GITHUB_GATEWAYS.has(file.path))
                .map((file) => file.path);
            expect(outsiders).toEqual([]);
        }
        {
            expect(GITHUB_WRITE_METHOD.test("method: 'POST'")).toBe(true);

            const gateways = scanSources().filter((file) => GITHUB_GATEWAYS.has(file.path));
            expect(gateways).toHaveLength(GITHUB_GATEWAYS.size);
            for (const file of gateways) {
                expect(file.text, `${file.path} builds a GitHub write`).not.toMatch(GITHUB_WRITE_METHOD);
            }
        }
        {
            for (const bundle of [BUNDLE, SERVICE_BUNDLE]) {
                expect(readFileSync(bundle, UTF8), `${bundle} embeds a dispatch token`).not.toMatch(CONCRETE_TOKEN);
            }
        }
    });
});

/* ------------------------------------------------------------------------- *
 * 004 containment (T-014, T-035: AC-133, AC-143, AC-144, AC-151, FR-002,
 * FR-005, FR-053, FR-088, NFR-121)
 *
 * Two halves, because the feature has two ways to fail: the *static* half
 * proves the shipped bytes and the newest modules cannot name the binding
 * field from the panel or smuggle a write or a suppression in, and the
 * *full-cycle* half runs save → refuse → detect → claim → dispatch → audit
 * read against a real loopback service with **all three tiers populated** and
 * then greps every surface for four planted strings — three accepted (one per
 * tier), one refused.
 * ------------------------------------------------------------------------- */

/** The instruction this cycle accepts, plants, and then hunts for. */
const ACCEPTED_PROMPT = 'Reproduce first, then patch. Keep the public API stable.';

/** The credential-shaped value this cycle refuses, and then hunts for everywhere. */
const REFUSED_VALUE = `ghp_${'refuse'.repeat(6)}`;

/** Repository and project the containment binding names, matching the loop fixture. */
const CONTAINMENT_REPOSITORY = 'acme/loop';

/** The binding this cycle saves, in the shape the shipped panel submits. */
function containmentBinding(): Record<string, unknown> {
    return {
        bindingId: 'bnd-containment',
        accountNumericUserId: SCANNED_ACCOUNT_ID,
        accountLogin: SCANNED_LOGIN,
        repository: CONTAINMENT_REPOSITORY,
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'disabled',
        createdAt: SCANNED_STAMP,
        updatedAt: SCANNED_STAMP,
    };
}

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/** One whole-file `PUT /v1/bindings` against the running service. */
async function putBindings(loop: DispatchLoop, binding: Record<string, unknown>): Promise<Response> {
    return await loop.service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ bindings: [binding] }),
    });
}

/** Store-relative path of the account record the containment cycle seeds. */
const CONTAINMENT_ACCOUNT_FILE = `accounts/${SCANNED_ACCOUNT_ID}.json`;

/** One whole-document `PUT /v1/config`, patched over the stored document. */
async function putConfig(loop: DispatchLoop, patch: Readonly<Record<string, unknown>>): Promise<Response> {
    const read = await answerText(loop, CONFIG_PATH);
    const document = (JSON.parse(read) as { readonly config: Record<string, unknown> }).config;

    return await loop.service.call(CONFIG_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ ...document, ...patch }),
    });
}

/** One `PUT /v1/accounts/:numericUserId` profile write against the seeded account. */
function putProfile(loop: DispatchLoop, body: Record<string, unknown>): Promise<Response> {
    return loop.service.call(ACCOUNT_PATH.replace(':numericUserId', () => SCANNED_ACCOUNT_ID), {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(body),
    });
}

/** The instruction the global tier holds for this cycle (004 FR-081). */
const GLOBAL_TIER_PROMPT = 'Name the failing test before proposing any fix.';

/** The instruction the account tier holds for this cycle (004 FR-082). */
const ACCOUNT_TIER_PROMPT = 'Prefer the smallest diff that closes the failing test.';

/**
 * The detection the fixture queue would have written for this issue (003's
 * fixture shape), so the run claims and dispatches exactly as a scanned one.
 */
function containmentDetection(issueNumber: number): EventSnapshot {
    return {
        bindingId: 'bnd-loop',
        repository: CONTAINMENT_REPOSITORY,
        accountNumericUserId: SCANNED_ACCOUNT_ID,
        accountLogin: SCANNED_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${CONTAINMENT_REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assignment fixture',
        detectedAt: SCANNED_STAMP,
    };
}

/**
 * Queue one run whose snapshot stacks **all three stored tiers**.
 *
 * The tiers are read back out of the store files the three saves just wrote
 * and resolved by the production resolver — `service/poll/loop.ts`'s own call
 * — so the snapshot under scan is the one a real detection would compose,
 * not a fixture's hand-built copy (004 FR-080).
 *
 * @throws {Error} When the stored records do not resolve into a three-source snapshot.
 */
async function enqueueThreeTierRun(input: {
    /** Running loop whose store receives the run. */
    readonly loop: DispatchLoop;
    /** Issue the detection is about. */
    readonly issueNumber: number;
    /** Logger the direct queue write reports through; its lines are scanned too. */
    readonly log: ServiceLogger;
}): Promise<void> {
    const { dataDir } = input.loop.service;
    const global = JSON.parse(await readFile(join(dataDir, CONFIG_FILE), UTF8)) as unknown;
    const account = JSON.parse(await readFile(join(dataDir, CONTAINMENT_ACCOUNT_FILE), UTF8)) as unknown;
    const bindings = JSON.parse(await readFile(join(dataDir, BINDINGS_FILE), UTF8)) as readonly unknown[];
    const snapshot = resolvePromptSnapshot({ global, account, binding: bindings[0] });
    if (snapshot === null) {
        throw new Error('the stored tiers resolved into no snapshot at all');
    }

    if (snapshot.sources.length !== 3) {
        throw new Error(`the stored tiers resolved into fewer sources: ${snapshot.sources.join(', ')}`);
    }

    await enqueueEvents({
        store: input.loop.store,
        log: input.log,
        incoming: [createEvent(containmentDetection(input.issueNumber))],
        prompt: snapshot,
    });
}

/** How many times one seeded string appears in a scanned byte string. */
function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

/** One `config.changed` `startingPrompt` entry, as the raw trail carries it. */
interface PromptPair {
    /** Value the row recorded before the change. */
    readonly from: unknown;
    /** Value the row recorded after the change. */
    readonly to: unknown;
}

/**
 * Read one `audit.ndjson` line as the `config.changed` pair for this field.
 *
 * @param line - One raw line of the trail, or `''` for its trailing newline.
 * @returns The line's `from`/`to`, or `null` when the line carries neither.
 */
function promptPairOf(line: string): PromptPair | null {
    if (line === '') {
        return null;
    }

    const row = JSON.parse(line) as { readonly eventType?: unknown; readonly details?: unknown };
    if (row.eventType !== 'config.changed') {
        return null;
    }

    const { details } = row;
    if (typeof details !== 'object' || details === null) {
        return null;
    }

    const { changes } = details as { readonly changes?: unknown };
    if (!Array.isArray(changes)) {
        return null;
    }

    for (const change of changes) {
        if (typeof change !== 'object' || change === null) {
            continue;
        }

        const { field, from, to } = change as {
            readonly field?: unknown;
            readonly from?: unknown;
            readonly to?: unknown;
        };
        if (field === 'startingPrompt') {
            return { from, to };
        }
    }

    return null;
}

/**
 * Every `startingPrompt` pair a `config.changed` row of the raw trail carries.
 *
 * Read from the **file bytes** rather than through a route, so the scan cannot
 * be satisfied by a projection that drops the value it should be judging.
 *
 * @param auditBytes - The exact bytes of `audit.ndjson`.
 * @returns One entry per recorded change, in file order.
 */
function startingPromptPairs(auditBytes: string): readonly PromptPair[] {
    const pairs: PromptPair[] = [];
    for (const line of auditBytes.split('\n')) {
        const pair = promptPairOf(line);
        if (pair !== null) {
            pairs.push(pair);
        }
    }

    return pairs;
}

describe('004 static containment (AC-143, AC-144, FR-002, FR-005)', () => {
    it('reads every 004 module in the static scans', () => {
        {
            const paths = new Set(scanSources().map((file) => file.path));
            for (const module of PROMPT_MODULES) {
                expect(paths.has(module), `${module} was not scanned`).toBe(true);
            }

            // The no-GitHub-write walk covers those same files: nothing 004 adds
            // may reach for GitHub at all, let alone write to it (FR-002).
            const gateways = new Set(GITHUB_GATEWAYS);
            for (const file of scanSources()) {
                if (PROMPT_MODULES.has(file.path)) {
                    expect(gateways.has(file.path), `${file.path} reached GitHub`).toBe(false);
                }
            }
        }
        {
            // This assertion used to read "the panel never even names it": 004
            // shipped no editor, so `startingPrompt` had no business in the IIFE.
            // 005 T-021 is the feature that breaks it **by design** (plan.md X7)
            // — one field in the binding editor — so the bundle now carries the
            // name, and the rule the old assertion stood for has moved to
            // SC-105: `tests/bindings-prompt.test.ts` counts rendered elements
            // across all six tabs and fails at 0 and at 2 alike.
            expect(readFileSync(BUNDLE, UTF8)).toContain('startingPrompt');
            expect(readFileSync(BUNDLE, UTF8)).toContain(
                'Starting prompt for dispatches from this repository',
            );
            // The save boundary is the service, which is exactly where the
            // refusal vocabulary does live.
            expect(readFileSync(SERVICE_BUNDLE, UTF8)).toContain('startingPrompt');
        }
        {
            const sources = scanSources().filter((file) => PROMPT_MODULES.has(file.path));
            expect(sources).toHaveLength(PROMPT_MODULES.size);
            for (const file of sources) {
                const directives = file.text.match(/eslint-disable[^\n]*/gu) ?? [];
                for (const directive of directives) {
                    expect(directive, `${file.path}: \`${directive}\``).toMatch(LINE_SCOPED_DISABLE);
                }
                expect(file.text, `${file.path} escapes the type system`)
                    .not.toMatch(/@ts-ignore|@ts-expect-error|@ts-nocheck|# type: ignore/);
                expect(file.text, `${file.path} uses \`any\``).not.toMatch(/:\s*any\b/);
            }
        }
    });
});

describe('004 full-cycle containment (AC-133, AC-143, AC-151, FR-053, NFR-121)', () => {
    it('holds each accepted tier in exactly two places and a refused value in none', async () => {
        const loop = await startDispatchLoop();
        // Every line the direct queue write produced, scanned with the service's.
        const enqueueLines: string[] = [];
        const enqueueLog = createLogger({ level: 'debug', sink: (line) => void enqueueLines.push(line) });
        try {
            // SAVE — three tiers, three documented paths (FR-081, FR-082, FR-014):
            // the configuration document, the account profile, the whole-file
            // bindings grant.
            await loop.store.writeJson(CONTAINMENT_ACCOUNT_FILE, scannedAccount());
            const savedGlobal = await putConfig(loop, { startingPrompt: GLOBAL_TIER_PROMPT });
            expect(savedGlobal.status).toBe(200);
            const savedAccount = await putProfile(loop, { startingPrompt: ACCOUNT_TIER_PROMPT });
            expect(savedAccount.status).toBe(200);
            const savedBinding = await putBindings(loop, {
                ...containmentBinding(),
                startingPrompt: ACCEPTED_PROMPT,
            });
            expect(savedBinding.status).toBe(200);

            // REFUSE — the same credential-shaped value at **all three** save
            // paths, each naming the shape and never the value, with no part of
            // the submission applied (FR-024, AC-133, AC-150).
            const refusalTexts: string[] = [];
            const refusals = [
                await putBindings(loop, {
                    ...containmentBinding(),
                    startingPrompt: `push ${REFUSED_VALUE} to prod`,
                }),
                await putConfig(loop, { startingPrompt: `push ${REFUSED_VALUE} to prod` }),
                await putProfile(loop, { startingPrompt: `push ${REFUSED_VALUE} to prod` }),
            ];
            for (const response of refusals) {
                expect(response.status).toBe(422);
                const text = await response.text();
                expect(text).toContain('github-token-classic');
                expect(text).not.toContain(REFUSED_VALUE);
                refusalTexts.push(text);
            }

            // DETECT — the run snapshots the three stored tiers at enqueue.
            await enqueueThreeTierRun({ loop, issueNumber: 91, log: enqueueLog });

            // CLAIM + DISPATCH — the panel's own path, one host call.
            const rt = loop.mount();
            await pollRelay(rt);
            await drainVerifications(rt);

            // AUDIT READ — the run's whole trail, over the operator's route.
            const runs = await readRuns(loop.store);
            const run = runs[0];
            if (run === undefined) {
                throw new Error('the scan produced no run');
            }

            const audit = await loop.service.call(
                `${AUDIT_PATH}?correlationId=${encodeURIComponent(run.correlationId)}`,
            );
            expect(audit.status).toBe(200);
            const auditText = await audit.text();

            const { dataDir } = loop.service;
            const auditBytes = await readFile(join(dataDir, AUDIT_FILE), UTF8);
            const surfaces: readonly (readonly [string, string])[] = [
                [CONFIG_FILE, await readFile(join(dataDir, CONFIG_FILE), UTF8)],
                [CONTAINMENT_ACCOUNT_FILE, await readFile(join(dataDir, CONTAINMENT_ACCOUNT_FILE), UTF8)],
                [BINDINGS_FILE, await readFile(join(dataDir, BINDINGS_FILE), UTF8)],
                [RUNS_FILE, await readFile(join(dataDir, RUNS_FILE), UTF8)],
                [EVENTS_FILE, await readFile(join(dataDir, EVENTS_FILE), UTF8)],
                [AUDIT_FILE, auditBytes],
                ['the audit read', auditText],
                ['the panel ledger', JSON.stringify(rt.state.ledger)],
                ['host.storage', JSON.stringify([...loop.panelStorage])],
                ['captured logs', JSON.stringify([...loop.service.logLines, ...enqueueLines])],
                ['toasts and status copy', JSON.stringify(rt.state)],
                ['the three refusals', refusalTexts.join('\n')],
                ['panel bundle', readFileSync(BUNDLE, UTF8)],
                ['service bundle', readFileSync(SERVICE_BUNDLE, UTF8)],
            ];

            // Exactly two persisted places hold each accepted tier: its own
            // store record and the run's composed snapshot (004 FR-053). A
            // third holder — an audit row, a log line, a banner, a bundle —
            // fails here, at 3, as surely as a missing one fails at 1.
            const holdersOf = (seeded: string): readonly string[] => surfaces
                .filter(([, text]) => text.includes(seeded))
                .map(([name]) => name)
                .toSorted(byText);

            expect(holdersOf(GLOBAL_TIER_PROMPT)).toEqual([CONFIG_FILE, RUNS_FILE].toSorted(byText));
            expect(holdersOf(ACCOUNT_TIER_PROMPT)).toEqual([CONTAINMENT_ACCOUNT_FILE, RUNS_FILE].toSorted(byText));
            expect(holdersOf(ACCEPTED_PROMPT)).toEqual([BINDINGS_FILE, RUNS_FILE].toSorted(byText));

            // `audit.ndjson` scanned for the seeded tier text: 0 occurrences
            // of any tier, on any row (FR-053, FR-088, AC-148, AC-151).
            for (const seeded of [GLOBAL_TIER_PROMPT, ACCOUNT_TIER_PROMPT, ACCEPTED_PROMPT]) {
                expect(countOccurrences(auditBytes, seeded), 'audit.ndjson carried a seeded tier')
                    .toBe(0);
            }

            // Every `config.changed` pair this field carries is a fingerprint
            // or `null` — never the text (AC-151, FR-088; 006 FR-071 as amended).
            const pairs = startingPromptPairs(auditBytes);
            expect(pairs.length).toBeGreaterThan(0);
            for (const pair of pairs) {
                expect(String(pair.from), 'a config.changed `from` was not a fingerprint').toMatch(
                    /^(mtp-[0-9a-f]{32}|null)$/,
                );
                expect(String(pair.to), 'a config.changed `to` was not a fingerprint').toMatch(
                    /^(mtp-[0-9a-f]{32}|null)$/,
                );
            }

            // The refused value appears nowhere — including in the refusals.
            for (const [name, text] of surfaces) {
                expect(text, `${name} carried the refused value`).not.toContain(REFUSED_VALUE);
            }
            expect(refusalTexts.join('\n').includes(REFUSED_VALUE)).toBe(false);

            // And no swept surface carries credential-shaped material. The one
            // exception is the file a credential *belongs* to (invariant 9: a
            // PAT lives in the account record and nowhere else) — it is still
            // scanned above for the refused value and every tier's text.
            const swept = surfaces.filter(([name]) => name !== CONTAINMENT_ACCOUNT_FILE);
            for (const [name, text] of swept) {
                expect(findSecretLeak(text), `${name} carried credential material`).toBeNull();
            }
            expect(findSecretLeak(swept.map(([, text]) => text).join('\n'))).toBeNull();
        } finally {
            await loop.shutdown();
        }
    });
});

describe('004 the field is documented, and the editor it points at is the shipped one (FR-062, FR-074)', () => {
    /**
     * The two site pages that now own the field's documentation, and why each.
     *
     * 007 FR-049 made the published site authoritative and moved the prose there:
     * the configure page owns the starting prompt itself — its three tiers, the
     * field each tier is set on, and every guarantee the validator enforces —
     * while the debug page owns the store inventory, so `bindings.json` is named
     * there and not on the page about configuration. Each is asserted once,
     * against the page that owns it: asserting both pages for both facts would
     * be the second home FR-049 forbids.
     */
    const PROMPT_PAGE = 'site/src/pages/configure.astro';
    const STORE_PAGE = 'site/src/pages/debug.astro';
    const pages: readonly string[] = [PROMPT_PAGE, STORE_PAGE];

    it('states the set path, the cap, the literal rule, the refusal, and the pinned agent', () => {
        {
            const text = readFileSync(resolve(ROOT, PROMPT_PAGE), UTF8);

            expect(text, `${PROMPT_PAGE} names the member`).toContain('startingPrompt');
            expect(text, `${PROMPT_PAGE} names the cap`).toContain('2,000');
            expect(text, `${PROMPT_PAGE} promises literal text`).toContain('literal');
            // 004 FR-024: a refused value is refused by name and never stored, so
            // the page has to say so — the cycle's whole containment claim.
            expect(text, `${PROMPT_PAGE} does not state the credential refusal`).toContain(
                'A credential-shaped value is refused, not stored',
            );
            // The other half of the pinned agent: the field is operator text and
            // cannot select the agent, so the session runs the pinned default.
            expect(text, `${PROMPT_PAGE} does not say the prompt cannot select an agent`).toContain(
                'It cannot select an agent',
            );
        }
        {
            const text = readFileSync(resolve(ROOT, STORE_PAGE), UTF8);

            expect(text, `${STORE_PAGE} names the store file`).toContain('bindings.json');
        }
        {
            for (const page of pages) {
                const text = readFileSync(resolve(ROOT, page), UTF8);

                // 004 shipped no editor in its own window; 005 T-021 shipped the
                // binding editor's starting-prompt field, so the cycle's promise
                // ("no editor yet") is history and the page that owns the field
                // must say where it lives instead of forecasting it.
                expect(text, `${page} still forecasts an editor`).not.toMatch(
                    /no editor for this field yet|Until the panel grows a field/,
                );
                expect(text, `${page} points at a retired spec path`).not.toContain('specs/001');
            }
        }
    });
});

/* ------------------------------------------------------------------------- *
 * T-032 one rendering per tier value, in the shipped bytes and the sources
 * (004 FR-089; 005 FR-051, SC-105, AC-123)
 *
 * The runtime half of the gate lives in `tests/bindings-prompt.test.ts`,
 * which renders all six tabs and counts the elements carrying each tier's
 * sentinel. This is the static half: the three sites FR-089 permits are the
 * sites that exist — no fourth hand-authored field, and the projected row's
 * guidance with exactly one author so it can render exactly once.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * T-034 the documentation site's own output joins the secret scan
 * (007 FR-054, NFR-005)
 *
 * Invariant 9 says a credential lives in the service store and nowhere else, and
 * that a redaction refusal blocks the write rather than logging through it. The
 * site is a third shipped artefact — its pages are what an operator reads, and
 * they are generated from the same declarations — so FR-054 puts its sources
 * and its build output under *the same patterns the repository applies to its
 * committed bundles*. The bundle's own assertions are unchanged: the scan gains a
 * path, never an exemption.
 *
 * Two things about the shape of this scan are load-bearing.
 *
 * **The output is conditional; the sources are not.** `site/dist/` is gitignored
 * (FR-071) and is produced by `cd site && npm run build`, which the root gate
 * does not and must not run (FR-070: the root verification command must not
 * lint, type-check or build the site). So the output scan runs wherever a build
 * has been run — locally after `npm run build` in `site/`, and in the site's own
 * CI job, which is the gate that builds it — and is skipped where one has not.
 * The `git ls-files` assertion below is what keeps that honest: nothing under the
 * output is committed, so a leak can never hide in a file the skip would miss.
 * The sources, which are committed and are what the output is generated from, are
 * scanned on every run.
 *
 * **The off-origin check is a check on positions, not on hosts.** The footer's
 * links into the repository are off-origin by necessity — the site publishes no
 * copy of the licence (plan D8) and AC-005 requires the link — so a scan that
 * flagged every off-origin URL would be flagging a requirement. `<a href>` is
 * therefore not a resource-loading position: a hyperlink a reader may choose to
 * follow is not a request the page makes. The positions below are the same list,
 * and the same distinction, as `site/scripts/assert-build.mjs` uses.
 * ------------------------------------------------------------------------- */

/** The site's sources: committed, and what the build output is generated from. */
const SITE_SRC = 'site/src';

/** The site's build output: gitignored, and produced by the site's own gate. */
const SITE_DIST = 'site/dist';

/** The site's declared canonical origin, read out of its one configuration file. */
const SITE_CONFIG = 'site/astro.config.ts';

/**
 * Attribute positions whose value the browser fetches or executes (FR-010,
 * NFR-003). `<a href>` is absent by design — see this block's note.
 */
const RESOURCE_POSITIONS: readonly { readonly tag: string; readonly attribute: string }[] = [
    { tag: 'img', attribute: 'src' },
    { tag: 'image', attribute: 'href' },
    { tag: 'image', attribute: 'xlink:href' },
    { tag: 'script', attribute: 'src' },
    { tag: 'iframe', attribute: 'src' },
    { tag: 'embed', attribute: 'src' },
    { tag: 'object', attribute: 'data' },
    { tag: 'input', attribute: 'src' },
    { tag: 'source', attribute: 'src' },
    { tag: 'track', attribute: 'src' },
    { tag: 'video', attribute: 'src' },
    { tag: 'video', attribute: 'poster' },
    { tag: 'audio', attribute: 'src' },
    { tag: 'use', attribute: 'href' },
    { tag: 'link', attribute: 'href' },
    // `base` fetches nothing itself, and is here for the reason
    // `site/scripts/assert-build.mjs` gives: a `<base href>` re-bases every *relative* URL
    // on the page, so the request it causes is made under whatever origin it names. That is
    // the shape NFR-003 forbids, it is reachable from a build that stays otherwise green,
    // and a position list that omitted it lets a page point its own stylesheet, font, and
    // script at a third-party host by changing one attribute.
    //
    // `style` is the second such entry, and it is handled rather than listed: a `style`
    // attribute is a stylesheet body, so it is routed through `stylesheetUrls` below —
    // which is what catches `style="background:url(https://…)"`. Listing it here would read
    // the value as a bare URL and miss every `url()` inside it.
    { tag: 'base', attribute: 'href' },
];

/** Schemes that carry their content inline rather than naming a file to fetch. */
const INLINE_SCHEMES: ReadonlySet<string> = new Set(['data:', 'blob:', 'about:']);

/** A `url()` reference in a stylesheet body, in single, double, or bare spelling. */
const STYLESHEET_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;

/** An `@import` target, which fetches without a `url()` wrapper. */
const IMPORT_TARGET = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'";\s]+))\s*\)|"([^"]*)"|'([^']*)')/gi;

/**
 * Every resource a stylesheet body names, whether it is the whole body or a `url()` or an
 * `@import` inside it.
 *
 * Three spellings because CSS has three: `url(…)`, `url("…")`, `url('…')`. The unquoted form
 * cannot contain a closing paren, so the run stops at one — which is the CSS spec's own
 * grammar, not a shortcut.
 *
 * @param css - A stylesheet body, whether a `<style>` block or a `style` attribute.
 * @returns Each referenced URL, as authored.
 */
function stylesheetUrls(css: string): readonly string[] {
    const found = [...css.matchAll(STYLESHEET_URL)].map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim());
    // Only the bare-string `@import` form is read here: `@import url(…)` *is* a `url()` in a
    // declaration and was already found above, so reading it again would report one
    // reference twice. Deduplicated, because a finding's count is part of what it says.
    const imports = [...css.matchAll(IMPORT_TARGET)]
        .map((match) => (match[4] ?? match[5] ?? '').trim())
        .filter((url) => url !== '');

    return [...new Set([...found, ...imports].filter((url) => url !== ''))];
}

/**
 * The URL a `<meta http-equiv="refresh">` navigates to, or the empty string when it only
 * re-renders the page it is on.
 *
 * Read out of the `content` value rather than treating it as a URL: `0;url=https://evil.example/`
 * is a *delay* followed by a target, and handing the whole value to `new URL()` would resolve
 * it as a relative path — back onto the site's own origin, where it passes as an internal
 * reference. That is why a meta refresh is handled rather than added to `RESOURCE_POSITIONS`.
 *
 * **Treated as a resource reference, not ignored.** It is the one navigation a page performs
 * with no reader's click in it, which makes it a reference the page itself makes — the shape
 * NFR-003 forbids rather than the shape it exempts (`<a href>`, a hyperlink the reader may
 * choose to follow).
 *
 * @param content - A refresh `content` value.
 * @returns The target URL, or the empty string when there is none.
 */
function refreshTarget(content: string): string {
    const found = /(?:^|[;,])\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,]+))/i.exec(content);

    return found?.[1] ?? found?.[2] ?? found?.[3] ?? '';
}

/** One element read out of a page's markup. */
interface MarkupElement {
    /** The element's name, lower-cased. */
    readonly tag: string;
    /** Its attribute values, keyed by lower-cased attribute name. */
    readonly attributes: Map<string, string>;
}

/**
 * Two scanners, both of which have a nested unbounded quantifier — the shape
 * `security/detect-unsafe-regex` exists for, whose failure mode is catastrophic
 * backtracking **on a request body**. Neither ever sees a request body: the input
 * is `astro build`'s own output on this repository, written by the site's own
 * build and read back in the same run. The unnested spelling of either one would be
 * worse than the warning rather than better — a `>` inside a quoted attribute value
 * would end the tag run early and silently drop a resource reference from the scan,
 * which is the false *accept* a gate must never buy.
 */

/** An opening tag: the name, then the attribute run. Quoted runs are matched whole. */
// eslint-disable-next-line security/detect-unsafe-regex -- nested quantifier; the input is a build artifact
const OPENING_TAG = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** One attribute inside an opening tag, with quoted, single-quoted and bare values. */
// eslint-disable-next-line security/detect-unsafe-regex -- nested quantifier; the input is a build artifact
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

/** A URL scheme at the start of a value. */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Every element in a document, in document order, with its attributes read.
 *
 * The emitted HTML is flat and minified and the Node standard library has no DOM
 * parser, so a tolerant tag scanner is what these checks read through — the same
 * reading `site/scripts/assert-build.mjs` makes and the reason it needs one.
 *
 * @param html - A page's markup.
 * @returns Every element, in document order.
 */
function resourceElements(html: string): readonly MarkupElement[] {
    return [...html.matchAll(OPENING_TAG)].map((match) => {
        const attributes = new Map<string, string>();
        const authored = (match[2] ?? '').matchAll(ATTRIBUTE);
        for (const attribute of authored) {
            attributes.set(attribute[1]?.toLowerCase() ?? '', attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        }

        return { tag: (match[1] ?? '').toLowerCase(), attributes };
    });
}

/**
 * Classify one resource-loading value.
 *
 * @param raw - The attribute value as authored.
 * @param origin - The site's declared canonical origin.
 * @returns `null` when the value makes no request — empty, a same-document
 *   fragment, or an inline `data:`/`blob:`/`about:` value — the origin it
 *   resolves to otherwise, or the empty string when it resolves to nothing.
 */
function referenceOrigin(raw: string, origin: string): string | null {
    const value = raw.trim();
    if (value === '' || value.startsWith('#')) {
        return null;
    }
    const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
    if (scheme !== undefined && INLINE_SCHEMES.has(`${scheme}:`)) {
        return null;
    }

    // A relative reference resolves against the site's own origin, so only an
    // absolute one can leave it.
    try {
        return new URL(value, `${origin}/`).origin;
    } catch {
        return '';
    }
}

/**
 * Every resource-loading reference in one page's markup that leaves the site's own origin.
 *
 * @param html - The page's markup.
 * @param origin - The site's declared canonical origin.
 * @returns Each off-origin reference, as the element and attribute it was written on.
 */
/** One reference read off an element, with the text a finding should name it by. */
interface NamedReference {
    /** How the reference is written in a finding. */
    readonly label: string;
    /** The reference as authored, to resolve. */
    readonly url: string;
}

/**
 * Every reference one element makes that is **not** a resource-loading attribute's whole
 * value, read as the CSS body or the `delay;url=target` pair that it actually is.
 *
 * Split out of `offOriginResources` because these two shapes are why the position list was
 * not enough, and putting them beside the loop that reads the list made the function a
 * branch tangle. Each is a *shape*, not a position:
 *
 * - **A `style` attribute** is a stylesheet body, so `url()` in it is a request — and the URL
 *   is not the attribute's whole value, which is why no entry in `RESOURCE_POSITIONS` can see
 *   it. `style="background:url(https://cdn.example/a.gif)"` is the case.
 * - **A meta refresh** is a delay followed by a target, read out of `content` rather than
 *   treated as a URL: handing `0;url=https://evil.example/` to `new URL()` resolves it as a
 *   relative path, back onto the site's own origin, where it passes as an internal reference.
 *   It is reported rather than ignored because it is the one navigation a page performs with
 *   no reader's click in it — the shape NFR-003 forbids rather than the shape it exempts
 *   (`<a href>`, a hyperlink the reader may choose to follow).
 *
 * @param element - One element from the page.
 * @returns Every reference it makes, in document order.
 */
function attributeReferences(element: MarkupElement): readonly NamedReference[] {
    const found: NamedReference[] = [];
    const style = element.attributes.get('style');

    if (style !== undefined) {
        for (const url of stylesheetUrls(style)) {
            found.push({ label: `<${element.tag} style="…${url}…">`, url });
        }
    }
    if (
        element.tag === 'meta' &&
        (element.attributes.get('http-equiv') ?? '').trim().toLowerCase() === 'refresh'
    ) {
        const target = refreshTarget(element.attributes.get('content') ?? '');
        if (target !== '') {
            found.push({ label: `<meta http-equiv="refresh" content="…${target}…">`, url: target });
        }
    }

    return found;
}

function offOriginResources(html: string, origin: string): readonly string[] {
    const found: string[] = [];
    const elements = resourceElements(html);

    /**
     * Report one reference, if it leaves the site's own origin.
     *
     * @param label - How the reference is named in the finding.
     * @param raw - The reference as authored.
     */
    const report = (label: string, raw: string): void => {
        const resolved = referenceOrigin(raw, origin);
        if (resolved === null || resolved === origin) {
            return;
        }
        found.push(resolved === '' ? `${label} is not a resolvable URL` : `${label} resolves to ${resolved}`);
    };

    for (const element of elements) {
        for (const position of RESOURCE_POSITIONS) {
            const raw = element.tag === position.tag ? element.attributes.get(position.attribute) : undefined;
            if (raw !== undefined) {
                report(`<${element.tag} ${position.attribute}="${raw}">`, raw);
            }
        }
        for (const reference of attributeReferences(element)) {
            report(reference.label, reference.url);
        }
    }

    // `<style>` bodies, read past their opening tag to their closing one. Scanned here as
    // well as by the site's own gate: this scan reads `dist/` when a build has run, and the
    // whole of T-034 is that the repository applies the same patterns to the site's output
    // as to its committed bundles.
    const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];

    for (const block of blocks) {
        const urls = stylesheetUrls(block[1] ?? '');

        for (const url of urls) {
            report(`<style> …${url}…`, url);
        }
    }

    return found;
}


/**
 * Drop the list item that names a credential's shape — the one thing a site
 * surface may *name*.
 *
 * `findSecretLeak`'s `authorization-header` pattern is
 * `\bAuthorization\s*[:=]\s*["']?\S+` — any non-space run after the header name —
 * so the configure page's list item, which has to tell the reader that "a value
 * shaped like a token, an `Authorization:` header, or a bearer credential" is
 * refused rather than stored (007 FR-034, 004 FR-024), trips it. That is the
 * documentation of a refusal rather than a credential, and stating it is not
 * optional, so the item is cut before the shape patterns run.
 *
 * The cut is a **rule** on the item, not a literal of the sentence: an item that
 * names the header is exempted wherever one is written, and the assertion beside
 * it holds the sentence that item must carry on the page that owes it — so a page
 * that stopped documenting the refusal fails there rather than quietly widening
 * the exemption here. The token patterns are not exempt at all; `ghp_…` is not
 * something a page can say about a refusal.
 *
 * @param text - A surface's text.
 * @returns The same text with every such item removed.
 */
function cutDocumentedShapeItems(text: string): string {
    return text
        .split('</li>')
        .filter((item) => !item.includes('Authorization:'))
        .join('</li>');
}

/**
 * Every file under a repository-relative directory, as a `path`/`text` pair.
 *
 * @param dir - Repository-relative directory, which may be absent.
 * @returns One pair per file, sorted by path; empty when the directory is absent.
 */
function readTree(dir: string): readonly (readonly [string, string])[] {
    const root = resolve(ROOT, dir);
    if (!existsSync(root)) {
        return [];
    }

    return readdirSync(root, { recursive: true })
        .map(String)
        .filter((entry) => statSync(resolve(root, entry)).isFile())
        .toSorted(byText)
        .map((entry) => [`${dir}/${entry}`, readFileSync(resolve(root, entry), UTF8)]);
}

/**
 * The origin the site publishes under, read out of the file that declares it.
 *
 * Read rather than written here, for the reason `site/scripts/assert-build.mjs`
 * gives: FR-005 and AC-002 declare the origin in exactly one file, and a second
 * copy in a gate is the rename bug inside the gate that exists to catch it.
 *
 * @returns The origin, scheme and host, without a trailing slash.
 */
function declaredSiteOrigin(): string {
    const config = readFileSync(resolve(ROOT, SITE_CONFIG), UTF8);
    const declared = /^\s*site:\s*'([^']+)'/m.exec(config)?.[1];

    if (declared === undefined) {
        throw new Error(`${SITE_CONFIG} declares no canonical \`site:\` origin to compare against`);
    }

    return new URL(declared).origin;
}

/**
 * Assert that no site surface carries credential material.
 *
 * @param surfaces - The `path`/`text` pairs to scan, read from the site's sources or its output.
 */
function expectNoCredentialMaterial(surfaces: readonly (readonly [string, string])[]): void {
    for (const [name, text] of surfaces) {
        // The token shapes carry no exemption at all: `ghp_…` is not something a
        // page can say about a refusal.
        for (const pattern of TOKEN_PATTERNS) {
            expect(text, `${name} matched ${pattern.source}`).not.toMatch(pattern);
        }
        // The shape patterns run on the surface with the one documented refusal
        // cut out — see `cutDocumentedShapeItems`.
        expect(findSecretLeak(cutDocumentedShapeItems(text)), `${name} carried credential material`).toBeNull();
    }
}

describe('T-034 the site ships no credential material (FR-054, NFR-005)', () => {
    it('scans the site sources on every run, and the scan bites', () => {
        {
            const surfaces = readTree(SITE_SRC);

            expect(surfaces.length, 'no site source was read').toBeGreaterThan(10);
            expectNoCredentialMaterial(surfaces);
        }
        {
            // The cut is not a hole in the scan: the page that owes the sentence
            // still carries it, and a credential planted beside it is still found.
            const configure = readFileSync(resolve(ROOT, 'site/src/pages/configure.astro'), UTF8);

            expect(configure, 'the configure page no longer names the header shape it refuses')
                .toContain('<code>Authorization:</code> header');
            expect(findSecretLeak(cutDocumentedShapeItems(configure)), 'the cut is wider than the sentence')
                .toBeNull();
            // A token inside the exempted item is still a token: the token patterns have
            // no exemption at all, so this proves the cut is not what catches it.
            const inTheItem = `<li>Authorization: ${REGISTERED_PAT}</li>`;

            expect(findSecretLeak(inTheItem), 'the cut hides a planted token').toBe('github-token-classic');
            expect(TOKEN_PATTERNS.some((pattern) => pattern.test(inTheItem))).toBe(true);
            // The cut exempts an item that *names* the header and nothing beside
            // it: a second item in the same list keeps its planted token.
            const beside = `<li>Authorization: a header</li><li>the token is ${REGISTERED_PAT}</li>`;

            expect(findSecretLeak(cutDocumentedShapeItems(beside)), 'the cut reached past its own item')
                .toBe('github-token-classic');
        }
        {
            // Not vacuous: the same detectors, on the very credential the
            // containment cycle above registers in the store. A planted PAT that
            // none of them caught would make every assertion beside it a
            // decoration. `findSecretLeak` reports the first matching label in its
            // own order, so the GitHub shapes are reported ahead of the transport
            // one — hence the separate, non-token value below for that label.
            expect(findSecretLeak(`Authorization: ${REGISTERED_PAT}`)).toBe('github-token-classic');
            expect(TOKEN_PATTERNS.some((pattern) => pattern.test(REGISTERED_PAT))).toBe(true);
            expect(findSecretLeak(REGISTERED_PAT)).toBe('github-token-classic');
            expect(findSecretLeak('Authorization: some-header-value')).toBe('authorization-header');
        }
    });

    it('covers the build output when a build has run, and nothing under it is committed', () => {
        {
            // What makes the skip below honest rather than a silent pass.
            const tracked = execFileSync('git', ['ls-files', SITE_DIST], { cwd: ROOT, encoding: UTF8 }).trim();

            expect(tracked, `${SITE_DIST} is committed, so its scan must not be conditional`).toBe('');
        }
        {
            if (!existsSync(resolve(ROOT, SITE_DIST))) {
                // No build has been run here. The root gate does not build the
                // site (FR-070); the site's own gate does, and there the scan
                // runs. The sources test above is the one that always runs.
                expect(existsSync(SITE_CONFIG)).toBe(true);

                return;
            }
        }
        {
            const surfaces = readTree(SITE_DIST);

            expect(surfaces.length, 'the output directory exists but the build emitted no file').toBeGreaterThan(0);
            expectNoCredentialMaterial(surfaces);
        }
        {
            // FR-010 and NFR-003: a page view fetches from the site's own origin
            // only. The positions are resource-loading ones, so the footer's
            // off-origin links into the repository are not in scope — and the
            // next assertion proves they are present, so this cannot pass by
            // having stopped reading them.
            const origin = declaredSiteOrigin();
            const pages = readTree(SITE_DIST).filter(([name]) => name.endsWith('.html'));

            expect(pages.length, 'the build emitted no HTML page').toBeGreaterThan(0);
            for (const [name, text] of pages) {
                expect(offOriginResources(text, origin), `${name} fetches off-origin`).toEqual([]);
                expect(text, `${name} links the licence in the repository`).toContain('<a href="https://github.com/');
            }

            // Not vacuous, on the other side of the distinction too: the same
            // reader, pointed at a real resource-loading position, does report
            // the off-origin reference — so it is the *position* list that
            // exempts the footer's hyperlink, not a scan that cannot see it.
            const planted = offOriginResources('<link href="https://fonts.example/style.css">', origin);

            expect(planted).toHaveLength(1);
            expect(planted[0]).toContain('fonts.example');
            expect(offOriginResources('<a href="https://github.com/o/r/blob/main/LICENSE">', origin)).toEqual([]);
        }
    });

    it('catches the three resource references no attribute-value scan can see', () => {
        // **The gap this closes, as a test rather than a claim.** All three shapes name a
        // resource without putting it in the value of a resource-loading attribute, so the
        // position list above reported nothing for every one of them. Each is checked in
        // both directions — refused here, accepted on its own-origin spelling — so a case
        // cannot pass because the reader stopped working altogether, which is the other way
        // this scan could go green.
        const origin = declaredSiteOrigin();
        const cases: readonly (readonly [string, string, string])[] = [
            // A `style` attribute is a stylesheet body, so `url()` in it is a request, and
            // the URL is not the attribute's whole value.
            ['a remote image in a `style` attribute', '<div style="background:url(https://cdn.example/a.gif)">x</div>', 'cdn.example'],
            // A `<base href>` fetches nothing, and re-bases every relative URL on the page.
            ['a base element pointing at another origin', '<base href="https://cdn.example/">', 'cdn.example'],
            // A meta refresh is a navigation with no reader's click in it.
            ['a meta refresh to another origin', '<meta http-equiv="refresh" content="0;url=https://evil.example/">', 'evil.example'],
        ];

        for (const [name, markup, host] of cases) {
            const found = offOriginResources(markup, origin);

            expect(found, `${name} was not reported`).toHaveLength(1);
            expect(found[0], `${name} named the wrong host`).toContain(host);
            // And the same shape, same-origin, is not a finding — so a case cannot pass
            // because the reader stopped working altogether.
            const sameOrigin = markup.replace(host, 'shaunburdick.github.io');

            expect(offOriginResources(sameOrigin, origin), `${name} refused its own-origin spelling`).toEqual([]);
        }
        // The `style` scan is a *stylesheet* reader, not a substring search: the three CSS
        // spellings of `url()` and the `@import` form are all references, and none is
        // reported twice.
        for (const spelling of [
            'url(https://cdn.example/a.gif)',
            'url("https://cdn.example/a.gif")',
            'url(\'https://cdn.example/a.gif\')',
            '@import url(https://cdn.example/a.css)',
            '@import "https://cdn.example/a.css"',
            'background:#fff url(https://cdn.example/a.gif) no-repeat',
        ]) {
            const found = offOriginResources(`<style>a{${spelling}}</style>`, origin);

            expect(found, spelling).toHaveLength(1);
            expect(found[0] ?? '', spelling).toContain('cdn.example');
        }
        // A `data:` value is inline content, not a fetch — the same exemption the
        // position scan makes, so the two do not disagree about it.
        const inline = '<div style="background:url(data:image/gif;base64,R0lGOD)">x</div>';

        expect(offOriginResources(inline, origin)).toEqual([]);
    });
});

describe('T-032 the three permitted tier sites are the only sites (005 FR-051, AC-123)', () => {
    it('ships the binding field and bakes no second author of the guidance', () => {
        {
            const bundle = readFileSync(BUNDLE, UTF8);

            expect(bundle).toContain('Starting prompt for dispatches from this repository');
            // The global tier's guidance is the service's own `format`
            // prose, read off `GET /v1/config` and rendered as text (006
            // FR-014, 004 research R-4) — so it is authored once, on the
            // wire, and a panel-side copy of that sentence would be the
            // second author this rule exists to prevent.
            expect(bundle).not.toContain('text sent to the agent verbatim');
            expect(readFileSync(SERVICE_BUNDLE, UTF8)).toContain('text sent to the agent verbatim');
        }
        {
            const labelled = scanSources()
                .filter((file) => file.path.startsWith('src/'))
                .filter((file) => file.text.includes('Starting prompt for dispatches from'))
                .map((file) => file.path)
                .toSorted(byText);

            expect(labelled).toEqual(['src/accounts-rows.ts', 'src/bindings-prompt.ts']);
            const account = scanSources().find((file) => file.path === 'src/accounts-rows.ts');
            expect(account?.text).toContain('Starting prompt for dispatches from this account');
        }
        {
            // Settings is the projected site: its row's label is composed
            // from `descriptor.name`, so the global tier has no hand-authored
            // label anywhere — a fourth site cannot hide behind this file's
            // own copy, and the row that renders arrives with the projection.
            const settings = scanSources().find((file) => file.path === 'src/settings-rows.ts');

            expect(settings?.text).toMatch(/\$\{descriptor\.name\} \(\$\{unit\}\) —/);
        }
    });
});

/* ------------------------------------------------------------------------- *
 * 006 Settings surface and offline posture (T-028: FR-085, FR-086, NFR-102,
 * AC-144, AC-145, SC-112)
 *
 * The scans above prove the shipped bytes are clean in general; these two
 * groups are 006's own halves: the edit surface actually reached the bundle
 * (invariant 1 — a green suite over sources that never shipped would prove
 * nothing), and the suite that claims to run offline really does.
 * ------------------------------------------------------------------------- */

/** Fragments present only when the Settings edit surface was bundled. */
const SETTINGS_MARKERS: readonly string[] = [
    'Save configuration',
    'deletes history',
    'service not running — settings read-only',
    'did not reach the trail',
    'config.changed',
];

/** A literal bearer credential, which no shipped artifact may embed. */
const BEARER_LITERAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/;

/** Third-party HTTP clients an offline suite must never import. */
const HTTP_CLIENT_IMPORT = /\bfrom ['"](axios|node-fetch|got|undici|superagent|request)['"]/;

/**
 * A `fetch(` **call** — not the string a scan of its own source necessarily
 * contains, which is why the quote characters are excluded from the prefix.
 */
const FETCH_CALL = /(^|[^A-Za-z0-9_.'"`])fetch\s*\(/;

/**
 * Where an offline test may fetch: every alternative is a locally bound
 * address — the service double's own base URL, the `127.0.0.1` fixtures, and
 * `nonLoopbackAddress()`, which the refusal case proves does *not* answer.
 */
const LOCAL_FETCH_TARGET = /(baseUrl|\$\{origin\}|\$\{HOST\}|\$\{external\})/;

/**
 * A credential read out of the process environment.
 *
 * The suite deliberately **plants** token-shaped strings to prove they are
 * redacted; what AC-144 rules out is a *real* credential being required, and
 * a developer's own token can only enter through the environment.
 */
const CREDENTIAL_ENV = /\bprocess\.env\.[A-Z_]*(TOKEN|PAT|SECRET|PASSWORD|API_KEY)\b/;

/**
 * Every `.ts` file under `tests/`, path and text.
 *
 * @returns The modules, in directory order.
 */
function testModules(): readonly ScannedFile[] {
    const entries = readdirSync(resolve(ROOT, 'tests'), { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.ts'))
        .toSorted(byText);

    return entries.map((entry) => ({
        path: `tests/${entry}`,
        text: readFileSync(resolve(ROOT, 'tests', entry), UTF8),
    }));
}

/**
 * The lines of a file that are not comments — the offline scan is about what
 * a test *does*, so a doc comment that names a URL is not a request.
 *
 * @returns The code lines, trimmed.
 */
function codeLinesOf(text: string): readonly string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^(\/\/|\/?\*)/.test(line));
}

describe('006 the Settings edit surface ships in the panel bundle (T-028, invariant 1)', () => {
    it('carries the confirmation, the failure causes, and the audit warning', () => {
        {
            const bundle = readFileSync(BUNDLE, UTF8);

            for (const marker of SETTINGS_MARKERS) {
                expect(bundle, `panel/main.js does not carry ${marker}`).toContain(marker);
            }
        }
        {
            for (const bundle of [BUNDLE, SERVICE_BUNDLE]) {
                const text = readFileSync(bundle, UTF8);
                for (const pattern of TOKEN_PATTERNS) {
                    expect(text, `${bundle} carries a token shape`).not.toMatch(pattern);
                }

                expect(text, `${bundle} embeds a bearer literal`).not.toMatch(BEARER_LITERAL);
            }
        }
    });
});

describe('006 the suite runs offline (T-028, AC-144, SC-112)', () => {
    it('reads every test module rather than a sample', () => {
        {
            const files = testModules();

            expect(files.length).toBeGreaterThan(90);
            expect(files.some((file) => file.path === 'tests/support/service.ts')).toBe(true);
        }
        {
            const offenders: string[] = [];
            for (const file of testModules()) {
                for (const line of codeLinesOf(file.text)) {
                    if (!FETCH_CALL.test(line) || LOCAL_FETCH_TARGET.test(line)) {
                        continue;
                    }

                    offenders.push(`${file.path}: ${line}`);
                }
            }

            expect(offenders).toEqual([]);
        }
        {
            const importers = testModules()
                .filter((file) => HTTP_CLIENT_IMPORT.test(file.text))
                .map((file) => file.path);

            expect(importers).toEqual([]);
        }
        {
            const readers = testModules()
                .filter((file) => codeLinesOf(file.text).some((line) => CREDENTIAL_ENV.test(line)))
                .map((file) => file.path);

            expect(readers).toEqual([]);
        }
    });
});

/* ------------------------------------------------------------------------- *
 * 003 v1.8.0 — the NFR-113 containment scan, and the one-comparison scan
 * (002 NFR-113, plan D9, D13; 003 AC-132)
 *
 * The **permitted set** is configuration; a copy of it in a file retained for
 * months, or in a bundle an operator can read, is a liability rather than an
 * audit aid. This is the scan that keeps that true: a real gate refusal is driven
 * end to end under a populated list, and every surface the build can write is
 * then grepped for a login that list permits.
 *
 * The fixture's permitted set is **disjoint** from every actor the run names
 * (plan B.5 item 3), which is what makes the zero meaningful: the run's own
 * denial names {@link SCANNED_DENIED}, so a second occurrence of *that* string
 * anywhere would be a real leak rather than the expected denial.
 * ------------------------------------------------------------------------- */

/** The login the scan's binding permits; it may appear only in `bindings.json`. */
const SCANNED_PERMITTED = 'permitted-operator';

/** The login the scan's denied actor uses; the refusal row may name it (FR-077). */
const SCANNED_DENIED = 'stranger-account';

/**
 * The scan's binding: the loop's own, active, with a populated allow-list.
 *
 * The mount installs the loop's binding as active, so the panel's own binding
 * guard must pass for the gate to be reached at all; and the scan needs the list
 * **populated**, which is the state that could leak.
 *
 * @returns The row the whole-file grant submits.
 */
function permitOnlyBinding(): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: SCANNED_ACCOUNT_ID,
        accountLogin: SCANNED_LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        triggers: { assignment: true, mention: true, reviewRequest: false },
        state: 'active',
        createdAt: SCANNED_STAMP,
        updatedAt: SCANNED_STAMP,
        allowedUsers: [SCANNED_PERMITTED],
    };
}

/** Write the scan's populated-allow-list binding through the real grant. */
async function permitOnly(loop: DispatchLoop): Promise<void> {
    const put = await loop.service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ bindings: [permitOnlyBinding()] }),
    });
    if (put.status !== 200) {
        throw new Error(`the scan binding did not save: ${put.status}`);
    }
}

describe('003 v1.8.0 no permitted login reaches any surface (NFR-113, AC-132)', () => {
    it('drives a real refusal and finds the permitted set nowhere but its own store file', async () => {
        const scanLogLines: string[] = [];
        const loop = await startDispatchLoop();
        try {
            await loop.store.writeJson(CONTAINMENT_ACCOUNT_FILE, scannedAccount());
            await permitOnly(loop);
            // The one detection the scan drives, attributed to an actor the list
            // does **not** permit — so the gate refuses, and a copy of the
            // permitted login in any surface would be this feature leaking.
            //
            // It names the **loop's own** binding, because the mount's binding
            // guard runs before the reserve: a run naming any other binding would
            // be parked as `binding-missing` and the gate never reached.
            await enqueueEvents({
                store: loop.store,
                // The queue's own logger lines are scanned below; this sink keeps
                // them out of the test output the way the harness's does.
                log: createLogger({ level: 'error', sink: (line) => void scanLogLines.push(line) }),
                incoming: [createEvent({
                    ...containmentDetection(SCANNED_ISSUE),
                    bindingId: BINDING_ID,
                    actorLogin: SCANNED_DENIED,
                    actorAttribution: 'subject-author',
                })],
            });

            const rt = loop.mount();
            await pollRelay(rt);

            // The gate refused, and the panel reported it through the existing
            // block report: the run is parked, and no session was started.
            expect(loop.sessions).toEqual([]);
            const runs = await readRuns(loop.store);
            const run = runs[0];
            if (run === undefined) {
                throw new Error('the scan produced no run');
            }

            expect(run.state).toBe('blocked:actor-not-allowed');
            // The refusal names the **denied** login and never the permitted one
            // (FR-077): a denial nobody can attribute is not an explainable
            // denial, but a copy of the *policy* is the liability NFR-113 names.
            const trail = await answerText(
                loop,
                `${AUDIT_PATH}?correlationId=${encodeURIComponent(run.correlationId)}`,
            );
            expect(trail).toContain(SCANNED_DENIED);
            expect(trail).not.toContain(SCANNED_PERMITTED);

            const { dataDir } = loop.service;
            const auditBytes = await readFile(join(dataDir, AUDIT_FILE), UTF8);
            const surfaces: readonly (readonly [string, string])[] = [
                [RUNS_FILE, await readFile(join(dataDir, RUNS_FILE), UTF8)],
                [AUDIT_FILE, auditBytes],
                ['the run history projection', await answerText(loop, EVENTS_PATH)],
                [AUDIT_READ_SURFACE, trail],
                ['the panel ledger', JSON.stringify(rt.state.ledger)],
                ['host.storage', JSON.stringify([...loop.panelStorage])],
                ['captured logs', JSON.stringify([...loop.service.logLines, ...scanLogLines])],
                ['the panel dispatch record', JSON.stringify(loop.panelStorage.get(DISPATCH_STORAGE_KEY) ?? null)],
                ['panel bundle', readFileSync(BUNDLE, UTF8)],
                ['service bundle', readFileSync(SERVICE_BUNDLE, UTF8)],
            ];

            for (const [name, text] of surfaces) {
                expect(text, `${name} carried a permitted login`).not.toContain(SCANNED_PERMITTED);
            }

            // The permitted set's own file is the one place it lives, which makes
            // the scan above a containment proof rather than a tautology:
            // something *was* written, and only there.
            expect(await readFile(join(dataDir, BINDINGS_FILE), UTF8)).toContain(SCANNED_PERMITTED);
        } finally {
            await loop.shutdown();
        }
    });

    it('reads the surface scan in both directions, so it cannot pass vacuously', () => {
        // The scan above has to be able to fail: its needle is a string a surface
        // really could carry, and its own store file really does carry it.
        expect(readFileSync(SERVICE_BUNDLE, UTF8)).not.toContain(SCANNED_PERMITTED);
        expect(JSON.stringify(scannedAccount())).not.toContain(SCANNED_PERMITTED);
        expect(JSON.stringify(permitOnlyBinding())).toContain(SCANNED_PERMITTED);
    });

    it('finds the membership helper in exactly two files: its own and the gate (plan D9)', () => {
        // One comparison in the product, so "may this run start a session?" has
        // exactly one answer. A panel-side pre-check, a poll-loop filter, or a
        // second service comparison would all fail here rather than drifting.
        const gate = 'service/poll/dispatch-actor-gate.ts';
        const callers = scanSources()
            .filter((file) => /\bisActorAllowed\(/.test(file.text))
            .map((file) => file.path)
            .filter((path) => path !== 'service/bindings-allow-list.ts');

        expect(callers).toEqual([gate]);
    });

    it('keeps detection deciding nothing: no trigger path reads the list (FR-076)', () => {
        // Detection records the actor and **decides nothing** (002 FR-043). A
        // poll-loop filter would be cheaper and would leave no audit row, so
        // "why was this not dispatched?" would have no answer — the defect 003
        // exists to end, repeated in a new place.
        for (const path of ['service/poll/triggers.ts', 'service/poll/loop.ts']) {
            const file = scanSources().find((candidate) => candidate.path === path);
            expect(file, `${path} was not scanned`).toBeDefined();
            expect(file?.text, `${path} compares the allow-list`).not.toContain('isActorAllowed');
            expect(file?.text, `${path} reads the allow-list`).not.toContain('allowedUsers');
        }
    });

    it('introduces no suppression and no `any` into a Wave-2 module (invariant 7)', () => {
        const modules: ReadonlySet<string> = new Set([
            'service/poll/dispatch-actor-gate.ts',
            'service/bindings-read.ts',
            'src/relay-gates.ts',
            'src/run-actor.ts',
            'src/dispatches-detail.ts',
        ]);
        const sources = scanSources().filter((file) => modules.has(file.path));
        expect(sources).toHaveLength(modules.size);
        for (const file of sources) {
            const directives = file.text.match(/eslint-disable[^\n]*/gu) ?? [];
            for (const directive of directives) {
                expect(directive, `${file.path}: \`${directive}\``).toMatch(LINE_SCOPED_DISABLE);
            }
            expect(file.text, `${file.path} escapes the type system`)
                .not.toMatch(/@ts-ignore|@ts-expect-error|@ts-nocheck|# type: ignore/);
            expect(file.text, `${file.path} uses \`any\``).not.toMatch(/:\s*any\b/);
        }
    });
});
