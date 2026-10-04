/**
 * Panel entry point.
 *
 * OpenChamber loads `panel/index.html`, which loads this file as a classic
 * IIFE bundle. The entry does exactly two things: connect to the documented
 * host bridge and hand the root element to the panel application.
 *
 * `connectHost()` only works inside OpenChamber; opened as a plain file every
 * call rejects with `HOST_UNAVAILABLE`, which is the documented behaviour
 * rather than an error to work around.
 */

import { connectHost } from '@openchamber/sdk';
import { createPanelApp } from '../src/app.ts';

const root = document.querySelector<HTMLElement>('#root');
if (root === null) {
    throw new Error('panel/index.html is missing its #root element');
}

const host = connectHost();

createPanelApp({ host, root, panelWindow: window });
