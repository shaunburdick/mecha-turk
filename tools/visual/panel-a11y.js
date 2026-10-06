/**
 * The panel's rendered accessibility evidence, across all three host fixtures.
 *
 * 005 M-003 is a review, and this is the part of it that can be re-run: it boots the same offline
 * harness `npm run shot` uses, puts the panel into each of the three fixtures — host light, host
 * dark, and the alias-unavailable frame — at each of the widths the review covers, walks the six tabs
 * with the keyboard, and records what a reader would meet.
 *
 * ## What it records
 *
 * - **Roles and names.** Every strip button's role and accessible name, and every focused control's.
 * - **Tab/body association.** Each body names the tab it belongs to, and the body the cascade paints
 *   is the selected tab's body.
 * - **Visible focus.** Per stop, an indicator in whichever form the panel draws it — an outline, or
 *   the SDK's `box-shadow` ring, which is what every text field in this panel uses — and the focused
 *   element not covered by anything else, probed inside its own box, which is what WCAG 2.2 SC 2.4.11
 *   asks about.
 * - **Reach at rail widths.** Every primary action inside the frame, the body region scrolling only
 *   vertically, and nothing clipped out of it.
 * - **State as text.** Every badge the panel paints state through carries words, not only a colour.
 *
 * ## The fallback fixture is measured, never photographed
 *
 * `shot.js` refuses `--fixture fallback` by name and says why: the strip read-back samples the
 * selected tab's painted fill, and in that frame there is none, so photographing it would mean
 * weakening a freshness proof. This tool does not photograph anything, so the frame is measured
 * here instead — `__MT__.applyFixture('fallback')` then `__MT__.hostThemeReport()` — and the aliases
 * it is supposed to have lost are asserted absent before anything is read from the frame.
 *
 * ## Kept apart from the automated contrast evidence
 *
 * `tests/panel-theme-contrast.test.ts` measures the panel's colours from the shipped stylesheet in
 * all three fixtures. This tool never computes a contrast ratio: it records what the browser paints
 * and what a keyboard reaches. The two reports are separate artefacts for that reason, and a reader
 * comparing them is comparing two independent measurements rather than one number twice.
 *
 * Usage: `node tools/visual/panel-a11y.js [--out DIR] [--width PX] [--session NAME] [--help]`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateTab, openHarness, waitForBoot } from './boot.js';
import { createBrowser } from './browser.js';
import { startServer } from './serve.js';
import { DARK, FALLBACK, LIGHT } from './theme-fixtures.js';

/** Repository root, derived from this file's location. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default output folder for the report. */
const DEFAULT_OUT = join(ROOT, 'screenshots', 'panel-a11y');

/** Session name a run isolates itself in. */
const DEFAULT_SESSION = 'mt-panel-a11y';

/** The widths the review covers: the tight end of the rail band, and the narrowest it may be given. */
const WIDTHS = [
    { name: 'narrow', width: 560, height: 900 },
    { name: 'narrowest', width: 320, height: 900 },
];

/** The six tabs, in the strip's own order: the id a body is named for, and the label a reader reads. */
const TABS = [
    { id: 'status', label: 'Status' },
    { id: 'dispatches', label: 'Dispatches' },
    { id: 'bindings', label: 'Bindings' },
    { id: 'accounts', label: 'Accounts' },
    { id: 'settings', label: 'Settings' },
    { id: 'about', label: 'About' },
];

/** Keystrokes one tab's focus order may contain before the walk calls it exhausted. */
const MAX_STOPS = 120;

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

/** Report a line on stderr. */
function writeError(text) {
    process.stderr.write(`${text}\n`);
}

/**
 * The focus half of the panel reading: where the focused control sits, whether anything covers it,
 * and which of the two indicator forms it draws.
 *
 * It is its own fragment because it is the only part of the reading a keyboard stop needs, and the
 * only part that changes when the panel gains a control; kept inside `panelExpression` it pushed
 * the whole expression past the length a single named step is allowed to be.
 *
 * `@openchamber/sdk` draws its focus ring as a box-shadow and sets outline to none, so **both**
 * halves of the indicator are read: a tool that read only the outline would report every input in
 * the panel as having no visible indicator — the check failing on the primitive's own way of
 * drawing one rather than on the panel.
 *
 * The fragment is interpolated verbatim into `panelExpression`, so it may not contain a backtick or
 * a `${`; the panel's own copy arrives through string concatenation for that reason.
 */
const FOCUS_READING = String.raw`
    const focusRect = active === null || active === panel.body ? null : active.getBoundingClientRect();
    const focusStyle = active === null || active === panel.body ? null : view.getComputedStyle(active);
    const covered = focusRect === null || frame === null
        ? false
        : [
              [focusRect.left + focusRect.width / 2, focusRect.top + focusRect.height / 2],
              [focusRect.left + 1, focusRect.top + 1],
              [focusRect.right - 1, focusRect.bottom - 1],
          ].some(([x, y]) => {
              const hit = panel.elementFromPoint(x, y);

              return hit !== null && hit !== active && !active.contains(hit) && !hit.contains(active);
          });
    const focus = focusRect === null
        ? null
        : {
              covered,
              inFrame: focusRect.left >= frame.left - 1 && focusRect.right <= frame.right + 1,
              name: (active.getAttribute('aria-label') ?? active.textContent ?? '')
                  .trim()
                  .replace(/\s+/gu, ' ')
                  .slice(0, 40),
              indicator: {
                  boxShadow: focusStyle.boxShadow,
                  outline: {
                      color: focusStyle.outlineColor,
                      style: focusStyle.outlineStyle,
                      width: focusStyle.outlineWidth,
                  },
              },
              role: active.getAttribute('role') ?? active.tagName.toLowerCase(),
              tag: active.tagName.toLowerCase(),
          };
`;

/**
 * The expression that reads the shell, one tab body, and the focused element.
 *
 * Everything M-003 asks of the panel is in here, so a tab's evidence is one round trip: the strip's
 * roles and names, the association between each body and its tab, the body the cascade actually
 * paints, every badge's text, whether anything inside the region scrolls sideways, and whether the
 * focused control is fully inside the region and not covered.
 *
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
function panelExpression() {
    return String.raw`(() => {
    const frame0 = window.document.querySelector('iframe');
    const panel = frame0 === null ? null : frame0.contentDocument;
    const view = window;
    if (panel === null) {
        return JSON.stringify({ panel: false });
    }
    const region = panel.querySelector('[data-body-region]');
    const root = panel.querySelector('#root');
    const selected = panel.querySelector('[role="tab"][aria-selected="true"]');
    const active = panel.activeElement;
    const badges = [...panel.querySelectorAll('.oc-sdk-badge')].map((el) => ({
        empty: el.textContent.trim() === '',
        text: el.textContent.trim().slice(0, 40),
    }));
    const controls = [...panel.querySelectorAll('button, input, select, summary, [role="tab"], a')];
    /*
     * The frame is the whole panel, not the body region: the strip sits above the region and is its
     * own horizontal scroller, so a strip button that has been scrolled partly out of view is a
     * control the reader can still reach by scrolling, not one that reaches outside the panel.
     */
    const frame = root === null ? null : root.getBoundingClientRect();
    const clipped = frame === null
        ? []
        : controls
            .filter((el) => {
                const rect = el.getBoundingClientRect();

                return (
                    el.getClientRects().length > 0 &&
                    (rect.left < frame.left - 1 || rect.right > frame.right + 1) &&
                    view.getComputedStyle(el).visibility !== 'hidden'
                );
            })
            .map(
                (el) =>
                    el.tagName.toLowerCase() +
                    ': ' +
                    (el.textContent ?? '')
                        .trim()
                        .replace(/\s+/gu, ' ')
                        .slice(0, 30),
            );
    ${FOCUS_READING}

    return JSON.stringify({
        panel: true,
        badges: { empty: badges.filter((badge) => badge.empty).length, total: badges.length },
        bodies: [...panel.querySelectorAll('[data-body]')].map((body) => ({
            hidden: body.hasAttribute('hidden'),
            labelledBy: body.getAttribute('aria-labelledby'),
            painted: view.getComputedStyle(body).display !== 'none',
            tab: (body.getAttribute('aria-labelledby') ?? '').replace('oc-tab-', ''),
        })),
        clipped,
        focus,
        region: region === null ? null : {
            clientWidth: Math.round(region.clientWidth),
            scrollWidth: Math.round(region.scrollWidth),
            scrollsSideways: region.scrollWidth > region.clientWidth,
        },
        root: root === null ? null : { height: Math.round(root.getBoundingClientRect().height) },
        selected: selected === null ? null : {
            id: selected.id,
            label: (selected.getAttribute('aria-label') ?? selected.textContent ?? '').trim(),
            role: selected.getAttribute('role'),
        },
        strip: [...panel.querySelectorAll('[role="tab"]')].map((tab) => ({
            id: tab.id,
            name: (tab.getAttribute('aria-label') ?? tab.textContent ?? '').trim(),
            role: tab.getAttribute('role'),
        })),
        tabbables: panel.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, ' +
                '[role="tab"], [tabindex]:not([tabindex="-1"])',
        ).length,
    });
})()`;
}

/**
 * Press `Tab` until the focus order is exhausted, reading each stop.
 *
 * @param {object} input `{ browser }`.
 * @returns {Promise<object[]>} Every stop, in the order the keyboard reached it.
 */
async function walkFocus(input) {
    const { browser } = input;
    const stops = [];
    let first = null;

    for (let press = 0; press < MAX_STOPS; press += 1) {
        await browser.run(['press', 'Tab']);
        const answer = await browser.evaluate(panelExpression());
        const reading = JSON.parse(String(answer));

        if (reading.panel === false || reading.focus === null) {
            break;
        }
        const key = `${reading.focus.tag}|${reading.focus.name}|${reading.focus.role}`;

        if (key === first) {
            break;
        }
        first ??= key;
        stops.push(reading.focus);
    }

    return stops;
}

/** Every strip button is a tab, and every tab has a name a reader would say out loud. */
function stripFindings(strip, where) {
    const findings = [];

    for (const entry of strip) {
        if (entry.role !== 'tab' || entry.name === '') {
            findings.push(`${where}: a strip button has role "${entry.role}" and name "${entry.name}"`);
        }
    }

    return findings;
}

/** Exactly one body painted, and it is this tab's; every body names the tab it belongs to. */
function bodyFindings(bodies, tab, where) {
    const findings = [];
    const painted = bodies.filter((body) => body.painted && !body.hidden);
    const labelled = bodies.filter((body) => body.labelledBy !== null && body.labelledBy !== '');

    if (painted.length !== 1 || painted[0]?.tab !== tab) {
        findings.push(
            `${where}: ${painted.length} body/bodies are painted, and the one that is names "${painted[0]?.tab}"`,
        );
    }
    if (labelled.length !== bodies.length) {
        findings.push(`${where}: ${bodies.length - labelled.length} tab body/bodies name no tab`);
    }

    return findings;
}

/** The body region never scrolls sideways — the strip above it is the one that may. */
function regionFindings(region, where) {
    if (region === null || !region.scrollsSideways) {
        return [];
    }

    return [
        `${where}: the body region scrolls sideways (${region.scrollWidth} > ${region.clientWidth})`,
    ];
}

/** No control reaches outside the panel frame, and no state badge is empty. */
function clippedFindings(clipped, where) {
    return clipped.map((control) => `${where}: "${control}" reaches outside the panel`);
}

/** A badge with no text carries no state. */
function badgeFindings(badges, where) {
    if (badges.empty === 0) {
        return [];
    }

    return [`${where}: ${badges.empty} of ${badges.total} state badge(s) carry no text`];
}

/**
 * Whether a `box-shadow` paints a ring.
 *
 * Only the offsets and blur after the first colour layer are read, because a colour is allowed to
 * end in `px`-free numbers and the spread can legitimately be zero; what is being asked is whether
 * anything is drawn *beyond* the element's own box.
 *
 * @param {string} shadow - The computed `box-shadow` value.
 * @returns {boolean} True when at least one length in the ring is non-zero.
 */
export function ringIsPainted(shadow) {
    if (shadow === 'none') {
        return false;
    }
    const ring = shadow.slice(shadow.indexOf(')') + 1);

    return /\b(?!0(?:px)?\b)[1-9]\d*px\b/u.test(ring);
}

/** Every focus stop draws an indicator, uncovered, inside the frame. */
function stopFindings(stops, where) {
    const findings = [];

    for (const stop of stops) {
        /*
         * An indicator is an outline with a width, or a box-shadow that paints one. The colour is
         * not matched by name: the SDK resolves the host's focus token, and a host may express it
         * as `oklab()` rather than `rgb()`, so a spelling test would report every input in the panel
         * as having no indicator in one host theme and having one in another.
         */
        const { outline } = stop.indicator;
        const hasOutline = outline.style !== 'none' && Number.parseFloat(outline.width) > 0;
        const hasRing = ringIsPainted(stop.indicator.boxShadow);

        if (!hasOutline && !hasRing) {
            findings.push(
                `${where}: "${stop.name}" is focused with neither an outline nor a focus ring ` +
                    `(outline ${outline.style} ${outline.width}, ` +
                    `box-shadow ${stop.indicator.boxShadow})`,
            );
        }
        if (stop.covered) {
            findings.push(`${where}: something covers "${stop.name}" while it holds focus`);
        }
        if (!stop.inFrame) {
            findings.push(`${where}: "${stop.name}" holds focus outside the panel frame`);
        }
    }

    return findings;
}

/** Every claim this tool makes about one (fixture, width, tab). */
function review(input) {
    const { reading, stops, tab } = input;
    const where = `${input.fixture} ${input.width}px ${tab}`;
    const findings = [
        ...stripFindings(reading.strip, where),
        ...bodyFindings(reading.bodies, tab, where),
        ...regionFindings(reading.region, where),
        ...clippedFindings(reading.clipped, where),
        ...badgeFindings(reading.badges, where),
        ...stopFindings(stops, where),
    ];

    return {
        badges: reading.badges,
        findings,
        clipped: reading.clipped,
        controls: reading.clipped.length,
        fixture: input.fixture,
        region: reading.region,
        stops,
        strip: reading.strip,
        tab,
        tabbables: reading.tabbables,
        width: input.width,
    };
}

/**
 * Walk every tab at every width in one fixture.
 *
 * @returns {Promise<object[]>} One review per (width, tab).
 */
async function reviewFixture(input) {
    const { browser, fixture, refs, tabs } = input;
    const applied = String(await browser.evaluate(`__MT__.applyFixture('${fixture}')`));
    const theme = JSON.parse(String(await browser.evaluate('JSON.stringify(__MT__.hostThemeReport())')));
    const reviews = [];
    const fixtureFindings = [];

    if (fixture === FALLBACK) {
        /*
         * The fixture's whole claim is that the aliases are gone and the panel's own fallbacks are
         * what resolve. Asserted here, from the live document, before anything is read from the
         * frame: a fallback that still had the host's tokens would measure the host's colours and
         * call them the panel's.
         */
        if (theme.inlineAliases.length > 0 || theme.computedAliases.length > 0) {
            fixtureFindings.push(
                `${applied}: ${theme.inlineAliases.length} inline and ${theme.computedAliases.length} computed host ` +
                    'alias(es) survive; the frame is not the alias-unavailable one',
            );
        }
        if (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark') {
            fixtureFindings.push(`${applied}: the frame kept no color-scheme, so its canvas is the browser default`);
        }
    }

    for (const width of WIDTHS) {
        await browser.setViewport({ height: width.height, width: width.width });

        for (const tab of tabs) {
            await activateTab({ browser, tab: { label: tab.label }, refs });
            const answer = await browser.evaluate(panelExpression());
            const reading = JSON.parse(String(answer));

            if (reading.panel === false) {
                throw new Error('the harness frame is not reachable, so there is no panel to review');
            }
            const stops = await walkFocus({ browser });
            const reviewed = review({
                findings: [],
                fixture: applied,
                reading,
                stops,
                tab: tab.id,
                width: width.width,
            });

            reviews.push(reviewed);
            fixtureFindings.push(...reviewed.findings);
        }
    }

    return { applied, findings: fixtureFindings, reviews, theme };
}

/**
 * Run every fixture, judge the answers, and leave the report behind.
 *
 * @param {string[]} argv - The command line, without the script name.
 * @returns {Promise<number>} Zero when nothing failed; one otherwise.
 */
export async function main(argv) {
    if (argv.includes('--help')) {
        writeLine(
            [
                'usage: node tools/visual/panel-a11y.js [--out DIR] [--session NAME] [--help]',
                `       fixtures: ${[LIGHT, DARK, FALLBACK].join(', ')} — every one is measured`,
                `       widths: ${WIDTHS.map((entry) => `${entry.name} ${entry.width}px`).join(', ')}`,
                '       every tab is activated and walked with Tab at each width in each fixture',
            ].join('\n'),
        );

        return 0;
    }
    const outIndex = argv.indexOf('--out');
    const sessionIndex = argv.indexOf('--session');
    const outDir = outIndex === -1 ? DEFAULT_OUT : resolve(String(argv[outIndex + 1]));
    const session = sessionIndex === -1 ? DEFAULT_SESSION : String(argv[sessionIndex + 1]);

    await mkdir(outDir, { recursive: true });

    const server = await startServer({ port: 0 });
    const browser = createBrowser({ session });
    const fixtures = [];
    const findings = [];

    try {
        await browser.setViewport({ height: 900, width: WIDTHS[0].width });
        await openHarness(browser, `${server.url}/tools/visual/index.html`);
        await waitForBoot(browser);

        const refs = await browser.snapshotTabs();

        for (const fixture of [LIGHT, DARK, FALLBACK]) {
            const measured = await reviewFixture({
                browser,
                fixture,
                refs,
                tabs: TABS,
            });

            fixtures.push(measured);
            findings.push(...measured.findings);
            const inline = measured.theme.inlineAliases.length;
            const computed = measured.theme.computedAliases.length;

            writeLine(
                `${measured.applied}: ${inline} inline / ${computed} computed host aliases, ` +
                    `${measured.reviews.length} tab reviews, ${measured.findings.length} findings`,
            );
        }
    } finally {
        await browser.close();
        await server.close();
    }

    for (const finding of findings) {
        writeError(`panel-a11y: ${finding}`);
    }

    const path = join(outDir, 'report.json');

    await writeFile(path, `${JSON.stringify({ fixtures, summary: { findings: findings.length } }, null, 4)}\n`);
    writeLine(`panel-a11y: ${fixtures.length} fixtures, ${findings.length} findings — ${path}`);

    return findings.length > 0 ? 1 : 0;
}

const isInvokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isInvokedDirectly) {
    process.exitCode = await main(process.argv.slice(2)).catch((error) => {
        writeError(`panel-a11y: ${error instanceof Error ? error.message : String(error)}`);

        return 1;
    });
}
