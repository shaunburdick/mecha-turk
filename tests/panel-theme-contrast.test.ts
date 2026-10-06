/**
 * The panel's contrast and focus floor, measured in all three host fixtures.
 *
 * 005 NFR-107 and 005 AC-159 require measured contrast in three states — the supported host
 * light theme, the supported host dark theme, and the frame where the host's semantic aliases
 * are unavailable and the panel's own fallbacks have to carry it — and require a deliberately
 * failing pair to fail **naming the element and the ratio**. This is that measurement, offline
 * and deterministic: the shipped `panel/index.html` stylesheet resolved against each fixture,
 * with WCAG 2.2's ratio computed here rather than transcribed.
 *
 * - **Fixtures.** `light` and `dark` are the harness's complete host token payloads, written
 *   onto the guest root exactly as the pinned SDK's `applyHostTheme` writes them. `fallback` is
 *   the same root after every alias and inherited declaration has been removed again — see
 *   `tools/visual/theme-fixtures.js` for why removing them is the only way to reach the
 *   fallback branch rather than a thinner payload.
 * - **What is measured.** Each case names a selector and the property to read from it, so the
 *   figure follows the shipped stylesheet: rename a token or repaint a block and the ratio
 *   here moves. Each case also names the surface it is read against, because a panel's text
 *   colour alone is meaningless without the block behind it.
 * - **Limits, stated rather than implied.** This resolves declarations by exact selector; it
 *   does not match elements, weigh specificity between two rules for one element, or read a
 *   pseudo-state. It is the resting state, which is where a text-contrast floor lives. The
 *   rendered half — computed styles in a real browser, including the focused indicator — is the
 *   harness's `__MT__.hostThemeReport()` plus M-003's review.
 * - **No live host, no token, no network** (FR-086): the host themes are this repository's own
 *   fixture data, and the SDK's alias table is parsed from the pinned package already installed.
 */
import { describe, expect, it } from 'vitest';
import hostFixtures from '../tools/visual/theme-fixtures.json';
import { CASES, FALLBACK_ROLES, focusCases, measuredCases, textCases } from './support/theme-cases.ts';
import {
    composite,
    contrastRatio,
    declaredValue,
    fallbackFixture,
    hostFixture,
    hostTokens,
    measureCase,
    panelFixtures,
    panelProperties,
    parseColour,
    requiredRatio,
    sdkAliasTable,
    toPixels,
    DARK,
    FALLBACK,
    LIGHT,
    HOST_INHERITED_PROPERTIES,
    BOLD_WEIGHT,
    LARGE_BOLD_PX,
    LARGE_FLOOR,
    LARGE_PX,
    NON_TEXT_FLOOR,
    NORMAL_FLOOR,
} from './support/theme-contrast.ts';
import type { Case, Colour, Measurement } from './support/theme-contrast.ts';

/** How many members a complete host token payload carries. */
const HOST_TOKEN_COUNT = 27;

/** The share `.mt-block`'s `color-mix()` border declares, used to prove the composite runs. */
const BORDER_SHARE = 0.6;

/** The opaque white a light frame's canvas is; each fixture carries its own canvas colour. */
const CANVAS: Colour = { red: 255, green: 255, blue: 255, alpha: 1 };

/** The colours a fallback is judged against, one per canvas the frame can keep. */
const FALLBACK_CANVASES: readonly (readonly [string, Colour])[] = [
    ['light', CANVAS],
    ['dark', { red: 0, green: 0, blue: 0, alpha: 1 }],
];

/**
 * The size a role is read at: its own if it declares one, the root's otherwise.
 *
 * A role that sets no size of its own inherits the pane's, and reporting `NaN` for it would
 * make the floor comparison itself meaningless rather than merely strict.
 */
function sizeOf(subject: Case): number {
    const own = declaredValue({ selector: subject.selector, property: 'font-size' });
    const inherited = declaredValue({ selector: '#root', property: 'font-size' });

    return toPixels(own === '' ? inherited : own);
}

/** The weight a role is read at, `400` when it declares none — which is what CSS does. */
function weightOf(subject: Case): number {
    const declared = declaredValue({ selector: subject.selector, property: 'font-weight' }).replaceAll(/[^\d.]/gu, '');

    return declared === '' ? 400 : Number(declared);
}

/**
 * A hex colour, or a loud failure rather than a `null` that would read as "not a colour".
 *
 * The literals are written here in this test, so the reader failing on one is a defect in the
 * reader rather than a case the suite has to reason about.
 */
function hex(value: string): Colour {
    const parsed = parseColour(value);

    expect(parsed, `the reader cannot parse its own literal ${value}`).not.toBeNull();

    return parsed ?? CANVAS;
}

/** `rgb(r, g, b)` for a colour, so a failure message shows the figure the reader sees. */
function rgb(colour: Colour): string {
    return `rgb(${colour.red}, ${colour.green}, ${colour.blue})`;
}

/** The line a failing pair reports: the element, both colours, the ratio, and the floor. */
function report(subject: Case, measured: Measurement, floor: number): string {
    if (typeof measured === 'string') {
        return measured;
    }

    return (
        `${subject.what} (\`${subject.selector}\`) is ${rgb(measured.foreground)} ` +
        `on ${rgb(measured.background)} at ${measured.ratio.toFixed(2)}:1, ` +
        `below the ${floor}:1 NFR-107 requires`
    );
}

describe('the host-theme fixtures are the ones the pinned SDK actually writes', () => {
    it('resolves every alias `applyHostTheme` writes, and no others', () => {
        // The alias table is transcribed (the SDK does not export it), so the transcription is
        // checked against the SDK's own source rather than trusted: a re-pin that renames or
        // adds an alias fails here instead of leaving the fallback fixture removing the wrong
        // names and reporting a clean frame.
        expect([...sdkAliasTable().keys()]).toEqual(hostFixtures.aliases);
    });

    it('writes every alias on each `ready`, whatever the payload carries', () => {
        // The premise of the fallback fixture, asserted rather than assumed. If the SDK ever
        // stopped writing an omitted alias as an empty declaration, a fixture with a thinner
        // payload would reach the fallback branch and the reset would be unnecessary.
        for (const mode of [LIGHT, DARK]) {
            const fixture = hostFixture(mode);
            const absent = hostFixtures.aliases.filter((alias) => !fixture.root.has(alias));
            const empty = hostFixtures.aliases.filter((alias) => fixture.root.get(alias) === '');

            expect(absent, mode).toEqual([]);
            expect(empty, mode).toEqual([]);
        }
        expect(HOST_INHERITED_PROPERTIES).toEqual(['color', 'font-family', 'font-size', 'line-height']);
    });

    it('offers the two supported host modes and the alias-unavailable frame', () => {
        expect([LIGHT, DARK, FALLBACK]).toEqual(['light', 'dark', 'fallback']);

        for (const mode of [LIGHT, DARK]) {
            const tokens = hostTokens(mode);

            // "Complete" is the requirement: a payload with a member missing is neither a
            // supported host theme nor the alias-unavailable case.
            expect(Object.keys(tokens).length, mode).toBe(HOST_TOKEN_COUNT);
            expect(tokens.background, mode).toMatch(/^#[\da-f]{6}$/u);
            expect(tokens.foreground, mode).toMatch(/^#[\da-f]{6}$/u);
            expect(tokens.font, mode).toContain('system-ui');
        }
        expect(hostTokens(DARK).background).not.toBe(hostTokens(LIGHT).background);
        expect([...fallbackFixture().root.keys()]).toEqual(['color-scheme']);
    });
});

describe('panel text clears the contrast floor in every host fixture', () => {
    for (const fixture of panelFixtures()) {
        it(`measures every text role in the ${fixture.name} fixture`, () => {
            const failures: string[] = [];
            const subjects = textCases();

            for (const subject of subjects) {
                const measured = measureCase(fixture, subject, CANVAS);

                if (typeof measured === 'string') {
                    failures.push(measured);

                    continue;
                }
                const floor = requiredRatio(sizeOf(subject), weightOf(subject));

                if (measured.ratio < floor) {
                    failures.push(report(subject, measured, floor));
                }
            }

            expect(failures).toEqual([]);
        });
    }
});

describe('the visible focus indicator clears the non-text floor', () => {
    for (const fixture of panelFixtures()) {
        it(`measures the focus outline in the ${fixture.name} fixture`, () => {
            const failures: string[] = [];
            const subjects = focusCases();

            for (const subject of subjects) {
                const measured = measureCase(fixture, subject, CANVAS);

                if (typeof measured === 'string') {
                    failures.push(measured);

                    continue;
                }
                if (measured.ratio < NON_TEXT_FLOOR) {
                    failures.push(report(subject, measured, NON_TEXT_FLOOR));
                }
            }

            expect(failures).toEqual([]);
        });
    }

    it('is not vacuous, and says which boundaries carry no floor', () => {
        expect(focusCases().length).toBeGreaterThan(0);
        // Every decoration case is listed by name, so the exclusion is a recorded decision a
        // reviewer can overturn by moving one entry rather than a silent gap in the list.
        expect(measuredCases().map((entry) => entry.kind)).toContain('decoration');
        expect(CASES.filter((entry) => entry.kind === 'decoration').map((entry) => entry.what)).toEqual([
            "a block's own border",
            "a card's own border",
            'a dense-list header rule',
        ]);
    });
});

describe('every measured selector is one the shipped stylesheet really paints', () => {
    it('declares the property each case reads', () => {
        // The exact-selector model is sound only while each role lives on one rule. A case that
        // started measuring an inherited colour — because the panel repainted the role on a
        // compound selector — would report a ratio for a colour no reader sees.
        const undeclared = measuredCases()
            .filter((subject) => declaredValue({ selector: subject.selector, property: subject.property }) === '')
            .filter((subject) => subject.overrides === undefined)
            .map((subject) => `${subject.what}: ${subject.selector} { ${subject.property} }`);

        expect(undeclared).toEqual([]);
    });

    it('paints each case\'s surface from a declaration of its own', () => {
        const withSurfaces = measuredCases().filter((subject) => subject.surface !== null);
        const unpainted = withSurfaces
            .filter((subject) => {
                const surface = subject.surface ?? '';

                return declaredValue({ selector: surface, property: subject.surfaceProperty }) === '';
            })
            .map((subject) => `${subject.surface} { ${subject.surfaceProperty} }`);

        expect(unpainted).toEqual([]);
    });
});

describe('the alias-unavailable frame resolves the panel\'s own fallbacks', () => {
    it('computes each `--mt-*` role from `panel/index.html`, not from a host token', () => {
        // The point of the fixture: with the aliases gone, every panel alias must fall through
        // to the last argument of its `var()` chain — the value the stylesheet itself declares.
        const fixture = fallbackFixture();
        const properties = panelProperties(fixture);
        const hostValues = new Set(
            [...hostFixture(LIGHT).root.values(), ...hostFixture(DARK).root.values()].filter((value) =>
                value.startsWith('#'),),
        );
        const fromHost = FALLBACK_ROLES.filter((role) => hostValues.has(properties.get(role) ?? ''));
        const missing = FALLBACK_ROLES.filter((role) => !properties.has(role));
        // Compared lower-cased because the stylesheet writes `currentColor` and a colour
        // keyword's case is not part of its value.
        const resolved = Object.fromEntries(
            FALLBACK_ROLES.map((role) => [role, (properties.get(role) ?? '').toLowerCase()]),
        );

        expect(missing).toEqual([]);
        expect(fromHost).toEqual([]);
        expect(resolved).toEqual({
            '--mt-surface': 'transparent',
            '--mt-sunken': 'transparent',
            '--mt-ink': 'inherit',
            '--mt-dim': '#767676',
            '--mt-line': 'currentcolor',
            '--mt-accent': 'currentcolor',
            '--mt-font': 'inherit',
            '--mt-mono': 'monospace',
            '--mt-hover': 'transparent',
            '--mt-radius': '8px',
        });
    });

    it('pins the muted fallback to a colour that clears the floor on either canvas', () => {
        // The reason `--mt-dim` changed from `gray`, kept as a measurement rather than as a
        // comment: a last-resort colour has to clear the floor against a white *and* a black
        // canvas, because the frame that uses it keeps whatever `color-scheme` the host left.
        const muted = parseColour(panelProperties(fallbackFixture()).get('--mt-dim') ?? '');

        expect(muted).not.toBeNull();

        if (muted === null) {
            return;
        }

        for (const [, canvas] of FALLBACK_CANVASES) {
            expect(contrastRatio(muted, canvas)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        }
        // …and the one it replaced is recorded as the failure it was, so the change cannot be
        // reverted without a test that says why it went the other way.
        expect(contrastRatio(hex('#808080'), CANVAS)).toBeLessThan(NORMAL_FLOOR);
    });

    it('measures the frame against the canvas, because every surface there is transparent', () => {
        const fixture = fallbackFixture();
        const subject = measuredCases()[0];

        expect(subject).toBeDefined();

        if (subject === undefined) {
            return;
        }

        const measured = measureCase(fixture, subject, CANVAS);

        expect(typeof measured).toBe('object');

        if (typeof measured === 'string') {
            return;
        }

        expect(measured.ratio).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        // The surface really is the canvas: `transparent` composited onto white, not the token's
        // own channels, which would put black text on black and report 1:1 for the whole frame.
        expect(measured.background).toEqual(CANVAS);
    });
});

describe('the thresholds bite: each negative case fails and names its element', () => {
    it('fails a normal-text pair below 4.5:1, naming the element and the ratio', () => {
        const subject = measuredCases()[0];

        expect(subject).toBeDefined();

        if (subject === undefined) {
            return;
        }

        const failing = measureCase(hostFixture(LIGHT), { ...subject, overrides: { color: '#8d8d8d' } }, CANVAS);

        expect(typeof failing).toBe('object');

        if (typeof failing === 'string') {
            return;
        }

        expect(failing.ratio).toBeLessThan(NORMAL_FLOOR);
        expect(report(subject, failing, NORMAL_FLOOR)).toContain('.mt-val');
        expect(report(subject, failing, NORMAL_FLOOR)).toMatch(/\d\.\d\d:1/u);
    });

    it('fails a large-text pair below 3:1, and holds the same colour to 4.5:1 as normal text', () => {
        // The classification is what makes the second floor meaningful, so it is exercised at
        // the boundary rather than assumed: 24px is large, 23.9px is not, 18.66px bold is.
        expect(requiredRatio(LARGE_PX, 400)).toBe(LARGE_FLOOR);
        expect(requiredRatio(LARGE_PX - 0.1, 400)).toBe(NORMAL_FLOOR);
        expect(requiredRatio(LARGE_BOLD_PX, BOLD_WEIGHT)).toBe(LARGE_FLOOR);
        expect(requiredRatio(LARGE_BOLD_PX, 400)).toBe(NORMAL_FLOOR);

        const between = contrastRatio(hex('#949494'), CANVAS);

        expect(between).toBeGreaterThan(LARGE_FLOOR);
        expect(between).toBeLessThan(NORMAL_FLOOR);
    });

    it('fails a focus pair below 3:1', () => {
        const subject = focusCases()[0];

        expect(subject).toBeDefined();

        if (subject === undefined) {
            return;
        }

        const lowered = { ...subject, overrides: { outline: '2px solid #3c4148' } };
        const failing = measureCase(hostFixture(DARK), lowered, CANVAS);

        expect(typeof failing).toBe('object');

        if (typeof failing === 'string') {
            return;
        }

        expect(failing.ratio).toBeLessThan(NON_TEXT_FLOOR);
        expect(report(subject, failing, NON_TEXT_FLOOR)).toContain('summary:focus-visible');
    });

    it('follows the fixture rather than a hard-coded figure', () => {
        // The proof that every number above is computed from the fixture: the same role, in the
        // same stylesheet, has to read as two different colours under the two host themes — and
        // the surface it is read against has to disappear when the aliases that paint it do.
        // A card body, because the light host's own elevated surface is white and the canvas the
        // fallback composites onto is white too — that pair would prove nothing.
        const subject = CASES.find((entry) => entry.what === 'a card body');

        expect(subject).toBeDefined();

        if (subject === undefined) {
            return;
        }

        const light = measureCase(hostFixture(LIGHT), subject, CANVAS);
        const dark = measureCase(hostFixture(DARK), subject, CANVAS);
        const reset = measureCase(fallbackFixture(), subject, CANVAS);

        expect(typeof light).toBe('object');
        expect(typeof dark).toBe('object');
        expect(typeof reset).toBe('object');

        if (!(typeof light === 'object' && typeof dark === 'object' && typeof reset === 'object')) {
            return;
        }

        expect(light.foreground).not.toEqual(dark.foreground);
        expect(light.background).not.toEqual(reset.background);
        expect(reset.background).toEqual(CANVAS);
    });

    it('composites a translucent border over its backdrop rather than reading its own channels', () => {
        // `.mt-block`'s border is a `color-mix()` of the line colour and `transparent`, so the
        // figure a reader sees is that colour at its share over the surface behind it. Reading
        // the border's own channels instead would report a colour nobody sees.
        const subject = CASES.find((entry) => entry.what === "a block's own border");
        const opaque = contrastRatio(hex('#d6dae1'), CANVAS);

        expect(subject).toBeDefined();

        if (subject === undefined) {
            return;
        }

        const measured = measureCase(hostFixture(LIGHT), subject, CANVAS);

        expect(typeof measured).toBe('object');

        if (typeof measured === 'string') {
            return;
        }

        // The wash is lighter than the token it is made from, so the two readings must differ —
        // otherwise the composite is not happening.
        expect(measured.ratio).toBeLessThan(opaque);
        expect(composite(hex('#d6dae1'), { ...CANVAS, alpha: BORDER_SHARE }).alpha).toBe(1);
    });
});
