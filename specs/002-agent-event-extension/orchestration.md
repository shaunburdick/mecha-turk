# Orchestration State: 002-agent-event-extension

**Durable state file — a fresh coordinator must be able to resume from this file alone.**

## Current Wave

**M5 VALIDATED 2026-09-28** — full loop proven live: bind → poll (first-scan replay) → events → relay → dispatch → TWO PM worktree sessions (issues #1 + #2). tasks.md M5 checked. Slice 2 (M6–M9) awaits product-owner go-ahead.

Session fixes that got M5 there (all on branch): `ad052da` M1–M4 build · `7ef0ba1` banner+adoption · `6dd17e3` repos pane mount+consent · `ea89d39` accounts assign · `0f101ad` adopt-on-duplicate+purge · `607380d` scan status+refresh+identity · `7a814c4`/`203d49e` events parser+recovery · `0cbfc8a` first-scan replay (product decision 2026-09-28). Test count: 229 → 489 green.

Bug family lesson (3x): writer/validator mismatches in store parsers — now covered by writer→reader round-trip test class (scan-state + events).

## Branch

`001-agent-event-orchestrator` (local-only, no remote). HEAD `421a4f0` (T-009o committed). Interrupted T-009p work stashed as `stash@{0}` ("interrupted T-009p work") — do not restore unless asked. 429/429 tests green at HEAD.

## Tasks

tasks.md re-cut: M1–M4 = Slice 1. **M1–M4 COMPLETE 2026-09-27, commit `ad052da`** (service poll loop, bindings store+routes, events relay+routes, panel Repos tab, panel relay driver + dispatch wiring; verify green 429/429 + lint/tsc clean; both bundles rebuilt). M5 = operator live test. M6–M9 deferred until M5 passes. Debt list recorded in tasks.md.

## Decisions

- All prior decisions stand (architecture, contracts, G1). NEW: MVP bar level-set; validate-before-harden; reviews only at credential-touching points; findings ≥ High severity only are fixed immediately, everything else → debt list; no remediation loops.
- Review cadence: single final review before the operator's live test, focused on "will it break on the happy path".

## Blockers

None open. T-033/T-034 live-proof scheduling unchanged in spirit — superseded by slice-based live validation (M5).

## Verification

- Last verify: 429/429 tests, 28 files, green at HEAD 421a4f0 (2026-09-27).
- Per-slice: npm run verify green + operator smoke test.

## Budget

N/A under MVP bar; watch for any single dispatch exceeding ~1 hour.

## Next Action

1. **Slice 2 (M6–M9)** on product-owner go: M6 mention trigger (comment scan for `@login`, bot-author ignored) · M7 review-request trigger · M8 runs list UI + retry · M9 agent verification (openSession read-back, warn if not project-manager).
2. Debt list grows only — add: durable dedupe index (eviction boundary >500 dispatched), shared/redaction move (T-036), legacy/mvp dispatch unification, stale binding-row status on manual refresh, second-account "add account" affordance.

## Quality Rules (adjusted for MVP bar)

`npm run verify` green; no suppressions; no `any`; doc comments on public symbols. No dual reviews; no remediation loops; contract amendments only when code/contract drift matters at run time. Conventional Commits + `Generated-By: opencode (model: mimo-v2.6-flash)`.
