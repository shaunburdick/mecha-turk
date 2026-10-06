import { defineConfig } from 'astro/config';

// The published address is declared here and nowhere else. `base` is what makes
// Astro emit every page and asset under `/mecha-turk` rather than `/`; a site
// that omits it works perfectly in `astro dev` and 404s every internal link in
// production, which is why it is a line with a comment and not a default.
//
// `trailingSlash: 'always'` is load-bearing for the same reason. Astro's
// configuration reference is explicit that `import.meta.env.BASE_URL`'s
// trailing slash comes from `trailingSlash` and not from `base`, so this is
// also the setting that decides whether that value reads `/mecha-turk` or
// `/mecha-turk/`. `src/data/site.ts` normalises the difference so a change here
// cannot silently strip the base off every link; both mechanisms are kept.
//
// No deployment integration and no server runtime: the artefact is a static
// directory uploaded to GitHub Pages as-is. The installed Astro skill in
// `.agents/skills/astro/` recommends adding one (see plan.md D3); it would add a
// dependency and a failure mode for a site with nothing to run on a server.
// `inlineStylesheets: 'always'` is what keeps the layout's stylesheet inside each page.
//
// The default is `'auto'`, which inlines a stylesheet only while it is smaller than Vite's
// 4kB `assetsInlineLimit` and emits a `_astro/*.css` file above it. That threshold is a
// byte count, so the first stylesheet edit large enough to cross it would have changed the
// artefact's *shape* rather than its appearance: `assert-build.mjs` reads the palette out of
// the built pages' inlined `<style>` blocks, and the build-output contract
// (`specs/007-homepage-docs/contracts/site-build-output.md` §2–§3, under FR-010) names exactly
// five HTML files with no `_astro/` directory. A stylesheet that silently became a file would
// fail both for reasons that have nothing to do with design, so the behaviour the contract
// depends on is declared rather than inherited from a default.
export default defineConfig({
    site: 'https://shaunburdick.github.io',
    base: '/mecha-turk',
    trailingSlash: 'always',
    output: 'static',
    build: {
        format: 'directory',
        inlineStylesheets: 'always',
    },
});
