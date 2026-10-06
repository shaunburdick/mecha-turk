# Contract: the site's build output

**Feature**: `specs/007-homepage-docs` · **Date**: 2026-10-05 · **Binds**: `site/dist/` — the artefact `actions/upload-pages-artifact` serves

GitHub Pages serves whatever the deploy workflow uploads. For a site with no server component, that means **the output directory's shape *is* the published site**, so its shape is a contract rather than an implementation detail. This file states it so a reviewer has a baseline to compare a build against, and so `site/scripts/assert-build.mjs` (task T-008) is checking against a written shape rather than against whatever the last build happened to produce.

**This is derived, not predicted.** Every claim below was observed on a real `astro@7.3.5` build of the chosen configuration (`site` + `base` + `trailingSlash: 'always'` + `output: 'static'` + `build.format: 'directory'`, no adapter, no integration). The values are placeholders where the real content lands; the *shape* is what is contracted.

---

## 1. Configuration this output is the consequence of

| Setting | Value | Why it is load-bearing |
| --- | --- | --- |
| `site` | `https://shaunburdick.github.io` | Canonical URLs. The repository is user-owned, not the `shaunburdick.github.io` special repository. |
| `base` | `/mecha-turk` | **The single largest correctness risk in this feature.** Without it the site works perfectly in `astro dev` and 404s every asset in production — a failure no local preview can catch. Declared in exactly one file (FR-005, AC-002). |
| `trailingSlash` | `'always'` | **Not cosmetic.** Verified: with it unset, `import.meta.env.BASE_URL` is `/mecha-turk` with no trailing slash, and a page path joined naively yields `/install/` — the base silently dropped. `'always'` makes `BASE_URL` `/mecha-turk/` and the join correct. |
| `output` | `'static'` | No server entry point (NFR-001). |
| `build.format` | `'directory'` (default) | `about.md` builds to `dist/about/index.html`, which is what Pages serves at `/mecha-turk/about/`. |
| adapter | **none** | GitHub Pages serves static files. An adapter would add a dependency and a failure mode to a site with no server component. |
| integrations | **none** | Same, plus FR-012's prohibition on a content-collection framework, i18n, or a search index. |

## 2. The shape

```text
site/dist/
├── index.html            # the landing page          → /mecha-turk/
├── install/index.html    # install                   → /mecha-turk/install/
├── configure/index.html  # configure                 → /mecha-turk/configure/
├── use/index.html        # use                       → /mecha-turk/use/
└── debug/index.html      # debug                     → /mecha-turk/debug/
```

**Exactly five HTML files and no others.** No `404.html` (FR-001 says five pages; a sixth file in the output is a sixth page to a reader crawling the artefact, and Pages serves its own 404 for a missing path regardless). No `_astro/` directory — see §3. No `sitemap`, no `robots.txt`, no `manifest.webmanifest`.

**Every page carries**, per FR-004, NFR-004, and FR-076: exactly one top-level `<h1>`; a `<nav>` with an accessible name; links to the landing page and all four documentation pages; a footer carrying a link to the `LICENSE` file in the repository. All of it comes from one layout, so it is true by construction rather than by review.

## 3. Assets

**Zero.** This is the contract's most checkable clause, and it is checked three ways (AC-004, NFR-002, NFR-003):

| Property | Requirement | Enforced by |
| --- | --- | --- |
| No `.js` file anywhere in `dist/` | NFR-002 — the site ships no client-side JavaScript | the assertion script; verified: with no client directive and no integration, Astro emits no `<script>` tag and no script bundle |
| No image file anywhere in `dist/` | FR-009 — no screenshots, no image of any kind | the assertion script; `public/` is not created, and there is deliberately no favicon (plan D8) |
| No external stylesheet, font, or script reference | FR-010 — a page view makes requests to the site's own origin only | the assertion script scans every emitted file for any off-origin URL; verified: no remote font, no CDN, no analytics |
| No `_astro/` asset directory | follows from the three above | the assertion script |

Verified on a real build of the chosen configuration: a `<style>` block in a component is **inlined** into the page, and a Markdown code block is styled by **Shiki at build time** with an inline `style` attribute — neither produces a stylesheet file, a webfont request, or a script.

## 4. Internal links

**Every internal `href` and `src` in the output begins `/mecha-turk/`.** That is AC-002's published criterion and the one property a source-level review cannot establish. Two shapes of the same bug are both caught:

| Bug | What the built output shows |
| --- | --- |
| A hand-written root-absolute path (`href="/install/"`) | resolves to the domain root; 404 in production, works in `astro dev` |
| A hand-joined path with no leading-slash strip (`` `${BASE_URL}${path.slice(1)}` ``) | works under `trailingSlash: 'always'`, and emits `/mecha-turkinstall/` under any other setting |

**The one mechanism that prevents both**: every internal link on every page is built by the site's single base-path helper in `site/src/data/site.ts`, which strips leading slashes and joins against `import.meta.env.BASE_URL`. A page never writes an `href`.

**Off-site links are the exception and are expected**: the repository URL and the `LICENSE` file URL, both `https://github.com/shaunburdick/…`. They are `<a href>` values — a link a reader may click, not a resource the page fetches — so they do not violate FR-010, which governs **requests a page view makes**. The assertion script therefore checks *resource* references (`src`, `<link>`, fonts) for off-origin URLs, and does not flag ordinary hyperlinks.

## 5. What the build job asserts

`site/scripts/assert-build.mjs` runs as the last step of `npm run build`, so the site's only gate checks the artefact it just produced:

1. exactly five HTML files, and they are the five named above
2. no `.js` file and no image file anywhere under `dist/`
3. no off-origin URL in any resource reference, in any emitted file
4. every internal `href`/`src` begins `/mecha-turk/`
5. every page contains a link to all five targets
6. every page has exactly one `<h1>`, a named `<nav>`, and a footer link to the license file
7. no page contains a placeholder, a "coming soon", or a `TODO`

Each assertion must be shown to **fail** on a deliberate violation before it is trusted — a check that has never been seen red is not a check (AC-001 – AC-005, AC-006, and the negative half of AC-022).

## 6. Not in this contract, and why

- **No schema or entity model.** Five static documents have no shape worth modelling; the content model is five rows in [plan.md](../plan.md) §Content ownership, and the tables on the pages are *generated from declarations the product already owns* rather than declared here. This is why there is no `data-model.md` — see [plan.md](../plan.md) §Why there is no data model.
- **No API, no endpoint, no wire shape.** The site is a static publish with nothing to call (FR-003, FR-012).
- **No performance budget.** A five-page static site has no measurable performance risk, and inventing a threshold nobody can fail would be a number without a decision behind it.
