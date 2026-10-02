# Implementation Plan: Per-Binding Starting Prompt

**Branch**: `full-project-plan` (spec artifacts; implementation moves to `004-starting-prompt` per `AGENTS.md` git conventions) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md) (v1.1.0, APPROVED — normative body unchanged from v1.0.0)

**Input**: Feature specification `specs/004-starting-prompt/spec.md` (v1.1.0) + `checklists/requirements.md`; constitution `.specify/memory/constitution.md` v1.3.0; repo directives `AGENTS.md`; predecessors `specs/002-agent-event-extension/spec.md` (v1.7.0) + `contracts/panel-service.md`, and `specs/003-dispatch-integrity/spec.md` (v1.3.0) + `plan.md` + `data-model.md` + `contracts/{README,claim-lease,dispatch-authorization,run-history-audit}.md`; successor `specs/005-panel-ia/spec.md` (FR-051/FR-052 placement); and the shipped code itself (read for this plan: `service/bindings.ts`, `service/routes/bindings.ts`, `service/poll/{events,events-write,loop}.ts`, `service/audit.ts`, `service/store/index.ts`, `service/accounts/store.ts`, `src/session.ts`, `src/relay.ts`, `src/panel-dispatch.ts`, `src/redaction.ts`, `src/repos-service.ts`, `src/repos.ts`, `src/service-calls.ts`, `src/config.ts`, `tests/{session,service-bindings,bundle,redaction}.test.ts`, `node_modules/@openchamber/sdk/dist/contract.js` attach caps).

**Note**: No application code is written in Phases 4–5. Every design decision below is decided and justified; the genuinely open questions this feature raises — there are none — are recorded in [research.md](./research.md).

## Summary

Feature 002 shipped the loop and feature 003 (its plan complete, its Phase 6 the prerequisite of this one) puts a run layer under it: leases, single-use dispatch tokens, one correlation id, and a sixteen-entry dispatch-lifecycle audit vocabulary. **004 adds exactly one optional field to the binding — `startingPrompt` — and one block to the dispatch message.**

- **Service** (`service/`): the field is parsed, validated (length / credential shape / reserved markers / well-formedness — refuse, never coerce), stored in `bindings.json` beside the other binding fields, fingerprinted with a salt-free SHA-256 scalar, snapshotted onto the **run** at enqueue, projected onto the claim answer and the run history, referenced by four credential-free scalars on the two audit rows that record what was sent, and audited itself by exactly one `binding.prompt-updated` row per change — actor `operator` for a change that arrived through the panel, `service` for a change observed in the store file. Whole-file `PUT /v1/bindings` becomes **omission-preserves, explicit-value-sets**.
- **Panel** (`src/`): reads the snapshot off the claim answer and **composes it first** — fenced, verbatim, never budgeted against, never substituted — above today's frame; adds three reference scalars to the attachment's machine-readable `data`; renders presence/fingerprint/length (never text) on the dispatch row. **No editor, no preview, no display of the text** (004 FR-062, AC-144 — 005 FR-051 renders the one field).
- **Nothing else moves**: no new host capability, no new route, no new store file, no config field, no `version`/`SERVICE_VERSION`/SDK-pinning change, no GitHub write, no content policy on operator text (the refusal set is closed at four: 004 FR-029).

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` (`AGENTS.md` invariant 7) |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` and **committed** (invariant 1). **No `node:` imports in `src/` modules the panel bundles** — this is why the fingerprint is service-side (004 FR-016: "computed by the service") |
| Service runtime | Node ESM, host-spawned; `service/main.js` built with `bunx openchamber-guest-bundle --node` and **committed** (invariant 1) |
| Service dependencies | Node stdlib only — the fingerprint uses `node:crypto`'s `createHash('sha256')`; 004 adds **no** dependency |
| Storage (service tier) | JSON + NDJSON under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename). 004 adds **no file**: the field rides in `bindings.json`, the snapshot in 003's `runs.json`, the rows in `audit.ndjson` |
| Storage (panel tier) | `host.storage` — 004 adds **no key and no value** (004 FR-011, AC-144) |
| Validation | The shipped fail-closed binding validator (`service/bindings.ts` `parseBinding`/`validateBindings`) extended in place; the shipped secret shapes (`src/redaction.ts` `SECRET_PATTERNS` via `findSecretLeak`) reused, never extended (004 FR-024: "the same shapes the product's existing secret detection recognises") |
| Testing | vitest `5.0.2`, fully offline: fake host (`tests/support/panel.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`). No live OpenChamber, no PAT, no network (`AGENTS.md` testing philosophy) |
| Target platform | OpenChamber desktop and web only (unchanged); SDK pinned `@openchamber/sdk` `1.24.2` exact (invariant 6; 004 FR-004 — **no re-pin in 004**) |
| Host attach caps | `GUEST_ATTACH_TEXT_MAX = 16_000`, `GUEST_ATTACH_DATA_MAX = 16_000`, `GUEST_ATTACH_ID_MAX = 128` (read from the pinned SDK): the composed message and the `data` object must stay inside them (see Composition below) |
| Scale | <10 bound repositories, one logical service instance, one operator machine (unchanged from 002/003) |
| Latency | 004 adds **zero** panel↔service round trips (004 NFR-120, SC-127): the snapshot rides the claim answer that already exists |

## Constitution Check (v1.3.0) — alignment statement

> **004 aligns with every principle and every security/quality gate of constitution v1.3.0. There are no constitutional violations, therefore no complexity-tracking rows and no exceptions to record.** The feature exists to make principle **II** (safe autonomy — a new instruction channel is bounded, validated, and refused rather than trusted because it is operator-authored) and principle **IV** (human-visible auditability — fingerprint, not text, is the explainability that survives retention) true of the shipped loop; **VI** (specification and verification) supplies the closed refusal set and the byte-identity tests; **VII** (thin orchestration boundary) is the constraint that nothing new is asked of the host. Re-read after design (below) — alignment unchanged.

| Principle / gate | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Discovery, adapters, and the polling loop are untouched; the panel↔service additions are additive members of the existing v1 operations, recorded as a contract delta in [contracts/](./contracts/) (002 contract §1 versioning: additive within v1) |
| **II. Safe autonomy by default** | Fail closed everywhere: an oversized / credential-shaped / marker-imitating / non-text prompt is refused with a field-level remediation and **no part of the submission applies** (004 FR-003, FR-027); a refused save leaves the previous prompt in force; a malformed stored prompt quarantines the file with a logged reason (004 FR-019); the prompt cannot select an agent, widen authority, or move a delimiter (004 FR-040–FR-043) |
| **III. Durable and idempotent work** | The prompt is snapshotted at enqueue onto the run beside `projectId`/`worktreeOption` (004 FR-015), so a binding edit never mutates queued work and a retry (003 FR-041) composes a byte-identical message from the same snapshot; no migration, no scan-window reset, no rewrite of any stored file (004 FR-018, SC-128) |
| **IV. Human-visible auditability** | Exactly one `binding.prompt-updated` row per change (004 FR-051, SC-125); every row that records what was sent carries binding id + fingerprint (004 FR-050); the run projects presence/fingerprint/length (004 FR-052); "which prompt produced this run, and has it changed since?" is answerable from `GET /v1/audit?correlationId=` alone (004 NFR-124) with **no prompt text in any row** (004 FR-053) |
| **V. Minimal, self-hosted deployment** | No new process, dependency, service route, store file, capability, or control plane; stdlib-only service unchanged; one field inside the file the operator already backs up |
| **VI. Spec before implementation** | This plan + [research.md](./research.md) + [data-model.md](./data-model.md) + [contracts/](./contracts/) land before code; byte-identity (SC-121), secret-containment (SC-123), exactly-one-row (SC-125), and upgrade (SC-128) are named automated tasks, not aspirations |
| **VII. Thin orchestration boundary** | 004 FR-004 / 003 NFR-110: no new host capability, API, permission, or private interface. The prompt travels inside the `text` of the `host.startSession()` call the panel already makes; the project picker, worktrees, sessions, and agent pin stay host-owned |
| **Security Std (secrets)** | 004 FR-024 refuses credential-shaped prompt text **at save** using the shipped shape set, so no credential can reach `bindings.json`, a run record, an audit row, a log, a toast, or a bundle; the refusal itself never quotes the value (004 NFR-121); the existing scan suites **gain cases, never exemptions** (004 FR-005) |
| **Security Std (untrusted input)** | The untrusted region keeps 002 FR-028 / 003 FR-014 bounds, delimiters, and truncation markers untouched and unremovable (004 FR-035, FR-043); structure is **built, never parsed out of operator or source text** (004 FR-033) |
| **Security Std (durable state)** | Prompt text lives in the service store only — `bindings.json` (0700/0600) and the run's snapshot — never in `host.storage`, the panel ledger, or a log (004 FR-011, FR-053) |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any`; offline suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (invariants 1, 7) |

**AGENTS.md non-negotiable invariants honoured by this plan** — (1) committed bundles ship: every wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt `panel/main.js` + `service/main.js` in the same commit; (2) one document, two roles: **no `version` bump in 004** and **no `SERVICE_VERSION` change** (`service/routes/health.ts` stays mirrored to `package.json` `0.0.1`, pinned by `tests/service-server.test.ts`); (3) `capabilities[]` stays `["sessions","prompt"]`, `contributes.service` gains no `permissions` key; (4) kebab-case identity unchanged — panel id `mecha-turk`, `host.storage` keys keep the `mecha-turk:` prefix and **004 adds none**; (5) `SERVICE_VERSION` mirrors `package.json` (untouched); (6) SDK pin `1.24.2` untouched (004 FR-004); (7) zero suppressions, zero `any`; (8) fail-closed parsing — the binding parser refuses a present-but-non-text prompt, the file parser quarantines on any prompt violation, the run parser refuses a malformed prompt snapshot (never coerced, never dropped: 004 FR-028); (9) secrets never leave the service store — the prompt is refused at the boundary before it is a secret, and no surface carries it after; (10) `extension-spike-1` and the NDJSON event contract are compatibility surfaces: 004 **versions neither** (002 v1.3.0 migration note says so explicitly) — the two `data` scalars are additive, see Decision D9.

## Prerequisite and sequencing

003's roadmap position is first and its plan is complete but its Phase 6 tasks are unchecked: **004 executes after 003's implementation lands.** That is not a preference, it is where the hooks are:

- 004's audit additions are specified against 003's vocabulary and correlation discipline (003 v1.1.0 `## Amendment History` records them requirement-by-requirement; 003's data-model §4.2 already reserves the `binding.` prefix for `binding.prompt-updated`).
- The snapshot lands on the **run** (003's queued record), the claim answer is 003's `ClaimedRun`, and the projection is 003's `RunHistoryRow`.
- The composition budget reserves the prompt block from the dispatch-level bound 002 FR-028 sets as widened by 003 FR-014.

Where a task names a 003 module (`service/poll/runs.ts`, `service/poll/runs-parse.ts`, `service/routes/dispatch.ts`, `src/relay.ts`'s reserve sequence), it names it **as 003 ships it**. If 004 were ever executed against the 002-only codebase, the same rules apply with `QueuedEvent` standing in for the run — but that is not the plan of record and no task is written for it.

## Requirement → module mapping (what satisfies what)

| Spec group | Satisfied by (service) | Satisfied by (panel) |
| --- | --- | --- |
| **A. FR-001–005** (authority, GitHub-read-only, fail-closed, no capability, no weakened invariant) | Refusals in `service/prompt.ts` + `service/bindings.ts` (FR-003); constraint checked by existing + new static/scan tests (FR-002, FR-004, FR-005) | Composition never touches GitHub (FR-002: existing static no-GitHub-write scan covers the new module); no host call added (FR-004: `SpikeHost` Pick-list unchanged) |
| **B. FR-010–019** (field, ownership, read/write path, omission-preserves, snapshot, fingerprint, absence, no migration, unusable stored values) | `service/prompt.ts` (validate/fingerprint/snapshot); `service/bindings.ts` (field + parse + quarantine); `service/routes/bindings.ts` (preservation merge + audit rows); `service/prompt-audit.ts` (both-actor rows); `service/poll/{loop,events}.ts` + `service/poll/runs*.ts` (snapshot onto the run) | none — 004 FR-011 forbids panel persistence; `src/repos-service.ts`'s lenient binding parser already ignores the field, and the panel's field-by-field `PreparedBinding` PUT omits it (the preservation rule exists for exactly this client) |
| **C. FR-020–029** (cap, tunable range, trim/empty, normalisation, credential refusal, reserved markers, well-formedness, additive-atomic, no coercion, no content policy) | `service/prompt.ts` `validateStartingPrompt` — the one validator, four refusals, order documented in [data-model.md](./data-model.md) §2 | none (refusal surfaces on the store file's quarantine log and on the 422 envelope; rendering the 422 is 005 FR-052's) |
| **D. FR-030–039** (order, fencing, unset means no block, structural markers, may direct the agent, untrusted region stands, one composition, envelope data, literal text) | — (the machine-readable `data` scalars are panel-built from the claim answer) | `src/prompt.ts` (fence constants + reserved prefixes, shared with the validator); `src/session.ts` `composeFirstMessage` + budget reservation in `buildBoundedContext` + `buildStartSessionRequest` `data` scalars; `src/relay.ts` passes the snapshot |
| **E. FR-040–044** (not an agent selector, no back door, no authority, no suppression, not a trigger) | constraint only — 004 sends no agent/model/variant anywhere (existing static test), trigger set untouched (002 FR-015) | constraint only — `data` gains three scalars and nothing else; the pin and its warn-only read-back (003 FR-043) are untouched |
| **F. FR-050–054** (dispatch rows reference, prompt change audited, projection, two places, retention) | `service/routes/dispatch.ts` (+4 details on `dispatch.reserved`/`dispatch.result`); `service/prompt-audit.ts` (`binding.prompt-updated`); `service/routes/events.ts` (projection trio) | `src/runs-service.ts` + `src/runs-rows.ts` (FR-052's row shows presence/fingerprint/length, never text) |
| **G. FR-060–064** (the field 005 renders; no editor here; documented set path) | the field exists, validated, on the existing bindings surface (FR-060's identity fixed by this plan's contract) | **no editor in 004** — the panel ships no surface (FR-062); `README.md` + quickstart document the store-file set path (FR-062's "that path MUST be documented"); the guidance sentences (FR-063) and the "not set" state (FR-064) travel with 005's field and are documented here (FR-074) |
| **H. FR-070–074** (per binding only, no invented default, future fallback order, not a policy profile, docs) | per-binding only by construction (field is on the binding record); no default text anywhere (FR-071) — asserted by the byte-identity suite | no panel default either; docs task (T-015) carries FR-074's four statements |

## Already built vs. changed vs. new

### Already built — do NOT re-touch (002 shipped, live-validated)

- **Service transport/security**: loopback server, bearer auth, body/size caps, route table mechanics (`service/server.ts`, `service/http.ts`, `service/auth.ts`, `service/pipeline.ts`), consent (`service/consent.ts`), throttles (`service/throttle.ts`).
- **Credential custody + accounts**: `service/accounts/`, `service/routes/{accounts,verify,credential}.ts`. The account-delete guard (`service/accounts/store.ts` `disableBindingsForAccount`) writes `{ ...binding.raw, state: 'disabled' }` — it already preserves every unknown field, so it preserves `startingPrompt` **by construction**; 004 does not change it.
- **Bindings mechanics**: `service/bindings.ts` store file handling, `service/routes/bindings.ts` whole-file grant, `service/routes/events.ts` `readStatusRows` — 004 *extends* the validator and the PUT semantics (below), never replaces the surface.
- **Polling/detection**: `service/poll/{poller-github,poller-entries,triggers,loop,timer,scan}.ts` trigger detection, windows, rate budget; `events-write.ts` `buildEventId` (**byte format untouched**, 002 FR-012 / 003 FR-012).
- **Store/audit mechanics**: `service/store/*` (0700/0600, atomic writes, quarantine funnel), `service/audit.ts` writer (seq chain, redaction pass, `AuditEntry` shape) — 004 *appends through it* and *adds vocabulary*, never rewrites it.
- **Config/health**: `service/config.ts`, `service/routes/{config,health,status}.ts` — 004 adds **no config field** (the cap is a module constant, Decision D6) and touches no status projection (005's).
- **Panel**: token handoff + consent, accounts mirror, bindings/repos UI (`src/repos*.ts`), evidence (`src/evidence.ts`), redaction guards (`src/redaction.ts` — reused, not extended), ledger write path (`src/ledger.ts`), project resolution (`src/session.ts` `resolveProject`), the `openSession`/`onSession` verification *mechanic* (`src/agent-verify.ts`), lifecycle (`src/lifecycle.ts`), storage-write guard (`src/storage-write.ts`), the spike dispatch path (`src/panel-dispatch.ts` — untouched; it composes with no prompt, which is its byte-identical default).
- **Invariants**: evidence schema `extension-spike-1` (version unchanged — see D9), delivery id format (`buildEventId`), manifest (ids, capabilities, **zero settings**), SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` `0.0.1`, the committed-bundle build pipeline.

### Already built — 003's deliverables (prerequisite; do NOT re-touch, do NOT re-specify)

003's plan is complete and its tasks are the wave that precedes 004's. Everything 003 owns is a **read-only dependency** for this feature: the run model (`service/poll/{runs,runs-parse,runs-adopt,run-key,sweep}.ts`), the claim/lease answer (`service/poll/events.ts` `claimRuns` + `service/routes/events.ts`), the authorization family (`service/routes/dispatch.ts` reserve/result/abandon/blocked, `service/routes/run-ops.ts` retry/requeue/resolve/verification), the sixteen-row lifecycle vocabulary + `dispatch.refused` + correlation discipline (`service/audit.ts` vocabulary constants, `audit-vocabulary.test.ts`), the run-history projection and `GET /v1/audit` (`service/routes/events.ts`, `service/routes/audit.ts`), the panel relay sequence with reconcile/reserve/attempt-record (`src/relay.ts`, `src/reconcile.ts`, `src/dispatch-record.ts`), the multi-reference bounded context (`src/session.ts` `buildBoundedContext` as 003 widens it), and 003's four contract files. **004 composes with all of it and contradicts none of it** (004 spec `## Governing Principles`: "003's dispatch state model is not restated and not contradicted").

### Changed (existing behaviour/shape moves)

| # | Change | Where | Specs |
| --- | --- | --- | --- |
| C1 | Binding validator gains the prompt field **and** switches to issue *accumulation*: `parseBinding` collects **every** problem in a candidate (identity → target → mode → prompt) instead of returning the first, so one 422 answers the whole submission; `BindingRecord` gains `startingPrompt?: string` (key absent when unset); the file parser refuses a violating prompt (quarantine) and captures the field+remediation as the logged reason | `service/bindings.ts` | 004 FR-010, FR-013, FR-017, FR-019, FR-027, FR-028; AC-131, AC-141 |
| C2 | Whole-file `PUT /v1/bindings` reads the stored document inside a new prompt-observation chain, **merges preserved prompts onto submissions that omit the field**, writes, then appends one `binding.prompt-updated` row per binding whose effective prompt differs (actor `operator`) and advances the baseline | `service/routes/bindings.ts` (+ `service/prompt-audit.ts`) | 004 FR-014, FR-051; AC-132, AC-137 |
| C3 | `readBindings` becomes the observation funnel: after a successful parse it runs the same chain task with actor `service`, so a prompt edited in the store file is recorded by whoever the service could actually attribute — never by the panel | `service/bindings.ts` + `service/prompt-audit.ts` | 004 FR-051 (actor rule), edge case "edited by something other than the panel" |
| C4 | Enqueue snapshots the prompt: `scanBinding` resolves `promptSnapshotOf(binding)` from **the same binding object that produced `projectId`/`worktreeOption`** and passes it into `enqueueEvents`; run creation persists `prompt: { text, fingerprint, length } \| null` beside them; coalesced joins keep the run's original snapshot; **delivery rows gain no field** | `service/poll/loop.ts`, `service/poll/events.ts`, `service/poll/runs.ts`, `service/poll/runs-parse.ts` | 004 FR-015, FR-053; AC-138 |
| C5 | The claim answer carries the snapshot to the panel: `promptPresent`, `promptFingerprint`, `promptLength`, **`promptText`** (claim-transport only, like `sourceReferences[].excerpt` — never re-stored) | `service/routes/events.ts` | 004 FR-015, FR-037; contracts `dispatch-prompt.md` §1 |
| C6 | The run-history projection gains `promptPresent`, `promptFingerprint`, `promptLength` — **no text**, no field removed (a pre-004 run projects `false` / `null` / `null`) | `service/routes/events.ts` | 004 FR-052; AC-139 |
| C7 | `dispatch.reserved` and `dispatch.result` gain four credential-free detail scalars: `bindingId`, `promptPresent`, `promptFingerprint`, `promptLength` — written by the service from the run's snapshot, never from panel input | `service/routes/dispatch.ts` | 004 FR-050; 003 v1.1.0 record; AC-139 |
| C8 | The run parser validates the snapshot: present-but-non-text, over-cap, malformed fingerprint, or credential-shaped text refuses the document (quarantine + logged reason — the same posture as the bindings file) | `service/poll/runs-parse.ts` | 004 FR-019 (by analogy), FR-028, NFR-121 |
| C9 | Composition: `buildBoundedContext` accepts a reserved-character count (the prompt block + its blank line) so the excerpt budget is cut **first** and the prompt is never cut; `buildStartSessionRequest` gains `promptPresent`/`promptFingerprint`/`promptLength` in `data`; the panel's claim DTO gains the four prompt members | `src/session.ts`, `src/repos-service.ts` | 004 FR-030–FR-039, FR-037; AC-130, AC-134, AC-145 |
| C10 | The relay passes the claimed run's snapshot into composition (one call site; the spike path composes with `null`, which is its unchanged byte-identical default); the ledger entry for a dispatch never carries the prompt | `src/relay.ts` | 004 FR-032, FR-053 |
| C11 | The dispatch row shows whether a prompt was used, its fingerprint, and its length — text never; rendered through the existing non-HTML path | `src/runs-service.ts`, `src/runs-rows.ts` | 004 FR-052, NFR-127; AC-139 |
| C12 | 003's contract files receive short additive notes so a reader of 003's contracts sees 004's fields (see "Cross-feature coordination") | `specs/003-dispatch-integrity/contracts/{claim-lease,run-history-audit,dispatch-authorization}.md` (docs only) | 004 spec `### Audit Vocabulary Delta`; 003 v1.1.0 record |

### New

| # | New thing | Where | Specs |
| --- | --- | --- | --- |
| N1 | Shared prompt text rules, browser-safe: fence constants (`--- BEGIN OPERATOR STARTING PROMPT ---` / `--- END OPERATOR STARTING PROMPT ---`), the reserved prefixes (`--- BEGIN `, `--- END `), trim + CRLF/CR→LF normalisation, code-point counting, control-character test | `src/prompt.ts` | 004 FR-022, FR-023, FR-025, FR-026, FR-031 |
| N2 | The prompt domain module (service): `STARTING_PROMPT_MAX_CODE_POINTS = 2_000`, `validateStartingPrompt` (the four refusals, no coercion, no echo), `promptFingerprint` (`mtp-<sha256 hex[0:32]>`), `promptSnapshotOf`, `PromptSnapshot` | `service/prompt.ts` | 004 FR-016, FR-020–FR-024 |
| N3 | The prompt-change observer: per-store baseline (seeded once from `binding.prompt-updated` rows in `audit.ndjson`), a per-store chain serialising bindings reads/writes with their observations, row builder with decision `set`\|`changed`\|`cleared` | `service/prompt-audit.ts` | 004 FR-051, SC-125 |
| N4 | Contract delta set (wire/panel changes — see [contracts/](./contracts/)) | `contracts/README.md`, `contracts/binding-prompt.md`, `contracts/dispatch-prompt.md` | 004 `## Dispatch Message Composition`, `### Audit Vocabulary Delta` |
| N5 | Prompt test suites: validation matrix, fingerprint determinism, composition byte-identity (golden), prompt-audit exactly-one, upgrade script, secret-containment extension | `tests/prompt-validation.test.ts`, `tests/prompt-audit.test.ts`, `tests/prompt-composition.test.ts`, `tests/prompt-upgrade.test.ts` + extensions to `tests/{service-bindings,service-events,service-audit-read,bundle,relay-integrity,session}.test.ts` | 004 AC-130–AC-145 |
| N6 | Operator documentation for the field (set path, cap, literal text, credential refusal, pinned agent) + `AGENTS.md` module-map rows | `README.md`, `specs/002-agent-event-extension/quickstart.md`, `AGENTS.md` | 004 FR-062, FR-074 |

**Per-requirement headline split**: already built = the transport, custody, polling, store, audit writer, config, panel substrate **and** 003's entire run layer; changed = C1–C12; new = N1–N6. Group A's FR-001/002/004/005 are conformance-verified rather than built (they are posture); group E is constraint-verified; group G's *rendering* half is 005's (FR-060–FR-064 bind whichever surface renders, and 004 ships no surface).

## Architecture (decided)

### The field, its validator, and the four refusals

`startingPrompt` is validated by **one** function in `service/prompt.ts`, called from the binding validator (write path *and* read path — the same rules on both, so a hand-edited file and a panel save cannot disagree). Order, each step documented with its requirement:

1. **Type**: absent → unset (key omitted); explicit `null` → unset; a string → continue; number/boolean/object/array → **refuse** (`startingPrompt must be text…`), never coerced or dropped (004 FR-017, FR-028).
2. **Trim** the ends only (004 FR-022; internal whitespace is the instruction).
3. **Empty after trim → unset** (004 FR-022; "an empty instruction" is not a state). The write path stores the key absent.
4. **Normalise** `\r\n` and lone `\r` → `\n` (004 FR-023). *Before* the control-character test, so a Windows line ending is a line ending and not a refusal.
5. **Cap**: code points of the normalised, trimmed text ≤ `2_000` (004 FR-020; counted with `[...text].length`, i.e. Unicode code points, not UTF-16 units). One over → refuse naming field + cap, never truncating, never quoting.
6. **Well-formedness**: no null character and no control character other than `\n`/`\t` (004 FR-026) → refuse.
7. **Reserved markers**: no line beginning with `--- BEGIN ` or `--- END ` (004 FR-025 — the *prefix* rule, so a future marker is covered; the trailing space is part of the prefix, so `--- BEGINNING …` is ordinary text). Remediation names the marker family, never the text.
8. **Credential shape**: `findSecretLeak` from the shipped `src/redaction.ts` (004 FR-024 — "the same shapes") → refuse naming the matched **label** (`github-token-classic`, …) and never the value.

The content-refusal set is closed at **four** — length (5), well-formedness (6), reserved markers (7), credential shape (8) — plus the type refusal of step 1, which is shape rather than content (004 FR-017): **no content policy, ever** (004 FR-029). Every refusal is a `BindingIssue { field: 'startingPrompt', remediation }` in the existing voice, collected additively (C1), never echoed.

**Fingerprint** (004 FR-016): `mtp-` + `sha256(UTF-8 bytes of the normalised text)` hex, first 32 hex characters — fixed 36 chars, `[a-z0-9-]` only, so it is safe in a log line, an audit row, and a URL; no salt, no configuration, computed only from the text; a pure function of the bytes, so two machines, two restarts, and two builds agree (004 NFR-126, AC-140). It is *derived on demand* — the binding record stores only the text, so no stored fingerprint can drift from its text. Because a credential-shaped prompt is refused at save (004 FR-024), a fingerprint can never be a hash of a secret.

### Omission-preserves: the whole-file write

`PUT /v1/bindings` keeps its whole-file replacement shape and gains one merge rule (004 FR-014, gate default #4):

```
validate submitted candidates (all fields, incl. any submitted startingPrompt)
chain task:
  read stored document            ← fresh read inside the prompt-observation chain
  for each submitted binding:
    field absent  → attach the stored binding's prompt (preserve)
    field present → validated value stands (null / empty-after-trim ⇒ unset)
  compute per-binding delta vs stored  →  write bindings.json  →  append one
  `binding.prompt-updated` row per differing binding (actor `operator`)  →  advance baseline
```

The shipped panel is precisely the client the rule protects: it builds `PreparedBinding` field-by-field (`src/repos.ts`), so its PUTs never contain `startingPrompt`, and its lenient `parseBindingEntry` (`src/repos-service.ts`) ignores the field on read. Between 004 and 005 the documented set path is the store file (004 FR-062), which is why preservation cannot be an afterthought — the panel *will* save over bindings it cannot see the field of.

### The prompt-change observer (exactly one row per change, honest actor)

`service/prompt-audit.ts` owns one **per-store chain** and one **per-store baseline** (`Map<bindingId, fingerprint | null>`):

- **Baseline seed** (once per store handle): scan `audit.ndjson` for `binding.prompt-updated`, keep the highest-`seq` row per binding. This gives `previousFingerprint` its value across restarts and keeps `binding.prompt-updated` self-describing without a new store file (004 NFR-129 — no new store, no new surface).
- **Observation** (chain task): read the document → diff each binding's fingerprint against the baseline → append one row per difference (`decision: set | changed | cleared`, actor as supplied) → advance the baseline (add, update, and drop bindings removed from the file).
- **Call sites**: `readBindings` (actor `service` — the poll loop reads it every cycle, so a hand edit is recorded within one cycle; the GET route and the PUT route's own read funnel through it) and the PUT route's write task (actor `operator`, 004 FR-051's actor rule). The PUT handler never calls `readBindings` *while holding* the chain — it uses the unobserved reader — so the chain cannot self-deadlock.
- **Serialization is the correctness argument**: because the file read, the write, the diff, and the baseline advance all run inside one chain, a poll-cycle read racing a PUT cannot produce a stale or duplicate row — SC-125's "exactly one row per change" holds by construction, not by timing.
- **Failure posture**: an audit append that fails is logged (`warn`, binding id, fingerprint — never text) and the baseline still advances, exactly 003's FR-063 posture: state stands, the failure is visible, nothing rolls back.

### Snapshot at enqueue

```
poll cycle ─ readBindings ─▶ binding (projectId, worktreeOption, startingPrompt)
   │
   ├─ collectTriggerEvents … detection snapshots (unchanged)
   ▼
scanBinding: promptSnapshotOf(binding) ─┐   ← the same binding object that
   ▼                                    │      produced projectId/worktreeOption
enqueueEvents(incoming, prompt) ────────┘   (004 FR-015: "at the same moment")
   │  inside the queue chain:
   ├─ dedupe / coalesce / create run
   ├─ run.prompt = prompt ?? null          ← the ONE persisted snapshot
   └─ delivery row: unchanged, no field    ← FR-053: the text lives in exactly two places
```

- A run created later by coalescing **keeps its original snapshot**; a binding edited while the run waits changes nothing about that run (004 FR-015, AC-138).
- A retry (003 FR-041) reclaims the same run → same snapshot → byte-identical message.
- Retention: the snapshot is payload on the run and dies with the run's terminal-tail eviction (004 FR-019; 003 NFR-107). It never outlives the record.

### Composition in the dispatch path

```text
--- BEGIN OPERATOR STARTING PROMPT ---      ← emitted by the composition (004 FR-031)
<the stored text: trimmed at the ends, normalised, otherwise byte for byte>
--- END OPERATOR STARTING PROMPT ---
<blank line>
Mecha Turk dispatch (automated — …)         ← today's frame, unchanged
… frame lines …
--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---
… bounded excerpt, 003 FR-014 per reference …
--- END UNTRUSTED ISSUE TEXT ---
```

- **Unset → `composeFirstMessage` returns the frame unchanged**: no fence, no blank line, no placeholder — byte-identical to the pre-feature composition (004 FR-032; SC-121 asserted against a golden string captured from today's `buildBoundedContext`).
- **Budget: reserve, then bound.** When a prompt is set, `promptBlock.length + 2` (the blank line) is subtracted from the composition's dispatch-level budget *before* the excerpt budget is computed; every existing per-item cap, separator count, and truncation marker then applies to the remainder. The prompt block is never passed through `fitExcerpt`, never sliced, never ellipsised (004 FR-035). Arithmetic for the plan's two regimes:
  - *Shipped frame* (`CONTEXT_MAX_CHARS = 4_000`): max block = 38 + 1 + 2,000 + 1 + 36 = **2,076** chars, + 2 for the blank line = **2,078** reserved → 1,922 left; frame ≈ 400 → `budget ≈ 1,520` → still above `BODY_EXCERPT_MAX_CHARS = 1_200`, so **a maximal prompt never starves the excerpt** (the spec's `## Assumptions` arithmetic, verified).
  - *003's widened frame* (≤4,000 per source, ≤12,000 per dispatch): excerpt budget = 12,000 − 2,078 ≈ 9,922 with per-reference caps unchanged.
  - Whole message stays under `GUEST_ATTACH_TEXT_MAX = 16_000` (worst case ≈ 2,078 + frame + 12,000 excerpt), so the host's `clampAttachRequest` slice can never fire (AC-145).
- **Markers are emitted, never searched for** (004 FR-033): `composeFirstMessage` builds strings; nothing in the pipeline splits, re-parses, escapes, re-indents, or substitutes in the operator text — `{number}`, `Correlation:`, `Rule:` written *by the operator* arrive as literal characters inside the fence (004 FR-039, AC-134). The one templated field in the product (002's `{number}` in the worktree option) is applied to the worktree option, not to the prompt.
- **One composition, one truth** (004 FR-036): `composeFirstMessage` is the only function that produces the message; the relay calls it; there is no preview surface to diverge (and building one would be 005's act).

### Machine-readable surfaces (the four shapes)

| Surface | Fields | Carries text? |
| --- | --- | --- |
| Binding document (`GET`/`PUT /v1/bindings`) | `startingPrompt?: string` (absent when unset) | **yes** — configuration read, the only read that returns it (004 FR-012) |
| Claim answer (`GET /v1/events/pending` entries) | `promptPresent`, `promptFingerprint`, `promptLength`, `promptText` | **yes, transport only** — like `sourceReferences[].excerpt`, never re-stored |
| Run history (`GET /v1/events` rows) | `promptPresent`, `promptFingerprint`, `promptLength` | no (004 FR-052) |
| `startSession` attachment `data` | `promptPresent`, `promptFingerprint`, `promptLength` | no — a second copy of the text is forbidden (004 FR-037, AC-130) |
| Audit details (`dispatch.reserved`, `dispatch.result`) | `bindingId`, `promptPresent`, `promptFingerprint`, `promptLength` | no (004 FR-050) |
| `binding.prompt-updated` details | `bindingId`, `promptPresent`, `promptFingerprint`, `promptLength`, `previousFingerprint` | no (004 FR-051) |

## Key decisions and rationale

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Fingerprint = `mtp-` + `sha256(text)[hex 0:32]`, no salt, no config, derived on demand | 004 FR-016 demands reproducibility from the text alone; mirrors 003's `mt-run-…`/`dtk-…` derivation discipline (hash prefix + fixed hex), so the format is already load-bearing in this store | full 64-hex (no benefit at this scale, noisier rows); HMAC/salt (violates FR-016); storing the fingerprint on the binding (a second stored field that can drift from its text — 004 `### Key Entities` says the binding gains **one** field) |
| D2 | Validation lives in `service/prompt.ts`, called from **both** the write path and the file-read path | one validator, one refusal set: a hand-edited file and a save cannot disagree (004 FR-019 requires the read path to refuse the same rules) | validating only at save (a file edit would bypass FR-019); a second validator in the panel (NFR-128: "shares the existing fail-closed validator rather than introducing a parallel one") |
| D3 | Normalise **before** the control-character test; measure the cap on the normalised, trimmed text | CR is a line ending (004 edge case "Windows line endings"), not a control character to refuse; the fingerprint and the stored value must be the canonical bytes (004 FR-023) | normalising after validation (refuses every CRLF paste); measuring pre-normalisation (the same text would fingerprint one way and be measured another) |
| D4 | Whole-binding issue **accumulation** in `parseBinding` | 004 FR-013/FR-027 require every problem in the submission in one answer with no partial apply; the shipped code collected one per binding, which cannot report "the prompt problem *and* every other problem" | keeping first-issue-per-binding (a submission with a bad repository and a bad prompt reports one of them — readable as violating FR-027) |
| D5 | Omission-preserves is implemented **at the PUT route with a fresh stored read**, not by making the panel carry the field | the rule exists precisely because the panel is a client that cannot see the field until 005 (spec `## Assumptions`); making the panel round-trip it would introduce stale-clobber on hand-edits | panel carries `startingPrompt` (stale-clobber: a panel holding an old copy overwrites a hand-edit with an explicit value); clear-on-omission (gate default #4 — rejected at the gate) |
| D6 | The cap is a **module constant** `STARTING_PROMPT_MAX_CODE_POINTS = 2_000` (tunable in planning within 500–3,000 per 004 FR-021), **not** a `ServiceConfig` field | 006 owns the settings surface and its field list; a config field with no operator-facing consumer is exactly the inert-field case 006 and 003 (its `requeueBudget` ruling) rejected | adding `promptMaxChars` to `config.json` (collides with 006's enumerated Settings list; no live consumer; spec allows planning-time adjustment without one) |
| D7 | The snapshot lives **only on the run**, passed from `scanBinding` into `enqueueEvents` | 003's amendment records the run as the queued record 004 extends; the delivery row gains nothing, so the text persists in exactly two places (004 FR-053); `scanBinding` has the binding in hand, so the snapshot shares the moment with `projectId`/`worktreeOption` (004 FR-015) | snapshotting on the delivery row too (three persisted copies — FR-053 forbids); reading the binding inside the enqueue chain (the binding read at cycle start is the one that produced the other snapshot fields — a second read could disagree with them); transient field on `QueuedEvent` stripped at serialization (type gymnastics and a footgun for every future writer) |
| D8 | Prompt-change observation runs on a **per-store chain with a baseline seeded from the audit trail** | linearizes read/write/diff/baseline so SC-125's exactly-one holds under a poll-cycle-vs-PUT race; the audit seed supplies `previousFingerprint` across restarts; no new store file (004 NFR-129) | diffing outside a chain (rare duplicate/stale row — violates SC-125); persisting the baseline in a new file (a new store file nobody specified); re-deriving the baseline from `bindings.json` alone (it *is* the thing being compared); scanning audit on every read (unbounded cost) |
| D9 | The two attachment-`data` scalars are **additive inside `extension-spike-1`**; the schema version does not change | 002 v1.3.0's migration note already rules that 004 "versions neither the delivery schema nor the delivery key"; additive-within-contract is the house rule (002 contract §1; 003 added `runCorrelationId` without a version bump); the host stores `data` opaquely and the panel never reads it back | bumping to `extension-spike-2` (churns the diagnostics surface 005 explicitly keeps to *notice* a version change, and every pinned test, for two scalars) |
| D10 | The panel **does not re-validate** the snapshot it receives from the claim | the service is the single save boundary (004 FR-013/FR-024); the claim answer is service-authored over a service-parsed store; a panel-side refusal would invent a second boundary and a dispatch-blocking path no requirement asks for | panel-side `findSecretLeak` before composing (defence-in-depth that can only fail into an un-specified `blocked:` state — and silently dropping operator text is the redact-and-store behaviour 004 FR-024 rejects); the run parser already refuses credential-shaped stored text (C8), so the claim answer cannot carry one |
| D11 | The run parser validates the snapshot's **shape** (string, cap, `^mtp-[0-9a-f]{32}$`, credential shape → refuse document) but **does not recompute** the fingerprint | recompute-on-read would turn any future fingerprint-algorithm change into a quarantine of every stored run | recompute-and-compare (self-integrity at the cost of a migration landmine; the store is operator-owned 0600 and hand-editing runs is already a refuse-and-repair path) |
| D12 | Refusal rendering of the 422 (`error.issues`) on the bindings surface is **not built here** | the panel has no field to render it against until 005 (004 FR-062), and 005 FR-052 explicitly owns rendering the service's field-level refusal; 004 fixes the envelope so 005 has a shape to render | building a prompt-specific error line in the shipped Repos tab (an editing surface for a field 004 forbids displaying, retired again by 005) |
| D13 | Composition stays **panel-side** in `src/session.ts` | constitution VII + 004 FR-004: the message is the attachment's `text`, which only the panel can supply; the service never calls the host | composing service-side and shipping a pre-built message (the service has no host call, and carrying full message text over the claim answer would move operator text to a third transport for no benefit) |

## Migration & rollout strategy

**There is no migration, and that is the design** (004 FR-018, SC-128):

| Stored artefact written before 004 | After upgrading | Mechanism |
| --- | --- | --- |
| `bindings.json` without `startingPrompt` | parses unchanged; reads as unset; dispatch byte-identical | absence is the correct reading; the file is not rewritten, not quarantined, not re-versioned (`SERVICE_SCHEMA_VERSION` stays `1`, no document marker exists on this file) |
| `bindings.json` with `startingPrompt: null` | reads as unset (004 FR-017) | parser maps null → key absent |
| `bindings.json` with a hand-added invalid prompt | **quarantined with the field+remediation reason logged; every binding stops scanning until repaired** (004 FR-019, AC-141) — the upgrade itself never quarantines a file it shipped | the read-path validator refuses, the store's existing quarantine funnel renames, `readBindings` logs the reason |
| `events.json` deliveries | untouched: no new field, `buildEventId` byte format unchanged | C4 puts the snapshot on the run, not the delivery |
| `runs.json` runs (003's, possibly adopted in the same release train) | `prompt` absent → `promptPresent: false`, `promptFingerprint: null`, `promptLength: null` on every surface | absence-means-unset, stated in 003 v1.1.0's migration note as "a true statement about that run rather than a hole in the record" |
| `audit.ndjson` | append-only; no row added, removed, or rewritten; the observer's baseline simply starts empty for bindings that never had a prompt row | chain-seeded cache pattern, unchanged writer |
| In-flight queued work | dispatches with the text it was queued with (004 AC-142) | the snapshot is taken at enqueue; nothing re-reads the binding at dispatch |
| Panel | nothing: no key, no parser change that would reject the field (the binding parser is lenient by design), no editor | `PanelBinding` never grows the field (D5) |

**Rollout mechanics**: panel and service ship together in one commit (invariant 1 — bundles rebuilt); `version` stays `0.0.1` (invariant 2; a bump is a release decision, and 004 is not a release); `SERVICE_VERSION` stays mirrored (invariant 5). Upgrade validation is a named test (T-013): seed a pre-004 store → start the service → assert zero quarantines, zero scan-window resets, byte-identical composition for a prompt-less binding against a golden string captured from the shipped `buildBoundedContext`, unchanged delivery ids / run keys / correlation ids.

## Cross-feature coordination & surfaced conflicts

1. **003 (contract amendment — stated, as required).** 004's prompt-reference scalars **change three of 003's contract files additively** and 004's own [contracts/](./contracts/) is authoritative for them: `claim-lease.md`'s `ClaimedRun` gains four members; `run-history-audit.md`'s `RunHistoryRow` gains three (003 already reserved this with its own line: *"004's additive delta (not built here)"*); `dispatch-authorization.md` §1/§2 gain four required `details` keys on `dispatch.reserved` and `dispatch.result`. **No 003 field is renamed, retyped, or removed; no event type is added to the lifecycle vocabulary; `binding.prompt-updated` uses the non-lifecycle `binding.` prefix 003's data-model §4.2 already reserved for it; correlation discipline is untouched** (003 FR-062: the fingerprint is derived, never minted per row). Task C12 patches 003's contract files with pointer notes so the two directories cannot disagree.
2. **003 v1.1.0 wording slip (noted, not implemented).** 003's FR-043 amendment row says a prompt that names an agent "is refused at save rather than dispatched" — that contradicts 004 FR-040/FR-029 and AC-135 (delivered **verbatim**, session still pinned). 004 FR-001 makes 004 authoritative for prompt behaviour and 003's own record says "004 is authoritative only for the prompt". **004 implements verbatim delivery; no content rule is built.** Recorded here so a later 003 amendment pass can correct the sentence; it is a documentation inconsistency, not a product question.
3. **005 (division of labour).** 004 ships **no** editor, preview, or display of the text (004 FR-062, AC-144); 005 FR-051 renders exactly one field in the binding editor with the FR-063 guidance and FR-064's "not set" state, and 005 FR-052 renders the service's 422 refusals. 004 ships the projection and the *minimal* dispatch-row line that 004 FR-052 itself requires (presence/fingerprint/length); 005 may re-place that line — it must not build a second one, and neither feature builds a second field. Reading of the two texts: the fingerprint **does** belong on the dispatch row (004 FR-052's MUST, reaffirmed by 005's own amendment table "the three projected fields stand exactly as specified") and does **not** belong on the Bindings row summary (005 FR-051: presence and length only) — two different rows.
4. **006 (a non-field).** The cap stays a constant (D6); 004 adds no `ServiceConfig` member, so 006's Settings list is untouched by this feature.
5. **Conflicting instruction surfaced to the requester (not silently resolved).** The Phase-4 brief asked this plan to cover a "prompt edit surface on the Bindings UI", while the approved spec forbids one outright (004 FR-062: "This feature **MUST NOT** add any editing, preview, or display surface for the prompt"; AC-144 asserts its absence at close-out; clarification row 14 "Does 004 build the Bindings tab's field? → No"). **This plan follows the approved specification** — 004 ships the capability (field + validation + PUT semantics + documented set path) and its validation, the panel ships the data path and composition, and the edit surface belongs to 005 FR-051. If the requester intends 004 to render an editable field anyway, that is a spec amendment (004 v1.2.0 + 005 coordination) and must come back as a gate decision, not a plan detail.

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Composition accidentally non-byte-identical when unset (a stray blank line, a reworded frame) | invalidates every in-flight mental model; SC-121 fails | golden test: capture today's `buildBoundedContext` output as a literal and assert `composeFirstMessage(null, frame) === frame` and full-message equality (T-010, T-013) |
| Double or stale `binding.prompt-updated` row under a PUT/poll race | SC-125 "exactly one" fails; the audit trail mis-attributes | all reads/writes/diffs/baseline advances on one per-store chain (D8); a dedicated race test enqueues a read observation between a PUT's write and its row append |
| Prompt text leaks into a log, ledger entry, toast, or error body | violates the product's hardest invariant (constitution I, 004 NFR-121) | no call site passes text to a logger by construction; suite seeds a prompt, runs a full cycle, and scans logs + ledger + `host.storage` + bundles for the value (T-014); refusals never echo the submitted value (asserted per refusal) |
| Whole-file PUT body exceeds `GUEST_REQUEST_BODY_MAX` (60,000) with many prompt-laden bindings | a large config cannot be saved (413) | scale assumption is <10 repositories (002/003/004 `## Assumptions`): 10 × (2,000 + ~300) ≈ 23,000 ≪ 60,000. Recorded as a bound, not a defect; the cap that matters (2,000/field) is enforced at validation |
| Claim answer grows by one prompt per claimed run | could approach `GUEST_REQUEST_RESPONSE_MAX` (256,000) on a burst | prompt ≤ 2,000 chars; the answer already carries excerpts per reference; test asserts a maximal claim batch stays under the cap (T-007); the transport guard errors rather than truncating (002 contract §1) |
| 003 modules not yet landed when 004 tasks start | tasks reference files that do not exist | hard sequencing note in this plan and in [tasks.md](./tasks.md): 004's Wave 1 (field/validation) is independent of 003, Waves 2–3 require 003's run layer; the orchestrator must not dispatch Waves 2+ before 003's final gate |
| Fingerprint algorithm changes in a future feature | hand-edited/mismatched snapshots | the run parser validates format, not derivation (D11); the algorithm is documented here as the compatibility surface |
| `parseBinding` issue accumulation changes an existing expectation | a shipped test asserting a single-issue list goes red | the one shipped assertion is containment-based (`toContain('triggers')`) and stays green; if an exact-array assertion surfaces, the expectation is updated with the reason — the *wire shape* (`422` + `issues[]`) is unchanged |
| Prompt interpreted as an agent selector by a reader of 003's amendment wording | spec confusion, not code | coordination note 2 above; AC-135 tests verbatim delivery + pinned agent explicitly |
| Committed bundles forgotten | shipped code ≠ source (invariant 1) | every wave's exit criterion includes `npm run build` + `tests/bundle.test.ts` green; `npm run verify` at wave boundaries |

## Out-of-scope guard (checked at every wave)

No editor, preview, or display of prompt **text** in the panel (004 FR-062, AC-144 — 005 FR-051 owns the field; do not "just add a textarea"). No template placeholders or substitution of any kind in the prompt (004 FR-039). No content policy beyond the four refusals (004 FR-029) — including **no** refusal for prompts that name an agent (004 FR-040, AC-135). No GitHub write (002 FR-031, 003 FR-002, 004 FR-002). No change to the dispatch state machine, leases, tokens, requeue budget, dead-lettering, or correlation ids (003 owns them). No change to `service/routes/status.ts`'s polling block, no rename of copy/modules/routes (005). No settings field, no `ServiceConfig` addition (006 / D6). No account-level, repository-group, or global prompt, and no invented default text (004 FR-070, FR-071). No policy profiles, no per-call agent/model/variant, no evidence-schema version bump, no `version`/`SERVICE_VERSION`/SDK-pin change.

## Project structure

### Documentation (this feature)

```text
specs/004-starting-prompt/
├── spec.md                # v1.1.0, APPROVED — the source of truth (FR/AC quoted as written)
├── plan.md                # this file (/speckit.plan)
├── research.md            # Phase 0: no open questions — settled sources cited
├── data-model.md          # Phase 1: field delta, fingerprint, snapshot, audit rows, validation scenarios
├── contracts/
│   ├── README.md          # index + what amends which predecessor contract
│   ├── binding-prompt.md  # binding document field, omission-preserves, refusals, prompt-change audit row
│   └── dispatch-prompt.md # claim members, projection trio, audit scalars, attachment data, composition pointer
├── tasks.md               # Phase 5 output (/speckit.tasks)
└── checklists/requirements.md   # pre-existing Phase-3 checklist (untouched)
```

`quickstart.md` is deliberately not produced: the Phase-4 brief scoped this delivery to plan/research/data-model/contracts/tasks, and the operator-facing walkthrough this feature needs lands under FR-062/FR-074 in `README.md` + `specs/002-agent-event-extension/quickstart.md` (task T-015), where operators already look.

### Source code (repository root — the real layout this plan changes)

```text
src/
├── prompt.ts              # NEW: fence constants, reserved prefixes, trim/normalise/code-point rules (shared, browser-safe)
├── session.ts             # CHANGED: composeFirstMessage + budget reservation + data prompt scalars
├── relay.ts               # CHANGED: pass the claimed run's snapshot into composition (one call site)
├── repos-service.ts       # CHANGED: claim DTO gains promptPresent/promptFingerprint/promptLength/promptText
├── runs-service.ts        # CHANGED: run row DTO gains the projection trio
├── runs-rows.ts           # CHANGED: dispatch row shows presence/fingerprint/length (never text)
└── main.js (panel/)       # REBUILT + committed (invariant 1)

service/
├── prompt.ts              # NEW: validateStartingPrompt, promptFingerprint, promptSnapshotOf, cap constant
├── prompt-audit.ts        # NEW: baseline + per-store chain + binding.prompt-updated rows (both actors)
├── bindings.ts            # CHANGED: BindingRecord.startingPrompt?, issue accumulation, file-path refusal + logged reason, observation funnel in readBindings
├── routes/bindings.ts     # CHANGED: preservation merge + operator-actor rows inside the chain
├── routes/events.ts       # CHANGED: claim prompt members + run-history projection trio (003's shapes)
├── routes/dispatch.ts     # CHANGED: four detail scalars on dispatch.reserved / dispatch.result (003's module)
├── poll/loop.ts           # CHANGED: scanBinding passes promptSnapshotOf(binding) into enqueueEvents
├── poll/events.ts         # CHANGED: enqueue passes the snapshot into run creation (003's chain)
├── poll/runs.ts           # CHANGED: run creation persists prompt (003's module)
├── poll/runs-parse.ts     # CHANGED: snapshot validation, fail closed (003's module)
└── main.js                # REBUILT + committed (invariant 1)

tests/                     # offline: fake host, loopback service on temp dirs, fixture GitHub
├── prompt-validation.test.ts     prompt-audit.test.ts
├── prompt-composition.test.ts    prompt-upgrade.test.ts
└── (extended) service-bindings.test.ts, service-events.test.ts, service-audit-read.test.ts,
    audit-vocabulary.test.ts, relay-integrity.test.ts, session.test.ts, runs.test.ts, bundle.test.ts

specs/003-dispatch-integrity/contracts/   # C12: additive pointer notes only (docs)
README.md · specs/002-agent-event-extension/quickstart.md · AGENTS.md   # N6: FR-062/FR-074 docs + module map
```

**Structure decision**: no new directories, no new dependencies, no new store file, no new route. The service-side prompt domain sits in one module beside the binding store it serves (and shares the fingerprint with the run parser); the observer gets its own module because it owns a chain and a baseline; panel-side 004 work is one shared-rules module plus narrow edits to the four modules that already own composition, relay, claim parsing, and row rendering — matching the one-responsibility-per-module map in `AGENTS.md`.

## Complexity tracking

**None.** The constitution check passed without violations, so there are no violations to justify.
