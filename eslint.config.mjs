import shaunburdick from 'eslint-config-shaunburdick';

export default [
    // Generated build output: OpenChamber loads the committed guest bundles
    // (the panel IIFE and the service ESM) as-is, so they are produced by the
    // bundler, not authored by hand. Excluding a build artifact from linting
    // is not a rule suppression — the TypeScript sources that produce them are
    // linted in full.
    {
        ignores: [
            'extension/panel/main.js',
            'extension/service/main.js',
            'node_modules/**',
            'coverage/**',
        ],
    },
    ...shaunburdick.config.js,
    ...shaunburdick.config.ts,
];
