# Research: Documentation Site and MIT Licence — new findings only

**Feature**: `specs/007-homepage-docs` · **Spec**: v1.1.0 · **Date**: 2026-10-05
**Phase**: 1–3 (constitution check, specification, clarification) **and §6, added in Phase 4**. `plan.md`, `contracts/`, and `tasks.md` are Phase 4–5; §6 records the findings Phase 4 made that a later phase would otherwise re-derive, and it is **appended** — nothing above this line changed.

This file answers only the questions **007** raises. Its two jobs: record the **verified** premises with the evidence each was checked against (so a later phase does not re-derive them and a reviewer can check them), and record the one **conflict** the feature must resolve rather than inherit. Everything about *what* the site says belongs to `spec.md`; everything about *how* it is built and published belongs to `plan.md`, which cites this file.

Every check below was run in this repository on **2026-10-05**.

---

## 1. Verified premises

### 1.1 GitHub Pages is already enabled, and publishing is workflow-driven

```
$ gh api repos/shaunburdick/mecha-turk/pages
{"url":"https://api.github.com/repos/shaunburdick/mecha-turk/pages","status":null,"cname":null,
 "custom_404":false,
 "html_url":"https://shaunburdick.github.io/mecha-turk/",
 "build_type":"workflow",
 "source":{"branch":"main","path":"/"},
 "public":true,"protected_domain_state":null,"pending_domain_unverified_at":null,"https_enforced":true}
```

Four facts, each load-bearing:

| Field | Value | What it settles |
| --- | --- | --- |
| `build_type` | `workflow` | Publishing is workflow-driven. Locked decision 6 is already true in the repository settings; this feature implements it rather than changing it. |
| `html_url` | `https://shaunburdick.github.io/mecha-turk/` | The one canonical address of the site. Fixed by the repo owner, not chosen here. |
| `https_enforced` | `true` | No plaintext-redirect handling is needed in the site; a canonical `https://` URL is correct as written. |
| `source` | `{branch: "main", path: "/"}` | **Not the publishing mechanism** — see 1.2. |

### 1.2 The `source` block is stale configuration, not the publish path

`build_type: "workflow"` and `source: {branch, path}` are both present. They are not in conflict as *behaviour* — with `build_type: "workflow"` the Pages site is served from whatever the deploy workflow uploads, and the branch/path block records the legacy branch-publish configuration the repository was created with. Nothing has ever been published through it:

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://shaunburdick.github.io/mecha-turk/
404
$ curl -s -o /dev/null -w "%{http_code}\n" https://shaunburdick.github.io/
404
```

The 404 body is GitHub's *"Site not found"*: Pages is on, nothing is deployed. **Consequence for the plan:** the deploy workflow is the only thing that makes the site exist, so it must be added and observed green **before** the feature can claim the address works. Nothing in this feature can assume the address is already live — and `research.md` records the 404 as the pre-change baseline that AC measures against.

### 1.3 The site is served from a subpath

The repository is user-owned (`shaunburdick/mecha-turk`), not the `shaunburdick.github.io` special repository, so the published root is `/mecha-turk/`, not `/`. Astro's own deployment guide is explicit:

> GitHub Pages will publish your website at an address that depends on both your username and your repository name (e.g. `https://<username>.github.io/<my-repo>/`). Set a value for `base` that specifies the repository for your website.
> — [Deploy your Astro Site to GitHub Pages](https://docs.astro.build/en/guides/deploy/github/)

and, on the consequence:

> **Internal links with `base` configured**: When this value is configured, all of your internal page links must be prefixed with your `base` value.
> — [Configuration reference — `base`](https://docs.astro.build/en/reference/configuration-reference/#base)

The reference adds the detail the plan needs: *"Astro will use this path as the root for your pages and assets both in development and in production build"*, accessible in code as `import.meta.env.BASE_URL`. So a site that sets `base` but writes root-absolute internal links produces a **locally working, entirely broken published site** — the worst failure shape available here, because the preview cannot catch it. This is why the published-base-path behaviour is an acceptance criterion and not a line in `plan.md`.

### 1.4 Astro 7.3.5 is current, and its Node floor exceeds the repository's

```
$ npm view astro version
7.3.5
$ npm view astro@latest engines
{ npm: '>=9.6.5', node: '>=22.12.0', pnpm: '>=7.1.0' }
$ npm view astro dist-tags
'latest': '7.3.5'   'beta': '7.4.0-beta.1'   'alpha': '7.0.0-alpha.2'   'legacy': '4.16.19'
```

**The conflict.** The repository's root manifest declares:

```json
"engines": { "node": ">=20.19.0" }
```

Astro 7 requires Node **≥ 22.12.0**. A single root manifest cannot advertise a Node floor of `>=20.19.0` and hold a dependency that refuses to install or run below `>=22.12.0`. Three ways out, and the third is the one this feature takes:

1. **Raise the root floor to `>=22.12.0`.** Rejected: AGENTS.md invariant 2 makes the root `package.json` the OpenChamber installable manifest, and changing the floor it advertises is a change to what the product declares it supports. Tracked separately as **issue #17** and explicitly out of scope here.
2. **Add an npm `workspaces` entry and make the site a workspace member.** Rejected: AGENTS.md invariant 2 says *"Do not reintroduce npm `workspaces`"*, and a workspace would hoist Astro's transitive tree into the root install and change what `npm ci` produces for the product's own toolchain.
3. **Make the site a self-contained subproject** — its own `package.json`, its own committed lockfile, its own `engines.node`, installed and built from its own directory. Chosen.

Consequence chain, all of it load-bearing for `plan.md`:

- The root `package.json` gains **no** dependency, **no** devDependency, **no** `workspaces`, and **no** script that builds the site. Its `engines.node` stays `>=20.19.0` (FR-007).
- The site's own `engines.node` declares `>=22.12.0` and is the floor its CI job installs.
- The root `npm run verify` cannot and does not build or typecheck the site (FR-059 – FR-061), so the repository gate keeps its exact meaning and its 15-minute budget.

**Astro pin.** `7.3.5` exactly, no `~` and no `^`. This mirrors AGENTS.md invariant 6's rule for the SDK (*"Compatibility-sensitive external APIs must be pinned"*, constitution §Development Quality Gates) applied to a build tool whose Node floor and config surface are compatibility-relevant. `7.4.0-beta.1` exists and is not used; the `legacy: 4.16.19` tag is for a pre-5 line that predates the `base` semantics this site depends on.

### 1.5 The three root-tooling boundaries, verified against the files themselves

**Lint.** `package.json`'s `lint` script is a bare `eslint .`, and the root flat config's `ignores` block is:

```js
ignores: ['panel/main.js', 'service/main.js', 'node_modules/**', 'coverage/**']
```

`eslint .` walks the whole tree from the repository root, so anything added under it is **offered to the root configuration**. The site's own TypeScript files (`astro.config.ts`, `env.d.ts`, and any `.ts` under the site) fall inside the shared config's TypeScript block, which is type-aware — and type-aware linting resolves types against the **root** `tsconfig.json`, which does not include the site. The result would be either spurious errors or a silently degraded check. The site directory therefore goes into that `ignores` array (FR-060). This is an *exclusion of a separately-owned subproject from the root's lint scope*, in the same shape as the two committed bundles already listed there with their stated reason — not a rule suppression.

**Types.** The root `tsconfig.json` `include` is explicit: `["src/**/*.ts", "panel/**/*.ts", "service/**/*.ts", "tests/**/*.ts"]`. `tsc --noEmit` therefore **already** cannot reach a site directory, and needs no change to stay true (FR-061). The site needs its *own* `tsconfig.json` for its own checker, which extends an Astro-provided base and excludes its build output.

**Ignore file.** `.gitignore` has an **unanchored** `node_modules/` (a pattern with no leading slash and no trailing slash matches at any depth), so `site/node_modules/` is already covered and needs no new line. It has **no** `dist/` entry and **no** `.astro/` entry, and both are produced by an Astro build and dev server respectively. Both need adding (FR-062) — without them a local build leaves hundreds of untracked files in `git status`, which is how generated output reaches a commit.

### 1.6 CI already runs a Node that satisfies Astro

`.github/workflows/verify.yml` sets up Node `24`, and its own comment states why:

> `package.json engines.node` is ">=20.19.0" — a floor, not a chosen release. Node 24 is the major this suite is verified green on, and `setup-node` resolves '24' to its newest patch release.

Node 24 ≥ 22.12.0, so the site's build job can use the same major the repository already verifies green on. Two useful consequences: the site needs **no** new Node version to be introduced anywhere, and `withastro/action`'s own `node-version` input **already defaults to `24`** (see 1.7), so the site build runs on the major CI already uses by default.

### 1.7 The deploy path, and what the build step is

Astro publishes an official action for exactly this:

| Input | Default | Note for this feature |
| --- | --- | --- |
| `path` | repository root | Accepts a **subproject directory**, which is what makes decision 3 viable without a monorepo |
| `node-version` | `24` | Already satisfies Astro 7's floor |
| `package-manager` | auto-detected from the lockfile | Detects the site's own lockfile when `path` points at the subproject |
| `build-cmd` | `<package-manager> run build` | — |
| `out-dir` | `dist` | The artifacted directory |
| `cache` | `true` | Caches `node_modules/.astro` |

— [withastro/action README](https://github.com/withastro/action), v6 line, paired with `actions/deploy-pages@v5` and `actions/checkout@v7`, which is also the shape Astro's own deployment guide prints.

Three requirements fall out of the action's shape rather than from preference (FR-054 – FR-057): the site build runs on **every pull request** and fails one that breaks it; publishing runs on push to `main` and needs `pages: write` + `id-token: write`, which is more permission than the read-only CI workflow holds and therefore cannot be folded into it; and every action reference is pinned to a commit SHA, matching the existing `verify.yml` convention.

### 1.8 Panel facts the About-tab entry point depends on

`src/about-tab.ts` is the whole change surface. Read directly:

- It renders four things: `PRODUCT_NAME`, the version line, `DESCRIPTION`, and `REPOSITORY_LINE`. The module docblock states the page is *"deliberately small — **name, version, description, repository link** — because that is all an About page is asked for."*
- The repository link is a **text** handle carrying markdown link syntax, not an anchor the iframe navigates: `REPOSITORY_LINE = \`Repository: [${REPOSITORY_URL}](${REPOSITORY_URL})\``, mounted through `mountStyledText` with `onOpenUrl`, which forwards to `rt.host.openUrl`. The module docblock gives the reason: *"A sandboxed iframe cannot open a link itself."*
- A refusal already has a home: `repoNote` renders the refusal on its own line, redacted, and the address stays readable.
- The static half renders with or without the service (FR-078's rule); the version is the only part that reads `/health`.

**The suite that guards it**, `tests/about-tab.test.ts`, and how it reacts to a fifth line:

| Existing assertion | Effect of adding a documentation link |
| --- | --- |
| `expect(mountButton).toHaveLength(2)` — "only the two controls" | **Unaffected.** A link is a text handle, not a button. The tab's control set stays two. |
| `expect(text).toContain('Repository: [https://github.com/shaunburdick/mecha-turk]')` | **Unaffected.** `toContain`, not an exhaustive list. |
| Version-shaped-literal scan over `src/**.ts` + `panel/main.ts` | **Unaffected.** The scan strips comment lines and matches `(?<![\d.])\d+\.\d+\.\d+(?![\d.])`. A URL constant has no three-part number. |
| Docblock and the comment *"Name, version, description, repository link — the whole page after the 2026-10-01 scrub"* | **Both become false.** They are comments asserting the page's complete contents; adding a fifth item makes them stale, and this repository tracks comment-to-code ratio and treats a comment that lies as a defect. |

So the About change is additive and cheap, but it is **not** free of consequences, and two of the four above are exactly the kind of thing a spec that said "add a link" would leave behind.

### 1.9 `src/` means the committed panel bundle moves (AGENTS.md invariant 1)

> The panel and service bundles (`panel/main.js`, `service/main.js`) are committed — OpenChamber never compiles TypeScript on install. Rebuild and commit them with any source change.

`src/about-tab.ts` is a `src/` change, so the feature ends with `npm run build` and the rebuilt `panel/main.js` committed in the same commit. `verify.yml` already enforces the rest of the rule as a check — its final step is `git diff --exit-code`, which fails the gate if a source change did not bring its bundle with it. `tests/bundle.test.ts` scans the shipped bundles for credential material (`findSecretLeak`); a URL constant cannot trip it.

### 1.10 The surfaces the documentation must be traced against

The content-sourcing constraint in the feature brief is only enforceable if the trace targets are named. They exist, and they are countable:

| Topic | Trace target in this repository |
| --- | --- |
| Capabilities the extension requests | `package.json` → `openchamber.contributes.capabilities` = `["sessions", "prompt"]`, plus `contributes.service` (implied `service`) |
| Service configuration: field names, bounds, units, defaults | `service/config.ts` → `NUMERIC_BOUNDS` (11 numeric fields: `intervalMs`, `overlapMs`, `perPage`, `retryMaxAttempts`, `retryBaseMs`, `retryMaxMs`, `auditRetentionDays`, `auditMaxEntries`, `excerptRetentionDays`, `leaseMs`, `resultDeadlineMs`) and `DEFAULT_CONFIG`; plus `logLevel`, `expectedAgent` (default blank), `startingPrompt` (default blank) |
| Configuration surface and its declaration | `service/routes/config.ts` → `GET /v1/config` answers `{ config, fields }`; `service/config-schema.ts` projects the declaration the validator reads |
| Dispatch states an operator can see | `service/routes/events-page.ts` → `LISTABLE_STATES` = `pending`, `claimed`, `starting`, `dispatched`, `failed`, `unconfirmed`, `dead-lettered`, beside an **open** `blocked:<reason>` family |
| Setup prerequisites | `src/prerequisite-records.ts` — five, each `met` / `not met` / *not checkable by the panel*, with its own remediation |
| Troubleshooting tokens | The identifiers shipped by `service/routes/` and read by the panel: `NO_SERVICE`, `SERVICE_FAILED`, `storage-unavailable`, `credential-rejected`, and the `project "<id>" is not registered` refusal text |
| Store layout and permissions | `service/store/` — data directory `0700`, files `0600`; `~/.config/openchamber/mecha-turk/` holding bindings, accounts, `config.json`, `events.json`, `runs.json`, scans, `audit.ndjson` |
| Extension storage vs service store | AGENTS.md invariant 4 (`mecha-turk:` key namespace) and the constitution's *"durable state must match the storage it actually lives in"* |

Two of these carry a **count or a table** the documentation must therefore reproduce exactly, which is what makes "traced, not remembered" checkable: the eleven numeric bounds, and the dispatch-state table.

### 1.11 The `## Install` permission table is stale, and the manifest says so

`README.md` currently says:

> 4. Review the approval dialog and choose **Allow and enable**. Mecha Turk asks for exactly these four things:
> `sessions` · `prompt` · `service` · `network`

`AGENTS.md` invariant 3 states the opposite about the fourth row:

> The integration card that also implied `network` was removed by product-owner order (2026-09-30); the panel makes no GitHub request of its own (`host.request()` has no caller), so `network` is no longer requested at all.

The manifest agrees with AGENTS.md: `capabilities` is `["sessions", "prompt"]`, and `service` is implied by `contributes.service`. So the shipped approval asks for **three** things, and the README documents **four**. This is a pre-existing documentation defect, not something this feature introduces — but this feature writes the install page from scratch and moves README's install prose, so the stale row would be **copied forward into the canonical source** unless it is refused. FR-020 refuses it by construction (the table is derived from the manifest, not retyped), and `## Clarifications` Q2 records the placement decision.

### 1.12 There is a third copy of this documentation today

The prose-duplication constraint ("a move, not an expansion — no topic at three different lengths") is not hypothetical. Install, first-run, store-and-backup, and troubleshooting prose currently lives in **two** user-facing places plus the planned site:

| Document | Lines | Operator content it carries |
| --- | --- | --- |
| `README.md` | 384 | Requirements, install, set up, starting prompt, first dispatch, failed dispatch, data locations, security, uninstall, troubleshooting, development |
| `specs/002-agent-event-extension/quickstart.md` | ~180 | Prerequisites, build, verify, **install**, **first run**, manual verification checklist, **service store & backup (94 lines)**, cleanup, **troubleshooting** |
| the site | — | install, configure, use, debug |

The bolded rows are the same topics the README covers and the site will cover. AGENTS.md calls `specs/002-agent-event-extension/quickstart.md` "the maintained walkthrough", so it is a live document and not an artefact. FR-042 and the pointer requirement in FR-043 are how the site becomes canonical rather than a third copy; whether the walkthrough's operator sections are reduced to pointers here is recorded as an inference in the report, not as a locked decision.

### 1.13 Related requirements in earlier specs this feature touches

Three approved requirements in 002 and 005 bind documentation documents by name, and a canonical-site move lands on all three:

| Requirement | Current text, in effect | What a canonical site does to it |
| --- | --- | --- |
| **002 FR-042** (+ **AC-022**) | "The maintained operator walkthrough (`quickstart.md`) and `README.md` MUST be brought into agreement with the surfaces this document and features 003–006 specify… This requirement binds the two user-facing documents" | The document list gains the site. Without this, the site becomes the one operator surface no synchronisation requirement covers — exactly the gap that let the `network` row rot. Extended, not weakened (007's amendment table). |
| **005 FR-020** (+ **SC-107**, **AC-140**) | Operator-facing copy MUST use **Dispatches** and **Bindings** and MUST NOT use "Run"/"Repositories", "everywhere a human reads it: … `README.md`" | The site is a place a human reads. The site's prose is bound by the same vocabulary rule. Extended (FR-046). |
| **005 FR-029** | "The mapping table MUST be reproduced in `README.md`, so that an operator who reads `run` in an audit row or a log can find the surface that produced it" | The mapping table is **not currently in the README** — this is an existing, undischarged requirement. The site is the natural home it was meant to have; the About tab renders none of it, so a table home has to exist somewhere. Recorded as a conformance gap this feature can close, not as a defect it causes. |

---

## 2. The one conflict, and how the feature resolves it

**Conflict.** Astro 7 needs Node ≥ 22.12.0; the repository's installable manifest advertises ≥ 20.19.0 and may not gain a `workspaces` key.

**Resolution.** A self-contained subproject (1.4, option 3). The root manifest is untouched; the site declares its own floor; CI installs the major it already uses. The price is real and is stated rather than discovered later: **the root `npm run verify` does not check the site**, so the site's own build job is the only thing standing between a broken page and a merge, and its coverage depends entirely on that job existing and being required.

Three consequences the plan must not soften:

1. **The PR build is the site's only gate.** It is not a second opinion; it is the whole gate. That is why locked decision 3 makes a failed build fail the pull request, and why the build job must run `astro check` and not only `astro build` (FR-063).
2. **Two Node floors now exist in one repository.** They are different floors for different subtrees, and `quickstart.md` states both so a contributor on Node 20 is not left to discover it.
3. **`git diff --exit-code` in the existing CI job does not cover the site.** Its comment is explicit that it exists to catch a forgotten bundle. It stays exactly as it is; nothing in this feature weakens it.

---

## 3. Decisions taken here, with rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| R-1 | The site is a self-contained subproject with its own manifest and committed lockfile | The only option that leaves both invariant 2 (one document, two roles; no `workspaces`) and the advertised Node floor intact (1.4) | Root workspace; root floor bump (issue #17) |
| R-2 | Astro pinned exactly at `7.3.5`, no range operator | Its Node floor and config surface are compatibility-relevant; this is invariant 6's pin rule applied to build tooling, and a range would silently change the Node floor CI resolves | `^7.3.5` (a minor bump can change `engines`) |
| R-3 | The site directory is excluded from the root lint config, and the root `tsconfig.json` is left alone | `eslint .` walks the whole tree and the shared TypeScript block is type-aware against the root project; the root `include` already excludes the site, so changing it would be noise (1.5) | Excluding `.astro` only; adding the site to the root `include` |
| R-4 | `dist/` and `.astro/` added to `.gitignore`; `node_modules/` left as-is | The existing unanchored pattern already covers the subproject (1.5); adding a duplicate line would be a second, redundant statement of the same fact | A `site/dist/` line (unanchored `dist/` is the correct shape and matches the existing style) |
| R-5 | The site build job is a separate workflow from the read-only CI job | The deploy job needs `pages: write` and `id-token: write`; folding it into `verify.yml` would widen the permissions of a workflow whose current comment says it *"never pushes, comments, or uploads, so it gets nothing but the ability to read the repository"* | One workflow with conditional permissions |
| R-6 | Astro's `base` behaviour is an acceptance criterion, not a config line | A root-absolute internal link produces a site that works in `astro dev` and 404s in production — the one failure the local loop cannot catch (1.3) | Verifying by inspection of `astro.config` only |
| R-7 | The debug page's scope stops at the panel, the store, and the files | The service listens on a **loopback** port with a host-provided token; an operator has no supported way to reach it from a shell, so documenting `curl` calls would document a path the product does not support. Recorded as `## Clarifications` Q3 rather than decided here | Documenting the HTTP surface as read-only diagnostics |
| R-8 | No third-party requests from the rendered page | Constitution §Security and Operational Standards requires *"outbound HTTPS only for MVP GitHub and the configured OpenChamber endpoint"*. That bullet's subject is the **product's runtime** — the service is the only thing that makes an outbound request in this product. A static documentation page is not that runtime: it holds no token, opens no GitHub connection, and exists only when a reader's browser fetches it. So no amendment is needed, and the bullet is not weakened. What the principle *does* support is the stricter posture this feature adopts anyway: a reader's browser makes **zero** requests to any origin but the site's own. Self-hosting every asset, no CDN font, no analytics, no third-party script — stronger than the constitution requires, not weaker, and therefore available to a feature specification without an amendment (constitution §Governance: *"A feature specification may add constraints"*) | A remote font or a CDN-hosted stylesheet (a reader's browser would make a request to a third party on every page view, for no benefit) |

---

## 4. The site directory's name is the plan's to choose

Not decided here. Whichever name the plan takes, it must satisfy all five of:

1. It is passed as the `path` input to the build action, so the action installs and builds **that** directory's lockfile (1.7).
2. It appears in the root `eslint.config.mjs` `ignores` array (R-3).
3. `dist/` and `.astro/` under it are ignored by the unanchored patterns added to `.gitignore` (R-4).
4. It is not matched by the root `tsconfig.json`'s `include` — true of any name that is not `src`, `panel`, `service`, or `tests` (1.5).
5. It does not begin with `.` (a leading-dot directory is excluded from some tooling by convention and would make the ignore story need an anchored pattern).

`site/` is the recommendation: it is the shortest unambiguous name, it matches the vocabulary already in use (`viewed.strings`, `testview`, the `site` word in the issue), and it cannot be confused with `specs/`.

---

## 5. Open items this research leaves

Three, all recorded in `spec.md` → `## Clarifications` with an encoded default so none of them blocks Phase 4:

1. **The MIT copyright holder.** The licence file needs a holder line and only the product owner can supply it. Default encoded: the repository owner, exactly as GitHub renders them for this repository, with the year 2026 — and the fallback if that is not wanted is the contributors line.
2. **Where the stale `network` row in README's install table is corrected** (1.11). Default encoded: corrected here, because this feature rewrites the install page from the manifest and a stale row cannot be carried forward into a canonical source.
3. **Whether the debug page documents the local service's HTTP surface** (R-7). Default encoded: it does not.

None of the three changes a requirement's shape if the answer differs: each is a one-line copy change or a scope confirmation, not a redesign.

---

## 6. What was deliberately **not** researched

The product's behaviour is not in question here — it ships, and its documentation is a **trace** of shipped code, not a place to describe intended behaviour (FR-041). So this file records no re-reading of the poll loop, the store, dispatch semantics, or `extension-spike-1`. The panel, service, and configuration facts in 1.8 – 1.10 were read from the source for exactly that reason: to establish the trace targets, not to re-derive the product.

---
---

## 7. Phase-4 findings (added 2026-10-05, plan and tasks)

Everything above is phases 1–3 and is retained as written. This section records what Phase 4 established **by building it**, not by reading about it. Each finding was reproduced against a real `astro@7.3.5` install in a scratch directory; the evidence is the command and its output, so a reviewer can re-run it rather than inherit it.

### 7.1 `base` is not one setting but two behaviours, and only one of them is obvious

`research.md` §1.3 recorded that `base` must be declared and that a root-absolute internal link breaks production. Phase 4 found a **second, sharper** failure the first account does not cover, and it is the reason `trailingSlash: 'always'` is load-bearing rather than cosmetic.

`base` changes the value of `import.meta.env.BASE_URL`, and **that value's trailing slash is determined by `trailingSlash`, not by `base`**. Both facts are in Astro's own configuration reference (*"The value of `import.meta.env.BASE_URL` will be determined by your `trailingSlash` config, no matter what value you have set for `base`"*), and both were measured:

| `trailingSlash` | `BASE_URL` | `new URL(path.replace(/^\//,''), new URL(BASE_URL, …))` | `` `${BASE_URL}${path.slice(1)}` `` |
| --- | --- | --- | --- |
| unset (default `'ignore'`) | `/mecha-turk` | `/install/` — **base dropped** | `/mecha-turkinstall/` |
| `'always'` | `/mecha-turk/` | `/mecha-turk/install/` | `/mecha-turk/install/` |
| `'never'` | `/mecha-turk` | `/install/` — **base dropped** | `/mecha-turkinstall/` |

**Why the first form fails on the default**: `new URL('install/', new URL('/mecha-turk', origin))` resolves against `/mecha-turk` as though it were a *file*, so `install/` replaces it. Nothing warns; the page builds, the build succeeds, and every internal link points at the domain root. **This is a strictly worse failure than the one §1.3 describes**, because the naive-concatenation form a reader is likely to write is correct under exactly one setting of three.

**The decision, then**: the site sets `trailingSlash: 'always'` (which is also what `build.format: 'directory'` wants, and what Pages serves from `about/index.html`) **and** routes every internal link through the strip-leading-slash `new URL` form, which is correct under either setting. Two independent mechanisms for one failure is not redundancy for its own sake — it is that a contributor who changes `trailingSlash` later cannot silently break every link on the site, and the assertion script would catch it anyway.

### 7.2 `astro check` **exits 0 when its own dependency is missing** — a silent pass on the site's only gate

FR-069 requires the build job to type-check as well as build, because it is the site's only gate. Two facts about that check:

```
$ npm install astro@7.3.5            # no @astrojs/check
$ npx astro check
To continue, Astro requires the following dependency to be installed: @astrojs/check.
  ╭────────────────────────────────────╮
  │  npm i @astrojs/check typescript   │
  ╰────────────────────────────────────╯
  ◆  Continue?   ● Yes / ○ No
$ echo $?
0
```

**It prompts, and it exits 0.** In CI, where there is nobody to answer the prompt, that is a job that reports success without having type-checked anything — the worst possible shape for the one gate standing between a broken page and a merge. `typescript` is in the same boat.

**The mitigation is in T-001**: both are exact devDependencies of the site from the first commit, and the build job's assertion step (§7.4) is what would notice if they ever went missing. This is a finding worth carrying forward to any other subproject in this repository.

### 7.3 `astro build` does **not** type-check — the reason FR-069 exists

```
$ npx astro build          # src/pages/index.astro: const n: number = "not a number";
  ├─ /index.html (+1ms)
  ✓ 1 page(s) built
$ echo $?
0
$ npx astro check          # with @astrojs/check installed
  src/pages/index.astro:2:7 - error ts(2322): Type 'string' is not assignable to type 'number'.
$ echo $?
1
```

Confirmed twice: with the dependency present, `astro check` **exits 1**; `astro build` builds the file anyway. So *"the build job runs `astro build`"* is not sufficient and never was. This is the mechanical justification for FR-069, and it is why the build job's step list has two entries rather than one.

### 7.4 The properties that matter are properties of the **output**, not of the sources

Five acceptance criteria and two NFRs cannot be established by reading a page: AC-001 (no page beyond five), AC-002 (every internal link resolves under the base), AC-004 (no image, no script, no off-origin reference), NFR-002 (no JavaScript), NFR-003 (no third-party request). A reviewer with the source open is checking the wrong artefact — the failure mode those criteria exist to catch is *precisely* the one a source review cannot see (§7.1 is a working example of a build that is green and wrong).

So the checks live in the artefact and run in the job that produced it: `site/scripts/assert-build.mjs` is the last step of the site's `build` script, stdlib-only, and asserts the seven properties in [`contracts/site-build-output.md`](./contracts/site-build-output.md) §5. A local `npm run build` and a CI build cannot differ, because there is only one command.

### 7.5 A site subproject can read the repository's declarations — which is what makes FR-048 enforceable

FR-048 requires four enumerations to be **derived** from the shipped declaration and **checked** against it, and FR-053 requires the version to be read from the manifest at build time. Both were verified against a two-directory fixture (a repository with a root `package.json` and a `site/` subproject with its own):

```
site/src/layouts/Doc.astro:  import manifest from '../../../package.json';
$ npx astro check     →  0 errors, 0 warnings, 0 hints
$ npx astro build     →  <p>Version 0.0.1</p> · <li><code>sessions</code></li> · <li><code>prompt</code></li>
```

**A cross-directory JSON import resolves and type-checks cleanly.** That single fact is what turns "derived, not retyped" from an instruction into a mechanism: the page's permission table is *generated* from `manifest.openchamber.contributes.capabilities`, so it cannot name a capability the manifest does not request, and no version literal is ever authored. The alternative — hand-writing the tables and adding a test that compares them — leaves a second copy to keep in step, and the page is still wrong in the window between the two edits.

The same direction of dependency is the safe one: the site **reads** the repository, and the repository learns nothing about the site. The root `package.json` gains no dependency, no script, and no workspace entry (invariant 2), which is what makes the read one-way and permanent.

### 7.6 The installed Astro skill is wrong about two things that would each have broken the build

`.agents/skills/astro/SKILL.md` is committed as part of this work (task T-000a). It is from third-party `astrolicious/agent-skills` — 16.4K installs — despite its frontmatter claiming `authors: "Astro Team"`, and two of its claims are actively harmful for this feature:

1. **It never mentions `base`.** Its Core Config table lists `site` alone, and its `astro.config.ts` example is `defineConfig({ site: 'https://example.com' })`. A site built to that guidance works perfectly in `astro dev` and 404s every asset in production. The skill's own advice would have produced AC-002's failure directly.
2. **Its "Deploying with an Adapter" section recommends `npx astro add vercel|node|cloudflare|netlify --yes`.** GitHub Pages is a purely static publish with no adapter. Following it would add a dependency the product owner declined in `## Out of Scope`, to a site with no server component.

Everything load-bearing in [plan.md](./plan.md) was verified against `docs.astro.build` instead. **The skill is a scaffold reference, not an authority**, and this paragraph is the record a later phase needs in order not to promote it to one.

### 7.7 `actions/configure-pages` does not accept `static_site_generator: astro`

The feature brief directed the publish workflow to pass `static_site_generator: astro`. **That input does not accept `astro`.** Verified against the action's own `action.yml` and `src/set-pages-config.js` on `main`:

```yaml
static_site_generator:
  description: 'Optional static site generator to attempt to configure: "nuxt", "next", "gatsby", or "sveltekit"'
```

```js
    default:
      throw `Unsupported static site generator: ${staticSiteGenerator}`
```

The throw is caught by `setPagesConfig`'s own try/catch and downgraded to a `core.warning`, so passing `astro` would emit a **permanent warning on every deploy** and achieve nothing — not a failure, which is why it would have survived review. The input is therefore **omitted** (plan D5), and `configure-pages` is used for what it does for us: enabling the Pages site and exporting `base_url` / `origin` / `host` / `base_path` as outputs, which the deploy step reports the published address from. **This corrects a factual claim in the brief, not a product decision**, and is flagged in [plan.md](./plan.md) §Flagged discrepancy and in [`contracts/pages-workflow.md`](./contracts/pages-workflow.md) §5.

### 7.8 `eslint .` walks into dot-directories — so `.agents/` needs an ignore

FR-070 excludes the site directory from the root lint scope. The brief asked whether the new top-level `.agents/` needs the same. **It does**, for a reason worth knowing:

```
$ npx eslint .agents
  You are linting ".agents", but all of the files matching the glob pattern ".agents" are ignored.
$ printf 'var probe = 1\n' > .agents/probe.mjs
$ npx eslint .            # →  .agents/probe.mjs  no-var, no-unused-vars, semi   (3 errors)
$ npx eslint .agents      # →  no matching configuration (dot-dir not descended)
$ npx eslint .agents/skills/astro/SKILL.md
  0:0  warning  File ignored because no matching configuration was supplied
```

`eslint .` **does** walk into a dot-directory; `eslint .agents` does not. Today's `.agents/` holds one markdown file, which produces a *warning* rather than an error, so the root gate is green today **by luck rather than by configuration**. The first `.ts` or `.mjs` file anyone drops into that directory would be a root-gate failure on a file nobody in this repository authored and nobody reviews. Both `.agents/**` and `site/**` go into the same `ignores` array, with the reason in the comment, in the same shape as the two committed bundles already there (T-000b, D12).

### 7.9 Verified action versions, for the SHA pins

Pinned by commit SHA per FR-067. Resolved 2026-10-05, so the task that writes the workflow does not have to re-resolve them:

| Action | Tag | Commit SHA |
| --- | --- | --- |
| `actions/configure-pages` | `v6.0.0` | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` |
| `actions/upload-pages-artifact` | `v5.0.0` | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
| `actions/deploy-pages` | `v5.0.1` | `368f82528645a54fb793d4d04e342629a3f51346` |

`actions/checkout` `v7.0.1` and `actions/setup-node` `v7.0.0` are already pinned in `verify.yml` and are reused **at the same SHAs**, so the two workflows cannot drift apart on the actions they share. A pinned SHA is a fact about a moment, not a version range: if a task resolves these again and gets a different SHA, that is a **new release**, and the right response is to read the release notes rather than to take the new SHA silently.

### 7.10 The four enumerations, and the four tests that will keep them honest

The trace targets `research.md` §1.10 named are countable, which is what makes "traced, not remembered" checkable. Re-read in Phase 4 to confirm each is still where §1.10 said it was, and that each is importable from a site subproject:

| Enumeration | Declared in | Count | Checked by |
| --- | --- | --- | --- |
| Requested capabilities | root `package.json` → `openchamber.contributes.capabilities` = `["sessions","prompt"]`, plus `contributes.service` implying `service` | 2 + 1 implied | AC-008 |
| Configuration fields | `service/config.ts` → `NUMERIC_BOUNDS` (11 numeric) + `DEFAULT_CONFIG` (`logLevel`, `expectedAgent`, `startingPrompt`) | 14 | AC-009 |
| Dispatch states | `service/routes/events-page.ts` → `LISTABLE_STATES`, beside an **open** `blocked:<reason>` family | 7 + 1 family | AC-010 |
| Symptom tokens | `service/routes/*` and the panel: `NO_SERVICE`, `SERVICE_FAILED`, `storage-unavailable`, `credential-rejected`, the `project "<id>" is not registered` refusal | 5 | AC-011 |

Two of these are traps rather than lists. The `blocked:` family is **open** — a closed list of four reasons in the documentation would be wrong the moment a fifth cause ships, which is why FR-038 says *family*. And the symptom tokens are **exact strings the product renders**, so the debug page's first column must be verbatim rather than paraphrased: an operator searching for `storage-unavailable` must find that string, not "a storage error" (FR-041).

### 7.11 Two root tests will break on the README's reduction, and that is the feature working

`tests/docs-sync.test.ts` currently asserts the README names six tabs, `GET /v1/config`, `expectedAgent`, `project-manager`, `config.json`, `operator-backable`, and "expected GitHub login", and that both bound documents exceed 1,500 characters. FR-049 moves every one of those claims to the page that owns it. **They will fail, and that is the requirement doing its job** — the alternative would be a README that keeps a summary of everything and the site beside it, which is the multi-home problem 007 exists to end.

The work is a **restructure, not a deletion**: the test's `PAGES` list gains the site, and each assertion becomes per-surface. The README is checked for the summary it now is; the site pages are checked for the detail they now carry. **No assertion is weakened** — each one moves to the surface the prose moved to, and the amended FR-042's tie-break is added: where a claim appears in two of the three bound documents, the site governs and the other two must not contradict it. This is named as its own task (T-031) rather than left to be discovered as a red suite.

---

## 8. Corrections and the index of measured findings (added 2026-10-05, Wave 4)

Everything above is retained as written. §7.1 carries **one false claim**, corrected here rather than edited in place, and §7's four load-bearing measurements are indexed below so a later phase reads them here instead of rediscovering them.

### 8.1 Correction: the strip-leading-slash `new URL` form is correct under **one** setting of three, not two

§7.1 measured the three settings correctly in its table and then drew the wrong conclusion from its own data. The sentence to correct is §7.1's:

> routes every internal link through the strip-leading-slash `new URL` form, which is correct under either setting.

**It is correct under exactly one of the three.** `new URL('install/', new URL('/mecha-turk', origin))` resolves against `/mecha-turk` *as though it were a file*, so the trailing segment replaces it and the result is `/install/` — the base dropped, with no warning, under both `trailingSlash: 'ignore'` (Astro's default) and `trailingSlash: 'never'`. That is the same row of §7.1's own table, three lines above the sentence that misread it. §7.1's *other* judgement in that paragraph — that naive concatenation is "correct under exactly one setting of three" — is right, and it is true of the `new URL` form too.

**No code is at risk, and none was ever at risk.** The shipped helper, `site/src/data/site.ts`'s `underBase`, does not use that form as written:

```ts
const directory = `${baseUrl.replace(/\/+$/, '')}/`;   // normalise the base to a directory form first
const relative = pagePath.replace(/^\/+/, '');          // strip the path's leading slash
const joined = new URL(relative, `${RESOLUTION_ORIGIN}${directory}`);
```

Normalising the base means the join is correct under **all three** settings of `trailingSlash`, and it carries the query and fragment across (the documentation pages link to their own sections by anchor). `site/tests/base-path.assertions.mjs` exercises the join against every spelling of the base without needing a build, so the property is under test rather than asserted in a comment. §7.1's *decision* — keep `trailingSlash: 'always'` **and** route every link through the helper — stands unchanged; only the description of what the helper buys was wrong.

`quickstart.md` §3a repeated the same claim, and it has been tightened there to say "correct under all three settings" and point at this section.

### 8.2 The four measurements, in one place

Each is already recorded with its evidence in §7. This is the index, and the consequence each one imposes on whoever touches it next:

| Finding | Recorded | Measured | What it obliges |
| --- | --- | --- | --- |
| **`actions/configure-pages` has no `static_site_generator: astro` input.** It accepts `nuxt`, `next`, `gatsby`, `sveltekit`; anything else hits a `throw` that the action's own `try/catch` downgrades to a warning | §7.7 | the action's `action.yml` and `src/set-pages-config.js` on `main` | **Omit the input.** Passing `astro` would emit a permanent warning on every deploy and achieve nothing — a failure mode that survives review precisely because it is not one. The action is still used, for enabling the site and exporting the outputs the deploy step reports the address from |
| **`astro check` prompts to install `@astrojs/check` and exits 0** when that dependency is absent; `typescript` is in the same boat | §7.2 | `npm install astro@7.3.5`, then `npx astro check`, with nobody to answer the prompt | **Both stay exact devDependencies from the first commit.** In CI that shape is a job reporting success without having type-checked anything — a silent pass on the site's *only* gate |
| **`import.meta.env.BASE_URL`'s trailing slash comes from `trailingSlash`, not `base`**, so a join against the un-normalised value is correct under one setting of three and silently drops the base under the other two | §7.1, corrected by §8.1 | three builds, one per setting | **Keep `trailingSlash: 'always'` *and* keep the normalising helper.** Either alone leaves a way to break every link on the site, quietly; the build-output assertion catches it, but the two together mean a contributor changing the setting does not have to know that |
| **`eslint .` walks into dot-directories; `eslint .agents` does not** | §7.8 | an `.mjs` probe at `.agents/probe.mjs`, linted both ways | **Keep `.agents/**` beside `site/**` in the root `ignores`.** Today's markdown-only content produces a warning rather than an error, so the root gate is green *by luck*; the first `.ts` or `.mjs` file dropped there would otherwise be a root-gate failure on a file nobody in this repository authored |

A fifth measurement is recorded in the same style and is the one with a home: **§7.5's finding that a site subproject can import the repository root's `package.json` cleanly** is the mechanism behind FR-048 and FR-053 — the site's enumerations are *generated*, not retyped, which is what makes AC-008 and AC-009 checkable rather than aspirational.

### 8.3 One stale cross-reference in this file, noted rather than edited

The header line above reads *"**and §6, added in Phase 4**"*, but §6 is *"What was deliberately **not** researched"* (phases 1–3) and the Phase-4 section is **§7**. The pointer is one section short. It is left as written — this file is append-only above this line, and the target is unmistakable from the section heading — but a reader arriving from that header should go to §7.

---

## 9. The Node floors are one number now (added 2026-10-05, product-owner decision)

Everything above is retained as written. §1.4 and §2 recorded a **conflict** and chose branch 3 of three ways out of it; that conflict is **resolved**, and this section records what dissolved it and which parts of the old record are now history.

**What moved.** The repository's root floor was `>=20.19.0` for as long as this file's phases 1–4 ran. **Issue #17 raised it to `>=24.15.0`**, merged to `main` as `51d3773` on 2026-10-05, and the product owner then decided that **the site's floor rises to match**. So `site/package.json`'s `engines.node` is now `>=24.15.0` rather than the `>=22.12.0` §1.4 measured.

**The three-way choice §1.4 set out, and which branch is historical.**

| Branch | What it was | Status now |
| --- | --- | --- |
| **1. Raise the root floor** | *"Rejected: AGENTS.md invariant 2 makes the root `package.json` the OpenChamber installable manifest, and changing the floor it advertises is a change to what the product declares it supports. Tracked separately as issue #17 and explicitly out of scope here."* | **This is what happened** — and the rejection's reasoning did not survive it. Issue #17's own commit found that the host never reads root `engines.node` (`parseManifestJson` validates only `openchamber.engines.openchamber`), so raising it removes nobody from the install path and is not a support-matrix change. The prohibition §1.4 read into invariant 2 was an inference about what a floor advertises, not the invariant's text |
| **2. Root `workspaces` member** | Rejected: invariant 2 says *"Do not reintroduce npm `workspaces`"*, and a workspace would hoist Astro's tree into the root install | **Still rejected, still correct.** Invariant 2 is unchanged and this feature still gains the site no workspace entry |
| **3. Self-contained subproject** | Chosen: own manifest, own committed lockfile, own `engines.node` | **Still chosen, and now the only reason it exists.** With branch 1 taken, branch 3's justification is no longer *"the root floor is lower"* — it is that the root manifest is the OpenChamber installable manifest and cannot gain a workspace |

**Why the measurement in §1.4 was not wasted.** The `npm view astro@latest engines` output above — `{ npm: '>=9.6.5', node: '>=22.12.0' }` — is still what sets the site's floor from below. `>=24.15.0` satisfies it with two minor lines of headroom, and the reason the pin on `astro@7.3.5` is exact (R-2) is unchanged: a range could move that floor. What changed is only which number satisfies it.

**The consequence §2 stated as unavoidable, and what happened to it.** §2's second consequence was *"**Two Node floors now exist in one repository.** They are different floors for different subtrees, and `quickstart.md` states both so a contributor on Node 20 is not left to discover it."* **There is one floor now.** The two-`engines`-blocks arrangement survives, so the site is still installed and built from its own directory and the root `npm run verify` still cannot reach it — §2's *first* consequence, that the site's pull-request job is its only gate, is **unchanged and still the price of branch 3**. But the contributor on Node 20 no longer exists as a distinct case, and `quickstart.md` §0 has been rewritten to say so rather than to teach a distinction that has stopped being true.

**What is recorded rather than rewritten.** `tests/manifest.test.ts` deliberately **never writes the root's floor into the suite**, so that the next legitimate change to it is not a failure here — that property is preserved, and the digest of `package.json` (§'s `ROOT_MANIFEST_SHA256`) is the mechanism that catches an unintended change instead. The site's own floor *is* named there, as a deliberate pin: raising it is a reviewed diff rather than a silent edit. FR-008's assertion is therefore about **the relationship between two manifests read at run time**, not about two recorded numbers — which is why it survives equality, and the comment in the test says so.
