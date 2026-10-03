# Tasks: The Layered Starting Prompt (004 v1.4.0)

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md),
[contracts/](./contracts/) — all Phase-4 outputs; [spec.md](./spec.md) **v1.4.0** is the source of
truth (FR/AC numbers below are quoted as written; FR-082's write path was re-cut at the gate).

**Numbering**: the pre-amendment task set (`T-001`–`T-016`, the binding tier) is **complete** and
its text is preserved in git history. **This set starts at `T-017`** so the two can never collide;
`[x]` boxes below belong to no task until Phase 6 checks them. **Gate re-cut (2026-10-02)**:
**`T-022` is withdrawn and merged into `T-023`** — the account track collapses to **one
profile-write handler task**, per the product owner's ruling (plan D26: one handler, one contract,
instead of a dedicated endpoint plus the `/display-name` work that would have trailed it). The ID
is retired, never reused. **Active task count: 21** (`T-017`–`T-038` minus `T-022`).

**Bar**: three tiers stack into one fenced block, resolved once at detection; every refusal fails
closed without echoing a value; `promptSources` is answerable from any run surface; the global and
account tiers render one field each and **each value renders exactly once panel-wide**; and with no
tier set **not one byte of the message changes**. Tests are offline and deterministic per
`AGENTS.md`: fake host (`tests/support/panel.ts`), loopback service on temp dirs
(`tests/support/service.ts`), fixture GitHub — **no live OpenChamber, no PAT, no network**.
`[P]` = parallel-safe with its wave-mates (disjoint files, no dependency edge between them).
**`npm run verify` runs at every wave boundary, and any wave that touches `src/`, `panel/*.ts`, or
`service/*.ts` ends with `npm run build` and the rebuilt bundles committed in the same commit
(invariant 1).**

**Co-ship rule for this feature (contracts README §7)**: the widened service writers and the widened
panel reader must land in the **same build**. The dependency `T-024/T-025/T-026 → T-027` below is
that rule — the closed reader refuses a present reference without `promptSources`, so the writers go
first.

## What's already built — do NOT re-touch

- **002/003 shipped**: transport, auth, custody, polling, stores, quarantine funnel, audit writer,
  config surface, the whole run layer (model, claim/lease, authorization family, vocabulary,
  projection, `GET /v1/audit`), the relay sequence, and the multi-reference `buildBoundedContext`.
- **004 v1.1.0 shipped (binding tier)**: `validateStartingPrompt` + `promptFingerprint` +
  `promptSnapshotOf` (`service/prompt.ts`), `src/prompt.ts`'s fence/rules, the prompt-change
  observer (`service/prompt-audit.ts`), omission-preserves (`service/routes/bindings.ts`), the
  enqueue snapshot (`service/poll/loop.ts` L422), claim trio + `promptText`
  (`service/poll/claim-project.ts` `promptViewOf`), the projection trio, the four audit detail
  scalars, `composeFirstMessage`, the budget reservation, the dispatch-row prompt line, and the six
  `prompt-*` test files.
- **005/006 shipped (amended surfaces)**: the six-tab shell, the Bindings editor's field, the
  Settings descriptor loop (`settingsRows()` maps `envelope.fields` — **a new descriptor becomes a
  new row with no row-list edit**), the account display-name **field and its draft/save flow** (the
  pattern the new prompt field copies) — its dedicated `…/display-name` **route is retired by this
  plan** (deleted, not aliased — plan D26, 005 v1.10.0), `GET/PUT /v1/config`, `config.changed`,
  the fail-closed panel config parser (`StringDescriptor.name` is already `string`).
- **Invariants**: delivery id format, evidence schema `extension-spike-1` (**version unchanged**),
  manifest ids/capabilities (`["sessions","prompt"]`), SDK pin `1.24.2`, `SERVICE_VERSION` ↔
  `package.json` (`0.0.1` — **no bump**), no new `host.storage` key, existing suite green throughout.

## Out-of-scope guard (check before any task feels like "just one more")

**No fourth tier, no fallback chain** (FR-070/FR-072). **No content policy beyond the four
refusals** (FR-029) — prompts that name an agent are delivered verbatim under the pinned Default
Agent (FR-040, AC-135). **No templating** (FR-039). **No GitHub write** (FR-002). **No change to
the dispatch state machine, leases, tokens, requeue budgets, correlation ids, or the `blocked:`
reason set** (003 owns them — plan D22 reports the budget floor as a failed attempt, not a new
reason). **No preview or second rendering of any tier's value** (005 FR-051 as amended — one
rendering per value; the Dispatches line shows presence/fingerprint/length/sources, never text).
**No migration, backfill, or legacy-projection code** (row 32 — plan §Migration). **No new host
capability or permission** (FR-004). **No `version`, `SERVICE_VERSION`, evidence-schema, or SDK-pin
change.** **No new store file, no new test file** (plan N9), **no policy profiles, no retention
tuning, no bulk prompt operations.**

---

## Wave 1 — the composed snapshot (service core)

**Goal**: the service resolves three tiers into one body, one fingerprint, one source list, and
persists exactly that. Independent test (spec US6): seed a config, an account, and a binding tier,
run one detection, read the queued record.

- [x] **T-017** [US6] **Shared source vocabulary** — `src/prompt.ts` (FR-072, FR-087): add
  `type PromptSource = 'global' | 'account' | 'binding'`, `PROMPT_SOURCE_ORDER` as a
  `readonly ['global','account','binding']` tuple, and the two predicates every reader will share
  (`isPromptSource`, and "is this list a duplicate-free subsequence of the order"). **Do not touch
  `PromptReference` yet** — this task must leave `tsc --noEmit` green on its own (the type change
  lands in T-027 with its readers). *Tests* (`tests/prompt-validation.test.ts`): every element of
  the order is a source; `['binding','global']`, `['repo']`, `['global','global']`, `['global',
  'account','binding']` classified correctly; no `any`, no suppression.
- [x] **T-018** [US1/US6] **The resolver and the stacked snapshot** — `service/prompt.ts`,
  `service/poll/loop.ts`, `service/prompt-audit.ts` (FR-080, FR-015, FR-083, FR-085, FR-086,
  FR-087): add `composePromptBody(tiers)` (set tiers joined by exactly one `\n\n` in
  global→account→binding order; **never** split afterwards), `resolvePromptSnapshot({ global,
  account, binding })` returning `{ text, fingerprint, length, sources } | null`, widen
  `PromptSnapshot` with `sources`, add the stack bound `n × STARTING_PROMPT_MAX_CODE_POINTS + 2 ×
  (n − 1)` (research R-1), rename `promptSnapshotOf` → **`promptTierOf`** (the rename is the compile
  error that forces this call-site review), and extend `parseStoredPromptSnapshot` to refuse a
  `prompt` whose `sources` is absent, non-empty-when-unset, unknown-ordered, duplicated, or
  inconsistent with `length`. Rewire `service/poll/loop.ts` L420–422 to resolve from
  `deps.config.startingPrompt` + the `account` already read in `scanBinding` + `binding` (the same
  objects that produced `projectId`/`worktreeOption`), and switch `service/prompt-audit.ts` to
  `promptTierOf` (binding rows keep the **tier's** fingerprint). *Tests*
  (`tests/prompt-snapshot.test.ts`, `tests/service-runs-parse.test.ts`): resolution matrix (all
  three / global-only / account+binding / binding-only / none ⇒ `null`); body bytes equal
  `global + "\n\n" + account + "\n\n" + binding`; fingerprint = `promptFingerprint(body)` and a
  binding-only value equals the shipped single-tier golden fingerprint; `sources` order and
  dup-free by construction; a stored `prompt` without `sources` or with an over-ceiling `length`
  **refuses the document** (never defaults — FR-087, invariant 8); unset tiers contribute nothing
  (FR-071).

**Wave 1 boundary**: `npm run verify` green; rebuilt `service/main.js` committed with the wave.

---

## Wave 2 — the two new tiers and the wire (three tracks, parallel)

**Goal**: the global tier is a configuration field, the account tier a record member carried by
**one account profile write** (closed two-member body), and every run surface names its sources.
Independent tests: a `PUT /v1/config` round trip, a `PUT /v1/accounts/:numericUserId` round trip
carrying either or both members, and a claim/row/audit read carrying `promptSources`.

### Track G — the global tier (config) — T-019 → T-020 → T-021, sequential inside the track

- [x] **T-019** [P] [US6] **The twelfth field** — `service/config.ts` (FR-081; 006 FR-010, FR-014,
  FR-040, FR-041): `ServiceConfig.startingPrompt: string` with `DEFAULT_CONFIG.startingPrompt = ''`
  (empty = unset), routed through `validateStartingPrompt` inside `collectIssues` so the whole-
  document `PUT` answers the same additive `422` for it as for any field, and read back by
  `buildConfig`. The `knownKey` gate (`Object.hasOwn(DEFAULT_CONFIG, key)`) and `parseStoredConfig`'s
  documented-key fill pick the member up with **no code beyond the declaration** — a file predating
  it fills from `""` and reports `startingPrompt` in `defaultsApplied`. *Tests*
  (`tests/service-config.test.ts`, `tests/config-authority.test.ts`): default `""` accepted; 2,000
  code points accepted, 2,001 refused with `field: 'startingPrompt'` and **no echo**; a
  credential-shaped value refused with the shipped shape label; a `PUT` omitting the member is a
  `422` (006 FR-041); an old-shape stored file fills + reports and writes **no** audit row; the
  bootstrap-env authority suite stays green (006 AC-152 unchanged).
- [x] **T-020** [US6] **The descriptor** — `service/config-schema.ts` (FR-081; 006 FR-020–FR-022,
  SC-101, SC-106, AC-101, AC-104): `TAKE_EFFECT.startingPrompt = 'next-cycle'` (the exhaustive table
  keeps failing `tsc` for any undeclared member), `StringFieldDescriptor.name` widens to
  `'expectedAgent' | 'startingPrompt'`, and `configSchema()` pushes the twelfth descriptor **after**
  `expectedAgent` so descriptor order still equals `collectIssues` order (006 AC-107). Descriptor:
  `kind: 'string'`, `unit: null`, `format` = the validator's own rule prose **carrying FR-063's
  guidance** (verbatim, no placeholders, cap, refusal shapes — research R-4), `maxLength: 2000`,
  `default: ''`, `takesEffect: 'next-cycle'`. *Tests* (`tests/take-effect.test.ts`,
  `tests/service-config.test.ts`): the class table is exhaustive and `startingPrompt` reads
  `next-cycle`; the projection has twelve descriptors in validator order; the descriptor round-trips
  through the panel's closed parser fixture (006 SC-106 counting against the projection).
- [x] **T-021** [US4/US6] **The global tier's audit row** — `service/config-audit.ts`, **new
  `service/config-prompt-observe.ts`**, hook in `service/poll/loop.ts` (FR-088; 006 FR-070, FR-071):
  `configChanges()` keeps raw-string equality (the no-op detector, 006 FR-048) but records this
  field's `from`/`to` as `mtp-` fingerprints or `null` (widening `ConfigChange`'s value type to
  `number | string | null`); the new observation lane holds a per-store chain plus a baseline seeded
  from the highest-seq `config.changed` `changes[].to` for `startingPrompt` (`null` when the trail
  has none) and appends one row with `actorSource: 'service'` when a cycle read differs from the
  baseline — hooked at `readCycleConfig`, the same cadence the bindings observer gets (research R-3).
  *Tests* (`tests/service-config-audit.test.ts`, `tests/service-cycle-config.test.ts`): a `PUT`
  changing the global tier writes one row whose pair matches `/^(mtp-[0-9a-f]{32}|null)$/` and
  carries `takesEffect: 'next-cycle'`; a hand edit observed at the next cycle writes exactly one
  `service` row; the **arrival fill writes none** (`""` ≡ `null` ≡ fresh baseline); restart with the
  file unchanged writes none; a refused write stays value-free (006 FR-072); an append failure warns
  and the baseline still advances.

### Track A — the account tier — **one task: T-023** (former T-022 merged in at the gate ruling), [P]

- [ ] ~~**T-022**~~ **WITHDRAWN (2026-10-02)** — merged into **T-023** by the product owner's gate
  ruling (plan D26): one profile-write handler task instead of a dedicated endpoint plus whatever
  `/display-name` work would have trailed it. Its record-member work is now T-023 part (a); the ID
  stays retired, never reused.
- [x] **T-023** [P] [US6] **The account tier and its one profile write** —
  `service/accounts/model.ts`, `service/routes/verify.ts`, `service/accounts/store.ts`,
  `service/routes/accounts.ts`, `service/routes/index.ts`, **new `service/account-prompt-audit.ts`**
  (FR-082, FR-083, FR-071, FR-017, FR-088, AC-149; 005 FR-066; contracts `layered-prompt.md` §2 and
  [`account-display-name.md`](../005-panel-ia/contracts/account-display-name.md) §2/§4):
  **(a) the record member** (former T-022): `Account.startingPrompt: string | null` (absent reads
  `null`), `AccountDto.startingPrompt` added **by name** (the credential-free projection stays
  exhaustive), `parseStoredAccount` validating the member through `validateStartingPrompt` so a
  violating document **refuses the record** — the store quarantines it with the reason captured as
  `field: remediation`, never the value (the bindings read's `RefusalNote` pattern); the **one
  full-literal construction** of an `Account` (a freshly verified account in
  `service/routes/verify.ts`) gains `startingPrompt: null` — a new account starts **unset**
  (FR-071's no-seeding), while the spread constructions (`rotatedAccount`, reconcile's
  mark/restore) preserve the member by construction and are asserted, not rebuilt; and the
  observed/unobserved read funnels (`readAccount`, `listAccounts`) in the `readBindings` shape. The
  type error from the new member is the sweep: it names every literal that must be touched.
  **(b) the profile write**: register `PUT /v1/accounts/:numericUserId` on the existing
  `ACCOUNT_PATH` — body read as a **closed set** `{ displayName?, startingPrompt? }`: an **absent
  member means unchanged** (FR-014's posture applied to this record); a body carrying **neither**
  member is refused `422 validation` (`field: "body"`, remediation naming both members — never a
  silent `200`); any other key — `credential`, `scopeCheck`, `state`, `connectionState`,
  `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt`
  — is refused `422` **naming that key, with zero characters of its value echoed**; issues are
  collected **additively in one pass** and **any issue refuses the whole write** (neither member,
  no `updatedAt`, no audit row); `startingPrompt` validates through `validateStartingPrompt`
  (identical shape labels to the other two paths — AC-150), clearing on `null`/`""`/
  whitespace-only; `displayName` through the shipped `validateDisplayName` (its six steps
  unchanged); the write is **whitelist-by-construction** — the record the *service* read, spread
  with the validated operator keys present in the body, plus a fresh `updatedAt`; `200 { account }`,
  `404 unknown-account`, `401`/`503` unchanged; the handler reads the account **unobserved** inside
  the chain.
  **(c) the retirement**: delete `ACCOUNT_DISPLAY_NAME_PATH`, `displayNameBodyRefusal`,
  `handleSetDisplayName`, and `setDisplayNameRoute`, registering the profile `PUT` in their place
  in `service/routes/index.ts`; re-cut `tests/service-accounts.test.ts`'s existing
  `describe('PUT /v1/accounts/:id/display-name …')` block onto the profile route. **No alias, no
  redirect, no legacy handler** (005 v1.10.0) — and the never-built `…/starting-prompt` route must
  exist nowhere either.
  **(d) the observer lane**: new `service/account-prompt-audit.ts` (chain + trail-seeded baseline,
  plan N8); the write appends exactly one `account.prompt-updated` row when **`startingPrompt`
  changes** (actor `operator`, decision `set|changed|cleared`, details `{ promptPresent,
  promptFingerprint, promptLength, previousFingerprint }`, fresh non-run correlation id) — a
  `displayName`-only write appends **nothing** (a label is not a tier; 005 adds no event type); the
  read funnels observe with actor `service` through the new lane.
  *Tests* (`tests/service-accounts.test.ts`, `tests/prompt-audit.test.ts`):
  - *Member/read side*: absent/`null` ⇒ `null` (no quarantine, no rewrite); a number/`true`/
    object, a 2,001-code-point value, a credential shape, and a `--- BEGIN ` line each quarantine
    that file with the logged reason and yield no account (the account does not scan — the edge
    case FR-082 names); the DTO carries no credential member; the observed read appends nothing by
    itself.
  - *Contract invariant 5 (deep compare — named deliverable)*: a body carrying one member changes
    **exactly that member and `updatedAt`** — the other member and every other field
    byte-identical (and vice versa); a two-member body changes both; `null`/`""` clear only the
    member they name.
  - *Contract invariant 6 (custody keys refused — named deliverable)*: a body containing any of
    the eleven custody/identity keys answers `422 validation` naming that key, with **no
    characters of its submitted value** anywhere in the response, log, or store, and the stored
    record is byte-identical — **no `updatedAt` bump**; a body whose allowed member also fails
    validation plus a forbidden key answers **one complete list** of issues and writes **nothing**.
  - *Contract invariant 4 (no-op — named deliverable)*: a body with neither member ⇒ `422`
    `field: "body"`, nothing written, no row.
  - *Contract invariant 8 (retired route resolves nowhere — named deliverable)*: `PUT
    …/display-name` **and** the never-built `PUT …/starting-prompt` answer the service's
    unknown-route refusal — no alias, no redirect, no handler, and no remaining reference to
    either path in any route table, handler, or test of the shipped build.
  - *Audit + cascade*: set → change → clear ⇒ exactly three rows with chained previous
    fingerprints and **no text anywhere**; a `displayName`-only write ⇒ zero rows; a hand edit
    observed once with actor `service`; restart with unchanged files ⇒ zero rows; `DELETE
    ?force=1` removes record and tier together, disables referencing bindings as today, writes
    `account.deleted`, and a re-added account (same id) reads `null` (**AC-149**); rotation and
    rename leave **both** members byte-identical; a refused write leaves the stored values
    byte-identical and writes no row (AC-150; `layered-prompt.md` §5 invariant 3).

### Track W — the wire writers — T-024 ∥ T-025 ∥ T-026

- [x] **T-024** [P] [US4/US6] Claim answer — `service/poll/claim-project.ts` (FR-087): `promptViewOf`
  answers `promptSources` beside the existing five members — the snapshot's list when set, explicit
  `null` when unset. *Tests* (`tests/service-claim.test.ts`): unset runs answer
  `false, null, null, null, null`; a set run answers its ordered list; the maximal-batch bound test
  is **re-derived** for a ≤6,004-char `promptText` (pagination via `measureEvents`, never
  truncation — plan Risk register); claim eligibility, lease, and audit behaviour byte-unchanged
  (003's claim tests stay green).
- [x] **T-025** [P] [US4/US6] Run history — `service/poll/run-history-project.ts` (FR-052, FR-087):
  the row gains `promptSources` from the snapshot (`null` when unset), **no text, no field
  removed**. *Tests* (`tests/service-run-history.test.ts`): the member is present for post-amendment
  runs and `null` for a run with no tier; a row never carries `promptText`.
- [x] **T-026** [P] [US4/US6] Dispatch audit details — `service/poll/dispatch-audit.ts` (FR-050,
  FR-087): `promptDetails` writes `promptSources` on **both** `dispatch.reserved` and
  `dispatch.result`, from the run's snapshot, never from panel input. *Tests*
  (`tests/audit-vocabulary.test.ts`, `tests/service-audit-read.test.ts`): both rows carry
  `bindingId` + presence + fingerprint + length + sources; correlation stays the run's id; existing
  details untouched; a correlation-filtered `GET /v1/audit` surfaces them; **no row anywhere in
  `audit.ndjson` contains any tier's text**.

**Wave 2 boundary**: `npm run verify` green; rebuilt bundles committed with the wave.

---

## Wave 3 — the panel: read, compose, refuse, render

**Goal**: the panel reads the widened wire fail-closed, refuses an over-budget composition before
any host call, and renders each new tier exactly once. Independent test (US6): drive a claimed run
with three tiers through the fake host and byte-compare; render all six tabs and count sentinels.

- [x] **T-027** [US4/US6] **The closed reader** — `src/prompt.ts`, `src/prompt-wire.ts`,
  `src/claim-service.ts`, `src/session.ts` (FR-087, FR-037, AC-151): `PromptReference` gains
  `promptSources: readonly PromptSource[] | null`; `readPromptReference` refuses (returns `null`)
  when a present reference carries no list, an empty list, an unknown tier, an out-of-order or
  duplicated list, or a null list on a present reference — **and one refused entry refuses the
  whole answer**; `readClaimPrompt` keeps its `promptText` iff; `ClaimedRun` gains the member;
  `NO_PROMPT` and the attachment `data` carry `promptSources` (additive within
  `extension-spike-1` — plan D9). Every construction site of `PromptReference` is updated in this
  task (the type change is what finds them). *Tests* (`tests/prompt-claim.test.ts`,
  `tests/prompt-composition.test.ts`, `tests/relay-integrity.test.ts`): all four hostile source
  lists refuse the entry and the answer; unset answers `false + null`; the serialized
  `startSession` request carries `data.promptSources` and still **one** occurrence of the block text
  (inside `text`); no `promptText` is written to `host.storage`, the ledger, or any copy.
- [x] **T-028** [US4/US6] The dispatch row's line — `src/dispatches-service.ts`,
  `src/dispatches-rows.ts` (FR-052, FR-087): `RunRow` inherits `promptSources`; the prompt phrase
  becomes `prompt set · global+account+binding · mtp-… · N chars` (sources joined in order) / `prompt
  not set`, through the existing non-HTML path — **never the text**. *Tests*
  (`tests/dispatches.test.ts`): both states render; an unknown source string renders as inert text;
  a run with no tier renders `prompt not set`.
- [x] **T-029** [P] [US6] The **budget floor** — `src/relay-attempt.ts` (FR-085, AC-147, SC-132):
  after composing, refuse when `composed.length > CONTEXT_MAX_CHARS` **before**
  `host.startSession()` — no session started, nothing truncated — with a remediation naming the
  contributing tiers from `promptSources`, reported through the existing failed-attempt `problem`
  path (research R-2; no new `blocked:` reason). *Tests* (`tests/prompt-composition.test.ts`,
  `tests/relay-integrity.test.ts`): a seeded over-budget claim fixture (hand-edited store, past
  validation) composes, refuses, and issues **zero** host calls; the remediation names
  `global`/`account`/`binding` as applicable; a maximal legal three-tier composition passes the
  floor untouched.
- [x] **T-030** [P] [US6] The **Settings row** — `src/settings-rows.ts` (+ `tests/settings-rows.*`,
  `tests/settings-tab.test.ts`) (FR-064, FR-081, FR-089; 006 FR-010, FR-014, FR-081): the twelfth
  row appears from the descriptor with **no row-list edit**; an empty string field shows the
  **not-set word** in its value slot (FR-064 — never an empty box that reads as an instruction) and
  renders the service-declared `format` guidance as text (research R-4); the control stays keyboard-
  operable with the accessible name 006 FR-018 requires; no other row moves. *Tests*: twelve rows in
  descriptor order; the not-set word appears for `''` and the value for a set tier; the row's
  helper/label come from the descriptor, never from a panel literal; the cross-check against the
  service's declaration still holds.
- [x] **T-031** [P] [US6] The **Accounts field** — `src/bindings-service.ts`, `src/service-calls.ts`,
  `src/accounts-state.ts`, `src/accounts-tab.ts`, `src/accounts-actions.ts`, `src/accounts-rows.ts`
  (FR-063, FR-064, FR-082, FR-089; 005 FR-051, FR-066): `PanelAccount` gains `startingPrompt`
  (fail-closed parse — a non-string refuses the entry); `service-calls.ts` swaps the
  `ACCOUNT_DISPLAY_NAME_PATTERN`/`accountDisplayNamePath` builder for the **account profile path**
  (same `:numericUserId` segment, no `/display-name` suffix — plan C28); `accounts-actions.ts`
  collapses both saves onto **one write helper** that PUTs the profile path with **only the member
  being edited** (`{ startingPrompt }` for the prompt field, `{ displayName }` for the label —
  absent = unchanged, so neither field can clobber the other), which re-points the existing label
  save off the retired route; the per-row draft + save control keep mirroring the label flow
  (service is the only validator — plan D24), the field shows **not set** when unset and carries
  FR-063's guidance (verbatim, no placeholders, pinned Default Agent, refusals, cap), the service's
  refusal renders in the existing refusal slot without echoing the value, and the **row summary
  keeps presence/length only** — never text, never a fingerprint. *Tests* (`tests/accounts-ui.test.ts`,
  `tests/accounts-rows.test.ts` if touched): unset shows the not-set state rather than an empty
  instruction box; a set value round-trips through the profile PUT and reappears after a reload;
  the save issues `PUT /v1/accounts/:numericUserId` with a **single-member body** (assert the path
  and body — the old `…/display-name` assertion is re-cut here); a refused save renders the
  remediation, changes nothing, and leaves the stored value intact; the summary never carries the
  value; `host.storage` receives no copy.
- [x] **T-039** [US6] *(added at the Wave-3 checkpoint, 2026-10-02)* **The binding tier's
  guidance and not-set state** — `src/bindings-prompt.ts` (+ `tests/bindings-prompt.test.ts`)
  (FR-063, FR-064, FR-089; AC-144): the Bindings editor's field still carries only
  `PROMPT_HELPER` = *"Sent first in every dispatch from this binding."* — one sentence, none of
  FR-063's five facts. FR-089 makes FR-063 and FR-064 apply to **every** surface that renders a
  tier, and AC-144 names this field: the guidance must convey that the text is sent verbatim,
  that there are no placeholders, that the session's agent is the operator's pinned Default Agent
  and the text cannot change it, that a credential-shaped value is refused rather than stored,
  and that there is a length cap; the empty field must show the honest **not set** word rather
  than an empty box (FR-064), matching what T-030 did for Settings and T-031 for Accounts.
  Service stays the only validator (plan D24); a service refusal keeps rendering in the existing
  slot without echoing the value; the row summary keeps presence/length only. *Tests*
  (`tests/bindings-prompt.test.ts`): the five facts are conveyed; `not set` shows when unset and
  the value when set; no panel-side validation introduced; the refusal slot unchanged; the row
  summary never carries the value.
- [x] **T-032** [US6] **One rendering per tier value** — `tests/bundle.test.ts` +
  `tests/bindings-prompt.test.ts`/`tests/accounts-ui.test.ts`/`tests/settings-rows.test.ts`
  (FR-089; 005 FR-051, SC-105, AC-123): seed a global, an account, and a binding prompt with three
  distinct sentinels, render all six tabs, count rendered elements carrying each sentinel —
  **every count exactly 1** (fail at 0 and at 2 alike), with row summaries at presence/length only.

**Wave 3 boundary**: `npm run verify` green; rebuilt `panel/main.js` committed with the wave
(`panel/main.js` changes here).

---

## Wave 4 — proof, documentation, gate

**Goal**: the specification's measurable outcomes as automated offline proofs, the operator's page,
and the release-candidate gate. Nothing here adds behaviour.

- [x] **T-033** [P] [US1/US6] **Golden-string composition suite** — `tests/prompt-composition.test.ts`
  (FR-084, FR-086, AC-146, SC-121, SC-130): four oracles as golden literals — **no tier** ⇒ the
  pre-004 message byte-for-byte (no fence, no blank line, no placeholder); **binding-only** ⇒ the
  single-tier golden message **and** its golden fingerprint; **global-only** ⇒ a fully determined
  string; **three tiers** ⇒ one fence, order global→account→binding, exactly one blank line between
  tiers, frame unchanged beneath; `promptSources` lists exactly the set tiers in generality order in
  every case; operator text with `{number}`, `Correlation:`, or blank lines inside a tier arrives
  verbatim and changes no frame line (AC-134).
- [x] **T-034** [US1] **Budget suite** — `tests/prompt-composition.test.ts`,
  `tests/relay-integrity.test.ts` (FR-085, AC-147, AC-145, SC-132): three maximal (2,000-code-point)
  tiers + maximal excerpt + full frame compose **≤ `CONTEXT_MAX_CHARS`** and **< `GUEST_ATTACH_TEXT_MAX`**
  with the excerpt at its full allowance and its truncation markers intact and **no tier shortened**;
  the block is reserved before the excerpt budget (excerpt shortens first, visibly); the seeded
  over-budget attempt refuses before `host.startSession()` starting no session (asserts T-029); no
  round trip added (NFR-120).
- [x] **T-035** [P] [US3/US5] **Containment, secret, and audit scans** — `tests/bundle.test.ts`,
  `tests/containment-proof.test.ts`, `tests/prompt-audit.test.ts`, `tests/prompt-validation.test.ts`
  (FR-005, FR-053, FR-088, NFR-121, AC-133, AC-143, AC-148, AC-151, SC-123, SC-131): full-cycle
  containment with **three tiers populated** — each accepted value in exactly two persisted places
  (its store record + the run snapshot) and a refused sentinel in **none** (config, accounts,
  bindings, runs, events, audit, ledger, `host.storage`, captured logs, toasts/status copy, both
  committed bundles); `audit.ndjson` scanned for seeded tier text ⇒ 0 occurrences;
  `config.changed`'s `startingPrompt` pairs all match `/^(mtp-[0-9a-f]{32}|null)$/` by sentinel
  scan; the same credential sentinel refused at **all three** save paths with identical shape labels
  and zero characters of the value anywhere, a refusal at one tier leaving the other two
  byte-identical (AC-150); `PROMPT_MODULES` gains `service/config-prompt-observe.ts`,
  `service/account-prompt-audit.ts`, `service/config-schema.ts`, `service/accounts/model.ts`,
  `service/accounts/store.ts`, `service/routes/accounts.ts`; static scans still show no GitHub
  write, no suppression, no `any` in the touched modules.
- [x] **T-036** [P] [US2] **Arrival writes nothing** — `tests/prompt-upgrade.test.ts`,
  `tests/service-migration.test.ts` (FR-018, FR-089, SC-128, AC-131, AC-142): seed documents
  predating every member (`config.json` without `startingPrompt`, account files without it,
  bindings, deliveries, runs, audit) → boot the service → assert **zero** quarantines by arrival,
  **zero** scan-window resets, byte-identical files, `defaultsApplied: ['startingPrompt']` for the
  config, delivery ids / run keys / correlation ids unchanged, `SERVICE_SCHEMA_VERSION` still `1`,
  and the composed message for a seeded no-tier event equal to the pre-004 golden literal; a stored
  `null` behaves identically to absence; a stored number/boolean/object/array is refused with a
  field-level remediation and never coerced (AC-131).
- [x] **T-037** [P] [US6] **Documentation and cross-contract pointers** — `README.md`,
  `specs/002-agent-event-extension/quickstart.md`, `AGENTS.md`,
  `specs/003-dispatch-integrity/contracts/{claim-lease,run-history-audit,dispatch-authorization}.md`
  (FR-074, FR-089): the operator's page now states **the three tiers, their stacking order
  (global → account → binding), and that an unset tier contributes nothing**, plus the per-tier
  2,000-code-point cap, "the text is literal — no placeholders", "a credential-shaped value is
  refused, not stored", "the session's agent is your pinned Default Agent", and the three set paths
  (Bindings editor, Accounts field, Settings row) — replacing the "store file is the set path" era
  (plan §Cross-feature coordination item 5); add `service/config-prompt-observe.ts`,
  `service/account-prompt-audit.ts` and the changed modules to the `AGENTS.md` module maps; add one
  additive `promptSources` pointer note to each of 003's three contract files (docs only, no 003
  field reworded). *Check*: no document contradicts the refusal set, no dead instruction, **neither
  retired route (`…/display-name`, `…/starting-prompt`) presented as a live path** (contract
  invariant 8's document half), no `specs/001-…` path presented as live
  (`tests/docs-sync.test.ts` stays green).
- [x] **T-038** **Final gate** — `npm run verify` green (build → lint → typecheck → test);
  `panel/main.js` + `service/main.js` rebuilt and committed **with the wave** (invariant 1);
  `SERVICE_VERSION` still mirroring `package.json` `0.0.1` (`tests/service-server.test.ts` pinned
  pair); manifest still `capabilities: ["sessions","prompt"]` with no `permissions` key and kebab-
  case ids (`tests/manifest.test.ts`); SDK pin still `1.24.2` exact; zero suppressions, zero `any`
  introduced; `git status` shows only intentional files. Record per-AC status for **AC-131, AC-142,
  AC-146 – AC-151** (004), **AC-123** (005), **AC-101/AC-104** (006) in the commit/PR body, and
  author every Phase-6 commit through `git-agent-commit` (or `AI_AGENT=opencode …`) so each carries
  `Generated-By: opencode (model: …)` per the `git-safety`/`ai-attribution` skills — after the
  preflight checks and never with `--no-verify`.

**Wave 4 boundary**: `npm run verify` — this is the release-candidate gate for 004 v1.4.0's Phase 6.

---

## Dependencies & execution order

```
Wave 1  T-017 → T-018
          │
          ├─ Track G: T-019 → T-020 → T-021          ┐
          ├─ Track A: T-023                          ├─ Wave 2: three tracks, file-disjoint ⇒ parallel
          └─ Track W: T-024 ∥ T-025 ∥ T-026          ┘
          │                         (co-ship: W must precede T-027)
Wave 3  T-027 → T-028
        T-029 ∥ T-030 ∥ T-031        ← need Tracks G/A (and T-027 only for T-029's floor)
        T-029 (floor) after T-027
        T-032 after T-030 + T-031
          │
Wave 4  T-033 → T-034   (both edit tests/prompt-composition.test.ts — sequential, not parallel)
        T-035 ∥ T-036 ∥ T-037                                    → T-038 final verify
```

- **Hard dependencies**: T-018 needs T-017; T-020 needs T-019; T-021 needs T-020; T-023 stands
  alone in Track A (former T-022's member work merged in — no internal edge left);
  **T-027 needs T-024 + T-025 + T-026** (co-ship rule) and T-018; T-028/T-029 need T-027;
  T-030 needs T-020; T-031 needs T-023; T-032 needs T-030 + T-031; T-034 needs T-029 **and
  T-033** (same test file); T-035 and T-036 need every behaviour task; T-038 needs all.
- **Parallel-safe**: in Wave 2, **T-019 ∥ T-023 ∥ T-024 ∥ T-025 ∥ T-026** (each track then runs
  its own sequence — Track A now has none); in Wave 3, **T-028 ∥ T-029 ∥ T-030 ∥ T-031** are
  file-disjoint once T-027 has landed (and T-030/T-031 additionally need their service tracks); in
  Wave 4, **T-033 ∥ T-035 ∥ T-036 ∥ T-037** — **T-034 is sequential after T-033** (same test file).
  T-017 and T-018 are Wave 1's own sequence: nothing runs beside them.
- **Critical path** (9 tasks): `T-017 → T-018 → T-019 → T-020 → T-021 → T-030 → T-032 → T-035 →
  T-038` — the config track is longest, so start Track G first inside Wave 2; Track A is now a
  single task (`T-023 → T-031`, shortest of the three) and Track W (`T-024… → T-027 → T-029 →
  T-034`, 7) runs beside it; both merge at T-032/T-035. The gate re-cut did not move the critical
  path — it shortened Track A, which was never the long pole.
- **Cut line (MVP slice if delivery is cut)**: Wave 1 + Track W + T-027 + T-033 — resolution,
  sources, and byte-identity proven; **but no wave boundary ships without `npm run verify` green and
  bundles rebuilt.**

## Requirement → task coverage (traceability)

| 004 requirement | Tasks |
| --- | --- |
| FR-070, FR-071, FR-072 (three tiers; unset contributes nothing; layered, sources are a set) | T-017, T-018, T-033, T-036 |
| FR-080 (resolve once at detection) | T-018 |
| FR-081 (global tier is configuration) | T-019, T-020, T-030 |
| FR-082 (account tier on the record; profile write, closed body, cascade) | T-023, T-031 |
| FR-083 (one validator, three call sites) | T-019, T-023 (each routes through it) + T-035's cross-path proof |
| FR-084 (one fence, stacked body, byte identity) | T-018, T-033 |
| FR-085 (per-tier cap, summed bound, fail-closed floor) | T-018 (stack bound), T-029, T-034 |
| FR-086 (one fingerprint over the body) | T-018, T-033 |
| FR-087 (`promptSources` everywhere the fingerprint is) | T-017, T-018, T-024, T-025, T-026, T-027, T-028 |
| FR-088 (one row per tier change, never text) | T-021, T-023, T-035 |
| FR-089 (placement; arrival writes nothing) | T-030, T-031, T-032, T-036, T-037 |
| FR-074 (documentation states the three tiers) | T-037 |
| FR-005 / NFR-121 (secret containment, suites gain cases) | T-035, T-038 |

| Acceptance criterion | Tasks |
| --- | --- |
| AC-131 (no tier ⇒ byte-identical; `null` ≡ absence; non-text refused) | T-033, T-036, T-019, T-023 |
| AC-142 (no migration, no rewrite, identifiers unchanged) | T-036 |
| AC-146 (four golden oracles + `promptSources` per case) | T-033 |
| AC-147 (maximal tiers fit; over-budget refused before `startSession`) | T-034, T-029 |
| AC-148 (pure-function fingerprint; per-tier rows fingerprinted; 0 text in audit) | T-018, T-021, T-023, T-035 |
| AC-149 (account cascade, re-add unset, rotation untouched) | T-023 |
| AC-150 (same refusal at three paths; refusal isolation) | T-035 (+ T-019/T-023's refusal tests) |
| AC-151 (closed reader refusals; fingerprint sentinel scan of `audit.ndjson`) | T-027, T-021, T-035 |
| 005 AC-123 / SC-105 (one rendering per tier value) | T-032 |
| 005 AC-130 / `account-display-name.md` §4 invariants 4, 5, 6, 8 (no-op refusal, deep-compare scope, custody-key refusal, retired route resolves nowhere) | T-023 (+ T-031's panel path re-point) |
| 005 AC-128 (rename/rotation leave both members byte-identical) | T-023 |
| 006 AC-101, AC-104 / SC-106 (twelve fields, class counts) | T-020, T-030 |

## Test expectations summary (each task's own gate)

Fail-first where behaviour changes (resolver, closed reader, refusal paths, the floor, **the profile
write's closed two-member body** — custody keys, no-op, all-or-nothing), golden
literals for anything byte-identical, offline only (fake host / loopback service + temp dirs), **no
`sleep`-based timing** (both observer chains are deterministic: schedule chain tasks instead of
waiting on a clock), seeded sentinel values scanned across every persisted and rendered surface,
consolidated table-driven proofs with `// case:` labels per the v1.2.0 change-efficiency posture
(the three security-floor files — `crash-permutations`, `dispatch-end-to-end`, `redaction` — stay
untouched), and **zero suppressions**: a red lint or a red test is fixed, never muted.
