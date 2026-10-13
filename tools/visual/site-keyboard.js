/**
 * Keyboard-only and accessibility-tree evidence over the built documentation site: 007 AC-035's
 * second clause and NFR-004's keyboard half are questions about a **sequence**, answered by
 * pressing keys and reading `agent-browser`'s accessibility snapshot — never by a scripted focus,
 * which does not produce `:focus-visible` and can reach an element tab order skips, so the tool
 * never asks the browser to focus anything itself and the suite assertion is shaped so this
 * docblock cannot satisfy it. Clauses: every link reachable in DOM order; names, roles, landmarks
 * and headings from the snapshot; an unobscured indicator at every stop; 320 CSS px with no
 * page-level scroll; textual state and static decoration. It makes **no WCAG conformance claim**,
 * and axe is deliberately not run — a score is not evidence for these clauses.
 * Usage: `node tools/visual/site-keyboard.js [--out DIR] [--only PAGE] [--session NAME] [--help]`
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowser } from './browser.js';
import { matrix, serveSite } from './site-contrast.js';
import { focusExpression } from './site-expressions.js';

/** Repository root, derived from this file's location. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the built site is. */
const DIST = join(ROOT, 'site', 'dist');

/** Default output folder for the report. */
const DEFAULT_OUT = join(ROOT, 'screenshots', 'site-keyboard');

/** Session name a run isolates itself in. */
const DEFAULT_SESSION = 'mt-site-key';

/** Keystrokes one page's focus order may contain before the walk calls it exhausted. */
const MAX_STOPS = 400;

/**
 * The width the reflow clause is checked at, and the only one it needs: AC-035 names 320 CSS px,
 * and a page that reflows there has reflowed at every width above it — the layout only gains room.
 * The wide reflow is left to the matrix.
 */
const REFLOW_WIDTH = 320;

/** Height asked for at the reflow width; tall enough that no control needs scrolling to be reached. */
const REFLOW_HEIGHT = 900;

/** Viewports the focus order itself is walked at. */
const FOCUS_VIEWPORTS = [
    { name: 'narrow', width: 720, height: 900 },
    { name: 'narrowest', width: REFLOW_WIDTH, height: REFLOW_HEIGHT },
];

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

/** Report a line on stderr. */
function writeError(text) {
    process.stderr.write(`${text}\n`);
}

/** A browser answer that is a JSON string, refusing anything else loudly. */
function readAnswer(answer) {
    return JSON.parse(String(answer));
}

/** The usage line. */
const USAGE = [
    'usage: node tools/visual/site-keyboard.js [--out DIR] [--only PAGE] [--session NAME] [--help]',
    `       pages: ${matrix.pages.map((page) => page.id).join(', ')} (default: all five)`,
    `       focus order walked at: ${FOCUS_VIEWPORTS.map((view) => `${view.name} ${view.width}px`).join(', ')}`,
    '       every stop is read after a real Tab press; no scripted focus is used for any figure',
];

/** Resolve `--only`, refusing a page the site does not publish. */
function selectedPages(argv) {
    const index = argv.indexOf('--only');

    if (index === -1) {
        return matrix.pages;
    }
    const name = String(argv[index + 1] ?? '');
    const found = matrix.pages.find((page) => page.id === name);

    if (found === undefined) {
        throw new Error(`unknown page "${name}" — try: ${matrix.pages.map((page) => page.id).join(', ')}`);
    }

    return [found];
}

/**
 * The expression the reflow clause is answered with: four questions from the live document rather
 * than from a width the caller asked for — does the page scroll sideways, is the title clipped,
 * does it overlap what follows, is every control inside the frame. Table figures are reported
 * separately and never fail the page: that is what "a table keeps its own scroll container" means.
 */
function reflowExpression() {
    return String.raw`(() => {
    const view = window;
    const root = document.documentElement;
    const title = document.querySelector('h1');
    const first = document.querySelector('main > section') ?? document.querySelector('main > p');
    const titleRect = title === null ? null : title.getBoundingClientRect();
    const firstRect = first === null ? null : first.getBoundingClientRect();
    const outside = [...document.querySelectorAll('a, button, input, select, summary')]
        .map((el) => ({ element: el.tagName.toLowerCase(), rect: el.getBoundingClientRect() }))
        .filter((entry) => entry.rect.left < -0.5 || entry.rect.right > view.innerWidth + 0.5)
        .map((entry) => entry.element);

    return JSON.stringify({
        clippedControls: outside,
        page: {
            clientWidth: root.clientWidth,
            scrollWidth: root.scrollWidth,
            overflowing: root.scrollWidth > root.clientWidth,
        },
        tables: [...document.querySelectorAll('table')].map((el) => ({
            clientWidth: Math.round(el.clientWidth),
            overflowX: view.getComputedStyle(el).overflowX,
            scrollWidth: Math.round(el.scrollWidth),
        })),
        title: titleRect === null ? null : {
            clientWidth: Math.round(title.clientWidth),
            fontSize: view.getComputedStyle(title).fontSize,
            overlapsNext: firstRect === null ? false : titleRect.bottom > firstRect.top + 0.5,
            scrollWidth: Math.round(title.scrollWidth),
            withinFrame: titleRect.left >= -0.5 && titleRect.right <= view.innerWidth + 0.5,
        },
        controls: document.querySelectorAll('a, button, input, select, summary').length,
        links: document.querySelectorAll('a').length,
        landmarks: {
            main: document.querySelectorAll('main').length,
            footer: document.querySelectorAll('footer').length,
            nav: document.querySelectorAll('nav').length,
            labelledNav: [...document.querySelectorAll('nav')].filter((el) =>
                el.getAttribute('aria-label') !== null || el.getAttribute('aria-labelledby') !== null).length,
        },
        headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => ({
            level: Number.parseInt(el.tagName.slice(1), 10),
            own: el.textContent.trim().replace(/\s+/gu, ' ').slice(0, 60),
            generated: view.getComputedStyle(el, '::before').content,
        })),
    });
})()`;
}

/**
 * Press `Tab` until the order is exhausted, reading each stop as it goes. The walk stops when the
 * focus lands back on the first stop — a browser wraps — or when it stops moving, which is what
 * happens once focus has left the document.
 */
async function walkFocus(input) {
    const { browser, selectors } = input;
    const stops = [];
    let first = null;

    for (let press = 0; press < MAX_STOPS; press += 1) {
        // The keystroke comes first: nothing is focused when the page opens, so a stop read before
        // the first Tab would be an absent stop rather than an order.
        await browser.run(['press', 'Tab']);
        const stop = readAnswer(await browser.evaluate(focusExpression(selectors)));

        if (stop.empty === true) {
            break;
        }
        const key = `${stop.tag}|${stop.name}|${stop.href ?? ''}|${stop.box.x},${stop.box.y}`;

        if (key === first) {
            break;
        }
        first ??= key;
        stops.push(stop);
    }

    return stops;
}

/**
 * Read the browser's own accessibility tree for one page: `agent-browser snapshot --json` is the
 * tree the browser builds for assistive technology, which is what "exposes a role and a name"
 * means — reading the DOM instead would report what the page marks up rather than what it exposes.
 */
async function treeOf(browser) {
    const data = await browser.run(['snapshot', '-c']);
    const refs = data.refs ?? {};

    return Object.values(refs).map((entry) => ({ name: entry.name ?? '', role: entry.role ?? '' }));
}

/** A stop the keyboard landed on that is a link, by markup or by exposed role. */
function isLink(stop) {
    return stop.tag === 'a' || stop.role === 'link';
}

/** The regions the page is expected to expose, as the accessibility tree names them. */
const LANDMARK_ROLES = new Set(['banner', 'contentinfo', 'main', 'navigation']);

/**
 * Every link the page renders must be reachable, and every stop must draw an indicator. Links are
 * counted against link stops; a stop that is not a link is recorded rather than counted against
 * them, because Chrome makes a horizontally scrollable container focusable so a reader can reach
 * it from the keyboard, and a wide table in its own scroller is what this site is asked to keep.
 * A link the keyboard cannot reach is a different thing entirely.
 */
function reachFindings(input) {
    const { reflow, stops, where } = input;
    const linkStops = stops.filter((stop) => isLink(stop));

    if (linkStops.length === reflow.links) {
        return [];
    }

    return [
        `${where}: ${linkStops.length} focus stop(s) reach ${reflow.links} link(s); ` +
            'a link the keyboard cannot reach is not a link',
    ];
}

/** An indicator the browser painted, and not covered by anything, at every stop. */
function indicatorFindings(stops, where) {
    const findings = [];

    for (const stop of stops) {
        if (stop.outline.style === 'none' || Number.parseFloat(stop.outline.width) === 0) {
            findings.push(
                `${where}: "${stop.name}" is focused with no visible indicator ` +
                    `(${stop.outline.style} ${stop.outline.width})`,
            );
        }
        if (stop.obscured) {
            findings.push(`${where}: the focus indicator on "${stop.name}" is covered`);
        }
    }

    return findings;
}

/** A link whose accessible name is empty names nothing a reader could follow. */
function nameFindings(links, where) {
    const unnamed = links.filter((link) => link.name.trim() === '');

    return unnamed.map(() => `${where}: a link has no discernible text`);
}

/** One landmark per region, and a name on the navigation. */
function landmarkFindings(landmarks, where) {
    const findings = [];

    if (landmarks.main !== 1 || landmarks.footer !== 1 || landmarks.nav !== 1) {
        findings.push(
            `${where}: the page exposes ${landmarks.main} main, ${landmarks.nav} navigation and ` +
                `${landmarks.footer} footer region(s)`,
        );
    }
    if (landmarks.labelledNav !== landmarks.nav) {
        findings.push(`${where}: the navigation region has no name`);
    }

    return findings;
}

/** No skipped level, one `h1`, and every heading carrying text of its own. */
function headingFindings(headings, where) {
    const findings = [];
    const titles = headings.filter((heading) => heading.level === 1).length;
    let previous = 0;

    for (const heading of headings) {
        if (previous !== 0 && heading.level > previous + 1) {
            findings.push(`${where}: a heading jumps from h${previous} to h${heading.level} (${heading.own})`);
        }
        previous = heading.level;
        if (heading.own === '') {
            findings.push(`${where}: an h${heading.level} heading carries no text of its own`);
        }
    }
    if (titles !== 1) {
        findings.push(`${where}: the page does not have exactly one h1`);
    }

    return findings;
}

/** The document does not scroll sideways, and no control is stranded outside the frame. */
function reflowFindings(reflow, where) {
    const findings = [];

    if (reflow.page.overflowing) {
        findings.push(
            `${where}: the page scrolls sideways (${reflow.page.scrollWidth} > ${reflow.page.clientWidth}) — ` +
                "a table's own scroller is permitted, the document's is not",
        );
    }
    for (const control of reflow.clippedControls) {
        findings.push(`${where}: a ${control} lies outside the frame`);
    }

    return findings;
}

/** The title is neither clipped nor overlapping what follows it. */
function titleFindings(title, where) {
    if (title === null) {
        return [];
    }
    if (title.scrollWidth > title.clientWidth || !title.withinFrame) {
        return [
            `${where}: the title is clipped (${title.scrollWidth}px of text in ${title.clientWidth}px)`,
        ];
    }
    if (title.overlapsNext) {
        return [`${where}: the title overlaps what follows it`];
    }

    return [];
}

/**
 * Walk one page, at one viewport, in one preference cascade — exported for the same reason
 * `site-matrix.js` exports its observation pass: a page walk is the unit of evidence, and a caller
 * that already holds a browser should not have to re-derive it.
 */
export async function walkPage(input) {
    const { browser, entry, url } = input;
    const { page, scheme, viewport } = entry;
    const where = `${page.id} ${viewport.name} ${scheme}`;

    await browser.run(['set', 'media', scheme]);
    await browser.setViewport({ height: viewport.height, width: viewport.width });
    await browser.open(`${url}${page.path === '/' ? '' : page.path}`);

    const reflow = readAnswer(await browser.evaluate(reflowExpression()));
    const tree = await treeOf(browser);
    const selectors = matrix.focusSubjects.map((subject) => subject.selector);
    const stops = await walkFocus({ browser, selectors });
    const links = tree.filter((node) => node.role === 'link');
    const findings = [
        ...reachFindings({ reflow, stops, where }),
        ...indicatorFindings(stops, where),
        ...nameFindings(links, where),
        ...landmarkFindings(reflow.landmarks, where),
        ...headingFindings(reflow.headings, where),
        ...reflowFindings(reflow, where),
        ...titleFindings(reflow.title, where),
    ];

    return {
        findings,
        page: page.id,
        path: page.path,
        scheme,
        viewport: viewport.name,
        width: viewport.width,
        controls: reflow.controls,
        landmarksInDom: reflow.landmarks,
        headingLevels: reflow.headings,
        otherStops: stops.filter((stop) => !isLink(stop)).map((stop) => ({ name: stop.name, tag: stop.tag })),
        links: reflow.links,
        landmarks: tree.filter((node) => LANDMARK_ROLES.has(node.role)),
        tables: reflow.tables,
        title: reflow.title,
        headings: tree.filter((entry2) => entry2.role === 'heading'),
        stops: stops.map((stop) => ({
            covering: stop.covering ?? [],
            href: stop.href,
            inViewport: stop.inViewport,
            name: stop.name,
            obscured: stop.obscured,
            outline: stop.outline,
            role: stop.role,
            tag: stop.tag,
        })),
    };
}

/** Refuse a run with nothing built to walk, and say what to run instead. */
async function requireBuild() {
    await readFile(join(DIST, 'index.html'), 'utf8');
}

/** `--out` and `--session`, each falling back to the recorded default. */
function readOptions(argv) {
    const read = (flag, fallback) => {
        const index = argv.indexOf(flag);

        return index === -1 ? fallback : String(argv[index + 1]);
    };

    return { outDir: resolve(read('--out', DEFAULT_OUT)), session: read('--session', DEFAULT_SESSION) };
}

/** Every (page, viewport, scheme) walk the run owes, in the order it owes them. */
function walkList(selected) {
    const walks = [];

    for (const page of selected) {
        for (const viewport of FOCUS_VIEWPORTS) {
            for (const scheme of matrix.schemes) {
                walks.push({ entry: { page, scheme, viewport } });
            }
        }
    }

    return walks;
}

/** Walk every page at every focus viewport in both cascades against one browser. */
async function walkEveryPage(input) {
    const { selected, session } = input;
    const site = await serveSite();
    const browser = createBrowser({ session });
    const walked = [];

    try {
        for (const { entry } of walkList(selected)) {
            const page = await walkPage({ browser, entry, url: site.url });

            walked.push(page);
            writeLine(
                `${page.page} ${page.viewport} (${page.width}px) ${page.scheme}: ${page.stops.length} focus stops, ` +
                    `${page.links} links, ${page.landmarks.length} landmarks, ` +
                    `${page.headings.length} headings, ${page.findings.length} findings`,
            );
        }
    } finally {
        await browser.close();
        await site.close();
    }

    return walked;
}

/** Walk every page at every focus viewport in both cascades, and judge it: zero when nothing failed. */
export async function main(argv) {
    await requireBuild();

    if (argv.includes('--help')) {
        writeLine(USAGE.join('\n'));

        return 0;
    }
    const { outDir, session } = readOptions(argv);

    await mkdir(outDir, { recursive: true });

    const pages = await walkEveryPage({ selected: selectedPages(argv), session });

    const findings = pages.flatMap((walked) => walked.findings);

    for (const finding of findings) {
        writeError(`site-keyboard: ${finding}`);
    }

    const path = join(outDir, 'report.json');

    await writeFile(
        path,
        `${JSON.stringify(
            {
                pages,
                summary: {
                    findings: findings.length,
                    focusStops: pages.reduce((total, walked) => total + walked.stops.length, 0),
                    headings: pages.reduce((total, walked) => total + walked.headings.length, 0),
                    landmarks: pages.reduce((total, walked) => total + walked.landmarks.length, 0),
                    // `links` is a count (a number), unlike the array fields beside it: taking
                    // `.length` of it yields undefined and the sum serialises to `null`.
                    links: pages.reduce((total, walked) => total + walked.links, 0),
                    pages: pages.length,
                },
            },
            null,
            4,
        )}\n`,
    );
    writeLine(`site-keyboard: ${pages.length} page walks, ${findings.length} findings — ${path}`);

    return findings.length > 0 ? 1 : 0;
}

const isInvokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isInvokedDirectly) {
    process.exitCode = await main(process.argv.slice(2)).catch((error) => {
        writeError(`site-keyboard: ${error instanceof Error ? error.message : String(error)}`);

        return 1;
    });
}
