import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * @param loop - The running loop to call.
 * @param path - Path to fetch.
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
 * @param pairs - Header name/value pairs.
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
    return loop.service.call(ACCOUNT_PATH.replace(':numericUserId', SCANNED_ACCOUNT_ID), {
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
 *
 * @param issueNumber - Issue the detection is about.
 * @returns One assignment snapshot.
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
 * @param input - The loop, the issue to enqueue, and the logger the queue write reports through.
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
        const enqueueLog = createLogger({ level: 'debug', sink: (line) => enqueueLines.push(line) });
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
    /** The two operator pages that owe the field a section. */
    const pages: readonly string[] = ['README.md', 'specs/002-agent-event-extension/quickstart.md'];

    it('states the set path, the cap, the literal rule, the refusal, and the pinned agent', () => {
        {
            for (const page of pages) {
                const text = readFileSync(resolve(ROOT, page), UTF8);
                expect(text, `${page} names the member`).toContain('startingPrompt');
                expect(text, `${page} names the store file`).toContain('bindings.json');
                expect(text, `${page} names the cap`).toContain('2,000');
                expect(text, `${page} promises literal text`).toContain('literal');
            }
        }
        {
            for (const page of pages) {
                const text = readFileSync(resolve(ROOT, page), UTF8);

                // 004 shipped no editor in its own window; 005 T-021 shipped the
                // binding editor's starting-prompt field, so the cycle's promise
                // ("no editor yet") is history and both documents must say where
                // the field actually lives instead of forecasting it.
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
 * @param text - File text.
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
                log: createLogger({ level: 'error', sink: (line) => scanLogLines.push(line) }),
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
        const modules: readonly string[] = [
            'service/poll/dispatch-actor-gate.ts',
            'service/bindings-read.ts',
            'src/relay-gates.ts',
            'src/run-actor.ts',
            'src/dispatches-detail.ts',
        ];
        const sources = scanSources().filter((file) => modules.includes(file.path));
        expect(sources).toHaveLength(modules.length);
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
