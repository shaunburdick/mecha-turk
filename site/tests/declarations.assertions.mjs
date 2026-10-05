/**
 * The four generated tables, checked against the declarations they are derived
 * from, and shown able to fail.
 *
 * `src/data/declarations.ts` imports its four sources, so importing it here and
 * reading it proves nothing on its own — that is the same object. What these
 * assertions do instead is **read the sources a second way**: `package.json`
 * through `JSON.parse`, and each TypeScript declaration through its own text.
 * The two readings are independent, which is what makes drift detectable at all.
 *
 * Three failures this catches, which is why each of the three exists:
 *
 * 1. **A hand-typed table.** If someone replaces an import with a copied list,
 *    the table agrees with itself and disagrees with the source. The text
 *    comparison is what notices (D7's rejected alternative).
 * 2. **A source that changed shape.** A bound added, a state renamed, a
 *    capability withdrawn: the parse yields a set the table does not have.
 * 3. **A capability the product stopped requesting.** `network` in particular —
 *    the table's whole purpose is that it cannot carry it (FR-077).
 *
 * And the negative half, which is the part that makes the rest a check rather
 * than a description: `declarations.assertions.mjs` ends by handing each
 * comparison a deliberately broken declaration and asserting it refuses. A
 * comparison never seen red is an assumption wearing a check's clothes.
 *
 * The `.assertions.mjs` name is deliberate, for the reason
 * `base-path.assertions.mjs` sets out: the repository's vitest has no config
 * file, so its default include globs every `test`-suffixed file from the
 * repository root and would collect this one into the repository's own gate,
 * which FR-070 says must not notice `site/` at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    ALLOW_LIST_BLOCKED_CAUSE,
    BLOCKED_FAMILY_PREFIX,
    BLOCKED_FILTER_TOKEN,
    BLOCKED_REASON_SHAPE,
    CAPABILITIES,
    CAPABILITY_COUNT,
    CONFIG_FIELDS,
    DECLARED_BLOCKED_CAUSES,
    DISPATCH_STATES,
    DISPATCH_STATE_TOKENS,
    PANEL_PLAIN_STATES,
    PANEL_PROBLEM_SHAPES,
    SYMPTOM_CODES,
    SYMPTOM_MESSAGES,
    TAKE_EFFECT_WORDS,
} from '../src/data/declarations.ts';
import { LICENSE_URL, OPENCHAMBER_ENGINE_FLOOR, PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from '../src/data/product.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_SRC = join(REPO_ROOT, 'site', 'src');

// The take-effect vocabulary is read through `declarations.ts` rather than
// imported from `service/config-schema.ts` directly: this file's other service
// reads go through `src/data/declarations.ts`, and importing one module from
// here and two from there would mean the assertions were reading a mix of
// sources — which is the drift they exist to catch, modelled at the wrong level.

/**
 * Read a repository source file.
 *
 * @param {...string} parts Path segments below the repository root.
 * @returns {string} The file's text.
 */
function source(...parts) {
    return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

/**
 * The body of one exported declaration, so a parse cannot wander into the rest
 * of the file and pick up an unrelated list of the same shape.
 *
 * @param {string} text A source file.
 * @param {string} declaration The name of the export to read.
 * @param {RegExp} closer What ends the declaration.
 * @returns {string} The declaration's body.
 */
function bodyOf(text, declaration, closer) {
    const start = text.indexOf(declaration);
    assert.notEqual(start, -1, `${declaration} is declared in the file this reads`);
    const end = text.indexOf(closer, start);
    assert.notEqual(end, -1, `${declaration} is closed`);
    return text.slice(start, end);
}

/**
 * Every single-quoted string literal in a declaration body, in source order.
 *
 * @param {string} body A declaration's body.
 * @returns {string[]} The literals, without their quotes.
 */
function stringsIn(body) {
    return [...body.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/**
 * Assert one generated list equals what its declaration says.
 *
 * Written as a function taking both sides so the negative cases below can drive
 * it with a broken declaration — the whole point of the file.
 *
 * @param {string} label What is being compared, named in the failure.
 * @param {readonly string[]} actual What the site publishes.
 * @param {readonly string[]} expected What the declaration declares.
 */
function assertDeclares(label, actual, expected) {
    const missing = expected.filter((entry) => !actual.includes(entry));
    assert.deepEqual(missing, [], `${label}: the site omits ${JSON.stringify(missing)}`);
    const extra = actual.filter((entry) => !expected.includes(entry));
    assert.deepEqual(extra, [], `${label}: the site publishes ${JSON.stringify(extra)}, which nothing declares`);
}

// ---------------------------------------------------------------------------
// Table 1 — capabilities, from package.json
// ---------------------------------------------------------------------------

describe('CAPABILITIES', () => {
    /** What the shipped manifest requests, read without going through the site. */
    const declared = JSON.parse(source('package.json')).openchamber;

    test('is exactly the manifest array plus the capability the service implies', () => {
        assertDeclares(
            'the permission table',
            CAPABILITIES.map((capability) => capability.id),
            [...declared.contributes.capabilities, 'service'],
        );
    });

    test('marks each row with where the manifest asks for it', () => {
        const origins = Object.fromEntries(CAPABILITIES.map((entry) => [entry.id, entry.origin]));
        assert.deepEqual(origins, { sessions: 'requested', prompt: 'requested', service: 'implied' });
    });

    test('names no capability the manifest does not request', () => {
        // The stale `network` row the README still carries, asserted as absent
        // (FR-077). It was removed by product-owner order on 2026-09-30
        // (AGENTS.md invariant 3); the manifest never asked for it.
        assert.ok(!CAPABILITIES.some((capability) => capability.id === 'network'));
        assert.ok(!declared.contributes.capabilities.includes('network'));
    });

    test('counts the rows it renders, so a stated count cannot disagree', () => {
        assert.equal(CAPABILITY_COUNT, CAPABILITIES.length);
    });

    test('has no two rows at the same capability', () => {
        const ids = CAPABILITIES.map((capability) => capability.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    test('refuses a capability the declaration does not carry', () => {
        // The negative case: a table that grew a row by hand.
        assert.throws(
            () => assertDeclares(
                'a hand-edited table',
                [...CAPABILITIES.map((capability) => capability.id), 'network'],
                [...declared.contributes.capabilities, 'service'],
            ),
            /the site publishes \["network"\]/,
        );
    });

    test('refuses a capability the manifest withdrew', () => {
        // The other direction: the manifest stopped asking, the page did not.
        assert.throws(
            () => assertDeclares('a stale table', CAPABILITIES.map((capability) => capability.id), ['prompt', 'service']),
            /sessions/,
        );
    });
});

// ---------------------------------------------------------------------------
// Table 2 — configuration fields, from service/config.ts through its projection
// ---------------------------------------------------------------------------

describe('CONFIG_FIELDS', () => {
    const configSource = source('service', 'config.ts');

    /** The bounds table as the validator itself spells them, read from its text. */
    function declaredBounds() {
        const body = bodyOf(configSource, 'export const NUMERIC_BOUNDS', '} as const');
        const entries = [...body.matchAll(/(\w+):\s*\{\s*min:\s*([\d_]+),\s*max:\s*([\d_]+),\s*unit:\s*'([^']+)'/g)];
        assert.notEqual(entries.length, 0, 'NUMERIC_BOUNDS is parseable');
        return entries.map(([, name, min, max, unit]) => ({
            name,
            min: Number(min.replaceAll('_', '')),
            max: Number(max.replaceAll('_', '')),
            unit,
        }));
    }

    /** The default document's keys, read from its text. */
    function declaredDefaults() {
        const body = bodyOf(configSource, 'export const DEFAULT_CONFIG', '\n};');
        return [...body.matchAll(/^ {4}(\w+):/gm)].map(([, name]) => name);
    }

    test('is every field the default document declares, in declaration order', () => {
        assert.deepEqual(CONFIG_FIELDS.map((field) => field.name), declaredDefaults());
    });

    test('carries a bound, a unit, and a default for every numeric field', () => {
        for (const bound of declaredBounds()) {
            const field = CONFIG_FIELDS.find((entry) => entry.name === bound.name);
            assert.notEqual(field, undefined, `${bound.name} reaches the page`);
            assert.equal(field.kind, 'integer', `${bound.name} is a numeric field`);
            if (field.kind !== 'integer') {
                throw new Error('unreachable after the kind assertion above');
            }

            assert.equal(field.min, bound.min, `${bound.name} prints its real lower bound`);
            assert.equal(field.max, bound.max, `${bound.name} prints its real upper bound`);
            assert.equal(field.unit, bound.unit, `${bound.name} prints the validator's own unit`);
            assert.ok(
                field.default >= field.min && field.default <= field.max,
                `${bound.name}'s declared default is inside its own bounds`,
            );
        }
    });

    test('declares exactly eleven numeric fields', () => {
        const numeric = CONFIG_FIELDS.filter((field) => field.kind === 'integer');
        assert.equal(numeric.length, 11);
        assert.deepEqual(
            numeric.map((field) => field.name),
            declaredBounds().map((bound) => bound.name),
        );
    });

    test('carries the log level with the accepted set and its own class', () => {
        const level = CONFIG_FIELDS.find((field) => field.name === 'logLevel');
        assert.notEqual(level, undefined, 'logLevel reaches the page');
        assert.equal(level.kind, 'enum');
        if (level.kind !== 'enum') {
            throw new Error('unreachable after the kind assertion above');
        }

        assert.deepEqual([...level.values], ['debug', 'info', 'warn', 'error']);
        assert.equal(level.default, 'info');
        assert.equal(level.takesEffect, 'immediate');
    });

    test('carries the agent baseline with an empty default meaning *no baseline*', () => {
        const baseline = CONFIG_FIELDS.find((field) => field.name === 'expectedAgent');
        assert.notEqual(baseline, undefined, 'expectedAgent reaches the page');
        assert.equal(baseline.kind, 'string');
        if (baseline.kind !== 'string') {
            throw new Error('unreachable after the kind assertion above');
        }

        // Empty is the documented *unset* state, not a missing value — the
        // difference the component renders as `empty — unset`.
        assert.equal(baseline.default, '');
    });

    test('carries the global prompt tier with its cap and multiline shape', () => {
        const prompt = CONFIG_FIELDS.find((field) => field.name === 'startingPrompt');
        assert.notEqual(prompt, undefined, 'startingPrompt reaches the page');
        assert.equal(prompt.kind, 'string');
        if (prompt.kind !== 'string') {
            throw new Error('unreachable after the kind assertion above');
        }

        assert.equal(prompt.default, '');
        assert.equal(prompt.multiline, true);
        assert.ok(prompt.maxLength > 0, 'the tier has a cap the validator enforces');
    });

    test('gives every field a take-effect class, and a word for each class', () => {
        for (const field of CONFIG_FIELDS) {
            const words = TAKE_EFFECT_WORDS[field.takesEffect];
            assert.ok(typeof words === 'string' && words.trim() !== '', `${field.name} has take-effect words`);
        }
    });

    test('covers the service\'s whole take-effect vocabulary, not only the classes in use', () => {
        // `restart` and `none` are carried by the wire contract and declared by no
        // field today, so a map keyed only by the classes in use would pass now
        // and be incomplete the day one is used. The vocabulary is read from the
        // service's own text rather than from the fields, which is the whole
        // difference between the two checks.
        const schemaSource = source('service', 'config-schema.ts');

        // The union the service declares. This — not the fields — is the whole
        // vocabulary: `restart` and `none` are carried by the wire contract and
        // declared by no field, so a map keyed only by observed classes would
        // pass today and be incomplete the day one is used.
        const vocabulary = stringsIn(bodyOf(schemaSource, 'export type TakeEffect =', ';'));
        assert.deepEqual(Object.keys(TAKE_EFFECT_WORDS).sort(), [...vocabulary].sort());
        for (const declared of vocabulary) {
            assert.ok(TAKE_EFFECT_WORDS[declared].trim() !== '', `${declared} words are non-empty`);
        }

        // And the two unused classes are genuinely unused, so the check above is
        // covering a real gap rather than a hypothetical one.
        const declared = bodyOf(schemaSource, 'export const TAKE_EFFECT', '} as const');
        const inUse = new Set([...declared.matchAll(/:\s*'([^']+)'/g)].map((match) => match[1]));
        assert.equal(inUse.has('restart'), false, 'no field declares restart today');
        assert.equal(inUse.has('none'), false, 'no field declares none today');
    });

    test('gives no two fields the same name', () => {
        const names = CONFIG_FIELDS.map((field) => field.name);
        assert.equal(new Set(names).size, names.length);
    });

    test('refuses a field the declaration dropped', () => {
        // The negative case: the validator retired a field and the page kept it.
        const kept = CONFIG_FIELDS.map((field) => field.name).filter((name) => name !== 'perPage');
        assert.throws(
            () => assertDeclares('a stale field list', kept, declaredDefaults()),
            /the site omits \["perPage"\]/,
        );
    });

    test('cannot print a stale bound, because the number it prints is the validator\'s', () => {
        // The negative case, and the reason this table is generated rather than
        // written. Moving a bound in `NUMERIC_BOUNDS` is the realistic drift; a
        // copied table would go on printing the old number and **every other
        // assertion here would still pass**, because the stale value is a
        // faithful copy of a value that used to be true.
        //
        // So the check is against the validator's own text rather than against a
        // remembered number: read the bound from the source, read the field from
        // the projection, and require them to be the same fact. A hand-typed table
        // cannot satisfy that after a bound moves, and this is the assertion that
        // notices.
        const body = bodyOf(configSource, 'export const NUMERIC_BOUNDS', '} as const');
        const match = /intervalMs:\s*\{\s*min:\s*([\d_]+),\s*max:\s*([\d_]+),\s*unit:\s*'([^']+)'/.exec(body);
        assert.notEqual(match, null, 'intervalMs declares bounds, a unit, and both of them');
        const field = CONFIG_FIELDS.find((entry) => entry.name === 'intervalMs');
        assert.notEqual(field, undefined, 'intervalMs reaches the page');
        if (field?.kind !== 'integer') {
            throw new Error('intervalMs reaches the page as a numeric field');
        }

        assert.equal(field.min, Number(match[1].replaceAll('_', '')));
        assert.equal(field.max, Number(match[2].replaceAll('_', '')));
        assert.equal(field.unit, match[3]);

        // And the realistic failure is proved against a mutated *source*: this is
        // what a hand-typed table does when a bound moves. It goes on printing the
        // number it was written with, and a table-versus-table check would call it
        // correct — because the stale value is a faithful copy of a value that used
        // to be true. The check against the validator's text is the only shape that
        // catches it, so the mutation is applied here to show it does.
        const movedBody = body.replace('min: 15_000, max: 300_000', 'min: 5_000, max: 300_000');
        assert.notEqual(movedBody, body, 'the mutation actually moved the bound');
        const moved = /intervalMs:\s*\{\s*min:\s*([\d_]+)/.exec(movedBody);
        assert.equal(Number(moved?.[1].replaceAll('_', '')), 5000, 'the source now declares the new bound');

        // The table still prints the old number, and the comparison against the
        // source text is what refuses it.
        assert.throws(
            () => assert.equal(field.min, Number(moved[1].replaceAll('_', '')), 'the page prints the new bound'),
            /15000 !== 5000/,
        );
    });
});

// ---------------------------------------------------------------------------
// Table 3 — dispatch states, from service/routes/events-page.ts and src/run-state.ts
// ---------------------------------------------------------------------------

describe('DISPATCH_STATES', () => {
    /** `LISTABLE_STATES`, read from the route's own text. */
    const declared = stringsIn(
        bodyOf(source('service', 'routes', 'events-page.ts'), 'export const LISTABLE_STATES', '] as const'),
    );

    test('is every state the service filter accepts, in its order', () => {
        assert.deepEqual([...DISPATCH_STATES], declared);
    });

    test('agrees with the panel\'s own seven-state vocabulary', () => {
        // Two declarations of the same seven words, one on each side of the wire.
        // A state added to one and not the other is a state one surface refuses.
        assert.deepEqual([...PANEL_PLAIN_STATES], [...DISPATCH_STATES]);
    });

    test('carries a row for each state plus the blocked family', () => {
        assert.deepEqual([...DISPATCH_STATE_TOKENS], [...DISPATCH_STATES, BLOCKED_FILTER_TOKEN]);
    });

    test('describes blocked as a family with a shape, not as an enumerated set', () => {
        assert.equal(BLOCKED_FAMILY_PREFIX, 'blocked:');
        assert.equal(BLOCKED_REASON_SHAPE, 'blocked:<reason>');
        // The family is a prefix: `stateFilterOf` accepts any non-empty kebab
        // reason, so no table may claim the states below are all of them.
        assert.ok(!DISPATCH_STATES.includes(BLOCKED_FILTER_TOKEN), 'blocked is not one of the plain states');
    });

    test('names the causes the service declares without claiming they are the only ones', () => {
        const blockSource = source('service', 'poll', 'dispatch-block.ts');
        const body = bodyOf(blockSource, 'export const BLOCKED_REASONS', ']);');
        const fromText = stringsIn(body);

        // Four of the five are literals; the fifth is the actor gate's exported
        // constant, which the service names by reference precisely because four
        // modules say that one string. So the text read is the four literals
        // plus whatever the constant resolves to.
        assert.deepEqual(
            [...DECLARED_BLOCKED_CAUSES].sort(),
            [...fromText, ALLOW_LIST_BLOCKED_CAUSE].sort(),
        );
        assert.equal(fromText.length, 4, 'the declaration is four literals and one named constant');
        assert.ok(body.includes('ACTOR_BLOCKED_REASON'), 'the fifth entry is the constant, not a literal');

        // And the constant resolves to the word the actor gate's own export
        // carries — read from that module rather than from here.
        const gate = source('service', 'poll', 'dispatch-actor-gate.ts');
        assert.equal(
            ALLOW_LIST_BLOCKED_CAUSE,
            stringsIn(bodyOf(gate, 'export const ACTOR_NOT_ALLOWED', ';'))[0],
        );
        assert.ok(DECLARED_BLOCKED_CAUSES.includes(ALLOW_LIST_BLOCKED_CAUSE));
    });

    test('gives no two states the same token', () => {
        assert.equal(new Set(DISPATCH_STATE_TOKENS).size, DISPATCH_STATE_TOKENS.length);
    });

    test('refuses a state the service added', () => {
        // The negative case: a state lands in the model and the page omits it.
        assert.throws(
            () => assertDeclares('a stale state table', [...DISPATCH_STATES], [...declared, 'quarantined']),
            /the site omits \["quarantined"\]/,
        );
    });

    test('refuses a state the service never shipped', () => {
        assert.throws(
            () => assertDeclares('a state invented for the page', [...DISPATCH_STATES, 'waiting'], declared),
            /the site publishes \["waiting"\]/,
        );
    });
});

// ---------------------------------------------------------------------------
// Table 4 — symptom tokens, from src/handoff-copy.ts
// ---------------------------------------------------------------------------

describe('SYMPTOM_CODES', () => {
    const copySource = source('src', 'handoff-copy.ts');

    /**
     * The keys of one of the panel's three copy tables, read from its text.
     *
     * @param {string} table The exported map's name.
     * @returns {string[]} Its keys, in source order.
     */
    function keysOf(table) {
        // Entries are matched by the key literal rather than by indentation,
        // because one of them (`scope-missing:pull-requests`) is wrapped across
        // lines to stay inside the file's length gate — a column-anchored
        // pattern would read that table as one entry short.
        const body = bodyOf(copySource, `export const ${table}`, ']);');
        return [...body.matchAll(/\[\s*'([^']+)',/g)].map(([, key]) => key);
    }

    test('is every token each copy table holds, in the panel\'s order', () => {
        const expected = [...keysOf('HOST_COPY'), ...keysOf('SERVICE_COPY'), ...keysOf('REASON_COPY')];
        assert.deepEqual(SYMPTOM_CODES.map((code) => code.token), expected);
    });

    test('reads the wrapped entry too, rather than stopping at the column', () => {
        // The negative case for the parse itself: a reader anchored to the
        // column would accept a table silently missing a row.
        assert.ok(keysOf('REASON_COPY').includes('scope-missing:pull-requests'));
    });

    test("carries the panel's own sentence for each token, not a paraphrase", () => {
        // The wording is the panel's because it is read out of the same maps the
        // panel renders from; FR-041 asks for the token to be exact and FR-038
        // asks for the panel's words.
        for (const code of SYMPTOM_CODES) {
            assert.ok(code.meaning.trim() !== '', `${code.token} carries its sentence`);
        }

        const hostCode = SYMPTOM_CODES.find((code) => code.token === 'NO_SERVICE');
        assert.equal(hostCode.meaning, 'The Mecha Turk service is not approved or has not started — approve the extension, then retry.');
    });

    test('attributes each token to the copy table that raises it', () => {
        const surfaces = new Set(SYMPTOM_CODES.map((code) => code.surface));
        assert.deepEqual([...surfaces].sort(), ['host', 'reason', 'service']);
    });

    test('has no two rows at the same token', () => {
        const tokens = SYMPTOM_CODES.map((code) => code.token);
        assert.equal(new Set(tokens).size, tokens.length);
    });

    test('carries the standalone sentences the panel renders on its own', () => {
        // A reader sees the sentence, not the code it stands for, so the
        // sentences are symptoms too (FR-041).
        for (const message of SYMPTOM_MESSAGES) {
            assert.ok(message.trim() !== '', 'a rendered message is non-empty');
            assert.ok(
                copySource.includes(`= '${message}'`),
                `the message is the panel's own string: ${JSON.stringify(message)}`,
            );
        }
    });

    test('states the project-not-registered refusal as the shape the panel builds', () => {
        // `src/session.ts` interpolates an identifier into this refusal and
        // imports the OpenChamber SDK, so it cannot be imported here — which is
        // why this assertion reads its text instead of the module.
        const sessionSource = source('src', 'session.ts');
        const shape = PANEL_PROBLEM_SHAPES[0];
        const prefix = shape.slice(0, shape.indexOf('<id>'));
        const suffix = shape.slice(shape.indexOf('>') + 1);
        assert.ok(sessionSource.includes(prefix), 'the panel builds this prefix');
        assert.ok(sessionSource.includes(suffix), 'the panel builds this suffix');
        assert.ok(shape.includes('<id>'), 'the shape keeps the identifier a placeholder');
    });

    test('refuses a token the panel\'s tables do not hold', () => {
        // The negative case: a token written into the table by hand.
        assert.throws(
            () => assertDeclares(
                'a hand-added token',
                [...SYMPTOM_CODES.map((code) => code.token), 'quota-exhausted'],
                [...keysOf('HOST_COPY'), ...keysOf('SERVICE_COPY'), ...keysOf('REASON_COPY')],
            ),
            /quota-exhausted/,
        );
    });

    test('refuses a token the panel removed', () => {
        const trimmed = SYMPTOM_CODES.map((code) => code.token).filter((token) => token !== 'rate-limited');
        assert.throws(
            () => assertDeclares('a stale symptom table', trimmed, keysOf('SERVICE_COPY')),
            /the site omits \["rate-limited"\]/,
        );
    });
});

// ---------------------------------------------------------------------------
// The one identity module — and the no-version-literal rule it exists for
// ---------------------------------------------------------------------------

describe('product', () => {
    const manifest = JSON.parse(source('package.json'));

    test('reads its identity out of the manifest rather than restating it', () => {
        assert.equal(PRODUCT_NAME, manifest.openchamber.contributes.panel.name);
        assert.equal(PRODUCT_ID, manifest.openchamber.contributes.panel.id);
        assert.equal(PRODUCT_VERSION, manifest.version);
        assert.equal(OPENCHAMBER_ENGINE_FLOOR, manifest.openchamber.engines.openchamber);
    });

    test('states the product\'s version the one way the product states it', () => {
        // AGENTS.md invariant 5: one source, read once. The About tab's own copy
        // is read from the service, so this is the site's single read.
        assert.equal(PRODUCT_VERSION, manifest.version);
    });

    test('carries no version-shaped literal anywhere in the site\'s sources', () => {
        // The gate T-011 states, as an assertion rather than a grep someone
        // remembers to run: a semver-shaped token in `site/src` would be a
        // second version that cannot move with the manifest (FR-053).
        const versionShaped = /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/;
        for (const file of ['data/product.ts', 'data/declarations.ts', 'data/site.ts', 'components/permissions.astro', 'components/settings-fields.astro', 'components/dispatch-states.astro', 'layout.astro']) {
            const text = readFileSync(join(SITE_SRC, file), 'utf8');
            const found = versionShaped.exec(text);
            assert.equal(found, null, `${file} carries no version literal${found === null ? '' : `: ${found[0]}`}`);
        }
    });

    test('gives the footer its two addresses from here, not from a second literal', () => {
        const footer = readFileSync(join(SITE_SRC, 'components', 'footer.astro'), 'utf8');
        assert.ok(footer.includes("from '../data/product.ts'"), 'the footer reads product.ts');
        assert.ok(!footer.includes('github.com'), 'the footer states no repository address of its own');
        assert.ok(LICENSE_URL.startsWith('https://'), 'the licence link is an absolute repository address');
        assert.ok(LICENSE_URL.endsWith('/blob/main/LICENSE'), 'the licence link points at the licence file');
    });
});