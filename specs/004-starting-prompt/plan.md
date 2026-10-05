# Implementation Plan: The Layered Starting Prompt (004 v1.4.2)

**Branch**: `keen-zebra` (spec artifacts only — Phases 4–5 produce documents, **no commits**; Phase 6 moves to `004-starting-prompt` per `AGENTS.md` git conventions) | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md) (v1.4.2, **APPROVED at the 4–5 gate with one recorded exception** — the layered starting prompt, GitHub issue #10, re-cut by the product owner's ruling: the account tier rides the account profile write, no dedicated endpoint; **v1.4.1 = the two gate corrections routed in** — FR-085's arithmetic corrected to 6,004 / 9,004 and NFR-129 reworded for the profile write's net-zero route count; **v1.4.2 = the pre-PR review correction** — FR-085's floor has two reachability routes, hand-edited store *or* legal supplementary-plane stack, and this plan's floor item follows it; no code, no bound, no decision moves; this plan is synced to all three)

**Input**: Feature specification `specs/004-starting-prompt/spec.md` **v1.4.2** (block I `FR-080`–`FR-089`, rewritten `FR-070`/`FR-071`/`FR-072`, `SC-121`, `SC-128`, `SC-130`–`SC-132`, `AC-131`, `AC-142`, `AC-146`–`AC-151`, `## Clarifications` rows 22–**34**; **v1.4.0 re-cuts `FR-082`'s write path, `FR-083`'s save-boundary phrase, and the `Account` entity line**; **v1.4.1 corrects `FR-085`'s two integers (6,002 / 9,006 → 6,004 / 9,004, derivation written into the requirement) and rewords `NFR-129`** to name the existing *bindings, account, and configuration* surfaces with the accounts surface net unchanged; **v1.4.2 corrects `FR-085`'s floor reachability and adds clarification row 34** — the floor's two ways in, the code-point/UTF-16 unit split, and the floor's deliberately unchanged UTF-16 measure); contract [layered-prompt.md](./contracts/layered-prompt.md) (new; **§2 write side + §5 invariant 3 re-cut at 004 v1.4.0**, **§4 rule 3's budget figures corrected at 004 v1.4.1 — `promptBlockChars` ≤ 6,080 default / 9,080 at the ceiling — and its floor reachability re-cut at 004 v1.4.2 (two routes; code-point vs UTF-16 units)**) plus [binding-prompt.md](./contracts/binding-prompt.md) and [dispatch-prompt.md](./contracts/dispatch-prompt.md); amended successors `specs/005-panel-ia/spec.md` (**v1.10.0** — FR-051/SC-105/AC-123 at v1.9.0, plus **FR-066's write path and the Wire Surface Delta Accounts row at v1.10.0**) and `specs/006-settings-crud/spec.md` (v1.6.0 — FR-010/FR-014/FR-070/FR-071/FR-081/FR-084/FR-090, `## Per-Field Contract`, SC-102/SC-106, AC-101/AC-104/AC-152 — **audited at the gate: references neither route, untouched**) with 006 contract [config-schema.md](../006-settings-crud/contracts/config-schema.md); 005 contract [account-display-name.md](../005-panel-ia/contracts/account-display-name.md) (**amended in place at 005 v1.10.0, retitled *Account Profile Write* — filename kept because this plan, data-model, and tasks link to it**); predecessors `specs/002-agent-event-extension/spec.md` and `specs/003-dispatch-integrity/spec.md`; constitution `.specify/memory/constitution.md` **v1.3.0**; repo directives `AGENTS.md`; and the **shipped code** read for this plan (anchors below were re-verified against the tree, not trusted from the brief; the account-route anchors re-verified again for this gate re-cut).

**Note**: No application code is written in Phases 4–5. Every design decision below is decided and justified; the one question still genuinely open (budget-floor reporting, default **R-2**) is recorded in [research.md](./research.md) §Open items, and the two that were surfaced to the PM there and in §Cross-feature coordination — FR-085's quoted integers and NFR-129's sentence — **closed at 004 v1.4.1**.

## Baseline — what shipped before this amendment, and what this plan adds

The pre-amendment plan (2026-09-28, v1.1.0) designed the **binding tier** and its task set `T-001`–`T-016` is **complete** (all boxes checked; text preserved in git history). Its decision, change, and new-item identifiers — **D1–D13, C1–C12, N1–N6** — are cited in shipped code comments (`plan D2`, `plan D10`, `plan N3`, …), so this document keeps them intact below and continues the series at **C13 / N7 / D14**. Nothing in this plan re-opens a shipped decision; the layered amendment *extends* them.

| Pre-amendment item | Status after v1.4.0 |
| --- | --- |
| C1–C12 (binding field, omission-preserves, observer, enqueue snapshot, claim/projection/audit scalars, composition, dispatch row) | **Shipped; re-touched only where this plan says** (C22–C25 add `promptSources` beside what is already there) |
| N1–N6 (`src/prompt.ts`, `service/prompt.ts`, `prompt-audit.ts`, contracts, tests, docs) | **Shipped; extended** by C13 (prompt modules), C24 (the closed reader), C31 (docs), C32 (test scans) |
| D1–D13 | **Still in force**; D6 (cap is a module constant, not a tunable setting) is untouched — the *global tier* is a new field, not a cap setting |
| Task numbering | The pre-amendment set is `T-001`–`T-016`; **this plan's tasks continue at `T-017`** so the two sets can never collide |

## Summary

**004 v1.4.0 stacks three operator tiers — global → account → binding — into one fenced block, resolved once at detection.**

- **Service** (`service/`): the prompt domain gains a **resolution function** that reads the global tier from the effective configuration, the account tier from the account record the binding names, and the binding tier from the binding record, concatenates the set tiers with one blank line, fingerprints the **composed body** once, and snapshots `{ text, fingerprint, length, sources }` onto the run beside `projectId`/`worktreeOption` (FR-080, FR-086, FR-087). `validateStartingPrompt` — unchanged — is now called from **three save boundaries**: the bindings write (existing), `PUT /v1/config` (twelfth field, `next-cycle`), and the **account profile write** `PUT /v1/accounts/:numericUserId` (body `{ displayName?, startingPrompt? }`, closed two-member set — plan **D26**, which replaces the dedicated endpoint this plan first drafted and retires the shipped `/display-name` handler with it). Every tier change writes exactly one audit row: `binding.prompt-updated` (unchanged), new `account.prompt-updated` (only when the prompt member changes — a `displayName`-only write stays row-less), and `config.changed` whose `from`/`to` for this field are **`mtp-` fingerprints or `null`, never the text**.
- **Panel** (`src/`): `promptSources` joins every surface the fingerprint already reaches — claim answer, run row, both dispatch audit rows (service-written), attachment `data` (panel-written) — through the **closed** prompt reader in `prompt-wire.ts`, which refuses an unknown tier, a wrong order, a duplicate, or a presence/sources disagreement (one refusal refuses the answer). Composition is unchanged: the service hands over an already-stacked block body, the panel fences it, reserves it before the excerpt budget, and now **refuses the dispatch before `host.startSession()`** if a composed message could ever exceed the bound. Two new rendered fields appear under 004 FR-089: the global tier as the **twelfth Settings row** (driven entirely by 006's descriptor table) and the account tier as **one field per account** on the Accounts tab (riding the account profile write beside `displayName`, sending only the member it edited).
- **Nothing else moves**: no migration, no backfill, no legacy projection (spec row 32 — *the feature has never been released*), no fourth tier, no fallback chain, no content policy, no new host capability, no new store file, no `version`/`SERVICE_VERSION`/SDK change, no evidence-schema bump, no dispatch-state-model or `blocked:` vocabulary change — and **no compatibility alias for either retired route**: the planned `…/starting-prompt` endpoint never exists and `PUT …/display-name` is deleted outright (005 v1.10.0; nothing released, row 32).

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` (`AGENTS.md` invariant 7) |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` and **committed** (invariant 1). **No `node:` imports in `src/`** — the fingerprint stays service-side (FR-016) |
| Service runtime | Node ESM, host-spawned; `service/main.js` built with `bunx openchamber-guest-bundle --node` and **committed** (invariant 1) |
| Service dependencies | Node stdlib only (`node:crypto` for the fingerprint) — **004 adds no dependency and no framework**; the service stays stdlib-only per `AGENTS.md` (constitution V) |
| Storage (service tier) | JSON + NDJSON under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename). **No new file**: the global tier rides `config.json`, the account tier rides `accounts/<id>.json`, the binding tier `bindings.json`, the snapshot `runs.json`, the rows `audit.ndjson` |
| Storage (panel tier) | `host.storage` — **no new key and no value** (FR-011, FR-081, AC-144) |
| Validation | The shipped fail-closed `validateStartingPrompt` (`service/prompt.ts` L139) — **one rule set, three call sites** (FR-083); secret shapes reused verbatim from `src/redaction.ts` `findSecretLeak`, never extended (FR-024) |
| Config projection | `service/config-schema.ts` — exhaustive `TAKE_EFFECT` (L47), closed `FieldDescriptor` union, `configSchema()` (L132). The twelfth field fails `tsc` if it is added without a class (SC-106) |
| Testing | vitest `5.0.2`, fully offline: fake host (`tests/support/panel.ts`), loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`). **No live OpenChamber, no PAT, no network** (`AGENTS.md` testing philosophy) |
| Target platform / SDK | OpenChamber desktop and web; `@openchamber/sdk` pinned `1.24.2` exact (invariant 6; FR-004 — **no re-pin**) |
| Host attach caps | `GUEST_ATTACH_TEXT_MAX = 16_000`, `GUEST_ATTACH_DATA_MAX = 16_000` (pinned SDK); working budget `CONTEXT_MAX_CHARS = 12_000` (`src/session.ts` L58) — the arithmetic FR-085 states is checked against both |
| Latency | **Zero** added panel↔service round trips (NFR-120, SC-127): the snapshot still rides the claim answer that already exists; the tier reads happen on reads the cycle already makes |
| Scale | <10 bound repositories, a handful of accounts, one operator machine, one logical service instance (unchanged) |

## Constitution Check (v1.3.0) — alignment statement

> **004 v1.4.2 aligns with every principle and every security/quality gate of constitution v1.3.0. There are no constitutional violations, therefore no complexity-tracking rows and no exceptions to record.** The amendment exists to make principle **II** true at *three* save boundaries instead of one (a refused tier is refused everywhere or it is not refused) — and, since the gate ruling, true of the account profile write as a **whole-body** rule (a closed two-member body refuses every custody key explicitly, and a refusal at either member writes nothing); principle **IV** true at *tier* granularity (one row per change per tier; `promptSources` answers "which tiers produced this run" from any run surface under any retention); principle **VI** true for the new arithmetic (golden-string oracles and a proved budget rather than an asserted one); and principle **VII** unchanged (one fence, one `startSession()`, no new capability). Re-read after design (below) — alignment unchanged. **Re-checked at 004 v1.4.1** (the two gate corrections: FR-085's integers corrected, NFR-129 reworded) — wording only: principle **VI**'s "a proved budget rather than an asserted one" and principle **VII**'s route-count statement both read *more* precisely for the corrections, and the alignment does not move. **Re-checked at 004 v1.4.2** (the pre-PR review correction: FR-085's floor reachability — two ways in, code points vs UTF-16) — documentation only, no code and no bound: principle **II**'s refusal is unchanged and now honestly described, principle **VI** gains the two measurement units written out against the code sites, **IV** and **VII** are untouched, and the alignment still does not move.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Discovery and the loop are untouched except that enqueue now *reads* two records it already holds (config is read each cycle, the account is read each scan). Every wire change is an additive member of existing v1 operations (`promptSources`, the account DTO's `startingPrompt`), recorded in [contracts/layered-prompt.md](./contracts/layered-prompt.md); the account **profile write** is the one non-additive move — it *replaces* `PUT …/display-name` one route for one route, and neither was ever released, so there is no compatibility surface to version; `extension-spike-1` is not versioned (invariant 10 — additive within the contract, 002 contract §1) |
| **II. Safe autonomy by default** | One `validateStartingPrompt`, three boundaries (FR-083): a non-text, oversized, credential-shaped, marker-imitating value is refused at the bindings write, at `PUT /v1/config`, and at the account profile write, each with a field-level remediation and **no echo**; at the profile write the rule is the body's: a **closed set of exactly two members** refuses all eleven custody/identity keys by name (`422`, no echo), a body with neither member is a refused no-op, issues are collected additively, and **any issue refuses the whole write** — no member, no `updatedAt`, no audit row; refusal at one tier never touches another tier's stored value; a malformed stored tier quarantines its own document (`bindings.json`, `config.json`, `accounts/<id>.json`) with a logged `field: remediation` reason; the composed-message overrun **refuses before `host.startSession()`** and truncates nothing (FR-085 — a stop condition, not permission to guess) |
| **III. Durable and idempotent work** | Resolution happens **once**, at the single moment FR-015 already fixes; a queued run keeps its block, fingerprint, and sources across any later edit, clear, or account deletion; a retry composes byte-identically from the same snapshot; **no migration, no backfill, no file rewrite, no scan-window reset** on arrival (FR-018, FR-089, SC-128, row 32) |
| **IV. Human-visible auditability** | Exactly one row per tier change — `binding.prompt-updated`, `account.prompt-updated`, `config.changed` — with actor `operator` for a write through the panel and `service` for a change observed in the store (including hand edits of `config.json` and an account file); **fingerprints only, never text, anywhere** (FR-053, FR-088, AC-148, AC-151); `promptSources` on the snapshot, claim answer, run row, both dispatch rows, and the attachment `data` (FR-087) so "which tiers produced this run" is one read (SC-131) |
| **V. Minimal, self-hosted deployment** | No new process, dependency, store file, capability, permission, or control plane; the two tiers live in documents the operator already backs up; the service stays stdlib-only |
| **VI. Spec before implementation** | This plan + [research.md](./research.md) + [data-model.md](./data-model.md) + [contracts/](./contracts/) land before code; byte-identity (SC-121, SC-130), budget (SC-132), secret-containment (SC-123), one-row-per-change (SC-125), and no-migration (SC-128) are each a named automated task, not an aspiration |
| **VII. Thin orchestration boundary** | FR-004 / 003 NFR-110: **no new host capability, API, permission, or private interface.** The block still travels in the `text` of the one `host.startSession()` call the panel already makes; the pin, worktrees, projects, and sessions stay host-owned |
| **Security std (secrets)** | Credential-shaped text is refused at save using the shipped shape set, so no credential can reach `config.json`, an account record, `bindings.json`, a run snapshot, an audit row, a log, or a bundle; refusals never quote the value; the scan suites **gain cases, never exemptions** (FR-005, NFR-121) |
| **Security std (untrusted input)** | The untrusted region keeps 002 FR-028 / 003 FR-014 bounds, delimiters, and markers untouched; **structure is built, never parsed** — the panel never re-splits the stacked block and derives no boundary from any tier's text (FR-033, FR-080, FR-084) |
| **Security std (durable state)** | Tier text lives in the service store only — one store record per tier plus the run's own snapshot (FR-053) — never in `host.storage`, the ledger, a log line, a toast, or a shipped bundle |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any`; offline suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (invariants 1, 7) |

**AGENTS.md non-negotiable invariants honoured by this plan** — (1) **committed bundles ship**: every wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` in the same commit; (2) **one document, two roles**: **no `version` bump** — 004 is not a release, and a bump is a product-owner call (release policy: stay pre-1.0.0); (3) **capabilities stay `["sessions","prompt"]`** and `contributes.service` gains no `permissions` key (the new route is served by the service the manifest already declares — `service` is implied, never listed); (4) **kebab-case identity unchanged** — panel id `mecha-turk`, `host.storage` keys keep the `mecha-turk:` prefix and **this feature adds none**; (5) **`SERVICE_VERSION` mirrors `package.json`** (untouched; `tests/service-server.test.ts` pins them together); (6) **SDK pin `1.24.2` untouched** (FR-004); (7) **zero suppressions, zero `any`** — the closed parsers widen by explicit unions, never by cast; (8) **fail closed** — the config, account, bindings, and run readers all refuse a malformed tier, and the panel's closed prompt reader refuses an unknown/out-of-order/duplicated `promptSources` (FR-087, invariant 8's exact wording); (9) **secrets never leave the service store** — refused at the boundary before they are a value, and no surface carries one after; (10) **`extension-spike-1` compatibility** — `promptSources` is an additive `data` member under 002 contract §1's within-v1 rule; the schema version does not change (plan D9 stands).

## Requirement → module mapping (what satisfies what)

| Spec group | Satisfied by (service) | Satisfied by (panel) |
| --- | --- | --- |
| **FR-070, FR-071, FR-072** (three tiers and no fourth; unset contributes nothing, no invented default; layered-not-fallback, sources are a set) | `resolvePromptSnapshot` concatenates only tiers it already *knows* are set — it never reads structure out of text and never substitutes a default (FR-033, FR-071) | composition receives one stacked body; the panel never splits it (FR-084); `promptSources` renders as data, never as message labels |
| **FR-080** (resolve once at detection) | `service/poll/loop.ts` — global from `deps.config`, account from the `readAccount` result already in `scanBinding`, binding from the `binding` already in hand, at the one enqueue call site | none (the snapshot arrives on the claim answer) |
| **FR-081** (global tier is service configuration) | `service/config.ts` (12th member, default `""`), `service/config-schema.ts` (descriptor, `next-cycle`, name union), `service/config-audit.ts` (fingerprint `from`/`to`), `service/config-prompt-observe.ts` (new: observed-change row) | the twelfth Settings row falls out of `settings-rows.ts`'s descriptor loop; `settings-rows.ts` gains the not-set state and the declared guidance |
| **FR-082** (account tier on the account record; profile write, closed body, cascade) | `service/accounts/model.ts` (member + DTO + parse validation), `service/accounts/store.ts` (observed/unobserved read + quarantine reason), `service/routes/accounts.ts` (**the profile `PUT /v1/accounts/:numericUserId`** — closed two-member body, all-or-nothing; the `/display-name` handler **deleted**), `service/routes/index.ts` (registration), `service/account-prompt-audit.ts` (new: observer lane); cascade falls out of the existing `removeAccount` | `src/bindings-service.ts` (`PanelAccount` member), `src/service-calls.ts` (the account profile path — the `…/display-name` pattern retired), `src/accounts-{state,tab,actions,rows}.ts` (field + one write helper, member-only body) |
| **FR-083** (one validator, three call sites) | `validateStartingPrompt` called by the binding parser (existing), by `collectIssues` in `config.ts`, and by the account profile write handler — same four refusals, same no-echo discipline, each wrapper naming its own field | none — the panel renders the service's refusal (existing 422 path); **no second validator** |
| **FR-084** (one fence, stacked body, byte identity) | `service/prompt.ts` `composePromptBody` (join with `\n\n`, order fixed) | `src/prompt.ts` `composeFirstMessage` — fence constants unchanged; golden-string suite proves all four cases |
| **FR-085** (per-tier cap, summed bound, fail-closed floor) | stack cap in `parseStoredPromptSnapshot` (`n×cap + 2×(n−1)` against `sources.length`) | budget floor in `src/relay-attempt.ts` before `host.startSession()`; `promptBlockChars` reserves the **stacked** body |
| **FR-086** (one fingerprint over the composed body) | `promptFingerprint(body)` — unchanged function, new input | none (panel checks `^mtp-[0-9a-f]{32}$` only, plan D11) |
| **FR-087** (`promptSources` everywhere the fingerprint is) | `claim-project.ts`, `run-history-project.ts`, `dispatch-audit.ts` (writers) | `src/prompt.ts` (type), `src/prompt-wire.ts` (closed reader), `src/claim-service.ts`, `src/session.ts` (`data`), `src/dispatches-{service,rows}.ts` |
| **FR-088** (one row per tier change, never text) | `prompt-audit.ts` (binding, unchanged), new `account-prompt-audit.ts`, new `config-prompt-observe.ts` + `config-audit.ts` | none |
| **FR-089** (placement: three fields, one rendering each; arrival writes nothing) | descriptor projection + account DTO; no file is rewritten by arrival | `settings-rows.ts` (row), `accounts-*.ts` (field), `bindings-prompt.ts` (existing field, untouched); SC-105 sentinel-count proof |
| **FR-074** (documentation is a shipped surface) | — | docs task T-037: README + quickstart state the three tiers, the stacking order, and that an unset tier contributes nothing |

## Already built vs. changed vs. new

### Already built — do NOT re-touch

- **002 shipped**: loopback server/auth/body caps, consent, throttles, account custody (`service/accounts/`, `routes/{accounts,verify,credential}.ts`), the bindings surface mechanics, polling/triggers/windows, `buildEventId` (**byte format untouched**), store quarantine funnel, the audit writer, config/health/status, and the panel substrate (handoff, accounts mirror, `repos*` UI, evidence, redaction, ledger, project resolution, verification mechanism, lifecycle, storage-write guard, spike dispatch path).
- **003 shipped**: run model + parsers, claim/lease, authorization family, the lifecycle vocabulary + correlation discipline, `GET /v1/audit`, run-history projection, the relay's reconcile→claim→guard→reserve→persist→report sequence, the multi-reference `buildBoundedContext`, and its four contract files. **004 composes with all of it and changes no state, lease, token, or requeue rule.**
- **004 v1.1.0 shipped (binding tier)** — C1–C12, N1–N6, D1–D13, tasks `T-001`–`T-016` all complete: `service/prompt.ts` (`validateStartingPrompt` L139, `STARTING_PROMPT_MAX_CODE_POINTS` L53, `promptFingerprint` L187, `promptSnapshotOf` L222, `PromptSnapshot` L197–204, `parseStoredPromptSnapshot` L309), the prompt-change observer, the omission-preserves PUT, the enqueue snapshot at `service/poll/loop.ts` L422, the claim trio + `promptText`, the projection trio, the four audit detail scalars, `composeFirstMessage`, the budget reservation, the dispatch-row prompt line, and the four prompt test files.
- **005/006 shipped (amended surfaces)**: the six-tab shell, the Bindings editor's prompt field (`src/bindings-prompt.ts`), the Settings descriptor table (`src/settings-rows.ts` `settingsRows()` maps `envelope.fields` — a new descriptor becomes a new row **without a row-list edit**), the account display-name **field and its draft/save flow** (the pattern FR-082's field copies) — its dedicated `PUT …/display-name` **route is retired by this plan** (D26: the handler is *deleted*, not aliased, and its work moves onto the profile `PUT`), `GET/PUT /v1/config`, `config.changed`, and the fail-closed panel config parser (`src/settings-schema.ts` `StringDescriptor.name` is already `string`, so the panel accepts the twelfth field with the union it has — **no panel parser change is required for the descriptor**, only the service-side name union widens).
- **Invariants**: delivery id format, evidence schema `extension-spike-1` (**version unchanged** — D9), manifest ids/capabilities, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` (`0.0.1`), no new `host.storage` key, existing suite green throughout.

### Changed (existing behaviour/shape moves)

| # | Change | Where | Specs |
| --- | --- | --- | --- |
| C13 | Prompt domain gains the stacked model: `PROMPT_SOURCE` vocabulary (shared), `composePromptBody(tiers)` (set tiers joined by exactly one blank line, order fixed), `resolvePromptSnapshot({ config, account, binding })` returning `{ text, fingerprint, length, sources } \| null`, `promptSnapshotOf` → **`promptTierOf`** (per-tier triple the change rows use), stack cap, and `parseStoredPromptSnapshot` validating `sources` (non-empty iff set, subsequence of `global,account,binding`, duplicate-free, and `length ≤ n×cap + 2×(n−1)`) | `src/prompt.ts`, `service/prompt.ts` | FR-080, FR-083, FR-085, FR-086, FR-087 |
| C14 | Enqueue resolves all three tiers from records already in hand: `deps.config.startingPrompt`, `account.startingPrompt`, `binding.startingPrompt` | `service/poll/loop.ts` (the L420–422 call site) | FR-080, FR-015 |
| C15 | Binding observer switches to the tier helper; its rows keep the **tier's own** fingerprint, unchanged | `service/prompt-audit.ts` | FR-051, FR-086, FR-088 |
| C16 | `ServiceConfig` gains `startingPrompt: string` (default `""` = unset); `collectIssues` routes it through `validateStartingPrompt`; `parseStoredConfig` fills a key the file predates from the default and reports it in `defaultsApplied` (no migration) | `service/config.ts` | FR-081; 006 FR-010, FR-014, FR-040, FR-041 |
| C17 | `TAKE_EFFECT.startingPrompt = 'next-cycle'`; `StringFieldDescriptor.name` widens to `'expectedAgent' \| 'startingPrompt'`; `configSchema()` pushes the twelfth descriptor **last**, matching `collectIssues` order | `service/config-schema.ts` | FR-081; 006 FR-020–FR-022, SC-101, SC-106, AC-107 |
| C18 | `configChanges` keeps raw equality (the no-op detector, 006 FR-048) but records this field's `from`/`to` as `mtp-` fingerprints or `null`; the `ConfigChange` value type widens to `number \| string \| null` | `service/config-audit.ts` | FR-088; 006 FR-071 |
| C19 | `Account` gains `startingPrompt: string \| null` (absent reads `null`); `AccountDto` gains it by name (credential guard untouched); `parseStoredAccount` validates it through `validateStartingPrompt` — a violation refuses the record so the store quarantines it, with the reason captured as `field: remediation`; the **one full-literal account construction** (a freshly verified account, `service/routes/verify.ts`) gains `startingPrompt: null` — a new account starts **unset**, no seeding | `service/accounts/model.ts`, `service/routes/verify.ts` | FR-082, FR-083, FR-071, FR-017; edge case "hand-edited account record" |
| C20 | Observed/unobserved account reads (the `readBindings` pattern): the funnels observe and append `account.prompt-updated` with actor `service`; the profile write uses the unobserved reader so the chain cannot self-deadlock | `service/accounts/store.ts` | FR-088 |
| C21 | The **account profile write** `PUT /v1/accounts/:numericUserId` (method `PUT` on the existing `ACCOUNT_PATH`) replaces the dedicated narrow handler: the body is read as a **closed set of exactly** `{ displayName?, startingPrompt? }` — an absent member means unchanged (FR-014 posture), a body carrying **neither** member is refused `422` (`field: "body"`, a no-op), and any other key — the eleven custody/identity keys `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt` — is refused `422` **by name with no echo**; issues are collected additively in one pass and **any issue refuses the whole write** (neither member, no `updatedAt`, no audit row); `startingPrompt` validates through `validateStartingPrompt`, `displayName` through the shipped `validateDisplayName`; the write is whitelist-by-construction (server-read record + the validated keys present in the body + fresh `updatedAt` — the client never submits a record); appends `account.prompt-updated` (actor `operator`, inside the chain, **only when the prompt member changes**); `200 { account }`, `404 unknown-account`, `422`, `401`/`503` unchanged. **The `ACCOUNT_DISPLAY_NAME_PATH` route, its body refusal, and `handleSetDisplayName`/`setDisplayNameRoute` are deleted** — no alias, redirect, or legacy handler (005 v1.10.0; unreleased, row 32) | `service/routes/accounts.ts`, `service/routes/index.ts` | FR-082, FR-083, FR-088; 005 FR-066; layered-prompt §2; account-display-name §2, §4 (invariants 4–6, 8) |
| C22 | `promptSources` joins both dispatch audit rows (from the run's snapshot, never panel input) | `service/poll/dispatch-audit.ts` | FR-050, FR-087 |
| C23 | Claim entries and run-history rows gain `promptSources` (unset ⇒ `null`) | `service/poll/claim-project.ts`, `service/poll/run-history-project.ts` | FR-052, FR-087 |
| C24 | `PromptSource` vocabulary + `PromptReference.promptSources`; the closed reader refuses unknown tier / wrong order / duplicate / presence disagreement — **one refusal refuses the entry, and one refused entry refuses the answer** | `src/prompt.ts`, `src/prompt-wire.ts` | FR-087, AC-151; invariant 8 |
| C25 | Claim DTO, `NO_PROMPT`, and attachment `data` carry `promptSources` (additive within `extension-spike-1`) | `src/claim-service.ts`, `src/session.ts` | FR-037, FR-087 |
| C26 | **Budget floor**: `runRequestOf` composes, then refuses before `host.startSession()` when the message would exceed `CONTEXT_MAX_CHARS` — no session, no truncation, remediation naming the contributing tiers from `promptSources` | `src/relay-attempt.ts` | FR-085, AC-147, SC-132 |
| C27 | Dispatch row's prompt line carries the sources (`prompt set · global+account+binding · mtp-… · N chars`) through the existing non-HTML path | `src/dispatches-service.ts`, `src/dispatches-rows.ts` | FR-052, FR-087 |
| C28 | `PanelAccount` gains `startingPrompt` (fail-closed parse); `service-calls.ts` swaps the `ACCOUNT_DISPLAY_NAME_PATTERN`/`accountDisplayNamePath` builder for the **account profile path** (same `:numericUserId` segment, no `/display-name` suffix) so both members travel one path | `src/bindings-service.ts`, `src/service-calls.ts` | FR-082; 005 FR-066 |
| C29 | The Accounts field: per-row draft, save control, service-refusal rendering, honest "not set" state, FR-063 guidance; row summary keeps presence/length only (never text, never fingerprint). **One write helper** PUTs the profile path with **only the member being edited** (`{ startingPrompt }` for the prompt field, `{ displayName }` for the label — absent = unchanged, so neither field can clobber the other), re-pointing the existing label save off `…/display-name` | `src/accounts-state.ts`, `src/accounts-tab.ts`, `src/accounts-actions.ts`, `src/accounts-rows.ts` | FR-063, FR-064, FR-082, FR-089; 005 FR-051, FR-066 |
| C30 | The Settings row: the twelfth row renders from the descriptor automatically; the row gains the **not-set word** for an empty string field and renders the service-declared `format` guidance | `src/settings-rows.ts` (+ `settings-*` tests) | FR-064, FR-081, FR-089; 006 FR-010, FR-014, FR-081 |
| C31 | Docs and cross-contract pointers: README + quickstart re-cut for three tiers (replacing the "store file is the set path" era), `AGENTS.md` module-map rows, additive `promptSources` notes in 003's three contract files | `README.md`, `specs/002-agent-event-extension/quickstart.md`, `AGENTS.md`, `specs/003-dispatch-integrity/contracts/*.md` | FR-074, FR-089 |
| C32 | Scan suites: `tests/bundle.test.ts` `PROMPT_MODULES` gains the new modules; containment, secret, and `audit.ndjson` sentinel scans widened to three tiers | `tests/bundle.test.ts`, `tests/containment-proof.test.ts`, prompt suites | NFR-121, FR-088, AC-143, AC-148, AC-151 |

### New

| # | New thing | Where | Specs |
| --- | --- | --- | --- |
| N7 | The **config-tier observation lane**: per-store chain + baseline seeded from the highest-seq `config.changed` `changes[].to` for `startingPrompt` (`null` when the trail has none), appending one `config.changed` row with actor `service` when the stored document differs from the baseline — hooked at the **cycle config read**, the same cadence the bindings observer gets | `service/config-prompt-observe.ts` (new module) | FR-088; 006 FR-070 |
| N8 | The **account-tier observation lane**: the same chain+baseline pattern seeded from `account.prompt-updated` rows, row shape per layered-prompt §2 | `service/account-prompt-audit.ts` (new module) | FR-088, SC-125's one-row rule |
| N9 | **No new store file, no new host.storage key, no new test file, no new dependency.** The prompt test files that already exist (`prompt-validation`, `prompt-snapshot`, `prompt-composition`, `prompt-claim`, `prompt-audit`, `prompt-upgrade`) are extended instead — the v1.2.0 change-efficiency posture (004 changelog.md) | — | NFR-129, NFR-128 |

**Per-requirement headline split**: already built = transport, custody, polling, stores, audit writer, config surface, panel substrate, 003's run layer, **and 004's shipped binding tier**; changed = C13–C32; new = N7–N9.

## Architecture (decided)

### Resolution once, at detection (FR-080, FR-015)

```text
poll cycle ─ readCycleConfig ─▶ deps.config.startingPrompt        (global tier)
           ─ readBindings   ─▶ binding.startingPrompt            (binding tier)
           ─ readAccount    ─▶ account.startingPrompt            (account tier)
   ▼
scanBinding (all three in hand, same objects that produced projectId/worktreeOption)
   ▼
resolvePromptSnapshot({ global, account, binding })
   ├─ validate each tier through validateStartingPrompt   ← no coercion, per tier
   ├─ keep the set tiers, drop the unset ones              ← an unset tier contributes nothing
   ├─ body = tiers.join('\n\n') in order global → account → binding
   ├─ fingerprint = promptFingerprint(body)   (mtp-, over the composed body — FR-086)
   ├─ length      = countCodePoints(body)
   ├─ sources     = ['global'?,'account'?,'binding'?]      (ordered, dup-free — FR-087)
   └─ null when no tier is set                             ← no fence, pre-004 bytes (FR-071, FR-032)
   ▼
enqueueEvents ─▶ run.prompt = snapshot        (one member, four properties)
```

The resolution point is `service/poll/loop.ts`'s existing enqueue call — the object that already carries `projectId`/`worktreeOption` — so "at the same moment" is structural, not a timing assumption. **The composition never evaluates tier text**: it concatenates structure the resolver already knows (FR-080's "never structure it reads out of text").

### One validator, three save boundaries (FR-083)

`validateStartingPrompt` (service/prompt.ts L139) is untouched in its eight-step order and its closed four-refusal set. It gains **call sites**, not rules:

| Boundary | Wrapper | Field/remediation voice |
| --- | --- | --- |
| Bindings write + read | `parseBinding` (existing, C1) | `startingPrompt` on the binding document |
| Config write + read | `collectIssues` → `validateStartingPrompt(raw.startingPrompt)` (C16) | `startingPrompt` in the `422` additive issues of `PUT /v1/config` |
| Account write + read | the profile PUT's body reader / `parseStoredAccount` (C19, C21) | `startingPrompt` on the account resource |

A refusal at one tier never reads, writes, or reports another tier's value (AC-150), and each wrapper reports in its own surface's vocabulary while the **shape labels stay identical** across all three (AC-150's "identical shape labels").

### The global tier rides the document 006 already owns (FR-081)

No new route, no new error code: `GET/PUT /v1/config` already carry the whole document. `startingPrompt` is a **required** member with documented default `""` (empty = unset), so the whole-document rule (006 FR-040/FR-041) is unchanged — a body missing it is a `422`, a stored file missing it is filled and reported in `defaultsApplied` (004 FR-018's no-migration posture; 006 FR-028's fill). The descriptor declares `kind: 'string'`, `unit: null`, `format` = the validator's own rule prose (which carries FR-063's guidance), `maxLength: 2000`, `default: ""`, `takesEffect: 'next-cycle'` — the class is a **tested claim** (006 FR-031): a detection in the cycle after a save composes with the new text; a queued run does not.

### The account tier rides the account profile write (FR-082)

One route, one handler, one contract for both operator-editable members: `PUT /v1/accounts/:numericUserId`, body `{ displayName?: string | null, startingPrompt?: string | null }`, absent member = unchanged — specified by 005's contract [account-display-name.md](../005-panel-ia/contracts/account-display-name.md) §2 (*Account Profile Write*, amended in place at 005 v1.10.0 / 004 v1.4.0), whose §2 the layered-prompt contract's §2 rides for the prompt half. **The safety rule replaces the discarded narrow-operation rationale**: the body is read as a **closed set of exactly those two members**, so all eleven custody/identity keys are refused **explicitly** — `422 validation`, one issue naming the key, field-level remediation, **no echo of the submitted value** — which is strictly stronger than making them unreachable by route shape; a body carrying **neither** member is refused as a no-op (`422`, `field: "body"`), never a silent `200`; issues are collected additively in one pass and **any issue refuses the whole write** (neither member, no `updatedAt`, no audit row); and the write itself is whitelist-by-construction — the record the **service** read, spread with the validated operator keys present in the body, plus a fresh `updatedAt` (the client never submits a record). `startingPrompt` validates through the single `validateStartingPrompt` (FR-083), `displayName` through the shipped six-step label rule; each refusal renders under its own field name. **`/display-name` retires with the swap**: the shipped handler is deleted outright — no alias, no redirect, no legacy route (unreleased: zero tags, `version` 0.0.1, PR #8 only — row 32), and the dedicated `…/starting-prompt` endpoint this plan first drafted never exists. **Cascade** falls out of deletion itself — `DELETE ?force=1` removes the record (and therefore the tier), still disables the referencing bindings, still writes `account.deleted`; queued runs keep their snapshot; a re-added account reads `null` (no seeding, FR-071); rotation and login rename spread the record and leave both members byte-identical (the `displayName` rule).

### `promptSources` — one closed vocabulary, one closed reader (FR-087)

```ts
type PromptSource = 'global' | 'account' | 'binding';        // src/prompt.ts (shared)
PROMPT_SOURCE_ORDER = ['global', 'account', 'binding'] as const;
// PromptReference gains:  promptSources: readonly PromptSource[] | null
// invariant: promptPresent ⇔ promptSources is a non-empty ordered duplicate-free list
```

Written by the service from the snapshot (claim, run row, both dispatch rows); written by the panel into `data`; read by **one** function — `readPromptReference` — which both the claim answer and the run-history row already share, so the extension lands once and applies to both. Unknown tier, wrong order, duplicate, or presence disagreement ⇒ `null` ⇒ the entry is refused ⇒ **one refused entry refuses the whole answer** (the reader's standing posture; AC-151). There is no defaulting branch to write: the feature has never been released, so no record lacking `promptSources` can exist, and one that arrived would be refused (row 32).

### Composition and the budget floor (FR-084, FR-085)

The panel's composition is **unchanged in shape**: it receives an already-stacked body and fences it. What changes is arithmetic and the floor:

- **Reservation**: `promptBlockChars(body)` = fence (38) + body + fence (36) + 4 = body + **78** as the shipped function computes it (`src/prompt.ts` L224 — the stacked body now includes its `n−1` separators, and of those four code points two are the fence's own newlines and two are the blank line between the fence end and the frame) ⇒ **6,082** at the default cap (**9,082** at the ceiling). The contract states the same reservation on the **body + fence** convention: [layered-prompt.md](./contracts/layered-prompt.md) §4 rule 3 counts the fence as **76** (38 + 36 + its two newlines) and budgets the blank line before the frame on the **frame** side ⇒ ≤ **6,080** (≤ **9,080** at FR-021's ceiling). The two numbers differ by exactly those 2 code points and **neither document drops them**: the plan's 6,082 includes them (the frame-side blank line, as the code reserves it), the contract's 6,080 attributes them to the frame — so a reader reconciling a reserved-chars claim against §4 rule 3 subtracts 2. The body bound (**6,004 / 9,004**) and the totals (7,680 / 10,680) are identical under either convention. The reservation is still subtracted **before** the excerpt budget is sized, so the excerpt is what shortens (FR-035 unchanged; no tier is ever shortened).
- **Bound**: body ≤ `3 × 2_000 + 2 × 2 = 6_004` code points at the default cap (`9_004` at FR-021's 3,000 ceiling) ⇒ block + frame (≈ 400) + full excerpt allowance (1,200) ≈ **7,700 / 10,700**, inside `CONTEXT_MAX_CHARS` (12,000) and far inside `GUEST_ATTACH_TEXT_MAX` (16,000) — FR-085's conclusion holds, and at 004 **v1.4.1** the specification states the exact sums beside the rounded ones: 6,004 + 76 + 400 + 1,200 = **7,680** and 9,004 + 76 + 400 + 1,200 = **10,680** (the prose integers FR-085 once quoted, 6,002 / 9,006, were corrected to the rule's own figures at that version); see [research.md](./research.md) §R-1 for the arithmetic and for how the prose/rule discrepancy this pass first found was closed.
- **Floor**: after composing, `runRequestOf` refuses when `composed.length > CONTEXT_MAX_CHARS` — reachable **two ways**: a store hand-edited past its validators, or a **legal** supplementary-plane-heavy (emoji/astral) stack whose code-point sums sit inside the per-tier cap *and* inside the run reader's stack bound (both count code points) while its UTF-16 length is over the floor — **before `host.startSession()`**, with a remediation naming the contributing tiers from `promptSources`, starting no session and truncating nothing (AC-147; reachability corrected at 004 **v1.4.2** — this item once said *"reachable only from a store hand-edited past its validators (the run reader's stack cap is the first line)"*, which is false for route two: the stack bound counts code points and therefore does not stop it). The floor stays in **UTF-16** on purpose: `CONTEXT_MAX_CHARS` budgets the message the host receives, and the host enforces `GUEST_ATTACH_TEXT_MAX` as a JS string limit, so a code-point floor would admit messages the host clamps or rejects.

### Audit: one row per tier change, never a byte of text (FR-088)

| Tier | Row | Actor rule | Value rule |
| --- | --- | --- | --- |
| binding | `binding.prompt-updated` (shipped) | `operator` via PUT, `service` observed | tier fingerprint |
| account | `account.prompt-updated` (new) | `operator` via the profile write **when `startingPrompt` changes** (a `displayName`-only write appends nothing — a label is not a tier, 005 adds no event type), `service` observed | presence, fingerprint, length, previous fingerprint — never text |
| global | `config.changed` (006's row, value-free for this field) | `operator` via `PUT /v1/config`, `service` observed without a write | `from`/`to` = `mtp-…` or `null`; `takesEffect: 'next-cycle'` |

Both new lanes copy `prompt-audit.ts`'s correctness argument: **one chain per store handle** linearises read → diff → append → baseline advance, so SC-125's "exactly one row per change" holds by construction rather than by timing; the baseline is seeded once from the trail itself (no new store file, NFR-129) and advances even when an append fails (003 FR-063 posture: warn + visible, nothing rolls back).

## Key decisions and rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| D14 | The **service** resolves and stacks the tiers; the panel receives one body | The panel holds no config document and no account record; stacking service-side keeps one resolver, one fingerprint input, and a claim answer that still carries a single `promptText` (no third transport for tier text) | resolving panel-side (would ship all three texts and re-derive structure where FR-084 forbids parsing); a service-built whole message (the service never calls the host — D13/constitution VII) |
| D15 | `PromptSnapshot` gains `sources`; `promptSnapshotOf` is renamed **`promptTierOf`** and returns the per-tier triple | The rename is a compile error at every call site, which is how `loop.ts` is forced to adopt the resolver instead of silently producing binding-only snapshots; the change rows still need a *tier* fingerprint (FR-086) | three snapshots on the run (multiplies every row and parser); keeping the old name (a silent wrong-snapshot bug) |
| D16 | Stack cap = `n × cap + 2 × (n − 1)`, checked in the **run reader** against `sources.length` | Sources are a separate member, so the bound can be cross-checked without ever splitting the body (FR-084: structure is built, never parsed) | capping the body at `3 × cap` only (misses the separators and lets a hand-edited row drift); re-splitting on `\n\n` (forbidden — a tier's own blank lines are legal text) |
| D17 | The global tier rides `config.json` and its existing whole-document PUT | 006 clarification row 22 already rejected a dedicated route for this field; no new error code, no second write path, and the Settings row falls out of the descriptor | a dedicated `/v1/config/start-prompt` route (forks FR-040's whole-document rule for one field) |
| D18 | **Superseded at the 2026-10-02 gate by D26** — *was (v1.3.0):* "the account tier gets a **dedicated** `PUT …/starting-prompt`" | *Was:* FR-082 then required it, for 005's reason — a narrow operation cannot clobber `state`/`scopeCheck`/`credential`. Preserved (marked, not erased) because the overturn replaces the rationale rather than contradicting it, the same quoting discipline 005's contract §2 applies to its own plan D8 — both quotes stand beside the ruling that replaced them | *Was:* a whole-account PUT (custody-field clobber); riding the bindings write (the tier does not live on a binding) — the first is superseded by D26's closed two-member body, the second still holds |
| D19 | Two **new small observer modules** (N7, N8) instead of growing `prompt-audit.ts` | One responsibility per module (AGENTS.md) and the file-length gate: `prompt-audit.ts` is already 320 lines; each new lane owns its own chain, baseline, and row vocabulary | one three-lane module (mixed vocabularies, gate risk); a persisted baseline file (a new store file nobody specified — NFR-129) |
| D20 | The fingerprint and `promptLength` describe the **composed body**; per-tier fingerprints live only on the change rows | FR-086: one `mtp-` scalar per run keeps every parser; a binding-only body *is* the tier text, so the shipped single-tier golden fingerprint still holds | three fingerprints per run surface (multiplies a thirteen-row lifecycle for provenance the change rows already answer) |
| D21 | `configChanges` compares **raw strings** (no-op detection stays 006 FR-048's) but records `startingPrompt` as fingerprints | Equality must stay byte equality of the stored string; only the *recorded pair* is mapped, so no other field's row shape moves | fingerprinting before comparison (a hash comparison for no gain); recording text (banned by FR-053) |
| D22 | The budget floor reports a **failed attempt** via the existing `dispatch.result` `problem`, not a new `blocked:` reason | `BLOCKED_REASONS` is 003's closed four-value set and 004 "does not restate and does not contradict" the state model; `problem` is already bounded free text written from the panel's own finding | a fifth `blocked:` reason (a 003 vocabulary extension 004 does not own); truncating to fit (explicitly forbidden); refusing pre-reserve with no wire path to carry it |
| D23 | FR-063's guidance for the Settings row is **declared by the service** in the descriptor's `format` prose | 006 FR-014 renders every row affordance from the service declaration, and the guidance must describe *this validator's* rules; the panel composes the not-set word for an empty value (FR-064) | panel-authored guidance (would drift from the validator and violate FR-014's "none from a value typed into the panel") |
| D24 | The Accounts field copies the display-name draft/save flow exactly: per-row draft, service refusal rendered, **no panel-side validation** | The service is the single save boundary (D2, FR-083); a panel validator would invent a second boundary that could disagree with the first | panel-side `findSecretLeak` before save (D10's rejection stands: it can only fail into an unspecified state and silently dropping text is the redact behaviour FR-024 rejects) |
| D25 | The panel validates `promptSources` as **list shape only** — never derived from the message | D10 stands: one boundary, and the list is service-authored over a service-parsed store; deriving sources from the block would violate FR-084 | recovering tiers from the message (there are no tier labels to find, by design) |
| D26 | **The account tier rides the account profile write `PUT /v1/accounts/:numericUserId` (body `{ displayName?, startingPrompt? }`, absent = unchanged) — one handler, one contract — and both dedicated routes retire**: the planned `…/starting-prompt` endpoint never exists, and the shipped `/display-name` handler is **deleted**, not aliased | The product owner's ruling at the 4–5 gate (2026-10-02), verbatim: *"Approved except the separate endpoint for prompts. I think the prompts should be part of the record instead of separate CRUD."* — with the option the owner then chose, verbatim: *"PUT /v1/accounts/:numericUserId carrying { displayName?, startingPrompt? }. Absent = unchanged. Retires /display-name entirely (free — nothing released). One handler, one contract, ~2 fewer tasks."* The **closed two-member body** refuses the eleven custody/identity keys **by name** (`422`, field-level remediation, no echo), which is strictly stronger than D18/D8's route-shape protection; a no-op body is refused, any issue refuses the whole write, and the write is whitelist-by-construction — so the whole-account-PUT objection loses its force while the endpoint-per-field growth stops. **This overturns 005's plan D8 at the gate** (D8's chosen shape: *"`displayName` gets its **own narrow write route** … a dedicated `PUT` cannot overwrite custody fields by accident"*; D8's rejected alternative: *"a whole-account `PUT` (a mistyped body could clobber `state`/`scopeCheck`)"*). **005's plan is a dated record and is not edited** — the override is noted here, and in 005's spec/contract, which the planner owns. Evidence for deletion-over-alias: zero git tags, `version` 0.0.1, PR #8 only (row 32) | keeping the dedicated prompt endpoint (the ruling itself); a whole-account `PUT` without a closed body (D8's rejected alternative — still rejected: the body never spreads client input); an alias/redirect for `/display-name` (005 v1.10.0 forbids it — nothing was released, so there is nothing to stay compatible with); folding the prompt into `POST …/token` (couples a tier to rotation, and 002 owns that route) |

## Migration & rollout strategy

**There is no migration, and that is the design** (FR-018, FR-089, SC-128, row 32): zero git tags, `package.json` `0.0.1`, and no released build has ever held prompt state — so nothing exists to adopt, backfill, or defend against, and this plan writes **no compat code**.

| Stored artefact | After the feature arrives | Mechanism |
| --- | --- | --- |
| `config.json` lacking `startingPrompt` | parses unchanged; the key is filled from `""` and reported in `defaultsApplied`; **no `config.changed` row is written by the fill** (an unset tier equals an unset baseline: `null`) | `parseStoredConfig`'s documented-key fill (006 FR-028) |
| `accounts/<id>.json` lacking the member | reads `null` (unset); the file is not rewritten, not quarantined | `parseStoredAccount` treats absence as unset |
| `accounts/<id>.json` with a hand-edited invalid tier | quarantined with `field: remediation` logged, the account does not scan until repaired | C19 + the store's quarantine funnel |
| `PUT …/display-name` (a route, not a document) | **deleted**; the panel's label save and the new prompt field both PUT the profile path — panel and service ship in one build (invariant 1), so no shipped build ever answers the retired route with anything but the unknown-route refusal, and none ever calls it | C21 + C29, plan D26; no alias/redirect (row 32 evidence; 005 v1.10.0) |
| `bindings.json` | unchanged (binding tier shipped) | — |
| `runs.json` rows | a stored `prompt` without `sources` **refuses the document** — not defaulted (FR-087) | no released record can carry one (row 32) |
| `audit.ndjson` | append-only; the two new lanes' baselines seed from rows that do not exist yet ⇒ start `null` ⇒ no spurious first row | chain-seeded baseline pattern |
| In-flight queued work | dispatches with the snapshot it queued with, fingerprint and sources intact | resolution at enqueue |
| Panel / manifest | no key, no capability, no `version`, no `SERVICE_VERSION`, no SDK re-pin | invariants 2–6 |

**Rollout mechanics**: panel and service ship together in one commit (invariant 1 — bundles rebuilt); the widened closed reader and the widened writers arrive in the **same build** (the contracts' co-ship assumption), so an old-shape answer to a new panel cannot occur — and the profile `PUT`, the deleted `/display-name` handler, and the panel's re-pointed path arrive in that same build, so no intermediate state calls a route that no longer exists. Upgrade validation is a named test (T-036): seed documents predating the field → boot the service → assert zero quarantines by arrival, zero scan-window resets, unchanged delivery ids / run keys / correlation ids, and the pre-004 golden composition for a run with no tier set.

## Cross-feature coordination & surfaced conflicts

1. **NFR-129 vs FR-082 — closed at 004 v1.4.1; no disagreement remains.** 004 NFR-129 (written at v1.0.0) said the feature "adds no new service route beyond the existing bindings surface". At v1.3.0 this plan read that against a mandated dedicated endpoint and surfaced the disagreement; at v1.4.0 the gate ruling removed most of the tension — the plan **adds** `PUT /v1/accounts/:numericUserId` and **removes** `PUT /v1/accounts/:numericUserId/display-name`, one route swapped for one route, net route count unchanged, no new surface *family* to learn, no host call, no permission, no capability (005's Wire Surface Delta Accounts row is cut the same way: "one operation added, one retired") — while NFR-129's literal wording still did not describe a method/path swap; **at v1.4.1 the owner-approved reword ("reword NFR-129's one sentence") closed that residue**: NFR-129 now reads **"no new service route beyond the existing bindings, account, and configuration surfaces"** and states the accounts surface as **net unchanged** — exactly one route added (the profile `PUT`, FR-082) and exactly one retired (`/display-name`), one for one. Nothing to recommend to the PM any more: the clause this item once asked for has been reworded into the text. **No code decision ever depended on it** — FR-082 (v1.4.0) is the later, owner-scoped, requirement-specific text, specified in full by both contracts, and this plan implements it.
2. **006 (the twelfth field).** Admitted under 006 FR-084's own test. Two ordering rules must hold together: `configSchema()` descriptor order == `collectIssues` order (006 AC-107), so `startingPrompt` is appended **last** in both; and the exhaustive `TAKE_EFFECT` table gains its key so a field without a class fails `tsc` (006 SC-106). 006's `config.changed` row shape is amended **for this field only** (fingerprints); every other field's `from`/`to` is untouched.
3. **005 (two rendered fields).** FR-051/SC-105/AC-123 now count **one rendering per tier value**. The binding tier stays where it is; this plan adds the account field (C29) and the Settings row (C30) and nothing else that renders a tier — the Dispatches line (C27) shows presence/length/fingerprint/sources, never text, which the single-rendering rule expressly allows.
4. **003 (one additive member, no vocabulary change).** `promptSources` joins two audit `details` payloads and the claim/projection shapes — the same additive move 004 already made for the four scalars; **no event type, state, lease, token, correlation id, or `blocked:` reason changes**. T-037 patches 003's three contract files with pointer notes so the directories cannot disagree.
5. **FR-062's "the store file is the set path" era is over** — 005 landed the bindings editor and FR-089 adds two more fields. T-037 re-cuts README/quickstart so no document tells an operator to hand-edit `bindings.json` as the primary path (the file stays documented as the low-level/validated store).
6. **Anchor verification (no drift found).** Every code anchor in the Phase-4 brief was re-read
   against the tree before this plan was written and **all of them held**: `validateStartingPrompt`
   (L139), `STARTING_PROMPT_MAX_CODE_POINTS` (L53), `promptFingerprint` (L187), `promptSnapshotOf`
   (L222), `PromptSnapshot` (L197–204), `parseStoredPromptSnapshot` (L309); the enqueue-time
   resolution point at `service/poll/loop.ts` L420–422; `promptViewOf`
   (`service/poll/claim-project.ts` L199–219) still the only place `promptText` reaches the wire;
   `ServiceConfig` (L58–107), `DEFAULT_CONFIG` (L159), the `knownKey` gate (L266), `collectIssues`
   (L278); `TAKE_EFFECT` (L47), the closed `FieldDescriptor` union, `StringFieldDescriptor.name`
   narrowed to `'expectedAgent'` (L100), `configSchema()` (L132–163); `composeFirstMessage`
   (`src/prompt.ts` L248–260), fence constants (L28/L31), `promptBlockChars` (L224),
   `buildBoundedContext` (`src/session.ts` L195–230), `runRequestOf` (`src/relay-attempt.ts`
   L149–195), the dispatch-row line (`src/dispatches-rows.ts` L414), and `src/prompt-wire.ts`
   L32–108. Three brief claims were verified as *design facts* rather than line numbers: the
   Settings row genuinely falls out of `settingsRows()`'s `envelope.fields` map (no row-list edit),
   `service/routes/accounts.ts` really does carry the dedicated `/display-name` handler this plan
   **deletes** in favour of the profile `PUT` (`ACCOUNT_DISPLAY_NAME_PATH` L64, `handleSetDisplayName`
   L491–522, `setDisplayNameRoute` L539, registered from `routes/index.ts` L22/L48; `ACCOUNT_PATH`
   L61 already serves `DELETE`, so the profile write registers a second method on a path that
   exists), the panel-side counterpart is `ACCOUNT_DISPLAY_NAME_PATTERN`/`accountDisplayNamePath`
   (`src/service-calls.ts` L100/L296) called from `accounts-actions.ts` L206 with
   `JSON.stringify({ displayName: … })`, and its assertions live in
   `tests/service-accounts.test.ts` (the `describe('PUT /v1/accounts/:id/display-name …')` block,
   L604) and `tests/accounts-ui.test.ts` (the path assertion, L646) — all four anchors re-verified
   2026-10-02 for this gate re-cut; and
   `tests/bundle.test.ts` really does carry a `PROMPT_MODULES` list the new modules must join.

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A stored body whose `sources` and `length` disagree (hand-edited `runs.json`) | a claim answer that lies about which tiers ran | the run reader cross-checks `length ≤ n×cap + 2×(n−1)` and refuses the document (C13); refusal tests seeded in T-018 |
| `promptText` grows from ≤2,000 to ≤6,004 characters per claimed run | fewer runs per claim page | `measureEvents` already paginates against `CLAIM_EVENTS_BUDGET_CHARS` — pagination, never truncation; T-024 re-derives the maximal-batch bound test instead of reusing the old constant |
| Settings/`take-effect` tests pin row counts (11 → 12) | red suite on an editorial expectation | counts are asserted **against the projection** (006 SC-106's own shape), so T-030 updates the expectation with the field's name and class, not a bare number |
| Config observer writes a spurious first row when a file predates the field | an audit trail that claims a change nobody made | the fill produces `""`, which maps to the unset fingerprint `null`, which equals a fresh baseline ⇒ zero rows; asserted in T-021 |
| Account observer races the profile write | duplicate or stale `account.prompt-updated` | the profile write reads **unobserved** inside the same chain (C20), mirroring the shipped bindings posture; deterministic chain test, no sleeps |
| The profile write's closed body is wider than the handler it replaces | a custody key (`credential`, `state`, …) reaching the stored record, or a two-member body half-applied | whitelist-by-construction (server-read record + validated keys + `updatedAt` only), additive issue collection, **any issue refuses the whole write**; the contract's invariants are named deliverables in T-023 — invariant 5 (deep-compare: supplied members + `updatedAt` and nothing else), invariant 6 (each of the eleven custody keys refused by name, no echo, byte-identical record), invariant 4 (no-op body refused) |
| Deleting `/display-name` strands its shipped tests, handler, and panel path | a red suite, or a panel save PUTting a route that resolves nowhere | T-023 removes the route/handler/registration and re-cuts `tests/service-accounts.test.ts`'s display-name block to the profile route, **plus invariant 8** (the retired route — and the never-built `…/starting-prompt` — resolve nowhere: unknown-route refusal, no alias); T-031 re-points `service-calls.ts` and `tests/accounts-ui.test.ts`'s path assertion in the same wave; invariant 1 co-ships panel and service so no build calls the old path |
| Budget floor fires on a legal composition | a dispatch refused that should run | the arithmetic bound (T-018's stack cap + T-034's budget proof) makes the floor unreachable for any value the validators accept; the floor test (T-029) seeds an over-budget claim fixture directly |
| The twelfth descriptor breaks the panel's closed config parser | Settings tab refuses the whole envelope | `StringDescriptor.name` is already `string` and `kind: 'string'` is already in the union — no parser change; T-030 still asserts the round trip |
| Forgetting the committed bundles | shipped code ≠ source (invariant 1) | every wave boundary runs `npm run build` inside `npm run verify`; `tests/bundle.test.ts` scans the rebuilt files |

## Out-of-scope guard (checked at every wave)

**No fourth tier, no repository-group prompt, no fallback chain** (FR-070/FR-072 — stacking replaced the reserved fallback). **No content policy beyond the four refusals** (FR-029) — including *no* refusal of prompts that name an agent: verbatim, pinned agent (FR-040, AC-135). **No templating or substitution of any kind** (FR-039). **No GitHub write** (002 FR-031, 003 FR-002, FR-002). **No change to the dispatch state machine, leases, tokens, requeue budgets, correlation ids, or the `blocked:` reason set** (003 owns them; plan D22). **No preview or second rendering of any tier's value** (005 FR-051 as amended — one rendering per value; no composed-message preview surface). **No migration, backfill, or legacy-projection code** (row 32). **No alias, redirect, or legacy handler for either retired route** (`…/display-name`, `…/starting-prompt` — plan D26; 005 v1.10.0). **No new host capability, permission, or private interface** (FR-004). **No `version`, `SERVICE_VERSION`, evidence-schema, or SDK-pin change.** **No policy profiles, no retention tuning, no bulk prompt operations.** **No new store file and no new `host.storage` key.**

## Project structure

### Documentation (this feature)

```text
specs/004-starting-prompt/
├── spec.md                # v1.4.2, APPROVED — the source of truth (FR/AC quoted as written; FR-082 re-cut at the gate; FR-085's figures + NFR-129's sentence corrected at v1.4.1; FR-085's floor reachability corrected at v1.4.2)
├── plan.md                # this file (/speckit.plan, v1.4.2 — synced to the gate corrections and the pre-PR review correction; the gate re-cut of the v1.3.0 pass)
├── research.md            # settled sources + the technical defaults this plan chose + open items
├── data-model.md          # three-tier field delta, the profile write's closed body, composed snapshot, promptSources, audit rows
├── contracts/
│   ├── README.md          # index (already lists layered-prompt.md — unchanged this pass)
│   ├── binding-prompt.md  # binding document field (shipped; unchanged)
│   ├── dispatch-prompt.md # claim/projection/audit/attachment shapes (amended by layered-prompt §3)
│   └── layered-prompt.md  # THE wire contract for all three tiers (spec 004 v1.4.2; §2 re-cut, §4 rule 3's figures corrected at 004 v1.4.1, §4 rule 3's reachability corrected at 004 v1.4.2 — binding for Phase 6)
├── tasks.md               # Phase 5 output (/speckit.tasks) — tasks T-017 … (T-022 withdrawn, merged into T-023)
└── checklists/requirements.md   # Phase-3 checklist (untouched)
```

No new contract file is needed: `layered-prompt.md` already specifies all three tiers, the `promptSources` wire type, and the stacked composition's testable rules, and it incorporates the 006 `config-schema.md` and 005 `account-display-name.md` patterns by reference. `quickstart.md` is deliberately not produced here — FR-074's operator page lands in `README.md` + `specs/002-agent-event-extension/quickstart.md` (T-037), where operators already look.

### Source code (repository root — the real layout this plan changes)

```text
src/
├── prompt.ts              # CHANGED: PromptSource vocabulary + PromptReference.promptSources (C24; fence/rules unchanged)
├── prompt-wire.ts         # CHANGED: closed reader gains the sources iff + order/dup checks (C24)
├── claim-service.ts       # CHANGED: ClaimedRun + promptSources (C25)
├── session.ts             # CHANGED: NO_PROMPT + data.promptSources (C25); buildBoundedContext unchanged
├── relay-attempt.ts       # CHANGED: budget floor before startSession + data sources (C26)
├── dispatches-service.ts  # CHANGED: RunRow inherits promptSources (C27)
├── dispatches-rows.ts     # CHANGED: prompt line names the sources (C27)
├── bindings-service.ts    # CHANGED: PanelAccount + startingPrompt (C28)
├── service-calls.ts       # CHANGED: account profile path replaces the display-name pattern (C28)
├── accounts-state.ts      # CHANGED: per-row prompt draft + refusal (C29)
├── accounts-tab.ts        # CHANGED: field mount, not-set state, save control (C29)
├── accounts-actions.ts    # CHANGED: one write helper → profile PUT, member-only body (C29)
├── accounts-rows.ts       # CHANGED: presence/length only on summaries (C29)
├── settings-rows.ts       # CHANGED: not-set word + declared guidance for the string row (C30)
└── main.js (panel/)       # REBUILT + committed (invariant 1)

service/
├── prompt.ts              # CHANGED: resolver, stack cap, PromptSnapshot.sources, promptTierOf (C13)
├── poll/loop.ts           # CHANGED: three-tier resolution at enqueue + config-observation hook (C14)
├── prompt-audit.ts        # CHANGED: tier helper only; binding rows unchanged (C15)
├── config.ts              # CHANGED: twelfth field + validation (C16)
├── config-schema.ts       # CHANGED: descriptor, TAKE_EFFECT, name union (C17)
├── config-audit.ts        # CHANGED: fingerprint from/to for this field (C18)
├── config-prompt-observe.ts  # NEW: the config lane (N7)
├── accounts/model.ts      # CHANGED: member, DTO, parse validation (C19)
├── routes/verify.ts       # CHANGED: the one account literal gains `startingPrompt: null` (C19)
├── accounts/store.ts      # CHANGED: observed/unobserved readers + quarantine reason (C20)
├── account-prompt-audit.ts   # NEW: the account lane (N8)
├── routes/accounts.ts     # CHANGED: profile PUT (closed two-member body); `/display-name` handler deleted (C21)
├── routes/index.ts        # CHANGED: route registration — the profile PUT replaces the display-name route (C21)
├── poll/claim-project.ts      # CHANGED: promptSources on claim entries (C23)
├── poll/run-history-project.ts # CHANGED: promptSources on rows (C23)
├── poll/dispatch-audit.ts     # CHANGED: promptSources on both dispatch rows (C22)
├── poll/runs-parse.ts     # CHANGED: nothing in code — its reader moved into C13; refusal tests land here
└── main.js                # REBUILT + committed (invariant 1)

tests/                     # offline: fake host, loopback service on temp dirs, fixture GitHub
├── (extended) prompt-validation, prompt-snapshot, prompt-composition, prompt-claim, prompt-audit,
│              prompt-upgrade, service-config, service-config-audit, config-authority, take-effect,
│              service-accounts, service-claim, service-run-history, service-run-wire,
│              service-runs-parse, audit-vocabulary, service-audit-read, accounts-ui,
│              settings-rows, settings-tab, settings-edit, relay-integrity, containment-proof,
│              bundle (PROMPT_MODULES + scans), docs-sync, manifest, service-server
└── (no new test file — N9; the v1.2.0 change-efficiency posture keeps proofs consolidated)

README.md · specs/002-agent-event-extension/quickstart.md · AGENTS.md ·
specs/003-dispatch-integrity/contracts/{claim-lease,run-history-audit,dispatch-authorization}.md
                                      # C31: three-tier docs + module map + pointer notes
```

**Structure decision**: no new directories, dependencies, store files, `host.storage` keys, or test files. The prompt domain stays one module beside the store it serves; the two *new* observation lanes get their own modules because each owns a chain, a baseline, and a vocabulary (one responsibility per module, and the file-length gate); panel-side work is narrow edits to the modules that already own composition, claim parsing, row rendering, the accounts tab, and the settings rows.

## Complexity tracking

**None.** The constitution check passed without violations, so there are no violations to justify. The one document-vs-document disagreement found (NFR-129 vs FR-082) **was** a wording defect in an NFR — the gate ruling narrowed it to a method/path swap the old clause did not quite describe (one route in, one route out), and **004 v1.4.1 then reworded NFR-129** so it names the existing bindings, account, and configuration surfaces and states the accounts surface's net-zero route count (§Cross-feature coordination item 1, **closed**). It was never a constitutional exception, this plan recorded no workaround for it, and after the reword no document disagrees for it to arbitrate.
