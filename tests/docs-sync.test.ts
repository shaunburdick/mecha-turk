/**
 * Documentation sync (005 T-033 + 006 T-029 + 007 T-031, discharging
 * 002 FR-042 / AC-022 as re-cut at v1.13.0).
 *
 * 002 v1.13.0 binds a **third** operator-facing document — the published site at
 * `https://shaunburdick.github.io/mecha-turk/` — and makes it authoritative
 * where a claim appears in more than one place. 007 FR-049 then made the prose
 * *move*: `README.md` went from 384 lines to 36 and the operator walkthrough
 * from 193 to 82, because no section's substance may be left in full in both a
 * repository document and a site page.
 *
 * So the per-document assertions below are **per-surface**. Each claim is
 * asserted against the one page that owns it and no other, which is what keeps
 * FR-049's one-home rule enforceable instead of aspirational:
 *
 * | claim | owner |
 * | --- | --- |
 * | the six tabs, the OpenChamber-off dependency, both storage locations | the landing page (FR-014 – FR-016) |
 * | the approval's capabilities, from the manifest, and no `network` | the install page (FR-020 – FR-024, FR-077) |
 * | `GET /v1/config`, `expectedAgent`, `config.json`, the expected login | the configure page (FR-025 – FR-035) |
 * | the starting-prompt field, its cap, and its refusals | the configure page (FR-030 – FR-034) |
 * | the prerequisites section and its placement on **Status** | the use page (FR-036 – FR-040) |
 * | the store inventory, the mapping table, every symptom token | the debug page (FR-041 – FR-045, FR-051) |
 *
 * Two claims are deliberately **not** asserted on any site page, and the reason
 * is in each case that the site states the substance in the words it owns rather
 * than the token the repository documents used:
 *
 * - `project-manager` — 002 v1.10.0 and 006 FR-100 (v1.5.0) **retired** it as
 *   the documented default (the owner's order: *"not everyone is going to use
 *   project-manager"*), so the site prescribes no agent name at all. The
 *   assertion is inverted rather than dropped: the site must say the baseline is
 *   blank by default **and** name no agent, which is the current requirement.
 * - `operator-backable` — 007 FR-032 requires the configure page to state that
 *   the file can be edited by hand and is the operator's to back up. It says
 *   exactly that in prose; the test asserts the prose rather than the spec's
 *   word for it.
 *
 * The negative half of AC-022 is here too and covers the site as well: no bound
 * surface may instruct an operator to configure anything through `MECHA_TURK_*`
 * or a `.env` **file**, may present a dead `specs/001-agent-event-orchestrator/`
 * path, and may name a retired tab. The one sanctioned exemption is the
 * identifier-mapping table on the debug page (D14), which is excluded by the
 * `data-vocabulary-mapping` marker that section carries — an attribute rather
 * than a comment, because Astro strips comments from a template.
 *
 * The site is read **as text** and never imported (FR-070): the root gate must
 * not lint, type-check, build, or resolve the site's dependency graph.
 *
 * Everything here reads the local tree only (FR-086).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The README, which under FR-049 is a summary and a pointer, nothing more. */
const README = 'README.md';

/** The operator walkthrough, whose install, first-run, store and troubleshooting sections became pointers. */
const WALKTHROUGH = 'specs/002-agent-event-extension/quickstart.md';

/** The two repository documents 002 FR-042 binds, and the site it made authoritative at v1.13.0. */
const REPOSITORY_DOCS: readonly string[] = [README, WALKTHROUGH];

/** The published address, so the two repository documents can be held to pointing at it. */
const SITE_ORIGIN = 'https://shaunburdick.github.io/mecha-turk';

/** The five site pages, each named by the documentation topic it is authoritative for (FR-049). */
const LANDING = 'site/src/pages/index.astro';
const INSTALL = 'site/src/pages/install.astro';
const CONFIGURE = 'site/src/pages/configure.astro';
const USE = 'site/src/pages/use.astro';
const DEBUG = 'site/src/pages/debug.astro';

/** Every surface FR-042 binds: the two repository documents and the five site pages. */
const BOUND_SURFACES: readonly string[] = [...REPOSITORY_DOCS, LANDING, INSTALL, CONFIGURE, USE, DEBUG];

/** The six tabs FR-010 ships, which the landing page is the one place that enumerates. */
const TABS: readonly string[] = ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About'];

/**
 * The floor a bound surface must clear for the read to have found a document.
 *
 * Deliberately low, and deliberately not a length target. The first cut of this
 * guard demanded 1,500 characters of every bound document, which was written
 * when both were prose walls; 007 FR-049 then shortened the README to 1,605 —
 * passing by 81 characters, so the next honest trim of a document that is
 * *supposed* to be a summary would have failed for no reason. A summary README
 * is the shipped state, not a defect. What the guard is for is the other half
 * of its message, "reads both documents rather than an empty pair": catching a
 * truncated or emptied file. 400 characters catches that and is below any
 * honest length for every surface here — the shortest, `install.astro`, is 5,356.
 */
const MINIMUM_SURFACE_CHARS = 400;

/**
 * The heading the README's vocabulary-mapping table used to live under
 * (005 FR-029), which the product owner removed from the readme on
 * 2026-10-01. Kept as the name of the thing that must **not** come back, so
 * the negative guard below fails loudly rather than silently if it does.
 */
const MAPPING_HEADING = '## Vocabulary mapping';

/** The two mapping rows the readme carried, which are spec-only now. */
const MAPPING_ROWS: readonly string[] = [
    '| Runs (panel section) | **Dispatches** | L1 |',
    '| Repositories (panel tab) | **Bindings** | L1 |',
    '| `run` (entity, key, ordinal) | `run` | L4 |',
    '| `GET /v1/events` and its operations | *retained* | L3 |',
];

/**
 * Shapes a retired noun takes when it is used rather than quoted: the bold
 * labels the old surface used, and the capital nouns the rename retired.
 */
const RETIRED: readonly RegExp[] = [
    /\*\*(Spike|Repos|Repositories|Runs|Health)\b/,
    /\bRuns\b/,
    /\bRepositories\b/,
    /\bRun\b\s+[a-z]/,
    /Repos pane/,
    /Spike tab/,
];

/**
 * A `.env` **file** reference, which no bound surface may instruct an operator to
 * configure the product through.
 *
 * The one exemption is named rather than a general boundary: `import.meta.env`,
 * which `site/src/data/site.ts` and `site/src/env.d.ts` spell while reading the
 * declared base path and the environment types. That is Astro's build-time API
 * in two source files, not a dotenv file, and a lookbehind of the whole spelling
 * keeps every other shape in — `my.env.local` and `dotenv` still fail here,
 * which a blanket word-character boundary would have let through.
 */
const DOTENV_FILE = /(?<!\bimport\.meta)\.env\b/;

/**
 * Proof the dotenv rule still bites on the shapes it exists for, checked in the
 * test body rather than trusted from the pattern's appearance.
 */
const DOTENV_SAMPLES: readonly (readonly [string, boolean])[] = [
    ['Configure it through a .env file.', true],
    ['a `.env` in the repository root', true],
    ['my.env.local and the .env.example template', true],
    ['reads import.meta.env.BASE_URL at build time', false],
];

/**
 * The identifier-mapping section on the debug page, as authored.
 *
 * The table's **markup** carries `data-vocabulary-mapping="true"` (D14), and its
 * **data** is the frontmatter `mappingRows` declaration that markup renders — the
 * retired words are written once, in the declaration, and the section is the
 * sanctioned one place on the site they may appear (005 FR-029, 007 AC-013).
 * Both are cut together and nothing else is, because a scan that exempted the
 * whole page would be no exemption at all.
 */
const MAPPING_SECTION = /<section\b[^>]*\bdata-vocabulary-mapping="true"[^>]*>[\S\s]*?<\/section>/;
const MAPPING_DECLARATION = /\nconst mappingRows[^=]*=\s*\[[\S\s]*?\n\];\n/;

/**
 * Read one surface whole.
 *
 * @param path - Repository-relative path of the surface.
 * @returns Its text.
 */
function page(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}

/**
 * Prose asserts against whitespace-normalized text: both repository documents
 * and every site page are hand-wrapped, so a phrase's words can be on two lines.
 *
 * @param path - Repository-relative path of the surface.
 * @returns Its text with every whitespace run collapsed to one space.
 */
function prose(path: string): string {
    return page(path).replaceAll(/\s+/g, ' ');
}

/**
 * Read the debug page with the identifier-mapping table cut out — the one place
 * on the site the retired words are allowed to appear.
 *
 * @returns The page, minus its mapping section and the declaration that section renders.
 */
function debugWithoutMappingTable(): string {
    return page(DEBUG).replace(MAPPING_SECTION, '').replace(MAPPING_DECLARATION, '');
}

/**
 * Every surface, with the debug page's identifier-mapping table removed.
 *
 * @returns A `path`/`text` pair per bound surface, keyed so a failure names it.
 */
function boundSurfaces(): readonly (readonly [string, string])[] {
    return BOUND_SURFACES.map((path) => [path, path === DEBUG ? debugWithoutMappingTable() : page(path)]);
}

describe('002 FR-042 the bound documents are read, not an empty set (T-031)', () => {
    it('finds prose on every surface 002 v1.13.0 binds', () => {
        {
            const surfaces = boundSurfaces();

            expect(surfaces).toHaveLength(BOUND_SURFACES.length);
            for (const [path, text] of surfaces) {
                expect(text.length, `${path} is suspiciously short`).toBeGreaterThan(MINIMUM_SURFACE_CHARS);
            }
        }
        {
            // The pair this suite was written around, plus the three pages that
            // answer "where does the operator read this now" — so a site page
            // going missing fails here rather than as a missing-file error.
            expect(BOUND_SURFACES).toEqual([
                README,
                WALKTHROUGH,
                LANDING,
                INSTALL,
                CONFIGURE,
                USE,
                DEBUG,
            ]);
        }
    });
});

describe('007 FR-049 each claim is asserted against the one page that owns it', () => {
    it('the landing page owns the six tabs, the OpenChamber-off dependency, and both storage locations', () => {
        {
            for (const tab of TABS) {
                expect(page(LANDING), `the landing page does not name the ${tab} tab`).toContain(tab);
            }
            // `Dispatches` and `Bindings` were two further assertions in the
            // first cut of this file, and they were dead weight twice over: they
            // are two of the six the loop above already holds, and their subject
            // — that the tabs really are called Dispatches and Bindings — is
            // pinned against the shipped panel by `tests/vocabulary.test.ts`
            // (L1) and `tests/bundle.test.ts` (the panel bundle's six labels).
            // What is new here is that the **landing page** names them.
        }
        {
            // FR-014 and AC-030: the OpenChamber-off dependency is documented and
            // surfaced, not masked, and the page says where it is read.
            expect(page(LANDING)).toContain('<strong>Nothing runs while OpenChamber is off.</strong>');
            expect(page(LANDING)).toContain('<strong>Status</strong> tab');
        }
        {
            // FR-016 and AC-031: two locations, what each holds, and which
            // survives an uninstall.
            expect(page(LANDING)).toContain('<code>~/.config/openchamber/mecha-turk/</code>');
            expect(page(LANDING), 'the landing page names no extension-storage location').toContain(
                "OpenChamber's extension storage",
            );
            expect(page(LANDING)).toContain('<strong>It survives an uninstall.</strong>');
            expect(page(LANDING)).toContain('<strong>Wiped on uninstall.</strong>');
        }
    });

    it('the install page owns the approval capability list and the absence of any network capability', () => {
        {
            // The permission table is generated from the manifest rather than
            // retyped, so the page cannot claim a capability the manifest does
            // not request — which is the half of AC-022 the README used to fail.
            // Anchored on the element and its prop, so the page's own docblock,
            // which also names the component, cannot satisfy it on its own.
            expect(page(INSTALL), 'the install page renders no permission table').toContain('<Permissions describe={');
        }
        {
            // AGENTS.md invariant 3: since the owner's 2026-09-30 sweep no
            // integration card exists and `network` is not requested at all, so
            // the page has to say the absence rather than let a reader infer it
            // from a list that happens not to mention it.
            expect(page(INSTALL), 'the install page does not say no network capability is requested')
                .toContain('No network capability is requested');
            expect(page(INSTALL), 'the install page does not say the panel makes no GitHub request')
                .toContain('the panel makes no GitHub request of its own');
        }
        // **The card's own absence is not asserted here, and the page does not
        // claim it.** The product fact is guarded by `tests/manifest.test.ts`
        // instead — `contributes.integration` is undefined, in "GitHub
        // integration card (retired 2026-09-30)" and "002 FR-041 / FR-011 re-cut".
        // This suite's pre-restructure half asserted the same absence in prose
        // over README and walkthrough (`/carries **no settings**|no integration
        // card/`). Nothing obliges the page to repeat it: 007's `## Out of
        // Scope` says the site documents what is requested "and nothing more",
        // and FR-049 forbids a topic living at two lengths — it obliges no
        // coverage beyond what a page owns. Restoring the prose is an addition
        // of scope to be agreed, not a gap to be filled here.
    });

    it('the configure page owns the configuration, the baseline, and the expected-login input', () => {
        {
            // 006 T-029, on the page that FR-033 names. The endpoint is written
            // as `<code>GET</code>/<code>PUT /v1/config</code>` — two code spans
            // round one path — so the assertion is on the rendered path rather
            // than on the two-word verb phrase, which appears nowhere in the page
            // and could not be retyped without splitting the markup that makes it
            // readable. Anchored on the code span so the page's own docblock,
            // which also mentions the path, cannot satisfy it on its own.
            expect(page(CONFIGURE), 'the configure page names no configuration endpoint')
                .toContain('<code>PUT /v1/config</code>');
            // 006 T-029 (extending 005 T-033): the read-only era is history, the
            // tab edits, and the page must say where the write actually lands.
            expect(page(CONFIGURE)).toContain('Save configuration');
        }
        {
            // The baseline the integration card no longer carries (002 FR-029,
            // 006 FR-100), named, and its documented default — which is blank.
            expect(prose(CONFIGURE), 'the configure page does not name the baseline field')
                .toContain('expectedAgent');
            expect(prose(CONFIGURE), 'the configure page does not say the baseline is blank by default')
                .toContain('blank by default');
        }
        {
            // 002 v1.10.0 retired `project-manager` as the documented default, so
            // no site page names an agent and the configure page says the value
            // is the operator's own. This is the one assertion here that was
            // *inverted* rather than re-pointed, and the inversion is the
            // current requirement: an assertion that a site page named
            // `project-manager` would fail the product forever.
            expect(page(CONFIGURE), 'the configure page prescribes an agent the owner retired as a default')
                .not.toContain('project-manager');
        }
        {
            // 006's own surface claims: where the document lives, that the
            // operator can edit and back it up, and that nothing else configures
            // anything. 007 FR-032 requires the second of those; the site's word
            // for it is prose rather than the specification's
            // *operator-backable*, and this asserts the prose that says it.
            expect(page(CONFIGURE), 'the configure page does not say where the configuration lives')
                .toContain('config.json');
            expect(page(CONFIGURE), 'the configure page does not say the document can be edited by hand')
                .toContain('you can edit by hand');
            expect(page(CONFIGURE), 'the configure page does not rule out another configuration surface')
                .toContain('There is no other way to configure this');
        }
        {
            // 005 FR-006 and 006 T-029: the Accounts add form is the
            // expected-login supply surface, and a disagreeing token is refused
            // rather than applied.
            expect(page(CONFIGURE)).toContain('<strong>Expected GitHub login</strong>');
            expect(page(CONFIGURE), 'the configure page does not say a disagreeing token is refused')
                .toContain('refused rather than applied');
        }
    });

    it('the use page owns the prerequisites section and where it is rendered', () => {
        {
            // 005 FR-037: the section is on Status, and this is the page whose
            // subject is the panel an operator watches rather than a checklist.
            expect(page(USE)).toContain('<h2>The setup prerequisites, on the Status tab</h2>');
            expect(page(USE), 'the use page does not place the prerequisites on Status')
                .toMatch(/prerequisites[^\n]*Status/i);
        }
    });

    it('the debug page owns the store inventory, the identifier mapping, and the storage locations', () => {
        {
            expect(page(DEBUG), 'the debug page names no binding store file').toContain("'bindings.json'");
        }
        {
            // AC-031's second page: the debug page has to name both locations and
            // say which survives an uninstall too — the landing page states it,
            // and a reader who lands here from a symptom needs it here. The one
            // that does *not* survive is named as the one that does not, so the
            // pair cannot be satisfied by naming only the folder to back up.
            expect(page(DEBUG), 'the debug page names no service-store location')
                .toContain('<code>.config/openchamber/mecha-turk/</code>');
            expect(page(DEBUG), 'the debug page names no extension-storage location')
                .toContain('OpenChamber extension storage');
            expect(page(DEBUG), 'the debug page does not say the service store survives')
                .toContain('<strong>the service store does</strong>');
            expect(prose(DEBUG), 'the debug page does not say extension storage is wiped')
                .toContain('Extension storage does not survive it');
        }
        {
            // 005 FR-029 and 007 AC-013: the mapping table is on the site, and it
            // is the one place the retired words are allowed to appear.
            expect(page(DEBUG), 'the debug page carries no mapping section')
                .toContain('data-vocabulary-mapping="true"');
            expect(page(DEBUG), 'the debug page declares no mapping rows').toContain('const mappingRows');
        }
    });
});

describe('007 FR-042 the tie-break: the site governs, and the other two point at it', () => {
    it('both repository documents name the page that owns each subject', () => {
        {
            expect(page(README), 'the README does not name the published documentation').toContain(`${SITE_ORIGIN}/`);
        }
        {
            // The walkthrough's install, first-run, store and troubleshooting
            // sections reduced to pointers (FR-049). Each documentation address
            // it reduced to must still be in it, or a reader who follows the
            // pointer from the repository arrives nowhere.
            for (const topic of ['install', 'configure', 'use', 'debug']) {
                expect(page(WALKTHROUGH), `the walkthrough points at no ${topic} page`)
                    .toContain(`${SITE_ORIGIN}/${topic}/`);
            }
        }
    });
});

describe('002 AC-022 the negative half: no dead instruction and no retired tab', () => {
    it('instructs no environment or file-based configuration', () => {
        {
            for (const [path, text] of boundSurfaces()) {
                expect(text, `${path} still instructs an environment variable`).not.toContain('MECHA_TURK_');
                expect(text, `${path} still points at a dotenv file`).not.toMatch(DOTENV_FILE);
            }
        }
        {
            for (const [path, text] of boundSurfaces()) {
                expect(text, `${path} cites a retired spec path`).not.toContain('specs/001-agent-event-orchestrator/');
            }
        }
        {
            for (const [path, text] of boundSurfaces()) {
                for (const retired of RETIRED) {
                    expect(retired.test(text), `${path} uses a retired noun: ${retired.source}`).toBe(false);
                }
            }

            // Not vacuous: the rule really does catch the shape it exists for,
            // and it now reads all seven bound surfaces — with the mapping table
            // that used to be the one sanctioned exemption excluded, and nothing
            // else.
            expect(RETIRED[0]?.test('the **Spike** tab')).toBe(true);
            expect(RETIRED[1]?.test('under **Runs**')).toBe(true);
            expect(page(README)).not.toContain(MAPPING_HEADING);
            for (const [sample, matched] of DOTENV_SAMPLES) {
                const verdict = matched ? 'should' : 'should not';

                expect(DOTENV_FILE.test(sample), `${sample} — the dotenv rule ${verdict} match`).toBe(matched);
            }
        }
        {
            // The exemption is exactly the table: cutting it is what lets the
            // debug page pass, so the uncut page is proved to still carry the
            // retired words. An exemption that removed nothing would be
            // indistinguishable from no exemption at all.
            const raw = page(DEBUG);

            expect(raw, 'the debug page names no retired noun without the cut').toMatch(RETIRED[1] ?? /$^/);
            expect(raw).toMatch(RETIRED[2] ?? /$^/);
            expect(debugWithoutMappingTable()).not.toMatch(RETIRED[1] ?? /$^/);
        }
    });

    it('reads the README whole, with no mapping heading and no mapping row', () => {
        {
            const text = page(README);

            // The owner's 2026-10-01 ruling, verbatim in intent: this is a
            // user-oriented readme for an unreleased product, so the rename
            // history goes entirely — heading, prose, and every row. What the
            // rows used to guard positively (the tabs really are called
            // Dispatches and Bindings) is guarded by the landing-page assertion
            // above, which is where that vocabulary now lives.
            expect(text, 'the README still introduces a vocabulary mapping')
                .not.toContain(MAPPING_HEADING);
            for (const row of MAPPING_ROWS) {
                expect(text, `the README still carries the mapping row ${row}`).not.toContain(row);
            }
        }
    });
});
