# Tasks: Repository reorganization — extension at the root

**Feature**: `specs/003-code-reorg` · **Date**: 2026-09-28
**Branch**: `code-reorg` · **PR**: https://github.com/shaunburdick/mecha-turk/pull/5 (open, awaiting human merge — Waves 1–3 complete)

Convention: `[P]` = parallel-safe with other `[P]` tasks in the same wave.
Every wave ends with `npm run verify` (build → lint → typecheck → test).

## Wave 1 — Move the install unit to the root

- [x] T001 `git mv extension/panel panel`, `git mv extension/service service`, `git mv extension/src src`, `git mv extension/README.md README.md` (history-preserving moves)
- [x] T002 Merge `extension/package.json` into the root `package.json`: single package named `mecha-turk`, `version: 1.0.0`, the `openchamber` manifest block, `build`/`build:panel`/`build:service` scripts inlined, `dependencies["@openchamber/sdk"]` pinned exactly, dev toolchain in `devDependencies`, **no** `workspaces` key; remove `extension/package.json`
- [x] T003 [P] Rebase config paths: `tsconfig.json` include → `src/**`, `panel/**`, `service/**`, `tests/**`; `eslint.config.mjs` ignores → `panel/main.js`, `service/main.js`; `.gitignore` comment paths
- [x] T004 [P] Rebase test paths: `../extension/src/` → `../src/`, `../extension/service/` → `../service/`, `extension/package.json` → `package.json`, `resolve(ROOT, 'extension', …)` → `resolve(ROOT, …)`, and every other `extension/` literal in `tests/`
- [x] T005 [P] Rework `tests/manifest.test.ts` for the single merged manifest (drop the dual-pin workspace test, keep SDK exact-pin and official-parser assertions) and fix the `--workspace extension` comment in `tests/bundle.test.ts`
- [x] T006 Regenerate `package-lock.json` (`npm install`) and run `npm run verify` → **commit 1** (`fb56a94`)

## Wave 2 — Identity rename to `mecha-turk`

- [x] T007 Rename package name and `contributes.panel.id` to `mecha-turk` in `package.json`
- [x] T008 [P] Rename literals in sources: `providerId` in `src/session.ts`, storage keys in `src/project-actions.ts` (`:project`), `src/evidence.ts` (`:evidence`), `src/ledger.ts` (`:ledger`)
- [x] T009 [P] Update assertions: `tests/manifest.test.ts` panel-id/provider-id expectations; `.env.example` key reference and spike wording; user-visible "Mecha Turk Spike" copy (panel title, status banner, dispatch frame)
- [x] T010 Grep gate: `grep -rn "mecha-turk-spike"` returns nothing outside this spec; rebuild bundles (`npm run build`); `npm run verify` → **commit 2** (`da4e818`, sources + rebuilt `panel/main.js` together — `service/main.js` unchanged, no service-side id)

## Wave 3 — Cleanup and documentation

- [x] T011 Remove `specs/001-agent-event-orchestrator/` (superseded spike history; only `src/evidence.ts` cited it — comment repointed at the invariant)
- [x] T012 [P] Write root `README.md` — user-focused: what Mecha Turk does, install by pasting the repo URL, capability approval, account + repository setup, first dispatch, security/privacy notes, uninstall, troubleshooting; dev commands point to `AGENTS.md`
- [x] T013 [P] Write root `AGENTS.md` — layout, `npm run verify` gate, committed-bundle rule, zero-suppression rule, capability rules (service/network are implied, never declared), storage/secret invariants, spec-kit workflow, module maps, commit/attribution conventions
- [x] T014 [P] Update `specs/002-agent-event-extension/quickstart.md` build/install steps for the root layout (001 references removed); repo-wide grep for stale `extension/` paths in living docs/config → `npm run verify` → **commit 3**

## Wave 4 — Owner gates (not agent-executable)

- [ ] T015 **Operator**: after merge, paste `https://github.com/shaunburdick/mecha-turk` into Settings → Extensions → Add and confirm approval dialog lists `sessions`, `prompt`, `service`, `network`, panel renders, service health OK (closes the git-URL install assumption this reorg exists for)
- [ ] T016 **Operator**: replace the existing folder install of `extension/` with the git-URL install; confirm the fresh `mecha-turk` storage namespace (project picker empty, ledger restarts) per D2 migration impact
