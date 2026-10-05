/**
 * Capture one PNG per panel tab — at its real width, twice — and prove every
 * frame is current.
 *
 * `npm run shot` (or `node tools/visual/shot.js <tab> …`) boots the shipped
 * `panel/index.html` inside the offline harness, walks the six tabs, and
 * writes two frames per tab: `screenshots/panel-<tab>.png` at the default
 * width (720px — the top of the band the host's own arithmetic gives an
 * extension rail, see `DEFAULT_WIDTH` below) and
 * `screenshots/panel-<tab>-narrow.png` at 560px, the tight end of that band —
 * plus one `panel-full.png` at the default width and the
 * panel's full scroll height. `screenshots/` is the repo-root folder the
 * operator opens (it is git-ignored, and `--out DIR` overrides it), so a
 * capture lands where it can be looked at rather than in a temp directory.
 * Nothing under `panel/`, `src/`, or `service/` is touched: this is a tool
 * for looking at the shipped bundle, not a part of it.
 *
 * ## Why every capture is verified so many times
 *
 * Screenshot runs in this environment have silently returned *stale* frames
 * before — the picture of a page that was navigated away from. Several checks
 * run against the decoded bytes of every image, one against the live cascade,
 * and a failure aborts the run:
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
 * 4. **Width read-back.** The delivered frame must be as wide as the frame
 *    that was asked for, so a viewport resize that never landed cannot hide
 *    behind an unchanged picture.
 * 5. **Same-width diff.** The frame must differ from the last capture at its
 *    own width — frames at *different* widths are never compared, because two
 *    widths of one content share background and left-aligned text.
 *
 * Plus: the sentinel must be absent from the delivered frame. Five
 * independent answers to "is this the picture I just asked for?".
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { assertVisibleBody } from './assert-body.js';
import { activateTab, openHarness, restoreHarness, waitForBoot } from './boot.js';
import { createBrowser } from './browser.js';
import { align, assertLayout, bodyView, fitViewport, measure, MIN_VIEWPORT_HEIGHT, ROOT_PAD } from './layout.js';
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

/**
 * Sentinel colours: index 0 proves the capture path, 1–6 a default-width
 * tab, 7–12 the same tab at the narrow width, 13 the full page.
 *
 * Every capture gets its own colour so a probe from one step earlier cannot
 * masquerade as the frame just asked for, and `verifyDelivered` is handed the
 * whole list so a delivered image carrying *any* of them is refused.
 */
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
    '#c8ff00',
    '#00ffc8',
    '#ff0095',
    '#4d7aff',
];

/** Sentinel colour for a tab's default-width frame (1–6). */
const WIDE_COLOR = 1;

/** Sentinel colour for a tab's narrow frame, `WIDE_COLOR + tabs` apart. */
const NARROW_COLOR = 7;

/** Sentinel colour for the full-height frame. */
const FULL_COLOR = 13;

/**
 * The default capture width: the width the host really gives a rail panel,
 * not the width of a desktop window.
 *
 * ## Evidence (read 2026-10-01, not estimated)
 *
 * Neither `@openchamber/sdk` nor its injected sheet documents a pixel width
 * anywhere — the SDK paints theme tokens and scrollbars only, and the host
 * theme implies no panel size. The *host* computes one instead:
 *
 * - Extension panels are `plugin:<id>` context surfaces, and
 *   `getContextSurfaceWidthFraction()` (`packages/ui/src/lib/surfaces/
 *   registry.ts`) returns **0.45** for every plugin mode: "default panel
 *   width as a fraction of the available content area".
 * - `ContextPanel.tsx` applies `clamp(0.45 × availableRegion, min, max)` with
 *   `CONTEXT_PANEL_MIN_WIDTH = 320`, `CONTEXT_PANEL_MAX_WIDTH = 1400`, and a
 *   ceiling of `availableRegion − CONTEXT_CHAT_MIN_WIDTH (400)` — the panel
 *   always leaves the chat a column.
 * - With `LEFT_SIDEBAR_DEFAULT_WIDTH = 280`, the region is ≈1100px on a 1440
 *   screen and ≈1600px on a 1920 one, so the *default* (never-resized) panel
 *   lands at **≈500px at 1440 and ≈715px at 1920**, resizable by the operator
 *   between 320 and 1400.
 *
 * 720 is the top of that computed band — and exactly 50% of a 1440 screen,
 * the product owner's own phrasing ("typically 40–50% of the screen") — so
 * the layout is judged where the widest default rail lands, and `NARROW_WIDTH`
 * covers the rest. `--width` still overrides it for a frame at one size.
 */
const DEFAULT_WIDTH = 720;

/**
 * The tight end of the same band, captured for every tab alongside the
 * default frame as `panel-<tab>-narrow.png`.
 *
 * 560 is the host's default on a 1440 screen (≈500px, rounded onto the
 * stylesheet's existing lower breakpoint): the width where a column grid that
 * reads as columns at 720 either still fits or has to stack, so the narrow
 * frame is the one that shows which. It is skipped only when the default
 * frame is already this narrow (or narrower) — then the two would be the
 * same picture.
 */
const NARROW_WIDTH = 560;

/** Short viewport used before the full-height capture stretches the page. */
const SANITY_HEIGHT = 1_000;

/** Tallest viewport the run will ask for before it gives up on a tab. */
const DEFAULT_MAX_HEIGHT = 6_000;

/**
 * Where captures land, unless `--out` says otherwise: the repo-root
 * `screenshots/` folder, git-ignored so a run's images never enter the index.
 */
const DEFAULT_OUT_DIR = join(import.meta.dirname, '..', '..', 'screenshots');

/** Usage the `--help` flag prints. */
const USAGE = [
    'usage: node tools/visual/shot.js [tab …] [--out DIR] [--width PX] [--max-height PX]',
    `       tabs: ${TABS.map((entry) => entry.id).join(', ')} (default: all six)`,
    '       flags: --no-full (skip panel-full.png), --session NAME, --help',
    `       every tab is captured at ${DEFAULT_WIDTH}px (or --width) and again at ${NARROW_WIDTH}px`,
    `       as panel-<tab>-narrow.png; --width ${NARROW_WIDTH} or narrower skips the second frame`,
    '       default --out: screenshots/ at the repository root (git-ignored)',
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
        width: DEFAULT_WIDTH,
        maxHeight: DEFAULT_MAX_HEIGHT,
        session: undefined,
        full: true,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];

        switch (argument) {
            case '--out': {
                options.outDir = optionValue(argv, index);
                index++;

                break;
            }
            case '--width': {
                options.width = Number(optionValue(argv, index));
                index++;

                break;
            }
            case '--max-height': {
                options.maxHeight = Number(optionValue(argv, index));
                index++;

                break;
            }
            case '--session': {
                options.session = optionValue(argv, index);
                index++;

                break;
            }
            case '--no-full': {
                options.full = false;

                break;
            }
            case '--help': {
                options.help = true;

                break;
            }
            default: { if (argument.startsWith('-')) {
                throw new Error(`unknown option ${argument}\n${USAGE}`);
            }
            options.tabs.push(argument);
            }
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

/** Paint or clear the sentinel over the harness document. */
function setSentinel(browser, color) {
    const argument = color === null ? 'null' : `'${color}'`;

    return browser.evaluate(`__MT__.sentinel(${argument})`);
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

/**
 * Capture one tab at one width: fit the viewport, probe, capture, verify.
 *
 * The freshness chain advances here rather than in the caller: the image just
 * delivered becomes the previous frame *for its width*, so the next frame at
 * that width — of this tab or of the next one — has to differ from it to
 * survive, and a frame delivered at the wrong width fails on its own read-back
 * instead.
 *
 * @param input - Browser, run context, the tab, the width to fit to, the
 *   sentinel colour, and the output file's name without its `.png`.
 * @returns The report's figures for this frame.
 */
async function captureFrame(input) {
    const { browser, context, tab, width, probeColor, name } = input;

    await fitViewport({ browser, tab, width, maxHeight: context.maxHeight });
    assertLayout({ tab, measurement: await align(browser, tab.id) });

    const probeFraction = await probe({
        browser,
        path: join(context.outDir, `.probe-${name}.png`),
        color: probeColor,
    });

    assertLayout({ tab, measurement: await align(browser, tab.id) });
    assertVisibleBody({ tab, view: await bodyView(browser), expected: TABS.length });
    const strip = await browser.evaluate('__MT__.strip()');
    const path = join(context.outDir, `${name}.png`);
    await browser.capture(path, { full: false });

    /*
     * The freshness chain is per width, not global: the previous frame at
     * *this* width is the one a re-emitted bitmap would repeat, and it is the
     * only comparison whose overlap means anything — 720px and 560px of the
     * same content are mostly shared background. The width itself is asserted
     * separately (`expectedWidth`), which is what catches a resize that never
     * reached the capture.
     */
    const previous = context.previousByWidth.get(width) ?? null;
    const verified = verifyDelivered({
        path,
        strip,
        probeColors: context.probeColors,
        expectedWidth: width,
        previous,
        minimumHeight: null,
    });

    context.previousByWidth.set(width, verified.image);

    return { id: name, path, size: verified.size, diff: verified.diff, probeFraction };
}

/**
 * Capture one tab: its frame at the default (or `--width`) width, then the
 * narrow frame beside it, so the tight end of the panel's real width band is
 * always on disk next to the comfortable one.
 *
 * @param input - Browser, run context, the tab, and both sentinel colours.
 * @returns One result per frame captured, in capture order.
 */
async function captureTab(input) {
    const { browser, context, tab, wideColor, narrowColor } = input;

    await activateTab({ browser, tab, refs: context.refs });

    const captured = [
        await captureFrame({
            browser,
            context,
            tab,
            width: context.width,
            probeColor: wideColor,
            name: `panel-${tab.id}`,
        }),
    ];

    if (context.width > NARROW_WIDTH) {
        captured.push(
            await captureFrame({
                browser,
                context,
                tab,
                width: NARROW_WIDTH,
                probeColor: narrowColor,
                name: `panel-${tab.id}-narrow`,
            }),
        );
    }

    return captured;
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
        expectedWidth: context.width,
        previous: null,
        minimumHeight: stretched.documentHeight,
    });

    await browser.evaluate('__MT__.stretch(null)');

    return { id: 'full', path, size: verified.size, diff: verified.diff, probeFraction };
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
        const captured = await captureTab({
            browser,
            context,
            tab,
            wideColor: PROBE_COLORS[WIDE_COLOR + TABS.indexOf(tab)],
            narrowColor: PROBE_COLORS[NARROW_COLOR + TABS.indexOf(tab)],
        });

        results.push(...captured);
        for (const result of captured) {
            report(result);
        }
    }

    if (includeFull) {
        const full = await captureFull({
            browser,
            context,
            tab: TABS[0],
            probeColor: PROBE_COLORS[FULL_COLOR],
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
        previousByWidth: new Map(),
    };

    writeLine(
        `freshness: sentinel probe, strip and width read-back, same-width diff — ${context.url}`,
    );

    try {
        const results = await runCapture({ browser, context, tabs, includeFull: options.full });
        writeLine(`captured ${results.length} images in ${options.outDir}`);
    } finally {
        await restoreHarness(browser);
        await browser.close();
        await server.close();
    }
}

const isInvokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isInvokedDirectly) {
    main().catch((error) => {
        writeError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
