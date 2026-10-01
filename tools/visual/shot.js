/**
 * Capture one PNG per panel tab, and prove every frame is current.
 *
 * `npm run shot` (or `node tools/visual/shot.js <tab> …`) boots the shipped
 * `panel/index.html` inside the offline harness, walks the six tabs, and
 * writes `/tmp/opencode/panel-<tab>.png` plus one `panel-full.png` at the
 * panel's full scroll height. Nothing under `panel/`, `src/`, or `service/`
 * is touched: this is a tool for looking at the shipped bundle, not a part of
 * it.
 *
 * ## Why every capture is verified twice
 *
 * Screenshot runs in this environment have silently returned *stale* frames
 * before — the picture of a page that was navigated away from. Two checks run
 * against the decoded bytes of every image, and a failure aborts the run:
 *
 * 1. **Sentinel probe.** Immediately before each capture, `host.js` covers the
 *    document with a per-capture colour and a throwaway screenshot is decoded
 *    to confirm ≥90% of its pixels are exactly that colour. A frame from one
 *    step earlier cannot be.
 * 2. **Strip read-back.** The delivered frame is decoded and the fill of the
 *    *selected* tab's pill is measured where the DOM said it would be. A frame
 *    showing the previously selected tab paints the wrong pill, so it fails.
 * 3. **Visible-body read-back.** Right before each capture, `assert-body.js`
 *    asks every `[data-body]` of the cascade: the five the shell hid must have
 *    no box, and the one that does must be the body the requested tab labels.
 *    The strip's pill lives outside the scroller, so 2 alone validated the
 *    right pill over the wrong body whenever all six shared the layout. It
 *    then asks every *other* `[hidden]` element the same question, so a
 *    control the panel hid but the cascade still paints — a greyed button, an
 *    inline-`display` row — aborts the run instead of shipping.
 *
 * Plus: the sentinel must be absent from the delivered frame, and it must
 * differ from the capture before it. Five independent answers to "is this the
 * picture I just asked for?".
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { assertVisibleBody } from './assert-body.js';
import { createBrowser } from './browser.js';
import { selfTest } from './png-selftest.js';
import { startServer } from './serve.js';
import { percent, verifyDelivered, verifyProbe } from './verify.js';

/** The six tabs, in the strip's own order (FR-010). */
const TABS = [
    { id: 'status', label: 'Status' },
    { id: 'dispatches', label: 'Dispatches' },
    { id: 'bindings', label: 'Bindings' },
    { id: 'accounts', label: 'Accounts' },
    { id: 'settings', label: 'Settings' },
    { id: 'about', label: 'About' },
];

/** Sentinel colours: index 0 proves the path, 1–6 a tab, 7 the full page. */
const PROBE_COLORS = [
    '#ff00c8',
    '#00e0ff',
    '#a8ff00',
    '#ff7a00',
    '#7a00ff',
    '#00ff9d',
    '#ffe100',
    '#ff0055',
    '#00b4ff',
    '#ff4dd2',
];

/** Rail-panel width every capture uses; height follows the tab's content. */
const VIEWPORT_WIDTH = 1400;

/** Short viewport used before the full-height capture stretches the page. */
const SANITY_HEIGHT = 1000;

/** Never ask for a viewport shorter than this, whatever the body measures. */
const MIN_VIEWPORT_HEIGHT = 400;

/** Tallest viewport the run will ask for before it gives up on a tab. */
const DEFAULT_MAX_HEIGHT = 6000;

/** `#root`'s bottom padding in `panel/index.html`, which sizes the region. */
const ROOT_PAD = 12;

/** Fits the region to the body within this many pixels. */
const FIT_EPSILON = 1;

/** How many viewport adjustments a tab may need to settle. */
const FIT_ATTEMPTS = 4;

/** Pixels a layout may be out by after a resize and still be correct. */
const LAYOUT_TOLERANCE = 2;

/** Characters a tab body must show before it counts as populated. */
const MIN_BODY_TEXT = 200;

/** Milliseconds to let the panel repaint after a click. */
const SETTLE_MS = 250;

/** Polls `waitForBoot` makes before it declares the panel dead. */
const BOOT_POLLS = 200;

/** Milliseconds between those polls. */
const BOOT_POLL_MS = 200;

/** How many times `openHarness` re-navigates if the wrong page answers. */
const OPEN_ATTEMPTS = 3;

/** Where captures land, unless `--out` says otherwise. */
const DEFAULT_OUT_DIR = '/tmp/opencode';

/** Usage the `--help` flag prints. */
const USAGE = [
    'usage: node tools/visual/shot.js [tab …] [--out DIR] [--width PX] [--max-height PX]',
    `       tabs: ${TABS.map((entry) => entry.id).join(', ')} (default: all six)`,
    '       flags: --no-full (skip panel-full.png), --session NAME, --help',
].join('\n');

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

/** Report a line on stderr. */
function writeError(text) {
    process.stderr.write(`${text}\n`);
}

/** The value that follows an option, or a refusal naming the option. */
function optionValue(argv, index) {
    const value = argv[index + 1];

    if (value === undefined) {
        throw new Error(`option ${argv[index]} needs a value`);
    }

    return value;
}

/**
 * Read the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns `{ tabs, outDir, width, maxHeight, session, full, help }`.
 */
function parseArgs(argv) {
    const options = {
        tabs: [],
        outDir: DEFAULT_OUT_DIR,
        width: VIEWPORT_WIDTH,
        maxHeight: DEFAULT_MAX_HEIGHT,
        session: undefined,
        full: true,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];

        if (argument === '--out') {
            options.outDir = optionValue(argv, index);
            index++;
        } else if (argument === '--width') {
            options.width = Number(optionValue(argv, index));
            index++;
        } else if (argument === '--max-height') {
            options.maxHeight = Number(optionValue(argv, index));
            index++;
        } else if (argument === '--session') {
            options.session = optionValue(argv, index);
            index++;
        } else if (argument === '--no-full') {
            options.full = false;
        } else if (argument === '--help') {
            options.help = true;
        } else if (argument.startsWith('-')) {
            throw new Error(`unknown option ${argument}\n${USAGE}`);
        } else {
            options.tabs.push(argument);
        }
    }

    return options;
}

/** Resolve the requested tab names, refusing anything unknown. */
function selectTabs(requested) {
    if (requested.length === 0) {
        return TABS;
    }

    const chosen = [];

    for (const name of requested) {
        const key = name.toLowerCase();
        const tab = TABS.find((candidate) => candidate.id === key || candidate.label.toLowerCase() === key);

        if (tab === undefined) {
            throw new Error(`unknown tab "${name}" — try: ${TABS.map((entry) => entry.id).join(', ')}`);
        }

        chosen.push(tab);
    }

    return chosen;
}

/** Ask the harness how one tab body sits in the region that scrolls it. */
function measure(browser, name) {
    return browser.evaluate(`__MT__.measure('${name}')`);
}

/** Scroll the region to a tab body and report how it landed. */
function align(browser, name) {
    return browser.evaluate(`__MT__.align('${name}')`);
}

/** Read every tab body as the cascade paints it, plus the strip's answer. */
function bodyView(browser) {
    return browser.evaluate('__MT__.bodyView()');
}

/** Paint or clear the sentinel over the harness document. */
function setSentinel(browser, color) {
    const argument = color === null ? 'null' : `'${color}'`;

    return browser.evaluate(`__MT__.sentinel(${argument})`);
}

/** Refuse a tab whose body is missing, unselected, empty, or off-screen. */
function assertLayout(input) {
    const { tab, measurement } = input;

    if (measurement === null) {
        throw new Error(`the panel has no body for "${tab.id}"`);
    }

    if (measurement.active !== tab.label) {
        throw new Error(`the strip selected "${measurement.active}" after "${tab.label}" was pressed`);
    }

    if (measurement.textLength < MIN_BODY_TEXT) {
        throw new Error(`"${tab.label}" rendered no fixture text (${measurement.textLength} characters)`);
    }

    if (Math.abs(measurement.regionHeight - measurement.bodyHeight) > LAYOUT_TOLERANCE) {
        throw new Error(
            `"${tab.label}" does not fit: a ${measurement.bodyHeight}px body in a ` +
                `${measurement.regionHeight}px region — raise --max-height (current limit is generous)`,
        );
    }

    if (
        Math.abs(measurement.visibleTop) > LAYOUT_TOLERANCE ||
        Math.abs(measurement.visibleBottom - measurement.bodyHeight) > LAYOUT_TOLERANCE
    ) {
        throw new Error(
            `"${tab.label}" is not flush with the top of the scroller ` +
                `(visibleTop ${measurement.visibleTop}, visibleBottom ${measurement.visibleBottom})`,
        );
    }
}

/** Resize the viewport until the region holds exactly one tab body. */
async function fitViewport(input) {
    const { browser, tab, width, maxHeight } = input;
    let current = await measure(browser, tab.id);

    for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
        if (current === null) {
            return null;
        }

        const wanted = current.chrome + current.bodyHeight + ROOT_PAD;
        const needed = Math.min(Math.max(wanted, MIN_VIEWPORT_HEIGHT), maxHeight);

        if (Math.abs(needed - current.rootHeight) <= FIT_EPSILON) {
            return current;
        }

        await browser.setViewport({ width, height: needed });
        current = await measure(browser, tab.id);
    }

    return current;
}

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
async function waitForBoot(browser) {
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
async function activateTab(input) {
    const { browser, tab, refs } = input;
    const ref = refs[tab.label];

    if (ref === undefined) {
        throw new Error(`the strip has no "${tab.label}" button (found: ${Object.keys(refs).join(', ')})`);
    }

    await browser.click(ref);
    await delay(SETTLE_MS);
}

/** Paint a sentinel, capture the proof, verify it, then always clear it. */
async function probe(input) {
    const { browser, path, color, full } = input;

    try {
        await setSentinel(browser, color);
        await browser.capture(path, { full: full === true });
        const fraction = verifyProbe({ path, color });
        await rm(path, { force: true });

        return fraction;
    } finally {
        await setSentinel(browser, null);
    }
}

/** Capture one tab: activate, fit, probe, capture, verify. */
async function captureTab(input) {
    const { browser, context, tab, probeColor } = input;

    await activateTab({ browser, tab, refs: context.refs });
    await fitViewport({ browser, tab, width: context.width, maxHeight: context.maxHeight });
    assertLayout({ tab, measurement: await align(browser, tab.id) });

    const probeFraction = await probe({
        browser,
        path: join(context.outDir, `.probe-${tab.id}.png`),
        color: probeColor,
    });

    assertLayout({ tab, measurement: await align(browser, tab.id) });
    assertVisibleBody({ tab, view: await bodyView(browser), expected: TABS.length });
    const strip = await browser.evaluate('__MT__.strip()');
    const path = join(context.outDir, `panel-${tab.id}.png`);
    await browser.capture(path, { full: false });

    const verified = verifyDelivered({
        path,
        strip,
        probeColors: context.probeColors,
        previous: context.previous,
        minimumHeight: null,
    });

    return { id: tab.id, path, size: verified.size, diff: verified.diff, probeFraction, image: verified.image };
}

/**
 * Capture the whole panel at its full scroll height, strip included.
 *
 * The tab is selected first: the six tab captures leave the last one active,
 * and only one body is in the layout now, so measuring any other body would
 * measure a box that is not there.
 */
async function captureFull(input) {
    const { browser, context, tab, probeColor } = input;

    await browser.setViewport({ width: context.width, height: SANITY_HEIGHT });
    await activateTab({ browser, tab, refs: context.refs });
    await align(browser, tab.id);
    const before = await measure(browser, tab.id);

    if (before === null) {
        throw new Error(`the panel has no body for "${tab.id}"`);
    }

    const stretched = await browser.evaluate(`__MT__.stretch(${before.chrome + before.scrollHeight + ROOT_PAD})`);
    const strip = await browser.evaluate('__MT__.strip()');
    const probeFraction = await probe({
        browser,
        path: join(context.outDir, '.probe-full.png'),
        color: probeColor,
        full: true,
    });

    const path = join(context.outDir, 'panel-full.png');
    assertVisibleBody({ tab, view: await bodyView(browser), expected: TABS.length });
    await browser.capture(path, { full: true });

    const verified = verifyDelivered({
        path,
        strip,
        probeColors: context.probeColors,
        previous: null,
        minimumHeight: stretched.documentHeight,
    });

    await browser.evaluate('__MT__.stretch(null)');

    return { id: 'full', path, size: verified.size, diff: verified.diff, probeFraction, image: verified.image };
}

/** Refuse to run on numbers that would produce nonsense captures. */
function assertOptions(options) {
    if (!Number.isFinite(options.width) || options.width < 1) {
        throw new Error(`--width must be a positive number, got ${options.width}`);
    }

    if (!Number.isFinite(options.maxHeight) || options.maxHeight < MIN_VIEWPORT_HEIGHT) {
        throw new Error(`--max-height must be at least ${MIN_VIEWPORT_HEIGHT}, got ${options.maxHeight}`);
    }
}

/** Refuse to capture anything if the codec that verifies captures is broken. */
function assertCodec(codec) {
    if (codec.ok) {
        return;
    }

    const failed = codec.checks.filter((check) => !check.ok).map((check) => check.name);

    throw new Error(`the PNG self-test failed, so no capture could be verified: ${failed.join('; ')}`);
}

/** Print one capture's result in the run's single-line-per-image report. */
function report(result) {
    const diff = result.diff === null ? '   n/a' : `${percent(result.diff)} changed`;
    writeLine(
        `${result.path}  ${result.size}  sentinel=${percent(result.probeFraction)}  ${diff}`.trimEnd(),
    );
}

/** Put the harness page back to its normal height; a dead page is fine. */
async function restoreHarness(browser) {
    try {
        await browser.evaluate('__MT__.stretch(null)');
    } catch {
        // The browser is already gone — there is no page to put back.
        return null;
    }

    return true;
}

/** Navigate to the harness and confirm that is the page answering. */
async function openHarness(browser, url) {
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

/** Boot the harness, prove the capture path, then capture what was asked for. */
async function runCapture(input) {
    const { browser, context, tabs, includeFull } = input;

    await browser.close();
    await openHarness(browser, context.url);
    await browser.setViewport({ width: context.width, height: SANITY_HEIGHT });
    await waitForBoot(browser);

    const bootFraction = await probe({
        browser,
        path: join(context.outDir, '.probe-boot.png'),
        color: PROBE_COLORS[0],
    });
    writeLine(`capture path verified: ${percent(bootFraction)} of the probe frame is the sentinel colour`);

    context.refs = await browser.snapshotTabs();
    const results = [];

    for (const tab of tabs) {
        const result = await captureTab({
            browser,
            context,
            tab,
            probeColor: PROBE_COLORS[TABS.indexOf(tab) + 1],
        });

        context.previous = result.image;
        results.push(result);
        report(result);
    }

    if (includeFull) {
        const full = await captureFull({
            browser,
            context,
            tab: TABS[0],
            probeColor: PROBE_COLORS[TABS.length + 1],
        });

        results.push(full);
        report(full);
    }

    return results;
}

/** Validate the codec, start the harness, capture, and report. */
async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        writeLine(USAGE);

        return;
    }

    assertOptions(options);
    assertCodec(selfTest());
    const tabs = selectTabs(options.tabs);
    await mkdir(options.outDir, { recursive: true });

    const server = await startServer({ port: 0 });
    const browser = createBrowser({ session: options.session });
    const context = {
        outDir: options.outDir,
        width: options.width,
        maxHeight: options.maxHeight,
        probeColors: PROBE_COLORS,
        url: `${server.url}/tools/visual/index.html`,
        refs: {},
        previous: null,
    };

    writeLine(`freshness: sentinel probe before every frame, strip read-back — ${context.url}`);

    try {
        const results = await runCapture({ browser, context, tabs, includeFull: options.full });
        writeLine(`captured ${results.length} images in ${options.outDir}`);
    } finally {
        await restoreHarness(browser);
        await browser.close();
        await server.close();
    }
}

const invokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    main().catch((error) => {
        writeError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
