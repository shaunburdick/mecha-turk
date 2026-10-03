# Orchestration: 004 Layered Starting Prompt (v1.4.2) — Phase 6

**Status**: Wave 0 — awaiting user confirmation to start Wave 1
**Branch**: `keen-zebra` (protected: `main`, `master`, `develop` — never commit to them)
**Owner**: project-manager (driving orchestration in-session; user chose this over handoff)
**Started**: 2026-10-02

## Inputs (authoritative)

| Artifact | Path | Version |
|---|---|---|
| Spec | `specs/004-starting-prompt/spec.md` | **v1.4.2** — approved text; v1.4.2 is a documentation-only correction (FR-085's floor reachability) |
| Plan | `specs/004-starting-prompt/plan.md` | synced to v1.4.2, decision D26 |
| Tasks | `specs/004-starting-prompt/tasks.md` | **22 active, 22 checked** (T-017→T-039, T-022 withdrawn; T-039 added at the Wave-3 checkpoint) |
| Data model | `specs/004-starting-prompt/data-model.md` | — |
| Research | `specs/004-starting-prompt/research.md` | 1 open default (R-2/D22) |
| Contract | `specs/004-starting-prompt/contracts/layered-prompt.md` | §4 rule 3 figures at v1.4.1; §4 rule 3 reachability at v1.4.2 |
| Contract | `specs/005-panel-ia/contracts/account-display-name.md` | *Account Profile Write*, 005 v1.10.0 |
| Constitution | `.specify/memory/constitution.md` | v1.3.0 |
| Agent guide | `AGENTS.md` | binding |

## Wave plan

| Wave | Tasks | Mode | Boundary |
|---|---|---|---|
| **1** — composed snapshot (service core) | T-017 → T-018 | sequential | `npm run verify` + `service/main.js` rebuilt |
| **2** — two new tiers + wire | T-019…T-026 (**∥** five-wide) → T-027 | parallel tracks G/A/W | verify + both bundles |
| **3** — panel read/compose/refuse/render | T-028…T-031 (**∥** four-wide) | parallel after T-027 | verify + `panel/main.js` |
| **4** — proof, docs, gate | T-033 ∥ T-035 ∥ T-036 ∥ T-037, then T-034 sequential | parallel + 1 pair | **release-candidate gate** |

**Critical path (9)**: T-017 → 018 → 019 → 020 → 021 → 030 → 032 → 035 → 038
**Co-ship edge**: T-024/25/26 → T-027 (closed reader refuses a present reference lacking `promptSources` — writers land first)
**Cut line (if delivery is cut)**: Wave 1 + Track W + T-027 + T-033

## Tasks

| ID | Wave | Status | Owner | Notes |
|---|---|---|---|---|
| T-017 | 1 | done (e32c99d) | modern-architect-engineer | shared `PromptSource` vocabulary, `src/prompt.ts` |
| T-018 | 1 | done (e32c99d) | modern-architect-engineer | resolver + stacked snapshot; `promptSnapshotOf` → `promptTierOf` rename |
| T-019…T-021 | 2 | pending | — | Track G: config field (global tier) |
| T-023 | 2 | pending | — | Track A: account record member + **profile PUT** (absorbed T-022) |
| T-024…T-026 | 2 | pending | — | Track W: wire/projection writers |
| T-027 | 2 | pending | — | closed reader (`src/prompt-wire.ts`) — after T-024/25/26 |
| T-028…T-031 | 3 | pending | — | panel ∥ (T-031 depends on T-023) |
| T-032 | 3 | pending | — | merge point |
| T-033…T-038 | 4 | pending | — | T-034 sequential after T-033 (same test file) |

## Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-02 | **Layered, not fallback** — global → account → binding → frame | Owner ruling, issue #10; amends 004 FR-072's reserved fallback |
| 2026-10-02 | **All three tiers now**, no account-tier deferral | Owner scope fix before specification |
| 2026-10-02 | **Amend 004 in place** + scoped 005/006 amendments | Owner chose over a new `specs/00X-` dir |
| 2026-10-02 | **No migration/backcompat** — feature never released | Owner note; evidence: 0 tags, `version` 0.0.1, PR #8. Row 32 |
| 2026-10-02 | **Profile `PUT /v1/accounts/:numericUserId`** `{displayName?, startingPrompt?}`; **`/display-name` retired outright**; planned `…/starting-prompt` never built | Owner ruling at 4–5 gate; overturns 005 plan D8; plan D26 |
| 2026-10-02 | FR-085 arithmetic → **6,004 / 9,004**; NFR-129 reworded (net route count unchanged) | Owner-approved at same gate, executed as v1.4.1 |
| 2026-10-02 | Budget floor = **failed attempt** via `dispatch.result` `problem`, not a new `blocked:` reason | Plan D22; `BLOCKED_REASONS` is 003's closed set |
| 2026-10-02 | One fence, no tier labels; one fingerprint over the composed block; global tier = 12th config field; account tier dies with its account | Owner-approved defaults, 004 rows 23/26/30/25 |
| 2026-10-02 | `displayName`-only write emits no audit row | Technical default; matches shipped handler, 005 declares no event type |

## Blockers & Escalations

_None._

## Verification

| Wave | Gate | Result | Evidence |
|---|---|---|---|
| — | phases 1–5 | **approved** | 004 v1.4.2 / 005 v1.10.0 / 006 v1.6.0, zero `[NEEDS CLARIFICATION]` |
| 1 | `npm run verify` | not run | — |
| 2 | `npm run verify` | not run | — |
| 3 | `npm run verify` | not run | — |
| 4 | `npm run verify` (release-candidate) | not run | — |

**Last gate result**: n/a — Wave 1 not yet dispatched.
**Failure classification taxonomy**: regression | environment/infrastructure | flaky | performance/timeout | blocked-by-permission.

## Budget

| Limit | Value | Consumed | Status |
|---|---|---|---|
| Input tokens per wave | 250,000 | ~0 (wave 1 not started) | OK |
| Warning threshold (80%) | 200,000 | — | — |
| Investigation duration / wave | 20 min | — | — |

**PM session note**: this session carried intake + phases 1–5 and is heavy. At the wave-1 checkpoint, if input tokens approach ~200K, stop and continue from this file in a fresh session rather than replaying transcript.

## Next action

**Await user confirmation of the wave plan, then dispatch Wave 1** (T-017 → T-018, sequential, one `modern-architect-engineer`) with: paths to spec v1.4.1 / plan / tasks / AGENTS.md / constitution, the `git-safety` + `ai-attribution` + `code-quality` + `style` skill instruction, scoped tests (`tests/prompt-validation.test.ts`, `tests/prompt-snapshot.test.ts`, `tests/service-runs-parse.test.ts`), and instruction to run `npm run build` + `npm run verify` and commit on `keen-zebra` with the `Generated-By` trailer.
