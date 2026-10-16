/**
 * The startup milestone record (005 AC-164, SC-117, NFR-115): one entry per
 * stage, environment on the first, and no startup record in host storage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostReadyContext } from '@openchamber/sdk';
import { begin, mountPanelApp, teardown } from '../src/app.ts';
import { runStartup } from '../src/bootstrap.ts';
import type { TabId } from '../src/panel-state.ts';
import { STARTUP_STAGES } from '../src/startup.ts';
import type * as tabBodies from '../src/tab-bodies.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';
import { createPushHarness, createStorageDouble, tick } from './support/panel.ts';

/** The stage vocabulary as the specification closes it — literals, not imports. */
const SPEC_STAGES = [
    'startup markup',
    'host bridge',
    'runtime construction',
    'shell mount',
    'initial setup',
];

/** The version a health answer would put in the single source. */
const SEEDED_VERSION = '4.5.6';

/** The keys host storage may be touched under — and nothing else may appear. */
const DOCUMENTED_KEYS: ReadonlySet<string> = new Set([
    'accounts',
    'mecha-turk:evidence',
    'mecha-turk:ledger',
    'mecha-turk:dispatches',
]);

/** The entry's opening fields, in the order FR-142 fixes them. */
const ENTRY_HEAD = /^\[mecha-turk\/startup\] stage="(?<stage>[^"]+)" outcome=(?<outcome>ok|failed)/u;
/** The optional environment block, which only a startup's first entry carries. */
const ENTRY_ENV = /(?<env> secure-context=(?:true|false) random-uuid=(?:true|false) mint="[^"]*")/u;
/** The version field, which every entry carries. */
const ENTRY_VERSION = / version=(\S+)/u;
/** The failure field, which only a failed entry carries, at the end of the line. */
const ENTRY_ERROR = / error="([^"]*)"$/u;

/** The console lines one drive recorded. */
const recorded = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };

    /** The surface the mounts receive: a node to append into, and a document. */
    interface MountRoot {
        readonly ownerDocument: { createElement(tagName: string): FakeElement };
        append(...nodes: FakeElement[]): void;
    }

    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (): { update: () => void; dispose: () => void } => ({
                update: (): void => undefined,
                dispose: (): void => undefined,
            });
        }
    }

    stubbed.mountBanner = (
        root: MountRoot,
        initial: { readonly tone: string; readonly title: string; readonly body?: string },
    ): { update: (next: { readonly title?: string; readonly body?: string }) => void; dispose: () => void } => {
        const node = root.ownerDocument.createElement('div');
        node.setAttribute('data-tone', initial.tone);
        let { title } = initial;
        let body = initial.body ?? '';
        const paint = (): void => {
            node.textContent = `${title} — ${body}`;
        };
        paint();
        root.append(node);

        return {
            update: (next): void => {
                title = next.title ?? title;
                body = next.body ?? body;
                paint();
            },
            dispose: (): void => {
                node.remove();
            },
        };
    };

    stubbed.mountTabs = (
        root: MountRoot,
        initial: {
            readonly items: readonly { readonly id: string; readonly label: string }[];
            readonly activeId: string;
        },
    ): { update: (next: { readonly activeId: string }) => void; dispose: () => void } => {
        const track = root.ownerDocument.createElement('div');
        track.setAttribute('role', 'tablist');
        root.append(track);
        const buttons = initial.items.map((item) => {
            const button = root.ownerDocument.createElement('button');
            button.setAttribute('role', 'tab');
            button.dataset.id = item.id;
            track.append(button);

            return button;
        });
        const paint = (activeId: string): void => {
            for (const [index, item] of initial.items.entries()) {
                const button = buttons[index];
                if (button !== undefined) {
                    button.setAttribute('aria-selected', item.id === activeId ? 'true' : 'false');
                }
            }
        };

        paint(initial.activeId);
        track.addEventListener('keydown', (): void => undefined);

        return {
            update: (next): void => {
                paint(next.activeId);
            },
            dispose: (): void => {
                track.remove();
            },
        };
    };

    // The fake root carries no document element for the host theme to land on.
    stubbed.applyHostReady = (): void => undefined;

    return stubbed;
});

vi.mock('../src/tab-bodies.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof tabBodies>();
    // Local to the factory: module bindings are not initialized yet when it runs.
    const ids: readonly TabId[] = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about', 'logs'];

    return {
        ...actual,
        tabSpecs: (): { readonly id: TabId; readonly label: string; readonly mount: (body: HTMLElement) => null }[] =>
            ids.map((id) => ({
                id,
                label: id,
                mount: (): null => null,
            })),
    };
});

/**
 * Parse one console line back into its fields; a line that fits no part of the
 * shape throws rather than parsing into something an assertion could pass on.
 */
function parseEntry(line: string): {
    readonly stage: string;
    readonly outcome: string;
    readonly env: string | null;
    readonly version: string;
    readonly error: string | null;
} {
    const head = ENTRY_HEAD.exec(line);
    if (head === null) {
        throw new Error(`not a startup milestone: ${line}`);
    }

    const rest = line.slice(head[0].length);
    const env = ENTRY_ENV.exec(rest);
    const withoutEnv = env === null ? rest : rest.slice(env[0].length);
    const version = ENTRY_VERSION.exec(withoutEnv);
    if (version === null) {
        throw new Error(`no version field: ${line}`);
    }

    const tail = withoutEnv.slice(version[0].length);
    const error = ENTRY_ERROR.exec(tail);
    if (tail !== (error?.[0] ?? '')) {
        throw new Error(`text outside the fixed entry shape: ${line}`);
    }

    return {
        stage: head.groups?.stage ?? '',
        outcome: head.groups?.outcome ?? '',
        env: env?.groups?.env ?? null,
        version: version[1] ?? '',
        error: error?.[1] ?? null,
    };
}

/** Every node under `node` carrying an error banner's tone. */
function failureSurfaces(node: FakeElement): FakeElement[] {
    const here = node.attribute('data-tone') === 'error' ? [node] : [];

    return [...here, ...node.children.flatMap((child) => failureSurfaces(child))];
}

/** What one full startup recorded. */
interface Drive {
    readonly lines: readonly string[];
    readonly detail: FakeElement | null;
    readonly dom: FakeDom;
}

/** Run the runner and then readiness to completion, one console capture across both. */
async function fullStartup(options: { readonly seedVersion?: string } = {}): Promise<Drive> {
    recorded.lines.length = 0;
    const dom = fakeDom();
    dom.rootElement.setAttribute('id', 'root');
    const notice = dom.document.createElement('div');
    notice.setAttribute('id', 'panel-startup-notice');
    const detail = dom.document.createElement('p');
    detail.setAttribute('id', 'panel-startup-detail');
    notice.append(detail);

    const storage = createStorageDouble();
    const harness = createPushHarness({ storage: storage.storage });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
        recorded.lines.push(args.map(String).join(' '));
    });

    try {
        const rt = runStartup({
            doc: dom.document,
            panelWindow: {
                addEventListener: (): void => undefined,
                removeEventListener: (): void => undefined,
                isSecureContext: true,
            },
            connect: () => harness.host,
            mountPanelApp,
        });
        if (rt === null) {
            throw new Error('startup failed on a document that has a root');
        }

        const capture: { ready: HostReadyContext | null } = { ready: null };
        harness.host.onReady((context): void => {
            capture.ready = context;
        });
        // The suite drives `begin` itself so the fifth entry is awaited, not raced.
        rt.started = true;
        if (options.seedVersion !== undefined) {
            rt.state.aboutTab.version = options.seedVersion;
        }

        harness.emitReady(null);
        if (capture.ready === null) {
            throw new Error('the harness never fired ready');
        }

        await expect(begin(rt, capture.ready)).resolves.toBeUndefined();
        await tick();
        teardown(rt);

        // SC-117: no startup record is persisted, and no key outside the
        // documented set is touched by any drive in this block.
        for (const operation of storage.operations) {
            const key = operation.slice(operation.indexOf(':') + 1);
            expect(DOCUMENTED_KEYS.has(key), `${operation} reaches outside the documented key set`).toBe(true);
        }

        return { lines: [...recorded.lines], detail, dom };
    } finally {
        consoleLog.mockRestore();
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('a successful startup leaves one milestone per stage (005 AC-164)', () => {
    it('records all five stages with no error, and the environment on the first entry', async () => {
        const drive = await fullStartup();
        const entries = drive.lines.map((line) => parseEntry(line));

        expect(STARTUP_STAGES, 'the vocabulary the module owns').toEqual(SPEC_STAGES);
        expect(entries.map((entry) => entry.stage)).toEqual(SPEC_STAGES);
        for (const entry of entries) {
            expect(entry.outcome, entry.stage).toBe('ok');
            expect(entry.error, `${entry.stage} carries no error`).toBeNull();
            // The version source has not answered on a fresh mount: unknown, not invented.
            expect(entry.version, entry.stage).toBe('unknown');
        }

        expect(entries[0]?.env, 'the first entry carries the environment').toContain('secure-context=true');
        expect(entries[0]?.env).toContain('random-uuid=true');
        expect(entries[0]?.env).toContain('mint="randomUUID"');
        for (const entry of entries.slice(1)) {
            expect(entry.env, `${entry.stage} is a stage record, not an environment record`).toBeNull();
        }

        expect(failureSurfaces(drive.dom.rootElement), 'nothing failed').toEqual([]);
    });

    it('reads the version the health answer put in the single source', async () => {
        const drive = await fullStartup({ seedVersion: SEEDED_VERSION });
        const entries = drive.lines.map((line) => parseEntry(line));
        const last = entries.at(-1);

        expect(last?.stage).toBe('initial setup');
        expect(last?.version, 'the seeded value rides the entry that read it').toBe(SEEDED_VERSION);
        const earlier = entries.slice(0, -1);
        for (const entry of earlier) {
            expect(entry.version, `${entry.stage} ran before the source answered`).toBe('unknown');
        }

        // Only the two values the single source can honestly produce appear —
        // never a second literal read from somewhere else.
        for (const entry of entries) {
            expect(['unknown', SEEDED_VERSION], `no second version source in ${entry.stage}`).toContain(entry.version);
        }
    });
});

describe('the getRandomValues fallback announces itself exactly once (FR-144, 005 AC-166)', () => {
    it('starts successfully and renders no failure surface', async () => {
        vi.stubGlobal('crypto', {
            getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
        });

        const drive = await fullStartup();
        const entries = drive.lines.map((line) => parseEntry(line));

        expect(entries.every((entry) => entry.outcome === 'ok')).toBe(true);
        expect(failureSurfaces(drive.dom.rootElement), 'nothing failed').toEqual([]);
        expect(drive.detail?.textContent, 'the notice never received a failure').toBe('');

        const announcements = entries.filter((entry) => (entry.env ?? '').includes('getRandomValues'));
        expect(announcements, 'one entry announces the fallback').toHaveLength(1);
        expect(announcements[0]?.stage).toBe('startup markup');
        expect(announcements[0]?.env).toContain('crypto.randomUUID is unavailable');
        expect(entries.filter((entry) => entry.outcome === 'failed')).toEqual([]);
    });
});
