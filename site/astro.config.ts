import { defineConfig } from 'astro/config';

// The published address is declared here and nowhere else: `base` makes Astro emit every page and
// asset under `/mecha-turk`, and omitting it works in `astro dev` while 404ing every internal
// link in production. `trailingSlash: 'always'` is load-bearing the same way — it, not `base`,
// decides what `import.meta.env.BASE_URL` reads — and `src/data/site.ts` normalises the
// difference so a change here cannot strip the base off every link; both mechanisms are kept.
//
// No deployment integration and no server runtime: the artefact is a static directory for GitHub
// Pages as-is (the installed Astro skill recommends one, plan.md D3; it would add a dependency
// and a failure mode for a site with nothing to run on a server).
//
// `inlineStylesheets: 'always'` rather than `'auto'` (which inlines only under Vite's 4kB
// `assetsInlineLimit`) keeps the stylesheet inside each page: above that byte threshold the
// artefact would gain a `_astro/*.css` file, failing `assert-build.mjs`'s palette read and the
// five-file contract (`specs/007-homepage-docs/contracts/site-build-output.md` §2–§3, FR-010) for
// reasons unrelated to design. Behaviour a contract depends on is declared, not inherited.
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
