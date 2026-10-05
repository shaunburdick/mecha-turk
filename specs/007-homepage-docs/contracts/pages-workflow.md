# Contract: the Pages publish workflow

**Feature**: `specs/007-homepage-docs` · **Date**: 2026-10-05 · **Binds**: `.github/workflows/site.yml`

Two requirements make this a contract rather than a comment. **FR-067** requires every action to be SHA-pinned and the publish job to hold *only* the permissions a Pages deployment needs; **FR-066** requires that publishing not depend on branch-based publishing and that the repository's stale Pages `source` block be reconciled. A future contributor who widens the permissions, unpins an action, or adds a trigger has broken an approved requirement, and the only thing that tells them so is this file plus two assertions in `tests/manifest.test.ts` (task T-033), which skip until this workflow exists and hold it from the moment it does.

**Status: shipped.** Every claim below is a property of the file as committed, and each is checked. Where this contract corrects the plan it says so and says why — see §5 and §7.

---

## 1. Triggers

| Event | Runs | Why |
| --- | --- | --- |
| `pull_request` | `build` only | FR-065: the site is built on every pull request and a build failure fails it. The deploy job is gated on `github.event_name == 'push'`, so **a pull request — including one from a fork — can never reach `deploy-pages`.** |
| `push` to `main` | `build`, then `deploy` | FR-066: published when the default branch is updated. The build runs again on the merge because a green pull request does not prove the merge landed as reviewed. |
| `workflow_dispatch` | *(not declared)* | **Deliberate.** Manual publishing would make it possible to publish something that was never built by the gate. If the owner wants a manual re-deploy, the correct shape is re-running the `deploy` job on the last green run, not a new trigger. |

**Publishing mechanism**: artifact-based, via `actions/upload-pages-artifact` + `actions/deploy-pages`. Branch-publish is **not** used and must not be configured.

---

## 2. Permissions — the whole contract in one table

| Scope | `build` | `deploy` | Rationale |
| --- | --- | --- | --- |
| `contents` | `read` *(inherited)* | **none** | Only `build` checks the repository out. Job-level permissions *replace* the workflow-level set rather than adding to it, so `deploy` — which checks nothing out and reads no repository content — holds nothing at all. |
| `pages` | none | `write` | The Pages deployment itself, and the one API read `configure-pages` makes. Nothing else needs it. |
| `id-token` | none | `write` | `actions/deploy-pages` exchanges a GitHub OIDC token for a Pages deployment token. This is the single most dangerous permission in the repository: **it must never be reachable from a pull-request-triggered run**, and the `if: github.event_name == 'push'` on the job is what guarantees it. |

**Workflow level**: `permissions: contents: read`. Every other scope is `none` by default at the workflow level and is granted **per job** — the deploy job's two write scopes are the only widening in the repository.

`tests/manifest.test.ts` collects **every** `key: read` / `key: write` line in the file and requires the list to be exactly `['contents: read', 'pages: write', 'id-token: write']`. A whole-file list rather than a per-job one is what makes a fourth grant a failure: `contents: write` on the deploy job is a plausible mistake (every other workflow in the wild grants it) and is the one this catches. It also means **the `build` job must not restate `contents: read`** — an inherited grant and a restated one are indistinguishable to that assertion, and restating it would read as a fourth entry.

**The existing gate is untouched.** `.github/workflows/verify.yml` keeps `permissions: contents: read`, its 15-minute timeout, its step sequence, and its `git diff --exit-code` bundle-freshness step. FR-067 requires this explicitly, and `tests/manifest.test.ts` asserts it by sha256.

---

## 3. Which job each action runs in, and why that is not free choice

A GitHub Actions job gets a **fresh runner and an empty workspace**. Nothing a job writes to disk survives it, and `needs:` establishes ordering, not a shared filesystem. `actions/upload-pages-artifact` is a composite action that runs `tar --directory "$INPUT_PATH"` against **the current job's workspace** — so `site/dist` has to be uploaded by the job that built it.

| Job | Step | Action | Consequence |
| --- | --- | --- | --- |
| `build` | checkout | `actions/checkout` | `persist-credentials: false` — nothing here talks to git over the network. |
| `build` | Node | `actions/setup-node` | `cache-dependency-path: site/package-lock.json`, because setup-node's cache otherwise defaults to the **repository root's** lockfile — this job installs the site's, so the default would key the cache on a file no step in the job reads. |
| `build` | install | `npm ci` (`working-directory: site`) | FR-068: a clean install from the site's own committed lockfile. Never `npm install`. |
| `build` | type-check | `npm run check` | FR-069: `astro check`. Required, not optional — `astro build` does **not** type-check (verified: a `const n: number = "x"` builds clean), so this is the only step that catches a type error in a page. |
| `build` | test | `npm test` | The site's own assertions, which no other job in the repository runs. |
| `build` | build | `npm run build` | `astro build` **followed by** `scripts/assert-build.mjs`, so the artefact's shape is checked by the same step that produced it — the next step uploads whatever this leaves behind, unexamined otherwise. |
| `build` | upload | `actions/upload-pages-artifact` | **This is the step that makes the two-job split work**, and it must be in `build`. `path: site/dist`, uploaded as-is: no adapter, no server entry point, nothing Pages-specific generated into it. The action names the artefact `github-pages`, which is the name `deploy-pages` looks for, so its default name is load-bearing and left alone. Gated `if: github.event_name == 'push'`. |
| `deploy` | read metadata | `actions/configure-pages` | `enablement: false`. See §5. |
| `deploy` | deploy | `actions/deploy-pages` | `id: deployment`, so the job's `environment.url` reports the address it published to (AC-024). |

**Why `configure-pages` is in `deploy` and not `build`.** It calls `repos.getPages`, which is a Pages-scoped API read. In `build` — which holds only `contents: read` — that read is not authorized; in `deploy` it is covered by `pages: write`. So the permission argument and the artifact argument point at different jobs for the two remaining actions, and neither is a stylistic choice.

**What the deploy job does not need, and does not have.** It does not check out the repository: `deploy-pages` calls only the Pages API (`pages/deployments`, `pages/builds`) and downloads the artefact through the run's own runtime token (`ACTIONS_RUNTIME_TOKEN`), not `GITHUB_TOKEN`. Verified against the pinned action's bundle, not inferred.

**The concurrency group is on the job, not the workflow.** GitHub's Pages template puts a `pages` group at workflow level, which also makes every pull-request build queue behind an in-flight deployment. Scoping `concurrency` to the `deploy` job keeps the guarantee that matters — one deployment at a time, `cancel-in-progress: false`, so the older commit can never finish last — without a gate waiting on a publish.

---

## 4. The pinned actions

Every `uses:` names a full 40-hex commit SHA. A tag or a branch is a supply-chain hole: version tags are mutable, and the tj-actions/changed-files attack in March 2025 re-tagged hundreds of versions to malicious commits across tens of thousands of repositories.

| Action | Tag | Commit SHA | Resolved from |
| --- | --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `git/ref/tags/v7.0.1` → `.object.type: commit` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` | `git/ref/tags/v7.0.0` → `.object.type: commit` |
| `actions/upload-pages-artifact` | `v5.0.0` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | `git/ref/tags/v5.0.0` → `.object.type: commit` |
| `actions/configure-pages` | `v6.0.0` | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | `git/ref/tags/v6.0.0` → `.object.type: commit` |
| `actions/deploy-pages` | `v5.0.1` | `368f82528645a54fb793d4d04e342629a3f51346` | `git/ref/tags/v5.0.1` → `.object.type: commit` |

All five resolved with `gh api repos/<action>/git/ref/tags/<tag>`, taking `.object.sha`; a `tag` object type would have been dereferenced once more to reach the commit. All five are **lightweight** tags, so the tag's SHA *is* the commit — no annotated-tag indirection. Each was then confirmed to exist as a commit in its own repository with `gh api repos/<action>/commits/<sha>` returning that exact SHA, which is also what rules out an impostor commit from a fork.

`actions/checkout` and `actions/setup-node` are the **same SHAs `verify.yml` already uses**, re-resolved and confirmed rather than copied. One action version per repository is a supply-chain property, not a convenience.

**No `oven-sh/setup-bun`.** `verify.yml` needs it because `npm run verify` shells out to `bunx openchamber-guest-bundle`. The site installs with npm and builds with `astro`, so this workflow does not.

**The `# vX.Y.Z` comment is required, not decorative.** `tests/manifest.test.ts` splits a `uses:` line on the first space, so a comment written `#v5.0.1` (no space) would be read as part of the reference and fail the SHA assertion. The space is load-bearing.

---

## 5. One factual correction, recorded rather than absorbed

`actions/configure-pages` accepts `static_site_generator` values **`nuxt`, `next`, `gatsby`, and `sveltekit`**. It does not accept `astro`.

Verified against the pinned `v6.0.0`'s own `action.yml` and `src/set-pages-config.js`: the documented input list is those four, and the `default:` branch of the generator switch **throws** `` `Unsupported static site generator: ${staticSiteGenerator}` ``. Two details make the omission the right call rather than a shrug:

- The throw is caught by `setPagesConfig`'s own try/catch and downgraded to a `core.warning`. So passing `astro` would produce a **permanent warning on every deploy and a step that does nothing** — not a failure, which is why it would survive review.
- `src/index.js` only calls `setPagesConfig` when the input is truthy, so omitting the input does not reach the switch at all. It is not "a warning we accept"; it is a code path never entered.

**The input is therefore omitted**, and `configure-pages` is used for what it actually does here: read the Pages site's metadata, export it, and **fail loudly when the repository is not configured for Actions-based publishing** — the misconfiguration §6 is about, caught before anything is published. `enablement: false` is stated explicitly rather than left to the default, because the alternative would create the Pages site and requires a credential this repository does not have and must not be given.

---

## 6. The published address, and the Pages `source` block

```
https://shaunburdick.github.io/mecha-turk/
```

`site: 'https://shaunburdick.github.io'` and `base: '/mecha-turk'` in `site/astro.config.ts`. **FR-005** requires the base path to be declared in exactly one place so a repository rename is one edit. Nothing in the workflow or the contract hard-codes the `/mecha-turk/` prefix; every internal link is built through the site's one base-path helper.

**The `source` block, and its reconciliation.** The repository's Pages configuration reports `build_type: "workflow"` *and* `source: {branch: "main", path: "/"}`. They are not in conflict **as behaviour** — with `build_type: "workflow"` the site is served from whatever the deploy workflow uploads, and the `source` block records the legacy branch-publish configuration the repository was created with. **Nothing has ever been published through it**: the address returned `404` ("Site not found") before this feature, which is the baseline `research.md` §1.2 records and AC-025 measures against.

It is not merely untidy, though. A residual branch source alongside `build_type: workflow` is the documented trigger for GitHub's managed `pages-build-deployment` Jekyll build firing on push alongside the real deployment, which logs a Node 20 deprecation warning this repository cannot edit, SHA-pin, or silence. So the reconciliation is a real task, not a cosmetic one.

**FR-066's obligation is that no stale branch-and-path setting is mistaken for the publishing mechanism.** Task **T-039** is the one-time repository-settings action, and it is **the product owner's to perform or authorise**: it mutates repository settings, not code, and this repository's own decision-making reserves it. The workflow does not depend on it either way — the workflow *is* the mechanism — but leaving the block invites exactly the misreading FR-066 names.

**The recommended command, not run by this change:**

```sh
gh api --method PUT repos/shaunburdick/mecha-turk/pages -f build_type=workflow
```

Three things a reviewer needs to know about it:

1. **It requires repository admin or maintainer** ("manage GitHub Pages settings"). The `gh` token available while this was written authenticates as `prompt-it-so`, whose permissions on this repository are `admin: false, maintain: false, push: true` — so **it would be rejected**. The owner must run it, or grant the token admin first.
2. **`source` is not a nullable field on this endpoint.** The `PUT` body documents `cname` as "string or null" and `source` as an object whose `branch` and `path` are both *required*; sending `source: null` fails validation. Clearing the residual block is therefore a matter of re-asserting `build_type: workflow` so the setting stops describing the mechanism.
3. **Settings → Pages → Build and deployment → Source → "GitHub Actions"** is the equivalent path in the UI and is reported by owners as the one that reliably clears the residual branch source.

Whichever is used, T-039 is verified by re-reading `gh api repos/shaunburdick/mecha-turk/pages` and confirming `build_type: "workflow"` with no branch source left describing the mechanism. **Note that until this is done, the first deployment is expected to succeed** — the artifact deploy path is independent of the residual block — so a green `site.yml` run is not evidence that T-039 was done, and the two must not be conflated.

---

## 7. What this workflow deliberately cannot do

- **It does not build the panel or the service, and does not run the repository's gate.** `verify.yml` runs `npm run verify` on the same two triggers and does that job. Duplicating it here would double the longest job in the repository to re-prove the same thing; the site workflow exists for the `site/` directory precisely because the root gate does not reach it (FR-070).
- **It does not lint.** Neither `astro check` nor `astro build` is ESLint, and the site's own gate is `astro check` + `npm run build` + the artefact assertion. A page with a style violation this repository's root ESLint config would flag is not caught here.
- **It does not read `src/`, `panel/`, `service/`, or `tests/`.** It checks the repository out only because the site lives inside it.
- **It does not deploy on a pull request, ever.** Not as a preview, not behind a flag, not under `pull_request_target`. The artefact upload is push-gated for the same reason the deploy job is: a pull request, including a fork's, must not leave a deployable artefact behind.
- **It carries no credential of any kind.** No PAT, no API token, no `ASTRO_KEY`. `configure-pages` runs with `enablement: false` precisely so it never reaches the create path, which is the one that would need one.
- **It proves nothing about the published site.** Every claim here is about a build. Whether the base path survives contact with Pages — the failure mode that works perfectly in `astro dev` and 404s every asset in production — is not observable until the site is deployed and fetched. That is T-040 and T-041, after the merge.