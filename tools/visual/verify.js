/**
 * Proof that a captured frame is the frame that was asked for.
 *
 * Screenshot runs in this environment have silently returned *stale* images
 * before — the picture of a page that had already been navigated away from —
 * so nothing here trusts a file's existence. Every image is decoded and read
 * back, and four independent questions are put to it:
 *
 * 1. **Sentinel probe** (`verifyProbe`): right before each capture, `host.js`
 *    covers the document with a per-capture colour and a throwaway screenshot
 *    is decoded. At least 90% of its pixels must be exactly that colour — a
 *    frame from one step earlier cannot be.
 * 2. **No leftover sentinel** (`assertNoSentinel`): the delivered frame must
 *    contain no trace of any sentinel colour, so it is not a probe frame.
 * 3. **Strip read-back** (`assertStrip`): the fill of the *selected* tab's
 *    pill, sampled where the DOM said it would be, must match the colour the
 *    cascade reports. A frame showing the previously selected tab paints the
 *    wrong pill and fails here.
 * 4. **Width read-back** (`verifyDelivered`): the frame's width must equal
 *    the width that was asked for — a narrow pass that quietly reused the
 *    wide viewport delivers the wrong width, and no pixel comparison of two
 *    *same-content* frames can be relied on to notice.
 * 5. **Consecutive difference** (`verifyDelivered`): the frame must differ
 *    from the last capture **at the same width**, which a re-emitted old
 *    frame does not. Frames at different widths are never compared: their
 *    overlap is background plus left-aligned text that did not move, so a
 *    genuine pair can sit under any sane threshold.
 *
 * A failure throws, and `shot.js` stops the run rather than publish a picture
 * it cannot vouch for.
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

/**
 * Decode a probe capture and insist it is the sentinel just painted.
 *
 * @param input - `{ path, color }`, the throwaway frame and its colour.
 * @returns The matched fraction, for the run's report.
 */
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
 * Decode a delivered capture and run every freshness check against it.
 *
 * The width is asserted rather than inferred: a frame whose width is not the
 * width that was asked for is exactly what a skipped viewport resize looks
 * like (the narrow pass re-delivering the wide bitmap), and the pixel diff
 * cannot be trusted to catch it — two frames of the *same* content at
 * different widths can legitimately share 99% of their pixels, because the
 * overlap is background plus left-aligned text that never moved.
 *
 * @param input - `{ path, strip, probeColors, expectedWidth, previous, minimumHeight }`.
 * @returns `{ image, size, diff }` for the report and the next comparison.
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
