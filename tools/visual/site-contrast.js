/**
 * The site contrast and style model: what to ask the browser, and how to judge the answer — the
 * half of 007 AC-033/AC-035/AC-036 that `site/scripts/assert-build.mjs` cannot answer by reading
 * a cascade. Every subject is judged **twice**, once from the cascade and once from the pixels of
 * a real capture, and the lower figure has to clear the floor: a computed `background-color` is
 * not the colour behind text when a translucent layer or an image sits between them. Limits,
 * stated rather than implied: 4.5:1, 3:1 and 3:1 are minima NFR-004 names, not a conformance
 * claim; no axe and no Lighthouse, because a score is not evidence for these clauses; focus is
 * measured after a real keystroke, since a scripted `.focus()` does not produce `:focus-visible`.
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.js';
import matrix from './site-matrix.json' with { type: 'json' };

export { matrix };

/** sRGB's own transfer function, and relative luminance's per-channel weights. */
const LINEAR_THRESHOLD = 0.03928;
const LINEAR_DIVISOR = 12.92;
const LINEAR_OFFSET = 0.055;
const LINEAR_SCALE = 1.055;
const LINEAR_EXPONENT = 2.4;

/** Relative luminance's per-channel weights, as WCAG 2.2 gives them. */
const WEIGHT_RED = 0.2126;
const WEIGHT_GREEN = 0.7152;
const WEIGHT_BLUE = 0.0722;
const WEIGHTS = [WEIGHT_RED, WEIGHT_GREEN, WEIGHT_BLUE];

/** The additive term in WCAG 2.2's ratio, so neither end can reach zero. */
const RATIO_OFFSET = 0.05;

/** Channels a colour has, and the ones a match must carry to be one. */
const COLOUR_CHANNELS = 3;
const REQUIRED_CHANNELS = 3;

/** Chunks a binary search for a target ratio runs before it settles. */
const SEARCH_STEPS = 24;

/**
 * How far a pixel may sit from a colour and still be read as part of it — for one thing only:
 * keeping a focus indicator out of its own adjacent-surface sample. Text is never excluded this
 * way (the capture is taken with the text transparent), so a background near the text colour is
 * measured rather than quietly skipped.
 */
export const GLYPH_TOLERANCE = 16;

/**
 * The share of a box a colour must paint before it counts as the surface the text sits on. The
 * box excludes the subject's own text, its descendants, and the pseudo-elements that do not sit
 * behind that text, leaving background with texture in it — a colour admitted at a hair's breadth
 * would admit the anti-aliased rim of a 1px decoration, so it must paint at least this share. At
 * 0.5% a 320px-wide box admits a colour after roughly three pixels in a row. Reported with every run.
 */
export const SURFACE_SHARE = 0.005;

/**
 * The width of one histogram bucket: small enough that a gradient still reads as several bands
 * rather than one average, large enough that a hairline's anti-aliased rim is not a dozen buckets.
 */
const BUCKET = 4;

/** Repository root, derived from this file's location. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the built site is; the measurement refuses to run without it rather than building it. */
const DIST = join(ROOT, 'site', 'dist');

/** The base path the site is published under, and therefore the one it is served at here. */
const BASE = '/mecha-turk';

/** Parse an `rgb()`/`rgba()` string into three channels, or null when it is not a colour. */
export function parseColour(value) {
    const match = /^rgba?\(([^)]+)\)$/u.exec(String(value).trim());

    if (match === null) {
        return null;
    }
    const parts = match[1].split(/[,/]/u).map((part) => Number.parseFloat(part.trim()));

    if (parts.length < REQUIRED_CHANNELS || parts.some((part) => Number.isNaN(part))) {
        return null;
    }

    return [parts[0], parts[1], parts[2]];
}

/** One channel through the sRGB transfer function. */
function linearise(channel) {
    const value = channel / 255;

    return value <= LINEAR_THRESHOLD
        ? value / LINEAR_DIVISOR
        : ((value + LINEAR_OFFSET) / LINEAR_SCALE) ** LINEAR_EXPONENT;
}

/** WCAG 2.2 relative luminance of an `rgb()` triple. */
export function luminance(colour) {
    let total = 0;

    for (let index = 0; index < COLOUR_CHANNELS; index += 1) {
        total += (WEIGHTS[index] ?? 0) * linearise(colour[index] ?? 0);
    }

    return total;
}

/** WCAG 2.2's contrast ratio, lighter end over darker. */
export function contrastRatio(foreground, background) {
    const first = luminance(foreground);
    const second = luminance(background);

    return (Math.max(first, second) + RATIO_OFFSET) / (Math.min(first, second) + RATIO_OFFSET);
}

/** Whether a rendered size and weight count as large text in WCAG 2.2. */
export function isLargeText(sizePx, weight) {
    const rule = matrix.largeText;

    return sizePx >= rule.px || (sizePx >= rule.boldPx && weight >= rule.boldWeight);
}

/** The floor a measured text pair is held to, given the size and weight it was read at. */
export function requiredFloor(sizePx, weight) {
    return isLargeText(sizePx, weight) ? matrix.floors.largeText : matrix.floors.normalText;
}

/** `rgb(r, g, b)` for a triple, so a message shows the figure the reader sees. */
export function rgb(colour) {
    return `rgb(${colour.map((channel) => Math.round(channel)).join(', ')})`;
}

/** Squared channel distance between two triples, compared against a squared tolerance. */
export function squaredDistance(left, right) {
    let total = 0;

    for (let index = 0; index < COLOUR_CHANNELS; index += 1) {
        const delta = (left[index] ?? 0) - (right[index] ?? 0);
        total += delta * delta;
    }

    return total;
}

/**
 * The slack an excluded rectangle is grown by, in pixels. A browser reports fractional boxes and
 * a derived rectangle is never exact — a flex host centres its mark, so one built from the leading
 * edge lands a pixel or two off — and a hairline of a 1px `--signal` rule left inside the sample
 * is 0.85% of a navigation label's box, which clears the surface share and reports the wordmark as
 * text painted on its own marker. Three pixels remove that; the slack can only exclude a little
 * more of the border between two boxes, never less of the surface.
 */
const EXCLUSION_SLACK = 3;

/** A rectangle grown to whole pixels, outwards, with the slack above. */
function outward(box) {
    const x = Math.max(Math.floor(box.x) - EXCLUSION_SLACK, 0);
    const y = Math.max(Math.floor(box.y) - EXCLUSION_SLACK, 0);

    return {
        x,
        y,
        width: Math.ceil(box.x + box.width) + EXCLUSION_SLACK - x,
        height: Math.ceil(box.y + box.height) + EXCLUSION_SLACK - y,
    };
}

/**
 * The worst contrast any *surface* colour in a box gives a foreground. The box is walked whole,
 * less the rectangles the page says are not surface, and what remains is histogrammed: the
 * colours painting at least `SURFACE_SHARE` of it are the surfaces, and the **lowest** ratio
 * among them wins, so a gradient band that dips below the floor anywhere a reader can see fails
 * rather than averaging itself away. The capture was taken with the page's text transparent, so
 * there are no glyphs to exclude by proximity — the whole reason the run takes a second frame,
 * since a "worst pixel in the box" rule over an ordinary capture reads a heading's anti-aliased
 * rim as its surface. A `sampled` of zero is a measurement that measured nothing, and the runner
 * reports it rather than reading it as a pass.
 */
export function worstPixelRatio(image, box, foreground, holes = []) {
    const excluded = holes.map((hole) => outward(hole));
    /*
     * Bounds are rounded to whole pixels before the walk: indexing a pixel array at a fractional
     * offset reads `undefined` rather than a colour — a NaN that would surface as a NaN ratio and
     * look like a palette defect rather than an arithmetic one.
     */
    const xStart = Math.max(Math.round(box.x), 0);
    const yStart = Math.max(Math.round(box.y), 0);
    const xEnd = Math.min(Math.round(box.x + box.width), image.width);
    const yEnd = Math.min(Math.round(box.y + box.height), image.height);
    const histogram = new Map();
    let sampled = 0;
    let skipped = 0;

    for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
            const inside = excluded.some(
                (hole) => x >= hole.x && x < hole.x + hole.width && y >= hole.y && y < hole.y + hole.height,
            );

            if (inside) {
                skipped += 1;
                continue;
            }
            const offset = (y * image.width + x) * 4;
            const pixel = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];

            sampled += 1;
            // Quantised before counting, so a smooth ramp lands in a few buckets, each on its own share.
            const key = pixel.map((channel) => Math.round(channel / BUCKET) * BUCKET).join(',');
            const entry = histogram.get(key) ?? { colour: pixel, count: 0 };

            entry.count += 1;
            histogram.set(key, entry);
        }
    }

    const minimum = sampled * SURFACE_SHARE;
    let ratio = Infinity;
    let background = null;
    let surfaces = 0;

    for (const entry of histogram.values()) {
        if (entry.count < minimum) {
            continue;
        }
        surfaces += 1;

        const measured = contrastRatio(foreground, entry.colour);

        if (!(measured < ratio)) {
            continue;
        }

        ratio = measured;
        background = entry.colour;
    }

    return { ratio, background, sampled, skipped, surfaces };
}

/** `share` of the way from one colour to another, as a rounded triple. */
function mix(foreground, background, share) {
    return foreground.map((channel, index) =>
        Math.round(channel + ((background[index] ?? 0) - channel) * share),);
}

/**
 * Mix a colour toward its surface until the pair lands on a target ratio. The injected figures
 * have to be derived rather than typed: a literal low-contrast colour clears one preference
 * cascade comfortably and sits far above the floor in the other, and a negative proof that only
 * bites half the time is not a proof.
 */
export function injectColour(foreground, background, target) {
    let low = 0;
    let high = 1;

    for (let step = 0; step < SEARCH_STEPS; step += 1) {
        const share = (low + high) / 2;
        const mixed = mix(foreground, background, share);

        if (contrastRatio(mixed, background) > target) {
            low = share;
        } else {
            high = share;
        }
    }

    return mix(foreground, background, (low + high) / 2);
}

/** Where the figure for one subject came from, and how far the sample got. */
function sampleOf(pixel) {
    const hasSample = pixel !== undefined && pixel !== null;

    return {
        measured: hasSample ? pixel.ratio : null,
        sampled: hasSample ? pixel.sampled : 0,
        surfaces: hasSample ? pixel.surfaces : 0,
        usable: hasSample && pixel.background !== null,
    };
}

/** The case fields a finding carries when it was measured at a viewport and a preference. */
function whereOf(input) {
    return {
        ...input.page !== undefined && { page: input.page },
        ...input.viewport !== undefined && { viewport: input.viewport },
        ...input.scheme !== undefined && { scheme: input.scheme },
    };
}

/** The figure a subject is judged on: the lower of the two readings, where there are two. */
function ratioOf(sample, computed) {
    return sample.usable ? Math.min(computed, sample.measured) : computed;
}

/** The surface and the name a subject is reported under, which come from the cascade and the DOM. */
function subjectOf(record, sample, computed) {
    const pixelWins = sample.usable && sample.measured < computed;

    return {
        background: pixelWins ? record.pixelBackground : record.background,
        decorative: record.pseudo !== undefined && record.pseudo !== null,
        element: record.element,
        selector: record.selector,
        label: record.label,
        pseudo: record.pseudo ?? null,
    };
}

/**
 * Judge one measured subject against the floor its size and kind carry. The lower of the two
 * readings decides, and a pixel reading is **required** where the cascade reading is known to be
 * incomplete: an ancestor painting an image means the colour under the text is not any declared
 * background, so a cascade-only figure would be one for a surface nobody sees. Where nothing in
 * the chain paints an image, the cascade reading is exact and the sample corroborates it.
 */
export function assessSubject(input) {
    const { pixel, record } = input;
    const sample = sampleOf(pixel);
    const sizePx = Number.parseFloat(record.fontSize);
    const weight = Number.parseFloat(record.fontWeight);
    const foreground = parseColour(record.color) ?? [0, 0, 0];
    const cascadeBackground = [record.background.red, record.background.green, record.background.blue];
    const computed = contrastRatio(foreground, cascadeBackground);
    const floor = requiredFloor(sizePx, weight);
    const gradient = record.gradient ?? null;
    const identity = subjectOf(
        { ...record, pixelBackground: sample.usable ? pixel.background : null },
        sample,
        computed,
    );
    const ratio = ratioOf(sample, computed);

    return {
        ...whereOf(input),
        ...identity,
        passes: ratio >= floor && (gradient === null || sample.usable),
        background: sample.usable && sample.measured < computed ? pixel.background : cascadeBackground,
        foreground,
        source: sample.usable ? 'pixels' : 'cascade',
        measured: sample.measured,
        surfaces: sample.surfaces,
        large: isLargeText(sizePx, weight),
        computed,
        sampled: sample.sampled,
        gradient,
        sizePx,
        weight,
        floor,
        ratio,
        box: record.box ?? null,
    };
}

/**
 * The one-line form a finding is reported in — page, viewport, preference, element, both colours
 * and the ratio, because a contrast number without those is not actionable and a floor that
 * cannot be acted on is a number in a log.
 */
export function describe(finding) {
    const where = [finding.page, finding.viewport, finding.scheme].filter((part) => part !== undefined).join(' ');

    return (
        `${where}: ${finding.label} (${finding.element}${finding.pseudo === null ? '' : finding.pseudo}) is ` +
        `${rgb(finding.foreground)} on ${rgb(finding.background)} at ${finding.ratio.toFixed(2)}:1, ` +
        `below the ${finding.floor}:1 floor`
    );
}

/**
 * Serve `site/dist` at the base path it is published under: every internal link in the built
 * pages is written against `/mecha-turk`, so serving `dist` at the server root would render fine
 * and 404 them all — exactly the base-path mistake the built-output assertion exists to catch. The
 * harness mounts it the same way the address does, so a 404 here is a real one.
 *
 * @returns The loopback server's URL and a closer that also removes the mount.
 */
export async function serveSite() {
    const mount = await mkdtemp(join(tmpdir(), 'mt-site-'));

    await symlink(DIST, join(mount, BASE.slice(1)), 'dir');
    const server = await startServer({ root: mount, port: 0 });

    return {
        url: `${server.url}${BASE}`,
        close: async () => {
            await server.close();
            await rm(mount, { force: true, recursive: true });
        },
    };
}
