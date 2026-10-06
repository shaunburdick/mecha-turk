/**
 * The rendered contrast and style matrix over the built documentation site.
 *
 * 007 AC-033, AC-035 and AC-036 are, in three of their four clauses, questions only a browser can
 * answer: what a heading resolves to *at this viewport*, what a focus indicator paints after a
 * keystroke, and what colour is really behind text where a gradient paints it. This drives a real
 * browser over `site/dist` and reports what a reader would see, judging every subject against the
 * surface it is painted on — resolved twice, from the cascade and from the pixels of a real
 * capture, with the lower figure the one that has to clear the floor. `./site-contrast.js` holds
 * the arithmetic and the browser expressions; `./site-matrix.json` holds the case list.
 *
 * ## A run that only ever passes teaches nothing
 *
 * Every case therefore also **injects** one test-only colour per threshold — a normal-text
 * foreground, a large-text foreground, and a focus-indicator colour, each synthesised in Node to
 * land at a stated ratio — and requires the assessment to refuse it, naming the page, the
 * preference, both colours and the ratio. The override lives in the page's own inline style for
 * the moment it takes and comes off in a `finally`; nothing under `site/` is written, and the
 * shipped artefact is never what is judged.
 *
 * ## Boundaries
 *
 * - **Local and offline.** The pages are `site/dist`, served over loopback by the harness's own
 *   `serve.js`, at the base path the site is published under. No published address is fetched, and
 *   nothing here speaks for the published site.
 * - **A floor, not a conformance claim.** 4.5:1, 3:1 and 3:1 are the minima NFR-004 names, for the
 *   pairs and viewports this visits. It establishes no WCAG conformance for anything else.
 *
 * Usage: `node tools/visual/site-matrix.js [--out DIR] [--only PAGE] [--session NAME] [--help]`
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowser } from './browser.js';
import { decodePng } from './png.js';
import {
    GLYPH_TOLERANCE,
    assessSubject,
    contrastRatio,
    describe,
    injectColour,
    matrix,
    parseColour,
    requiredFloor,
    rgb,
    serveSite,
    worstPixelRatio,
} from './site-contrast.js';
import {
    bareTextExpression,
    focusBoxExpression,
    measureExpression,
    restoreTextExpression,
    rereadExpression,
} from './site-expressions.js';

/** Repository root, derived from this file's location. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the built site is; the tool refuses to run without it rather than building it itself. */
const DIST = join(ROOT, 'site', 'dist');

/** The base path the site is published under, and therefore the one it is served at here. */
/** Default output folder for the frames and the report. */
const DEFAULT_OUT = join(ROOT, 'screenshots', 'site-matrix');

/** Session name a run isolates itself in, so it never hijacks another agent's browser. */
const DEFAULT_SESSION = 'mt-site';

/** Keystrokes a focus walk may press before it calls the order exhausted. */
const MAX_TAB_STOPS = 80;

/** Device pixel ratio the pixel sampling is valid at, because a sample is placed in CSS pixels. */
const REQUIRED_DPR = 1;

/** Pixels a sample must hold before a figure is reported from it rather than refused. */
const MIN_SAMPLE = 4;

/**
 * The share of prose blocks that may carry their own surface before "selective" becomes "everywhere".
 *
 * The field manual says most prose stays open and key truths get emphasis, and "most" is the only
 * honest reading of that sentence: a layout that gives every paragraph a card is green under a
 * description and red under a count. Half is the bound — strictly fewer than half — because the
 * site deliberately surfaces the lead paragraph of the title and of each section, and a bound below
 * that would be measuring the design rather than the rule.
 */
const MAX_SURFACE_SHARE = 0.5;

/** Channels of a sampled pixel, which is an `rgb()` triple from the decoder. */
const PIXEL_CHANNELS = 3;

/** A share printed as a percentage. */
const PERCENT = 100;

/** The usage line, so an unknown flag is refused before a browser is opened. */
const USAGE = [
    'usage: node tools/visual/site-matrix.js [--out DIR] [--only PAGE] [--session NAME] [--help]',
    `       pages: ${matrix.pages.map((page) => page.id).join(', ')} (default: all five)`,
    `       viewports: ${matrix.viewports.map((view) => `${view.name} ${view.width}px`).join(', ')}`,
    `       schemes: ${matrix.schemes.join(', ')} — every case runs in both`,
    `       cases: ${matrix.pages.length * matrix.viewports.length * matrix.schemes.length}` +
        ' (five pages x three viewports x two schemes)',
    '       each run injects one colour per threshold and requires the check to refuse it',
];

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

/** Report a line on stderr. */
function writeError(text) {
    process.stderr.write(`${text}\n`);
}

/** Read a browser answer that is a JSON string, refusing anything else loudly. */
function readJson(answer) {
    return JSON.parse(String(answer));
}

/** Every (page, viewport, scheme) triple the matrix enumerates, in a stable order. */
export function casesFor(pages) {
    const cases = [];

    for (const page of pages) {
        for (const viewport of matrix.viewports) {
            for (const scheme of matrix.schemes) {
                cases.push({ page, scheme, viewport });
            }
        }
    }

    return cases;
}

/** Refuse a run with nothing built to measure, and say what to run instead. */
export async function requireBuild() {
    const built = await stat(join(DIST, 'index.html')).catch(() => null);

    if (built === null || !built.isFile()) {
        throw new Error(
            'there is no built site to measure — run `cd site && npm run build` first, so the matrix reads ' +
                "the artefact the published address serves rather than a dev server's in-memory pages",
        );
    }
}

/** Resolve `--only`, refusing a page the site does not publish. */
function selectedPages(argv) {
    const index = argv.indexOf('--only');

    if (index === -1) {
        return matrix.pages;
    }
    const name = String(argv[index + 1] ?? '');
    const found = matrix.pages.find((page) => page.id === name);

    if (found === undefined) {
        throw new Error(
            `unknown page "${name}" — try: ${matrix.pages.map((page) => page.id).join(', ')}`,
        );
    }

    return [found];
}

/**
 * Apply a test-only override to one subject, read it back, and take it away again.
 *
 * The override goes into the page's own inline style and comes off in a `finally`, so a failure
 * to read the figure back still leaves the page as it was found.
 *
 * @param {object} input `{ browser, colour, injection }`.
 * @returns {Promise<object>} What the browser reported while the override was in force.
 */
async function withOverride(input) {
    const { browser, colour, injection } = input;
    const selector = JSON.stringify(injection.subject);
    const property = JSON.stringify(injection.property);
    const value = JSON.stringify(rgb(colour));

    await browser.evaluate(
        `(() => { const el = document.querySelector(${selector});` +
            ` if (el !== null) { el.style.setProperty(${property}, ${value}, 'important'); } return true; })()`,
    );
    try {
        return readJson(
            await browser.evaluate(rereadExpression(injection.subject)),
        );
    } finally {
        await browser.evaluate(
            `(() => { const el = document.querySelector(${selector});` +
                ` if (el !== null) { el.style.removeProperty(${property}); } return true; })()`,
        );
    }
}

/**
 * Press `Tab` until the focus subject is the active element.
 *
 * `:focus-visible` does not match a scripted `.focus()`, so the injected figure and the resting
 * one would not be the same thing; a real keystroke makes them the same thing.
 *
 * @param {object} input `{ browser, selector }`.
 * @returns {Promise<boolean>} Whether the subject was reached.
 */
async function tabToSubject(input) {
    const { browser, selector } = input;

    for (let stop = 0; stop < MAX_TAB_STOPS; stop += 1) {
        const reached = readJson(
            await browser.evaluate(
                '(() => { const el = document.activeElement;' +
                    ` return JSON.stringify(el !== null && el.matches(${JSON.stringify(selector)})); })()`,
            ),
        );

        if (reached === true) {
            return true;
        }
        await browser.run(['press', 'Tab']);
    }

    return false;
}

/**
 * The colour painted where a focus indicator sits, read from the capture.
 *
 * A focus indicator is non-text, so what it has to clear 3:1 against is whatever is painted around
 * it — on this site a gradient in the navigation and a wash on the page. The ring's box is
 * sampled with the ring's own colour dropped, so the indicator never judges itself, and the mean
 * of what is left is the adjacent surface.
 *
 * @param {object} image - The decoded capture.
 * @param {object} box - The ring's box, in image pixels.
 * @param {number[]} outline - The ring's own colour, dropped from the sample.
 * @param {number[]} fallback - The cascade's background, used when the box holds too few pixels.
 * @returns {number[]} The adjacent colour.
 */
function adjacentToFocusRing(image, box, outline, fallback) {
    const xEnd = Math.min(Math.round(box.x + box.width), image.width);
    const yEnd = Math.min(Math.round(box.y + box.height), image.height);
    const tolerance = GLYPH_TOLERANCE * GLYPH_TOLERANCE;
    let count = 0;
    let total = [0, 0, 0];

    for (let y = Math.max(Math.round(box.y), 0); y < yEnd; y += 1) {
        for (let x = Math.max(Math.round(box.x), 0); x < xEnd; x += 1) {
            const offset = (y * image.width + x) * 4;
            const pixel = [
                image.data[offset],
                image.data[offset + 1],
                image.data[offset + 2],
            ];
            const distance = pixel.reduce(
                (total2, channel, index) =>
                    total2 + (channel - (outline[index] ?? 0)) ** 2,
                0,
            );

            if (distance <= tolerance) {
                continue;
            }
            total = [
                (total[0] ?? 0) + pixel[0],
                (total[1] ?? 0) + pixel[1],
                (total[2] ?? 0) + pixel[2],
            ];
            count += 1;
        }
    }

    if (count < MIN_SAMPLE) {
        return fallback;
    }

    return Array.from(
        { length: PIXEL_CHANNELS },
        (_, index) => (total[index] ?? 0) / count,
    );
}

/**
 * Prove one threshold bites: inject a colour below it and require the assessment to refuse.
 *
 * @param {object} input `{ browser, context, image, injection }`.
 * @returns {Promise<object>} What was injected, what it measured, and whether it was refused.
 */
export async function proveThreshold(input) {
    const { browser, context, image, injection } = input;
    const resting = context.subjects.find(
        (subject) => subject.selector === injection.subject,
    );

    if (resting === undefined) {
        return {
            id: injection.id,
            proved: false,
            note: `${injection.subject} is not on this page`,
        };
    }
    if (
        injection.kind === 'focus' &&
        !(await tabToSubject({ browser, selector: injection.subject }))
    ) {
        return {
            id: injection.id,
            proved: false,
            note: `${injection.subject} is not reachable by Tab`,
        };
    }
    const ring = readJson(
        await browser.evaluate(focusBoxExpression(injection.subject)),
    );

    if (!ring.present) {
        return {
            id: injection.id,
            proved: false,
            note: `${injection.subject} vanished mid-run`,
        };
    }
    const ringColour = parseColour(ring.color) ?? [0, 0, 0];
    const adjacent =
        injection.kind === 'focus'
            ? adjacentToFocusRing(
                image,
                ring.box,
                ringColour,
                resting.background,
            )
            : resting.background;
    const colour = injectColour(ringColour, adjacent, injection.targetRatio);
    const reread = await withOverride({ browser, colour, injection });
    const answered =
        injection.property === 'outline-color'
            ? reread.outlineColor
            : reread.color;
    const foreground = parseColour(answered) ?? [0, 0, 0];
    const floor =
        injection.kind === 'focus'
            ? matrix.floors.nonText
            : requiredFloor(
                Number.parseFloat(reread.fontSize),
                Number.parseFloat(reread.fontWeight),
            );
    const ratio = contrastRatio(foreground, adjacent);

    return {
        id: injection.id,
        page: context.page,
        viewport: context.viewport,
        scheme: context.scheme,
        foreground,
        background: adjacent,
        ratio,
        floor,
        proved: ratio < floor,
    };
}

/**
 * Sample one subject's painted box.
 *
 * @param {object} image - The decoded **bare** capture, taken with the page's text made
 *   transparent, so every pixel left in the box is surface rather than lettering.
 * @param {object} record - One measured subject.
 * @returns {object | null} The sample, or null when the subject's colour could not be read.
 */
function sampleSubject(image, record) {
    const foreground = parseColour(record.color);

    if (foreground === null) {
        return null;
    }

    return worstPixelRatio(image, record.box, foreground, record.holes ?? []);
}

/** Why a subject has no measured pixels behind its own foreground colour. */
function unmeasuredReason(record, finding, sampled) {
    if (record.overflowed === true) {
        return { sampled, reason: 'too many descendants to exclude' };
    }
    if (finding.gradient !== null && finding.source === 'cascade') {
        return {
            sampled,
            reason: 'a gradient paints the surface and no pixels were sampled',
        };
    }

    return null;
}

/**
 * Judge every subject the page rendered, and note the ones nothing could be sampled behind.
 *
 * @param {object[]} records - The page's measured subjects.
 * @param {object} image - The decoded bare capture.
 * @param {object} page - `{ id, scheme, viewport: name }`, so each judgement carries where it was made.
 * @returns {{ subjects: object[], unmeasurable: object[] }} Every judgement, and the ones with no pixels.
 */
function judgeSubjects(records, image, page) {
    const subjects = [];
    const unmeasurable = [];
    const rendered = records.filter((record) => record.present);

    for (const record of rendered) {
        const pixel = sampleSubject(image, record);
        const finding = assessSubject({
            page: page.id,
            pixel,
            record,
            scheme: page.scheme,
            viewport: page.viewport,
        });
        const blind = unmeasuredReason(record, finding, pixel?.sampled ?? 0);

        if (blind !== null) {
            unmeasurable.push({
                label: record.label,
                selector: record.selector,
                ...blind,
            });
        }
        subjects.push(finding);
    }

    return { subjects, unmeasurable };
}

/** Measure, judge and record one (page, viewport, scheme) case. */
async function measureCase(input) {
    const { browser, entry, outDir, url } = input;
    const { page, scheme, viewport } = entry;

    await browser.run(['set', 'media', scheme]);
    await browser.setViewport({
        height: viewport.height,
        width: viewport.width,
    });
    await browser.open(`${url}${page.path === '/' ? '' : page.path}`);

    const measurement = readJson(await browser.evaluate(measureExpression()));

    if (measurement.devicePixelRatio !== REQUIRED_DPR) {
        throw new Error(
            `the page renders at a device pixel ratio of ${measurement.devicePixelRatio}, and this tool places ` +
                'samples in CSS pixels; refusing to report a figure it cannot put on the image',
        );
    }
    const frame = join(outDir, `${page.id}-${viewport.name}-${scheme}.png`);

    await browser.capture(frame, { full: true });

    /*
     * The second capture is the measurement one. The page's text is made transparent for it, so
     * the frame holds only what is painted *behind* the text — surfaces, ramps, rules, decoration —
     * and no glyph can be mistaken for the surface a heading is painted on. It is a diagnostic and
     * is not published as evidence; the frame above is.
     */
    const bare = join(
        outDir,
        `.bare-${page.id}-${viewport.name}-${scheme}.png`,
    );

    await browser.evaluate(bareTextExpression());
    try {
        await browser.capture(bare, { full: true });
    } finally {
        await browser.evaluate(restoreTextExpression());
    }
    const image = decodePng(await readFile(bare));

    const { subjects, unmeasurable } = judgeSubjects(
        measurement.subjects,
        image,
        {
            id: page.id,
            scheme,
            viewport: viewport.name,
        },
    );
    const context = {
        page: page.id,
        scheme,
        subjects,
        viewport: viewport.name,
    };
    const proofs = [];

    for (const injection of matrix.injections) {
        proofs.push(
            await proveThreshold({ browser, context, image, injection }),
        );
    }

    return {
        subjects,
        page: {
            clientWidth: measurement.page.clientWidth,
            height: measurement.page.height,
            scrollWidth: measurement.page.scrollWidth,
        },
        proofs,
        frame: `${page.id}-${viewport.name}-${scheme}.png`,
        path: page.path,
        id: page.id,
        colorScheme: measurement.colorScheme,
        colours: measurement.colours,
        signature: measurement.signature,
        decoration: measurement.decoration,
        landmarks: measurement.landmarks,
        pageScrolls:
            measurement.page.scrollWidth > measurement.page.clientWidth,
        tables: measurement.tables,
        title: measurement.title,
        unmeasurable,
        viewport: viewport.name,
        width: viewport.width,
        headings: measurement.headings,
        scheme,
        surfaces: measurement.surfaces,
    };
}

/** The scale an alpha literal is read on, the rounding its text keeps, and `rgb()`'s own length. */
const ALPHA_SCALE = 255;
const ALPHA_PRECISION = 1_000;
const RGB_PARTS = 3;

/** The base a hex literal's digits are read in, and the digit a shorthand pair doubles. */
const HEX_RADIX = 16;

/**
 * The shapes a colour literal arrives in.
 *
 * The hex pattern matches digits only and the digit count is checked separately, rather than one
 * pattern of repeated groups: nested quantifiers over the same class are what a regex checker
 * flags as potentially super-linear, and there is nothing to gain here from the nesting — the
 * input is one literal.
 */
const HEX_DIGITS = /^#([\da-f]+)$/u;
const FUNCTIONAL_COLOUR = /^rgba?\(([^)]*)\)$/u;

/** The digit counts `#rgb`, `#rrggbb` and `#rrggbbaa` arrive in. */
const SHORT_HEX_LENGTH = 3;
const LONG_HEX_LENGTH = 6;
const ALPHA_HEX_LENGTH = 8;

/** True for the three hex forms, and false for a length that is no colour at all. */
function isHexForm(digits) {
    return [SHORT_HEX_LENGTH, LONG_HEX_LENGTH, ALPHA_HEX_LENGTH].includes(
        digits.length,
    );
}

/** An alpha hex pair as the decimal a computed style reports. */
function alphaShare(pair) {
    return (
        Math.round(
            (Number.parseInt(pair, HEX_RADIX) / ALPHA_SCALE) * ALPHA_PRECISION,
        ) / ALPHA_PRECISION
    );
}

/**
 * One colour literal in the form `getComputedStyle` reports it.
 *
 * The page's stylesheet is written in hex and the browser answers in `rgb()`, so the two are
 * normalised onto one spelling before they are compared; without that, every declared colour would
 * read as undeclared.
 *
 * @param {string} literal - A `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` literal.
 * @returns {string} The colour as `getComputedStyle` would report it.
 */
function normaliseColour(literal) {
    const text = literal.toLowerCase();
    const hex = HEX_DIGITS.exec(text);

    if (hex !== null && isHexForm(hex[1])) {
        const doubled = hex[1].replaceAll(
            /[\da-f]/gu,
            (digit) => digit + digit,
        );
        const digits = hex[1].length === SHORT_HEX_LENGTH ? doubled : hex[1];
        const pairs = digits
            .match(/[\da-f]{2}/gu)
            .map((pair) => Number.parseInt(pair, HEX_RADIX));

        // `rgb()` renders the whole call, so the channels are joined here instead: interpolating it
        // inside `rgba(...)` yields `rgba(rgb(244, 246, 239), 0.4)`, which no browser will ever
        // report and which made every alpha-hex literal read as undeclared.
        if (pairs.length === RGB_PARTS + 1) {
            return `rgba(${pairs.slice(0, RGB_PARTS).join(', ')}, ${alphaShare(digits.slice(-2))})`;
        }

        return rgb(pairs);
    }
    const functional = FUNCTIONAL_COLOUR.exec(text);

    if (functional === null) {
        return text;
    }
    const parts = functional[1].split(/[,/]/u).map((part) => part.trim());

    return parts.length > RGB_PARTS
        ? `rgba(${parts.join(', ')})`
        : `rgb(${parts.join(', ')})`;
}

/**
 * Every colour the site's own stylesheet declares, read from the built pages.
 *
 * The rendered pass's claim that the page paints colours it owns is only checkable against
 * something: a colour the browser resolves must be one the page's own `<style>` declares. Reading
 * them out of `site/dist` rather than out of the sources is deliberate — the artefact is what a
 * reader is served, and a minifier that rewrote a literal would change what is on the page.
 *
 * @param {string[]} html - Each built page's text.
 * @returns {Set<string>} Normalised `rgb()`/`rgba()` strings the pages declare, plus `transparent`.
 */
export function declaredColours(html) {
    const declared = new Set(['transparent', 'rgba(0, 0, 0, 0)']);

    for (const page of html) {
        for (const block of page.matchAll(
            /<style[^>]*>([\s\S]*?)<\/style>/giu,
        )) {
            const sheet = block[1] ?? '';
            const literals = sheet.matchAll(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/giu);

            for (const literal of literals) {
                declared.add(normaliseColour(literal[0]));
            }
        }
    }

    return declared;
}

/** The heading levels a case rendered, with their own text, for the two heading clauses. */
function headingFindings(entry, where) {
    const found = [];
    const levels = entry.headings.map((heading) => heading.level);
    const titles = levels.filter((level) => level === 1).length;
    let previous = 0;

    for (const heading of entry.headings) {
        if (previous !== 0 && heading.level > previous + 1) {
            found.push(
                `${where}: a heading jumps from h${previous} to h${heading.level} (${heading.text})`,
            );
        }
        previous = heading.level;
        if (heading.text === '') {
            found.push(
                `${where}: an h${heading.level} heading carries no text of its own`,
            );
        }
    }
    if (titles !== 1) {
        found.push(`${where}: the page has ${titles} h1 elements, not one`);
    }

    return found;
}

/** The two size clauses: the title above a section heading, and a section heading above the body. */
function hierarchyFindings(entry, where, findings) {
    const sizeOf = (selector) => {
        const record = entry.subjects.find(
            (subject) =>
                subject.selector === selector && subject.pseudo === null,
        );

        return record === undefined ? null : record.sizePx;
    };
    const title = sizeOf('h1');
    const section = sizeOf('h2');
    const prose = sizeOf('p');

    if (title !== null && section !== null && title <= section) {
        findings.push(
            `${where}: the title (${title}px) is not larger than a section heading (${section}px)`,
        );
    }
    if (section !== null && prose !== null && section <= prose) {
        findings.push(
            `${where}: a section heading (${section}px) is not larger than body text (${prose}px)`,
        );
    }
}

/** The overflow values that make a wide table reachable, so a clipped one fails the clause. */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll']);

/** The surfaces and tables one case rendered, judged and recorded together. */
function surfaceAndTableFindings(entry, where, summary) {
    const findings = [];
    const { onSurface, prose } = entry.surfaces;

    if (prose > 0 && onSurface / prose >= MAX_SURFACE_SHARE) {
        findings.push(
            `${where}: ${onSurface} of ${prose} prose blocks carry their own surface`,
        );
    }
    summary.surfaces.push({
        prose,
        page: entry.id,
        viewport: entry.viewport,
        onSurface,
        scheme: entry.scheme,
    });

    for (const table of entry.tables) {
        const isWider = table.scrollWidth > table.clientWidth;

        if (isWider && !SCROLLABLE_OVERFLOW.has(table.overflowX)) {
            findings.push(
                `${where}: a table is ${table.scrollWidth - table.clientWidth}px wider than ` +
                    'its box and is not scrollable',
            );
        }
        summary.tables.push({
            ...table,
            page: entry.id,
            viewport: entry.viewport,
            scheme: entry.scheme,
        });
    }

    return findings;
}

/** The clauses about colour ownership, motion and reflow, for one case. */
function pageFindings(entry, where, palette) {
    const found = [];

    if (entry.pageScrolls) {
        found.push(
            `${where}: the page scrolls horizontally (${entry.page.scrollWidth} > ${entry.page.clientWidth})`,
        );
    }
    if (entry.decoration.animated !== 0 || (entry.decoration.running ?? 0) > 0) {
        found.push(
            `${where}: ${entry.decoration.animated} element(s) animate and ${entry.decoration.running} run`,
        );
    }
    for (const [colour, element] of Object.entries(entry.colours)) {
        if (!palette.has(colour)) {
            found.push(
                `${where}: the page resolves ${colour} at ${element}, which its own stylesheet never declares`,
            );
        }
    }

    return found;
}

/** The per-viewport half of the colour-only clause: the two cascades compared side by side. */
function schemeFindings(cases, context) {
    const { page, summary, viewport } = context;
    const match = (scheme) =>
        cases.find(
            (entry) =>
                entry.id === page &&
                entry.viewport === viewport.name &&
                entry.scheme === scheme,
        );
    const [left, right] = matrix.schemes.map((scheme) => match(scheme));

    if (left === undefined || right === undefined) {
        return [];
    }
    const moved = Object.entries(left.signature).filter(
        ([selector, shape]) =>
            JSON.stringify(shape) !==
            JSON.stringify(right.signature?.[selector]),
    );

    summary.colourOnly.push({
        coloursDiffer:
            JSON.stringify(left.colours) !== JSON.stringify(right.colours),
        properties: Object.keys(left.signature).length,
        page,
        scheme: matrix.schemes[1],
        viewport: viewport.name,
    });

    return moved.map(
        ([selector]) =>
            `${page} ${viewport.name}: ${selector} changes something other than colour between the ` +
            'two preference cascades',
    );
}

/**
 * The colour-only clause: one non-colour property that moves between the cascades, or no finding.
 *
 * The comparison runs on every page, not on whichever page happens to come first — element
 * presence gates the signature (`SIGNATURE_SELECTORS` skips what a page does not render), so a
 * page with no `<table>` proves nothing about table behaviour, and only a page that has one can.
 * All five pages are therefore paired at all three viewports: 15 light/dark pairs.
 */
function cascadeFindings(cases, summary) {
    const findings = [];
    const pages = [...new Set(cases.map((entry) => entry.id))];

    for (const page of pages) {
        for (const viewport of matrix.viewports) {
            findings.push(
                ...schemeFindings(cases, { page, summary, viewport }),
            );
        }
    }

    if (
        summary.colourOnly.length > 0 &&
        summary.colourOnly.every((entry) => !entry.coloursDiffer)
    ) {
        findings.push(
            'the two preference cascades resolve the same colours, so the theme switch changes nothing',
        );
    }

    return findings;
}

/**
 * The observations a run records besides its contrast figures.
 *
 * These are the clauses of AC-033 and AC-036 that are not contrast ratios, and each is checked
 * rather than described, because each has a shape a mistake takes:
 *
 * - **Colour-only theming.** On every page and viewport, the two cascades must agree on every
 *   non-colour property in `SIGNATURE_PROPERTIES`, and must differ on at least one colour.
 * - **Site-owned colours.** Every colour the browser resolves must be one the built pages declare.
 * - **Hierarchy.** One `h1`, no skipped heading level, and sizes that decrease with depth.
 * - **Decorative-only indices.** Every heading carries its own text; the serial index beside it is
 *   generated content, and nothing on the page animates — a clause that is judged on a counter
 *   and therefore asserts the counter answered, so a browser with no `getAnimations` fails the
 *   run rather than passing it silently.
 * - **Selective surfaces.** Most prose is open, so a card around every passage fails a count rather
 *   than a description.
 * - **Responsive tables.** A table wider than its scroller is scrollable inside its own container,
 *   and the page itself never scrolls sideways at any viewport.
 *
 * @param {object[]} cases - Every measured case.
 * @param {Set<string>} palette - The colours the built pages declare.
 * @returns {{ findings: string[], summary: object }} What failed, and what was recorded.
 */
export function observe(cases, palette) {
    const findings = [];
    const summary = {
        palettes: new Set(),
        colourOnly: [],
        headingCounts: [],
        surfaces: [],
        tables: [],
        animated: 0,
        animationApi: true,
    };

    for (const entry of cases) {
        const where = `${entry.id} ${entry.viewport} ${entry.scheme}`;

        summary.palettes.add(entry.colorScheme);
        summary.animated +=
            entry.decoration.animated + (entry.decoration.running ?? 0);
        summary.animationApi &&= entry.decoration.running !== null;

        findings.push(
            ...pageFindings(entry, where, palette),
            ...headingFindings(entry, where),
        );
        hierarchyFindings(entry, where, findings);
        findings.push(...surfaceAndTableFindings(entry, where, summary));

        summary.headingCounts.push({
            h1: entry.headings.filter((heading) => heading.level === 1).length,
            headings: entry.headings.length,
            page: entry.id,
            viewport: entry.viewport,
            scheme: entry.scheme,
        });
    }

    /*
     * The counter's own liveness is a finding, not a note: `running` is `null` when the browser
     * exposes no `document.getAnimations`, and a run that reported "nothing animates" from a
     * counter that never answered would be the green check this tool exists to refuse. Keeping it
     * here rather than in `publish` means the error line and the non-zero exit come from the one
     * path every other clause already takes.
     */
    if (!summary.animationApi) {
        findings.push(
            'the browser exposed no `document.getAnimations`, so the no-animation clause measured nothing',
        );
    }

    findings.push(...cascadeFindings(cases, summary));

    return { findings, summary };
}

/** `--out` and `--session`, each falling back to the recorded default. */
function readOptions(argv) {
    const read = (flag, fallback) => {
        const index = argv.indexOf(flag);

        return index === -1 ? fallback : String(argv[index + 1]);
    };

    return {
        outDir: resolve(read('--out', DEFAULT_OUT)),
        session: read('--session', DEFAULT_SESSION),
    };
}

/** The scroll marker on a case's line, so a sideways-scrolling page cannot pass unnoticed. */
function hScroll(measured) {
    return measured.pageScrolls ? ' [the page scrolls horizontally]' : '';
}

/**
 * Walk the selected cases, reporting each as it lands.
 *
 * @param {object} input `{ browser, outDir, selected, url }`.
 * @returns {Promise<object[]>} Every measured case, in the order the matrix enumerates them.
 */
async function walkCases(input) {
    const { browser, outDir, selected, url } = input;
    const cases = [];

    for (const entry of selected) {
        const measured = await measureCase({ browser, entry, outDir, url });
        const clear = measured.subjects.filter(
            (subject) => subject.passes,
        ).length;

        cases.push(measured);
        writeLine(
            `${measured.id} ${measured.viewport} (${measured.width}px) ${measured.scheme}: ` +
                `${measured.subjects.length} subjects, ${clear} clear the floor${hScroll(measured)}`,
        );
    }

    return cases;
}

/**
 * Walk the selected cases against a served build, and close both before returning.
 *
 * The server and the browser belong to this call alone, so a run that dies mid-matrix still leaves
 * nothing listening — which is the only way a loopback port stays free for the next tool.
 *
 * @param {object} input `{ outDir, selected, session }`.
 * @returns {Promise<object[]>} Every measured case.
 */
async function measureAll(input) {
    const { outDir, selected, session } = input;
    const site = await serveSite();
    const browser = createBrowser({ session });

    try {
        return await walkCases({ browser, outDir, selected, url: site.url });
    } finally {
        await browser.close();
        await site.close();
    }
}

/** The reason an injection did not bite, parenthesised, or nothing at all when it simply held. */
function whyNot(note) {
    return note === undefined ? '' : ` (${note})`;
}

/** The animation counter named for the run's own log: it answered, or it did not. */
function counterLabel(animationApi) {
    return animationApi ? 'document.getAnimations' : 'NO animation counter';
}

/** Write the report, say what failed, and return the exit code the run earned. */
async function publish(input) {
    const { cases, observed, outDir } = input;
    const subjects = cases.flatMap((entry) => entry.subjects);
    const failures = subjects.filter((subject) => !subject.passes);
    const proofs = cases.flatMap((entry) => entry.proofs);
    const unproved = proofs.filter((proof) => !proof.proved);
    const unmeasurable = cases.flatMap((entry) => entry.unmeasurable);

    for (const failure of failures) {
        writeError(`site-matrix: ${describe(failure)}`);
    }
    for (const entry of unmeasurable) {
        writeError(
            `site-matrix: ${entry.selector} was measured from the cascade alone — ${entry.reason}`,
        );
    }
    for (const proof of unproved) {
        writeError(
            `site-matrix: the ${proof.id} injection was not refused${whyNot(proof.note)}`,
        );
    }
    for (const finding of observed.findings) {
        writeError(`site-matrix: ${finding}`);
    }

    const path = join(outDir, 'report.json');

    await writeFile(
        path,
        `${JSON.stringify(
            {
                cases,
                observations: {
                    ...observed.summary,
                    palettes: [...observed.summary.palettes],
                },
                summary: {
                    cases: cases.length,
                    failures: failures.length,
                    findings: observed.findings.length,
                    proofs: proofs.length,
                    subjects: subjects.length,
                    unmeasurable: unmeasurable.length,
                    unproved: unproved.length,
                },
                floors: matrix.floors,
                // The bound `surfaceAndTableFindings` enforces on "selective emphasis", next to the
                // thresholds it belongs with; the pixel-histogram share in `site-contrast.js` is a
                // sampling parameter and would read as a design rule beside `floors`.
                maxProseSurfaceShare: MAX_SURFACE_SHARE,
                largeText: matrix.largeText,
            },
            null,
            4,
        )}\n`,
    );

    const { surfaces } = observed.summary;
    const widestProse = Math.max(
        ...surfaces.map((entry) =>
            entry.prose === 0 ? 0 : entry.onSurface / entry.prose,),
    );

    writeLine(
        `site-matrix: ${cases.length} cases, ${subjects.length} subjects, ${failures.length} below a floor, ` +
            `${proofs.length - unproved.length}/${proofs.length} threshold proofs, ` +
            `${observed.findings.length} findings — ${path}`,
    );
    writeLine(
        'site-matrix: recorded — colour-only themes verified at ' +
            `${observed.summary.colourOnly.length} page/viewport pairs, ` +
            `${observed.summary.headingCounts.length} heading orders, ` +
            `${(widestProse * PERCENT).toFixed(1)}% of prose on its own surface at worst, ` +
            `${observed.summary.tables.length} table measurements, ` +
            `${observed.summary.animated} animations ` +
            `(counter: ${counterLabel(observed.summary.animationApi)})`,
    );

    return failures.length > 0 ||
        unproved.length > 0 ||
        unmeasurable.length > 0 ||
        observed.findings.length > 0
        ? 1
        : 0;
}

/**
 * Measure every case, judge it, and return the exit code the run earned.
 *
 * @param {string[]} argv - The command line, without the script name.
 * @returns {Promise<number>} Zero when every case cleared its floor, every threshold was proved to
 *   bite, and every observation held; one otherwise.
 */
export async function main(argv) {
    await requireBuild();

    if (argv.includes('--help')) {
        writeLine(USAGE.join('\n'));

        return 0;
    }
    const { outDir, session } = readOptions(argv);

    await mkdir(outDir, { recursive: true });

    const cases = await measureAll({
        outDir,
        selected: casesFor(selectedPages(argv)),
        session,
    });

    const pages = await Promise.all(
        matrix.pages.map((page) =>
            readFile(join(DIST, `${page.path}index.html`), 'utf8'),),
    );

    return publish({
        cases,
        observed: observe(cases, declaredColours(pages)),
        outDir,
    });
}

const isInvokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (isInvokedDirectly) {
    process.exitCode = await main(process.argv.slice(2)).catch((error) => {
        writeError(
            `site-matrix: ${error instanceof Error ? error.message : String(error)}`,
        );

        return 1;
    });
}
