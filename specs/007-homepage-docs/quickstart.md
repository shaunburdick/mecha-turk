# Quickstart: the documentation site

How to build, preview, and check the documentation site locally, and what CI will do with the same commands. Every command below is one a contributor can run on a clean clone with no further setup.

> **The site is a separate subproject.** It has its own `package.json`, its own lockfile, and its own Node floor. Nothing you install for the site touches the repository's own toolchain, and `npm run verify` at the repository root neither builds nor checks the site. The evidence is in [research.md](research.md) §2.

> **On the directory name — settled by the plan.** Every path below writes the site directory as `site/`, and `site/` **is** the decided name: [plan.md](./plan.md) §Project structure adopts it against the five constraints `research.md` §4 records. Nothing else in this document changes.

## 0. Prerequisites

| You need | Version | Why |
| --- | --- | --- |
| **Node** | **≥ 22.12.0** for the site | The site's build tool requires it. |
| Node | ≥ 20.19.0 for the repository root | The root `package.json` declares this floor. |
| npm | ≥ 9.6.5 | The site's build tool declares this floor. |

**Two different floors, on purpose.** The repository's root floor is `>=20.19.0` because that is what the OpenChamber installable manifest advertises, and raising it is issue #17 — out of scope here. The site's floor is higher because its build tool requires it. If you are on Node 20, you can still run the repository's own gate; you just cannot build the site until you move to Node 22.12 or newer. CI uses Node 24 for both.

> Verify: `node --version`. If it is below `v22.12.0`, use a version manager (`nvm`, `mise`, `asdf`, `volta`) to select a newer release before continuing.

## 1. Install the site's dependencies

```sh
cd site
npm ci
```

- **Expected**: no output beyond npm's own progress lines, exit code 0.
- `npm ci` (not `npm install`) so your tree matches the committed lockfile exactly — that is what the build job does too, and a tree that drifts from the lockfile is not what will be published.
- If npm reports an engine error naming a version below 22.12.0, you are on the wrong Node release. Go back to step 0.

> Verify: `site/node_modules/` exists, and `git status --porcelain` from the repository root reports nothing new. The site's dependency directory is already covered by the repository's existing `node_modules/` ignore rule.

## 2. Preview the site

```sh
npm run dev
```

- **Expected**: a local server, and the URL it prints **ends in `/mecha-turk/`**.
- **Open that exact URL.** The site is published at a subpath — `https://shaunburdick.github.io/mecha-turk/` — not at the root of a domain, so the local preview serves the pages under `/mecha-turk/` as well. If you open `/` you will get a 404 that looks like a broken site and is not one.
- **The five pages** (spec FR-001):

  | Page | What it is for |
  | --- | --- |
  | `/mecha-turk/` | The landing page — what the product is, its boundaries, its prerequisites, both storage locations. |
  | `/mecha-turk/install/` | Adding the extension, the permission table, version pinning, updates. |
  | `/mecha-turk/configure/` | Projects, accounts, bindings, Settings, the layered starting prompt. |
  | `/mecha-turk/use/` | The first dispatch, the state table, the panel's surfaces day to day. |
  | `/mecha-turk/debug/` | Symptoms and what to do, the data directory, the two trails. |

- There is **no** FAQ page, **no** search, and **no** images. If you are looking for one, it is out of scope on purpose — see `## Out of Scope` in [spec.md](./spec.md).

> Verify: each of the five addresses above loads, and the network panel shows requests to `localhost` only. The site makes **no** request to any other origin (FR-010, NFR-003): no remote font, no CDN, no analytics, no third-party script.

## 3. Build the site the way CI builds it

```sh
npm run build
```

- **Expected**: exit code 0, and a `site/dist/` directory containing one HTML file per page.
- **Then check it**, which is the other half of what CI runs:

```sh
npm run check
```

  This type-checks the site's own sources. A type error in a page fails here, which is why it is in the build job and not only `astro build` (FR-069).

- **Then preview the built output** rather than the dev server:

```sh
npm run preview
```

  - **Expected**: the same five addresses, served from `dist/`.
  - This is the step that catches a base-path mistake: the dev server and the built site resolve the base path slightly differently, and the built output is the thing that gets published.

> Verify with a quick grep — a heuristic for the eye, not the acceptance criterion (AC-002 is the published check):

```sh
grep -r 'src="/[^m]' dist/ ; grep -r 'href="/[^m]' dist/
```

  No matches. Any `src="/…"` or `href="/…"` pointing somewhere other than `/mecha-turk/` is an asset or an internal link that will **404 in production while working perfectly in `npm run dev`** — the single largest correctness risk in this feature (research.md §1.3, AC-002). The site's own components must build these paths through the base path the configuration declares, not by hand.

> Also verify: `dist/` contains no `.js` file and no image file. The site ships **zero client-side JavaScript** (NFR-002) and no images (FR-009). `git status --porcelain` from the repository root reports `dist/` and `.astro/` as ignored.

## 3a. The base path, and why step 3's grep is not paranoia

The site is published at a **subpath** — `https://shaunburdick.github.io/mecha-turk/` — not at the root of a domain. That single fact is responsible for the largest correctness risk in this feature, so it is worth stating plainly what goes wrong and why your local preview will not catch it.

**Astro's `base` setting makes the repository name the root of the site.** Every asset URL and every internal link is written relative to that root. Forget `base` and the site works perfectly in `npm run dev` and 404s every asset in production, because the built pages reference `/install/` where Pages serves `/mecha-turk/install/`. A contributor who does not know about the subpath will look at the wrong URL and conclude the site is broken — the failure mode `spec.md` → User Story 7 exists to prevent.

**Two rules follow, and the site follows both so you do not have to remember them:**

1. **`base` is declared in exactly one file** — `site/astro.config.ts`. If the repository is ever renamed, that one line is the only edit the site's address needs. Nothing else in the site, the workflow, or the documentation hard-codes `/mecha-turk/`.
2. **No page writes an `href` by hand.** Every internal link is built by one helper (`site/src/data/site.ts`) that joins against the base path the configuration declares.

**A second trap, sharper than the first.** The trailing slash on that base path comes from `trailingSlash`, **not** from `base`. Measured on a real build:

| `trailingSlash` | The base path a link is built from | A hand-joined link produces |
| --- | --- | --- |
| unset (Astro's default) | `/mecha-turk` — no trailing slash | `/install/` — **the base is gone** |
| `'always'` | `/mecha-turk/` | `/mecha-turk/install/` |

So the site sets `trailingSlash: 'always'`, which is also what the published `/install/` address needs, **and** uses a link helper that is correct under either setting. If you add a page, extend the page list in `site/src/data/site.ts` and nothing else; if you change `trailingSlash`, run step 3's grep and the build's assertion step before you push.

> Verify: step 3's grep finds nothing, and `npm run build` — which ends with the build-output assertion — fails loudly if a link, an asset, or a page count is wrong. Research.md §7.1 has the measured table and §7.4 explains why the check lives on the output rather than in a review.

## 4. Edit a page

- Page sources are Markdown or component files inside the site directory. Navigation, the footer, and the base path live in the site's layout and configuration — **change those once, not per page**.
- **The base path is declared in exactly one place** (FR-005). If the repository is ever renamed, that one place is the only edit the site's address needs.
- Before opening a pull request, run all three:

```sh
npm run check      # type-check the site
npm run build      # build it
cd .. && npm run verify   # the repository's own gate
```

  - `npm run verify` at the root is **unchanged by this feature** and still means: build → lint → typecheck → test. It runs on Node ≥ 20.19 and takes a Node ≥ 22.12 for the site's own commands above.
  - Run the root gate **always**, because the site's build is not part of it.

## 5. What happens when you open a pull request

| Check | What it does | Fails the pull request if |
| --- | --- | --- |
| **The repository gate** (`CI`) | `npm ci`, then `npm run verify`: build → lint → typecheck → test, then `git diff --exit-code` to assert the committed bundles match their sources | Anything in the panel, the service, or the tests regresses, or a source change did not bring its rebuilt bundle with it |
| **The site's build job** | Installs the site from **its own** lockfile, runs `astro check` **and** `astro build` (which ends with the build-output assertion) | The site does not type-check, does not build, or builds the wrong output — an extra page, a script file, an image, an off-origin reference, or an internal link that does not resolve under the base path |

**The site's build job is the site's only gate, not a second opinion.** The site is a self-contained subproject, and the root `npm run verify` cannot reach it: it lints and type-checks `src/`, `panel/`, `service/`, and `tests/`, and the site directory is deliberately excluded from both scopes. That is why the job runs `astro check` and not only `astro build` — `astro build` does not type-check, so a build alone would let a type error through (research.md §7.3, FR-069).

**If your change touched `src/`** — for example the About tab's documentation link — the root gate's final step is what catches a forgotten bundle: `panel/main.js` is committed by design (`AGENTS.md` invariant 1), and that step fails if your rebuild left it dirty.

**On merge to `main`**, a second job in the site's workflow publishes the built site to GitHub Pages. The jobs are separate, and the workflow is separate from the repository gate, on purpose: publishing needs `pages: write` and `id-token: write`, and the repository gate deliberately holds read-only permission. The deploy job is gated on the push event, so **a pull request — including one from a fork — can never reach it.** The Pages site was configured workflow-driven and has never been published; the address returns 404 until this feature's workflow runs for the first time.

The permissions, the pinned action SHAs, and the address the deployment publishes to are written down in [contracts/pages-workflow.md](./contracts/pages-workflow.md).

## 6. Common problems

| Symptom | Cause | What to do |
| --- | --- | --- |
| The dev server prints a URL with no `/mecha-turk/` | The base path is not applied in the site's configuration | Restore it. Every published asset depends on it, and the failure is invisible locally except as a missing path. |
| `npm ci` refuses to install, naming an engine version | Node is below the site's floor (≥ 22.12.0) | Move to Node 22.12 or newer. The repository root's lower floor does not apply to this directory. |
| A page 404s in the built output but not in `npm run dev` | A hand-written root-absolute `src`/`href` | Route it through the site's link helper — step 3a explains why a hand-joined link can drop the base silently, and the build's assertion step catches it. |
| A link is `/mecha-turkinstall/` — base and path run together | `trailingSlash` was changed away from `'always'`, so the base path has no trailing slash to join against | Restore it, and keep using the helper rather than a hand-written join. Step 3a has the measured table. |
| `npm run check` passes but seems to have done nothing | `@astrojs/check` or `typescript` is missing, so `astro check` prompts to install and **exits 0** | Both are exact devDependencies of the site. Restore them; a check that silently checks nothing is worse than no check (research.md §7.2). |
| The root `npm run verify` does not mention the site | Correct, and intended | The root gate cannot reach the site: it is a separate subproject with a separate Node floor. The site's build job is its gate. |
| `git status` shows `dist/` or `.astro/` after a build | They are not ignored | They must be ignored (FR-071). Fix the ignore entries rather than committing them. |
| Root lint or typecheck reports a file under the site directory | The site directory is not excluded from that tool | Exclude the **directory**. Do **not** disable a lint rule to make it fit (FR-070, FR-072). |
| Root lint starts reporting a file under `.agents/` | The installed skill directory is not excluded — and `eslint .` walks into dot-directories even though `eslint .agents` does not | Add the directory to `ignores` alongside `site/`. Same shape, same reason (research.md §7.8). |

## Where to look next

| Question | File |
| --- | --- |
| What the site must contain, and what it must not | [spec.md](./spec.md) |
| How the site is built, and every decision behind it | [plan.md](./plan.md) |
| Why Astro 7, why a subproject, why the base path matters, and what Phase 4 measured | [research.md](./research.md) |
| The workflow's permissions contract, and the published address | [contracts/pages-workflow.md](./contracts/pages-workflow.md) |
| The shape of the published output, and what is asserted about it | [contracts/site-build-output.md](./contracts/site-build-output.md) |
| Which of features 002 and 005 this amends, and how | [changelog.md](./changelog.md) |
| How to install, verify, and read Mecha Turk (operator walkthrough) | [../002-agent-event-extension/quickstart.md](../002-agent-event-extension/quickstart.md) |
| Repository layout, invariants, and contributor workflow | [../../AGENTS.md](../../AGENTS.md) |