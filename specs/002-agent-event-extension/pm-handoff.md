# PM Handoff: `002-agent-event-extension` — the actor allow-list (GitHub issue #9)

> ## Retained as provenance (2026-10-05, issue #15 Phase D)
>
> Issue #15 Phase D proposed deleting this file with the other superseded PM
> artefacts, on the reasoning that the *mandate* to write one lives in the global
> `agent-routing` and `orchestration` skills and that nothing in this repo
> requires the file. That reasoning is sound and still holds: a future PM session
> creates one file rather than inheriting this tax.
>
> What the phase did not account for is that this file is cited **as a source**.
> `## Flagged` is the target of four live relative links — `005/research.md:95`,
> `005/tasks.md:397`, `005/plan.md:426` and `003/tasks.md:206` — and its content
> appears nowhere in `002/spec.md` or `002/changelog.md`. `005/plan.md:426` cites
> it for a decision D14 turns on, so deleting this file would remove the record a
> later spec's own plan leans on, with nothing to repoint to — and nothing in the
> suite would notice, because no test validates relative markdown links.
>
> So the file stays. The coordination role is over; the provenance role is not.

> ## ⚠️ Supersession notice — read this first
>
> This file previously held the **002 MVP delivery record** (the M1–M9 cut, dispatched
> 2026-09-27 and validated live on the operator's OpenChamber on 2026-09-28). **That record is
> preserved verbatim at the bottom of this file**, under the heading *Superseded record — 002 MVP
> delivery*. Nothing in it was edited or deleted; it remains the historical account of how the MVP
> shipped and of the pre-cycle roadmap.
>
> **The live handoff is everything above that heading**: the per-repository actor allow-list,
> specified in phases 1–3 and planned in phases 4–5 on **2026-10-03**, ready for the phase gate.
> Two other files are superseded by this one and are **left intact**: `003-dispatch-integrity/pm-handoff.md`
> (the 003 cycle's dispatch record).

---

## Context

- **Feature**: the **per-repository actor allow-list** — `BindingRecord.allowedUsers?: string[]`.
  GitHub issue #9, verbatim: *"anyone who can create an issue or leave a comment on the repo could
  then trigger the agent. I think we would rather have an allow-list of users that are allowed to
  trigger the agent."*
- **Branch**: `issue-9-user-allow-list` (non-protected; the product owner created it for this work).
- **Constitution**: `.specify/memory/constitution.md` **v1.3.0**, approved 2026-09-27.
- **Repo directives**: `AGENTS.md` at the repo root — its ten non-negotiable invariants and its
  panel/service module maps are hard constraints on every task below.
- **Phase**: **phases 1–3 COMPLETE and APPROVED** (three specification amendments, below).
  **Phases 4–5 COMPLETE** — plans, research, data-model deltas, contracts, and the consolidated
  task list, all dated 2026-10-03. **Phase 6 has not started.**

## The three amended specifications

| Spec | Version | What it contributes | Plan block | Tasks |
| --- | --- | --- | --- | --- |
| [`002-agent-event-extension`](./plan.md) | **v1.11.0** | the **model** and the field's **validation**: `actorLogin` + `actorAttribution` on the normalized event, attribution mandatory for all four trigger kinds, `BindingRecord.allowedUsers` with its three states, `buildEventId` untouched | [plan.md §A](./plan.md) | `A-1 … A-7` |
| [`003-dispatch-integrity`](../003-dispatch-integrity/plan.md) | **v1.8.0** | the **gate**: the one membership comparison inside `service/poll/dispatch-authorize.ts`, the `409 actor-not-allowed` refusal, the fifth declared `blocked:` cause, the value-free `actorPolicy` audit detail, the retry re-check | [plan.md §B](../003-dispatch-integrity/plan.md) | `B-1 … B-7` |
| [`005-panel-ia`](../005-panel-ia/plan.md) | **v1.11.0** | the **rendering**: the editor field, the row count, the worded absent-policy warning, the Status count, the dispatch row's actor and its basis | [plan.md §C](../005-panel-ia/plan.md) | `C-1 … C-6` |
| [`006-settings-crud`](./) | **deliberately NOT amended** | nothing — `allowedUsers` is per-binding and `GET /v1/config` describes one global document | — | — |

**006 is left alone on purpose, not overlooked.** A per-binding value cannot live in one global
document — the precedent is 002's own `expectedLogin`, a per-*account* constraint that lives on the
credential-verify route and the Accounts form — and the field's take-effect boundary is an
authorization event, not a cycle boundary, so 006's closed `FieldDescriptor` union, its
twelve-field count, FR-084's "no setting is invented", and every take-effect class are untouched.

## Key artefact paths

| Artefact | What to read it for |
| --- | --- |
| [`tasks.md` §"Issue #9 block (2026-10-03)"](./tasks.md) | **the consolidated task list — the single source of truth for all 20 tasks**, with the wave graph, the `[P]` list, the coverage tables, and the routing recommendation |
| [`plan.md` §A](./plan.md) · [`003/plan.md` §B](../003-dispatch-integrity/plan.md) · [`005/plan.md` §C](../005-panel-ia/plan.md) | the key decisions (**D1–D9**, **D13–D20**, **D13–D18**), the constitution-alignment restatements, the invariants walk, the risks, and each block's out-of-scope guard |
| [`research.md` §R8–§R9](./research.md) | what GitHub's three list feeds actually name about *who acted*, and what counts as a GitHub login |
| [`contracts/binding-allow-list.md`](./contracts/binding-allow-list.md) (**new**) | the field's whole wire contract: three states, the refusal envelope, the omission-means-unset rule, and the "the list never leaves `bindings.json`" invariant |
| [`contracts/events-carry-forward.md`](./contracts/events-carry-forward.md) | the additive `schemaVersion 1.2` actor fields |
| [`003/contracts/dispatch-authorization.md`](../003-dispatch-integrity/contracts/dispatch-authorization.md) | the gate's refusal row, the `actorPolicy` details, the **fifth** `blockedReason`, the error-code entry |
| [`005/contracts/status-projection.md`](../005-panel-ia/contracts/status-projection.md) | `actorPolicy` on each `repositories[]` row, never the logins |
| [`002/ac-status.md`](./) · [`003/ac-status.md`](../003-dispatch-integrity/ac-status.md) · [`005/ac-status.md`](../005-panel-ia/ac-status.md) | the delivered criteria, plus dated **"not started"** blocks for the eight new ones, each pointing at the task that will discharge it |

## Settled product-owner decisions — do NOT re-open

1. **Coalesced runs.** 003 FR-011 lets one run carry deliveries from several people, and
   `blocked:*` runs are **non-terminal**, so new deliveries **join** them. The authorization
   therefore **succeeds when at least one** of the run's source references names an allowed actor.
   **Ratified at the gate on 2026-10-03.** Both alternatives — *refuse if any reference is
   disallowed*, *judge only the opening reference* — were rejected because they **wedge runs
   permanently**: a stranger's comment would disable every dispatch on that issue forever, or open a
   run that an allowed user's later mention could never authorize. Encoded as a **testable
   predicate** (`∃ r : isActorAllowed(r.actorLogin, …)`), not as prose.
2. **The Status surface stays** (005 FR-093): a per-binding `actorPolicy` member plus **one counted
   line**. Confirmed.
3. **No migration.** No shim, no fallback reader, no legacy default, no upgrade acceptance
   criterion. Verbatim: *"there are no migrations needed as we haven't released yet. keep it simple
   as I can delete my one local install and start over easily."* A stored binding without the key
   **is** the absent state; a stored run whose references carry no readable actor is **refused**
   (003 FR-080).
4. **One repository per binding, permanently.** The `binding.projectId` → event snapshot → run →
   `host.startSession({ projectId })` chain makes the `repo → project` edge load-bearing. The issue's
   three scenarios are expressed as **N bindings**.

## Shape of the work

**20 tasks, 13 `[P]`, three waves.** Wave 1 is 002's model and the field's validator and **strictly
gates** the other two; each wave ends at an `npm run verify` boundary with both bundles rebuilt and
committed (invariant 1).

| Wave | Tasks | Goal | Independent test |
| --- | --- | --- | --- |
| **1** | `A-1 ∥ A-2 ∥ A-3 ∥ A-4`, then `A-5`, then `A-6 ∥ A-7` | every event carries an attributed actor; every binding carries a validated list | 002 AC-024 – AC-027 driven through the fixture GitHub and the bindings document |
| **2** | `B-1 → {`B-2 ∥ B-4`} → B-3 → B-5 → {B-6 ∥ B-7}` | one membership comparison, in one place, that leaves a refusal behind | 003 AC-130 – AC-133: reserve under `['alice']` with a run attributed only to `bob` |
| **3** | `C-1 → {`C-2 ∥ C-3 ∥ C-4 ∥ C-5`} → C-6` | the operator can answer *who may trigger this, and who asked* without leaving the panel | 005 AC-142 – AC-146 across all six tabs |

**Routing recommendation: multi-wave orchestration** (>15 tasks). Beyond the count, `B-2` is a
**security gate** in the constitution-II sense and deserves its own independent security review
rather than the implementer's own sign-off — the same treatment `token-handoff.md` got — and `C-6`'s
copy-and-honesty assertions are the part least likely to be caught by a red test.

## Flagged — decide at the gate, do NOT resolve in code

Four places where the approved specifications leave a real fork. Each is **decided for planning
purposes only**, recorded where it belongs, and listed here so a resuming session does not discover
it mid-implementation. **All four change no requirement text; each is a wording or shape question the
owner can settle in one line.**

1. **003 NFR-114's letter does not match the shipped code.** It reads *"The gate reads the binding
   table the authorization path already reads"* — but `reserveDispatch` today reads `config.json` and
   the run document, and **no** bindings document. So reading the live policy is, strictly, *a
   service store read that is not already made on that path*. **Adopted**: read it (003 plan D13); the
   requirement's stated purpose — p95 unchanged, no extra round trip, no network — is met and asserted
   by `B-7`. **Recommended owner wording**: replace that sentence with *"one read of the bindings
   document, which the authorization path does not otherwise make, off the hot path"*. The rejected
   alternative (a `writeBindings`-invalidated cache) is in 003's research §R5 with its reason:
   `ServiceStore` exposes no `stat`, so a hand-edited `bindings.json` would never be seen until a
   restart.
2. **The empty-list round trip** — the one genuinely under-specified interaction. 005 FR-090 says the
   panel "MUST NOT pre-emptively accept input the service would refuse nor pre-emptively reject input
   it would accept"; 005 AC-142 requires that "submitting `[]` is refused by the service" **and** that
   the panel "contains no second control"; and 002 FR-047 forbids `null` and `''` as the unset
   sentinel. Those cannot all hold unless the panel either submits `[]` — and can then **never remove
   a configured list**, which also makes 002 FR-047's own remediation ("remove the field to allow
   everyone") unactionable — or omits the key, which is why the contract was written the second way
   ([`contracts/binding-allow-list.md` §2](./contracts/binding-allow-list.md), 002 plan **D4**, 005
   plan **D14**, 005 research **Q3**). **Adopted**: omit the key; discharge AC-142's `[]` case
   against the **service** plus the panel's own refusal-rendering path. **Ask the owner to confirm**
   this reading, or to permit one affordance inside the field's block that expresses *unset*.
3. **002 FR-045(c)'s wording.** *"no binding field may be written to allow-list a bot, because no bot
   event is ever created to be allowed"* can be read as a **capability** statement (no mechanism
   admits a bot — the reading its own reason and the matching `## Out of Scope` bullet and AC-025
   support) or as a **validator** rule (refuse a `[bot]` login at save). **Adopted**: accept it and
   keep it inert (002 plan **D7**) — adding a refusal would grow a set FR-047 states as exactly
   three states. If the owner reads it as a validator rule, D7 inverts: one extra refusal, one extra
   test, one line of remediation vocabulary.
4. **The retry verdict for an unreadable bindings document.** `blocked:actor-not-allowed` is
   **service-corroborated** (like `blocked:binding-missing`), so the retry re-checks the live policy;
   an unreadable document answers **`cause-not-cleared`** (adopted, 003 plan **D15/D17**) rather than
   a new wire code, because FR-078 declares exactly one new code and a second would widen the closed
   `dispatch.refused` vocabulary for a case the panel cannot act on differently.

**Also recorded, not flagged**: a historical `run.blocked` row may still name a login the operator
has since **permitted**. That is allowed and intended — NFR-113 forbids recording what the policy
*permits*, and a row naming a denial that was true when written is a true statement about a past
decision, the same posture 003 v1.7.0 recorded for the `agent.mismatch` rows it did not rewrite. The
`B-6` scan is written accordingly.

## Hard constraints for Phase 6

- **`buildEventId` MUST NOT change** (002 FR-046). The actor rides the event row and **stays out of
  the identifier**, or existing dedupe breaks. Pinned by a byte-identity test (`A-3`, `A-7`).
- **The gate belongs in `dispatch-authorize.ts`**, inside the one `run-chain.ts` chain task, after
  `judgeReserve` returns `null` and before any token is minted. **Enforcement at detection time in
  `triggers.ts` is forbidden** — a filtered event would leave no audit trail, which constitution IV
  requires.
- **Reuse the existing predicates.** `isBotAuthor` is exported and reused unchanged; the unreadable-
  author check beside it is module-private and is **renamed and exported** as
  `isAttributableAuthor` (002 plan **D3**) — do not add a sibling predicate.
- **Whole-file bindings write only.** `allowedUsers` rides `src/bindings-grant.ts`, which already
  strips prompt keys (004 FR-014) and emits a "nothing changed" refusal. The per-binding
  `PATCH /v1/bindings/:bindingId` MVP-DEBT is **not** reopened.
- **Fail-closed validator discipline**: `BindingVerdict` = `{binding} | {issues}`, `BindingIssue` =
  `{field, remediation}`, per field, **collecting every refusal**. `allowedUsers` is validated on
  **every read and every write**, case-insensitively, with the stored spelling preserved.
- **Committed bundles ship** (invariant 1). `SERVICE_VERSION` mirrors `package.json` (invariant 5) —
  **no version bump**: this is a feature, not a release.
- **Zero suppressions, zero `any`** (invariant 7). **Every test offline and deterministic** — no live
  OpenChamber, no real PAT, no network.
- **Secret hygiene (NFR-113)**: the permitted logins must reach **no** audit row, run record,
  projection, ledger entry, `host.storage` value, or shipped bundle. A GitHub **login** is public
  identity and is not a secret; the **permitted set** is configuration, and a copy of it in a
  retained file is a liability, not an audit aid. A **refusal** may name **denied** logins.

## Next steps

1. **Phase-5 gate**: present this handoff, the three plan blocks, and the four flagged items to the
   product owner. Get a ruling on flags 2 and 3 (shape/wording); note flags 1 and 4 as recorded.
2. **Then Phase 6**, following the consolidated list's wave graph:
   - **Wave 1** (`A-1 … A-7`) — 002's model and the field's validator. Four tasks genuinely parallel.
   - **Wave 2** (`B-1 … B-7`) — the gate. **`B-2` gets an independent security review** before it is
     accepted.
   - **Wave 3** (`C-1 … C-6`) — the rendering. `C-6`'s copy assertions get a second reader.
3. **At every wave boundary**: `npm run verify` green, `npm run build`, both bundles committed with
   their sources, conventional commit with the `Generated-By` trailer, **never pushed**.
4. **Docs**: `README.md` and [`quickstart.md`](./quickstart.md) gain one line per surface this block
   adds — the allow-list field on the Bindings tab, the counted Status line, and the dispatch row's
   actor. 002 FR-042's documentation-synchronisation obligation applies, and no `.env` or
   `MECHA_TURK_*` instruction may appear.
5. **Housekeeping not in the task list** (record, do not invent scope): bump 002's `research.md`
   header citation from `R1–R7` to `R1–R9` if a future reader finds the mismatch confusing — it is
   already recorded in the plan's artefact block.

## Resume instructions for any agent

1. Read **this file**, then [`tasks.md` §"Issue #9 block"](./tasks.md) — that is the whole task set
   with its wave graph.
2. Read the three plan blocks (**002 §A**, **003 §B**, **005 §C**) for the decisions; **do not
   re-derive them**, and do not re-open the four settled product-owner decisions.
3. Read the four named contracts for the wire shapes; they are binding and dated.
4. Load `git-safety` + `ai-attribution` before any commit, `code-quality` before writing code, and
   `orchestration` if you are driving the waves.
5. **Foreground subagent dispatches only.** The 003 cycle recorded a background dispatch that
   appeared stalled and was re-dispatched in the foreground; both then ran and raced on the same
   files. Treat that as a standing environment rule.
6. `npm run verify` is the gate. A green suite is the floor, not the goal — the acceptance criteria
   in `ac-status.md` are the target, and the three "not started" blocks must be filled in as the
   work lands.

## User preferences (unchanged from the MVP handoff below)

- Panel-centric UX, self-hosted, under 10 repositories, N accounts.
- Conventional commits with AI attribution; **never push or merge**.
- Product owner approves at every phase gate.
- "Runs → Dispatches" and "Repositories → Bindings" is the preferred domain vocabulary.

---

## Superseded record — 002 MVP delivery (retained verbatim, superseded 2026-10-03)

> Everything below is the original handoff for the 002 MVP cut, written when that feature was in
> Phase 6 and its Waves 0–1 were dispatched. **It is kept as the historical account**: it records
> how the MVP shipped, the decisions made on the way, and the state of the cycle at the time. Its
> "Current State", "Next Steps", and branch references are **no longer current** — the cycle it
> describes completed, and 003/004/005/006 have since been specced, planned, and delivered. Do not
> act on them; read them for context.

### Context
- **Spec**: specs/002-agent-event-extension/spec.md (v1.0.0, APPROVED 2026-09-27)
- **Plan**: specs/002-agent-event-extension/plan.md (APPROVED)
- **Tasks**: specs/002-agent-event-extension/tasks.md (35 tasks, 11 waves, 2 gates — APPROVED)
- **Constitution**: .specify/memory/constitution.md (v1.3.0, APPROVED)
- **Branch**: `001-agent-event-orchestrator` (local-only, no remote)

### Current State
- **Phase**: Phase 6 (implementation), Waves 0+1 dispatched
- **Completed**: 001 spike (S1–S7 PASS, superseded); constitution v1.2.0→v1.3.0; research consolidation; spec 002 v1.0.0; plan; tasks
- **In Progress**: T-001 security audit of contracts (security-auditor); T-003–T-006 service core (modern-architect-engineer)
- **Blocked**: T-007–T-009 blocked by G1 (closes after T-001/T-002)

### Decisions Made
- Architecture: OpenChamber extension (panel) + hosted local service (Option B, multi-account)
- Extension read-only to GitHub; agent owns all GitHub write-back
- Agent pinning: `expected-agent` setting (default `project-manager`) + `openSession()` verification, fail-closed `blocked:agent-mismatch`
- Token handoff panel→service is approved but G1-gated (security review first)
- Service data dir: default `~/.config/openchamber/mecha-turk/` (Option 1 deviation, documented + health-surfaced)
- Retention: audit 180d/50k entries, payload excerpts 30d; export/restore post-MVP
- Poll: 60s default, service-side, per_page ≤ 30, shared rate budget ≤1,500 req/h
- Manual cleanup; no project creation; picker-only; desktop/web only (no VS Code/mobile services)
- Persistence: service durable store for accounts/audit; host.storage for panel UI state (uninstall-wipe documented)

### Next Steps
1. Complete T-001→T-002, close G1, checkpoint with product owner
2. Complete Wave 1 service core, wave-close verify, checkpoint
3. Continue wave-by-wave per tasks.md; user confirmation after each wave
4. T-033/T-034 live gates need operator's OpenChamber (record host build version)
5. T-035 confirms retention + integration-card gate questions with product owner

### User Preferences
- Product owner approves at every wave gate; autonomy default = no approval for agent actions
- Silence until agent responds (no ack reactions)
- <10 repos, N accounts, panel-centric UX (Accounts/Repos/Runs tabs)
- Conventional commits with AI attribution; never push/merge (no remote anyway)