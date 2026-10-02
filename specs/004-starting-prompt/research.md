# Research: The Layered Starting Prompt (004 v1.4.1) — new findings only

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.4.1 · **Date**: 2026-10-02 (the gate
re-cut supersedes the v1.3.0 pass of the same date, which supersedes the 2026-09-28 v1.1.0 pass —
both preserved in git history). **v1.4.1 = the two gate corrections routed into the specification
and into this file**: FR-085's arithmetic corrected to **6,004 / 9,004** (with the contract's
`promptBlockChars` ceiling corrected alongside) and **NFR-129 reworded** — both discrepancies this
pass had recorded as open are **closed**, see §Open items.

## Status: no open technology questions; four defaults recorded (none changed at the gate), one open item for the PM (two more closed at v1.4.1)

The layered amendment adds two tiers to a field that already ships, a second member on an existing
wire shape, and two rendered fields on surfaces 005/006 already own. **No new language, library,
host API, storage mechanism, or protocol is introduced** (FR-004, NFR-125, NFR-129): the config
document, the account document, the descriptor projection, the account profile write, the closed
panel readers, and the chain-serialised observer pattern all exist and were read before deciding
anything. Every product question the amendment raised was closed in `## Clarifications` rows 22–**33**
(row 33 being the gate ruling itself). What remains is Phase 4's to fix — and is fixed, with
rejected alternatives, in [plan.md](./plan.md) §Key decisions **D14–D26**.

## Settled before this feature (cited, re-verified against the tree, not re-researched)

| Question this feature would otherwise raise | Where it is already settled | Settled answer used here |
| --- | --- | --- |
| Host attachment limits, and what the host does on overflow | 002 research §R1/§R4 + the pinned SDK `1.24.2` (`contract.js`) | `GUEST_ATTACH_TEXT_MAX = 16_000`, `GUEST_ATTACH_DATA_MAX = 16_000`; the composed message must stay under both — FR-085's arithmetic (plan §Architecture) does |
| The working composition budget | `src/session.ts` L58 (`CONTEXT_MAX_CHARS = 12_000`), `buildBoundedContext` L195–230 | the prompt block is reserved *before* the excerpt budget is sized; the floor check compares the composed length against this constant |
| Where durable configuration lives, and what `host.storage` may hold | 002 FR-033/FR-034, constitution "durable state" standard | tiers live in `config.json` / `accounts/<id>.json` / `bindings.json` (0700/0600); never in `host.storage`, never in the ledger (FR-011, FR-081) |
| The panel↔service transport, auth, caps, `422` envelope, issue shape | 002 contract [`panel-service.md`](../002-agent-event-extension/contracts/panel-service.md) §1, §4 | refusals ride the existing `422 validation` with `issues[] { field, remediation }`; the account profile write reuses 005's accounts envelope (`200`/`404 unknown-account`/`422`/`401`/`503`) — the exact codes the retired member route specified |
| How the **account profile write** behaves (closed two-member body, refusal, cascade) | 005 contract [`account-display-name.md`](../005-panel-ia/contracts/account-display-name.md) §2/§4 (re-titled *Account Profile Write* at 005 v1.10.0; filename deliberately kept) + shipped `service/routes/accounts.ts` `handleSetDisplayName` L491–522 (the narrow handler this plan **deletes**) | one `PUT /v1/accounts/:numericUserId` carries `{ displayName?, startingPrompt? }`: absent = unchanged, closed set refuses the eleven custody keys by name with no echo, no-op body refused, any issue refuses the whole write, whitelist-by-construction; `DELETE ?force=1` cascade and `account.deleted` are unchanged (AC-149) |
| How a **config field** is declared, projected, validated, and audited | 006 spec `## Per-Field Contract`, 006 contract [`config-schema.md`](../006-settings-crud/contracts/config-schema.md), shipped `service/config-schema.ts` | descriptor + exhaustive `TAKE_EFFECT` + `collectIssues` order + `config.changed`; `startingPrompt` appended last in both orders (006 AC-107) |
| Secret shapes and the refusal posture when a value must not persist | 002 FR-007, `src/redaction.ts` `SECRET_PATTERNS` + `findSecretLeak` | reuse verbatim at all three save boundaries — same labels, same no-echo discipline (FR-024, FR-083) |
| The fail-closed reader pattern for wire members | shipped `src/prompt-wire.ts`, `src/dispatches-service.ts`, `src/settings-schema.ts` | extend `readPromptReference` deliberately: a bad member refuses the entry, a refused entry refuses the answer (AGENTS invariant 8, AC-151) |
| The exactly-one-audit-row mechanism under races | shipped `service/prompt-audit.ts` (per-store chain + trail-seeded baseline) | both new lanes copy it; the correctness argument is serialisation, not timing (SC-125) |
| Claim-answer sizing when one member grows | shipped `service/poll/claim-bounds.ts` (`measureEvents`, `MAX_CLAIMED_RUNS = 50`, `CLAIM_EVENTS_BUDGET_CHARS`) | a ≤6,004-char `promptText` shrinks the page by measurement — pagination, never truncation; the bound test is re-derived (plan Risk register) |
| Line endings, Unicode counting, hashing primitives | already in use (`node:crypto`, `[...string].length`) | unchanged: CRLF/CR→LF at save, code points via spread, `mtp-` = `sha256(utf8)[0:32]` |
| Compatibility surfaces | `AGENTS.md` invariant 10; 002 v1.3.0 migration note | `extension-spike-1` **unchanged**; `promptSources` is additive within v1 (plan D9 stands) |

## Technical defaults chosen in this pass (each reversible without a redesign)

| # | Default | Why this one | Rejected |
| --- | --- | --- | --- |
| **R-1** | The stored block body's ceiling is `n × 2_000 + 2 × (n − 1)` code points, i.e. **6,004** at the default cap and **9,004** at FR-021's ceiling, cross-checked in the run reader against `sources.length` | **Resolved at 004 v1.4.1** — this default was the finding, and the finding is now closed rather than pending: FR-085's prose had quoted "≤ 6,002" and "≤ 9,006", which its own rule ("one blank line, 2 code points, per gap", counted only between tiers present ⇒ two gaps) does not produce, and the contract repeated the omission ("≤ 6,078" for `promptBlockChars`). v1.4.1 corrected the prose to the rule's own **6,004 / 9,004** and [`contracts/layered-prompt.md`](./contracts/layered-prompt.md) §4 rule 3 alongside it to ≤ **6,080** (6,004 stacked body + the 76-char fence; ≤ **9,080** at FR-021's 3,000 ceiling) — so specification, contract, and this default now quote one set of integers, and the figures in the left column are the figures all three state. The **rule** stays what the code implements and what the run reader cross-checks; the conclusion FR-085 draws (≈7,700 / ≈10,700 — exact totals 7,680 / 10,680, both inside 12,000 and 16,000) was unchanged by the correction and nothing downstream moved | deriving the cap from the prose integers (they contradicted the rule until v1.4.1 corrected them); ignoring the cross-check entirely (leaves a hand-edited row free to claim a body its own `sources` could not have produced) |
| **R-2** | The budget floor is enforced **panel-side, after composition, immediately before `host.startSession()`**, and reported as a failed attempt through the existing `dispatch.result` `problem` | FR-085 requires only "refused before `host.startSession()`, remediation naming the contributing tiers, no session". `problem` is already bounded free text written from the panel's own finding, so no 003 vocabulary changes | a fifth `blocked:<reason>` (would extend 003's closed `BLOCKED_REASONS` set — a state-model change 004 explicitly does not make); refusing pre-reserve (no wire path exists to carry it before reservation) |
| **R-3** | The two observation hooks are the **cycle config read** (`service/poll/loop.ts`) and the **account read funnels** (`readAccount`/`listAccounts`) | exactly mirrors the shipped bindings observer's cadence — "the poll loop reads it every cycle, so a hand edit is recorded within one cycle" — and touches no route read | observing at every `configFromStore` call site (claim, sweep, status: four call sites, four chains' worth of risk for no extra coverage); observing in the PUT only (would miss hand edits, which FR-088 names) |
| **R-4** | FR-063's guidance on the Settings row is carried by the **service-declared `format` prose**; the Accounts field carries a fixed helper beside its own field | 006 FR-014 renders the row's bounds/format slot from the declaration and forbids panel-authored shape copy; the guidance must describe *this validator's* rules, and a descriptor is the only place both already live | panel-authored sentences (drift from the validator; violates FR-014's "none from a value typed into the panel"); a new descriptor member (a wire change for copy) |

**Gate note (2026-10-02): no default changed.** R-1 through R-4 stand exactly as written — the
product owner's ruling replaced a *route* decision, not a technical default: plan **D18** (the
dedicated `PUT …/starting-prompt`) is superseded by **D26** (the account profile write
`PUT /v1/accounts/:numericUserId`, closed two-member body, `/display-name` retired). That is a
decision with a verbatim owner rationale recorded in [plan.md](./plan.md) §Key decisions and in spec
`## Clarifications` row 33 — nothing in this table needed a new value, a new rejection, or a new
source.

**Copy defaults** (the wording is Phase 4's wherever the specification does not fix it):
the dispatch row's line reads `prompt set · <sources joined by '+'> · mtp-… · N chars` /
`prompt not set`; the Settings row shows `not set` in the value slot when the field is `""`; the
Accounts field shows `not set` in place of an empty editor. All three sit behind the v1.2.0
relaxation (004 `## Amendment History`): one representative proof per behaviour carries the
guarantee, so wording may pivot at zero test cost.

## Open items this research leaves — for the PM, not blockers

1. **Budget-floor reporting** (default **R-2**): a failed attempt rather than a new `blocked:`
   reason, precisely because 004 does not extend 003's vocabulary. If the PM would rather see the
   run parked in a distinct state (e.g. `blocked:over-budget`), that is a **003 vocabulary amendment
   plus** a pre-reserve refusal path — a spec change, not a plan detail.

**Closed at 004 v1.4.1 (2026-10-02)** — the two items this section carried at the gate re-cut were
both approved by the product owner at the 4–5 gate (*"Correct the prose"*; *"reword NFR-129's one
sentence"*) and routed into the specification. They are recorded here as **resolved**, not open:

- **NFR-129 vs FR-082** — **reworded at v1.4.1.** NFR-129 now reads *"no new service route beyond
  the existing bindings, account, and configuration surfaces"* and states the accounts surface's
  route count as **net unchanged** — one added (`PUT /v1/accounts/:numericUserId`), one retired
  (`PUT …/display-name`) — so the clause this section flagged (a method/path swap the old sentence
  did not describe) no longer exists to survive. This plan still follows **FR-082** as the later,
  owner-approved, requirement-specific text; [plan.md](./plan.md) §Cross-feature coordination item 1
  is closed with it. **No code decision ever depended on the answer** — the profile write is
  required either way.
- **FR-085's quoted integers (6,002 / 9,006)** — **corrected at v1.4.1** to the rule's own
  **6,004 / 9,004** (default **R-1**), with the contract's `promptBlockChars` ceiling corrected
  alongside to ≤ **6,080** (6,004 stacked body + the 76-char fence; ≤ **9,080** at FR-021's 3,000
  ceiling). The arithmetic conclusion and every bound test were unaffected by the correction — then
  and now.

Nothing above blocks Phase 6: the open item is a documented default with the specification's own
text cited on both sides, and the two closed items are agreement, not disagreement.
