/**
 * The host-theme fixtures the offline harness paints the panel from.
 *
 * ## Why the data lives in a JSON document beside this file
 *
 * Two consumers need the same three fixtures, and they are in different languages: the harness
 * runs in the browser as plain ESM, and the accessibility suite in `tests/` is TypeScript under
 * `tsconfig.json`, whose `include` covers `src/`, `panel/`, `service/`, and `tests/` — not
 * `tools/`. A TypeScript import of a plain `.js` file outside that scope resolves to `any`, so
 * writing the data as a module would have put untyped values inside the one suite whose job is
 * to prove the panel's colours are right. A JSON document is read by both: this module imports
 * it as a JSON module — which Node and a browser each load with no `fetch` and no `node:fs` —
 * and TypeScript reads it as a typed literal. One source of truth, no `any`, and no second copy
 * to drift.
 *
 * ## Why the fixture set has three members
 *
 * Two are host modes — light and dark, each a **complete** token payload, because a payload with
 * a member missing is neither a supported host theme nor the alias-unavailable case. The third
 * is not a payload at all: it is a *condition*, the post-`ready` state in which every alias the
 * SDK wrote has been removed again so the panel's own fallbacks resolve. It cannot be expressed
 * as a payload at all, because `applyHostTheme` writes its whole alias table on every `ready`
 * whether or not the payload carries the token behind it — so `aliases` below is the table it
 * writes, and `stripHostTheme` removes exactly those names.
 */
import fixtures from './theme-fixtures.json' with { type: 'json' };

/** The two supported host modes, in the order the harness offers them. */
export const LIGHT = 'light';
export const DARK = 'dark';

/**
 * The third fixture, and the one that is not a host mode at all.
 *
 * It is a *condition* rather than a payload: the SDK has run, and then the aliases it wrote are
 * gone. Named here beside the two modes so a caller listing the fixtures has one list.
 */
export const FALLBACK = 'fallback';

/** Every fixture name the harness understands. */
export const FIXTURES = [LIGHT, DARK, FALLBACK];

/**
 * Every CSS custom property `@openchamber/sdk` 1.24.2's `applyHostTheme` writes onto the
 * guest document root on each `ready`.
 *
 * In the SDK's own `TOKEN_VARS` order, which is the order it writes them in, so a diff against
 * the pinned source is a line-for-line comparison rather than a set membership test.
 */
export const HOST_THEME_ALIASES = fixtures.aliases;

/**
 * The four inherited declarations `applyHostTheme` writes beside the aliases.
 *
 * They are part of the reset for the same reason the aliases are: `panel/index.html` reads
 * `color` for `--mt-ink`'s last resort (`inherit`), `font-family` for `--mt-font`, and the
 * panel's own `font-size`/`line-height` come from the same block. Leaving them behind would
 * mean the "aliases unavailable" frame still had the host's text colour and family, which is
 * the one thing the fallback fixture exists to rule out.
 *
 * `color-scheme` is deliberately **not** in this list: the SDK writes it first, the fallback
 * frame keeps it (so the canvas is the mode's own), and the suite asserts it survived.
 */
export const HOST_INHERITED_PROPERTIES = ['color', 'font-family', 'font-size', 'line-height'];

/**
 * The panel aliases, and the host alias each one reads first.
 *
 * Read by the accessibility suite to name which panel role drifted, and by the harness's own
 * report so a failure says which role lost its host token.
 */
export const PANEL_ALIASES = {
    '--mt-surface': ['--oc-elevated', '--surface-elevated'],
    '--mt-sunken': ['--oc-subtle', '--surface-subtle'],
    '--mt-ink': ['--oc-fg', '--surface-foreground'],
    '--mt-dim': ['--oc-muted', '--surface-muted-foreground'],
    '--mt-line': ['--oc-border', '--interactive-border'],
    '--mt-accent': ['--oc-primary', '--primary'],
    '--mt-font': ['--oc-font', '--font-sans'],
    '--mt-mono': ['--oc-mono', '--font-mono'],
    '--mt-hover': ['--oc-hover', '--interactive-hover'],
    '--mt-radius': ['--radius'],
};

/**
 * The complete host token payload for one mode.
 *
 * @param mode {string} `light` or `dark`.
 * @returns {Record<string, string>} A copy, so a caller cannot edit the fixture document.
 */
export function hostTokens(mode) {
    return { ...(mode === DARK ? fixtures.dark : fixtures.light) };
}

/**
 * Every colour value that fixture's aliases hold.
 *
 * @param mode {string} `light` or `dark`.
 * @returns {Set<string>} The values the offline suite must not mistake for a fallback.
 */
export function hostTokenValues(mode) {
    return new Set(Object.values(hostTokens(mode)).filter((value) => value.startsWith('#')));
}
