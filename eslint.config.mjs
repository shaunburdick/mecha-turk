import shaunburdick from 'eslint-config-shaunburdick';

export default [
    // Generated build output: OpenChamber loads the committed IIFE as-is, so it
    // is produced by the bundler, not authored by hand. Excluding a build
    // artifact from linting is not a rule suppression — the TypeScript source
    // that produces it is linted in full.
    { ignores: ['extension/panel/main.js', 'node_modules/**', 'coverage/**'] },
    ...shaunburdick.config.js,
    ...shaunburdick.config.ts,
];
