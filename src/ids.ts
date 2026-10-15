/**
 * Correlation and clock helpers shared by the panel and its tests: every
 * ledger entry and evidence record carries a correlation id so a poll, a
 * dispatch, and a lifecycle phase tie back to one observation (NFR-007).
 */

/**
 * Which source {@link newCorrelationId} would draw from in this environment,
 * as FR-142's milestone announces it: the native `randomUUID`, the
 * `getRandomValues` fallback, or neither (FR-144's refusal).
 */
export type CorrelationIdMode = 'randomUUID' | 'getRandomValues' | 'unavailable';

/**
 * The byte count a UUIDv4 is assembled from, and the RFC 4122 shapes the mint
 * applies to it: byte 6 carries version 4 (low nibble `4`), byte 8 carries the
 * `10x` variant. The `mod`/`tag` pairs are the arithmetic spellings of
 * `& 0x0f | 0x40` and `& 0x3f | 0x80` — the repo's lint forbids bitwise
 * operators, and neither pair of bits overlaps, so the sums are identical.
 */
const UUID_BYTES = 16;
const VERSION_BYTE = 6;
const VERSION_MOD = 16;
const VERSION_TAG = 64;
const VARIANT_BYTE = 8;
const VARIANT_MOD = 64;
const VARIANT_TAG = 128;
const HEX_RADIX = 16;
/** Group widths of the 8-4-4-4-12 spelling; the last group takes the rest. */
const UUID_HEAD_GROUP = 8;
const UUID_GROUP_WIDTHS = [UUID_HEAD_GROUP, 4, 4, 4] as const;

/**
 * Assemble one UUIDv4 from 16 CSPRNG bytes: 8-4-4-4-12 lowercase hex, version
 * nibble `4`, RFC 4122 variant nibble — byte-level what `randomUUID` produces,
 * so stored rows, audit rows, and the copy affordance cannot tell the two mint
 * paths apart (FR-144).
 */
function uuidV4(bytes: Uint8Array): string {
    const hex = Array.from(bytes, (byte, index) => {
        const withVersion = index === VERSION_BYTE ? (byte % VERSION_MOD) + VERSION_TAG : byte;
        const withVariant = index === VARIANT_BYTE ? (withVersion % VARIANT_MOD) + VARIANT_TAG : withVersion;

        return withVariant.toString(HEX_RADIX).padStart(2, '0');
    }).join('');

    const groups: string[] = [];
    let at = 0;
    for (const width of UUID_GROUP_WIDTHS) {
        groups.push(hex.slice(at, at + width));
        at += width;
    }

    groups.push(hex.slice(at));

    return groups.join('-');
}

/**
 * Which mint this environment can use (FR-142's announced mode).
 *
 * The preference order `newCorrelationId` follows: the native API where the
 * context exposes it, the same `Crypto` interface's CSPRNG where it does not,
 * and `unavailable` only when neither exists.
 */
export function correlationIdMode(): CorrelationIdMode {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'randomUUID';
    }

    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        return 'getRandomValues';
    }

    return 'unavailable';
}

/**
 * Create a new correlation identifier.
 *
 * The strongest available source of the same `Crypto` interface mints it
 * (FR-144): `randomUUID()` where the context exposes it — secure contexts
 * only — and otherwise a UUIDv4 assembled from `getRandomValues` over the same
 * OS-seeded entropy, so a plain-HTTP self-hosted install starts instead of
 * dying at runtime construction. Only when neither API exists does the mint
 * refuse, rather than fall back to weaker entropy: `Math.random()` is not a
 * third source and appears nowhere in this path.
 *
 * @throws {Error} When neither API is available — the refusal FR-141 renders
 *   as a categorized startup failure, never a fallback.
 */
export function newCorrelationId(): string {
    const mode = correlationIdMode();
    if (mode === 'randomUUID') {
        return crypto.randomUUID();
    }

    if (mode === 'getRandomValues') {
        return uuidV4(crypto.getRandomValues(new Uint8Array(UUID_BYTES)));
    }

    throw new Error('crypto.randomUUID is unavailable; refusing to record an observation without a correlation id');
}

/**
 * Read the current time as an RFC 3339 timestamp.
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Zero-pad one `Date` getter to two characters.
 */
function padTwoDigits(part: number): string {
    return String(part).padStart(2, '0');
}

/**
 * Render one stamp as a compact UTC minute (`2026-09-28 09:00`).
 *
 * Absolute rather than relative: two references detected minutes apart must
 * not collapse into the same "2m ago" when the operator is reconstructing
 * which reason fired first, an audit row's timestamp is the same kind of
 * fact, and a binding's created/updated stamps are read the same way.
 *
 * @returns The compact stamp, or the stored text when it is not a time.
 */
export function utcStamp(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
        return iso;
    }

    const value = new Date(at);

    return `${value.getUTCFullYear()}-${padTwoDigits(value.getUTCMonth() + 1)}-${padTwoDigits(value.getUTCDate())}`
        + ` ${padTwoDigits(value.getUTCHours())}:${padTwoDigits(value.getUTCMinutes())}`;
}
