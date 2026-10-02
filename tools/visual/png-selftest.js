/**
 * The proof that `png.js` can be trusted.
 *
 * Every check here is offline and deterministic: a synthetic image with three
 * known colour regions is encoded, decoded, written to disk, read back, and
 * measured. If any of it disagrees, the numbers `shot.js` would print about a
 * screenshot are worthless — so `shot.js` runs `selfTest()` before it captures
 * anything, and `tests/visual-tooling.test.ts` runs it in the suite.
 *
 * `node tools/visual/png-selftest.js` prints the same JSON by hand.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
    boxAverage,
    colorFraction,
    decodePng,
    diffFraction,
    encodePng,
    hexToRgb,
    imagesEqual,
    readPng,
} from './png.js';

/** Sample image geometry: a band over a half-and-half body. */
const SAMPLE = { width: 64, height: 40, band: 8, left: 32 };

/** The three colours the sample is built from, as channel triples. */
const SAMPLE_COLOURS = {
    band: { red: 16, green: 208, blue: 112 },
    left: { red: 212, green: 0, blue: 0 },
    right: { red: 0, green: 64, blue: 212 },
};

/** The left-hand colour written as the shorthand the metrics parse. */
const LEFT_HEX = '#d40000';

/** Share of the sample that is its left-hand colour: 32 of 40 rows, half wide. */
const EXPECTED_RED_FRACTION = 0.4;

/** Slack the fraction checks allow, for rounding. */
const FRACTION_SLACK = 0.02;

/** Share of pixels an inverted copy must differ on. */
const EXPECTED_FULL_DIFF = 0.9;

/** Alpha value for pixels the sample writes without one. */
const OPAQUE_ALPHA = 255;

/** Sample file the self-test round-trips through the real file system. */
const SELF_TEST_FILE = '/tmp/opencode/png-selftest.png';

/** Which of the sample's three regions a pixel belongs to. */
function sampleColour(y, x) {
    if (y < SAMPLE.band) {
        return SAMPLE_COLOURS.band;
    }

    if (x < SAMPLE.left) {
        return SAMPLE_COLOURS.left;
    }

    return SAMPLE_COLOURS.right;
}

/** A small RGBA image with three known colour regions. */
function sampleImage() {
    const { width, height } = SAMPLE;
    const data = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const colour = sampleColour(y, x);
            data[offset] = colour.red;
            data[offset + 1] = colour.green;
            data[offset + 2] = colour.blue;
            data[offset + 3] = OPAQUE_ALPHA;
        }
    }

    return { width, height, data };
}

/** Every channel of the sample, flipped — a copy nothing in it can match. */
function invert(sample) {
    const data = Buffer.from(sample.data);

    for (let offset = 0; offset < data.length; offset++) {
        data[offset] = OPAQUE_ALPHA - data[offset];
    }

    return { ...sample, data };
}

/** One self-test outcome, named so a failure says what broke. */
function outcome(result) {
    return { name: result.name, ok: result.ok, detail: result.detail };
}

/** The encoded sample must decode back to the bytes it was made from. */
function checkRoundTrip(sample) {
    const decoded = decodePng(encodePng(sample));

    return outcome({
        name: 'encode → decode round-trips pixel for pixel',
        ok: imagesEqual(sample, decoded),
        detail: `${decoded.width}x${decoded.height}`,
    });
}

/** The same decode, this time through the file system. */
function checkFileRoundTrip(sample) {
    mkdirSync(dirname(SELF_TEST_FILE), { recursive: true });
    writeFileSync(SELF_TEST_FILE, encodePng(sample));
    const decoded = readPng(SELF_TEST_FILE);
    rmSync(SELF_TEST_FILE, { force: true });

    return outcome({
        name: 'readPng reads a written file',
        ok: imagesEqual(sample, decoded),
        detail: SELF_TEST_FILE,
    });
}

/** The metrics must agree with the colours the sample was built from. */
function checkMetrics(sample) {
    const red = colorFraction(sample, hexToRgb(LEFT_HEX));
    const band = boxAverage(sample, { x: 0, y: 0, width: SAMPLE.width, height: SAMPLE.band });
    const unchanged = diffFraction(sample, sample);
    const changed = diffFraction(sample, invert(sample));
    const ok =
        Math.abs(red - EXPECTED_RED_FRACTION) < FRACTION_SLACK &&
        unchanged === 0 &&
        changed > EXPECTED_FULL_DIFF;

    return outcome({
        name: 'colorFraction, boxAverage, and diffFraction agree with the sample',
        ok,
        detail: `red=${red.toFixed(3)} band=${band.join('/')} same=${unchanged} inverted=${changed.toFixed(3)}`,
    });
}

/** Garbage must be refused, not half-decoded. */
function checkGarbage() {
    let refused = false;

    try {
        decodePng(Buffer.from('this is not a png file at all'));
    } catch {
        refused = true;
    }

    return outcome({ name: 'non-PNG bytes are refused', ok: refused, detail: 'decodePng threw' });
}

/**
 * Run every self-test.
 *
 * @returns `{ ok, checks }` — `ok` is false when any check failed.
 */
function selfTest() {
    const sample = sampleImage();
    const checks = [checkRoundTrip(sample), checkFileRoundTrip(sample), checkMetrics(sample), checkGarbage()];

    return { ok: checks.every((check) => check.ok), checks };
}

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

const invokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    const result = selfTest();
    writeLine(JSON.stringify(result, null, 2));
    if (!result.ok) {
        process.exitCode = 1;
    }
}

export { selfTest };
