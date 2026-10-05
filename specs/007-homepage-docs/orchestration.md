# Orchestration: Documentation Site and MIT Licence (007)

**Feature**: `specs/007-homepage-docs` · **Issue**: https://github.com/shaunburdick/mecha-turk/issues/11
**Branch**: `issues-11-homepage-docs` (no upstream yet)
**Coordinator**: project-manager · **Started**: 2026-10-05
**Scope decision (product owner)**: run **all 8 waves in one session**. Report at each wave boundary, do not block.

---

## Current Wave

**Wave 0 — Repository hygiene.** 4 tasks, T-000a – T-000d. Not started.

## Tasks

| Wave | Tasks | Agent shape | Status |
|---|---|---|---|
| 0 | T-000a–T-000d | 1 dispatch (4 `[P]`-marked, trivial) | pending |
| 1 | T-001–T-006 | 1 dispatch (skeleton + build) | pending |
| 2 | T-007–T-010 | 1 dispatch (contract + assertion script) | pending |
| 3 | T-011–T-015 | 1 dispatch (declarations — the gate everything serializes behind) | pending |
| 4 | T-016–T-026 | **4 parallel dispatches** | pending |
| 5 | T-027–T-030 | 1 dispatch, **serial** — only wave touching `src/` | pending |
| 6 | T-031–T-036 | **3 parallel dispatches** | pending |
| 7 | T-037–T-039 | 1 dispatch | pending |
| 8 | T-040–T-045 | 1 dispatch — **post-merge, blocked until PR merges** | pending |

46 tasks total. Full detail in `tasks.md`.

## Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-05 | Constitution **not** amended; stays v1.3.0 | §Governance permits a spec to add constraints without weakening principles. No principle text becomes obsolete — this adds a static site and a licence file, not a runtime, adapter, or policy gate. Recorded in 007 §Clarifications Q4, `research.md` R-8. |
| 2026-10-05 | Site is **canonical** for docs; README becomes a summary | Product owner. Makes FR-049 ("no substance left in both") and FR-002 (site authoritative where a claim appears twice) enforceable. |
| 2026-10-05 | Landing + exactly 4 doc pages; **no** screenshots, FAQ page, or search | Product owner. Keeps FR-009 true and avoids committed PNGs that go stale. |
| 2026-10-05 | Build on PR, **deploy on push to `main`** | Product owner. A broken site fails the PR check before it reaches the homepage. |
| 2026-10-05 | Both README and About tab link to the site | Product owner. The About tab half forces `npm run build` + recommitted `panel/main.js` (invariant 1). |
| 2026-10-05 | MIT holder: `Copyright (c) 2026 Shaun Burdick`, full MIT text | Product owner ruling Q1. Fallbacks recorded as **closed**, not deferred. |
| 2026-10-05 | Fix the stale `network` capability row **here**, not later | Product owner ruling Q2 → new FR-077. The README currently tells the reader the dialog "asks for exactly these four things"; `network` was removed by product-owner order 2026-09-30 (invariant 3). |
| 2026-10-05 | Debug page documents panel + files, **no** HTTP endpoint | Product owner ruling Q3. The service listens on a host-provided loopback port and token; documenting `curl` would document an unsupported path and put a token in shell history. |
| 2026-10-05 | `static_site_generator: astro` **omitted** from `configure-pages` | Architect's factual correction to the PM's brief. Verified against the action's own `action.yml`: accepts only `nuxt`, `next`, `gatsby`, `sveltekit`; `astro` hits a `default:` throw that is caught and downgraded to a warning. Would have emitted a permanent warning and achieved nothing. |
| 2026-10-05 | `trailingSlash: 'always'` is **load-bearing**, not cosmetic | Measured on a real build: with it unset, `BASE_URL`'s trailing slash is absent, a naive concat emits `/mecha-turkinstall/`, and a `new URL` join silently drops the base. **Build goes green, site is wrong.** |
| 2026-10-05 | Root Node floor **not** touched here | It is issue #17, filed separately. The Astro site's own `engines.node: ">=22.12.0"` is in scope (FR-008). |

## Blockers

None.

## Verification

- **Baseline** (2026-10-05, pre-Wave-0): `npm run verify` **GREEN** — build → lint → typecheck → **1303 tests / 106 files**. `npm ci` → 259 packages, 0 vulnerabilities. npm warns `unrs-resolver@1.12.2` has an uncovered postinstall script under `allow-scripts` — noted, not blocking.
- **Known drift**: `AGENTS.md` documents 1302 tests; actual is 1303. Pre-existing, one-test doc drift from the reduction pass `d2d3f40`. Flagged, **not chased** (product owner, 2026-10-05).
- **Site gate**: `cd site && npm run check && npm run build && node scripts/assert-build.mjs`. This is the site's **only** gate — root `npm run verify` cannot reach a self-contained subproject (FR-069).

## Budget

| Limit | Default | Consumed | Status |
|---|---|---|---|
| Session (product owner overrode: all 8 waves) | — | — | acknowledged |
| Per-wave warning | 200K input tokens / 16 min | — | monitoring |
| Per-wave hard stop | 250K input tokens / 20 min | — | monitoring |

The product owner was told that PM is the heaviest-context agent in this harness and that a forced handoff may still occur if quality degrades. Standing instruction: if context degrades, write `pm-handoff.md` and stop rather than pushing through.

## Next Action

Dispatch Wave 0 (T-000a–T-000d) to `modern-architect-engineer`. Then run `npm run verify` at the wave boundary and checkpoint.

---

## Wave log

_(appended per wave)_