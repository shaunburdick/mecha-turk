/**
 * The static startup notice (005 FR-140, `005 AC-161`): present while no shell
 * has mounted, gone the moment one has.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runStartup } from '../src/bootstrap.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';
import { fakeHost } from './support/panel.ts';

/** The shipped document, read once for every assertion that reads it. */
const HTML = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8');

/** What the stand-in shell mount records, so removal can be asserted beside it. */
const shellMount = vi.hoisted(() => ({ calls: 0 }));

/** A frame face the runner reads its environment from. */
function startupWindow(isSecureContext: boolean): Pick<
    Window,
    'addEventListener' | 'removeEventListener' | 'isSecureContext'
> {
    return {
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        isSecureContext,
    };
}

/** The notice and detail nodes the shipped markup carries, wired into a body. */
function documentWithNotice(dom: FakeDom): { readonly body: FakeElement; readonly notice: FakeElement } {
    const body = dom.document.createElement('body');
    const notice = dom.document.createElement('div');
    notice.setAttribute('id', 'panel-startup-notice');
    notice.setAttribute('role', 'status');
    const detail = dom.document.createElement('p');
    detail.setAttribute('id', 'panel-startup-detail');
    notice.append(detail);
    dom.rootElement.setAttribute('id', 'root');
    body.append(notice, dom.rootElement);

    return { body, notice };
}

/** A shell mount that behaves: it records itself on the runtime and builds a stand-in. */
function standInShell(rt: PanelRuntime, root: HTMLElement): void {
    rt.root = root;
    shellMount.calls += 1;
    const shell = root.ownerDocument.createElement('section');
    shell.dataset.shell = 'mounted';
    root.append(shell);
}

describe('the shipped panel carries the startup notice before the bundle runs (005 AC-161)', () => {
    it('is outside and before #root, ahead of the script, and claims nothing', () => {
        const noticeAt = HTML.indexOf('id="panel-startup-notice"');
        const rootAt = HTML.indexOf('<div id="root">');
        const scriptAt = HTML.indexOf('<script src="main.js"></script>');

        expect(noticeAt, 'the notice exists').toBeGreaterThan(-1);
        expect(rootAt, 'the root exists').toBeGreaterThan(-1);
        expect(scriptAt, 'the bundle script exists').toBeGreaterThan(-1);
        expect(noticeAt).toBeLessThan(rootAt);
        expect(scriptAt).toBeGreaterThan(rootAt);

        const start = HTML.lastIndexOf('<div', noticeAt);
        const end = HTML.indexOf('</div>', noticeAt);
        expect(end, 'the notice closes before #root opens').toBeLessThan(rootAt);
        const block = HTML.slice(start, end + '</div>'.length);

        expect(block).toContain('role="status"');
        expect(block).toContain('Mecha Turk');
        expect(block).toContain('is starting');
        expect(block, 'the manual recovery instruction').toMatch(/reopen the panel/iu);
        // Nothing in the untouched markup may read as a panel that already ran.
        expect(block).not.toMatch(/\b(started|ready|connected|running)\b/iu);
        expect(block, 'the failure slot starts empty').toContain('<p id="panel-startup-detail"></p>');

        const rule = /#panel-startup-notice\s*\{([^}]*)\}/u.exec(HTML);
        expect(rule, 'the notice is styled').not.toBeNull();
        const declarations = rule?.[1] ?? '';
        expect(declarations, 'colour resolves through the host alias chain').toContain('var(--oc-');
        expect(declarations, 'no bare palette literal of its own').not.toMatch(/#[\da-f]{6}/iu);
    });

    it('is gone once a shell has mounted, and still there while none has', () => {
        const mounted = fakeDom();
        const first = documentWithNotice(mounted);
        shellMount.calls = 0;

        const rt = runStartup({
            doc: mounted.document,
            panelWindow: startupWindow(true),
            connect: () => {
                throw new Error('unused: this drive never reaches the bridge');
            },
            mountPanelApp: standInShell,
        });

        expect(rt, 'the runner refuses before a root exists').toBeNull();
        expect(shellMount.calls, 'no shell was mounted').toBe(0);
        expect(first.body.children, 'the notice survives a startup that never mounted').toContain(first.notice);

        const successful = fakeDom();
        const second = documentWithNotice(successful);
        let hostCalls = 0;
        const shell = runStartup({
            doc: successful.document,
            panelWindow: startupWindow(true),
            connect: () => {
                hostCalls += 1;

                return fakeHost();
            },
            mountPanelApp: standInShell,
        });

        expect(hostCalls, 'the bridge was reached').toBe(1);
        expect(shell, 'startup reached a runtime').not.toBeNull();
        expect(shellMount.calls, 'the shell mounted').toBe(1);
        expect(second.body.children, 'the notice does not outlive the shell').not.toContain(second.notice);
    });
});
