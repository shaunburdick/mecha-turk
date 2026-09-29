import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { drainVerifications } from '../src/agent-verify.ts';
import { DISPATCH_STORAGE_KEY } from '../src/dispatch-record.ts';
import { auditItems, parseAuditBody } from '../src/audit-view.ts';
import { findSecretLeak } from '../src/redaction.ts';
import { pollRelay } from '../src/relay.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
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

    it('ships the Repositories pane and its tab (MVP blocker, 2026-09-27)', () => {
        const bundle = readFileSync(BUNDLE, UTF8);

        // The mount-time gate greps the bundle for the pane's marker; the
        // minifier renames identifiers and strips comments, so the marker
        // rides a runtime attribute instead: `data-mount="mountRepositoriesPane"`.
        expect(bundle).toContain('mountRepositoriesPane');
        // And a semantic proof that is only true when the pane's code is
        // actually bundled: the empty-list copy the pane itself renders.
        expect(bundle).toContain('No repository bound yet — add one below or refresh.');
        expect(bundle).toContain('Repository bindings');
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
const DISPATCH_MODULES: readonly string[] = [
    'src/relay.ts',
    'src/relay-gates.ts',
    'src/relay-attempt.ts',
    'src/dispatch-record.ts',
    'src/claim-service.ts',
    'src/reconcile.ts',
    'src/prerequisites.ts',
    'src/audit-view.ts',
    'src/runs-rows.ts',
    'src/runs-service.ts',
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
            const auditBytes = await readFile(resolve(loop.service.dataDir, 'audit.ndjson'), UTF8);
            const record = loop.panelStorage.get(DISPATCH_STORAGE_KEY) ?? null;
            const rows = parseAuditBody(auditText) ?? [];
            const surfaces: readonly (readonly [string, string])[] = [
                ['runs.json', await readFile(resolve(loop.service.dataDir, 'runs.json'), UTF8)],
                ['audit.ndjson', auditBytes],
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
        const rendered = ['src/runs-rows.ts', 'src/audit-view.ts', 'src/prerequisites.ts', 'src/runs-ui.ts'];
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
