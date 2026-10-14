# Implementation Plan: follow-up cross-session delivery (B+ park + auto-rearm)

**Branch**: `008-follow-up-delivery` (from `chore/sdk-2.3.1` @ 51dcb2d — PR #49, stacked) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md) (Gate 1 closed pass-with-cuts, decision-closed)

**Input**: Feature specification from `/specs/008-follow-up-delivery/spec.md` — the approved amendment to `specs/002-agent-event-extension/spec.md` (v1.17.0 → v1.18.0). Supporting records: [research.md](research.md), [challenge-ledger.md](challenge-ledger.md), [pm-handoff.md](pm-handoff.md). Issue: github.com/shaunburdick/mecha-turk/issues/48.

## Summary

Deliver follow-ups under the mandated **B+** semantics (product owner, 2026-10-13): a follow-up whose target session is not the panel's current session is **never navigated to, prompted, retried, or toasted against** — it enters the waiting state in the existing vocabulary (`session-busy`) and **re-arms by itself** the moment `onSession`/`ready.session` reports the target current and `onSessionLifecycle` reports it idle, delivering exactly once under the at-most-once record. **Every** prompt — first attempt, re-armed attempt, and retry alike — re-verifies the target is still current immediately before firing (FR-104; FR-105 keeps only the retry path's outcome, `navigation-refused`). The retry ladder shrinks to **transient host errors only**: `NO_SESSION`, a refused/unissuable navigation, and an over-budget composition park on the first refusal consuming no ladder attempt; a **raced** `SESSION_BUSY` is an observed-busy outcome — waiting state, no budget, never parked; mid-turn is never an attempt at all. A pre-amendment record carrying `parked: true, reason: 'session-busy'` re-arms into the waiting state on the next read, attempt history intact, re-derivable from the two existing fields (no new persisted field, state name, or store).

The delivered package also contains the **conforming in-place edits** to `specs/002-agent-event-extension/`: FR-104 and FR-105 rewritten in place, the AC-050/AC-051 spans replaced, the nine byte-exact companions (§3, including the `:8` historical marker) rewritten, the Status/Version header taken to v1.18.0, and one changelog entry written at conforming-edit time. The published site's two now-false passages (`site/src/pages/use.astro:144-149`, `:151-157`) are rewritten in the same delivery (FR-042 makes doc drift a merge gate).

Requirement count is unchanged: zero requirements, ACs, state names, or reason words are added or removed (the union stays at five).

**Stacked-branch contingency**: if PR #49 changes before merge, rebase `008-follow-up-delivery` onto it, re-run `npm run verify`, and re-check research.md §2's surface claims before continuing.

## Technical Context

**Language/Version**: TypeScript (strict), Node >= 24.15 toolchain; shipped `service/main.js` keeps the Node-20-era API surface.

**Primary Dependencies**: `@openchamber/sdk` pinned exactly at **2.3.1** (base of this branch, PR #49; engine floor `openchamber.engines.openchamber >= 2.0.0`). The design rests on the 2.x surface: `onSessionLifecycle` push (`{ sessionId, phase: 'started'|'completed'|'failure' }`), `onSession`/`ready.session` snapshots carrying `busy` — all **current-session-scoped by construction** (research.md §2). Vitest for the offline suite. The site is Astro with its own gate (root `verify` does not reach it; root suites read `site/src/pages/*.astro` as text only).

**Storage**: `host.storage` key `mecha-turk:dispatches`, schema `dispatch-attempts-1` — **unchanged**. The migration is a read-time transform over fields that already exist (`parked`, `reason`); no new persisted field, key, or store (FR-105's migration clause).

**Testing**: `npm test` (vitest, fully offline) against the `tests/support/` fake host; no live OpenChamber, real PAT, or network anywhere in the suite.

**Target Platform**: OpenChamber extension panel (iframe) plus the OpenChamber-hosted local service; committed bundles `panel/main.js` (IIFE) + `service/main.js` (ESM) ship as-is from git (invariant 1).

**Project Type**: extension + local service, single repo; panel-side change only — `service/` is untouched.

**Performance Goals**: relay cadence unchanged (`RELAY_POLL_INTERVAL_MS`); at most one event-driven immediate poll added (re-arm), sharing the existing in-flight serialization; no new timer.

**Constraints**: no new HTTP route, capability, configuration field, persisted field, state name, reason word, UI affordance, or host call beyond the already-declared surface (navigation, under B+, is removed from the delivery path entirely); zero lint suppressions and zero `any`; fail-closed posture preserved (unreadable record still blocks delivery); secrets rules untouched; committed bundles ship with their source in the same commit.

**Scale/Scope**: one panel module rewritten (`src/follow-up.ts`), one extended (`src/relay.ts`), one comment-corrected + one read-transform added (`src/dispatch-record.ts`), one state slot added (`src/panel-state.ts`), the fake host extended, three test suites reworked, two site spans rewritten, thirteen spans rewritten in 002's `spec.md` plus one changelog entry.

## Constitution Check

*GATE: passed for Gate 1 (spec §4) and re-checked here against the implementation shape.*

- **I (polling-first, contract-first)**: unaffected. No new provider contract; the host surface used is exactly the declared, SDK-pinned one; `openSession` remains in the host surface for its other caller (agent verification) but leaves the delivery path.
- **II (safe autonomy)**: delivery stays autonomous (judged like `start_work`); the waiting state is a wait with a visible reason, never a silent skip; FR-027's authorization clause stands byte-identical.
- **III (durable and idempotent)**: at-most-once holds unchanged — the durable record still stops a remount from re-sending (NFR-002); the waiting state consumes no budget and creates no second attempt path; the migration re-arms old parks from existing fields only.
- **IV (human-visible auditability)**: every not-yet-delivered follow-up is explainable from the panel's own words — the run row's waiting count, FR-036's queue, the trail row a raced-busy settlement writes, and park reasons.
- **V (minimal, self-hosted)**: no deployment, packaging, or capability change.
- **VI (specification before implementation)**: the conforming spec edits land with the code they describe (same delivery), and every behavioural assertion runs offline against the fake host.
- **VII (thin orchestration boundary)** — the tension point, resolved as the spec records (§4): the panel **holds no queued send** (the message is composed at attempt time under FR-104's measure-before-call clause), makes **no host call while waiting**, and **schedules nothing** — it reacts to the host's own current-session signals and attempts once. The waiting state is the opposite of a guest-side queue against the host's scheduler.

**No violations**, so the Complexity Tracking table stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-follow-up-delivery/
├── spec.md              # Gate 1 closed (input; not edited by this phase)
├── research.md          # 2.x surface facts (input)
├── challenge-ledger.md  # Gate 1 record (input)
├── pm-handoff.md        # decision provenance (input)
├── plan.md              # this file
└── tasks.md             # Phase 5 output (same handoff)

specs/002-agent-event-extension/   # conforming-edit target (v1.17.0 → v1.18.0)
├── spec.md             # FR-104, FR-105, AC-050, AC-051 spans + nine companions + header
├── quickstart.md       # §10's false view-switch sentence rewritten (Wave 4; FR-042, Gate 2)
└── changelog.md        # one v1.18.0 entry (003's amendment pattern)
```

### Source Code (repository root)

```text
src/
├── follow-up.ts           # REWRITE: waiting state, auto-rearm, every-prompt re-verification,
│                          #   transient-only ladder, raced-busy, migration read (FR-104/FR-105)
├── relay.ts               # EXTEND: lifecycle subscription at arm, event-driven re-arm poll,
│                          #   FIFO delivery in detection order under existing serialization
├── dispatch-record.ts     # CORRECT: the :78 session-busy doc comment dies; read-time
│                          #   migration of parked session-busy records (no new field)
└── panel-state.ts         # EXTEND: relay state slot for the current session's busy/idle

tests/
├── support/panel.ts       # EXTEND: fake-host onSessionLifecycle push + current-session switch driver
├── follow-up-lifecycle.test.ts   # REWRITE the FR-104/FR-105 section to amended AC-050/AC-051
├── follow-up-reoffer.test.ts     # UPDATE where pre-amendment park/ladder behaviour is encoded
└── relay-arming.test.ts          # UPDATE arming assertions (lifecycle subscription)

site/src/pages/use.astro   # REWRITE :144-149 (example) and :151-157 (parked paragraph)

panel/main.js, service/main.js    # rebuilt bundles, committed with their source (invariant 1)
```

**Supporting artifacts skipped, and why**: `data-model.md` (the persisted record's shape is unchanged — the migration is a read-time transform), `contracts/` (no interface consumed outside this repo is added or changed; the NDJSON/evidence wire contracts are untouched, invariant 10), `quickstart.md` (no new operator steps; verification is the offline suite plus the standing Gate-3 visual tools, which this change does not alter). `research.md` already exists from Gate 1.

## Key Decisions (chosen over the alternative each was made from)

1. **The waiting/idle observation lives in the relay's state slot** (`rt.state.relay`, beside the existing `currentSessionId`), fed by one `onSessionLifecycle` subscription registered and released with the relay arm (same discipline as `trackCurrentSession`). *Alternative*: folding the state update into `app.ts`'s existing lifecycle listener (the ledger writer) — rejected: relay arming/teardown owns the follow-up observation lifecycle, and coupling the ledger listener to delivery state would make one registration load-bearing for two unrelated consumers.
2. **Idle is observed, never assumed** — a delivery requires an idle fact: an `onSession`/`ready.session` snapshot with `busy: false`, or a lifecycle `completed` (replayed to late subscribers per research.md §2.3). `started`/`busy: true` marks busy; `failure`/`unknown` marks neither current-and-idle, so nothing delivers against it (fail closed).
3. **Re-arm is event-driven, not a second timer — and the poke is a lifecycle `completed` only**: when a lifecycle `completed` lands for the current session and follow-ups are outstanding, the listener pokes one immediate `pollRelay(rt)` through the same in-flight/`busy` guards the interval uses; an `onSession` snapshot alone pokes nothing, because the pane's own post effect carries `currentSessionId` in its dependency list (`PluginPane.tsx:948-956`, deps `[currentSessionId, lifecyclePhase, postToGuest]`), so a switch always posts a lifecycle event and the one `completed` poke is the whole trigger. *Alternative*: waiting for the next interval tick — rejected: FR-104 says the parked follow-up "re-arms by itself the moment…" and AC-050's exactly-once prompt is cleanest to prove against a deterministic trigger.
4. **`attempt` counts ladder-consuming attempts only.** A raced-`SESSION_BUSY` settlement writes the record with the attempt number unchanged, reason `session-busy`, `parked: false`, next attempt due immediately; a park-at-first-refusal (`no-session`, `over-budget`, `navigation-refused`) writes `parked: true` with the attempt unchanged. *Alternative*: incrementing on every host-call attempt — rejected: AC-051 says each of those "consumes **no** ladder attempt" and the raced refusal "consumed no ladder attempt".
5. **The migration is a read-time normalization** inside the dispatch record's reader: `parked: true && reason: 'session-busy'` reads as `parked: false` (waiting) with `attempt` and `reason` kept, next attempt due now. *Alternative*: a one-shot write pass on mount — rejected: it adds a write that records no new fact and would race the record's write chain; the read-time form is re-derivable from the two existing fields exactly as FR-105's clause demands.
6. **`sent: 'skipped'` and a thrown `SESSION_BUSY` both classify to the same observed-busy outcome** (waiting, no budget, never parked) — the closed reason union and every other classification stay as they are; only the ladder's retry membership changes (transient host errors only).
7. **`navigation-refused` keeps its one word for both of its amended situations** (navigation unissuable under the one-navigation rule; a retry that found the target no longer current) — no union-count change; under B+ only the second situation has a writer, and it parks (FR-105: every other stop is terminal at once).
8. **NFR-001's detection-armed clock with the observed-busy exclusion is spec-side only** — the bar measures panel-caused delay; no instrumentation is added, because the amendment explicitly keeps the waiting duration human-visible "with no new persisted state".
9. **005 is untouched** (spec §7): the waiting state is a reason word on the existing follow-up record, rendered through the run row's existing vocabulary (`followUpRowView` already counts any `!delivered && !parked` record as waiting), and no affordance is added for FR-084 to reach. The surfaces task is therefore an assertion task, not a rendering rewrite.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.
