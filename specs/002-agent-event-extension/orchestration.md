# Orchestration State: 002-agent-event-extension

**Durable state file — a fresh coordinator must be able to resume from this file alone.**

## Current Wave

**COMPLETE — pre-PR (2026-09-28)** — MVP M1–M9 all built, all checked in tasks.md, and **live-validated by the operator**: assignment, comment mention, issue-body mention, review request, runs list + retry, and agent verification all fired live (five dispatched events in the operator's store). docs-only closing pass on top of `4221da9`. Next action: PR to main, awaiting human merge.

**SLICE 2 COMPLETE (M6–M9) 2026-09-27** — M6/M7 in `e966894`, M8/M9 panel side in `6af4c00`. The loop now reads end to end: bind → poll → events → relay → dispatch → **runs list with retry** → **agent read-back banner**. tasks.md M1–M9 all checked.

**M5 VALIDATED 2026-09-28** — full loop proven live: bind → poll (first-scan replay) → events → relay → dispatch → TWO PM worktree sessions (issues #1 + #2). tasks.md M5 checked.

Session fixes that got M5 there (all on branch): `ad052da` M1–M4 build · `7ef0ba1` banner+adoption · `6dd17e3` repos pane mount+consent · `ea89d39` accounts assign · `0f101ad` adopt-on-duplicate+purge · `607380d` scan status+refresh+identity · `7a814c4`/`203d49e` events parser+recovery · `0cbfc8a` first-scan replay (product decision 2026-09-28) · `e966894` M6+M7+runs endpoints · `6af4c00` M8+M9 panel. Test count: 229 → 551 green.

Bug family lesson (3x): writer/validator mismatches in store parsers — now covered by writer→reader round-trip test class (scan-state + events). M8 extended the rule to the runs projection (`parseRunsBody` round-trips `EventRunRow`).

## Branch

`001-agent-event-orchestrator` (tracks `origin/001-agent-event-orchestrator`; `origin/main` is the base). Last code commit `4221da9` (issue-body mentions, v1.1.0) — this docs commit records it and follows it on the same branch. 558/558 tests green at `4221da9`.

## Tasks

tasks.md re-cut: M1–M4 = Slice 1. **M1–M4 COMPLETE 2026-09-27, commit `ad052da`** (service poll loop, bindings store+routes, events relay+routes, panel Repos tab, panel relay driver + dispatch wiring; verify green 429/429 + lint/tsc clean; both bundles rebuilt). **M6/M7 in `e966894`. M8/M9 panel side in `6af4c00`** (Runs section + retry, `agent-verify.ts` read-back; verify green 551/551 + lint/tsc clean; panel bundle rebuilt). **M1–M9 all `[x]` and live-validated 2026-09-28** (issue-body mentions in `4221da9`, v1.1.0). tasks.md carries the per-task evidence; MVP-DEBT entries there record what each slice deliberately did not do.

## Decisions

- All prior decisions stand (architecture, contracts, G1). NEW: MVP bar level-set; validate-before-harden; reviews only at credential-touching points; findings ≥ High severity only are fixed immediately, everything else → debt list; no remediation loops.
- Review cadence: single final review before the operator's live test, focused on "will it break on the happy path".
- M9 is **warn-only** (the re-cut's explicit call, superseding FR-029's `blocked:agent-mismatch`): the panel records and warns, never blocks; the service-side mirror is deferred to the debt list. quickstart V6 updated to the shipped behavior.

## Blockers

None open. T-033/T-034 live-proof scheduling unchanged in spirit — superseded by slice-based live validation (M5).

## Verification

- Last verify: **558/558 tests, 38 files, green at HEAD `4221da9` (2026-09-28)**: build (both bundles), lint 0 errors/0 warnings, typecheck clean, secret scans green. Docs-only closing pass re-verified after the documentation sweep.
- Operator live validation 2026-09-28: **M1–M9 all fired live** — assignment, comment mention, issue-body mention, review request, runs list + retry, agent verification (five dispatched events in the operator's store).
- Per-slice: npm run verify green + operator smoke test.

## Budget

N/A under MVP bar; watch for any single dispatch exceeding ~1 hour. M9's read-back shares the dispatch slot with a hard 15 s bound — one extra context switch per dispatch, accepted for the MVP.

## Next Action

1. **PR to main, awaiting human merge.** All M-tasks checked and live-validated; verification green at `4221da9`.
2. Debt list grows only (tasks.md is the single list — it now carries the pre-M8 candidates and the M8/M9 additions; pick from there, not from this file).

## Quality Rules (adjusted for MVP bar)

`npm run verify` green; no suppressions; no `any`; doc comments on public symbols. No dual reviews; no remediation loops; contract amendments only when code/contract drift matters at run time. Conventional Commits + `Generated-By: opencode (model: mimo-v2.6-flash)`.
