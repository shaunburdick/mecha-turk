# PM Handoff: Dispatch Integrity & Recovery (003)

## Context
- **Feature**: `003-dispatch-integrity` — first spec in the post-MVP cycle
- **Predecessor**: `specs/002-agent-event-extension` (v1.1.0, Implemented 2026-09-28) — the landed MVP
- **Constitution**: `.specify/memory/constitution.md` (v1.3.0, Approved 2026-09-27)
- **Repo directives**: `AGENTS.md` (repo root)
- **Branch**: `full-project-plan` (non-protected; spec artifacts land here during phases 1–3. Each spec gets its own branch when implementation starts.)

## Current State
- **Phase**: Phase 1 COMPLETE for all four features (003, 004, 005, 006 — all Approved). **Remaining this session: the cycle's second commit (006 + amendments).** Next session: Phases 4–5 per feature (plan + tasks → `modern-architect-engineer`), then Phase 6.
- **Completed**:
  - 002 landed and live-validated (M5: two issues → two worktree sessions); feature roadmap agreed with product owner
  - **003 spec v1.0.0 APPROVED 2026-09-28** — 53 FR / 12 NFR / 11 SC / 29 AC, 5 user stories (P1×3, P2×2), 23 edge cases, 20 clarification rows + 3 gate confirmations. Cleared for `/speckit.plan`.
  - **004 spec v1.0.0 APPROVED 2026-09-28** — 55 FR / 10 NFR / 10 SC / 16 AC, 5 user stories, 23 edge cases, 21 clarification rows + 3 gate confirmations. Cleared for `/speckit.plan`.
  - **005 spec v1.0.0 APPROVED 2026-09-28** — 85 FR / 12 NFR / 12 SC / 40 AC, 8 user stories (P1×4), 25 edge cases, 28 clarification rows + 4 gate confirmations. Cleared for `/speckit.plan`.
  - **006 spec APPROVED 2026-09-28 at v1.1.0 (bumped at the gate)** — 75 FR in nine reserved blocks, 12 NFR, 17 SC, 50 AC, 6 user stories (32 scenarios), 27 edge cases, 18 clarification rows, 4 resolved gate answers. The gate **overturned** the encoded default: the nine inert fields are now **wired into real consumers** (~3× scope; see 006 outcome below). Cleared for `/speckit.plan`.
  - **Amendment chain (final)**: 002 → **v1.5.0** (003 conformance, 004 extension, 005 placement, 006 extension+reaffirmation; body verbatim; 002's v1.5.0 entry edited in place when 006's gate widened scope — no second bump, since no requirement text/vocabulary/behaviour changed in 002 itself); 003 → **v1.3.0** (004, 005, 006 record amendments); 004 → **v1.1.0**; 005 → **v1.1.0** (006 supersedes 005 FR-070 and FR-073).
- **In Progress**: none — final commit pending
- **Blocked**: none
- **Commits**: `e1037fa` — `docs: approve feature specs 003-005; amend 002 to v1.4.0` (8 files, +2210/-3, verify green 563 tests). **Pending: 006 + the three predecessor amendments** (`M 002`, `M 003/spec`, `M 005`, `M 003/pm-handoff`, `?? specs/006-settings-crud/`). Nothing is ever pushed (AGENTS.md).

## Git context for committing (learned this session — a resuming session needs this)
- Worktree caveat: `.git` is a file, so hooks live in the **main gitdir** — `git rev-parse --git-path hooks` resolves to `/home/agents/github/shaunburdick/mecha-turk/.git/hooks` (the `prepare-commit-msg` attribution hook is installed there). The `check-hook.sh` script's literal `.git/hooks` path is unreliable in this worktree.
- Identity: repo is on the `agent` identity (`Prompt it so <agents@burdick.dev>`, gh `prompt-it-so`) — the operator's deliberate agent identity; do not switch to `personal` (that's `shaunburdick`).
- Attribution claim: `AI_AGENT=opencode OPENCODE_AGENT="project-manager" OPENCODE_MODEL="opencode/big-pickle" git commit ...` → trailer `Generated-By: project-manager (model: opencode/big-pickle)`.
- Remote exists (`git@github.com:shaunburdick/mecha-turk.git`) but AGENTS.md forbids push — never push, never create a PR without explicit user approval.

## 005 outcome (decisions for context when 006 is specced)

Six-tab shell: **Status / Dispatches / Bindings / Accounts / Settings / About**, replacing the spike-era UI + Repos pane. Notable placements: prerequisites live on Status (live state, not About); Dispatches owns the relay loop (tab switching must not change whether dispatching runs); About reads version from `GET /v1/health` → `SERVICE_VERSION` with no panel-side literal (invariant 5); Status requires fixing `service/routes/status.ts`'s hardcoded `paused: true` / `nextPollAt: null` (FR-031–FR-033: computed from `poll/timer.ts` + `poll/loop.ts`, `repositories: []` → one row per stored binding projected from the same `readStatusRows` the Bindings tab uses); 003's `## Wire Surface Delta` row marking Status "Unchanged" is the one supersession of the cycle.

**Rename adjudication (product-owner confirmed 2026-09-28):**
- L1 user-facing copy: Runs→Dispatches, Repositories→Bindings everywhere (FR-020)
- L2 internal source: `runs*.ts`→`dispatches*.ts`, `repos*.ts`→`bindings*.ts`, `PanelState.repos`→`.bindings` (FR-024)
- L3 wire: `/v1/events*` **NOT renamed — confirmed deferred** (documented in Vocabulary Mapping; settled deferral, not backlog) — Q1 at gate
- L4 domain/audit: `run`, `run key`, `run ordinal`, `attempt` retained (002 FR-030, 003 FR-010/020, 004 FR-038 defined over them)
- `host.storage` keys + `mecha-turk` panel id untouched (invariant 4); active tab deliberately not persisted

**005 gate confirmations (all as encoded, version stayed 1.0.0):**
1. Wire route rename deferred (rejected: rename now with contract bump)
2. Spike diagnostics survive read-only as a Diagnostics section in About; only the live "Record phase" writer is dropped (rejected: drop entirely)
3. Dispatches tab: server-side filtering by binding and state alongside cursor pagination (rejected: no filters)
4. Accounts tab: durable `displayName: string | null` added (rejected: login-only label)

**Also in 005**: the spike-era manual "Start session" control is retired as a conformance consequence of 003 FR-035 (started a session without run/lease/token); `canRetry = row.state !== 'dispatched'` named as the defect FR-044 corrects; `MAX_LISTED_EVENTS = 100` is why the 101st dispatch is unreachable (FR-042); retry/Resolve/Return-to-waiting interactions honor 003's semantics; the token-handoff flow moves to Accounts verbatim (consent not re-requested by navigating); Settings tab is read-only in 005 — edit capability is 006's; 004's `startingPrompt` renders on the Bindings tab exactly once.

**Known cosmetic debt (004, reproduction not endorsement)**: shipped `Rule:` framing line reads as though an assignment fired on a mention/review dispatch. Fix belongs to 005's implementation or later.

## 004 outcome (for context when 005–006 are specced)

Composed dispatch message: `--- BEGIN OPERATOR STARTING PROMPT ---` operator text verbatim (ends trimmed, nothing escaped) `--- END OPERATOR STARTING PROMPT ---`, blank line, then today's framing unchanged (Correlation / Repository / Issue / URL / Machine account / Rule), then `--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---` bounded excerpt. With no prompt set, the message is **byte-identical to today's dispatch**. Operator text is literal — no `{number}`-style substitution. When prompt + excerpt exceed the dispatch budget, **the excerpt shortens, the prompt never does** (FR-035).

**Product decisions confirmed by the owner on 2026-09-28** (all matched encoded defaults; version stayed 1.0.0):
1. Prompt length cap **2,000 Unicode code points** after trimming; tunable range 500–3,000 so long as the composed message fits 002 FR-028's per-dispatch bound. Rejected: 3,000 (starves source excerpt), 1,000 (machine context dominates).
2. **Credential-shaped prompt → refused on save** with remediation (FR-024), consistent with the service's refuse-don't-log-through behaviour. Documented cost: a prompt that *discusses* token handling can be refused — narrow but non-zero-width match. Rejected: warn-and-allow-save.
3. **Audit records the prompt as a fingerprint, never text** (FR-050–FR-054). Full text lives in exactly two places: the binding record and an enqueue-time snapshot (retry replays byte-identical text even if the binding was edited mid-retry). Audit rows carry binding id + deterministic unsalted fingerprint + presence + length. New event type `binding.prompt-updated`; `dispatch.reserved`/`dispatch.result` gain the reference scalars. Once a queued record ages out, a fingerprint-vs-binding mismatch is the operator-changed signal.
4. **Omission preserves** in whole-file `PUT` (technical default, no rejected alternative recorded): only an explicit empty value, explicit `null`, or empty-after-trim clears the prompt.

Known cosmetic debt documented in 004, reproduction not endorsement: the shipped `Rule:` framing line reads as though an assignment fired on a mention/review dispatch. The copy fix belongs to **005 or later**.

## 003 outcome (for context when 004–006 are specced)

003 numbers FRs in **reserved blocks of ten** (`001–005`, `010–017`, `020–029`, `030–037`, `040–044`, `050–054`, `060–065`, `070–075`) so a later clarification can be added inside its group without renumbering. ACs are `AC-101–129`, SCs `SC-101–111`, NFRs `NFR-101–112`. **Phase 4/5 must reference these numbers as written and not renumber.**

Dispatch state model: `pending → claimed → starting → dispatched`, with four audited exits — `claimed→pending` on lease expiry (the *only* automatic re-dispatch path, budget 3, then dead-letter), `starting→unconfirmed` on result-deadline expiry (fail-closed, never auto-expires, operator-resolved only), `claimed→blocked:<reason>` when a guard refuses before any host call, and `any→failed` for a dispatch that produced no session (the shipped build recorded this as success). A non-destructive migration table maps the shipped `pending | in-flight | dispatched` vocabulary onto this.

**Three product decisions confirmed by the owner on 2026-09-28** (all matched the planner's encoded defaults, so no requirement text moved and the version stayed 1.0.0):
1. A follow-up trigger after a terminal run opens a new, separately numbered run and a second session (`runOrdinal` in the run key). "One session per subject, ever" was rejected — it would make `@bot, one more thing` permanently unanswered.
2. `unconfirmed` never auto-expires. Time-bounded auto-resolution was rejected: it trades a fail-closed wedge for an unattended path that could start a second session.
3. Automatic requeue budget is 3, and only an expired claim consumes one — a guard refusal never does.

**Residual risk, documented not hidden**: durable dedup is evictable, so a sufficiently old mention can re-detect and open a further run. Fixing it is an eviction-policy change, deliberately deferred to the backlog.

## The Feature Roadmap (agreed 2026-09-28, product owner)

Four specs, sequenced by dependency. Only 003 is in flight.

| # | Feature | Size | Why in this position |
| --- | --- | --- | --- |
| 003 | Dispatch integrity & recovery | Medium | Dispatches UX is untrustworthy until the double-session and audit gaps close |
| 004 | Per-binding starting prompt | Medium | Lands before 005 so the Bindings tab renders the prompt field exactly once |
| 005 | Panel IA — six tabs | Large | The headline UX work; consumes 003's honest retry + 004's prompt field |
| 006 | Settings — full service config CRUD | Medium | `GET`/`PUT /v1/config` already exist; this is UI + live-apply |

**Backlog, not this cycle**: retention & export/restore, service-side `agentVerified` mirror, policy profiles, durable dedupe-index eviction, webhook adapter (constitution I).

## Product-owner decisions (2026-09-28)

1. **Starting prompt composition** → trusted operator intent first, auto-built source attachment and bounded untrusted excerpt below, already delimited. Prompt may direct the agent; untrusted source text can never override it. (Decides the shape of 004.)
2. **Settings scope** → **full CRUD over all service settings**, not a reduced read-mostly surface. (Decides the size of 006; the planner must plan the live-apply and destructive-knob-confirmation behavior.)
3. **Terminology** → adopt the product owner's words: **Dispatches** and **Bindings** replace Runs and Repositories across copy, service route names, tests, and spec language. (Decides part of 005.)

## 003 scope — conformance failures against 002 v1.1.0

Source: `specs/002-agent-event-extension/tasks.md` debt list and its final pre-PR review record (2026-09-28).

| Item | 002 requirement it fails |
| --- | --- |
| Two triggers on one issue (assignment + mention) mint two event ids → two sessions | FR-030 deterministic run key; the spec's own edge case requires one run, one session, both source refs preserved |
| Panel closing mid-dispatch strands a claimed event; no auto-requeue | FR-037 non-looping crash response / manual replay; NFR-006 durability |
| A dispatch whose `POST /v1/events/:id/dispatched` never lands can double-session on retry | FR-030 dispatch idempotency; NFR-002 |
| Service audit rows missing for dispatch / dispatch-result / retry / agent-verification | FR-035 |
| Audit rows carry their own uuid while the ledger carries `eventId` | NFR-007 one correlation id end to end |
| "Not listed?" project-picker guidance absent | FR-014 |
| First-run prerequisites section absent from the panel | FR-038 |

**Triage note**: the first five are conformance failures against requirements 002 already states, so 003 needs a **companion amendment to 002 (v1.1.0 → v1.2.0)** alongside the new 003 requirements. The planner owns the precise sequencing.

## 003 explicitly out of scope
- Status projection honesty (hardcoded `paused: true` / `nextPollAt: null` in `service/routes/status.ts`) → belongs to 005's Status tab
- Runs-list interval cadence, per-row retry affordance → 005's Dispatches tab
- Policy profiles, retention/export-restore, dedupe-index eviction → backlog
- Any GitHub write (FR-031 stands; the extension and service stay read-only to GitHub)

## 006 outcome (gate: 2026-09-28)

**The finding that sized it**: only `intervalMs` had a runtime consumer; the other nine fields were stored with **no reader anywhere** (`logLevel` not even restart-applied — `main.ts:115` hardcoded `'info'`; lowering `auditRetentionDays` deleted nothing; `audit.ndjson` grew unbounded).

**Gate answers (4):**
1. **Inert fields → OVERTURNED: "also wire all fields (~3× size)"** — the owner rejected editable-but-inert. 006 now specifies every consumer: audit trim pass writing `audit.trimmed` with a protected run-chain set (opener + outcome rows survive, so correlation chains still answer *what it was* / *what happened*); excerpt trim over `events.json` (terminal rows only, `limitReached: 'excerpt-days'`); HTTP-poll backoff (`min(cap, base×2^(n−2)) × jitter[0.5,1.0]`, `retry-after` wins even over cap, exhaustion **retains** `lastScanAt` instead of today's clear-to-replay) with an explicit clause that this is **not** 003's requeue/attempt semantics (panel copy may say *requests / attempts / poll backoff*, never *requeue / run attempts / retry budget*); `overlapMs` consumed by `windowFor` (**closes 002 FR-019's conformance gap**); `perPage` replacing hardcoded `PAGE_SIZE` (002 FR-020 ceiling ≤30 kept). Classes now: 9 × `next-cycle`, 1 × `immediate` (logLevel), **0 × `stored-not-applied`**. Destructive confirmation truthfully states what is deleted, when, what survives.
2. **`PUT /v1/config` last-writer-wins** — confirmed as encoded (matches `PUT /v1/bindings`).
3. **`logLevel` `immediate`** — confirmed as encoded (service change required; `restart` would have lied about the shipped build).
4. **`requeueBudget` deferred** — confirmed as encoded. No 11th field; `## Deferred` + 003 v1.3.0 stand.

**Double-write incident (process lesson)**: after the background 006 dispatch appeared stalled (16 ms created→updated, no outcome), the PM re-dispatched foreground — both then ran and raced on the same files. On-disk is the foreground version, verified internally consistent; the divergent draft's `requeueBudget` idea surfaced as gate answer 4. **Rule: no background-mode subagent dispatches in this environment — foreground only.**

## Next Steps
1. **006 (Settings — full config CRUD)** — Phase 1 spec, then its gate. Known scope: panel edit UI over the existing `GET`/`PUT /v1/config` (10 validated fields, additive 422 refusal, `config.json` in the service store); live-apply semantics are the open design question (recommendation to carry: `logLevel` live, `intervalMs`/`overlapMs`/`perPage` next-scheduled-poll, retention fields destructive-knob-confirmed); the Settings tab shell from 005 FR-xxx is the render target. The product-owner's decision at intake was **full CRUD over all service settings**, which is why 006 is bigger than read-mostly.
2. **Phases 4–5 per feature** (plan + tasks via `modern-architect-engineer`), one dispatch per spec in order 003 → 004 → 005 → 006. Numbers are convention-protected: 003 (FR blocks of ten, AC-101+), 004 (FR blocks, NFR/SC/AC-120+), 005 (FR blocks, AC-1xx). Verify no renumbering.
3. **Phase 6** per spec, routed by size (005 is Large → orchestration; 003/004/006 Medium → architect or orchestration by judgment call). `npm run verify` at every wave boundary.
4. **Known cosmetics to fold in**: the `Rule:` framing-line fix; `#n title` copy; the 002 debt list items that 003/005 did not absorb (policy profiles, retention/export-restore, dedupe-index eviction, service-side `agentVerified` mirror, runs-list interval cadence → now "dispatches-list cadence").
5. 003/004/005 Phase-1 work is **committed** as `e1037fa`. After 006's gate, verify green and commit 006 (conventional commit + AI attribution; never push).

## Next-session resume instructions (PM)
Start: read THIS file. State: three of four feature specs approved; 006 is the remaining Phase 1 task. Diagnostics: `specs/003-dispatch-integrity/pm-handoff.md`, `specs/004-starting-prompt/spec.md`, `specs/005-panel-ia/spec.md` are the authoritative current surfaces. Dispatch `spec-driven-planner` for 006 exactly as this session did for 003–005 (no slash-command invocation; read `.opencode/commands/*.md` + `.specify/templates/spec-template.md`; stay on `full-project-plan`, no branch, no git).

## User Preferences
- Panel-centric UX, self-hosted, under 10 repositories, N accounts
- Conventional commits with AI attribution; never push or merge
- Product owner approves at every phase gate
- "Runs → Dispatches" and "Repositories → Bindings" is the preferred domain vocabulary
