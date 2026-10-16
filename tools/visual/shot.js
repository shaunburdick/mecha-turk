/**
 * Capture one PNG per panel tab at its real width, twice, and prove every frame is current
 * (`npm run shot`): sentinel probe, strip read-back, visible-body read-back, width read-back and
 * same-width diff — five independent answers to "is this the picture I just asked for?", any of
 * which aborts a stale run.
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
import { tabs as TABS } from './tabs.js';
import { DARK, FALLBACK, FIXTURES, LIGHT } from './theme-fixtures.js';
import { percent, verifyDelivered, verifyProbe } from './verify.js';

/**
 * Sentinel colours: 0 proves the capture path, 1–7 a default-width tab, 8–14 the same tab at the
 * narrow width, 15 the full page — one per capture so a probe from an earlier step cannot
 * masquerade as the frame just asked for, and `verifyDelivered` refuses a delivered image
 * carrying *any* of them.
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
    '#b8860b',
    '#9400d3',
];

/** Sentinel colour for a tab's default-width frame (1–7). */
const WIDE_COLOR = 1;

/** Sentinel colour for a tab's narrow frame, `WIDE_COLOR + tabs` apart. */
const NARROW_COLOR = WIDE_COLOR + TABS.length;

/** Sentinel colour for the full-height frame, past both tab bands. */
const FULL_COLOR = WIDE_COLOR + 2 * TABS.length;

/**
 * The harness fixture document, read once for the scene table. A scene's **delta** lives in
 * `fixtures.json`, which the harness merges itself, so only the *names* are needed here — to
 * advertise `--scene` and refuse an unknown one before a browser is opened — and reading them
 * from the same file keeps the usage line and the harness's table in step.
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
 * The default capture width: the width the host really gives a rail panel, not a desktop window
 * (read 2026-10-01, not estimated). Extension panels are `plugin:<id>` context surfaces, whose
 * `defaultWidthFraction` is **0.45** of the available content region, clamped between
 * `CONTEXT_PANEL_MIN_WIDTH` (320) and `region − CONTEXT_CHAT_MIN_WIDTH` (400): ≈500px at 1440 and
 * ≈715px at 1920. 720 is the top of that computed band and exactly 50% of a 1440 screen — the
 * product owner's own phrasing — so `NARROW_WIDTH` covers the rest.
 */
const DEFAULT_WIDTH = 720;

/**
 * The tight end of the same band, captured beside the default frame as `panel-<tab>-narrow.png`:
 * 560 is the host's default on a 1440 screen (≈500px, rounded onto the stylesheet's lower
 * breakpoint) — where a column grid that reads as columns at 720 either still fits or has to
 * stack. Skipped only when the default frame is already this narrow or narrower.
 */
const NARROW_WIDTH = 560;

/** Short viewport used before the full-height capture stretches the page. */
const SANITY_HEIGHT = 1_000;

/**
 * Which host fixture the run paints from: `light` and `dark` are the two supported host themes,
 * each a complete token payload; `fallback` is the post-`ready` state where the SDK's aliases are
 * removed again. Read once, right after boot, so a run photographs one fixture — the sentinel
 * colours, the strip read-back and the per-width diff all assume a single painted document.
 */
const DEFAULT_FIXTURE = 'light';

/**
 * The fixtures a capture run may paint from: the two supported host themes. The
 * alias-unavailable fixture is deliberately absent — `selectFixture` refuses it by name and says
 * why rather than photographing a frame whose selection it cannot verify.
 */
const PHOTOGRAPHABLE = [LIGHT, DARK];

/** Tallest viewport the run will ask for before it gives up on a tab. */
const DEFAULT_MAX_HEIGHT = 6_000;

/** Where captures land unless `--out` says otherwise: the repo-root `screenshots/`, git-ignored. */
const DEFAULT_OUT_DIR = join(import.meta.dirname, '..', '..', 'screenshots');

/** Usage the `--help` flag prints. */
const USAGE = [
    'usage: node tools/visual/shot.js [tab …] [--out DIR] [--width PX] [--max-height PX]',
    `       tabs: ${TABS.map((entry) => entry.id).join(', ')} (default: all tabs)`,
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
 * Resolve a requested fixture, refusing anything unknown and refusing the fallback. In the
 * fallback frame the SDK's selected-tab fill resolves through an alias removed on purpose, so the
 * strip read-back — which samples that fill to prove a frame is not the previous tab's — has
 * nothing to sample; weakening or skipping that check for one fixture is the one thing this
 * run's machinery exists to prevent, so the fallback is *measured* (`__MT__.applyFixture(
 * 'fallback')` with `hostThemeReport()`, from the accessibility suite and M-003's review) rather
 * than photographed. Refused at the command line like an unknown scene, which would otherwise
 * boot the base light fixture and write its frames under the name asked for.
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
 * Resolve a requested scene, refusing anything unknown. Refused here rather than passed through:
 * an unknown name reaching the harness would boot the base document and publish a picture of the
 * *wrong* frame under this scene's filename, or fail with a browser-side message that names no
 * scene at all.
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
 * The options that take a value, and how each lands in the options object — a table rather than a
 * branch per option: one `if` per value option is what pushed `parseArgs` past the complexity
 * this codebase allows. `--scene` differs only in being **validated** as it is read. A `Map`
 * because the keys are protocol tokens this codebase is not free to spell, and a plain object
 * would also answer `--constructor` from the prototype chain.
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

/** Read the command line: `{ tabs, outDir, width, maxHeight, session, scene, fixture, full, help }`. */
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

    // `index` is stepped by hand so each value option consumes the next argument and lands in the
    // table's own writer rather than repeating the same branch five times over.
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
 * Capture one tab at one width: fit the viewport, probe, capture, verify. The freshness chain
 * advances here rather than in the caller — the image just delivered becomes the previous frame
 * *for its width*, so the next frame at that width has to differ from it, and a frame delivered
 * at the wrong width fails on its own read-back instead.
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
     * The freshness chain is per width, not global: the previous frame at *this* width is the one
     * a re-emitted bitmap would repeat, and it is the only comparison whose overlap means anything
     * — 720px and 560px of one content are mostly shared background. The width itself is asserted
     * separately (`expectedWidth`), which catches a resize that never reached the capture.
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
 * Capture one tab: its frame at the default (or `--width`) width, then the narrow frame beside
 * it, so the tight end of the panel's real width band is always on disk next to the comfortable
 * one.
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
 * Capture the whole panel at its full scroll height, strip included. The tab is selected first:
 * the tab captures leave the last one active, so measuring any other body would measure a box
 * that is not there.
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
     * The fixture is applied once, after boot and before the first probe: the freshness chain
     * assumes one painted document, and applying it per capture would let the same-width diff call
     * a theme change a stale bitmap.
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
        // The tab's **own** wide and narrow colours, reused as they are: a scene is its own
        // process, so the per-width chain starts empty and `verifyDelivered` refuses any frame
        // carrying a probe colour — no new colour, index arithmetic or diff rule needed.
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
    // A scene captures the tabs it was asked about and nothing else: a full-height frame of a
    // different scene would be a picture of the base document wearing the scene's filename.
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
