# Plan: Repository reorganization — extension at the root

**Feature**: `specs/003-code-reorg` · **Date**: 2026-09-28
**Branch**: `code-reorg`

## Goal

The MVP shipped as an OpenChamber extension under `extension/`. Now that the
shape is settled, the repository itself becomes the installable unit: the
manifest, panel, service, and panel sources move to the repository root so a
user can install by pasting the GitHub repository URL into
Settings → Extensions → Add (git-URL installs read `package.json` +
the `openchamber` block at the repo root and run the committed bundles).
Alongside the move: drop dead spike-era material, publish a user-focused
`README.md`, and add an `AGENTS.md` for contributors and agents.

## Decisions (product owner, 2026-09-28)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Move `extension/{panel,service,src,README.md}` to the repository root; merge `extension/package.json` into the root `package.json`; drop npm workspaces | The repo root is the install unit for git-URL installs (OpenChamber docs: manifest at repo root, committed `panel/main.js` + `service/main.js`, no npm install at install time) |
| D2 | **Full identity rename** `mecha-turk-spike` → `mecha-turk`: package name, `contributes.panel.id`, `providerId`, and the `host.storage` key prefixes (`:project`, `:evidence`, `:ledger`) | Public package should carry the product name; product owner accepted that storage namespaces reset for existing installs |
| D3 | Remove `specs/001-agent-event-orchestrator` (superseded spike); keep `specs/002-agent-event-extension` (its contract fixture is read by `tests/consent.test.ts`) plus `.specify/` and `.opencode/` workflow tooling | Product owner chose "drop spike-era specs, keep workflow" |
| D4 | Keep `version: 1.0.0` in the merged manifest | `service/routes/health.ts` `SERVICE_VERSION` and `tests/service-server.test.ts` pin it; git-URL updates key off this field |
| D5 | SDK stays pinned exactly (`1.24.2`) in `dependencies` only — no duplicate `devDependencies` pin | Single manifest ends the root-vs-workspace dual-pin test; tests resolve the SDK through `dependencies` |

## Target layout

```text
├── package.json          # BOTH the npm dev package and the OpenChamber manifest
├── panel/                # index.html, main.ts, main.js (committed IIFE bundle)
├── service/              # main.ts, main.js (committed ESM bundle), server, routes, store, poll
├── src/                  # panel logic, one responsibility per module
├── tests/                # vitest suites + support fakes (paths rebased off the root)
├── specs/002-agent-event-extension/   # production spec (001 removed)
├── README.md             # user-focused: install by URL, configure, operate
├── AGENTS.md             # contributor/agent guide: layout, commands, invariants
├── tsconfig.json / eslint.config.mjs / .editorconfig / .env.example
└── .specify/ .opencode/  # spec-kit workflow tooling
```

## Constitution alignment (v1.3.0)

- **Principle V (minimal, self-hosted)** — the reorg removes the workspace
  indirection: one folder, one manifest, one copy into OpenChamber's data dir.
- **Principle VI (spec + verify before implementation)** — this plan and
  `tasks.md` precede the move; `npm run verify` gates every commit.
- **No principle weakened.** D2 (identity rename) is a product-identity
  decision with a stated migration impact (existing installs reset), not a
  change to autonomy, durability, audit, or security behavior.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Manifest at repo root is rejected by the host (spike-era note: root install once failed with `package.id should be kebab case` — the root had **no** `openchamber` block then) | `tests/manifest.test.ts` parses the root manifest with the official SDK parser and asserts kebab ids; final live install from the git URL is an operator step after merge |
| Rename misses a `mecha-turk-spike` literal (storage key drift breaks ledger/project reads) | Repo-wide grep gate in tasks; `npm run verify` runs the panel unit tests that assert the key constants |
| Bundled `panel/main.js` / `service/main.js` go stale after the rename | Rebuild is part of `npm run verify`; bundles are committed in the same commit as the rename |
| Tests keep stale `../extension/...` paths | Mechanical rebase + full suite green before commit 1 |
| npm lockfile still describes a workspace | `npm install` regenerates `package-lock.json` after the workspace key is dropped |

## Verification

1. `npm run verify` → build + lint + typecheck + test, zero suppressions.
2. `grep -rn "extension/"` over sources/tests/configs → no stale paths.
3. `grep -rn "mecha-turk-spike"` → zero occurrences outside git history.
4. Post-merge operator check: paste `https://github.com/shaunburdick/mecha-turk`
   into Settings → Extensions (recorded in tasks.md as an owner gate).
