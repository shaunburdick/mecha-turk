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
import { EVENTS_FILE } from '../service/poll/events.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { EVENTS_PATH } from '../service/routes/events.ts';
import { readRuns } from './support/dispatch-corpus.ts';
import { startDispatchLoop } from './support/dispatch-loop.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Bundled panel entry produced by `npm run build`. */
const BUNDLE = resolve(ROOT, 'panel/main.js');

/** Repository-relative path of the committed service bundle. */
const SERVICE_BUNDLE_PATH = 'service/main.js';

/** Bundled service entry produced by `npm run build`. */
const SERVICE_BUNDLE = resolve(ROOT, SERVICE_BUNDLE_PATH);

/** Panel HTML that loads the bundle. */
const PANEL_HTML = resolve(ROOT, 'panel/index.html');

/** Encoding used when reading the shipped artifacts. */
const UTF8 = 'utf8';

/** GitHub token shapes that must never appear in shipped artifacts. */
const TOKEN_PATTERNS: readonly RegExp[] = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/];

/** Exports of the committed service bundle, typed without an `any`. */
interface ServiceEntryModule {
    /** Starts the service from the host environment; called only when spawned. */
    readonly runService: (env?: NodeJS.ProcessEnv) => Promise<void>;
}

describe('built panel bundle', () => {
    it('exists where the manifest expects it', () => {
        expect(existsSync(BUNDLE)).toBe(true);
    });

    it('is a classic IIFE rather than an ES module', () => {
        const bundle = readFileSync(BUNDLE, UTF8);
        expect(bundle.startsWith('(()=>{')).toBe(true);
        expect(bundle.trimEnd().endsWith('})();')).toBe(true);
        expect(bundle).not.toContain('import.meta');
        expect(bundle).not.toMatch(/(^|\n)export\s/m);
        expect(bundle).not.toMatch(/(^|\n)import\s/m);
    });

    it('carries no GitHub token material', () => {
        const bundle = readFileSync(BUNDLE, UTF8);
        for (const pattern of TOKEN_PATTERNS) {
            expect(bundle).not.toMatch(pattern);
        }
    });

    it('ships the Bindings body (MVP blocker, 2026-09-27; re-cut by 005 T-009)', () => {
        const bundle = readFileSync(BUNDLE, UTF8);

        // The mount-time gate greps the bundle for the pane's marker; the
        // minifier renames identifiers and strips comments, so the marker
        // rides a runtime attribute instead: `data-mount="mountBindingsBody"`.
        expect(bundle).toContain('mountBindingsBody');
        // And a semantic proof that is only true when the pane's code is
        // actually bundled: the empty-list copy the pane itself renders.
        expect(bundle).toContain('No repository bound yet — add one below or refresh.');
        expect(bundle).toContain('Repository bindings');
    });

    it('ships the six-tab shell and none of the spike controls it retired (005 T-010)', () => {
        const bundle = readFileSync(BUNDLE, UTF8);

        // FR-011: the spike surface is deleted, not hidden — so what ships
        // carries none of its controls, and the six labels FR-010 names do.
        for (const retired of ['Start session', 'Record phase', 'Observed phase', 'Verify host state']) {
            expect(bundle).not.toContain(retired);
        }

        for (const label of ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About']) {
            expect(bundle).toContain(`"${label}"`);
        }
    });
});

describe('panel html', () => {
    it('loads the bundled script', () => {
        const html = readFileSync(PANEL_HTML, UTF8);
        expect(html).toContain('<script src="main.js"></script>');
        expect(html).toContain('<div id="root">');
    });

    it('carries no inline secrets or external origins', () => {
        const html = readFileSync(PANEL_HTML, UTF8);
        expect(html).not.toMatch(/(token|secret|password)\s*=/i);
        for (const pattern of TOKEN_PATTERNS) {
            expect(html).not.toMatch(pattern);
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
const GITHUB_GATEWAYS: ReadonlySet<string> = new Set([
    'src/github.ts',
    'service/github.ts',
    'service/poll/poller-github.ts',
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
 * binding field").
 *
 * The walk is dynamic — every `.ts` under {@link SOURCE_DIRS} is read — so
 * this list is the assertion that the newest additions are inside it.
 */
const PROMPT_MODULES: readonly string[] = [
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
];

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
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map((entry) => String(entry));
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
                ['the audit read', auditText],
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
        for (const bundle of [BUNDLE, SERVICE_BUNDLE]) {
            const text = readFileSync(bundle, UTF8);
            for (const sink of HTML_SINKS) {
                expect(text, `${bundle} must not use ${sink.source}`).not.toMatch(sink);
            }
        }
    });

    it('keeps every module that renders a 003 field on the text-only path', () => {
        const sources = scanSources();
        const rendered = [DISPATCHES_ROWS_MODULE, 'src/audit-view.ts', 'src/prerequisites.ts', 'src/dispatches-ui.ts'];
        for (const path of rendered) {
            const file = sources.find((candidate) => candidate.path === path);
            expect(file, `${path} was not scanned`).toBeDefined();
            for (const sink of HTML_SINKS) {
                expect(file?.text, `${path} must not use ${sink.source}`).not.toMatch(sink);
            }
        }
    });
});

describe('AC-128 the no-GitHub-write scan covers every module (FR-002)', () => {
    it('reads every source module, including every 003 addition', () => {
        const files = scanSources();
        expect(files.length).toBeGreaterThan(60);

        const paths = new Set(files.map((file) => file.path));
        for (const module of DISPATCH_MODULES) {
            expect(paths.has(module), `${module} was not scanned`).toBe(true);
        }
    });

    it('finds a GitHub API reference only in the read-only gateways', () => {
        // The scan has to bite before it can be believed.
        expect(GITHUB_API.test('const url = new URL(API_ORIGIN + "/repos/acme/widget/issues")')).toBe(true);
        expect(GITHUB_API.test('const path = `/repos/` + owner + `/issues`')).toBe(true);

        const outsiders = scanSources()
            .filter((file) => GITHUB_API.test(file.text) && !GITHUB_GATEWAYS.has(file.path))
            .map((file) => file.path);
        expect(outsiders).toEqual([]);
    });

    it('finds no non-GET method in a gateway, where every GitHub call is built', () => {
        expect(GITHUB_WRITE_METHOD.test("method: 'POST'")).toBe(true);

        const gateways = scanSources().filter((file) => GITHUB_GATEWAYS.has(file.path));
        expect(gateways).toHaveLength(GITHUB_GATEWAYS.size);
        for (const file of gateways) {
            expect(file.text, `${file.path} builds a GitHub write`).not.toMatch(GITHUB_WRITE_METHOD);
        }
    });

    it('embeds no concrete dispatch token in either bundle', () => {
        for (const bundle of [BUNDLE, SERVICE_BUNDLE]) {
            expect(readFileSync(bundle, UTF8), `${bundle} embeds a dispatch token`).not.toMatch(CONCRETE_TOKEN);
        }
    });
});

/* ------------------------------------------------------------------------- *
 * 004 containment (T-014: AC-133, AC-143, AC-144, FR-002, FR-005, NFR-121)
 *
 * Two halves, because the feature has two ways to fail: the *static* half
 * proves the shipped bytes and the newest modules cannot name the binding
 * field from the panel or smuggle a write or a suppression in, and the
 * *full-cycle* half runs save → refuse → detect → claim → dispatch → audit
 * read against a real loopback service and then greps every surface for two
 * planted strings — one accepted, one refused.
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

describe('004 static containment (AC-143, AC-144, FR-002, FR-005)', () => {
    it('reads every 004 module in the static scans', () => {
        const paths = new Set(scanSources().map((file) => file.path));
        for (const module of PROMPT_MODULES) {
            expect(paths.has(module), `${module} was not scanned`).toBe(true);
        }

        // The no-GitHub-write walk covers those same files: nothing 004 adds
        // may reach for GitHub at all, let alone write to it (FR-002).
        const gateways = new Set(GITHUB_GATEWAYS);
        for (const file of scanSources()) {
            if (PROMPT_MODULES.includes(file.path)) {
                expect(gateways.has(file.path), `${file.path} reached GitHub`).toBe(false);
            }
        }
    });

    it('carries the binding field exactly where 005 renders it (FR-051, SC-105)', () => {
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
    });

    it('introduces no suppression and no `any` into a 004 module (FR-005)', () => {
        const sources = scanSources().filter((file) => PROMPT_MODULES.includes(file.path));
        expect(sources).toHaveLength(PROMPT_MODULES.length);
        for (const file of sources) {
            expect(file.text, `${file.path} suppresses a rule`)
                .not.toMatch(/eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/);
            expect(file.text, `${file.path} uses \`any\``).not.toMatch(/:\s*any\b/);
        }
    });
});

describe('004 full-cycle containment (AC-133, AC-143, NFR-121)', () => {
    it('holds an accepted prompt in exactly two places and a refused value in none', async () => {
        const loop = await startDispatchLoop();
        try {
            // SAVE — the documented set path until 005 lands: the whole-file PUT.
            await loop.store.writeJson(`accounts/${SCANNED_ACCOUNT_ID}.json`, scannedAccount());
            const saved = await putBindings(loop, {
                ...containmentBinding(),
                startingPrompt: ACCEPTED_PROMPT,
            });
            expect(saved.status).toBe(200);

            // REFUSE — a credential-shaped value is refused at save, naming the
            // shape and never the value, and no part of it is applied (FR-024).
            const refused = await putBindings(loop, {
                ...containmentBinding(),
                startingPrompt: `push ${REFUSED_VALUE} to prod`,
            });
            expect(refused.status).toBe(422);
            const refusalText = await refused.text();
            expect(refusalText).toContain('github-token-classic');
            expect(refusalText).not.toContain(REFUSED_VALUE);

            // DETECT — the run snapshots the accepted text at enqueue.
            await loop.enqueue({ issueNumber: 91, prompt: ACCEPTED_PROMPT });

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
            const surfaces: readonly (readonly [string, string])[] = [
                [BINDINGS_FILE, await readFile(join(dataDir, BINDINGS_FILE), UTF8)],
                [RUNS_FILE, await readFile(join(dataDir, RUNS_FILE), UTF8)],
                [EVENTS_FILE, await readFile(join(dataDir, EVENTS_FILE), UTF8)],
                [AUDIT_FILE, await readFile(join(dataDir, AUDIT_FILE), UTF8)],
                ['the audit read', auditText],
                ['the panel ledger', JSON.stringify(rt.state.ledger)],
                ['host.storage', JSON.stringify([...loop.panelStorage])],
                ['captured service logs', JSON.stringify(loop.service.logLines)],
                ['status copy', JSON.stringify(rt.state.bindings)],
                ['panel bundle', readFileSync(BUNDLE, UTF8)],
                ['service bundle', readFileSync(SERVICE_BUNDLE, UTF8)],
            ];

            // Exactly two persisted places hold the instruction: the binding
            // and the run's own snapshot (004 FR-053). Everywhere else the
            // reference is a fingerprint, or nothing at all.
            const holders = surfaces
                .filter(([, text]) => text.includes(ACCEPTED_PROMPT))
                .map(([name]) => name)
                .sort();
            expect(holders).toEqual([BINDINGS_FILE, RUNS_FILE].sort());

            // The refused value appears nowhere — including in the refusal.
            for (const [name, text] of surfaces) {
                expect(text, `${name} carried the refused value`).not.toContain(REFUSED_VALUE);
                expect(findSecretLeak(text), `${name} carried credential material`).toBeNull();
            }
            expect(refusalText.includes(REFUSED_VALUE)).toBe(false);

            // And the accepted prompt left no credential-shaped trace either.
            expect(findSecretLeak(surfaces.map(([, text]) => text).join('\n'))).toBeNull();
        } finally {
            await loop.shutdown();
        }
    });
});

describe('004 the field is documented, and no editor is promised (FR-062, FR-074)', () => {
    /** The two operator pages that owe the field a section. */
    const pages: readonly string[] = ['README.md', 'specs/002-agent-event-extension/quickstart.md'];

    it('states the set path, the cap, the literal rule, the refusal, and the pinned agent', () => {
        for (const page of pages) {
            const text = readFileSync(resolve(ROOT, page), UTF8);
            expect(text, `${page} names the member`).toContain('startingPrompt');
            expect(text, `${page} names the store file`).toContain('bindings.json');
            expect(text, `${page} names the cap`).toContain('2,000');
            expect(text, `${page} promises literal text`).toContain('literal');
            expect(text, `${page} promises refusal, not storage`).toContain('refused, not stored');
            expect(text, `${page} names the pinned agent`).toContain('Default Agent');
            expect(text, `${page} documents omission-preserves`).toContain('keeps whatever the store');
        }
    });

    it('promises no panel editor before 005, and cites no retired spec path (FR-062)', () => {
        for (const page of pages) {
            const text = readFileSync(resolve(ROOT, page), UTF8);
            expect(text, `${page} promises an editor`).toMatch(
                /no editor for this field yet|Until the panel grows a field/,
            );
            expect(text, `${page} points at a retired spec path`).not.toContain('specs/001');
        }
    });
});
