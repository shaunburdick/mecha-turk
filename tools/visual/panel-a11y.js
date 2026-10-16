/**
 * The panel's rendered accessibility evidence, across all three host fixtures — the re-runnable
 * part of review 005 M-003. It boots the offline harness `npm run shot` uses, puts the panel into
 * host light, host dark and the alias-unavailable frame at each width the review covers, walks the
 * tabs with the keyboard, and records roles and names, tab/body association, visible focus
 * (the SDK's `box-shadow` ring included), reach at rail widths, and state as text. The fallback
 * frame is *measured*, never photographed — `shot.js` refuses it by name because its strip
 * read-back has no fill to sample — and its lost aliases are asserted absent before any reading.
 * This tool computes no contrast ratio: it records roles, names, focus and reach, and draws no
 * conclusion of its own about colour.
 * Usage: `node tools/visual/panel-a11y.js [--out DIR] [--width PX] [--session NAME] [--help]`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateTab, openHarness, waitForBoot } from './boot.js';
import { createBrowser } from './browser.js';
import { startServer } from './serve.js';
import { tabs as TABS } from './tabs.js';
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
 * The focus half of the panel reading: where the focused control sits, whether anything covers
 * it, and which of the two indicator forms it draws. Its own fragment because it is the only part
 * a keyboard stop needs and the only part that changes when the panel gains a control — inside
 * `panelExpression` it pushed the whole expression past the length one named step may be.
 * `@openchamber/sdk` draws its ring as a box-shadow with outline none, so **both** halves are
 * read: an outline-only tool would report every input as having no visible indicator. The
 * fragment is interpolated verbatim, so it may not contain a backtick or a `${`; the panel's own
 * copy arrives through string concatenation for that reason.
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
 * The expression that reads the shell, one tab body, and the focused element: everything M-003
 * asks of the panel in one round trip — the strip's roles and names, each body's tab association,
 * the body the cascade actually paints, every badge's text, sideways scroll inside the region, and
 * whether the focused control is fully inside the region and not covered.
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
     * own horizontal scroller, so a partly scrolled strip button is still reachable by scrolling.
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

/** Press `Tab` until the focus order is exhausted, reading each stop. */
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
 * Whether a `box-shadow` paints a ring. Only the offsets and blur after the first colour layer
 * are read — a colour may end in `px`-free numbers and the spread can legitimately be zero —
 * because the question is whether anything is drawn *beyond* the element's own box.
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
         * not matched by name: the SDK resolves the host's focus token, which a host may express
         * as `oklab()`, so a spelling test would flip with the host theme.
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

/** Walk every tab at every width in one fixture. */
async function reviewFixture(input) {
    const { browser, fixture, refs, tabs } = input;
    const applied = String(await browser.evaluate(`__MT__.applyFixture('${fixture}')`));
    const theme = JSON.parse(String(await browser.evaluate('JSON.stringify(__MT__.hostThemeReport())')));
    const reviews = [];
    const fixtureFindings = [];

    if (fixture === FALLBACK) {
        /*
         * The fixture's whole claim is that the aliases are gone and the panel's own fallbacks are
         * what resolve — asserted here, from the live document, before anything is read: a fallback
         * that still had the host's tokens would measure them and call them the panel's.
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

/** Run every fixture, judge the answers, and leave the report behind: zero when nothing failed. */
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
