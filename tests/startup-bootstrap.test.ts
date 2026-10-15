/**
 * The synchronous bootstrap failures (005 `005 AC-162`, `005 SC-116`, NFR-115
 * states 2–3): each of the runner's stages fails in turn, and every failure has
 * to land on the static notice — the only surface a shell that never mounted
 * can reach — under the pinned stage token, with the message verbatim, the
 * insecure-context annotation only where the frame is actually insecure, and
 * nothing scheduled, claimed, or written behind it.
 *
 * Case (d) is the routing proof: the half-built runtime already holds the root
 * element, and the failure still goes to the notice, because routing follows
 * *stage completion*, never root presence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStartup } from '../src/bootstrap.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { createStorageDouble, fakeHost, NO_SESSION } from './support/panel.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';

/** The refusal pinned in `src/ids.ts`, written here as bytes of its own. */
const BOTH_ABSENT =
    'crypto.randomUUID is unavailable; refusing to record an observation without a correlation id';

/** The stage-1 message the runner took over from the entry point. */
const ROOT_MISSING = 'panel/index.html is missing its #root element';

/** A shell mount that dies halfway, after recording the root it was handed. */
const PARTIAL_MOUNT = 'the strip mount threw while the shell was half built';

/** One drive's observable surface: the DOM, the console, and the host calls. */
interface Drive {
    readonly rt: PanelRuntime | null;
    readonly detail: FakeElement | null;
    readonly dom: FakeDom;
    readonly lines: readonly string[];
    readonly connectCalls: number;
    readonly startSession: ReturnType<typeof vi.fn>;
    readonly storage: ReturnType<typeof createStorageDouble>;
    readonly timeout: ReturnType<typeof vi.spyOn>;
    readonly interval: ReturnType<typeof vi.spyOn>;
}

/** Capture the console for one drive; swallowed so the suite stays quiet. */
function capture(): { readonly lines: string[]; readonly restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
        lines.push(args.map(String).join(' '));
    });

    return { lines, restore: (): void => spy.mockRestore() };
}

/** Run the runner once against a document built to the case's shape. */
function drive(options: {
    readonly withRoot: boolean;
    readonly withNotice: boolean;
    readonly isSecureContext: boolean;
    readonly mountPanelApp?: (rt: PanelRuntime, root: HTMLElement) => void;
}): Drive {
    const dom = fakeDom();
    if (options.withRoot) {
        dom.rootElement.setAttribute('id', 'root');
    }

    let detail: FakeElement | null = null;
    if (options.withNotice) {
        const notice = dom.document.createElement('div');
        notice.setAttribute('id', 'panel-startup-notice');
        detail = dom.document.createElement('p');
        detail.setAttribute('id', 'panel-startup-detail');
        notice.append(detail);
    }

    const startSession = vi.fn(async () => NO_SESSION);
    const storage = createStorageDouble();
    const host = fakeHost({ startSession, storage: storage.storage });
    let connectCalls = 0;
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const console_ = capture();

    try {
        const rt = runStartup({
            doc: dom.document,
            panelWindow: {
                addEventListener: (): void => undefined,
                removeEventListener: (): void => undefined,
                isSecureContext: options.isSecureContext,
            },
            connect: (): ReturnType<typeof fakeHost> => {
                connectCalls += 1;

                return host;
            },
            mountPanelApp: options.mountPanelApp ?? ((): never => {
                throw new Error('this drive must fail before any shell mount');
            }),
        });

        return { rt, detail, dom, lines: console_.lines, connectCalls, startSession, storage, timeout, interval };
    } finally {
        console_.restore();
    }
}

/** The console entry the drive recorded for one stage. */
function entryFor(lines: readonly string[], stage: string): string | undefined {
    return lines.find((line) => line.includes(`stage="${stage}"`));
}

/** Every text node under `node`, in document order — the double has no innerText. */
function textOf(node: FakeElement): string {
    return [node.textContent, ...node.children.map((child) => textOf(child))].join(' ');
}

/** Assert the things every failed startup owes, whichever stage it failed in. */
function expectNothingScheduled(drv: Drive): void {
    expect(drv.timeout, 'no retry timer was scheduled').not.toHaveBeenCalled();
    expect(drv.interval, 'no retry interval was scheduled').not.toHaveBeenCalled();
    expect(drv.startSession, 'no session was started').not.toHaveBeenCalled();
    expect(drv.storage.operations, 'nothing was persisted').toEqual([]);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('a missing root fails at startup markup (005 AC-162 (a))', () => {
    it('lands on the notice with the pinned token, and records the environment', () => {
        const drv = drive({ withRoot: false, withNotice: true, isSecureContext: true });

        expect(drv.rt, 'nothing was constructed').toBeNull();
        expect(drv.connectCalls, 'the bridge was never reached').toBe(0);

        const entry = entryFor(drv.lines, 'startup markup');
        expect(entry, 'the console entry names the stage').toBeDefined();
        expect(entry).toContain('outcome=failed');
        // A stage-1 failure is still a complete record of what the frame was.
        expect(entry).toContain('secure-context=true');
        expect(entry).toContain('random-uuid=true');
        expect(entry).toContain('version=unknown');

        expect(drv.detail, 'the notice detail node exists').not.toBeNull();
        expect(drv.detail?.textContent).toContain('startup markup');
        expect(drv.detail?.textContent).toContain(ROOT_MISSING);
        expectNothingScheduled(drv);
    });
});

describe('both crypto APIs refused fails at runtime construction (005 AC-162 (b))', () => {
    it('renders the refusal verbatim and names the insecure frame it was taken in', () => {
        vi.stubGlobal('crypto', undefined);
        const drv = drive({ withRoot: true, withNotice: true, isSecureContext: false });

        expect(drv.rt, 'the runtime was never constructed').toBeNull();
        expect(drv.connectCalls, 'the bridge answered first').toBe(1);

        const entry = entryFor(drv.lines, 'runtime construction');
        expect(entry, 'the console entry names the stage').toBeDefined();
        expect(entry).toContain('outcome=failed');
        expect(entry).toContain(BOTH_ABSENT);

        const text = drv.detail?.textContent ?? '';
        expect(text).toContain('runtime construction');
        expect(text, 'the message is verbatim, not generic copy').toContain(BOTH_ABSENT);
        expect(text, 'the insecure context is stated').toContain('not a secure context');
        expect(text, 'the remediation names both spellings').toContain('HTTPS');
        expect(text, 'the remediation names both spellings').toContain('localhost');
        expectNothingScheduled(drv);
    });

    it('says nothing about the frame when the context is secure (NFR-112)', () => {
        vi.stubGlobal('crypto', undefined);
        const drv = drive({ withRoot: true, withNotice: true, isSecureContext: true });

        const text = drv.detail?.textContent ?? '';
        expect(text).toContain('runtime construction');
        expect(text).toContain(BOTH_ABSENT);
        expect(text, 'no cause the frame does not have').not.toContain('secure context');
        expect(text, 'no remediation a secure frame needs').not.toContain('localhost');
        expectNothingScheduled(drv);
    });
});

describe('a shell mount that throws half-built (the partial-mount edge case)', () => {
    it('still reports to the notice, tears the runtime down, and keeps the gate shut', () => {
        const drv = drive({
            withRoot: true,
            withNotice: true,
            isSecureContext: true,
            mountPanelApp: (rt, root): never => {
                // The half-built shell: the root is recorded, a body is up, then it dies.
                rt.root = root;
                root.append(root.ownerDocument.createElement('section'));

                throw new Error(PARTIAL_MOUNT);
            },
        });

        expect(drv.rt, 'the runner hands the runtime back').not.toBeNull();
        expect(drv.rt?.disposed, 'the half-built runtime is torn down').toBe(true);
        expect(drv.rt?.reconcileSettled, 'the gate never opened').toBe(false);
        expect(drv.rt?.relayArmPending, 'no arming intent survives').toBe(false);

        const entry = entryFor(drv.lines, 'shell mount');
        expect(entry, 'the console entry names the stage').toBeDefined();
        expect(entry).toContain(PARTIAL_MOUNT);

        // Root presence must not decide the surface: the failure is on the
        // notice, and the shell area carries none of it.
        const text = drv.detail?.textContent ?? '';
        expect(text).toContain('shell mount');
        expect(text).toContain(PARTIAL_MOUNT);
        expect(textOf(drv.dom.rootElement), 'nothing leaked into the half-built shell')
            .not.toContain(PARTIAL_MOUNT);
        expectNothingScheduled(drv);
    });
});

describe('a failure the notice cannot carry still reaches the console', () => {
    it('records the entry when the document has no notice node to write', () => {
        const drv = drive({
            withRoot: true,
            withNotice: false,
            isSecureContext: true,
            mountPanelApp: (): never => {
                throw new Error(PARTIAL_MOUNT);
            },
        });

        expect(drv.detail, 'there is no node to write').toBeNull();
        const entry = entryFor(drv.lines, 'shell mount');
        expect(entry, 'the console still has the record').toBeDefined();
        expect(entry).toContain(PARTIAL_MOUNT);
        expectNothingScheduled(drv);
    });
});
