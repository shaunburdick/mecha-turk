/**
 * Panel entry point: OpenChamber loads `panel/index.html`, which loads this file as a classic IIFE
 * bundle. It hands the document, the frame, the host bridge, and the shell mount to the startup
 * runner, which owns the five stages and their failure surfaces (005 FR-140 – FR-142).
 * `connectHost()` only works inside OpenChamber; opened as a plain file every call rejects with
 * `HOST_UNAVAILABLE`, documented behaviour, not an error.
 */

import { connectHost } from '@openchamber/sdk';
import { mountPanelApp } from '../src/app.ts';
import { runStartup } from '../src/bootstrap.ts';

runStartup({
    doc: document,
    panelWindow: globalThis,
    connect: connectHost,
    mountPanelApp,
});
