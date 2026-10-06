/**
 * The rendered site evidence — its case list, its thresholds, and the wiring that produces it.
 *
 * 007 T-048 and T-049 are browser passes, and the checks that keep them honest are here rather than
 * inside the tools, for two reasons. The **case list** is data both a reader and a runner need and
 * neither may own alone, so it lives in `tools/visual/site-matrix.json` and is imported as a typed
 * literal — the same arrangement `tools/visual/theme-fixtures.json` uses, and for the same reason: a
 * plain `.js` outside the root TypeScript project resolves to `any`, which is not something to put
 * inside the one suite whose job is to prove a palette is right. The **wiring** is asserted against
 * the tools' source, as `tests/visual-tooling.test.ts` already does for `host.js` and `shot.js`,
 * because that is the only side of a browser tool the repository's own gate can reach.
 *
 * What is deliberately *not* here: the ratios. Those are measured in a browser, and this file makes
 * no claim about them beyond the arithmetic that decides whether a pair is judged at all — the
 * floors, and the large-text boundary that chooses between two of them.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import matrix from '../tools/visual/site-matrix.json';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Read a tool's source, which is the only side of it this gate can reach. */
function source(name: string): string {
    return readFileSync(resolve(ROOT, 'tools', 'visual', name), 'utf8');
}

/**
 * One page's committed sources: its own template, the shell it renders inside, and every `.astro`
 * component reachable from either by import.
 *
 * These assertions read the sources rather than `site/dist` because the root gate never builds the
 * site — FR-070 keeps `npm run verify` (and `.github/workflows/verify.yml`) out of the site's build,
 * and `site/dist` is git-ignored, so a test reading it fails every clean checkout instead of the
 * change it exists to catch. Presence survives the move: an element no template contains cannot
 * appear in the page those templates render.
 */
function pageSource(path: string): string {
    // The published path is absolute (`/install/`); the file name is neither, so both slashes go
    // before the name reaches `resolve`, which would otherwise read the leading one as the root.
    const stem = path.replaceAll(/^\/+|\/+$/gu, '');
    const entry = resolve(ROOT, 'site', 'src', 'pages', `${stem === '' ? 'index' : stem}.astro`);
    const seen = new Set<string>();
    const parts: string[] = [];
    const visit = (file: string): void => {
        if (seen.has(file)) {
            return;
        }
        seen.add(file);
        const text = readFileSync(file, 'utf8');

        parts.push(text);
        for (const match of text.matchAll(/from '(\.[^']+\.astro)'/gu)) {
            const specifier = match[1];

            if (specifier !== undefined) {
                visit(resolve(dirname(file), specifier));
            }
        }
    };

    visit(entry);

    return parts.join('\n');
}

/** One channel's step in WCAG 2.2's relative-luminance formula. */
const channel = (value: number): number => {
    const scaled = value / 255;

    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of a triple, as WCAG 2.2 defines it. */
const luminance = (colour: number[]): number =>
    0.2126 * channel(colour[0] ?? 0) + 0.7152 * channel(colour[1] ?? 0) + 0.0722 * channel(colour[2] ?? 0);

/** WCAG 2.2's contrast ratio, computed here so the floors are checked against the definition. */
function ratio(foreground: number[], background: number[]): number {
    const first = luminance(foreground);
    const second = luminance(background);

    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('the rendered matrix covers what AC-033 and AC-035 name', () => {
    it('enumerates five pages, three viewports and two preference cascades', () => {
        expect(matrix.pages.map((page) => page.id)).toEqual(['landing', 'install', 'configure', 'use', 'debug']);
        expect(matrix.viewports.map((view) => view.width)).toEqual([1_280, 720, 320]);
        expect(matrix.schemes).toEqual(['light', 'dark']);

        // The counts AC-033 and AC-035 state: 5 x desktop/narrow x 2 = 20, plus 320 x 5 x 2 = 30.
        const cases = matrix.pages.length * matrix.viewports.length * matrix.schemes.length;

        expect(cases).toBe(30);
        expect(matrix.pages.length * 2 * matrix.schemes.length).toBe(20);
        expect(matrix.pages.length * matrix.schemes.length).toBe(10);
    });

    it('publishes the five pages at the addresses the site is built at', () => {
        expect(matrix.pages.map((page) => page.path)).toEqual(['/', '/install/', '/configure/', '/use/', '/debug/']);
    });

    it('holds the three floors NFR-004 names, and no others', () => {
        expect(matrix.floors).toEqual({ largeText: 3, nonText: 3, normalText: 4.5 });

        // Checked against WCAG 2.2's own definition rather than against a comment: black on white is
        // 21:1, and the two steps the definition actually turns on are 4.5:1 and 3:1.
        expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
        expect(ratio([119, 119, 119], [255, 255, 255])).toBeLessThan(matrix.floors.normalText);
        // #8c8c8c is the canonical between-the-two-steps grey: 3.36:1, which clears the large-text
        // floor and fails the normal-text one. That gap is what makes the classification matter.
        expect(ratio([140, 140, 140], [255, 255, 255])).toBeGreaterThan(matrix.floors.largeText);
        expect(ratio([140, 140, 140], [255, 255, 255])).toBeLessThan(matrix.floors.normalText);
    });

    it('classifies large text at WCAG 2.2 boundary', () => {
        // 18pt is 24 CSS px; 14pt bold is 18.67 CSS px at weight 700.
        expect(matrix.largeText).toEqual({ boldPx: 18.67, boldWeight: 700, px: 24 });
        expect(matrix.largeText.px).toBeCloseTo((18 * 96) / 72, 5);
        expect(matrix.largeText.boldPx).toBeCloseTo((14 * 96) / 72, 1);
    });

    it('measures the roles AC-035 names, on every page that renders them', () => {
        const selectors = matrix.subjects.map((subject) => subject.selector);

        for (const wanted of ['main p', 'main a', 'h1', 'h2', 'caption', 'thead th', 'td', 'code']) {
            expect(selectors, wanted).toContain(wanted);
        }
        expect(selectors).toContain('nav a[aria-current=\'page\']');
        expect(selectors).toContain('tbody th[scope=\'row\']');

        // Every subject's selector has to name something the pages' own sources contain, or the
        // matrix is silently measuring nothing on the page it names.
        const pages = matrix.pages.map((page) => pageSource(page.path));
        const misses = matrix.subjects
            .map((subject) => subject.selector)
            .filter((selector) => {
                const bare = /^([a-z][a-z0-9]*)/u.exec(selector)?.[1] ?? '';

                return pages.every((page) => !page.includes(`<${bare}`));
            });

        expect(misses).toEqual([]);
    });

    it('records the roles the keyboard pass focuses, all of which the pages render', () => {
        const focusSelectors = matrix.focusSubjects.map((entry) => entry.selector);

        expect(focusSelectors).toEqual([
            'nav a',
            'main a',
            'footer a',
        ]);
        const pages = matrix.pages.map((page) => pageSource(page.path));

        for (const selector of focusSelectors) {
            expect(pages.some((page) => page.includes(`<${selector.split(' ', 1)[0]}`)), selector).toBe(true);
        }
    });
});

describe('each threshold is proved by an injection that can only fail it', () => {
    it('injects one colour per floor, and each lands where it is claimed to', () => {
        const ids = matrix.injections.map((injection) => injection.id);

        expect(ids).toEqual(['normal-text', 'large-text', 'focus']);

        const normal = matrix.injections.find((injection) => injection.id === 'normal-text');
        const large = matrix.injections.find((injection) => injection.id === 'large-text');
        const focus = matrix.injections.find((injection) => injection.id === 'focus');

        // The normal-text figure sits between the two text floors, so it can only be refused by the
        // 4.5:1 assertion; a figure below 3:1 would prove nothing about which floor did the refusing.
        expect(normal?.targetRatio).toBeGreaterThan(matrix.floors.largeText);
        expect(normal?.targetRatio).toBeLessThan(matrix.floors.normalText);
        // The large-text and focus figures sit below every floor, so either floor refuses them.
        expect(large?.targetRatio).toBeLessThan(matrix.floors.largeText);
        expect(focus?.targetRatio).toBeLessThan(matrix.floors.nonText);
        // …and each names the property it degrades, so the figure read back is the one asserted.
        expect(matrix.injections.map((injection) => injection.property)).toEqual([
            'color',
            'color',
            'outline-color',
        ]);
    });
});

describe('the rendered contrast tool measures what it claims to measure', () => {
    const tool = source('site-matrix.js');
    const model = source('site-contrast.js');

    it('reads its case list from the shared document, not from a copy', () => {
        // The document is imported once, by the model module, and the runner reads the matrix
        // through it — so a case added to the JSON cannot be measured by one and ignored by the
        // other.
        expect(model).toContain("import matrix from './site-matrix.json' with { type: 'json' };");
        expect(tool).toContain('export function casesFor(pages)');
        expect(tool).toContain('    matrix,');
    });

    it('judges every subject against the colour painted behind it, from two readings', () => {
        // The cascade reading and the pixel reading both, with the lower figure deciding — and a
        // pixel reading REQUIRED wherever an image paints the surface, because that is the case the
        // cascade cannot answer at all.
        expect(model).toContain('Math.min(computed, sample.measured)');
        expect(model).toContain('gradient === null || sample.usable');
        expect(tool).toContain('a gradient paints the surface and no pixels were sampled');
    });

    it('takes its measurement capture with the page text made transparent, and takes it away again', () => {
        // The second frame exists because a "worst pixel in the box" rule over an ordinary capture
        // reads a heading's own anti-aliased lettering as the surface the heading is painted on.
        expect(source('site-expressions.js')).toContain('color: transparent !important');
        expect(tool).toContain('bareTextExpression()');
        expect(tool).toMatch(/await browser\.evaluate\(bareTextExpression\(\)\);\s*\n\s*try \{/u);
        expect(tool).toMatch(/\} finally \{\s*\n\s*await browser\.evaluate\(restoreTextExpression\(\)\);/u);
    });

    it('proves each threshold bites, on every case, and exits non-zero when it does not', () => {
        expect(tool).toContain('for (const injection of matrix.injections)');
        expect(tool).toContain('proved: ratio < floor');
        expect(tool).toMatch(/the \$\{proof\.id\} injection was not refused/u);
    });

    it('refuses to report a figure it cannot place', () => {
        // No build, no measurement; a device pixel ratio it cannot map; a subject with too many
        // descendants to exclude; a gradient surface with no sampled pixels.
        expect(tool).toContain('there is no built site to measure');
        expect(tool).toContain('samples in CSS pixels');
        expect(tool).toContain('too many descendants to exclude');
        expect(tool).toContain('measured from the cascade alone');
    });

    it('normalises an alpha hex literal to the spelling the browser reports', () => {
        // The built pages paint `#f4f6ef66`; `getComputedStyle` answers `rgba(244, 246, 239, 0.4)`
        // for it. The `rgb()` helper renders a whole `rgb(...)` call, so interpolating it inside
        // `rgba(...)` produced `rgba(rgb(244, 246, 239), 0.4)` — a spelling no browser reports —
        // and every alpha-hex literal was then judged undeclared by the site-owned palette clause.
        expect(tool).toContain("pairs.slice(0, RGB_PARTS).join(', ')");
        expect(tool).toContain('alphaShare(digits.slice(-2))');
        expect(tool).not.toMatch(/rgba\(\$\{rgb\(/u);
    });

    it('serves the built pages at the base path they are published under', () => {
        expect(model).toContain("const BASE = '/mecha-turk';");
        expect(model).toContain('export async function serveSite()');
    });

    it('records the clauses that are not contrast ratios', () => {
        for (const observation of [
            'colour-only',
            'the page resolves',
            'a heading jumps from',
            'a card around every passage',
            'the page scrolls horizontally',
            'element(s) animate',
        ]) {
            expect(tool, observation).toContain(observation);
        }
        // The heading and landmark clauses live in the keyboard pass, which is where the focus walk
        // already has the page open; asserting them here keeps each assertion next to its tool.
        const keyboard = source('site-keyboard.js');

        for (const observation of [
            'does not have exactly one h1',
            'a heading jumps from',
            'the navigation region has no name',
        ]) {
            expect(keyboard, observation).toContain(observation);
        }
    });

    it('asks the document — not the window — how many animations run, and fails a run that could not answer', () => {
        // `getAnimations()` lives on `Document`/`Element`; asked of `window` it is `undefined` on
        // every browser, so all thirty cases answered `null` and the no-animation clause was
        // judged on a counter that never existed. Both halves are asserted: the live call, and the
        // guard that turns a dead measurement into a non-zero exit instead of a silent pass.
        expect(source('site-expressions.js')).toContain("typeof doc.getAnimations === 'function'");
        expect(source('site-expressions.js')).toContain('runningAnimations(document)');
        expect(tool).toContain('entry.decoration.animated !== 0 || (entry.decoration.running ?? 0) > 0');
        // The liveness check lives in `observe`, so a dead counter becomes a finding — which is
        // the one path that already prints an error and earns the run its non-zero exit.
        expect(tool).toContain('if (!summary.animationApi)');
    });

    it('pairs the two preference cascades on every page, so a table-bearing page is actually exercised', () => {
        // Element presence gates the signature — a page with no `<table>` records no `table`
        // entry — so a pairing fixed to the first page (the landing page, which has none) never
        // checks "table behaviour unchanged" anywhere. Every page the matrix renders is paired.
        expect(tool).not.toContain('cases[0]');
        expect(tool).toContain('const pages = [...new Set(cases.map((entry) => entry.id))];');
    });
});

describe('the keyboard pass presses keys rather than asking the DOM what it would do', () => {
    const tool = source('site-keyboard.js');

    it('reads each stop after a Tab, and never calls focus()', () => {
        expect(tool).toContain("await browser.run(['press', 'Tab']);");
        // The keystroke comes before the read: nothing is focused when a page opens, so a stop read
        // first would be the absence of a stop.
        expect(tool).toMatch(/press', 'Tab'\]\);\s*\n\s*const stop = readAnswer\(/u);
        // Not `.focus(` anywhere — the tool's own docblock names the shortcut it refuses to take.
        expect(tool).not.toContain("['focus'");
        expect(tool).not.toContain('.focus(');
    });

    it('reads the accessibility tree the browser builds, not the markup', () => {
        expect(tool).toContain("browser.run(['snapshot', '-c'])");
    });

    it('judges an indicator covered only when something paints over the focused box', () => {
        // The covering test itself lives in the browser expression (the page answers it), and the
        // sentence the finding is reported under lives in the keyboard pass that prints it.
        expect(source('site-expressions.js')).toContain('const inside = [');
        expect(source('site-expressions.js')).toContain('obscured: covering.some');
        expect(tool).toContain('with no visible indicator');
    });

    it('counts link stops against links, and records the stops that are neither', () => {
        expect(tool).toContain('const linkStops = stops.filter((stop) => isLink(stop));');
        expect(tool).toContain("return stop.tag === 'a' || stop.role === 'link';");
        expect(tool).toContain('otherStops:');
    });

    it('permits a table to scroll in its own container and refuses the document scrolling', () => {
        expect(tool).toContain("a table's own scroller is permitted, the document's is not");
        expect(tool).toMatch(/a \$\{control\} lies outside the frame/u);
    });
});

describe('the panel review measures the panel, in all three fixtures', () => {
    const tool = source('panel-a11y.js');

    it('applies every fixture and asserts the fallback really lost its aliases', () => {
        expect(tool).toContain('for (const fixture of [LIGHT, DARK, FALLBACK])');
        expect(tool).toMatch(/__MT__\.applyFixture\('\$\{fixture\}'\)/u);
        expect(tool).toContain('hostThemeReport()');
        // The fallback's whole claim is that the host's tokens are gone; asserted from the live
        // document before anything is read from the frame.
        expect(tool).toContain('theme.inlineAliases.length > 0 || theme.computedAliases.length > 0');
    });

    it('reads the focus indicator in both forms a control can draw one', () => {
        // @openchamber/sdk sets outline to none and paints a box-shadow ring, and the host token may
        // resolve as oklab() rather than rgb() — so a check reading only one of the two, or matching
        // the colour by name, would report the panel's inputs as having no indicator.
        expect(tool).toContain('indicator: {');
        expect(tool).toContain('const hasOutline =');
        expect(tool).toContain('const hasRing =');
        expect(tool).not.toContain(".includes('rgb')");
    });

    it('compares every control with the whole panel, not with the body region', () => {
        // The strip sits above the region and scrolls on its own; measuring it against the region
        // would report every tab that has been scrolled partly out of view as an escapee.
        expect(tool).toContain('const frame = root === null ? null : root.getBoundingClientRect();');
    });

    it('separates the body region from the controls in it', () => {
        // The guards, not only the sentences they print: an assertion written solely against a
        // message string survives the guard being deleted, which is how a check stops checking.
        expect(tool).toContain('function regionFindings(region, where) {');
        expect(tool).toContain('if (region === null || !region.scrollsSideways) {');
        expect(tool).toContain('function badgeFindings(badges, where) {');
        expect(tool).toContain('if (badges.empty === 0) {');
        expect(tool).toContain('state badge(s) carry no text');
    });
});
