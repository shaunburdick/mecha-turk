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
import { readFileSync } from 'node:fs';
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
import { DARK, FALLBACK, FIXTURES, LIGHT } from './theme-fixtures.js';
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
 * The harness fixture document, read once for the scene table.
 *
 * A scene's **delta** lives in `fixtures.json`, not here: the harness fetches
 * that document itself and merges the delta over it in the browser, so a copy of
 * the delta in this file would be a second spelling of a fixture that could
 * drift from the one actually served. Only the *names* are needed here — to
 * advertise `--scene` and to refuse an unknown one before a browser is opened —
 * and reading them from the same file is what keeps the usage line and the
 * harness's own table in step.
 *
 * @returns Scene name to its fixture record.
 */
function readScenes() {
    const document_ = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures.json'), 'utf8'));

    return document_.scenes ?? {};
}

/** Every scene the fixture document defines, in name order. */
const SCENES = readScenes();

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

/**
 * Which host fixture the run paints from.
 *
 * `light` and `dark` are the two supported host themes, each a complete token payload;
 * `fallback` is the post-`ready` state where the SDK's aliases are removed again and the
 * panel's own fallbacks resolve. It is read once, right after boot, so a run photographs one
 * fixture rather than switching halfway through its own freshness chain — the sentinel colours,
 * the strip read-back, and the per-width diff all assume a single painted document per run.
 */
const DEFAULT_FIXTURE = 'light';

/**
 * The fixtures a capture run may paint from: the two supported host themes.
 *
 * The alias-unavailable fixture is deliberately absent — see `selectFixture`, which refuses it
 * by name and says why rather than quietly photographing a frame whose selection it cannot
 * verify.
 */
const PHOTOGRAPHABLE = [LIGHT, DARK];

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
    `       scenes: ${Object.keys(SCENES).join(', ') || 'none'} (--scene NAME; default: the base fixture)`,
    `       fixtures: ${PHOTOGRAPHABLE.join(', ')} (--fixture NAME; default: ${DEFAULT_FIXTURE})`,
    `                 ${FALLBACK} is measured through the harness, never photographed: its selected`,
    '                 tab has no host-painted fill for the strip read-back to sample',
    '       flags: --no-full (skip panel-full.png), --session NAME, --help',
    `       every tab is captured at ${DEFAULT_WIDTH}px (or --width) and again at ${NARROW_WIDTH}px`,
    `       as panel-<tab>-narrow.png; --width ${NARROW_WIDTH} or narrower skips the second frame`,
    '       a --scene run writes panel-<tab>-<scene>.png, and captures the named tabs only',
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
 * Resolve a requested fixture, refusing anything unknown, and refusing the fallback.
 *
 * `light` and `dark` are photographable; **`fallback` is not**, and the reason is a property of
 * the fixture rather than a gap in this tool. The strip read-back samples the fill of the
 * *selected* tab and compares it with the colour the cascade reports — that is what proves a
 * frame is not the previous tab's. In the fallback frame the SDK's selected-tab fill resolves
 * through an alias that has been removed on purpose, so there is no fill to sample and no proof
 * to make. The alternative would be to weaken or skip that check for one fixture, which is the
 * one thing this run's machinery exists to prevent; so the fallback is measured (`__MT__.
 * applyFixture('fallback')` and `hostThemeReport()`, driven from the accessibility suite and
 * from M-003's review) rather than photographed.
 *
 * Refused at the command line for the same reason a scene is: an unknown name would otherwise
 * boot the base light fixture and write its frames under the name asked for — a picture of the
 * wrong document published as the requested one.
 *
 * @param name - The fixture asked for.
 * @returns The fixture's name.
 * @throws {Error} On an unknown name, or on `fallback`.
 */
function selectFixture(name) {
    if (!FIXTURES.includes(name)) {
        throw new Error(`unknown fixture "${name}" — try: ${FIXTURES.join(', ')}`);
    }
    if (name === FALLBACK) {
        throw new Error(
            'the alias-unavailable fixture is measured, not photographed: its selected tab has no ' +
                'host-painted fill, so the strip read-back has nothing to sample and capturing it ' +
                `would mean weakening that check. Apply it through __MT__.applyFixture("${
                    FALLBACK
                }") and read __MT__.hostThemeReport() instead.`,
        );
    }

    return name;
}

/**
 * Resolve a requested scene, refusing anything unknown.
 *
 * Refused here rather than passed through: an unknown name reaching the harness
 * would either boot the base document — publishing a picture of the *wrong*
 * frame, under this scene's filename — or fail with a browser-side message that
 * names no scene at all.
 *
 * @param name - The scene asked for.
 * @returns The scene's name.
 * @throws {Error} When no such scene exists.
 */
function selectScene(name) {
    if (!Object.hasOwn(SCENES, name)) {
        throw new Error(
            `unknown scene "${name}" — try: ${Object.keys(SCENES).join(', ') || 'none defined'}`,
        );
    }

    return name;
}

/**
 * The options that take a value, and how each one lands in the options object.
 *
 * A table rather than a branch per option: `parseArgs` steps one value at a
 * time, and one `if` per value option is what pushed it past the complexity
 * this codebase allows — a fifth of them did. `--scene` differs only in being
 * **validated** as it is read.
 *
 * A `Map` because the keys are protocol tokens — command-line flags — which are
 * not names this codebase is free to spell, and which a plain object would also
 * answer from the prototype chain (`--constructor` is not an option).
 */
const VALUE_OPTIONS = new Map([
    ['--out', (options, value) => {
        options.outDir = value;
    }],
    ['--width', (options, value) => {
        options.width = Number(value);
    }],
    ['--max-height', (options, value) => {
        options.maxHeight = Number(value);
    }],
    ['--session', (options, value) => {
        options.session = value;
    }],
    ['--scene', (options, value) => {
        options.scene = selectScene(value);
    }],
    ['--fixture', (options, value) => {
        options.fixture = selectFixture(value);
    }],
]);

/** The options that are switches, and what each one sets. */
const FLAG_OPTIONS = new Map([
    ['--no-full', (options) => {
        options.full = false;
    }],
    ['--help', (options) => {
        options.help = true;
    }],
]);

/**
 * Read the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns `{ tabs, outDir, width, maxHeight, session, scene, fixture, full, help }`.
 */
function parseArgs(argv) {
    const options = {
        tabs: [],
        outDir: DEFAULT_OUT_DIR,
        width: DEFAULT_WIDTH,
        maxHeight: DEFAULT_MAX_HEIGHT,
        session: undefined,
        scene: null,
        fixture: DEFAULT_FIXTURE,
        full: true,
        help: false,
    };

    // `index` is stepped by hand for the options that take a value, so each one
    // that consumes the next argument advances it and lands in the table's own
    // writer rather than repeating the same branch five times over.
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];

        const takesValue = VALUE_OPTIONS.get(argument);
        if (takesValue !== undefined) {
            takesValue(options, optionValue(argv, index));
            index++;

            continue;
        }

        const flag = FLAG_OPTIONS.get(argument);
        if (flag !== undefined) {
            flag(options);

            continue;
        }

        if (argument.startsWith('-')) {
            throw new Error(`unknown option ${argument}\n${USAGE}`);
        }

        options.tabs.push(argument);
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
 * @returns One result per frame captured, in capture order.
 */
async function captureTab(input) {
    const { browser, context, tab, wideColor, narrowColor, scene } = input;
    const stem = `panel-${tab.id}${scene === null ? '' : `-${scene}`}`;

    await activateTab({ browser, tab, refs: context.refs });

    const captured = [
        await captureFrame({
            browser,
            context,
            tab,
            width: context.width,
            probeColor: wideColor,
            name: stem,
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
                name: `${stem}-narrow`,
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
    const { browser, context, tabs, includeFull, scene } = input;

    await browser.close();
    await openHarness(browser, context.url);
    await browser.setViewport({ width: context.width, height: SANITY_HEIGHT });
    await waitForBoot(browser);

    /*
     * The fixture is applied once, after boot and before the first probe, because the run's
     * whole freshness chain assumes one painted document: applying it per capture would let a
     * later frame differ from the previous one purely because the theme changed, and the
     * same-width diff could no longer tell a stale bitmap from a real edit.
     */
    const fixture = String(await browser.evaluate(`__MT__.applyFixture('${context.fixture}')`));
    const theme = JSON.parse(String(await browser.evaluate('JSON.stringify(__MT__.hostThemeReport())')));

    writeLine(
        `fixture ${fixture}: ${theme.inlineAliases.length} host alias(es) inline, ` +
            `${theme.computedAliases.length} computed, color-scheme ${theme.colorScheme || 'none'}`,
    );

    const bootFraction = await probe({
        browser,
        path: join(context.outDir, '.probe-boot.png'),
        color: PROBE_COLORS[0],
    });
    writeLine(`capture path verified: ${percent(bootFraction)} of the probe frame is the sentinel colour`);

    context.refs = await browser.snapshotTabs();
    const results = [];

    for (const tab of tabs) {
        // The tab's **own** wide and narrow colours, reused as they are: a scene
        // is its own process, so the per-width freshness chain starts empty and
        // `verifyDelivered` refuses any frame carrying a probe colour — no new
        // colour, index arithmetic, or diff rule is needed to keep that proof.
        const captured = await captureTab({
            browser,
            context,
            tab,
            wideColor: PROBE_COLORS[WIDE_COLOR + TABS.indexOf(tab)],
            narrowColor: PROBE_COLORS[NARROW_COLOR + TABS.indexOf(tab)],
            scene,
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
    const { scene } = options;
    const tabs = selectTabs(options.tabs);
    // A scene captures the tabs it was asked about and nothing else: a
    // full-height frame of a different scene would be a picture of the base
    // document wearing the scene's filename, which is the one thing a scene must
    // never publish.
    const includeFull = options.full && scene === null;
    await mkdir(options.outDir, { recursive: true });

    const server = await startServer({ port: 0 });
    const browser = createBrowser({ session: options.session });
    const query = scene === null ? '' : `?scene=${scene}`;
    const context = {
        outDir: options.outDir,
        width: options.width,
        maxHeight: options.maxHeight,
        probeColors: PROBE_COLORS,
        url: `${server.url}/tools/visual/index.html${query}`,
        fixture: options.fixture,
        refs: {},
        previousByWidth: new Map(),
    };

    writeLine(
        `freshness: sentinel probe, strip and width read-back, same-width diff — ${context.url}`,
    );
    if (scene !== null) {
        writeLine(`scene ${scene}: ${SCENES[scene].summary ?? 'no summary'}`);
    }

    try {
        const results = await runCapture({ browser, context, tabs, includeFull, scene });
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
    try {
        await main();
    } catch (error) {
        writeError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
