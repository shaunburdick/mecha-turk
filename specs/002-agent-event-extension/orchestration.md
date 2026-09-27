# Orchestration State: 002-agent-event-extension

**Durable state file — a fresh coordinator must be able to resume from this file alone.**

## Current Wave

MODE CHANGE 2026-09-27 (product owner): MVP bar = "works reliably for me, self-hosted". Over-building/over-testing explicitly rejected. tasks.md RE-CUT to Slice 1 (M1–M5, live loop today) / Slice 2 (M6–M9) / Debt list. Wave 2 remediation stopped mid-flight; partial commits landed and are green.

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

1. **M5: operator live test on their OpenChamber** — restart/reinstall extension from `extension/`, verify account connect, add a repo binding (repo → account → project → assignment ✓), open panel, assign an issue in the test repo, observe event → dispatch → worktree session.
2. On pass: Slice 2 (M6–M9). On failure: fix forward, no ceremony.
3. Debt list grows only.

## Quality Rules (adjusted for MVP bar)

`npm run verify` green; no suppressions; no `any`; doc comments on public symbols. No dual reviews; no remediation loops; contract amendments only when code/contract drift matters at run time. Conventional Commits + `Generated-By: opencode (model: mimo-v2.6-flash)`.
