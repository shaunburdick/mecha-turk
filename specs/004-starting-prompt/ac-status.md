# Acceptance status: Per-Binding Starting Prompt (AC-130 – AC-145)

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.1.0 · **Recorded by**: T-016, the final gate
**Branch**: `003-dispatch-integrity` (004's Phase 6 runs here; feature 003 shipped on it first)

Every row below is **binary** and points at the automated, offline assertion that
proves it — fake host, real loopback service on temp directories, fixed stamps.
No row is marked met on an aspiration: if a criterion is met only in part, or
belongs to another feature, the status says so.

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-130** — prompt leads the message; frame follows; `data` carries presence + fingerprint and no copy of the text | **Met** | `tests/relay-integrity.test.ts` "carries the text exactly once — inside the message — and nowhere else" (text leads the frame, one occurrence in the serialized `startSession` request, `data` carries the three scalars and no text); `tests/prompt-composition.test.ts` "fences the operator text, then a blank line, then the frame — in that order" and "adds the three scalars to `data` and never the text" |
| **AC-131** — no prompt ⇒ byte-identical message, no fence, no placeholder; stored `null` identical; stored number/boolean/object/array refused with a field-level remediation and never coerced | **Met** | `tests/prompt-composition.test.ts` "returns the frame untouched when the prompt is unset or null" against a golden literal; `tests/relay-integrity.test.ts` "composes a prompt-less dispatch byte-identically to the pre-004 frame"; `tests/prompt-upgrade.test.ts` "composes the seeded prompt-less run byte-identically to the shipped frame"; `tests/service-bindings.test.ts` "quarantines a stored non-text prompt, logging the reason and yielding no bindings" (42 / true / `{}` / `[]`) |
| **AC-132** — empty and whitespace-only clear; at the cap accepted; one over refused naming field + cap; submitted text in no refusal, log, or audit row | **Met** | `tests/prompt-validation.test.ts` "reads an empty or whitespace-only value as unset", "accepts exactly the cap and refuses one code point over it", the refusal matrix with a sentinel scanned out of every remediation; `tests/service-bindings.test.ts` "clears exactly the binding an explicit empty value names" and "refuses an invalid prompt with no write, no row, and the previous prompt in force" |
| **AC-133** — a credential-shaped prompt is refused at save naming the shape and not the value; the previous prompt stays in force; the whole submission is unapplied; a scan finds 0 occurrences of the rejected value | **Met** | `tests/service-bindings.test.ts` "refuses a credential-shaped prompt at the write boundary, storing nothing" and "reports a bad prompt and a bad repository in one 422"; `tests/bundle.test.ts` "holds an accepted prompt in exactly two places and a refused value in none" (eleven surfaces + the refusal body) |
| **AC-134** — reserved marker refused naming the family; frame-imitating lines delivered verbatim and changing no frame line; delivered text byte-identical to the stored value after trim + normalisation | **Met** | `tests/prompt-validation.test.ts` "refuses each reserved marker prefix, naming the family and not the line", "accepts prose that merely resembles a marker", "normalises line endings and trims the ends on save"; `tests/prompt-composition.test.ts` "carries frame-imitating operator lines verbatim and changes no frame line" |
| **AC-135** — a prompt naming an agent reaches the session verbatim; the observed agent is the pinned Default Agent; the run row reports it; no agent/model/variant field is sent per call; the panel still cannot read or change the pin | **Met** | Verbatim + no content rule: `tests/prompt-validation.test.ts` "applies no content rule beyond the four refusals". No per-call selector: `tests/prompt-composition.test.ts` "sends no agent, model, or variant member per call" (request and `data`). Observed agent and the warn-only read-back: 003's unchanged `tests/agent-verify.test.ts`. The pin stays unreadable: 003's unchanged `tests/prerequisites.test.ts` (`not-checkable`) |
| **AC-136** — the untrusted region stays delimited, bounded, and visibly marked; the request carries no credential; no policy, gate, or tool scope changes; the cycle shows no GitHub write | **Met** | `tests/prompt-composition.test.ts` "shortens the excerpt, never the prompt, and stays inside the host cap"; `tests/session.test.ts` (003, unchanged) hostile-source and budget tests; `tests/bundle.test.ts` "every 004 module" is outside the GitHub gateways, both bundles scan clean for tokens and HTML sinks, and the full-cycle surfaces scan `findSecretLeak`-clean |
| **AC-137** — two bindings keep their own prompts; a whole-file write omitting the field preserves both; an explicit empty clears exactly the one it names; a hand edit is recorded with the actor that made it | **Met** | `tests/service-bindings.test.ts` "preserves every stored prompt on a panel-shaped whole-file save", "clears exactly the binding an explicit empty value names", "records an out-of-panel edit once with actor service, and a racing PUT adds nothing" |
| **AC-138** — editing a prompt leaves a waiting dispatch's text and fingerprint unchanged; the next dispatch uses the new text; both appear on their own runs; a retry composes a byte-identical message from the same snapshot | **Met** | `tests/prompt-snapshot.test.ts` "keeps a queued run on the text it was queued with after an edit" and "never lets a coalescing delivery replace the run's own snapshot"; `tests/prompt-upgrade.test.ts` "keeps a queued run on its snapshot after the binding's prompt is edited" (compose after the edit still yields the queued text and never the new one) |
| **AC-139** — every row that records what was sent carries binding id + fingerprint; no row anywhere holds the text; the projection shows presence, fingerprint, and length; each prompt change writes exactly one row | **Met** | `tests/audit-vocabulary.test.ts` "the two rows that record what was sent carry the prompt reference"; `tests/prompt-claim.test.ts` "names the binding and the fingerprint on both rows, under the run's id" and "projects presence, fingerprint, and length — and no text"; `tests/prompt-audit.test.ts` "appends exactly one row per difference" and "set, changed, and cleared with chained previous fingerprints" (SC-125) |
| **AC-140** — the same text fingerprints identically across restart, two module instances, and two machines; reproducible from the text alone; message boundaries determined structurally | **Met** | `tests/prompt-validation.test.ts` "is identical across a fresh module instance", "is identical for the same text stored in two different temp stores", "fingerprints the normalised text, so CRLF and LF pastes agree"; `tests/prompt-audit.test.ts` "re-seeds from the rows just written and chains previousFingerprint"; `tests/prompt-composition.test.ts` fence/structure assertions |
| **AC-141** — a stored bindings file whose prompt violates the rules is quarantined and logged with the reason, scanning stops, no file is rewritten, no binding is dropped | **Met** | `tests/service-bindings.test.ts` "quarantines a stored non-text prompt, logging the reason and yielding no bindings" (reason is `startingPrompt: <remediation>`, exactly one `.corrupt-` file, `[]` bindings) |
| **AC-142** — upgrading needs no migration: everything parses and renders, queued records dispatch with their text, 0 quarantines, 0 scan-window resets, delivery ids / run keys / correlation ids unchanged | **Met** | `tests/prompt-upgrade.test.ts` "boots the pre-004 store with no quarantine, no window reset, and no rewrite" plus the SC-121 composition; `tests/prompt-snapshot.test.ts` "parses a row written before this feature, with no prompt member" and "adds no field to the delivery rows: the bytes are the pre-004 bytes" |
| **AC-143** — the existing secret-scan suites pass unchanged; new assertions cover the binding store, the snapshot, the projection, the audit rows, and every rendered surface and find 0 credential occurrences; a refused save leaves no trace | **Met** | Existing suites unchanged and green (1134 / 69 files at the gate); `tests/bundle.test.ts` full-cycle containment over bindings store, `runs.json`, `events.json`, `audit.ndjson`, ledger, `host.storage`, service logs, status copy, and both bundles; `tests/prompt-audit.test.ts` "carries no credential-shaped string in the rows it writes"; `tests/prompt-validation.test.ts` "refuses exactly the shapes the shipped detector recognises — and no others" |
| **AC-144** — no editor, preview, or display surface for the prompt exists; `host.storage` holds no copy | **Met for 004's half** | `tests/bundle.test.ts` "carries the binding field exactly where 005 renders it" (the bundle names the member only for the one field 005 ships — the older *never names the member* rule was re-cut by 005 T-009, and its rendered-surface half now lives in `tests/bindings-prompt.test.ts`, which counts exactly one element carrying the prompt and fails at 0 and at 2 alike) and the containment scan of `host.storage`; the documentation test proves both operator pages promise **no** editor. **The rendering clauses of AC-144 — the Bindings tab's one field carrying FR-063's guidance and FR-064's "not set" state — belong to 005** (FR-060 binds whichever surface renders, and 004's own v1.1.0 amendment places the field there); 004 ships no surface to render them, which is what the first half of this AC asserts |
| **AC-145** — zero additional round trips per dispatch; the composed message never exceeds the per-dispatch bound; where prompt and excerpt together would exceed it, the excerpt is shortened with a visible marker and the prompt appears in full | **Met** | `tests/relay-integrity.test.ts` "adds no round trip: still claim, reserve, startSession (+0, NFR-120)" (latency is asserted as round-trip count per SC-127/NFR-120 — an offline suite measures no wall clock); `tests/prompt-composition.test.ts` "shortens the excerpt, never the prompt, and stays inside the host cap" (prompt block reserved at 2,078 chars, total ≤ `CONTEXT_MAX_CHARS` and < `GUEST_ATTACH_TEXT_MAX`, `… [truncated]` marker present) |

## Gate

- `npm run verify` green at T-016: build → lint → typecheck → test.
- `panel/main.js` and `service/main.js` rebuilt and committed with the wave that changed their sources (AGENTS invariant 1).
- `SERVICE_VERSION` still mirrors `package.json` `0.0.1` (pinned by `tests/service-server.test.ts`); `capabilities[]` still `["sessions","prompt"]` (pinned by `tests/manifest.test.ts`); `SERVICE_SCHEMA_VERSION` still `1`.
- Zero lint suppressions and zero `any` in any 004 module (`tests/bundle.test.ts`, T-014).
- No `version`, `SERVICE_VERSION`, evidence-schema, or SDK-pin change anywhere in the feature.

## Interpretations recorded rather than narrowed

1. **AC-144's rendering clauses are 005's.** The criterion mixes 004's assertion
   (no surface, no copy in `host.storage`) with 005's (the one field, its
   guidance, its "not set" state). 004 asserts the first half and defers the
   second by its own FR-060/FR-063/FR-064; `tasks.md`'s AC→task table reads
   AC-144 the same way.
2. **AC-145's p95 is measured as round trips, not milliseconds.** SC-127 and
   NFR-120 define the property as "0 additional round trips per dispatch",
   which is deterministic and offline-testable; a wall-clock p95 is not
   measurable in a suite forbidden to sleep or use the network.
3. **The composition lives in `src/prompt.ts`, not `src/session.ts`.**
   `composeFirstMessage` and `promptBlockChars` sit beside the fence constants
   they emit, because `src/session.ts` was already at the repository's
   500-line gate; `buildBoundedContext` and `buildStartSessionRequest` — the
   budget reservation and the `data` scalars — remain in `src/session.ts`
   exactly as T-010 specifies.
4. **The claim DTO grew three modules, not one.** The 500-line gate forced the
   prompt wire readers (`src/prompt-wire.ts`), the bounded excerpt renderer
   (`src/context-blocks.ts`), and the eight-state vocabulary
   (`src/run-state.ts`) out of their neighbours; the behaviours T-009/T-010
   name are unchanged and their tests still import the documented entry points.
5. **The panel-side claim DTO is `src/claim-service.ts`, not
   `src/repos-service.ts`.** 003 moved it there; `tasks.md`'s standing rule is
   that a task naming a predecessor's module means it *as 003 ships it*.


## Amendment note — 2026-10-01 (acceptance evidence consolidated; spec v1.2.0)

The mappings above are the record of *what proved what* when this feature was
accepted. The suite behind them was consolidated on 2026-10-01 by product-owner
order for change efficiency: **1441 tests → 532**, across the same 101 files.

Nothing above stops being true — every criterion still has a proof — but a
criterion may now be discharged by a **representative or table-driven case**
rather than by a dedicated `it()`, and exact-wording pins were dropped where
the wording is not itself a requirement. Where a row cites a per-string
assertion, read it as citing the *behaviour* the string carried.

**Functional requirements, security rules, and AGENTS.md's invariants are
untouched.** The three security-floor proof files (`crash-permutations`,
`dispatch-end-to-end`, `redaction`) were excluded from the consolidation.
