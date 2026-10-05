# Contract: the Pages publish workflow

**Feature**: `specs/007-homepage-docs` · **Date**: 2026-10-05 · **Binds**: `.github/workflows/site.yml`

Two requirements make this a contract rather than a comment. **FR-067** requires every action to be SHA-pinned and the publish job to hold *only* the permissions a Pages deployment needs; **FR-066** requires that publishing not depend on branch-based publishing and that the repository's stale Pages `source` block be reconciled. A future contributor who widens the permissions, unpins an action, or adds a trigger has broken an approved requirement, and the only thing that tells them so is this file plus a test (`tests/docs-sync.test.ts`, task T-033).

---

## 1. Triggers

| Event | Runs | Why |
| --- | --- | --- |
| `pull_request` | `build` only | FR-065: the site is built on every pull request and a build failure fails it. The deploy job is gated on `github.event_name == 'push'`, so **a pull request — including one from a fork — can never reach `deploy-pages`.** |
| `push` to `main` | `build`, then `deploy` | FR-066: published when the default branch is updated. The build runs again on the merge because a green pull request does not prove the merge landed as reviewed. |
| `workflow_dispatch` | *(not declared)* | **Deliberate.** Manual publishing would make it possible to publish something that was never built by the gate. If the owner wants a manual re-deploy, the correct shape is `deploy` with a `needs: build` that is re-run, not a new trigger. |

**Publishing mechanism**: artifact-based, via `actions/upload-pages-artifact` + `actions/deploy-pages`. Branch-publish is **not** used and must not be configured.

---

## 2. Permissions — the whole contract in one table

| Scope | `build` | `deploy` | Rationale |
| --- | --- | --- | --- |
| `contents` | `read` | `read` | Both check the repository out. Neither writes to it. |
| `pages` | — | `write` | The Pages deployment itself. Nothing else needs it. |
| `id-token` | — | `write` | `actions/deploy-pages` exchanges a GitHub OIDC token for a Pages deployment token. This is the single most dangerous permission in the repository: **it must never be reachable from a pull-request-triggered run.** |

**Workflow level**: `permissions: contents: read`. Every other scope is `none` by default at the workflow level and is granted **per job** — the deploy job's two write scopes are the only widening in the repository.

**The existing gate is untouched.** `.github/workflows/verify.yml` keeps `permissions: contents: read`, its 15-minute timeout, its step sequence, and its `git diff --exit-code` bundle-freshness step. FR-067 requires this explicitly, and `tests/docs-sync.test.ts` asserts it byte-for-byte.

**Why two jobs and not two workflows**: the deploy job needs the built artefact, so sharing a workflow lets it `needs: build` and upload what the gate already built. Two files would duplicate the build steps and let them drift.

---

## 3. The action sequence

| Step | Action | Pinned to | Contract |
| --- | --- | --- | --- |
| Checkout | `actions/checkout` | commit SHA, `# vX.Y.Z` comment | `persist-credentials: false` — nothing in this workflow talks to git over the network, so the token is never written into the workspace's git configuration. Matches `verify.yml`. |
| Node | `actions/setup-node` | commit SHA | `node-version: '24'`, the major `verify.yml` already uses and is verified green on. FR-073 requires the site's floor to be satisfied by a release the repository already verifies; Node 24 ≥ 22.12.0, and **no new Node version is introduced anywhere**. `cache: npm` keyed on the site's lockfile. |
| Install | `npm ci` | — | `working-directory: site`. **FR-068**: a clean install from the site's own committed lockfile, so the build is reproducible from what is committed. Never `npm install`. |
| Type-check | `npm run check` | — | **FR-069**: `astro check`. Required, not optional — the build job is the site's **only** gate, because the root `npm run verify` cannot reach a self-contained subproject. `astro build` does **not** type-check (verified: a `const n: number = "x"` builds clean), so this step is the only thing that catches a type error in a page. |
| Build | `npm run build` | — | `astro build` followed by the build-output assertion script, so the artefact's shape is checked by the gate that produced it. |
| Configure Pages | `actions/configure-pages` | commit SHA | **No `static_site_generator` input** — see §5. Its outputs (`base_url`, `origin`, `host`, `base_path`) are what the deploy step reports the published address from. |
| Upload | `actions/upload-pages-artifact` | commit SHA | `path: site/dist`. The whole directory, uploaded as-is: no adapter, no server entry point, no generated Pages-specific files. |
| Deploy | `actions/deploy-pages` | commit SHA | `environment: github-pages` with `url: ${{ steps.deployment.outputs.page_url }}`, so the deployment **records the address it published to** (AC-024). |

**Every `uses:` carries a 40-hex commit SHA.** A tag or a branch is a supply-chain hole, and the repository's own `verify.yml` has pinned this way since it was written.

---

## 4. The published address

```
https://shaunburdick.github.io/mecha-turk/
```

`site: 'https://shaunburdick.github.io'` and `base: '/mecha-turk'` in `site/astro.config.ts`. **FR-005** requires the base path to be declared in exactly one place so a repository rename is one edit. Nothing in the workflow, the contract files, or a page hard-codes the `/mecha-turk/` prefix; every internal link is built through the site's one base-path helper.

**The Pages `source` block, and its reconciliation.** The repository's Pages configuration today reports `build_type: "workflow"` *and* `source: {branch: "main", path: "/"}`. They are not in conflict as behaviour — with `build_type: "workflow"` the site is served from whatever the deploy workflow uploads, and the `source` block records the legacy branch-publish configuration the repository was created with. **Nothing has ever been published through it**: the address returned `404` ("Site not found") before this feature, which is the baseline `research.md` §1.2 records and AC-025 measures against.

FR-666's obligation is that **no stale branch-and-path setting is mistaken for the publishing mechanism.** The reconciliation is a one-time repository-settings action (task T-039): confirm the Pages source reads **GitHub Actions**. The workflow does not depend on it either way — the workflow *is* the mechanism — but leaving the block as it stands invites exactly the misreading FR-066 names.

---

## 5. One factual correction, recorded rather than absorbed

`actions/configure-pages` accepts `static_site_generator` values **`nuxt`, `next`, `gatsby`, and `sveltekit`**. It does not accept `astro`.

Verified against the action's own `action.yml` and `src/set-pages-config.js` on `main`: the documented input list is those four, and the `default:` branch of the generator switch **throws** `` `Unsupported static site generator: ${staticSiteGenerator}` ``. The throw is caught by `setPagesConfig`'s own try/catch and downgraded to a `core.warning` — so passing `astro` would produce a **permanent warning on every deploy and a step that does nothing**, not a failure.

**The input is therefore omitted**, and `actions/configure-pages` is used for what it is actually for here: enabling the Pages site and exporting its metadata as outputs. Nothing in the specification depends on the input; FR-066 requires that publishing not depend on branch-based publishing, which an artifact upload satisfies outright.

This is a factual correction to the feature brief, recorded here so a reader who expected the input finds the reasoning rather than the omission.

---

## 6. What this workflow deliberately cannot do

- **It does not build the panel or the service.** `verify.yml` does that, and the two must not be merged: the site job's whole point is that it can hold write permissions the read-only gate must not (FR-070, R-5 in `research.md`).
- **It does not read the site directory.** `verify.yml` lints and type-checks `src/`, `panel/`, `service/`, and `tests/`; the site is excluded from both scopes (FR-070).
- **It does not deploy on a pull request, ever.** Not as a preview, not behind a flag, not under `pull_request_target`. FR-055 requires the site be served only from the address FR-005 names.
- **It does not carry a credential of any kind.** No PAT, no API token, no `ASTRO_KEY`. The site builds without one and the workflow supplies none.
