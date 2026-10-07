import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    PANEL_STARTUP_FAILURE_COPY,
    PANEL_STARTUP_FAILURE_STATUS,
    dismissPanelStartupNotice,
    reportPanelStartupFailure,
    renderPanelStartupFailure,
    runPanelStartup,
} from '../src/panel-startup.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, NO_SESSION } from './support/panel.ts';

const REPOSITORY_ROOT = resolvePath(import.meta.dirname, '..');

describe('panel startup surface', () => {
    it('ships accessible fallback text before the root and panel bundle', () => {
        const html = readFileSync(resolvePath(REPOSITORY_ROOT, 'panel/index.html'), 'utf8');
        const noticeAt = html.indexOf('<div id="panel-startup-notice"');
        const rootAt = html.indexOf('<div id="root">');
        const scriptAt = html.indexOf('<script src="main.js">');

        expect(noticeAt).toBeGreaterThanOrEqual(0);
        expect(noticeAt).toBeLessThan(rootAt);
        expect(rootAt).toBeLessThan(scriptAt);
        expect(html.slice(noticeAt, rootAt)).toContain('role="status"');
        expect(html.slice(noticeAt, rootAt)).toContain('aria-live="polite"');
        expect(html.slice(noticeAt, rootAt)).toContain(
            'Mecha Turk panel is starting. If this message remains, reopen the panel;',
        );
    });

    it('keeps the notice on bootstrap failure and removes it only after mount', () => {
        const entry = readFileSync(resolvePath(REPOSITORY_ROOT, 'panel/main.ts'), 'utf8');
        const mountAt = entry.indexOf('createPanelApp({ host, root, panelWindow: globalThis });');
        const dismissAt = entry.indexOf('dismissPanelStartupNotice(startupNotice);');

        expect(mountAt).toBeGreaterThanOrEqual(0);
        expect(dismissAt).toBeGreaterThan(mountAt);
        expect(entry).toContain('renderPanelStartupFailure(notice);');
    });

    it('removes the startup overlay from its parent after a successful mount', () => {
        const { rootElement } = fakeDom();
        const notice = rootElement.ownerDocument.createElement('div');
        rootElement.append(notice);

        dismissPanelStartupNotice(notice);

        expect(rootElement.children).not.toContain(notice);
    });

    it('updates a startup node with accessible text-only failure copy', () => {
        const { rootElement } = fakeDom();

        renderPanelStartupFailure(rootElement);

        expect(rootElement.textContent).toBe(PANEL_STARTUP_FAILURE_COPY);
        expect(rootElement.attribute('role')).toBe('alert');
        expect(rootElement.attribute('aria-live')).toBe('assertive');
        expect(rootElement.attribute('aria-atomic')).toBe('true');
    });

    it('keeps failed setup from settling reconciliation or leaking the rejection', async () => {
        let sessionStarts = 0;
        const runtime = createTestRuntime(
            fakeHost({
                startSession: async () => {
                    sessionStarts += 1;

                    return NO_SESSION;
                },
            }),
        );
        runtime.reconcileSettled = false;
        runtime.relayArmPending = true;

        await runPanelStartup(
            async () => {
                throw new Error('synthetic-error-detail-not-for-rendering');
            },
            () => {
                runtime.reconcileSettled = true;
            },
            () => reportPanelStartupFailure(runtime),
        );

        expect(runtime.reconcileSettled).toBe(false);
        expect(runtime.relayArmPending).toBe(false);
        expect(runtime.relayArmed).toBe(false);
        expect(runtime.state.relay.timer).toBeNull();
        expect(sessionStarts).toBe(0);
        expect(runtime.state.status).toEqual(PANEL_STARTUP_FAILURE_STATUS);
        expect(PANEL_STARTUP_FAILURE_STATUS).toEqual({
            tone: 'error',
            title: 'Panel startup failed',
            body: PANEL_STARTUP_FAILURE_COPY,
        });
    });

    it('wires async mount failure to recovery without opening the relay gate', () => {
        const app = readFileSync(resolvePath(REPOSITORY_ROOT, 'src/app.ts'), 'utf8');

        expect(app).toContain('await runPanelStartup(');
        expect(app).toContain('() => settleReconciliation(rt)');
        expect(app).toContain('() => reportPanelStartupFailure(rt)');
    });

    it('settles reconciliation only after successful initial setup', async () => {
        let didSettle = false;
        let didFail = false;

        await runPanelStartup(
            () => Promise.resolve(),
            () => {
                didSettle = true;
            },
            () => {
                didFail = true;
            },
        );

        expect(didSettle).toBe(true);
        expect(didFail).toBe(false);
    });
});
