# PM Handoff: 004 Layered Starting Prompt (issue #10)

## Context
- **Spec**: `specs/004-starting-prompt/spec.md` — **v1.4.1**, APPROVED
- **Plan**: `specs/004-starting-prompt/plan.md` — decision **D26** is the profile-PUT ruling
- **Tasks**: `specs/004-starting-prompt/tasks.md` — 21 active, T-017→T-038 (T-022 withdrawn into T-023)
- **Orchestration**: `specs/004-starting-prompt/orchestration.md`
- **Constitution**: `.specify/memory/constitution.md` (v1.3.0)
- **Amended**: `specs/005-panel-ia/spec.md` **v1.10.0**, `specs/006-settings-crud/spec.md` **v1.6.0**
- **Branch**: `keen-zebra` (clean — no commits yet; 16 dirty spec files)

## Current State
- **Phase**: 6 (implementation) — **Wave 0**, awaiting user confirmation of the wave plan
- **Completed**: intake, phases 1–3 (spec), phases 4–5 (plan/tasks), all three gates approved
- **In Progress**: none — no sub-agent dispatched for implementation
- **Blocked**: none

## Decisions Made
1. **Layered, not fallback** — global → account → binding → event frame; amends 004 FR-072's reserved fallback chain (owner, issue #10).
2. **All three tiers built now** — no deferral of the account tier.
3. **Amend 004 in place**, with scoped amendments to 005 (FR-051/SC-105/AC-123, FR-066) and 006 (global tier = 12th config field). 006 untouched by the later route ruling.
4. **No migration, no back-compat** — the feature has never been released (0 tags, `version: 0.0.1`, landed only in PR #8). Recorded as 004 clarification **row 32**. Any legacy-projection clause was deleted as vacuous.
5. **Account tier rides a profile write**: `PUT /v1/accounts/:numericUserId`, body `{ displayName?, startingPrompt? }`, absent = unchanged, **closed two-member set** (11 custody/identity keys refused by name, `422`, no echo), neither member = `422` no-op, refusal writes nothing at all. **`/display-name` retired outright — no alias.** The planned dedicated `…/starting-prompt` endpoint **never exists**. Overturns 005 plan D8; recorded as plan **D26** and 004 row 33 / 005 row 36.
6. **Settled defaults**: one fence, no in-message tier labels; one `mtp-` fingerprint over the composed block; global tier = 12th config field (`next-cycle`); account tier deleted with its account.
7. **Budget floor** reports as a **failed attempt** via `dispatch.result` `problem` — not a new `blocked:` reason (003 owns that closed set). Plan D22.
8. **v1.4.1 corrections** (owner-approved at the 4–5 gate): FR-085 arithmetic → **6,004 / 9,004** (totals 7,680 / 10,680); NFR-129 reworded — accounts surface **net unchanged** (one added, one retired).
9. **`displayName`-only write emits no audit row** — technical default, matches shipped handler.

## Wave Plan (see orchestration.md)
| Wave | Tasks | Mode |
|---|---|---|
| 1 — composed snapshot | T-017 → T-018 | sequential |
| 2 — tiers + wire | T-019…T-026 ∥ → T-027 | 3 parallel tracks, file-disjoint |
| 3 — panel | T-028…T-031 ∥ → T-032 | 4-wide after T-027 |
| 4 — proof + gate | T-033 ∥ T-035 ∥ T-036 ∥ T-037, then T-034 | release-candidate gate |

Critical path: T-017 → 018 → 019 → 020 → 021 → 030 → 032 → 035 → 038
Co-ship edge: writers T-024/25/26 → closed reader T-027.

## Next Steps
1. Get user confirmation of the wave plan (orchestration skill requires it).
2. Dispatch Wave 1 to `modern-architect-engineer`; run `npm run verify` + rebuild bundles at the boundary; checkpoint with the user.
3. Repeat per wave; `code-quality-reviewer` earns a slot at Wave 2 (shared wire contract), the security-sensitive wave, and Wave 4 (pre-PR). `security-auditor` if secrets/credential paths are touched.
4. Pre-PR checklist → PR (ai-attribution footer) → human merge.

## User Preferences
- Product owner is **Shaun Burdick**; source request is GitHub **issue #10**.
- Prefers simpler shapes over defensive abstraction — rejected the dedicated endpoint, wants fields on the record.
- Explicitly flagged that nothing is released, so compat machinery is unwanted.
- Chose PM-driven orchestration in-session over handing off to the `orchestrator` agent.
- Approved gates quickly; wants the reasoning surfaced, not buried.
