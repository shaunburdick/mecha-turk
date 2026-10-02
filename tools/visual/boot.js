/**
 * The page half of a capture: getting the harness open, booted, and pointed
 * at the tab that is about to be photographed.
 *
 * `shot.js` owns the capture ordering — fit, probe, capture, verify — and
 * this module owns everything that talks to the page *before* a frame exists:
 * navigating to the harness, waiting for the panel inside it to mount a
 * populated body, pressing a strip button, and putting the document back to
 * its normal height afterwards. Splitting them keeps each file to one
 * question: here it is *is the page up and showing the right tab?*, there it
 * is *is this the frame I asked for?*.
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Milliseconds to let the panel repaint after a click or a navigation. */
export const SETTLE_MS = 250;

/** Polls `waitForBoot` makes before it declares the panel dead. */
const BOOT_POLLS = 200;

/** Milliseconds between those polls. */
const BOOT_POLL_MS = 200;

/** How many times `openHarness` re-navigates if the wrong page answers. */
const OPEN_ATTEMPTS = 3;

/** Describe the page a boot failure saw, so the message is actionable. */
async function bootState(browser) {
    const expression =
        'JSON.stringify({ url: globalThis.location.href, api: typeof globalThis.__MT__, ' +
        'ready: typeof globalThis.__MT__ === "object" ? globalThis.__MT__.booted() : false, ' +
        'error: typeof globalThis.__MT__ === "object" ? globalThis.__MT__.error() : null })';

    try {
        return String(await browser.evaluate(expression));
    } catch (error) {
        return `eval refused: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Poll the harness until the panel has mounted a populated body. */
export async function waitForBoot(browser) {
    for (let poll = 0; poll < BOOT_POLLS; poll++) {
        const failure = await browser.evaluate(
            'typeof globalThis.__MT__ === "object" ? globalThis.__MT__.error() : null',
        );

        if (failure !== null) {
            throw new Error(`the harness could not load its fixtures: ${failure}`);
        }

        const ready = await browser.evaluate(
            'typeof globalThis.__MT__ === "object" ? globalThis.__MT__.booted() : false',
        );

        if (ready === true) {
            return;
        }

        await delay(BOOT_POLL_MS);
    }

    const state = await bootState(browser);

    throw new Error(
        `the panel never booted (${state}) — run \`node tools/visual/serve.js\`, open the printed ` +
            'URL by hand, and check what `agent-browser errors` reports',
    );
}

/** Press a tab in the strip and wait for the shell to select it. */
export async function activateTab(input) {
    const { browser, tab, refs } = input;
    const ref = refs[tab.label];

    if (ref === undefined) {
        throw new Error(`the strip has no "${tab.label}" button (found: ${Object.keys(refs).join(', ')})`);
    }

    await browser.click(ref);
    await delay(SETTLE_MS);
}

/** Navigate to the harness and confirm that is the page answering. */
export async function openHarness(browser, url) {
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
        await browser.open(url);
        const seen = await browser.evaluate('String(globalThis.location.href)');

        if (seen === url) {
            return;
        }

        await delay(SETTLE_MS);
    }

    throw new Error(`the harness at ${url} never became the page the browser reports`);
}

/** Put the harness page back to its normal height; a dead page is fine. */
export async function restoreHarness(browser) {
    try {
        await browser.evaluate('__MT__.stretch(null)');
    } catch {
        // The browser is already gone — there is no page to put back.
        return null;
    }

    return true;
}
