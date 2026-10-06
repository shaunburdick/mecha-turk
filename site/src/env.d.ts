/**
 * The one type reference the site's sources need that nothing else in the tree
 * provides.
 *
 * `import.meta.env` is declared by `astro/client`, which reaches a project two
 * ways: the `/// <reference types="astro/client" />` line Astro writes into the
 * generated `.astro/types.d.ts`, and this file. `tsconfig.json` includes that
 * generated file, so with `.astro/` present either line does — but `.astro/` is
 * generated *and* git-ignored, so on a fresh clone a bare `tsc --noEmit` has
 * nothing to read and reports `Property 'env' does not exist on type
 * 'ImportMeta'` at the one line that uses it (`withBase` in `src/data/site.ts`).
 *
 * Astro's TypeScript guide offers `/// <reference path="../.astro/types.d.ts" />`
 * here instead, and that is worse in exactly this case: it resolves into the
 * git-ignored directory, so a clone without a build reports `TS6053 File … not
 * found` *and* still leaves `import.meta.env` untyped. This line resolves
 * through `node_modules`, which `npm ci` restores from the committed lockfile,
 * so it holds whether or not anything has been built.
 */
/// <reference types="astro/client" />
