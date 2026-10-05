/**
 * Minimal PNG codec plus the pixel metrics `shot.js` verifies captures with.
 *
 * The environment has no ImageMagick, no `pdftoppm`, no `pdftocairo`, and no
 * Playwright — so a screenshot is only trustworthy if the tool that took it
 * can read the bytes back. This module decodes what Chrome writes (8-bit,
 * non-interlaced; colour types 0/2/3/4/6) and answers the three questions a
 * freshness check asks:
 *
 * - `colorFraction` — how much of the frame is the sentinel colour?
 * - `boxAverage`    — what colour is the strip's selected pill painted?
 * - `diffFraction`  — how much changed since the previous capture?
 *
 * `png-selftest.js` proves the decoder against a file it encoded itself;
 * `shot.js` runs that proof before it captures anything, so a broken codec
 * fails the run rather than a screenshot.
 *
 * Definitions are ordered callees-before-callers: `no-use-before-define`
 * counts function declarations too, so the leaves come first.
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** Leading bytes of a PNG, as the header reader compares them. */
const PNG_SIGNATURE = 0x89_50_4E_47;

/** The same eight bytes as hex, which `Buffer.from(…, 'hex')` accepts. */
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';

/** Bytes the signature occupies, and so where the first chunk starts. */
const SIGNATURE_BYTES = 8;

/** Fixed layout of a chunk: length at 0, type at 4, body at 8, crc last. */
const CHUNK = { lengthAt: 0, typeAt: 4, bodyAt: 8, frame: 12 };

/** Byte offsets inside an IHDR body, so no bare offset reads the magic. */
const IHDR = { width: 0, height: 4, bitDepth: 8, colorType: 9, compression: 10, filter: 11, interlace: 12, size: 13 };

/** Bit depth the self-test writes and the decoder accepts. */
const BIT_DEPTH = 8;

/** Colour type numbers, as PNG spells them. */
const COLOR_TYPES = { rgba: 6, rgb: 2, grayAlpha: 4, palette: 3, gray: 0 };

/** Bytes per pixel for each of those colour types. */
const CHANNELS = { rgba: 4, rgb: 3, grayAlpha: 2, gray: 1, palette: 1 };

/** Bytes a PNG row filter can hide behind, and the filter numbers. */
const FILTERS = { none: 0, sub: 1, up: 2, average: 3, paeth: 4 };

/** Alpha value for a colour type that carries none. */
const OPAQUE_ALPHA = 255;

/** Width every pixel row wraps to, since filters carry single bytes. */
const BYTE_WRAP = 256;

/** Radix `parseInt` needs for the `#rrggbb` shorthand. */
const HEX_RADIX = 16;

/** Byte ranges `hexToRgb` slices out of `#rrggbb`. */
const HEX_SLICES = { red: { from: 1, to: 3 }, green: { from: 3, to: 5 }, blue: { from: 5, to: 7 } };

/** Default colour distance, as a sum of per-channel differences. */
const DEFAULT_TOLERANCE = 6;

/** Default distance above which two pixels count as changed. */
const DEFAULT_DIFF_THRESHOLD = 30;

/**
 * Parse `#rrggbb` into the `[red, green, blue]` triple the metrics use.
 *
 * @param hex - Six hex digits with a leading `#`.
 * @returns Three channel values, 0–255 each.
 */
function hexToRgb(hex) {
    return [
        Number.parseInt(hex.slice(HEX_SLICES.red.from, HEX_SLICES.red.to), HEX_RADIX),
        Number.parseInt(hex.slice(HEX_SLICES.green.from, HEX_SLICES.green.to), HEX_RADIX),
        Number.parseInt(hex.slice(HEX_SLICES.blue.from, HEX_SLICES.blue.to), HEX_RADIX),
    ];
}

/**
 * Sum-of-channels distance between one pixel and one colour.
 *
 * @param data - RGBA bytes of the image.
 * @param point - `{ offset, rgb }`, the pixel's index and the colour to beat.
 * @returns Distance, 0 when the channels match exactly.
 */
function colorDistance(data, point) {
    const { offset, rgb } = point;

    return (
        Math.abs(data[offset] - rgb[0]) +
        Math.abs(data[offset + 1] - rgb[1]) +
        Math.abs(data[offset + 2] - rgb[2])
    );
}

/** Map a colour type to its bytes per pixel, or refuse it. */
function channelsOf(colorType) {
    if (colorType === COLOR_TYPES.rgba) {
        return CHANNELS.rgba;
    }

    if (colorType === COLOR_TYPES.rgb) {
        return CHANNELS.rgb;
    }

    if (colorType === COLOR_TYPES.grayAlpha) {
        return CHANNELS.grayAlpha;
    }

    if (colorType === COLOR_TYPES.palette) {
        return CHANNELS.palette;
    }

    if (colorType === COLOR_TYPES.gray) {
        return CHANNELS.gray;
    }

    throw new Error(`unsupported PNG colour type ${colorType}`);
}

/** Read and validate the one header this decoder supports. */
function readHeader(body) {
    const header = {
        width: body.readUInt32BE(IHDR.width),
        height: body.readUInt32BE(IHDR.height),
        bitDepth: body.readUInt8(IHDR.bitDepth),
        colorType: body.readUInt8(IHDR.colorType),
        interlace: body.readUInt8(IHDR.interlace),
    };

    if (header.bitDepth !== BIT_DEPTH) {
        throw new Error(`unsupported PNG bit depth ${header.bitDepth}`);
    }

    if (header.interlace !== FILTERS.none) {
        throw new Error('interlaced PNG is not supported');
    }

    return header;
}

/** Paeth's predictor: whichever neighbour the estimate sits closest to. */
function paeth(values) {
    const { left, above, upperLeft } = values;
    const estimate = left + above - upperLeft;
    const fromLeft = Math.abs(estimate - left);
    const fromAbove = Math.abs(estimate - above);
    const fromCorner = Math.abs(estimate - upperLeft);

    if (fromLeft <= fromAbove && fromLeft <= fromCorner) {
        return left;
    }

    if (fromAbove <= fromCorner) {
        return above;
    }

    return upperLeft;
}

/** The value a filter type says this byte was encoded with. */
function predictor(values) {
    const { filter, left, above, upperLeft } = values;

    if (filter === FILTERS.sub) {
        return left;
    }

    if (filter === FILTERS.up) {
        return above;
    }

    if (filter === FILTERS.average) {
        return Math.floor((left + above) / 2);
    }

    if (filter === FILTERS.paeth) {
        return paeth({ left, above, upperLeft });
    }

    if (filter === FILTERS.none) {
        return 0;
    }

    throw new Error(`unknown PNG row filter ${filter}`);
}

/** Undo one row filter, byte by byte. */
function unfilteredRow(values) {
    const { filter, line, previous, bytesPerPixel } = values;
    const current = Buffer.alloc(line.length);

    for (const [index, element] of line.entries()) {
        const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
        const above = previous[index];
        const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
        const added = predictor({ filter, left, above, upperLeft });

        current[index] = (element + added) % BYTE_WRAP;
    }

    return current;
}

/** Reverse PNG's per-row filters, returning the raw scanlines. */
function unfilter(input) {
    const { raw, stride, height, bytesPerPixel } = input;
    const rows = [];
    let offset = 0;
    let previous = Buffer.alloc(stride);

    for (let row = 0; row < height; row++) {
        const filter = raw[offset];
        const line = raw.subarray(offset + 1, offset + 1 + stride);
        offset += stride + 1;
        const current = unfilteredRow({ filter, line, previous, bytesPerPixel });
        rows.push(current);
        previous = current;
    }

    return Buffer.concat(rows);
}

/** Three-channel rows to four. */
function expandRgb(pixels) {
    const rgba = Buffer.alloc((pixels.length / CHANNELS.rgb) * 4);

    for (let source = 0, target = 0; source < pixels.length; source += CHANNELS.rgb, target += 4) {
        rgba[target] = pixels[source];
        rgba[target + 1] = pixels[source + 1];
        rgba[target + 2] = pixels[source + 2];
        rgba[target + 3] = OPAQUE_ALPHA;
    }

    return rgba;
}

/** One-channel grey rows to four. */
function expandGray(pixels) {
    const rgba = Buffer.alloc(pixels.length * 4);

    for (const [index, pixel] of pixels.entries()) {
        const target = index * 4;
        rgba[target] = pixel;
        rgba[target + 1] = pixel;
        rgba[target + 2] = pixel;
        rgba[target + 3] = OPAQUE_ALPHA;
    }

    return rgba;
}

/** Two-channel grey-plus-alpha rows to four. */
function expandGrayAlpha(pixels) {
    const rgba = Buffer.alloc((pixels.length / CHANNELS.grayAlpha) * 4);

    for (let source = 0, target = 0; source < pixels.length; source += CHANNELS.grayAlpha, target += 4) {
        rgba[target] = pixels[source];
        rgba[target + 1] = pixels[source];
        rgba[target + 2] = pixels[source];
        rgba[target + 3] = pixels[source + 1];
    }

    return rgba;
}

/** Resolve palette indices (and their optional alpha) to RGBA. */
function expandPalette(input) {
    const { pixels, chunks } = input;
    const { palette, transparency } = chunks;

    if (palette === null) {
        throw new Error('paletted PNG has no palette');
    }

    const rgba = Buffer.alloc(pixels.length * 4);

    for (const [index, pixel] of pixels.entries()) {
        const entry = pixel * 3;
        const target = index * 4;
        rgba[target] = palette[entry];
        rgba[target + 1] = palette[entry + 1];
        rgba[target + 2] = palette[entry + 2];
        rgba[target + 3] = transparency === null ? OPAQUE_ALPHA : transparency[pixel];
    }

    return rgba;
}

/** Expand decoded scanlines to RGBA, whatever colour type they arrived as. */
function expandToRgba(input) {
    const { colorType, pixels, chunks } = input;

    if (colorType === COLOR_TYPES.rgba) {
        return pixels;
    }

    if (colorType === COLOR_TYPES.rgb) {
        return expandRgb(pixels);
    }

    if (colorType === COLOR_TYPES.gray) {
        return expandGray(pixels);
    }

    if (colorType === COLOR_TYPES.grayAlpha) {
        return expandGrayAlpha(pixels);
    }

    if (colorType === COLOR_TYPES.palette) {
        return expandPalette({ pixels, chunks });
    }

    throw new Error(`unsupported PNG colour type ${colorType}`);
}

/**
 * Record one chunk, and say whether the scan should go on.
 *
 * Its own function so the scan loop has no `break` buried inside it: `IEND`
 * answering "stop" is a fact about the format, and the loop reading that answer
 * is the whole shape of the thing.
 *
 * @param {object} chunks - The accumulator the scan fills.
 * @param {string} type - Four-character chunk type.
 * @param {Buffer} body - The chunk's bytes.
 * @returns `false` at `IEND`, `true` otherwise.
 */
function applyChunk(chunks, type, body) {
    switch (type) {
        case 'IHDR': {
            chunks.header = readHeader(body);

            return true;
        }

        case 'PLTE': {
            chunks.palette = Buffer.from(body);

            return true;
        }

        case 'tRNS': {
            chunks.transparency = Buffer.from(body);

            return true;
        }

        case 'IDAT': {
            chunks.data.push(Buffer.from(body));

            return true;
        }

        default: {
            return type !== 'IEND';
        }
    }
}

/**
 * The chunks a finished file must have produced.
 *
 * A separate step so the scan can stop the moment it sees `IEND` *and* still go
 * through the same check: reaching the end of the buffer without an `IEND` is
 * just as truncated as one that ends early.
 */
function finishedChunks(chunks) {
    if (chunks.header === null || chunks.data.length === 0) {
        throw new Error('not a PNG: no header or no image data');
    }

    return chunks;
}

/** Split the file into its header, palette, and concatenated image data. */
function parseChunks(buffer) {
    const chunks = { header: null, palette: null, transparency: null, data: [] };
    let offset = SIGNATURE_BYTES;

    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + CHUNK.typeAt, offset + CHUNK.bodyAt);
        const body = buffer.subarray(offset + CHUNK.bodyAt, offset + CHUNK.bodyAt + length);

        offset += CHUNK.frame + length;

        if (!applyChunk(chunks, type, body)) {
            break;
        }
    }

    return finishedChunks(chunks);
}

/**
 * Decode PNG bytes into `{ width, height, data }`, `data` being RGBA.
 *
 * @param buffer - Whole PNG file.
 * @returns The image, with every pixel expanded to four channels.
 */
function decodePng(buffer) {
    if (buffer.length < SIGNATURE_BYTES || buffer.readUInt32BE(0) !== PNG_SIGNATURE) {
        throw new Error('not a PNG: the signature bytes are wrong');
    }

    const chunks = parseChunks(buffer);
    const { width, height, colorType } = chunks.header;
    const bytesPerPixel = channelsOf(colorType);
    const pixels = unfilter({
        raw: inflateSync(Buffer.concat(chunks.data)),
        stride: width * bytesPerPixel,
        height,
        bytesPerPixel,
    });

    return { width, height, data: expandToRgba({ colorType, pixels, chunks }) };
}

/** Read a PNG file from disk into an RGBA image. */
function readPng(path) {
    return decodePng(readFileSync(path));
}

/**
 * Fraction of pixels whose colour is within `DEFAULT_TOLERANCE` of `rgb`.
 *
 * @param rgb - `[red, green, blue]` to look for.
 * @returns Matched fraction of all pixels, 0–1.
 */
function colorFraction(image, rgb) {
    let hits = 0;

    for (let offset = 0; offset < image.data.length; offset += 4) {
        if (colorDistance(image.data, { offset, rgb }) <= DEFAULT_TOLERANCE) {
            hits++;
        }
    }

    return hits / (image.width * image.height);
}

/**
 * Mean colour of a rectangle of the image — how the strip pill is read back.
 *
 * @param box - `{ x, y, width, height }` in image pixels.
 * @returns The `[red, green, blue]` mean, or black for an empty box.
 */
function boxAverage(image, box) {
    const xEnd = Math.min(box.x + box.width, image.width);
    const yEnd = Math.min(box.y + box.height, image.height);
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;

    for (let y = Math.max(box.y, 0); y < yEnd; y++) {
        for (let x = Math.max(box.x, 0); x < xEnd; x++) {
            const offset = (y * image.width + x) * 4;
            red += image.data[offset];
            green += image.data[offset + 1];
            blue += image.data[offset + 2];
            count++;
        }
    }

    if (count === 0) {
        return [0, 0, 0];
    }

    return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
}

/**
 * Fraction of the two images' shared top-left region that differs.
 *
 * Captures are sized to their tab, so heights differ; the overlap is what can
 * be compared, and a stale frame reproduces it exactly — which is the failure
 * this metric exists to catch.
 *
 * @param left - The image just written.
 * @param right - The image written before it.
 * @returns Changed fraction of the overlap, 0–1.
 */
function diffFraction(left, right) {
    const width = Math.min(left.width, right.width);
    const height = Math.min(left.height, right.height);
    let changed = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const here = (y * left.width + x) * 4;
            const there = (y * right.width + x) * 4;
            const distance =
                Math.abs(left.data[here] - right.data[there]) +
                Math.abs(left.data[here + 1] - right.data[there + 1]) +
                Math.abs(left.data[here + 2] - right.data[there + 2]);

            if (distance > DEFAULT_DIFF_THRESHOLD) {
                changed++;
            }
        }
    }

    return changed / (width * height);
}

/** Two images identical in size and bytes. */
function imagesEqual(left, right) {
    if (left.width !== right.width || left.height !== right.height || left.data.length !== right.data.length) {
        return false;
    }

    return left.data.equals(right.data);
}

/** The eight bytes a PNG file must open with. */
function signatureBytes() {
    return Buffer.from(PNG_SIGNATURE_HEX, 'hex');
}

/** One length-prefixed, checksummed PNG chunk. */
function chunk(type, data) {
    const framed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(CHUNK.frame + data.length);
    out.writeUInt32BE(data.length, CHUNK.lengthAt);
    framed.copy(out, CHUNK.typeAt);
    out.writeUInt32BE(crc32(framed), CHUNK.bodyAt + data.length);

    return out;
}

/**
 * Encode an RGBA image as a PNG file — the self-test's known input, and the
 * only way to *write* a screenshot-sized image without a dependency.
 *
 * @param image - `{ width, height, data }` with four bytes per pixel.
 * @returns A complete PNG file.
 */
function encodePng(image) {
    const header = Buffer.alloc(IHDR.size);
    header.writeUInt32BE(image.width, IHDR.width);
    header.writeUInt32BE(image.height, IHDR.height);
    header.writeUInt8(BIT_DEPTH, IHDR.bitDepth);
    header.writeUInt8(COLOR_TYPES.rgba, IHDR.colorType);
    header.writeUInt8(FILTERS.none, IHDR.compression);
    header.writeUInt8(FILTERS.none, IHDR.filter);
    header.writeUInt8(FILTERS.none, IHDR.interlace);

    const stride = image.width * CHANNELS.rgba;
    const scanlines = Buffer.alloc(image.height * (1 + stride));
    for (let row = 0; row < image.height; row++) {
        const source = row * stride;
        const target = row * (1 + stride);
        scanlines[target] = FILTERS.none;
        image.data.copy(scanlines, target + 1, source, source + stride);
    }

    return Buffer.concat([
        signatureBytes(),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(scanlines)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

export {
    boxAverage,
    colorFraction,
    decodePng,
    diffFraction,
    encodePng,
    hexToRgb,
    imagesEqual,
    readPng,
    signatureBytes,
};
