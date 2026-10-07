/**
 * Panel entry point.
 *
 * OpenChamber loads `panel/index.html`, which loads this file as a classic
 * IIFE bundle. The entry connects to the documented host bridge and hands the
 * root element to the panel application. A static startup notice remains until
 * that shell mounts successfully.
 *
 * `connectHost()` only works inside OpenChamber; opened as a plain file every
 * call rejects with `HOST_UNAVAILABLE`, which is the documented behaviour
 * rather than an error to work around.
 */

import { connectHost } from '@openchamber/sdk';
import { createPanelApp } from '../src/app.ts';
import { dismissPanelStartupNotice, renderPanelStartupFailure } from '../src/panel-startup.ts';

const root = document.querySelector<HTMLElement>('#root');
const startupNotice = document.querySelector<HTMLElement>('#panel-startup-notice');

try {
    if (root === null || startupNotice === null) {
        throw new Error('Panel startup markup is missing');
    }

    const host = connectHost();
    createPanelApp({ host, root, panelWindow: globalThis });
    dismissPanelStartupNotice(startupNotice);
} catch {
    const notice = startupNotice ?? document.createElement('div');
    if (startupNotice === null) {
        notice.id = 'panel-startup-notice';
        document.body.append(notice);
    }

    renderPanelStartupFailure(notice);
}
