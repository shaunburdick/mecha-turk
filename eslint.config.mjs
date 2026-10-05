import shaunburdick from 'eslint-config-shaunburdick';

export default [
    // Generated build output: OpenChamber loads the committed guest bundles
    // (the panel IIFE and the service ESM) as-is, so they are produced by the
    // bundler, not authored by hand. Excluding a build artifact from linting
    // is not a rule suppression — the TypeScript sources that produce them are
    // linted in full.
    {
        ignores: [
            'panel/main.js',
            'service/main.js',
            'node_modules/**',
            'coverage/**',
        ],
    },
    ...shaunburdick.config.js,
    ...shaunburdick.config.ts,
    {
        // Four overrides, down from twelve at 11.2.0, and each is a rule the whole
        // codebase answers differently everywhere it applies. The nine that
        // went away — eight of them because 11.3.0 made them the shipped
        // defaults, and nine because a rule with fewer than twenty sites
        // belongs on the line it excuses — are not lost: AGENTS.md invariant 7
        // says where they went. `consistent-boolean-name` now ships with
        // `checkFunctions: 'never'`, `numeric-separators-style` at
        // `minimumDigits: 4`, `no-top-level-assignment-in-function` skipped in
        // test files, and `no-unknown-parameters` / `no-unsafe-dictionary-type`
        // / `no-redundant-logic` disabled outright. See the changelog in
        // eslint/CHANGELOG.md at 11.3.0 for each.
        rules: {
            // It asks for an explicit length check before reading a first or
            // last element. This repo has `noUncheckedIndexedAccess` on, so an
            // unguarded read is already `T | undefined`, and the codebase
            // narrows the *value* rather than the length, which is exact and
            // has no window between the two. Of 257 findings: 244 are
            // `rows[0]?.field` in assertions (null-safe by construction, and an
            // empty array *should* fail loudly), and the rest null-check the
            // same binding or are guarded further up.
            'llm-core/no-unsafe-array-access': 'off',
            // All 58 catch bindings in this repo are named `cause`, or
            // `retryCause` where two are live in one function. That is the whole
            // of what this rule is for — it exists because LLMs mix `e`, `err`,
            // `error`, and `ex` within one codebase — and there is none of that
            // here. `cause` is also a domain word, not a convention: it is a
            // member of the discriminated union in dispatch-actor-gate.ts
            // (`UnreadablePolicyCause`), a detail member on ~54 audit row
            // literals, and the stem of `causeReport` / `causeClearedSource`.
            // Its sibling `unicorn/catch-error-name` demands the opposite name
            // and is disabled for the same reason; two rules insisting on
            // opposite spellings is what makes the local choice deliberate
            // rather than accidental.
            'llm-core/consistent-catch-param-name': 'off',
            'unicorn/catch-error-name': 'off',
            // 46 findings, and 13 of them sit in a function that must *not* become
            // async. These are the chain-join and memoisation helpers —
            // inWriteChain in audit.ts and scan.ts, inQueueChain and
            // whenQueueIdle in runs-document.ts, auditCacheFor, serializeAudit,
            // serializeScan, startAdoption, startReconciliation, startBootSweep
            // — and each one either assigns to the chain it is joining before
            // returning, or memoises its promise synchronously so that
            // concurrent first callers share one seed read. `await` inserts a
            // suspension point before that assignment, so complying would break
            // the invariant the surrounding docblocks state as the reason the
            // function exists. prefer-then-catch compounds it: the two-armed
            // `.then(task, task)` is deliberate, because the chain must carry a
            // previous rejection into the next slot without wedging.
            'unicorn/prefer-await': 'off',
            // The plugin ships a per-module opinion and for `node:path` it is
            // `default`: `import path from 'node:path'`. This repo is the other
            // way — 69 files import the members they use, `resolve('a', 'b')`
            // rather than `path.resolve('a', 'b')`, and only the store and the
            // service entrypoint used the default form. So this *narrows* the
            // plugin's default rather than widening it: `named` only, which also
            // bans the namespace and default spellings the plugin would have
            // let through. Conforming the 69 files instead would mean ~536 call
            // sites rewritten to say less, in tests whose subject is not paths.
            'unicorn/import-style': ['error', { styles: { path: { default: false, named: true } } }],
            // These two are mutually unsatisfiable and both are on as errors.
            // `prefer-iterator-to-array` reports `[...map.keys()]` and asks for
            // `Array.from(map.keys())`; `prefer-spread` reports
            // `Array.from(map.keys())` and asks for the spread. I converted all
            // twelve sites to `Array.from` to check, and the count went from 12
            // findings on one rule to 13 on the other with nothing else changed
            // — so there is no line that satisfies both, and the choice has to
            // be made in config. The repo answers it the same way in all twelve
            // places and in every other spread of an iterator: `[...]`. This one
            // goes, and `prefer-spread` stays as the rule that owns the shape.
            'unicorn/prefer-iterator-to-array': 'off',
            // The inherited `default` selector is `camelCase`, and it was reaching object
            // literal keys — which in this repo are not names. They are protocol
            // tokens: `HOME`, `PATH` and `OPENCHAMBER_SERVICE_PORT` in the test
            // harness's environment maps, the lowercase-dashed HTTP header names
            // `tools/visual/serve.js` sends, and every DTO member the service and
            // panel agree on, whose spelling is the wire's decision rather than
            // this linter's. None of the rule's six predefined formats matches
            // `'cache-control'` or `'GET /v1/status'` at all, so there was no way
            // to express this except by turning the selector off for keys.
            //
            // This restates the inherited selectors because naming the rule here
            // replaces its option list wholesale, and gives
            // `objectLiteralProperty` an empty format list — no constraint on
            // keys, while variables, parameters, types and enum members keep the
            // naming rules they had.
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