import shaunburdick from 'eslint-config-shaunburdick';

export default [
    // Generated build output: OpenChamber loads the committed guest bundles as-is, so they are
    // produced by the bundler, not authored by hand — not a rule suppression, since the `.ts`
    // sources that produce them are linted in full.
    {
        ignores: [
            'panel/main.js',
            'service/main.js',
            'node_modules/**',
            'coverage/**',
            // The installed agent-skill directory: a third-party skill file added by
            // `npx skills add`, not code this repository authors. `eslint .` descends into
            // dot-directories, so it is excluded by config rather than escaping only because its
            // current content happens to be markdown.
            '.agents/**',
            // `site/` is a self-contained npm subproject with its own manifest, lockfile and Node
            // floor (FR-007, FR-008); the root manifest must stay the OpenChamber installable one
            // and cannot list it as a workspace, so its own gate — `astro check` plus its tests —
            // is the only one that reaches it. The exclusion is required, not tidiness:
            // `eslint .` reaches `site/astro.config.ts` under this config's TypeScript block and
            // aborts the whole run with `EslintPluginImportResolveError`, a crash of the
            // repository's own gate rather than a finding. It is a scope exclusion of a
            // separately-owned subproject — the same shape as the two bundles above — with no rule
            // turned off and nothing in `site/` exempted from a check that applies (FR-070, FR-072).
            'site/**',
        ],
    },
    ...shaunburdick.config.js,
    ...shaunburdick.config.ts,
    {
        // Four overrides, down from twelve at 11.2.0, each a rule the whole codebase answers
        // differently everywhere it applies. The nine that went away are not lost: 11.3.0 made
        // eight of them the shipped defaults, and AGENTS.md invariant 7 says where the rest went.
        rules: {
            // The shared cap is two inline disables per file; invariant 7 (owner-ruled 2026-10-04)
            // allows a described line-scoped disable anywhere and only bars a *file-wide* one below
            // five sites in that file, and the repo's policy is the newer of the two. Five is the
            // line — a file that needs six is the signal.
            'shaunburdick/max-inline-disables': ['warn', { max: 5 }],
            // It asks for an explicit length check before reading a first or last element;
            // `noUncheckedIndexedAccess` already types an unguarded read as `T | undefined`, and
            // the codebase narrows the value rather than the length. Of 257 findings, 244 are
            // `rows[0]?.field` in assertions, which are null-safe by construction.
            'llm-core/no-unsafe-array-access': 'off',
            // All 58 catch bindings are named `cause` (or `retryCause`), so the premise — that
            // LLMs mix `e`, `err`, `error`, `ex` — does not hold here, and `cause` is a domain
            // word: a detail member on ~54 audit row literals and the stem of `causeReport`.
            // Its sibling `unicorn/catch-error-name` demands the opposite name, and two rules
            // insisting on opposite spellings is what makes the local choice deliberate.
            'llm-core/consistent-catch-param-name': 'off',
            'unicorn/catch-error-name': 'off',
            // 46 findings, 13 of them in functions that must not become asynchronous: the chain
            // joiners and the seed-and-memoise openers each assign to the chain they are joining
            // before returning, so awaiting would insert a suspension point and break the
            // invariant the surrounding docblocks give as the reason each helper exists.
            // `prefer-then-catch` compounds it: one task on both arms keeps a rejection travelling.
            'unicorn/prefer-await': 'off',
            // The plugin's per-module opinion for `node:path` is `default`; this repo is the other
            // way — 69 files import the members they use, so `named` narrows rather than widens
            // that default (and bans the namespace form). Conforming instead means ~536 call sites
            // rewritten to say less, in tests whose subject is not paths.
            'unicorn/import-style': ['error', { styles: { path: { default: false, named: true } } }],
            // Mutually unsatisfiable, and both are on as errors: `prefer-iterator-to-array` asks
            // for `Array.from(map.keys())` and `prefer-spread` asks for the spread — converting all
            // twelve sites moved 12 findings to 13 with nothing else changed, so no line satisfies
            // both. The repo answers it the same way in every other spread of an iterator
            // (`[...]`), so this one goes and `prefer-spread` stays as the rule that owns the shape.
            'unicorn/prefer-iterator-to-array': 'off',
            // The inherited `default` selector is `camelCase`, and it was reaching object literal
            // keys — which here are protocol tokens: `HOME`, `PATH`, the lowercase-dashed HTTP
            // header names `tools/visual/serve.js` sends, and every DTO member the service and panel
            // agree on, whose spelling is the wire's decision. No predefined format matches
            // `'cache-control'` or `'GET /v1/status'` at all. Naming the rule replaces its option
            // list wholesale, so the inherited selectors are restated: variables, parameters, types
            // and enum members keep the naming rules they had, keys get no constraint.
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow', trailingUnderscore: 'allow' },
                {
                    selector: 'variable',
                    format: ['camelCase', 'UPPER_CASE'],
                    leadingUnderscore: 'allow',
                    trailingUnderscore: 'allow',
                },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'enumMember', format: ['PascalCase'] },
                {
                    selector: 'objectLiteralProperty',
                    format: [],
                    leadingUnderscore: 'allow',
                    trailingUnderscore: 'allow',
                },
            ],
        },
    },
];
