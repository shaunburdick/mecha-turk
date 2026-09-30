/**
 * Documentation sync (005 T-033, discharging 002 FR-042 and AC-022).
 *
 * The two operator-facing documents must describe the product that shipped,
 * not the one that shipped in September: the six tabs and their vocabulary,
 * the prerequisites section on **Status**, the Dispatches list with its
 * paging and filters, **Settings** as the configuration surface for the whole
 * service configuration (including the agent-verification baseline the
 * integration card no longer carries), and the Accounts add form as the
 * expected-login supply surface.
 *
 * The negative half of AC-022 is here too: neither document may instruct an
 * operator to configure anything through `MECHA_TURK_*` or a `.env` file, may
 * present a dead `specs/001-agent-event-orchestrator/` path, or may name a
 * retired tab — with one sanctioned exception, the vocabulary mapping table,
 * which exists precisely to carry the retired words as history.
 *
 * Everything here reads the local tree only (FR-086).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The README, named once for the assertions that read only it. */
const README = 'README.md';

/** The two documents 002 FR-042 puts in scope. */
const PAGES: readonly string[] = [README, 'specs/002-agent-event-extension/quickstart.md'];

/** The six tabs FR-010 ships, which both documents must name. */
const TABS: readonly string[] = ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About'];

/** The heading the full mapping table lives under (005 FR-029). */
const VOCAB_HEADING = '## Vocabulary mapping';

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
 * Read one document with its vocabulary section removed — the one place the
 * retired words are supposed to appear (005 FR-029).
 *
 * @param page - Repository-relative path of the document.
 * @returns The document without any `## …Vocabulary…` section.
 */
function withoutMapping(path: string): string {
    const kept: string[] = [];
    let skipping = false;

    for (const line of readFileSync(resolve(ROOT, path), 'utf8').split('\n')) {
        if (line.startsWith('## ')) {
            skipping = /vocabulary/i.test(line);
        }

        if (!skipping) {
            kept.push(line);
        }
    }

    return kept.join('\n');
}

/**
 * Read one document whole.
 *
 * @param page - Repository-relative path of the document.
 * @returns Its text.
 */
function page(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('002 FR-042 / AC-022 the two operator documents describe the shipped panel', () => {
    it('reads both documents rather than an empty pair', () => {
        for (const doc of PAGES) {
            expect(page(doc).length, `${doc} is suspiciously short`).toBeGreaterThan(1500);
        }
    });

    it('names all six tabs, in the vocabulary the product ships', () => {
        for (const doc of PAGES) {
            const text = page(doc);
            for (const tab of TABS) {
                expect(text, `${doc} does not name the ${tab} tab`).toContain(tab);
            }
            expect(text).toContain('Dispatches');
            expect(text).toContain('Bindings');
        }
    });

    it('puts the prerequisites section on Status (005 FR-037)', () => {
        const onStatus = /Status[^\n]*prerequisites|prerequisites[^\n]*Status/i;

        for (const doc of PAGES) {
            const text = page(doc);
            expect(text, `${doc} does not mention the prerequisites`).toMatch(/prerequisites/i);
            expect(text, `${doc} does not place them on Status`).toMatch(onStatus);
        }
    });

    it('describes Settings as the surface for the whole service configuration', () => {
        for (const doc of PAGES) {
            const text = page(doc);
            expect(text, `${doc} does not point at the configuration document`).toContain('GET /v1/config');
            expect(text, `${doc} does not say the tab is read-only`).toContain('read-only in this release');
            // The baseline the integration card no longer carries (002 FR-029,
            // 006 FR-100): named, sourced from the service, defaulted.
            expect(text, `${doc} does not name the baseline field`).toContain('expectedAgent');
            expect(text, `${doc} does not name the documented default`).toContain('project-manager');
            expect(text, `${doc} does not say the card carries no settings`).toMatch(/carries \*\*no settings\*\*/);
        }
    });

    it('names the Accounts add form as the expected-login supply surface (005 FR-006)', () => {
        for (const doc of PAGES) {
            expect(page(doc), `${doc} does not document the expected-login input`)
                .toContain('expected GitHub login');
        }
    });

    it('describes the Dispatches list with its paging, filters, and controls (005 FR-042)', () => {
        const text = page(README);

        expect(text).toContain('cursor paging');
        expect(text).toContain('filters by binding and by state');
        expect(text).toContain('audit history');
    });

    it('reproduces the vocabulary mapping table in README in full (005 FR-029)', () => {
        const text = page(README);

        expect(text).toContain(VOCAB_HEADING);
        expect(text).toContain('| Runs (panel section) | **Dispatches** | L1 |');
        expect(text).toContain('| Repositories (panel tab) | **Bindings** | L1 |');
        expect(text).toContain('| `run` (entity, key, ordinal) | `run` | L4 |');
        expect(text).toContain('| `GET /v1/events` and its operations | *retained* | L3 |');
    });
});

describe('002 AC-022 the negative half: no dead instruction and no retired tab', () => {
    it('instructs no environment or file-based configuration', () => {
        for (const doc of PAGES) {
            const text = page(doc);
            expect(text, `${doc} still instructs an environment variable`).not.toContain('MECHA_TURK_');
            expect(text, `${doc} still points at a dotenv file`).not.toContain('.env');
        }
    });

    it('presents no dead specs/001 path', () => {
        for (const doc of PAGES) {
            expect(page(doc), `${doc} cites a retired spec path`)
                .not.toContain('specs/001-agent-event-orchestrator/');
        }
    });

    it('names no retired tab outside the vocabulary mapping', () => {
        for (const doc of PAGES) {
            const text = withoutMapping(doc);
            for (const retired of RETIRED) {
                expect(retired.test(text), `${doc} uses a retired noun: ${retired.source}`).toBe(false);
            }
        }

        // Not vacuous: the rule really does catch the shape it exists for,
        // and the mapping section really is the only place it is allowed.
        expect(RETIRED[0]?.test('the **Spike** tab')).toBe(true);
        expect(RETIRED[1]?.test('under **Runs**')).toBe(true);
        expect(page(README)).toContain(VOCAB_HEADING);
        expect(withoutMapping(README)).not.toContain(VOCAB_HEADING);
    });
});
