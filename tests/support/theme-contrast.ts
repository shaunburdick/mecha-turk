/**
 * The panel's colours as a *fixture* resolves them, offline.
 *
 * 005 NFR-107 puts three states side by side — the host light theme, the host dark theme, and
 * the host-alias-unavailable frame — and requires measured contrast in each. This module is the
 * deterministic half of that evidence: it reads the **shipped** `panel/index.html` stylesheet,
 * resolves the custom properties for one fixture, and evaluates WCAG 2.2's ratio over named
 * selector/property pairs.
 *
 * ## What this is not
 *
 * It is not a CSS engine, and it says so in the places where that matters:
 *
 * - a declaration is resolved **by exact selector**, not by matching an element. A selector
 *   list, a media query, or a specificity contest between two rules for one element is not
 *   modelled. The panel's own text and boundary roles each live on one selector (asserted in
 *   `panel-theme-contrast.test.ts`), which is what makes an exact match the whole answer.
 * - `@media` rules are read only when a case names them; a viewport-dependent declaration is
 *   never silently folded into the resting answer.
 * - `color-mix()` is resolved for the shape the panel uses — one colour at a percentage against
 *   `transparent` — and refused otherwise, because the general form needs a backdrop this
 *   module does not carry.
 *
 * The rendered half of the evidence is the offline harness (`tools/visual/host.js`), which
 * reads `getComputedStyle` for the same roles in a real browser. Two independent measurements
 * of one stylesheet beat one measurement believed twice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import hostFixtures from '../../tools/visual/theme-fixtures.json';
import { parseStylesheet, styleText } from './stylesheet.ts';
import type { StyleRule } from './stylesheet.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..', '..');

/** The shipped panel document: its stylesheet is the thing under test. */
const PANEL_HTML = readFileSync(resolve(ROOT, 'panel', 'index.html'), 'utf8');

/** The panel's own rules, parsed once for every case in the suite. */
const PANEL_RULES = parseStylesheet(styleText(PANEL_HTML));

/** Font size, in CSS pixels, above which WCAG 2.2 counts text as large. */
export const LARGE_PX = 24;

/** Font size, in CSS pixels, at which bold text counts as large. */
export const LARGE_BOLD_PX = 18.66;

/** Weight at or above which WCAG 2.2's bold definition holds. */
export const BOLD_WEIGHT = 700;

/** NFR-107's floor for normal text, and for large text, and for a meaningful boundary. */
export const NORMAL_FLOOR = 4.5;
export const LARGE_FLOOR = 3;
export const NON_TEXT_FLOOR = 3;

/** How many `var()` hops a reference may take before the reader stops following it. */
const MAX_REFERENCE_HOPS = 8;

/** The root font size `rem` is measured against, in CSS pixels. */
const ROOT_FONT_PX = 16;

/** Percentage shares are read against a whole hundred. */
const PERCENT_BASE = 100;

/** How many hex characters make one channel, and the base they are read in. */
const CHANNEL_WIDTH = 2;
const HEX_RADIX = 16;

/**
 * The sRGB transfer function's two branches, and the luminance weights WCAG 2.2 gives each
 * channel. Named rather than inlined so the arithmetic below reads as WCAG's, not as constants.
 */
const LINEAR_THRESHOLD = 0.03928;
const LINEAR_DIVISOR = 12.92;
const LINEAR_OFFSET = 0.055;
const LINEAR_SCALE = 1.055;
const LINEAR_EXPONENT = 2.4;
const WEIGHT_RED = 0.2126;
const WEIGHT_GREEN = 0.7152;
const WEIGHT_BLUE = 0.0722;
const LUMINANCE_WEIGHTS: readonly number[] = [WEIGHT_RED, WEIGHT_GREEN, WEIGHT_BLUE];

/** The additive term WCAG 2.2's ratio carries, so neither end can reach zero. */
const RATIO_OFFSET = 0.05;

/** Every channel value a byte-scale channel can hold. */
const MAX_CHANNEL = 255;

/** One host-theme state the panel is measured in. */
export interface Fixture {
    /** `light`, `dark`, or `fallback`. */
    readonly name: string;
    /** The declarations the pinned SDK would have written on the guest root, by property. */
    readonly root: ReadonlyMap<string, string>;
    /**
     * The colour a transparent surface composites onto: the frame's canvas.
     *
     * The SDK paints no background on the guest root, so whatever is behind a transparent panel
     * surface is the **user agent's** canvas, which follows `color-scheme` — white under `light`,
     * black under `dark`. Getting this wrong would report the dark theme's own text as 1.2:1
     * against a white it is never painted on.
     */
    readonly canvas: string;
    /**
     * The colour `inherit` and `currentColor` resolve to in this frame.
     *
     * The panel's last-resort text colour is `inherit` and its last-resort rule colour is
     * `currentColor`, so the fallback frame's text contrast cannot be measured without them.
     * Where the SDK wrote `color`, that is the answer; where it did not, it is the canvas text
     * of the `color-scheme` the frame keeps — black under `light`, white under `dark`.
     */
    readonly currentText: string;
}

/** A colour, with the alpha a `color-mix(…, transparent)` boundary carries. */
export interface Colour {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    /** 0–1. */
    readonly alpha: number;
}

/** One measured role: where its colour comes from, and what it is read against. */
export interface Case {
    /** The role, as a failure message names it. */
    readonly what: string;
    /** The selector whose declaration supplies the colour. */
    readonly selector: string;
    /** The property read from it. */
    readonly property: string;
    /** The selector that paints the surface behind it, or null for the canvas. */
    readonly surface: string | null;
    /** The property on that surface. */
    readonly surfaceProperty: string;
    /** What the floor applies to — see `CASES` in `theme-cases.ts`. */
    readonly kind: 'text' | 'focus' | 'decoration';
    /** A declaration that replaces the stylesheet's, used by the red-first cases. */
    readonly overrides?: Readonly<Record<string, string>>;
}

/**
 * The four inherited declarations the SDK writes beside the aliases, and the panel aliases
 * themselves.
 *
 * They live here rather than in the harness's module because `tsconfig.json` does not include
 * `tools/`, so a TypeScript import of that plain-JS module resolves to `any` — and a suite whose
 * job is to prove the panel's colours cannot hold untyped values. The list is *data about the
 * SDK*, and it is asserted against the SDK's own source by `sdkAliasTable`'s callers.
 */
export const HOST_INHERITED_PROPERTIES = ['color', 'font-family', 'font-size', 'line-height'];

/** A measured pair, or the reason it could not be measured. */
export type Measurement = string | { readonly ratio: number; readonly foreground: Colour; readonly background: Colour };

/** Every colour keyword this reader knows, by name. */
const KEYWORDS = new Map<string, Colour>([
    ['transparent', { red: 0, green: 0, blue: 0, alpha: 0 }],
    ['white', { red: MAX_CHANNEL, green: MAX_CHANNEL, blue: MAX_CHANNEL, alpha: 1 }],
    ['black', { red: 0, green: 0, blue: 0, alpha: 1 }],
    ['gray', { red: 128, green: 128, blue: 128, alpha: 1 }],
    ['grey', { red: 128, green: 128, blue: 128, alpha: 1 }],
]);

/** The alias→token-key table, read out of the pinned SDK's own source. */
function readSdkSource(): string {
    return readFileSync(
        resolve(ROOT, 'node_modules', '@openchamber', 'sdk', 'dist', 'ui', 'theme.js'),
        'utf8',
    );
}

/** Lower-case a selector and collapse the whitespace a minifier or an author may vary. */
function normalise(selector: string): string {
    return selector.trim().toLowerCase().replaceAll(/\s*([>+~])\s*/gu, '$1').replaceAll(/\s+/gu, ' ');
}

/**
 * One `var(--name[, fallback])` call, as `substituteReferences` reads it.
 *
 * `start`/`end` are the span the call occupies in the value it was found in, so a replacement
 * rebuilds the string without re-scanning what it has already written.
 */
interface VarReference {
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly fallback: string | undefined;
}

/**
 * Where a `var()` call begins, with the reference name it carries.
 *
 * `g` rather than `y`, so a malformed call is skipped instead of stopping the search — the scan
 * below advances `lastIndex` past it and looks for the next one.
 */
const REFERENCE_HEAD = /var\(\s*(--[a-z0-9-]+)/giu;

/**
 * The index of the `)` closing the `(` at `open`, or `-1` when the brackets do not balance.
 *
 * Counted rather than matched: a pattern that spans balanced parentheses needs a quantifier
 * inside a quantified group, which is the nested-quantifier shape a ReDoS checker refuses — and
 * refuses correctly, since such a pattern is judged over input length rather than over intent.
 * The input here is the panel's own committed stylesheet, but counting brackets is three lines
 * and costs less than the argument that the old pattern was safe.
 */
function closingBracket(value: string, open: number): number {
    let depth = 0;

    for (let index = open; index < value.length; index += 1) {
        const character = value[index];

        if (character === '(') {
            depth += 1;
        } else if (character === ')') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

/**
 * The first well-formed reference at or after `from`, or null when there is none.
 *
 * A `var(` whose closing bracket never arrives, or whose tail is neither empty nor a `,`-led
 * fallback, is passed over rather than reported: it is left exactly as written in the output,
 * and the well-formed calls behind it are still resolved.
 */
function readReference(value: string, from: number): VarReference | null {
    REFERENCE_HEAD.lastIndex = from;

    for (let head = REFERENCE_HEAD.exec(value); head !== null; head = REFERENCE_HEAD.exec(value)) {
        const name = head[1];
        // The count starts *on* the bracket inside what was matched: starting past it leaves the
        // opening bracket uncounted, so the first `)` drives the depth negative and no call closes.
        const open = head.index + head[0].indexOf('(');
        const end = closingBracket(value, open);

        if (name !== undefined && end !== -1) {
            // Everything between the name and the call's own bracket: nothing at all, or a
            // comma-led fallback. Nesting is already spent by `closingBracket`, so one level or
            // three arrive here as text either way — `var(--oc-fg, var(--surface-foreground,
            // inherit))` keeps its fallback rather than being truncated at the inner `)`.
            const rest = value.slice(head.index + head[0].length, end).trim();

            if (rest === '' || rest.startsWith(',')) {
                return {
                    start: head.index,
                    end: end + 1,
                    name,
                    fallback: rest === '' ? undefined : rest.slice(1).trim(),
                };
            }
        }
        REFERENCE_HEAD.lastIndex = open;
    }

    return null;
}

/**
 * One left-to-right pass over a value: each reference swapped for the property's value when the
 * property exists, its own fallback when it does not, and itself when it carries neither.
 */
function substituteOnce(value: string, properties: ReadonlyMap<string, string>): string {
    let rebuilt = '';
    let cursor = 0;
    let found = readReference(value, cursor);

    while (found !== null) {
        const resolved = properties.get(found.name.toLowerCase());

        rebuilt += value.slice(cursor, found.start);
        rebuilt += resolved ?? found.fallback ?? value.slice(found.start, found.end);
        cursor = found.end;
        found = readReference(value, cursor);
    }

    return rebuilt + value.slice(cursor);
}

/**
 * Replace every `var(--x)` in a value with the property's computed value, to a fixed depth.
 *
 * The depth bound is the same reason the site audit has one: a self-referential declaration
 * would otherwise spin. A reference that does not resolve within it is left as written, and the
 * colour reader refuses it — an unreadable value is a finding, not a silent pass.
 */
function substituteReferences(value: string, properties: ReadonlyMap<string, string>): string {
    let text = value;

    for (let pass = 0; pass < MAX_REFERENCE_HOPS && text.includes('var('); pass += 1) {
        const next = substituteOnce(text, properties);

        if (next === text) {
            break;
        }
        text = next;
    }

    return text;
}

/**
 * The alias→token-key table `@openchamber/sdk`'s `applyHostTheme` iterates.
 *
 * The SDK does not export `TOKEN_VARS`, so the mapping has to be parsed from the shipped file.
 * Parsing the dependency is what keeps this model honest: a re-pin that renames an alias changes
 * the parse, and the suite's assertion fails rather than measuring a fixture the SDK no longer
 * produces.
 *
 * @returns {Map<string, string>} Alias name → the token key whose value it carries, in the
 *   SDK's own order.
 */
export function sdkAliasTable(): Map<string, string> {
    const table = /const TOKEN_VARS = \[(.*?)\];/su.exec(readSdkSource())?.[1] ?? '';
    const pairs = [...table.matchAll(/\['(--[a-z-]+)',\s*'([a-zA-Z]+)'\]/gu)];

    return new Map(pairs.map((entry) => [entry[1] ?? '', entry[2] ?? '']));
}

/**
 * One host mode as the SDK writes it onto the guest root.
 *
 * Every alias gets a value — which is the point of the reset fixture's existence: the SDK
 * writes all of them regardless of the payload, so a fixture that "omitted" a token would still
 * have the property set, and the panel's own fallback would never run.
 *
 * @param mode {string} `light` or `dark`.
 * @returns {Fixture} The declarations `applyHostTheme` would leave on `<html>`.
 */
/** The supported host modes, as the fixture document names them. */
export const LIGHT = 'light';
export const DARK = 'dark';

/** The alias-unavailable condition, which is not a payload at all. */
export const FALLBACK = 'fallback';

/**
 * The complete host token payload for one mode, copied so a caller cannot edit the document.
 *
 * @param mode {string} `light` or `dark`.
 * @returns {Record<string, string>} The fixture's tokens.
 */
export function hostTokens(mode: string): Record<string, string> {
    return { ...(mode === DARK ? hostFixtures.dark : hostFixtures.light) };
}

export function hostFixture(mode: string): Fixture {
    const tokens = hostTokens(mode);
    const declarations = new Map<string, string>([
        ['color-scheme', mode],
        ['font-family', tokens.font ?? ''],
        ['font-size', '0.875rem'],
        ['line-height', '1.45'],
        ['color', tokens.foreground ?? ''],
    ]);

    for (const [alias, key] of sdkAliasTable()) {
        declarations.set(alias, tokens[key] ?? '');
    }

    return {
        name: mode,
        root: declarations,
        canvas: mode === 'dark' ? '#000000' : '#ffffff',
        currentText: tokens.foreground ?? '',
    };
}

/**
 * The alias-unavailable frame: the SDK's `ready` has been handled and its writes removed again.
 *
 * Only `color-scheme` survives, because the SDK writes that too and the fallback legitimately
 * keeps it — it is what makes the canvas the host's mode rather than the browser default. Every
 * inherited declaration is gone, which is what forces `--mt-ink`'s last resort (`inherit`) and
 * `--mt-font`'s (`inherit`) to resolve as they would in a frame the host never readied.
 *
 * @returns {Fixture} The declarations the guest root holds after the reset.
 */
export function fallbackFixture(): Fixture {
    return {
        name: 'fallback',
        root: new Map([['color-scheme', LIGHT]]),
        canvas: '#ffffff',
        currentText: '#000000',
    };
}

/** The three fixtures NFR-107 names, in the order the suite measures them. */
export function panelFixtures(): readonly Fixture[] {
    return [hostFixture('light'), hostFixture('dark'), fallbackFixture()];
}

/**
 * Every custom property the panel's own stylesheet declares, resolved through `var()` chains.
 *
 * Two sources are merged, in the order a browser resolves them: the fixture's root declarations
 * first, then the panel's `--mt-*` block, which reads them.
 *
 * @param fixture {Fixture} The host state in force.
 * @returns {Map<string, string>} Property name → computed value, for every property either
 *   source declared.
 */
export function panelProperties(fixture: Fixture): Map<string, string> {
    const declared = new Map(fixture.root);
    const unconditional = PANEL_RULES.filter((rule) => rule.media === null);

    for (const rule of unconditional) {
        for (const declaration of rule.declarations) {
            if (declaration.property.startsWith('--')) {
                declared.set(declaration.property, declaration.value.trim());
            }
        }
    }

    const resolved = new Map<string, string>();

    for (const [name, value] of declared) {
        resolved.set(name, substituteReferences(value, resolved));
    }

    return resolved;
}

/** Whether one rule applies in the media in force, and whether it names the selector. */
function appliesTo(rule: StyleRule, selector: string, media: ReadonlySet<string>): boolean {
    if (rule.media !== null && !media.has(rule.media)) {
        return false;
    }

    return rule.selectors.some((candidate) => normalise(candidate) === selector);
}

/**
 * The value one selector declares for one property, as the cascade would resolve it.
 *
 * The **last** declaration wins, which is what a browser does for a single selector appearing
 * twice; the panel's rules are ordered so that is also the specificity answer for every role
 * measured here. A case may pass `overrides`, which replace a declaration for that one selector
 * — the seam the red-first cases use to lower a contrast without editing the stylesheet.
 *
 * @param selector {string} The selector, matched exactly after whitespace normalisation.
 * @param property {string} The property to read.
 * @param media {ReadonlySet<string>} Preludes in force; a rule inside any other query is skipped.
 * @param overrides {Readonly<Record<string, string>>} Declarations that replace what the
 *   stylesheet says.
 * @returns {string} The declared value, unresolved, or `''` when nothing declares it.
 */
export function declaredValue(input: {
    readonly selector: string;
    readonly property: string;
    readonly media?: ReadonlySet<string>;
    readonly overrides?: Readonly<Record<string, string>>;
}): string {
    const override = input.overrides?.[input.property];

    if (override !== undefined) {
        return override;
    }

    const selector = normalise(input.selector);
    const media = input.media ?? new Set<string>();
    let winner = '';

    for (const rule of PANEL_RULES) {
        if (!appliesTo(rule, selector, media)) {
            continue;
        }
        for (const declaration of rule.declarations) {
            if (declaration.property === input.property) {
                winner = declaration.value.trim();
            }
        }
    }

    return winner;
}

/** Read a `#rgb` or `#rrggbb` colour, or `null` when the text is not one. */
function parseHex(text: string): Colour | null {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(text);

    if (hex === null) {
        return null;
    }

    const digits = hex[1] ?? '';
    const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;
    const channel = (at: number): number => Number.parseInt(full.slice(at, at + CHANNEL_WIDTH), HEX_RADIX);

    return { red: channel(0), green: channel(2), blue: channel(4), alpha: 1 };
}

/** One channel of an `rgb()` argument, in bytes, from a number or a percentage. */
function channelValue(part: string): number {
    if (!part.endsWith('%')) {
        return Number(part);
    }

    return (Number(part.slice(0, -1)) * MAX_CHANNEL) / PERCENT_BASE;
}

/** Three parsed channels as a colour, rounded the way a browser rounds a computed value. */
function fromChannels(channels: readonly number[]): Colour {
    return {
        red: Math.round(channels[0] ?? 0),
        green: Math.round(channels[1] ?? 0),
        blue: Math.round(channels[2] ?? 0),
        alpha: 1,
    };
}

/** The alpha of an `rgb()`/`rgba()` colour, which defaults to fully opaque. */
function alphaValue(part: string | undefined): number {
    if (part === undefined) {
        return 1;
    }

    const alpha = Number(part);

    return Number.isFinite(alpha) ? alpha : 1;
}

/** Read an `rgb()`/`rgba()` colour, or `null` when the text is not one. */
function parseFunctional(text: string): Colour | null {
    const functional = /^rgba?\(([^)]*)\)$/u.exec(text);

    if (functional === null) {
        return null;
    }

    const parts = (functional[1] ?? '').split(/[,/]/u).map((part) => part.trim());

    if (parts.length < 3) {
        return null;
    }

    const channels = parts.slice(0, 3).map((part) => channelValue(part));

    if (channels.some((value) => !Number.isFinite(value))) {
        return null;
    }

    return { ...fromChannels(channels), alpha: alphaValue(parts[3]) };
}

/**
 * Read a colour as written, or `null` for a form this reader will not guess at.
 *
 * `null` is the answer that matters: a colour nobody measured is a finding, so every caller
 * turns it into a named failure rather than a skipped case.
 */
export function parseColour(value: string): Colour | null {
    const text = value.trim().toLowerCase();

    return KEYWORDS.get(text) ?? parseHex(text) ?? parseFunctional(text);
}

/** Split a declaration value into tokens, keeping `func(...)` groups whole. */
function splitTokens(value: string): string[] {
    const tokens: string[] = [];
    let depth = 0;
    let buffer = '';

    for (const char of value) {
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth = Math.max(depth - 1, 0);
        }
        if (depth === 0 && /\s/u.test(char)) {
            if (buffer !== '') {
                tokens.push(buffer);
                buffer = '';
            }

            continue;
        }
        buffer += char;
    }

    if (buffer !== '') {
        tokens.push(buffer);
    }

    return tokens;
}

/** Resolve a relative colour keyword to the frame's own text colour, or `null`. */
function resolveRelative(currentText: string | undefined): Colour | null {
    return currentText === undefined ? null : parseColour(currentText);
}

/** Read a `color-mix()` against `transparent`, which is a pure alpha reduction. */
function parseMix(text: string): Colour | null {
    const mixed = /color-mix\(in srgb,\s*([^,]+),\s*transparent\s*\)/u.exec(text);

    if (mixed === null) {
        return null;
    }

    // The share is part of the argument (`#d6dae1 60%`), so it is split off before the colour
    // is read — passing the whole argument to `parseColour` would return null for every real
    // declaration and silently measure nothing.
    const argument = (mixed[1] ?? '').trim();
    const share = Number((/([\d.]+)%\s*$/u.exec(argument) ?? [])[1]);
    const base = parseColour(argument.replace(/\s*[\d.]+%$/u, '').trim());

    if (base === null || !Number.isFinite(share)) {
        return null;
    }

    return { ...base, alpha: base.alpha * (share / PERCENT_BASE) };
}

/**
 * Read the colour a declaration paints, out of whatever shape it declares it in.
 *
 * A boundary is written as a shorthand — `1px solid color-mix(in srgb, var(--mt-line) 60%,
 * transparent)`, `2px solid var(--mt-accent)` — so the reader has to find the colour inside the
 * shorthand rather than demand the value *be* one.
 *
 * @param value {string} The declared value, with `var()` references still in it.
 * @param properties {ReadonlyMap<string, string>} The resolved custom properties.
 * @param currentText {string | undefined} What `inherit` and `currentColor` resolve to here.
 * @returns {Colour | null} The colour, or `null` when none could be read out of the value.
 */
export function readColour(
    value: string,
    properties: ReadonlyMap<string, string>,
    currentText?: string,
): Colour | null {
    const substituted = substituteReferences(value, properties);
    const relative = substituted.trim().toLowerCase();

    // `inherit` and `currentColor` are not colours; they are the element's own text colour, and
    // the panel's fallbacks use both. Resolving them is what lets the alias-unavailable frame be
    // measured at all — without it, every text role in that fixture would read as "not a colour".
    if (relative === 'inherit' || relative === 'currentcolor') {
        return resolveRelative(currentText);
    }

    const direct = parseColour(substituted) ?? parseMix(substituted);

    if (direct !== null) {
        return direct;
    }

    for (const token of splitTokens(substituted)) {
        const lowered = token.toLowerCase();

        // A shorthand can carry the relative keyword rather than being only it — `2px solid
        // currentColor` is how the focus outline is written once the alias is gone.
        if (lowered === 'inherit' || lowered === 'currentcolor') {
            return resolveRelative(currentText);
        }

        const colour = parseColour(token) ?? parseMix(token);

        if (colour !== null) {
            return colour;
        }
    }

    return null;
}

/** One channel's linear-light value, per WCAG 2.2. */
function linearise(channel: number): number {
    const proportion = channel / MAX_CHANNEL;

    return proportion <= LINEAR_THRESHOLD
        ? proportion / LINEAR_DIVISOR
        : ((proportion + LINEAR_OFFSET) / LINEAR_SCALE) ** LINEAR_EXPONENT;
}

/** A translucent colour laid over an opaque one, in sRGB — what the browser paints. */
export function composite(colour: Colour, backdrop: Colour): Colour {
    if (colour.alpha >= 1) {
        return colour;
    }

    const blend = (own: number, behind: number): number => Math.round(own * colour.alpha + behind * (1 - colour.alpha));

    return {
        red: blend(colour.red, backdrop.red),
        green: blend(colour.green, backdrop.green),
        blue: blend(colour.blue, backdrop.blue),
        alpha: 1,
    };
}

/** A colour's relative luminance, composited over an opaque backdrop first. */
export function luminance(colour: Colour, backdrop: Colour): number {
    const flat = composite(colour, backdrop);
    const channels = [flat.red, flat.green, flat.blue];

    return channels.reduce((total, channel, index) => total + linearise(channel) * (LUMINANCE_WEIGHTS[index] ?? 0), 0);
}

/** WCAG 2.2's contrast ratio between a foreground and the colour behind it. */
export function contrastRatio(foreground: Colour, background: Colour): number {
    const lighter = Math.max(luminance(foreground, background), luminance(background, background));
    const darker = Math.min(luminance(foreground, background), luminance(background, background));

    return (lighter + RATIO_OFFSET) / (darker + RATIO_OFFSET);
}

/**
 * The floor a run of text must clear, by WCAG 2.2's own size definition.
 *
 * 24 CSS px (18pt) counts as large at any weight, and 18.66 CSS px (14pt) does so when the text
 * is bold — the requirement's own wording rather than a rounded pixel heuristic, so a future
 * type change cannot quietly reclassify a heading and lower its bar.
 */
export function requiredRatio(fontSizePx: number, fontWeight: number): number {
    const isLarge = fontSizePx >= LARGE_PX || (fontWeight >= BOLD_WEIGHT && fontSizePx >= LARGE_BOLD_PX);

    return isLarge ? LARGE_FLOOR : NORMAL_FLOOR;
}

/** Font sizes in CSS pixels, resolved from the `rem`/`px` values the panel declares. */
export function toPixels(value: string, rootPx: number = ROOT_FONT_PX): number {
    const text = value.trim().toLowerCase();
    const parsed = Number.parseFloat(text);

    if (!Number.isFinite(parsed)) {
        return NaN;
    }

    return text.endsWith('rem') || text.endsWith('em') ? parsed * rootPx : parsed;
}

/**
 * Measure one case in one fixture.
 *
 * @param fixture {Fixture} The host state in force.
 * @param subject {Case} The case to measure.
 * @param canvas {Colour} The colour a translucent surface composites onto.
 * @returns {Measurement} The ratio and both colours, or a sentence naming what could not be
 *   read.
 */
export function measureCase(fixture: Fixture, subject: Case, canvas: Colour): Measurement {
    const properties = panelProperties(fixture);
    const foregroundRaw = declaredValue({
        selector: subject.selector,
        property: subject.property,
        ...(subject.overrides !== undefined && { overrides: subject.overrides }),
    });
    const foreground = readColour(foregroundRaw, properties, fixture.currentText);

    if (foreground === null) {
        return (
            `\`${subject.selector}\`'s ${subject.property} is \`${foregroundRaw}\`, ` +
            'which this reader cannot read as a colour'
        );
    }

    const backgroundRaw =
        subject.surface === null
            ? fixture.canvas
            : declaredValue({ selector: subject.surface, property: subject.surfaceProperty });
    const background = readColour(backgroundRaw, properties, fixture.currentText);

    if (background === null) {
        return (
            `the surface behind \`${subject.selector}\` is \`${backgroundRaw}\`, ` +
            'which this reader cannot read as a colour'
        );
    }

    // A translucent surface is composited over the canvas before it is measured against. The
    // alias-unavailable frame is where this bites: every block surface is `transparent` there,
    // and reading it as its own channels would put black text on black and report 1:1 for the
    // whole frame — a failure of the reader, reported as a failure of the panel.
    const flat = composite(background, canvas);

    return { ratio: contrastRatio(foreground, flat), foreground, background: flat };
}
