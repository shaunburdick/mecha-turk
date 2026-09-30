# Tasks: Per-Binding Starting Prompt (004)

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md), [contracts/](./contracts/) — all Phase-4 outputs; [spec.md](./spec.md) v1.1.0 is the source of truth (FR/AC numbers below are quoted as written).

**Bar**: a binding can carry an operator's prompt, every refusal fails closed without echoing the value, the dispatch message opens with that prompt verbatim — and **with no prompt, not one byte of the message changes**. Tests are offline and deterministic per `AGENTS.md`: fake host (`tests/support/panel.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub — **no live OpenChamber, no PAT, no network**. `[P]` = parallel-safe (different files, no dependency). **`npm run verify` runs at every wave boundary, and any wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt bundles committed in the same commit (invariant 1).**

**Sequencing prerequisite**: Waves 2–4 build on 003's run layer (`service/poll/runs*.ts`, `service/routes/dispatch.ts`, 003's claim/projection in `service/routes/events.ts`, 003's `src/relay.ts` sequence and widened `buildBoundedContext`). **003's final gate must be green before Wave 2 starts.** Wave 1 (the field and its refusals) touches only 002-era modules and can run in parallel with 003's Phase 6 if the orchestrator wants the overlap — but the same branch, one wave at a time, never both in one file.

## What's already built — do NOT re-touch

- **Service (002 shipped)**: loopback server/auth/body-caps (`server.ts`, `http.ts`, `auth.ts`, `pipeline.ts`), consent, throttles, account custody + verify + rotate (`accounts/`, `routes/{accounts,verify,credential}.ts`), the bindings surface mechanics (`bindings.ts` store file handling, `routes/bindings.ts` whole-file grant — 004 *extends* these, never replaces them), polling/triggers/windows/rate budget (`poll/{poller-github,poller-entries,triggers,loop,timer,scan}.ts`), `buildEventId` (**byte format untouched**), store 0700/0600 + quarantine funnel (`store/*`), the audit writer's seq/redaction chain (`audit.ts` — 004 *appends through it*, never rewrites it), config/health (`routes/{config,health}.ts`), **`routes/status.ts` (005's)**, the account-delete guard's field-preserving binding write (`accounts/store.ts`).
- **Panel (002 shipped)**: token handoff + consent, accounts mirror, bindings/repos UI (`repos*.ts` — its `PanelBinding`/`PreparedBinding` deliberately never grow the field), evidence (`evidence.ts`), redaction guards (`redaction.ts` — **reused, not extended**: the four shipped secret labels are 004 FR-024's shape set), ledger write path (`ledger.ts`), project resolution (`session.ts` `resolveProject`), the verification *mechanism* (`agent-verify.ts`), lifecycle (`lifecycle.ts`), storage-write guard (`storage-write.ts`), the spike dispatch path (`panel-dispatch.ts` — composes with no prompt, its byte-identical default).
- **003's deliverables (prerequisite; read-only for 004)**: run model + parsers + adoption (`poll/runs*.ts`, `run-key.ts`, `sweep.ts`), claim/lease, the authorization family (`routes/dispatch.ts`, `routes/run-ops.ts`), the sixteen-row lifecycle vocabulary + `dispatch.refused` + correlation discipline, `GET /v1/audit` (`routes/audit.ts`), the run-history projection (`routes/events.ts`), the relay's reconcile→claim→guard→reserve→persist→report sequence (`src/relay.ts`, `reconcile.ts`, `dispatch-record.ts`), the widened multi-reference `buildBoundedContext`, `runs-service.ts`/`runs-rows.ts` DTOs, and 003's four contract files.
- **Invariants**: delivery id format (`buildEventId`), evidence schema `extension-spike-1` (**version unchanged** — plan D9), manifest ids/capabilities/zero-settings, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` (`0.0.1` — **no bump in 004**), `SERVICE_SCHEMA_VERSION = 1`, no new `host.storage` key, the existing test suite stays green throughout.

## Out-of-scope guard (check before any task feels like "just one more")

**No editor, preview, or display of prompt text** (004 FR-062, AC-144 — "just add a textarea" is 005 FR-051's field, and building it here violates an asserted AC). No template placeholders or substitution in the prompt (004 FR-039). **No content policy beyond the four refusals** (004 FR-029) — including *no* refusal of prompts that name an agent: they are delivered verbatim (004 FR-040, AC-135), whatever 003's amendment wording says (plan §Cross-feature coordination item 2). No GitHub write (002 FR-031, 003 FR-002, 004 FR-002). No change to the dispatch state machine, leases, tokens, requeue budget, correlation ids (003 owns them). No `service/routes/status.ts` change, no renames (005). **No `ServiceConfig` field** — the cap is a module constant (plan D6; 006 owns settings). No account-level/global prompt and no invented default text (004 FR-070/FR-071). No `version`, `SERVICE_VERSION`, evidence-schema, or SDK-pin change.

---

## Wave 1 — The field and its four refusals (service; independent of 003)

**Goal**: a binding can hold a validated prompt, and every invalid one is refused without echoing a byte. Independent test (spec US2/US5): write each invalid shape, observe the field-level refusal, confirm the previous prompt still dispatches and the submitted value appears nowhere.

- [x] **T-001** [P] [US1] Create `src/prompt.ts` — the browser-safe shared text rules: fence constants `OPERATOR_PROMPT_FENCE_BEGIN`/`_END` byte-equal to the spec's composition block, `RESERVED_MARKER_PREFIXES = ['--- BEGIN ', '--- END ']`, `trimPrompt` (outer only), `normaliseLineEndings` (`\r\n`|`\r` → `\n`), `countCodePoints` (`[...text].length`), `hasReservedMarkerLine`, `hasIllegalControlChar`. *Tests* (`tests/prompt-validation.test.ts`): CRLF and lone-CR normalise; internal newlines/tabs survive; `--- BEGINNING OF PLAN ---` is **not** reserved while `--- BEGIN ` at a line start is; surrogate pairs counted as code points; fence constants match the literal strings in spec `## Dispatch Message Composition`.
- [x] **T-002** [US1/US5] Create `service/prompt.ts` — `STARTING_PROMPT_MAX_CODE_POINTS = 2_000` (with the 500–3,000 tunable range documented in the doc comment, 004 FR-021), `validateStartingPrompt(raw)` implementing the §2.1 eight-step order (type → trim → empty=unset → normalise → cap → control chars → reserved markers → `findSecretLeak`), `promptFingerprint` = `mtp-` + sha256(utf8(text)).hex[0:32] via `node:crypto`, `promptSnapshotOf`, `PromptSnapshot`, and the five remediation strings. *Tests*: full refusal matrix (non-text ×4 kinds, 2,001 code points, `\u0000`, `/\t`-adjacent controls, each reserved prefix, each of the four secret labels) — every refusal carries `field: 'startingPrompt'` + remediation and **zero characters of the submitted value** (plant a sentinel, scan issue/message); 2,000 accepted, 2,001 refused; whitespace-only → unset not refusal; fingerprint deterministic across two module instances and two temp stores, matches `/^mtp-[0-9a-f]{32}$/`, differs for one-character edits; a refused credential never reaches `promptFingerprint`'s inputs (FR-016's closing clause).
- [x] **T-003** [US2/US5] `service/bindings.ts` (plan C1): `BindingRecord.startingPrompt?: string` (key absent when unset), the prompt step in `parseBinding` with **issue accumulation** (collect every problem per binding instead of returning the first), `parseBindingsFile` refusing a violating prompt (returns `null` → quarantine) while capturing `field: remediation` for the caller, and `readBindings` logging that reason beside `quarantinePath` — never the value. Preserve an unobserved reader for 003-consumers. *Tests* (extend `tests/service-bindings.test.ts`): a file without the field parses unchanged with **no** quarantine (AC-142); stored `null` reads as unset; stored `42`/`true`/`{}`/`[]` each quarantine with the logged reason and yield `[]` bindings (AC-141); a submission with a bad prompt *and* a bad repository answers one 422 listing both (FR-027); the shipped `toContain('triggers')` assertion stays green.
- [x] **T-004** [US4] Create `service/prompt-audit.ts` — per-store baseline seeded once from `audit.ndjson` (highest-`seq` `binding.prompt-updated` per binding), the per-store observation chain, and `appendPromptChange` building the row (decision `set|changed|cleared`, `previousFingerprint`, actors supplied by the caller). *Tests* (`tests/prompt-audit.test.ts`): seed → diff → exactly one row per difference with the required `details` keys and **no text**; second observation of the same file writes nothing; baseline survives a simulated restart (re-seed from the rows just written) so `previousFingerprint` chains; append failure logs `warn` (binding id + fingerprint only) and the baseline still advances (003 FR-063 posture).
- [x] **T-005** [US2/US4] Wire the two call sites: `service/routes/bindings.ts` (plan C2) — preservation merge for submitted bindings **without** the field, explicit value set/clear, write inside the chain, then one `binding.prompt-updated` row per differing binding with actor `operator`; and `readBindings` observation with actor `service` (plan C3). *Tests* (extend `tests/service-bindings.test.ts` + `tests/prompt-audit.test.ts`): panel-shaped PUT (no field anywhere) preserves every stored prompt byte-identically (AC-137); explicit empty clears exactly the named binding; invalid prompt ⇒ 422, file byte-identical, no audit row, previous prompt in force (AC-132/AC-133); set→change→clear ⇒ three rows, actors `operator`, chained previous fingerprints (SC-125); hand-edit observed once with actor `service`, restart with unchanged file ⇒ zero rows, PUT racing an observation ⇒ still exactly one row per change.

**Wave 1 boundary**: `npm run verify` green; rebuilt `service/main.js` committed with the wave.

---

## Wave 2 — Snapshot and reference scalars (service; requires 003)

**Goal**: the prompt reaches the run at enqueue and is referenced — never reproduced — on every surface that records what was sent. Independent test (spec US1/US4): seed a binding with a prompt, detect an event, inspect run, claim, projection, and audit.

- [x] **T-006** [US1] Snapshot at enqueue (plan C4): `service/poll/loop.ts` `scanBinding` resolves `promptSnapshotOf(binding)` from the binding already in hand and passes it into `enqueueEvents`; `service/poll/events.ts` forwards it into run creation; `service/poll/runs.ts` persists `prompt` beside `projectId`/`worktreeOption` (coalesced joins keep the run's original); **no field is added to delivery rows**; `service/poll/runs-parse.ts` validates the snapshot per data-model §3 (types, cap, `^mtp-…$` format, equal `length`, credential scan → refuse document, absent/`null` → unset). *Tests*: snapshot equals the detection-time binding's text (not a later edit); edit-then-dispatch uses the new text while the queued run keeps the old (AC-138); coalesce does not replace the snapshot; `events.json` bytes for the same detection are unchanged from the pre-004 format; a run row with `prompt: 42` or a malformed fingerprint refuses the document; a pre-004 run row parses (AC-142).
- [x] **T-007** [P] [US1/US4] Claim members (plan C5): `service/routes/events.ts` answer gains `promptPresent`, `promptFingerprint`, `promptLength`, `promptText` per [contracts/dispatch-prompt.md](./contracts/dispatch-prompt.md) §1 (explicit `false`/`null`/`null`/`null` when unset; `promptText` claim-transport only). *Tests*: unset runs answer the four nulls; a maximal claim batch stays under `GUEST_REQUEST_RESPONSE_MAX`; the answer scans credential-free; claim eligibility/lease/audit behaviour byte-unchanged (003's claim tests stay green).
- [x] **T-008** [P] [US4] Projection + audit scalars: `service/routes/events.ts` `RunHistoryRow` gains `promptPresent`/`promptFingerprint`/`promptLength` (plan C6; pre-004 runs ⇒ `false`/`null`/`null`), and `service/routes/dispatch.ts` writes the four `details` keys on `dispatch.reserved` and `dispatch.result` from the run's snapshot (plan C7). *Tests*: projection trio present, no text anywhere in a row (AC-139); vocabulary suite (`tests/audit-vocabulary.test.ts`) extended — both rows carry `bindingId` + fingerprint + presence + length, correlation still the run's id, existing details untouched; a correlation-filtered `GET /v1/audit` returns them (SC-124).

**Wave 2 boundary**: `npm run verify` + bundles.

---

## Wave 3 — Panel: compose, reference, render (requires Wave 2's wire)

**Goal**: the first message opens with the operator's words and nothing else changes. Independent test (spec US1/US3): drive a claimed run through the fake host and byte-compare the request.

- [ ] **T-009** [P] [US1] `src/repos-service.ts` (plan C9, first half): claim DTO gains the four prompt members (typed, fail-closed: `promptText` non-null iff `promptPresent`), parsed alongside the existing fields. *Tests*: fixture claim bodies with and without a prompt parse; a `promptText` without `promptPresent` refuses the entry (fail closed, list stays partial as today).
- [ ] **T-010** [P] [US1/US3] `src/session.ts` (plan C9): `composeFirstMessage({ prompt, frame })` (unset ⇒ returns `frame` unchanged), budget reservation in `buildBoundedContext` (`reservedChars` = prompt block + blank line, subtracted **before** the excerpt budget; prompt never passed through `fitExcerpt`), and `buildStartSessionRequest` `data` gains `promptPresent`/`promptFingerprint`/`promptLength` (no text). *Tests* (`tests/prompt-composition.test.ts`): golden byte-identity — a literal captured from today's `buildBoundedContext` equals the composed output for unset/`null` (SC-121, AC-131); fence + blank line + frame order; `{number}`, `Correlation:`, `Rule:` written by the operator appear verbatim inside the fence and change no frame line (AC-134); 2,000-code-point prompt + long body ⇒ prompt complete, excerpt shortened with marker, total < `GUEST_ATTACH_TEXT_MAX` (AC-145); `data` carries three scalars, never the text; hostile prompt text (`<img onerror>`, delimiter lookalikes) is carried literally and structurally inert (NFR-127).
- [ ] **T-011** [US1/US3] `src/relay.ts` (plan C10): pass the claimed run's snapshot into composition at the single call site; ledger entry detail for a dispatch gains **no** prompt member; the spike path keeps composing with unset. *Tests* (extend `tests/relay-integrity.test.ts`): one dispatch = the same round-trip count as 003's baseline (**+0**, NFR-120/AC-145); a seeded prompt appears exactly once in the serialized `startSession` request (inside `text`) and **zero times** in `host.storage`, the ledger JSON, and captured status copy; a prompt-less dispatch's request bytes equal the pre-004 fixture (SC-121).
- [ ] **T-012** [P] [US4] Dispatch-row projection (plan C11, 004 FR-052): `src/runs-service.ts` parses the trio; `src/runs-rows.ts` shows presence + fingerprint + length in the row's existing line (e.g. `prompt set · mtp-… · 340 chars` / `prompt not set`) through the existing non-HTML path — **never the text**. *Tests*: both states render with the exact strings; hostile fingerprint/length values render as text; a pre-004 run row renders `prompt not set`; `host.storage` never receives the fingerprint's text (AC-139, NFR-127).

**Wave 3 boundary**: `npm run verify` + bundles (`panel/main.js` changes here).

---

## Wave 4 — Proof, documentation, gate (cross-cutting)

**Goal**: the spec's measurable outcomes as automated offline tests, plus the operator's page. Nothing here adds behaviour.

- [ ] **T-013** [US2] Create `tests/prompt-upgrade.test.ts` — the migration script (004 FR-018, SC-128, AC-142): seed a pre-004 store (bindings without the field, deliveries, audit) → boot the service → assert **zero** quarantine files, **zero** scan-window resets, bindings byte-identical, delivery ids / run keys / correlation ids unchanged, `SERVICE_SCHEMA_VERSION` still `1`, and the composed message for a seeded prompt-less event equals a golden literal captured from the shipped `buildBoundedContext` (SC-121); a stored prompt edited mid-flight never changes a queued run's snapshot (AC-138, AC-142).
- [ ] **T-014** [P] [US3/US5] Extend the secret and sink scans (`tests/bundle.test.ts`, `tests/prompt-validation.test.ts`, `tests/prompt-audit.test.ts`): full-cycle containment (save → refuse → detect → claim → dispatch → retry → audit read) asserting the accepted prompt exists in **exactly two** persisted places (binding + run snapshot) and the refused value in **none** — bindings store, `runs.json`, `events.json`, `audit.ndjson`, panel ledger, `host.storage`, captured service logs, toasts/status copy, both committed bundles (AC-133, AC-143, NFR-121); static scan: no `startingPrompt` key anywhere in `panel/main.js` (the panel never touches the binding field — 004 FR-011/FR-062), no GitHub-write import in the new modules, no suppression/`any` introduced (004 FR-002/FR-005).
- [ ] **T-015** [P] [US5] Documentation and cross-contract pointers (plan C12/N6; 004 FR-062, FR-074): `README.md` + `specs/002-agent-event-extension/quickstart.md` gain the field's page — **set path until 005 = the `bindings.json` store file** (0700/0600, validated on read, quarantined with a logged reason if malformed), the 2,000-code-point cap, "the text is literal — no placeholders", "a credential-shaped value is refused, not stored", "the session's agent is your pinned Default Agent and the text cannot change it", omission-preserves on whole-file saves; add the three pointer notes into 003's `contracts/{claim-lease,run-history-audit,dispatch-authorization}.md` (docs only — additive, no 003 field reworded); add `src/prompt.ts`, `service/prompt.ts`, `service/prompt-audit.ts` to the `AGENTS.md` module maps. *Check*: no doc suggests a panel editor exists before 005, none contradicts 004's refusal set, no `specs/001-…` path presented as live.
- [ ] **T-016** Final gate: `npm run verify` green (build → lint → typecheck → test); `panel/main.js` + `service/main.js` rebuilt and committed with the wave; `SERVICE_VERSION` still mirroring `package.json` `0.0.1` (pinned test); `capabilities[]` still `["sessions","prompt"]`; zero suppressions/`any` introduced; `git status` shows no unintended files. Record per-AC status for **AC-130–AC-145** in the PR/commit body.

**Wave 4 boundary**: `npm run verify` — this is the release-candidate gate for 004's Phase 6.

---

## Dependencies & execution order

```
Wave 1 (T-001 → T-002 → T-003 → T-004 → T-005)          ← independent of 003; strictly ordered
        │                                                 (each file is a hard dependency of the next)
        ▼   [requires 003's Phase 6 merged and green]
Wave 2 (T-006 → { T-007 ∥ T-008 })
        │
        ▼
Wave 3 (T-009 ∥ T-010 ∥ T-012 → T-011)
        │
        ▼
Wave 4 (T-013 ∥ T-014 ∥ T-015 → T-016 final verify)
```

- **Hard dependencies**: T-002 needs T-001 (shared rules); T-003 needs T-002 (the validator); T-004 needs T-003 (the unobserved reader) and T-002 (fingerprints); T-005 needs T-003 + T-004; T-006 needs T-002 and 003's run creation; T-007/T-008 need T-006's field; T-011 needs T-009 + T-010; T-013/T-014 need every behaviour wave.
- **Parallel-safe**: T-007 ∥ T-008 (different route modules once T-006 lands); T-009 ∥ T-010 ∥ T-012 (different files, no import edge); T-013 ∥ T-014 ∥ T-015. T-001 is `[P]` in name only — it is Wave 1's first brick.
- **MVP slice if delivery is cut**: Wave 1 + T-006 + T-010 + T-011 — field, refusal, snapshot, composition; **but no wave boundary ships without `npm run verify` green and bundles rebuilt.**

## Requirement → task coverage (traceability)

| 004 requirements | Tasks |
| --- | --- |
| FR-001–FR-005 (authority, posture) | T-014 (scans), T-016 (gate), constraint tests throughout |
| FR-010–FR-019 (field, persistence, omission, snapshot, fingerprint, no migration) | T-002–T-007, T-013 |
| FR-020–FR-029 (validation, refusals, atomicity) | T-001–T-005, T-014 |
| FR-030–FR-039 (composition, envelope data) | T-010, T-011 (+ T-009 supplying the snapshot) |
| FR-040–FR-044 (pin, containment, not a trigger) | T-010/T-011 constraints + existing static/verification tests (unchanged) |
| FR-050–FR-054 (audit scalars, prompt-change row, projection, two places) | T-004, T-005, T-008, T-012, T-014 |
| FR-060–FR-064 (the field 005 renders; no editor; documented set path) | T-015 (docs), T-014 (panel bundle carries no field), out-of-scope guard |
| FR-070–FR-074 (per-binding, no default, docs) | T-013 (byte identity ⇒ no invented default), T-015 |

| Acceptance criterion | Tasks |
| --- | --- |
| AC-130, AC-134, AC-136 | T-010, T-011 |
| AC-131, AC-142 (byte identity, no migration) | T-010, T-013 |
| AC-132, AC-133 (cap edges, credential refusal, zero trace) | T-002, T-005, T-014 |
| AC-135 (prompt names an agent ⇒ verbatim + pinned) | T-011 (request carries no agent/model/variant; verification read-back unchanged) |
| AC-137 (omission preserves, explicit clears, hand-edit actor) | T-005 |
| AC-138 (snapshot across edit/retry) | T-006, T-013 |
| AC-139 (rows carry references, never text; exactly one change row) | T-004, T-005, T-008, T-012 |
| AC-140 (fingerprint determinism) | T-002 |
| AC-141 (quarantine of an unusable stored prompt) | T-003 |
| AC-143 (existing secret suites pass unchanged + new assertions) | T-014 |
| AC-144 (no editor; `host.storage` holds no copy) | T-014, T-016, out-of-scope guard |
| AC-145 (latency, bounds, excerpt-shortened-first) | T-010, T-011 |

## Test expectations summary (each task's own gate)

Fail-first where behaviour changes (validator refusals, preservation, composition, projection), golden literals for anything byte-identical, offline only (fake host / loopback service + temp dirs), **no `sleep`-based timing** (inject stamps; the observation chain is deterministic, so the race test schedules chain tasks instead of waiting on a clock), a seeded sentinel value scanned for in every persisted and rendered surface, and zero suppressions — a red lint or a red test is fixed, never muted.
