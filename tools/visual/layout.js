/**
 * The measurement half of a capture: how one tab body sits, whether it fits,
 * and how tall the viewport has to be to show all of it and nothing else.
 *
 * `shot.js` owns the ordering — activate, fit, probe, capture, verify — and
 * this module owns the arithmetic behind the first two steps. Splitting them
 * keeps each file to one question: here it is *does the panel fit at this
 * width?*, there it is *is this the frame I asked for?*.
 *
 * Everything reads the live document through the harness API `shot.js`
 * hands down; nothing here spawns, captures, or writes a file.
 */

/** Never ask for a viewport shorter than this, whatever the body measures. */
export const MIN_VIEWPORT_HEIGHT = 400;

/** `#root`'s bottom padding in `panel/index.html`, which sizes the region. */
export const ROOT_PAD = 12;

/** Fits the region to the body within this many pixels. */
const FIT_EPSILON = 1;

/** How many viewport adjustments a tab may need to settle. */
const FIT_ATTEMPTS = 4;

/** Pixels a layout may be out by after a resize and still be correct. */
const LAYOUT_TOLERANCE = 2;

/** Characters a tab body must show before it counts as populated. */
const MIN_BODY_TEXT = 200;

/** Ask the harness how one tab body sits in the region that scrolls it. */
export function measure(browser, name) {
    return browser.evaluate(`__MT__.measure('${name}')`);
}

/** Scroll the region to a tab body and report how it landed. */
export function align(browser, name) {
    return browser.evaluate(`__MT__.align('${name}')`);
}

/** Read every tab body as the cascade paints it, plus the strip's answer. */
export function bodyView(browser) {
    return browser.evaluate('__MT__.bodyView()');
}

/**
 * Refuse a tab whose body is missing, unselected, empty, or off-screen.
 *
 * @param input - The tab that was asked for and the measurement that came back.
 * @returns Nothing; it throws on the first contract the measurement breaks.
 */
export function assertLayout(input) {
    const { tab, measurement } = input;

    if (measurement === null) {
        throw new Error(`the panel has no body for "${tab.id}"`);
    }

    if (measurement.active !== tab.label) {
        throw new Error(`the strip selected "${measurement.active}" after "${tab.label}" was pressed`);
    }

    if (measurement.textLength < MIN_BODY_TEXT) {
        throw new Error(`"${tab.label}" rendered no fixture text (${measurement.textLength} characters)`);
    }

    if (Math.abs(measurement.regionHeight - measurement.bodyHeight) > LAYOUT_TOLERANCE) {
        throw new Error(
            `"${tab.label}" does not fit: a ${measurement.bodyHeight}px body in a ` +
                `${measurement.regionHeight}px region — raise --max-height (current limit is generous)`,
        );
    }

    if (
        Math.abs(measurement.visibleTop) > LAYOUT_TOLERANCE ||
        Math.abs(measurement.visibleBottom - measurement.bodyHeight) > LAYOUT_TOLERANCE
    ) {
        throw new Error(
            `"${tab.label}" is not flush with the top of the scroller ` +
                `(visibleTop ${measurement.visibleTop}, visibleBottom ${measurement.visibleBottom})`,
        );
    }
}

/**
 * Refuse a measurement whose page is not laid out at the width asked for.
 *
 * The delivered PNG carries the same assertion on the other side of the
 * capture (`verify.js`), so the contract is checked from both ends: this one
 * fails early and names the width the page reports, before a probe, a strip
 * read-back, and a file are spent on a frame that could not be right.
 *
 * @param measurement - The measurement `measure` just returned.
 * @param width - The viewport width the caller asked for.
 * @returns The same measurement, so the guard reads inline with the returns.
 */
function assertViewportWidth(measurement, width) {
    if (measurement.viewportWidth !== width) {
        throw new Error(
            `the panel is laid out at ${measurement.viewportWidth}px, expected ${width}px — ` +
                'the viewport resize never reached the page',
        );
    }

    return measurement;
}

/**
 * Resize the viewport until the region holds exactly one tab body.
 *
 * @param input - Browser, the tab, the width to hold, and the height ceiling.
 * @returns The measurement the last resize produced, or null when the tab has
 *   no body to fit — so the caller reports that instead of a stale number.
 */
export async function fitViewport(input) {
    const { browser, tab, width, maxHeight } = input;
    let current = await measure(browser, tab.id);

    if (current === null) {
        return null;
    }

    /*
     * Apply the width *before* the fit question is asked, and only when the
     * page is not already laid out at it.
     *
     * The loop below answers "does it fit?" with heights alone, and a panel
     * fitted at a *different* width has the right height for the wrong width
     * — so the early return would skip the very resize that gives the frame
     * its width, and the narrow pass would deliver a byte copy of the wide
     * one. `viewportWidth` is the page's own answer (host.js reads it from
     * the panel's window), not an assumption about what was requested.
     */
    if (current.viewportWidth !== width) {
        await browser.setViewport({
            width,
            height: Math.min(Math.max(current.rootHeight, MIN_VIEWPORT_HEIGHT), maxHeight),
        });
        current = await measure(browser, tab.id);
    }

    for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
        if (current === null) {
            return null;
        }

        const wanted = current.chrome + current.bodyHeight + ROOT_PAD;
        const needed = Math.min(Math.max(wanted, MIN_VIEWPORT_HEIGHT), maxHeight);

        if (Math.abs(needed - current.rootHeight) <= FIT_EPSILON) {
            return assertViewportWidth(current, width);
        }

        await browser.setViewport({ width, height: needed });
        current = await measure(browser, tab.id);
    }

    return current === null ? null : assertViewportWidth(current, width);
}
