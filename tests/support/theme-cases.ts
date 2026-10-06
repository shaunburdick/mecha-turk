/**
 * The panel roles 005 NFR-107 names, and what the floor applies to each of them.
 *
 * The list lives apart from the suite that measures it so the *shape* of the evidence is one
 * file: a reader can see every role, the surface it is read against, and — in `kind` — whether
 * a threshold applies, without reading the loops.
 *
 * ## `kind`
 *
 * `text` and `focus` carry thresholds — 4.5:1 (or 3:1 for large text) and 3:1 respectively.
 * `decoration` carries none, and the reason is recorded here rather than assumed: NFR-107 bounds
 * *meaningful* control boundaries and visible focus indicators, and a block's own hairline is
 * not what tells a reader one group from the next — the gap between blocks is, and where the
 * surfaces differ, the surface tint is. Listing them as decoration keeps the exclusion visible:
 * a reviewer who disagrees moves one case rather than re-deriving the argument.
 */
import type { Case } from './theme-contrast.ts';

/** Every role measured, in the order the suite reports them. */
export const CASES: readonly Case[] = [
    {
        what: 'a block value',
        selector: '.mt-val',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a block key',
        selector: '.mt-key',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a block lede',
        selector: '.mt-lede',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a block heading',
        selector: '.mt-heading',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a card title',
        selector: '.mt-card-title',
        property: 'color',
        surface: '.mt-card',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a card body',
        selector: '.mt-card-body',
        property: 'color',
        surface: '.mt-card',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a disclosure summary',
        selector: '.mt-details > summary',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'muted text',
        selector: '.mt-muted',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'a dense-list header',
        selector: '.mt-head',
        property: 'color',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'the panel root text',
        selector: '#root',
        property: 'color',
        surface: null,
        surfaceProperty: 'background',
        kind: 'text',
    },
    {
        what: 'the focused disclosure indicator',
        selector: '.mt-details > summary:focus-visible',
        property: 'outline',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'focus',
    },
    {
        what: "a block's own border",
        selector: '.mt-block',
        property: 'border',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'decoration',
    },
    {
        what: "a card's own border",
        selector: '.mt-card',
        property: 'border',
        surface: '.mt-card',
        surfaceProperty: 'background',
        kind: 'decoration',
    },
    {
        what: 'a dense-list header rule',
        selector: '.mt-head',
        property: 'border-bottom',
        surface: '.mt-block',
        surfaceProperty: 'background',
        kind: 'decoration',
    },
];

/** The `--mt-*` roles the alias-unavailable frame is judged on resolving itself. */
export const FALLBACK_ROLES = [
    '--mt-surface',
    '--mt-sunken',
    '--mt-ink',
    '--mt-dim',
    '--mt-line',
    '--mt-accent',
    '--mt-font',
    '--mt-mono',
    '--mt-hover',
    '--mt-radius',
] as const;

/** Every case, for the shape assertions that no selector is measuring an unpainted role. */
export function measuredCases(): readonly Case[] {
    return CASES;
}

/** The text roles, which carry the normal-text floor. */
export function textCases(): readonly Case[] {
    return CASES.filter((entry) => entry.kind === 'text');
}

/** The focus indicators, which carry the non-text floor. */
export function focusCases(): readonly Case[] {
    return CASES.filter((entry) => entry.kind === 'focus');
}
