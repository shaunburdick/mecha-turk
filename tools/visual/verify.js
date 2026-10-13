/**
 * Proof that a captured frame is the frame that was asked for. Screenshot runs here have silently
 * returned *stale* images before, so nothing trusts a file's existence: every image is decoded and
 * read back through five independent questions — a sentinel probe (at least 90% of a throwaway
 * frame is the colour just painted), no leftover sentinel in the delivered frame, the selected
 * tab's pill fill matching the cascade, the frame's width equal to the width asked for, and a
 * difference from the last capture **at the same width** (frames at different widths are never
 * compared: their overlap is background plus unmoved text). A failure throws, and `shot.js` stops
 * the run rather than publish a picture it cannot vouch for.
 */
import { boxAverage, colorFraction, diffFraction, hexToRgb, readPng } from './png.js';

/** Share of a probe frame that must be the sentinel colour. */
const MIN_PROBE_FRACTION = 0.9;

/** Share of a delivered frame that may be a leftover sentinel. */
const MAX_GHOST_FRACTION = 0.001;

/** Share of pixels two different captures must differ by. */
const MIN_TAB_DIFF = 0.01;

/** Rows of the selected pill the strip read-back samples. */
const STRIP_BAND_ROWS = 4;

/** First row of the pill to sample: inside its corner radius, above its text. */
const STRIP_BAND_TOP = 1;

/** Inset from the pill's edges before sampling, clear of the rounded corners. */
const STRIP_SAMPLE_INSET = 8;

/** How far the measured pill fill may sit from the colour the cascade reports. */
const ACTIVE_FILL_TOLERANCE = 24;

/** A `--full` capture may undershoot the stretched document by this much. */
const FULL_HEIGHT_TOLERANCE = 8;

/** Divisor that turns a 0–1 fraction into whole percentage points. */
const PERCENT_SCALE = 100;

/** Format a fraction as the percentage a run report should quote. */
function percent(fraction) {
    return `${(fraction * PERCENT_SCALE).toFixed(1)}%`;
}

/** Read an `rgb(r, g, b)` colour the cascade reported. */
function parseCssRgb(value) {
    if (!value.startsWith('rgb(')) {
        throw new Error(`the selected fill is not an rgb() colour: ${value}`);
    }

    const channels = value.match(/\d+/g);

    if (channels === null || channels.length < 3) {
        throw new Error(`cannot read channels out of ${value}`);
    }

    return [Number(channels[0]), Number(channels[1]), Number(channels[2])];
}

/** The rectangle of a tab pill worth sampling: top rows, clear of the text. */
function stripBand(tab) {
    return {
        x: tab.x + STRIP_SAMPLE_INSET,
        y: tab.y + STRIP_BAND_TOP,
        width: tab.width - STRIP_SAMPLE_INSET * 2,
        height: STRIP_BAND_ROWS,
    };
}

/** Refuse a delivered frame that still carries any sentinel colour. */
function assertNoSentinel(image, colors) {
    for (const color of colors) {
        const ghost = colorFraction(image, hexToRgb(color));

        if (ghost > MAX_GHOST_FRACTION) {
            throw new Error(`stale frame: ${percent(ghost)} of the image is still sentinel ${color}`);
        }
    }
}

/** Refuse a delivered frame whose strip does not show this tab selected. */
function assertStrip(image, strip) {
    const selected = strip.tabs.find((tab) => tab.selected);

    if (selected === undefined || strip.activeColor === null) {
        throw new Error('the strip reports no selected tab in the captured frame');
    }

    const expected = parseCssRgb(strip.activeColor);
    const measured = boxAverage(image, stripBand(selected));
    const distance =
        Math.abs(measured[0] - expected[0]) +
        Math.abs(measured[1] - expected[1]) +
        Math.abs(measured[2] - expected[2]);

    if (distance > ACTIVE_FILL_TOLERANCE) {
        throw new Error(
            `stale frame: the strip shows no fill on "${selected.label}" ` +
                `(expected rgb(${expected.join(', ')}), measured rgb(${measured.join(', ')}))`,
        );
    }
}

/** Decode a probe capture and insist it is the sentinel just painted; returns the matched fraction. */
function verifyProbe(input) {
    const image = readPng(input.path);
    const fraction = colorFraction(image, hexToRgb(input.color));

    if (fraction < MIN_PROBE_FRACTION) {
        throw new Error(
            `stale frame: ${input.path} is only ${percent(fraction)} sentinel ${input.color}, ` +
                `expected at least ${percent(MIN_PROBE_FRACTION)}`,
        );
    }

    return fraction;
}

/**
 * Decode a delivered capture and run every freshness check against it. The width is asserted
 * rather than inferred: a frame at the wrong width is what a skipped viewport resize looks like
 * (the narrow pass re-delivering the wide bitmap), and the pixel diff cannot be trusted to catch
 * it — two frames of the *same* content at different widths can share 99% of their pixels,
 * because the overlap is background plus left-aligned text that never moved.
 */
function verifyDelivered(input) {
    const image = readPng(input.path);

    if (input.expectedWidth !== null && image.width !== input.expectedWidth) {
        throw new Error(
            `stale frame: ${input.path} is ${image.width}px wide, expected ${input.expectedWidth}px — ` +
                'the viewport resize never reached the capture',
        );
    }

    assertNoSentinel(image, input.probeColors);
    assertStrip(image, input.strip);

    if (input.minimumHeight !== null && image.height < input.minimumHeight - FULL_HEIGHT_TOLERANCE) {
        throw new Error(
            `the full-height capture is ${image.height}px, short of the ${input.minimumHeight}px document — ` +
                'Chrome did not capture beyond the viewport',
        );
    }

    let diff = null;

    if (input.previous !== null) {
        diff = diffFraction(image, input.previous);

        if (diff < MIN_TAB_DIFF) {
            throw new Error(
                `stale frame: ${input.path} repeats the previous capture ` +
                    `(${percent(diff)} of the overlap changed)`,
            );
        }
    }

    return { image, size: `${image.width}x${image.height}`, diff };
}

export { percent, verifyDelivered, verifyProbe };
