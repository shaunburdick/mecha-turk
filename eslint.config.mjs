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
        // Four overrides, down from twelve at 11.2.0. Eight of the nine that
        // went away are now the shipped defaults: `consistent-boolean-name`
        // with `checkFunctions: 'never'`, `numeric-separators-style` at
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
            // 44 findings, every one a module that re-exports a name its own
            // body reads — `utcStamp` in dispatches-rows, `inQueueChain` and
            // `parseStoredEvents` in poll/events, `readStateLine` in
            // settings-tab, `PollLoop` in poll/timer. `export … from` binds no
            // local, so applying it deletes the binding the body needs, and the
            // only shape left writes the module specifier twice. The 13
            // genuine passthroughs — a binding imported only to be re-exported —
            // were merged into `export … from` and the rule is silent on them
            // now that it ships `checkUsedVariables: false`.
            'unicorn/prefer-export-from': 'off',
            // Wants a module renamed to match its single export: `auth.ts` ->
            // `is-authorized.ts`, `audit-protect.ts` ->
            // `chain-and-decision-seqs.ts`. That is a module-identity change
            // across 11 product files and every import of them, which is
            // outside what a lint pass may do — and one of those two names is
            // worse than the file it would replace.
            'llm-core/filename-match-export': 'off',
        },
    },
];