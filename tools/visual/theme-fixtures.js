/**
 * The host-theme fixtures the offline harness paints the panel from. The data lives in a JSON
 * document beside this file because the two consumers are in different languages: the browser
 * harness (plain ESM) and `tests/` (TypeScript, whose `include` covers `src/`, `panel/`, `service/`
 * and `tests/` but not `tools/`, so a `.js` import would resolve to `any` inside the suite that
 * proves the panel's colours are right). Three members: light and dark are **complete** token
 * payloads; the third is a *condition* — the post-`ready` state where every alias the SDK wrote is
 * removed, which no payload can express, because `applyHostTheme` writes its whole alias table on
 * every `ready` whether or not the payload carries the token behind it.
 */
import fixtures from './theme-fixtures.json' with { type: 'json' };

/** The two supported host modes, in the order the harness offers them. */
export const LIGHT = 'light';
export const DARK = 'dark';

/**
 * The third fixture, and the one that is not a host mode at all: a *condition* rather than a
 * payload — the SDK has run, and then the aliases it wrote are gone. Named beside the two modes
 * so a caller listing the fixtures has one list.
 */
export const FALLBACK = 'fallback';

/** Every fixture name the harness understands. */
export const FIXTURES = [LIGHT, DARK, FALLBACK];

/**
 * Every CSS custom property `@openchamber/sdk` 1.24.2's `applyHostTheme` writes onto the guest
 * document root on each `ready`, in the SDK's own `TOKEN_VARS` order so a diff against the pinned
 * source is a line-for-line comparison rather than a set membership test.
 */
export const HOST_THEME_ALIASES = fixtures.aliases;

/**
 * The four inherited declarations `applyHostTheme` writes beside the aliases, part of the reset
 * for the same reason: `panel/index.html` reads `color` for `--mt-ink`'s last resort, `font-family`
 * for `--mt-font`, and the panel's own size and line-height from the same block — leaving them
 * behind would leave the "aliases unavailable" frame with the host's text colour and family, the
 * one thing the fallback fixture exists to rule out. `color-scheme` is deliberately **not** in
 * this list: the SDK writes it first, the fallback frame keeps it, and the suite asserts it.
 */
export const HOST_INHERITED_PROPERTIES = ['color', 'font-family', 'font-size', 'line-height'];

/**
 * The panel aliases, and the host alias each one reads first — read by the accessibility suite to
 * name which panel role drifted, and by the harness's report so a failure says which role lost it.
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

/** The complete host token payload for one mode, as a copy so a caller cannot edit the fixture. */
export function hostTokens(mode) {
    return { ...(mode === DARK ? fixtures.dark : fixtures.light) };
}

/** Every colour value that fixture's aliases hold — what the offline suite must not mistake for a fallback. */
export function hostTokenValues(mode) {
    return new Set(Object.values(hostTokens(mode)).filter((value) => value.startsWith('#')));
}
