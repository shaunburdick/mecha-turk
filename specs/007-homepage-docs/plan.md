# Implementation Plan: Documentation Site and MIT Licence

**Branch**: `issues-11-homepage-docs` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md) (v1.1.0, **approved** with 002 v1.13.0 and 005 v1.16.0, one package)

**Input**: Feature specification `specs/007-homepage-docs/spec.md` (v1.1.0, 77 FRs, 9 NFRs, 10 SCs, 31 ACs); constitution `.specify/memory/constitution.md` **v1.3.0**; predecessor amendments [`002-agent-event-extension/spec.md`](../002-agent-event-extension/spec.md) → v1.13.0 and [`005-panel-ia/spec.md`](../005-panel-ia/spec.md) → v1.16.0; [research.md](./research.md) (phases 1–3, extended here by §6); the shipped tree, read for the trace targets the documentation must mirror.

**Note**: No application code is written in phases 4–5. Every decision below is decided and justified — there are no open option pairs, and where the specification settled a product question this plan records the consequence rather than reopening it.

**Product source**: GitHub issue [#11](https://github.com/shaunburdick/mecha-turk/issues/11).

---

## Summary

Five static pages — one landing page and **install**, **configure**, **use**, **debug** — built by **Astro 7.3.5 pinned exactly**, published to `https://shaunburdick.github.io/mecha-turk/` by a GitHub Actions workflow, carrying the operator prose that currently sits in a 384-line `README.md`. The README reduces to identity, a summary, a documentation link, a licence pointer, and a contributor pointer. A documentation link appears in the panel's About tab. A full MIT licence file lands at the repository root.

Four things make this more than a documentation move, and the plan is organised around them:

1. **The site cannot live in the root manifest.** Astro 7 needs Node `>=22.12.0`; the root `package.json` is simultaneously the npm dev package and the OpenChamber installable manifest and advertises `>=20.19.0`, and `workspaces` is banned (`AGENTS.md` invariant 2). The site is therefore a **self-contained subproject** with its own manifest, its own committed lockfile, and its own declared floor. The root manifest gains **nothing** — no dependency, no script, no version bump, no `workspaces` key, and no change to its `engines` (FR-007, FR-008).
2. **That makes the site's own pull-request job its only gate.** Root `npm run verify` cannot reach it, so that job runs `astro check` *and* `astro build`, and its failure fails the pull request (FR-065, FR-069). This is the honest price of decision 1, stated in `spec.md` → `## Clarifications` Q4 and not softened here.
3. **The base path is the largest correctness risk in the feature.** A site that forgets `base` works perfectly in `astro dev` and 404s every asset in production. It is an acceptance criterion, not a configuration line (FR-005, AC-002).
4. **The content is a trace of shipped code, not prose from memory.** Four enumerations — the requested capabilities, the eleven numeric configuration fields with their bounds, the dispatch-state vocabulary, and the troubleshooting tokens — are checked against the declarations the shipped code already owns (FR-047, FR-048, AC-008 – AC-011).

---

## Technical Context

| Dimension | Value |
| --- | --- |
| Site directory | `site/` — a self-contained subproject with **no** npm workspace (research.md §4; constraint 1 of this plan) |
| Build tool | **Astro `7.3.5`, pinned exactly** — no `^`, no `~`, no prerelease (FR-006, by analogy to `AGENTS.md` invariant 6) |
| Site Node floor | `>=22.12.0` in `site/package.json` `engines` — higher than the root's `>=20.19.0`, and **the root floor does not move** (FR-008; raising it is issue #17, out of scope) |
| Site TypeScript | `typescript` `6.0.3` + `@astrojs/check` `0.9.10`, both exact devDependencies of the **site**; `astro check` refuses to run without them |
| Site tsconfig | `extends: "astro/tsconfigs/strictest"`, `include: [".astro/types.d.ts", "**/*"]`, `exclude: ["dist"]` — the shape Astro's own TypeScript guide prescribes |
| Output | `output: 'static'`, **no adapter** (§Architecture, D3), `trailingSlash: 'always'`, `build.format: 'directory'` (the default) |
| Published address | `https://shaunburdick.github.io/mecha-turk/` — `site: 'https://shaunburdick.github.io'` + `base: '/mecha-turk'`, declared in **exactly one file** (FR-005) |
| Assets | **Zero** images, **zero** client-side JavaScript, **zero** third-party requests (FR-009, FR-010, NFR-002, NFR-003) |
| Site CI | `.github/workflows/site.yml` — two jobs on one workflow: `build` (every PR **and** push to `main`) and `deploy` (push to `main` only) |
| Site build job | `npm ci` in `site/`, then `astro check`, then `astro build` (FR-068, FR-069) |
| Publish actions | `actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`, every one pinned to a commit SHA (FR-067) |
| Publish permissions | `pages: write` + `id-token: write` on the deploy job; the build job inherits `contents: read` (FR-067) |
| Root toolchain | **Untouched in meaning.** `package.json` byte-identical; `verify` runs the same four steps in the same order; the site directory is added to `eslint.config.mjs` `ignores` and to `.gitignore` only (FR-007, FR-070, FR-071) |
| Panel change | One new text handle in `src/about-tab.ts` + two comment updates + one test (FR-059 – FR-064) |
| Licence | MIT, full text, `Copyright (c) 2026 Shaun Burdick` verbatim, at the repository root; the site's footer links it (FR-074 – FR-076) |

---

## Constitution alignment (v1.3.0)

> **This plan aligns with every principle, every §Security and Operational Standards item, and every §Development Quality Gate of constitution v1.3.0. No principle is weakened, none is strained, and there are no exceptions to record and therefore no complexity-tracking rows.** The feature adds a documentation site and a licence file to the repository. It adds no polling, no provider adapter, no policy gate, no durable state, no audit row, no host capability, and no runtime requirement of any kind. **No constitutional amendment is made** — `.specify/memory/constitution.md` stays at v1.3.0, for the reasons `spec.md` → `## Clarifications` Q4 records.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Untouched. The site changes no provider contract, no polling behaviour, and no wire surface. The `extension-spike-1` evidence schema and the NDJSON event contract are read to document them and are not touched (invariant 10). |
| **II. Safe autonomy by default** | Untouched and mirrored. The landing page states all four honest boundaries (FR-014) and the debug page states that an unconfirmed dispatch is **never** re-dispatched automatically and that only an explicit operator decision resolves it (FR-039). The product's fail-closed posture becomes documentation rather than being relaxed into it: no page documents a path that guesses or partially applies (FR-041, FR-045). |
| **III. Durable and idempotent work** | Untouched. The site creates no state, writes no store file, and duplicates no event. The two storage locations and which of them survives an uninstall are **published** (FR-016, FR-043), which is this principle's honest counterpart on a documentation surface. |
| **IV. Human-visible auditability** | **Served and strengthened.** The debug page names which trail answers which question, what a correlation identifier is, and that no credential appears in either (FR-044); the identifier-mapping table gives an operator who reads a wire- or log-level name the surface that produced it (FR-051, closing 005 FR-029's undischarged gap). |
| **V. Minimal, self-hosted deployment** | **Honoured, not extended.** A static documentation site is not product infrastructure: it requires nothing of the operator, adds no process, no container, no service, no capability, and no proprietary control plane, and it removes nothing from the product's deployment. The site additionally makes **zero** outbound requests of its own (FR-010), which is stricter than the principle requires. |
| **VI. Specification and verification before implementation** | This plan, [research.md](./research.md) (extended, §6), [contracts/](./contracts/), and [tasks.md](./tasks.md) land before any code. The specification is approved; both predecessor amendments are approved in the same package. The verification the plan relies on is enumerated in §Verification, and every acceptance criterion has a named check. |
| **VII. Thin orchestration boundary** | Untouched and honoured. The About link opens through `host.openUrl` — the path the panel already uses for a dispatch's source link — so the panel gains no capability and no documentation fetch (FR-059). The site is not part of the orchestration boundary at all. |
| **§Security Std — outbound HTTPS** | Its subject is the **product's runtime**, where the local service is the only thing that makes an outbound request. A static documentation page is not that runtime: it holds no token, opens no GitHub connection, and exists only when a reader's browser fetches it. The bullet is therefore not weakened. This plan nonetheless adopts a **stricter** posture the constitution permits a specification to add: a reader's browser makes **zero** requests to any origin but the site's own (FR-010, NFR-003). Recorded as research.md **R-8** so a reviewer can check the reading rather than inherit it. |
| **§Security Std — unattended dependency** | **Discharged by the artefact, not by this document**: the landing page states that nothing runs while OpenChamber is off and names the Status tab as where the honest state is read (FR-014, FR-019, AC-030), and the debug page says it again (FR-042). |
| **§Security Std — durable state** | **Discharged by the artefact**: both storage locations, their contents, their permissions, and which survive an uninstall are published on the landing page and the debug page (FR-016, FR-043, AC-031). No page claims audit history lives in storage the operator cannot back up. |
| **§Development Quality Gates** | Strict type checking and linting are mandatory and remain so: the site gets `astro check` under `strictest` in its own gate, and the root gate keeps every rule it has. **No suppression is added anywhere** — no `@ts-ignore`, no `@ts-expect-error`, no `# type: ignore`, and no `eslint-disable` to accommodate the site (FR-072, invariant 7). Compatibility-sensitive tooling is pinned exactly (FR-006). No capability is reimplemented through a private API. Tests cover the checks below; the operator-gated live check (the published address returning 200) is a task, not an aspiration. |

### `AGENTS.md` invariants — how this plan touches each of the ten

1. **Committed bundles ship.** The About-tab change is a `src/` change, so it ends with `npm run build` and the rebuilt `panel/main.js` committed in the same commit (FR-062, AC-028). `verify.yml`'s `git diff --exit-code` step is what enforces it and is not modified. `tests/bundle.test.ts`'s secret scan stays green — a URL constant cannot trip `findSecretLeak`, and the site's build output is scanned by the same patterns (FR-054, NFR-005).
2. **One document, two roles.** The root `package.json` is **byte-identical** before and after: no dependency, no devDependency, no `workspaces`, no script, and `version` stays `0.0.1` (FR-007, AC-017). A version bump is a product-owner release decision and this is not a release.
3. **Capabilities stay `sessions` and `prompt`.** Untouched. The install page's permission table is **derived from the manifest declaration** rather than retyped, so it cannot name a capability the manifest does not request (FR-022, AC-008), and the README's stale four-capability claim is corrected (FR-077).
4. **Kebab-case identity.** Untouched. The site directory name is `site/`, which is not a manifest id, not a `host.storage` key, and not a panel id. Nothing is renamed; no `mecha-turk:` key is added, read, or renamed.
5. **`SERVICE_VERSION` mirrors `package.json`.** Untouched. No page authors a version literal; the only version any page renders is read from the root manifest at build time (FR-053) — the same single-source rule, pointed at the manifest instead of the service, because the site is a build-time artefact and the service is a runtime one.
6. **SDK pinned exactly.** Untouched. Astro is pinned exactly for the same reason (FR-006).
7. **Scoped suppressions, zero `any`.** No suppression anywhere (FR-072). The site directory is **excluded from the root lint scope** — that is an exclusion of a separately-owned subproject, in the same shape as the two committed bundles already in `ignores`, not a rule suppression (FR-070).
8. **Fail closed.** No page documents a path that guesses or partially applies. Every documented failure names its cause and its remediation (FR-045). The site's own `tsconfig` is `strictest` and the root's `noUncheckedIndexedAccess` is untouched.
9. **Secrets never leave the service store.** No page carries a credential, a token, a real account identifier, a correlation identifier, or a path outside the documented data directory, and **the build output is scanned by the same patterns the repository applies to its committed bundles** (FR-054, NFR-005).
10. **`extension-spike-1` is a wire contract.** Untouched. The site documents the wire surface as it is and mirrors the identifier mapping; no schema version changes and no shape changes (FR-048, FR-051).

---

## Project structure (decided)

```text
site/                                     # self-contained subproject; the root manifest gains nothing
├── package.json                          # own manifest: astro + @astrojs/check + typescript, all exact;
│                                         #   own engines.node ">=22.12.0"; NO openchamber block, NO version
│                                         #   mirroring of the product, NO workspace link
├── package-lock.json                     # committed, and the ONLY tree `npm ci` installs for the site (FR-068)
├── astro.config.ts                       # site, base, trailingSlash, output — the ONE declaration of the
│                                         #   published address path (FR-005, D1)
├── tsconfig.json                         # extends astro/tsconfigs/strictest; excludes dist
├── .gitignore                            # site-local: dist/ and .astro/ (the root .gitignore also covers them)
├── public/                               # NOT created. Zero images, zero favicon-from-the-internet;
│                                         #   a self-hosted .ico only if AC-005's "no image file" allows it (D8)
├── src/
│   ├── env.d.ts                          # `/// <reference types="astro/client" />` — Astro's own convention
│   ├── layout.astro                      # the page shell: <html lang>, one <h1> slot, the <nav> landmark,
│   │                                     #   the footer. Carries NO content of its own (D6)
│   ├── components/
│   │   ├── nav.astro                     # the five links, built through the base-path helper (D2)
│   │   └── footer.astro                  # repository link + MIT licence link, every page (FR-076)
│   ├── data/
│   │   ├── site.ts                       # the single base-path helper and the page list — the only file
│   │   │                                 #   that knows a page path, so a rename is one edit (D2)
│   │   ├── product.ts                    # the product identity + repository URL, read from the root
│   │   │                                 #   manifest at build time; NO version literal (FR-053)
│   │   └── declarations.ts               # the four trace-derived tables: capabilities, configuration fields
│   │                                     #   with bounds and take-effect, dispatch states, symptom tokens
│   └── pages/
│       ├── index.astro                   # the landing page  → /mecha-turk/
│       ├── install.md                    # install          → /mecha-turk/install/
│       ├── configure.md                  # configure        → /mecha-turk/configure/
│       ├── use.md                        # use              → /mecha-turk/use/
│       └── debug.md                      # debug            → /mecha-turk/debug/
│                                         # five pages exactly; no 404 page, no FAQ, no search (FR-001, FR-009)

.github/workflows/
├── verify.yml                            # UNCHANGED. The read-only gate, contents: read, 15-minute timeout
└── site.yml                              # NEW. build job (every PR + push to main) and deploy job (push to main)

src/about-tab.ts                          # + one text handle: the documentation link (FR-059)
tests/about-tab.test.ts                   # + documentation-link assertions; 2 comments corrected (FR-063, FR-064)
tests/docs-sync.test.ts                   # + the site as a third scanned document; 3 site claims replace
│                                         #   the README's (002 v1.13.0 FR-042/AC-022)
tests/vocabulary.test.ts                  # + the site in the L1 scanned set (005 v1.16.0 SC-107/AC-140)
tests/manifest.test.ts                    # + the About link and the site's licence link are ordinary https
│                                         #   URLs with no capability implication
tests/bundle.test.ts                      # UNCHANGED in code; + `site/dist/**` added to the same scan (FR-054)
tests/prose-budget.test.ts                # NEW. The NFR-006 before/after measurement (FR-049, AC-016)

README.md                                 # reduced to summary + documentation link + licence + contributor pointer
specs/002-agent-event-extension/quickstart.md  # §3–§6, §8 reduce to pointers; §1, §2, §7 stay (FR-049)
LICENSE                                   # NEW. Full MIT text, `Copyright (c) 2026 Shaun Burdick` (FR-074)
AGENTS.md                                 # layout block: `site/` added, README's line corrected (FR-057 context)
eslint.config.mjs                         # + 'site/**' and '.agents/**' in `ignores` — no rule change (FR-070)
.gitignore                                # + dist/ and .astro/ (unanchored, matching existing style) (FR-071)
skills-lock.json                          # committed — the Astro skill's provenance (see §Artifacts)
.agents/skills/astro/SKILL.md             # committed — see the correction note below
```

### Why this layout

- **`site/` for the directory** — it satisfies all five constraints research.md §4 lists (it is the `path` the build job installs and builds; it appears in `eslint.config.mjs` `ignores`; `dist/` and `.astro/` under it are covered by the unanchored ignore patterns; no name in the root `tsconfig.json` `include` matches it, so the root type-checker cannot reach it; and it does not begin with `.`). It is also the shortest unambiguous name and cannot be confused with `specs/`. **`.agents/` is a different case and is handled separately below.**
- **Markdown for the four documentation pages, `.astro` for the shell and the landing page.** The four documentation pages are prose with tables, and Markdown is what they already are. The landing page is `.astro` because it is a composition — a definition-style sequence of statements plus two tables — rather than a document. The shell is `.astro` because the navigation landmark, the heading discipline, and the footer are the furniture FR-004, NFR-004, and FR-076 bind, and putting them in one layout makes them true by construction instead of by review. Verified: a `.md` page with `layout:` frontmatter builds to `<page>/index.html` under `build.format: 'directory'` and carries exactly one `<h1>` from the layout.
- **`src/data/` for the declarations.** FR-048 requires four enumerations to be *derived* from the shipped declaration and *checked* against it, not retyped. Putting them in one module, each with a comment naming the file it is read from, makes the derivation a single readable artifact and gives the check exactly one place to read. Verified: a site subproject may import the repository root's `package.json` directly (`resolveJsonModule` through Vite) and render `manifest.version` and `manifest.openchamber.contributes.capabilities` at build time — which is what makes FR-053 satisfiable with no authored version literal.
- **A site-local `.gitignore`.** Redundant with the root one by design, and the redundancy is the point: the root `.gitignore` entry exists for the *repository's* hygiene, and the site-local one means the site directory carries its own rule if it is ever moved, copied, or vendored. It is two lines and it costs nothing.
- **`.agents/` is committed, and is a genuine exception to "no new top-level directory".** It is the installed Astro skill and its provenance lock, and the brief requires both committed. It is **not** linted: ESLint 10 does not descend into a dot-directory when handed a directory argument, but `eslint .` **does** walk into one — verified, a `.mjs` placed at `.agents/probe.mjs` is reported by `eslint .` and not by `eslint .agents`. `.agents/skills/astro/SKILL.md` is markdown and produces only a "no matching configuration" warning rather than an error, so the root gate stays green as it stands; the ignore entries are added anyway so that the first JavaScript file anyone drops into that directory is not suddenly a root-gate failure. **The skill is treated as a scaffold reference, not an authority** — see the correction note below.

### Correction note on the installed Astro skill

`.agents/skills/astro/SKILL.md` comes from third-party `astrolicious/agent-skills` despite its frontmatter claiming `authors: "Astro Team"`, at 16.4K installs. Two of its claims would have produced a broken build here, and both are recorded in research.md §6.5 so a later phase does not rediscover them:

1. **It never mentions `base`.** Its Core Config table lists only `site`, and its `astro.config.ts` example is `defineConfig({ site: 'https://example.com' })`. Following it produces a site that works in `astro dev` and 404s every asset in production — the exact failure AC-002 exists to catch.
2. **Its "Deploying with an Adapter" section recommends `npx astro add vercel|node|cloudflare|netlify --yes`.** GitHub Pages is a purely static publish with **no adapter**; adding one would be wrong and would add a dependency the site does not need.

Everything load-bearing in this plan was verified against `docs.astro.build` instead. The skill is committed as the artifact it is and cited as a starting point only.

---

## Architecture

### The site as a pipeline

```text
site/src/pages/*.md|.astro  ──astro build──>  site/dist/  ──upload-pages-artifact──>  artifact
        │                                              │
        │  data/declarations.ts reads:                └──deploy-pages──>  https://shaunburdick.github.io/mecha-turk/
        │    ../../package.json          (capabilities, version — build time, no literal)
        │    ../../service/config.ts     (configuration fields, bounds, units, take-effect)
        │    ../../service/routes/…      (dispatch states, symptom tokens)
        │
        └── every page: layout.astro → nav.astro + footer.astro → data/site.ts (the one base-path helper)
```

The site is a **consumer of this repository's declarations**, not a copy of them. That direction is the whole mechanism behind FR-047 and FR-048: a claim is traced by naming the file it came from, an enumeration is generated from the declaration, and a check compares the two. The site imports across the directory boundary, which Vite resolves and `astro check` type-checks without complaint (verified against a two-directory fixture: a `site/` subproject importing the parent `package.json` type-checks clean and renders the imported values).

### The two gates, and what each proves

| Gate | Triggers | Steps | What it proves | What it cannot prove |
| --- | --- | --- | --- | --- |
| **The repository gate** (`verify.yml`, unchanged) | `pull_request`, push to `main` | `npm ci`, `npm run verify` (build → lint → typecheck → test), `git diff --exit-code` | The panel, the service, and the tests are green; the committed bundles match their sources | **Nothing about the site.** It cannot reach a self-contained subproject, and that is by design (FR-070). |
| **The site's build job** (`site.yml`) | `pull_request`, push to `main` | `npm ci` in `site/`, `astro check`, `astro build`, then a build-output assertion step | The site type-checks under `strictest`; it builds; the output has exactly five pages, no script file, no image, and every internal link under the base | Nothing about the panel, the service, or the tests |
| **The deploy job** (`site.yml`) | push to `main` **only** | needs `build`; `configure-pages` → `upload-pages-artifact` → `deploy-pages` | The built site is published to the Pages address, and the deployment records that address (AC-024) | — |

The build job runs on push to `main` as well as on pull requests, deliberately: a merge is a claim that the site builds, and a green PR does not prove the merge landed the way the PR was reviewed. The deploy job is gated on `github.event_name == 'push'`, so a pull request from a fork can never reach `deploy-pages`.

### Content ownership, and the one-home rule

| Topic | Its one home (FR-049) | What happens to the other two surfaces |
| --- | --- | --- |
| What it is, boundaries, prerequisites, storage, panel shape | the landing page | README's *How it works* and *Honest boundaries* move; the six-tab table moves |
| Install, requirements, updates, permissions, surfaces | `/install/` | README's *Requirements* and *Install* move; `quickstart.md` §3 becomes a pointer |
| Configuration, accounts, bindings, settings, starting prompt | `/configure/` | README's *Configuration*, *Set up*, and *Starting prompt* move; `quickstart.md` §4 becomes a pointer |
| First dispatch, state table, day-to-day controls | `/use/` | README's *First dispatch* and *When a dispatch doesn't go through* move |
| Symptoms, data locations, trails, hand-edited files | `/debug/` | README's *Where your data lives*, *Security at a glance*, *Uninstall*, and *Troubleshooting* move; `quickstart.md` §6 and §8 become pointers |

No topic is authored at two lengths. `specs/002-agent-event-extension/quickstart.md` keeps §1 *Build*, §2 *Verify*, §5 *Manual verification checklist*, and §7 *Cleanup* — contributor commands and a live checklist, which are not operator documentation and which 002 FR-042's amended text does not treat as documentation prose to move. The `Development` section of the README likewise stays: it is contributor commands, and the contributor pointer FR-057 requires is that section.

### Verification map (which check discharges which criterion)

| Criterion | The check that discharges it | Where it lives |
| --- | --- | --- |
| AC-001 (five pages) | the build-output assertion enumerates `dist/**/*.html` and asserts the exact set | `site/scripts/assert-build.mjs`, run by the build job |
| AC-002 (base path) | the same script resolves every internal `href`/`src` in the output and asserts each begins `/mecha-turk/`; plus the published fetch after deploy | site job + a post-merge fetch task |
| AC-003 (every page links all five) | the same script asserts each page contains all five nav targets | site job |
| AC-004 (no remote font/script/image/CDN) | the same script scans every emitted file for any off-origin URL and for `.js`/image extensions | site job |
| AC-005 (one `h1`, nav landmark, footer licence link) | the same script, per page | site job |
| AC-006 (no placeholder/TODO) | a repository test scanning the site's page sources | `tests/docs-sync.test.ts` |
| AC-007/AC-008 (capabilities) | the page's table is generated from `package.json`; a test asserts the rendered rows equal `capabilities` plus the implied `service`, and that the README names no other | `tests/manifest.test.ts` |
| AC-009 (configuration fields) | a test reads `service/config.ts`'s `NUMERIC_BOUNDS` + `DEFAULT_CONFIG` and asserts the page's field list matches names, bounds, units, defaults, and take-effect classes | `tests/docs-sync.test.ts` |
| AC-010 (dispatch states) | a test reads `LISTABLE_STATES` from `service/routes/events-page.ts` and asserts every one is on the use page, with the `blocked:` family described as a family | `tests/docs-sync.test.ts` |
| AC-011 (symptom tokens) | a test enumerates the tokens the panel and service ship and asserts each appears verbatim on the debug page | `tests/docs-sync.test.ts` |
| AC-012 (vocabulary) | the L1 scan gains the site as a scanned surface | `tests/vocabulary.test.ts` |
| AC-013 (mapping table) | a test asserts the mapping table is present on the site and absent from the README | `tests/docs-sync.test.ts` |
| AC-014/AC-015 (prose discipline) | the prose-budget measurement plus a section-mapping assertion | `tests/prose-budget.test.ts` |
| AC-016 (NFR-006) | a test runs the project-health prose measurement and asserts the site's content plus the README does not exceed the README plus the walkthrough as measured before | `tests/prose-budget.test.ts` |
| AC-017/AC-018/AC-019 (tooling isolation) | a test asserts the root manifest is byte-identical, the lint/typecheck reach no site file, and the `verify` script is unchanged | `tests/docs-sync.test.ts` |
| AC-020 (no suppression) | the repository-wide suppression scan, unchanged and green | existing suites |
| AC-021 (ignores) | a test asserts `dist/`, `.astro/`, and `node_modules/` are all ignored after a local build | `tests/docs-sync.test.ts` |
| AC-022 (a syntax error fails the PR) | the build job runs `astro check` and `astro build`; either failing fails the PR | site job |
| AC-023 (SHA pins, exact permissions) | a test parses `site.yml` and asserts every `uses:` carries a 40-hex SHA, the deploy job's permissions are exactly `pages: write` + `id-token: write`, and `verify.yml` is unchanged | `tests/docs-sync.test.ts` |
| AC-024/AC-025 (deployed address) | a post-merge fetch task | a Phase-6 task, not a test |
| AC-026/AC-027 (About link) | the About-tab suite gains the assertions; the two comments are corrected | `tests/about-tab.test.ts` |
| AC-028 (bundle freshness) | the existing `git diff --exit-code` step and the secret scan | `verify.yml` + `tests/bundle.test.ts` |
| AC-029 (licence) | a test asserts the file exists, carries the full MIT text and the exact copyright line, and that the manifest's `license` and the README's licence section agree | `tests/docs-sync.test.ts` |
| AC-030/AC-031 (constitution discharge) | a test asserts the landing page states the OpenChamber-off dependency, names the Status tab, and names both storage locations with their uninstall survival | `tests/docs-sync.test.ts` |

---

## Key decisions

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D1** | **`site/` is a self-contained subproject** — own manifest, own committed lockfile, own `engines.node` `>=22.12.0`, installed and built from its own directory. The root `package.json` is byte-identical. | Astro 7 requires Node `>=22.12.0` against the root's advertised `>=20.19.0`, and the root manifest is simultaneously the npm dev package and the OpenChamber installable manifest (invariant 2). Raising the root floor is issue #17; `workspaces` is banned. Research.md §2 records the conflict and the three exits. | A root workspace member (banned, and it would hoist Astro's tree into `npm ci` for the product); raising the root floor (a change to what the product declares it supports, filed separately) |
| **D2** | **The base path is declared in exactly one file, and every internal link is built through one helper that reads `import.meta.env.BASE_URL`.** No `href` or `src` in a page or component is hand-written. | FR-005 requires one edit on a rename. It is also the only way to survive the specific trap: **verified** — with `trailingSlash` left at its default `'ignore'`, `BASE_URL` is `/mecha-turk` with no trailing slash, so a page path like `/install/` joined naively produces `/install/` with the base **silently dropped**. With `trailingSlash: 'always'`, `BASE_URL` is `/mecha-turk/` and the join is correct. Three join shapes were built and measured; the strip-leading-slash `new URL` form is the one that is correct under both settings, and pinning `trailingSlash: 'always'` makes it correct twice over. | Hand-writing `/mecha-turk/…` in five files (five edits on a rename, and one place to get wrong); `${BASE_URL}${path.slice(1)}` (correct **only** under `trailingSlash: 'always'` — verified to emit `/mecha-turkinstall/` otherwise) |
| **D3** | **No adapter, no integration, `output: 'static'`.** The published artefact is `site/dist/` uploaded as-is. | GitHub Pages serves static files. An adapter adds a dependency, a build-mode surface, and a failure mode to a site with no server component — and the installed Astro skill recommends one, which is the specific thing to avoid here. | `astro add vercel|netlify|cloudflare --yes` (the skill's advice: wrong for a static publish, and it would add a dependency the product owner declined in `## Out of Scope`) |
| **D4** | **Two jobs in one workflow file, `.github/workflows/site.yml`.** `build` runs `astro check` then `astro build`; `deploy` needs `build`, is gated on `github.event_name == 'push'`, and is the only job holding `pages: write` + `id-token: write`. | FR-069 requires the build job to type-check as well as build, because it is the site's **only** gate — the root `npm run verify` cannot reach a self-contained subproject. FR-065 makes its failure fail the pull request. One workflow with two jobs keeps the build steps in one place and lets the deploy job reuse the built artefact rather than rebuilding it. | Two separate workflow files (duplicates the build steps and lets the two drift); a `withastro/action` single step (it hides the `astro check` half, and FR-069 requires it to be visible) |
| **D5** | **`actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`, each pinned to a commit SHA, and **no** `static_site_generator` input.** | FR-067 requires SHA pins and exact permissions. The three actions are GitHub's own documented sequence for a custom Pages workflow, and they are what the repository's `AGENTS.md` action-SHA convention already applies to `verify.yml`. **`static_site_generator` is deliberately not passed** — see the flag below. | `withastro/action` (convenient, but it collapses `astro check` and `astro build` into one opaque `build-cmd`, and FR-069 requires the type-check to be a step a reviewer can see fail) |
| **D6** | **The navigation, the heading discipline, and the footer live in `src/layout.astro` and its two components; pages carry content only.** | FR-004 (every page links all five), NFR-004 (one `h1` in order, a labelled nav landmark, discernible link text, contrast), and FR-076 (a footer licence link on every page) are then true **by construction**. Verified: a `.md` page with `layout:` frontmatter inherits exactly one `<h1>` and the layout's nav, and the build emits no `<script>` and no external stylesheet. | Per-page markup (fifteen copies of the same nav, each a chance to miss a link, add an orphan, or drop the licence link) |
| **D7** | **The four trace-derived enumerations are generated from the shipped declarations at build time and compared by a repository test.** The site's `data/declarations.ts` imports the root `package.json`, and the four tables are asserted against `service/config.ts`, `service/routes/events-page.ts`, and the panel's rendered tokens. | FR-048 makes the derivation the rule and a failing check the consequence, so a later feature that adds a field, a state, or a capability fails a check rather than producing a stale page. Verified: a site subproject can import the parent `package.json` and render it under `astro check` + `astro build` without complaint. | Hand-writing the tables and adding a test that compares them (a second copy to keep in step, and the page is still wrong between the two edits) |
| **D8** | **`public/` is not created. There is no favicon, no image, and no font file.** Zero images is FR-009 and AC-004 asserts the built output contains no image file. | The requirement is explicit and a self-hosted favicon would be the one image in the output. The browser's default `/favicon.ico` request 404s harmlessly, and Pages serves a 404 page — no reader impact, and a strictly smaller surface. | A self-hosted `favicon.svg` in `public/` (it would be the only image in the output, and AC-004 asserts there is none) |
| **D9** | **Version and capabilities are read from the root `package.json` at build time. No page authors a version literal.** | FR-053 forbids an authored version literal and names the manifest as the one permitted source. Reading it rather than hard-coding it is what makes the rule structural instead of aspirational. The About tab keeps its own single source (the service's health answer) — two surfaces, two legitimate sources, neither a literal. | Hard-coding `0.0.1` in a page (a literal that rots on the next release, and FR-053 forbids it) |
| **D10** | **The build job runs a committed assertion script over `dist/` after `astro build`.** It is part of the site's only gate, so the properties that gate exists to protect are checked in it rather than by review. | AC-001 – AC-005 and NFR-002 are properties of the **built output**, not of the sources, and a source-level review cannot establish them. AC-002 in particular cannot be verified locally without checking the built output's resolved links. | Checking these in a reviewer's browser (the failure AC-002 exists to prevent is precisely the one a local preview cannot catch) |
| **D11** | **The site's `.gitignore` is created even though the root one will also cover `dist/` and `.astro/`.** | Redundancy that is deliberate and cheap: the root entries are the repository's hygiene, and the site-local file means the directory carries its own rule if it is moved or vendored. The root `.gitignore` still gains both lines (FR-071) because the root one is what a contributor reads. | Site-local only (then the root `.gitignore` does not state the rule, and FR-071 binds the repository's ignore) |
| **D12** | **`.agents/` is committed and added to the root lint `ignores` alongside `site/`.** | The skill and its provenance lock are part of this work and must be committed. **Verified**: `eslint .` walks into a dot-directory — a `.mjs` at `.agents/probe.mjs` is reported by `eslint .` and *not* by `eslint .agents` — so today's markdown-only content produces no error by luck, and the first `.ts` file dropped in there would be a root-gate failure. The ignore makes that impossible. It is a scope exclusion in the same shape as `panel/main.js` and `service/main.js`, not a rule suppression. | Leaving it out of `ignores` (a latent root-gate failure the first time someone adds a script there) |
| **D13** | **The README keeps a `Development` section and a `License` section; everything operator-facing moves.** | FR-057 enumerates what the README reduces to and the contributor pointer is one of them. `## Out of Scope` in the specification already ruled a version bump out, and a release note is not what a summary carries. The README keeps the six-tab table's **absence** deliberately: the landing page owns that topic, and FR-049 forbids two homes. | Moving the contributor commands to the site too (they are not operator documentation, and the site is for operators) |
| **D14** | **The site's prose uses the panel's reserved vocabulary — Dispatches, Bindings — and the `run`/`repositories` nouns are absent, exactly as `tests/vocabulary.test.ts` already enforces for the README.** The mapping table itself, which names the retired words, lives in exactly one place on the site. | 005 FR-020 as extended by v1.16.0 binds the site; SC-107 and AC-140 gain it as a scanned surface. The mapping table is a table **about** the retired words, so it is the one legitimate place they appear, and 005 v1.16.0 is explicit that the one-home rule is preserved rather than relaxed. | Naming them for readability (they are the words operators meet in a log; the mapping table is what resolves them) |

### A flagged discrepancy in the brief, and what this plan does about it

The feature brief directs the publish workflow to use `static_site_generator: astro` on `actions/configure-pages`. **That input does not accept `astro`.** Verified against the action's own `action.yml` and `src/set-pages-config.js` on `main`: the documented values are `nuxt`, `next`, `gatsby`, and `sveltekit`, and the `default:` branch of the switch **throws** `Unsupported static site generator: astro` — caught by `setPagesConfig`'s own try/catch and downgraded to a `core.warning`, not a failure. The net effect of passing it is a permanent warning on every deploy and a step that does nothing.

The correct value is therefore to **omit the input**, which is what D5 does, and to use `actions/configure-pages` for what it is actually for here: enabling the Pages site and exporting `base_url` / `origin` / `host` / `base_path` as outputs, which the deploy step uses to report the published address (AC-024). Nothing in the specification depends on the input — FR-066 requires that publishing not depend on branch-based publishing and that the stale `source` block be reconciled, which a workflow upload satisfies. **This is flagged rather than silently absorbed: it is a factual correction to the brief, not a product decision, and the product owner should know the input was dropped on purpose.**

### Reconciling the stale Pages `source` block

The repository's Pages configuration reports `build_type: "workflow"` alongside `source: {branch: "main", path: "/"}` (research.md §1.1). With `build_type: "workflow"` the site is served from whatever the deploy workflow uploads, and the `source` block records the legacy branch-publish configuration the repository was created with — nothing has ever been published through it, and the address returns 404. FR-066 requires the configured source to be reconciled so no stale branch-and-path setting is mistaken for the publishing mechanism. The reconciliation is a repository-settings action taken once as a Phase-6 task: confirm the Pages source reads **GitHub Actions**, so the setting and the mechanism agree and the stale block is not left looking authoritative. The workflow does not depend on it either way; the workflow *is* the publishing mechanism.

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| **The published base path is wrong.** Every asset and internal link 404s while the local preview works perfectly. | D2 (one helper, `trailingSlash: 'always'`, no hand-written paths), D10 (the build job asserts every resolved internal link in the built output begins `/mecha-turk/`), AC-002 (the published fetch is an acceptance criterion), and `research.md` §1.3. The failure is now caught at three points instead of by a reader. |
| **The site subproject's only gate is a workflow nobody watches.** | D4 (the build job runs on every pull request and on push to `main`), FR-065 (its failure fails the pull request), and the Phase-6 task that watches the first run to completion rather than assuming it passed. |
| **A capability, configuration field, dispatch state, or symptom token is added to the product later and the page goes stale.** | D7 (the enumerations are generated) plus four repository tests that compare them (AC-008 – AC-011). The failure is a failing check in the root gate, which every pull request already runs. |
| **The documentation re-creates a home the owner deliberately emptied.** | The About tab's scrubbed copy is not re-added (005 v1.16.0 is explicit), and the mapping table goes on the site rather than back into the README. `tests/docs-sync.test.ts`'s negative half asserts the retired copy stays out of the README. |
| **The prose budget is exceeded** — the move becomes an expansion. | `tests/prose-budget.test.ts` measures before and after against `.project-health/baseline.json` and fails if the total grows (NFR-006, AC-016). The measurement command and both figures are recorded in the pull request, as AC-016 requires. The most recent commit on `main` (`d2d3f40`) was a reduction pass; the budget is measured against what exists, not against what is convenient. |
| **The `LICENSE` file is a summary rather than the licence.** | FR-074 requires every grant, condition, disclaimer, and warranty waiver, and the exact copyright line. A repository test asserts the presence of the standard template's clauses and the verbatim string, and `package.json`'s `license: "MIT"` is asserted to agree (FR-075, AC-029). |
| **Adding `site/` and `.agents/` to the root lint `ignores` reads as a suppression.** | The reason is stated in the config comment, exactly as the two committed bundles' entries are, and FR-072's prohibition on disabling a rule is honoured — no rule is turned off and no type suppression is added. The check that proves it (AC-019, AC-020) is a test. |
| **The README's reduced length breaks `tests/docs-sync.test.ts`'s existing assertions**, which currently require the README to name six tabs, `GET /v1/config`, `expectedAgent`, `config.json`, and `expected GitHub login`. | Expected, and it is the point of FR-049: those claims move to the pages that own them. The test's `PAGES` list gains the site and its per-document assertions become per-surface — the README is checked for the summary, the site pages for the detail. This is a named task, not an incidental fix, and the plan does not weaken any assertion it moves. |
| **`astro check` needs `@astrojs/check` and `typescript` present**, and refuses to run without them. | **Verified**: with `@astrojs/check` absent, `astro check` prints a prompt asking to install it and exits 0 — a silent pass, which is the worst possible shape for the site's only gate. Both are exact devDependencies of the site from the first commit, and the build job's assertion step fails if the check did not actually run. |
| **A page's prose claims something the shipped code does not do.** | FR-047 requires the trace target to be named before publication. Every page section carries a comment naming the file it was read from, and the four enumerations are generated rather than remembered. |

---

## Artifacts

```text
specs/007-homepage-docs/
├── spec.md                      # v1.1.0, approved with 002 v1.13.0 and 005 v1.16.0
├── plan.md                      # this file
├── research.md                  # 268 lines at Phase 3, EXTENDED in Phase 4 — existing entries preserved
├── tasks.md                     # NEW — the ordered, dependency-correct task list
├── data-model.md                # NOT created, and §"Why there is no data model" says so explicitly
├── contracts/
│   ├── pages-workflow.md        # NEW — the publish workflow's permissions and trigger contract
│   ├── site-build-output.md     # NEW — the declared shape of `dist/`, which is what Pages serves
│   └── README.md                # index + a note on what is deliberately not a contract
├── quickstart.md                # 134 lines at Phase 3, EXTENDED — site dev loop + both Node floors
├── changelog.md
└── checklists/requirements.md
```

Plus, at the repository root: `site/`, `LICENSE`, `.github/workflows/site.yml`, and the committed `.agents/` + `skills-lock.json`.

---

## Why there is no `data-model.md`

A `data-model.md` earns its place when a feature introduces entities, a schema, state machines, storage tiers, or a wire contract. This feature introduces **five static documents**. A page has a path, a title, a heading, a body, and a footer link; the "entities" are a navigation list and four tables, and the tables are not modelled — they are **generated from declarations the product already owns** (D7), which is the whole point of FR-048. There is no schema to describe, no state to enumerate, no storage to lay out, and no migration to reason about. Manufacturing an entity model for five Markdown files would be a document that costs a reader time and can never disagree with the code, because it says nothing the code does not.

What the feature *does* have — the published address, the build output's shape, and the workflow's permissions — is contract material, and it lives in [`contracts/`](./contracts/): `pages-workflow.md` for the permissions and trigger contract, `site-build-output.md` for the shape of the artefact Pages serves. The content model, such as it is, is five rows in §Content ownership above and needs no file of its own.
