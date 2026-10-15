/**
 * Panel entry point: OpenChamber loads `panel/index.html`, which loads this
 * file as an IIFE bundle that hands everything to the startup runner.
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
