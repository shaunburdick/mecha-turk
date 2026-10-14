# Implementation Plan: engine-primary follow-up delivery (service→OpenCode queue, B+ fallback)

**Branch**: `008-follow-up-delivery` (PR #50, open — carries the shipped B+ implementation and 002 v1.18.0) | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md) (Gate 1 passed, decision-closed 2026-10-14)

**Input**: Feature specification from `/specs/009-engine-delivery/spec.md` — the decision-closed amendment to `specs/002-agent-event-extension/spec.md` (v1.18.0 → **v1.19.0**). Supporting records: [research.md](research.md) (live-verified engine API facts), [challenge-ledger.md](challenge-ledger.md) (all dispositions, incl. the four unfixed round-3 Lows carried in Wave 4). Issue #48 follow-on, product-owner decisions 2026-10-14.

**Gate status**: this file plus [tasks.md](tasks.md) is the **unapproved Phase-4/5 handoff**. Gate 2 and user approval come before any implementation commit; nothing is committed with these documents.

## Summary

Delivery becomes **engine-primary**: the always-on service discovers the operator's OpenCode engine, verifies its identity, pre-checks session ownership, and admits each detected follow-up into the engine's own queue with `POST /api/session/{sessionId}/prompt`, body `{"prompt": {"text": …}, "delivery": "queue"}` — one autonomous act at detection time, regardless of the session's turn state, with the admission's message `id` (`msg_…`) persisted as the at-most-once receipt (intent → POST → receipt). **`steer` is never used**; the service never creates, joins, or deletes a session (invariant 10). **B+ (008's shipped park + auto-rearm) is retained unmodified as the fallback**: it is demoted, not rewritten — its trigger conditions change (the panel attempts when the projected member is **absent** — v1.18.0 behaviour unchanged — when it positively says `engine-unavailable`, or through the operator's re-offer; a member **present and not `unavailable`** is zero prompts, per the Gate 2 H2 ruling on span C/AC-050), but its waiting/re-arm/every-prompt-re-verification mechanics stand as v1.18.0 shipped them.

The service records its own deliveries on the queue row the follow-up event already owns — an absentable `engine` member `{ state: 'admitted' | 'unavailable' | 'unknown', messageId?, intentAtMs?, cause? }`, single-writer service (one of the two unavoidable persisted additions, §2.4) — and projects it additively onto the follow-up row of the existing `GET /v1/events` read as `{ state: 'queued' | 'unavailable' | 'unknown', messageId? }`. The second persisted addition is `SessionRef.directory`, the dispatch-reported session directory (Gate 2 H1): store-internal, read by the engine pre-check from the service's own run record, carried on **no** wire surface beyond the result body that already posts it. Exactly one reason word joins the closed union — `engine-queued`, the product owner's 2026-10-14 decision (§7 Q1) — rendered from the projection member's `queued` branch, whose only writer is that member. Failure classification is closed: connection-refused is the engine path's one retryable class (same ladder, same knobs); timeout/5xx/crash-between-intent-and-receipt enter `unknown` at once and are never auto-retried or auto-resent; `401`, discovery/pid/version/ownership/token failures mark `engine-unavailable` with no ladder rung and hand the delivery to the fallback permanently; the engine's `404` parks `no-session` on the first refusal (routing pin, below). The panel advances `followUpsFrom` past panel-delivered **and** engine-admitted rows and never past `unavailable`/`unknown` by projection alone (span B2); the service prunes nothing on any path (span B).

The delivered package also contains the **conforming in-place edits**: FR-104 across four spans (A, B, B2, C) and FR-105 across three (D, E, F), both ACs, the eighteen byte-exact companions (§3, incl. the two 005 contract rows and the quickstart walkthrough line), the 002 header/status flip to v1.19.0, one changelog entry, and the unfixed Gate-1-round-3 Lows as explicit checklist items. The pre-existing stale `events-carry-forward.md:147` note is **deferred, not carried** (Gate 2 Cut 2): pre-existing drift, false since v1.18.0, rides a future docs wave — recorded in the skipped/deferred list below rather than in this wave's tasks.

**PR #50 note**: the branch's existing B+ code is the **fallback layer being retained**, not rewritten. These waves **add** the engine path (service side) and **demote** B+'s trigger conditions (panel side); no B+ mechanic is deleted (§9).

Requirement count is unchanged: zero FRs, ACs, run states, configuration fields, capabilities, or storage keys are added; exactly one reason word (`engine-queued`) joins by product-owner decision, and the **two** persisted additions — the §2.4 `engine` member and `SessionRef.directory` (Gate 2 H1) — are stated as unavoidable (§2.4 records the first; the second is the dispatch-reported directory the pre-check reads).

## Technical Context

**Language/Version**: TypeScript (strict), Node >= 24.15 toolchain; shipped `service/main.js` keeps the Node-20-era API surface — the engine client therefore uses only global `fetch`, `node:` stdlib (`fs`, `path`, `os` for the `/proc` chain), and nothing else. **No new dependency** (std-lib only, per the amendment).

**Primary Dependencies**: `@openchamber/sdk` pinned exactly at 2.3.1 — **unchanged, and not involved in the engine path**: the service talks to OpenCode's published HTTP API directly (research.md §2), not through the SDK; the panel keeps its existing host surface (invariant 3 — `sessions` and `prompt` only; `host.request()` still has no caller). Vitest for the offline suite. The site is Astro with its own gate (root `verify` does not reach it).

**Engine API (live-verified, research.md §2)**: admission `POST /api/session/{id}/prompt` with `delivery: "queue"` answers 200 even on a running session and returns the receipt as `data.id` (`msg_…`); discovery via `~/.config/openchamber/managed-opencode/<pid>.json` (per-boot port — **re-discovered every attempt**), Basic auth `opencode:$OPENCODE_SERVER_PASSWORD`; identity `GET /api/info` → `{ version, pid }` (pid cross-checks the registry); ownership pre-check `GET /api/session/{id}` → `location.directory` + `metadata.openchamber` (observed live 2026-10-14). **No client-supplied idempotency key exists** (checked, negative — research §2.7), which is why the unknown-state rule is the at-most-once guarantee for ambiguous failures. SSE is observability prose only; the fake ships **no SSE writer** unless a test needs one (Cut 2).

**Storage**: the service store (`~/.config/openchamber/mecha-turk/`, 0700/0600). The follow-up's queue row in `events.json` gains one absentable `engine` member — a **store-internal change to an existing record** (FR-107 as amended), schema-versioned with the store it rides in: `SERVICE_SCHEMA_VERSION` stays 1, no new file, and the member is absentable so a pre-amendment row parses byte-identically (the parser reads named fields and ignores extras, so the downgrade direction is also the safe one). **The dispatch result gains one additive `directory` member** (Gate 2 H1): the panel records it from `host.startSession()`'s own result — `worktree.directory` when the result carries one, else `result.directory` — and hands it in the result body it already POSTs; the service persists it on the run's session ref (`sessionRefOf` — both call sites: the dispatch-result report, and the operator-confirm path in `service/poll/run-operate.ts:388`, which has no result body and therefore persists **absent**, the intended fail-safe case), and reads it **from its own store run** (`run.session.directory`) where the engine pre-check needs it — **nothing on `GET /v1/events` carries it** (Gate 2 HIGH B: the fourth wire surface is cut; the two wire additions the amendment names hold exactly as amended). `parseSession` (`service/poll/runs-parts-parse.ts:215-246`) is extended with it fail-closed: absent → absent; a malformed value → **treated as absent** (fail-safe, matching the absent-byte-identical convention) rather than quarantining the run document. Absent — a pre-amendment dispatch or a host that reported none — the pre-check fails safe to `engine-unavailable` (fallback). The Gate-1 handback amended the spec's wire-claims in parallel; the byte-exact span A / FR-107 text is re-extracted at conforming-edit time (routine wave-4 discipline). **`OPENCODE_SERVER_PASSWORD` is never persisted** (invariant 9, spec §6): it is read **per attempt** from the layered chain (env → registry file + `/proc/<pid>/environ`, pid-alive and ownerPid-verified) and never written to any file, log, ledger, audit row, panel storage, or bundle. Panel host storage (`mecha-turk:dispatches`) gains **no field** — its record stays the sole at-most-once authority for the fallback path (§2.4).

**Testing**: `npm test` (vitest, fully offline) against a new **fake OpenCode stdlib server** (`tests/support/`) plus the existing fake host and fake service; injectable token source and `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` override for discovery/token seams (research §4). No live engine, OpenChamber, PAT, or network anywhere in the suite; live confirmation is operator-gated and already recorded (research §1–§2).

**Target Platform**: OpenChamber extension panel plus the OpenChamber-hosted local service; committed bundles `panel/main.js` (IIFE) + `service/main.js` (ESM) ship as-is from git (invariant 1). Lockstep packaging holds per AGENTS.md invariants 1–2, so no cross-version skew matrix is owed (research §5 L3).

**Constraints**: no new HTTP route, operation, path, method, status code, or error code on `/v1` — the engine-delivery member rides the existing `GET /v1/events` read additively in `followUpsFrom`'s shape, and the dispatch-result `directory` member is additive on the existing result body (the wire claim is exactly the amendment's **three surface additions** — `followUpsFrom` (v1.18.0), the engine-delivery member (v1.19.0) on this read, the dispatch-result directory (v1.19.0) on the body; `SessionRef.directory` is store-internal and projects onto nothing — Gate 2 HIGH B); no new capability, configuration field, `host.storage` key, run state, or UI affordance; no `steer`; no production session create/delete; zero lint suppressions and zero `any`; committed bundles ship with their source in the same commit; the `package.json` version does not move (releases are the product owner's call).

**Scale/Scope**: one new service subsystem (`service/engine/` — discovery, token, client/info, session pre-check, prompt admission), two new service poll modules (composition, delivery pass), six service files extended (`events-parse.ts`, `events.ts` chain, `runs-parts-parse.ts` for `parseSession`'s `directory`, the dispatch-result route/report path incl. both `sessionRefOf` call sites), six panel files extended (`dispatches-detail.ts`, `dispatches-service.ts`, `dispatch-record.ts`, `follow-up.ts`, `relay.ts`, `relay-attempt.ts` — the last carrying the `directory` report), one new test-support server, seven test suites new/extended, eighteen companions plus four spans and two ACs rewritten in 002's `spec.md`, one changelog entry, two 005 contract rows, one quickstart line, three site spans.

## Constitution Check

*GATE: passed for Gate 1 (spec §6) and re-checked here against the implementation shape.*

- **I (polling-first, contract-first)**: the engine path is a documented, live-verified provider contract (research §2); detection and GitHub polling are untouched.
- **II (safe autonomy)**: both paths stay autonomous like `start_work`; a permission/form stall after admission is visible waiting and **nothing is ever auto-approved** (AC-050 asserts zero approve/resolve calls); the unknown outcome errs to a missing follow-up, never an unattended duplicate; token/authorization ambiguity is fallback, never a guess.
- **III (durable and idempotent)**: at-most-once per path with a permanent one-way handoff (§5) — intent-before-send, receipt-after, restart reconciliation leaves intent-without-receipt `unknown` with zero automatic re-POSTs; the deterministic delivery id still dedupes detection (NFR-002 unchanged).
- **IV (human-visible auditability)**: the run row states the mode (`engine-queued` / `session-busy` / `unconfirmed` note); receipts, marks, and causes are explainable from the projected row and the service's audit rows; the engine-composed message carries the same "Mecha Turk follow-up (automated…)" attribution header, FR-028 delimiters, and correlation id the panel composed (asserted in AC-050); the engine password appears nowhere an operator reads.
- **V (minimal, self-hosted)**: no packaging, deployment, or control-plane change — the engine is the host's own loopback service.
- **VI (specification before implementation)**: every behavioural assertion runs offline against the fake; the conforming spec edits land with the code they describe (same delivery).
- **VII (thin orchestration boundary)** — owner-confirmed strongest reading (§7 Q5): the **engine's own queue** is the harness's scheduling; admitting a message there is dispatch, not a guest-side queue. Mecha Turk persists a receipt, not a pending send; the fallback composes at attempt time.
- **Network-clause exception (owner-confirmed, §7 Q5 / spec §6)**: outbound **loopback HTTP with Basic auth** to the host's own engine, discovered from the operator's config tree, authenticated with the operator's own password — no traffic leaves the operator's controlled surface; stated with rationale in the changelog entry, not a constitutional amendment.
- **Invariants**: **1** (bundles rebuilt+committed with source at each source-touching wave close), **3** (no capability changes; the panel makes no engine call — the service does, outside the host permission system exactly as GitHub polling), **4** (kebab-case identity untouched; no storage key changes), **9** (the password is a new secret: per-attempt layered read, never persisted; redaction and secret-scan suites extended **by name**), **10** (evidence schema and NDJSON event contract untouched; the engine path only ever POSTs `/prompt` to existing ids).

**No violations**, so the Complexity Tracking table stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/009-engine-delivery/
├── spec.md              # Gate 1 passed, decision-closed (input; not edited by this phase)
├── research.md          # live-verified engine facts (input)
├── challenge-ledger.md  # Gate 1 record incl. the four unfixed Lows (input)
├── plan.md              # this file
└── tasks.md             # Phase 5 output (same handoff)

specs/002-agent-event-extension/   # conforming-edit target (v1.18.0 → v1.19.0)
├── spec.md             # FR-104 (spans A/B/B2/C), FR-105 (spans D/E/F), AC-050/AC-051 + eighteen companions + header
├── quickstart.md       # §10's delivery sentence (companion 16; 76-line pin)
└── changelog.md        # one v1.19.0 entry (003/008's amendment pattern)
    # contracts/events-carry-forward.md:147 — DEFERRED (Gate 2 Cut 2; future docs wave)

specs/005-panel-ia/contracts/dispatch-list.md  # companions 17–18 (005's read contract)
site/src/pages/use.astro                        # companion 9's three spans (FR-042 doc-drift gate)
```

### Source Code (repository root)

```text
service/engine/                # NEW subsystem — stdlib-only OpenCode client
├── discovery.ts               # EXTEND-NEW: managed-opencode registry read, pid-alive + ownerPid
│                               #   verification, per-attempt re-discovery, connect-failure
│                               #   invalidation; OPENCHAMBER_MANAGED_PROCESS_REGISTRY seam (FR-104 A)
├── token.ts                   # layered acquisition: env OPENCODE_SERVER_PASSWORD → registry +
│                               #   /proc/<pid>/environ; injectable seam; never persisted (FR-105 D; inv. 9)
├── client.ts + info.ts        # fetch wrapper (Basic auth, bounded timeout) + GET /api/info identity
│                               #   probe: version pin [2.0.29, 3.0.0) + pid cross-check, fail-safe
├── session.ts                 # ownership pre-check GET /api/session/{id}: location.directory exact-match
│                               #   (normalized) against the dispatch-reported session directory (pin 2)
│                               #   AND metadata.openchamber present; absent directory fails safe (FR-104 A)
└── prompt.ts                  # POST …/prompt delivery:"queue" ONLY; zero steer; receipt = data.id;
                                #   failure classification incl. 200-without-receipt → unknown
                                #   (FR-104 A; FR-105 D/E; §9)

service/routes/ + service/poll/
├── dispatch.ts, dispatch-report.ts, run-chain.ts   # EXTEND (Gate 2 H1): the result body's additive
│                               #   `directory` member — read fail-closed (absent stays absent, never
│                               #   guessed), persisted on the run's session ref by `sessionRefOf`
│                               #   (both call sites: this report, and run-operate.ts:388's
│                               #   operator-confirm path — no result body → persists absent, the
│                               #   intended fail-safe case)
├── runs-parts-parse.ts         # EXTEND (Gate 2 HIGH A): `parseSession` (:215-246) reads `directory`
│                               #   fail-closed — absent → absent; malformed → absent (fail-safe) —
│                               #   so a runs.json re-read cannot silently drop the persisted member
├── engine-compose.ts          # NEW: service-side follow-up message under FR-028 bounds/delimiters/
│                               #   preamble/correlation id, sharing src/session.ts's renderer; measured
│                               #   before any engine call, refused rather than truncated (FR-104 A)
├── engine-delivery.ts         # NEW: per-cycle pass — rows with absent engine member + a dispatched run
│                               #   session; intent → POST → receipt; ladder on connection-refused only;
│                               #   marks; restart reconciliation; credential-free audit rows (FR-104 C,
│                               #   FR-105 D/E, §5)
├── engine-state.ts            # NEW: single-writer engine-member writes on the queue chain (same slot
│                               #   the enqueue/trim use); never prunes a row on any path (§2.4, span B)
├── events-parse.ts            # EXTEND: absentable `engine` member on QueuedEvent, fail-closed parse
│                               #   (`unavailable` carries no cause — H3)
├── events.ts                  # chain re-export for engine-state (inQueueChain), no enqueue change
└── run-history-project.ts     # EXTEND: absentable engine member on HistoryFollowUp, sourced from the
                                #   queue row (§2.4; FR-107 row-shape addition); `HistorySession`
                                #   unchanged — `directory` is store-internal (Gate 2 HIGH B)

src/
├── dispatches-detail.ts       # EXTEND: RunFollowUp engine member type; reason-map label line
│                               #   `engine-queued`; reofferableFollowUps widens to parked AND unknown
├── dispatches-service.ts      # EXTEND: fail-closed parse of the projection member (unreadable page →
│                               #   last-good-view discipline → no attempt)
├── dispatch-record.ts         # EXTEND: FollowUpFailure union + runtime set gain `engine-queued`
│                               #   (vocabulary closure; no panel write produces it)
├── follow-up.ts               # EXTEND: fallback gate (absent → v1.18.0; positive `unavailable`
│                               #   mark → auto-attempt; present-not-unavailable → zero prompts;
│                               #   unknown → display-only), window advance past panel-delivered AND
│                               #   engine-admitted (span B2), waiting-constant neighbourhood comment
├── relay.ts                   # EXTEND: deliverOneFollowUp's candidate filter honours the member
└── relay-attempt.ts           # EXTEND (Gate 2 H1/Medium C): the dispatch result body reports the
                                #   session's directory — `worktree.directory` when the startSession
                                #   result carries one, else `result.directory` — absent when neither
                                #   (never guessed)

tests/
├── support/opencode-engine.ts # NEW: fake OpenCode stdlib server (info/session/prompt canned:
│                               #   admit/stall/5xx/401/404/malformed-200), request + message log,
│                               #   fixture registry files, token double; no SSE writer (research §2.4)
├── support/panel.ts           # EXTEND (008's fake host): projection-member fixtures for the row reads
│                               #   + the dispatch-result `directory` report fixture (Gate 2 H1)
├── engine-client.test.ts      # NEW: discovery/token/info/pre-check/prompt against the fake (incl.
│                               #   dispatch-reported directory matching; absent directory fails safe)
├── engine-delivery.test.ts    # NEW: the pass — admission, ladder (incl. the four no-rung classes),
│                               #   marks, unknown (incl. malformed-200), reconciliation, and the
│                               #   invariant-10 request-log assertion (only the named GETs + /prompt)
├── engine-pre-mortem.test.ts  # NEW (Gate 2 mandated): table-driven end-to-end — one row per distinct
│                               #   final-word outcome asserting the FINAL operator-visible word/state through
│                               #   service classification → projection → panel rendering
├── follow-up-lifecycle.test.ts, follow-up-reoffer.test.ts, relay-arming.test.ts  # UPDATE: gate,
│                               #   advance, eligibility, rendering; 008's shipped assertions are a
│                               #   must-pass-untouched block (line-pins named in tasks.md T025)
└── bundle.test.ts, redaction.test.ts  # EXTEND: OPENCODE_SERVER_PASSWORD by name (invariant 9)

panel/main.js, service/main.js    # rebuilt bundles, committed with their source (invariant 1)
```

**Supporting artifacts skipped, and why**: `data-model.md` — the amendment's §2.4 **is** the data-model record for the two members (spec of record; duplicating it invites drift), and no other persisted shape changes. `contracts/` — no interface consumed outside this repo is added or changed: the projection member is documented by the two 005 contract rows and the FR-107 rewrite the amendment already carries, and invariant 10's surfaces are untouched. `quickstart.md` (009's) — no new operator steps: the engine path is autonomous and the fallback keeps its documented idiom; 002's walkthrough gets its companion-16 rewrite instead. `research.md` already exists from Gate 1 and is the live-verified record.

**Deferred (Gate 2 Cut 2)**: `specs/002-agent-event-extension/contracts/events-carry-forward.md:147` — the pre-existing stale delivery description, false since v1.18.0 and independent of 009 — is **not** rewritten in this wave; it rides a future docs wave, recorded here so the drift is not lost.

## Key Decisions (plan-phase pins; chosen over the alternative each was made from)

1. **Version pin: `>= 2.0.29 < 3.0.0`** against `GET /api/info`'s `version`. The floor is the live-verified point (research §1 — the adapter must never claim a surface below the one that was proven); the ceiling is the exclusive major, because a major bump is exactly when route shapes change and everything beyond 2.x is unverified. Outside the range the adapter **fails safe** — `engine-unavailable`, fallback, never a hard stop (FR-105 span D). *Alternative*: open-ended floor (`>= 2.0.0`) — rejected: nothing verifies the pre-2.0.29 surface, and research §5 pins the range "against the API surface the adapter actually uses". The pin is one exported constant beside the probe, so re-pinning is one deliberate edit (constitution VI).
2. **Directory-match rule: exact equality, normalized — against the dispatch-reported session directory** (Gate 2 H1). The pre-check compares the engine session's `location.directory` to the directory the **dispatch itself reported**: the panel records it from `host.startSession()`'s result — **`worktree.directory` when the result carries one, else `result.directory`** (the Gate-1 handback's span A carries the same rule) — and hands it to the service in the dispatch result body, which gains one **additive `directory` member**; the service persists it on the run's session ref and reads it **from its own store run** (`run.session.directory`) — store-internal, on no wire surface (Gate 2 HIGH B); `parseSession` reads it fail-closed or a restart silently loses it (Gate 2 HIGH A, T012). Comparison trims trailing separators; no prefix rule, no `realpath`/symlink resolution. **Absent — a pre-amendment dispatch, the operator-confirm path (`run-operate.ts:388`, no result body), or a host that reported none — fails safe**: the pre-check refuses, the row marks `engine-unavailable`, the fallback takes it; a nested directory, a symlinked path, or any foreign value fails the same way. The handback amended the spec's wire-claims in parallel; the byte-exact span A text is re-extracted at conforming-edit time (routine wave-4 discipline), and this pin's wording matches it. *Alternative*: prefix match — rejected: over a shared data directory a prefix rule can accept a foreign session living under a subdirectory of the run's checkout, which is the misdelivery span A exists to prevent; research §5 records that symlinked/nested comparisons are unexercised, and the safe direction of an over-strict rule is the fallback, not a duplicate or a misdelivery.
3. **Ladder bound: reuse the existing knobs, unchanged.** The engine's connection-refused class runs under the service's own `retryMaxAttempts` / `retryBaseMs` / `retryMaxMs` — read once per cycle through `readCycleConfig` (the same values the GitHub pace and the panel's fallback reader already use), doubling and capped exactly as `followUpBackoffMs` does. **No new configuration field** (FR-107). Exhaustion marks `engine-unavailable` — never parks (FR-105 span D). *Alternative*: a separate engine retry bound — rejected: 002's follow-up-retry-bound rule is one ladder with one meaning, and a second spelling is a second thing to keep in agreement (the panel reader's own doc comment says so).
4. **Engine `404` routing (derived pin, Gate 2 H3 ratified).** Span D's closed cause list omits the `404`, and span E parks it `no-session` on the first refusal — while §2.4's projection member is deliberately three-valued and the reason-word union's single-writer rule bars the service from writing panel words. Resolution: the service marks the delivery `unavailable` consuming **no ladder rung** — the store write is **`{ state: 'unavailable' }` only, with no `cause`** (§2.4's iff holds: `cause` is present iff the state is `unknown`), and the 404's evidence lives in the pass's credential-free audit row — and the `no-session` word reaches the run row through the fallback's own first-refusal park: the panel auto-attempts the `unavailable` row, the host refuses `NO_SESSION`, the panel parks `no-session` with its own record. Neither party writes the other's record, the member stays three-valued, and "parks on the first refusal, consuming no ladder attempt" holds on both sides (AC-051). *Alternative*: a fourth projection state — rejected: §2.4 closed the member at three.
5. **The intent write is `unknown`-shaped.** Before the admission POST the service persists `{ state: 'unknown', intentAtMs, cause: 'intent' }` on the queue row; a 200 replaces it with `{ state: 'admitted', messageId }`, a timeout/5xx leaves `unknown` with its cause, a connection-refused retry re-POSTs (non-delivery proven) and exhaustion replaces it with `{ state: 'unavailable' }` (no `cause` — pin 4). A crash between intent and receipt therefore lands in exactly the state span E names, with no reconciliation scan needed to invent one — the pass's boot entry only re-reads rows already `unknown` and leaves them (zero automatic re-POSTs, ever). *Alternative*: a separate `pending` state — rejected: §2.4 closed the enum at three, and while an attempt is in flight the delivery's outcome genuinely **is** unknown, so `unknown` is the honest label, not a compromise.
6. **Attempt scheduling: one engine-delivery pass per poll cycle**, after the enqueue phase, over the run-linked follow-up rows whose `engine` member is absent (discovery, token, probe, and pre-check are re-run **per attempt**, per the per-boot port rule — research §2.6). *Alternative*: an event-driven immediate pass at enqueue — rejected: it would need a second timer or a second loop beside the scan cycle, and NFR-001's detection→admission bar is 2× the poll interval, which the cycle pass meets by construction.
7. **The panel's gate reads the member, not a record** (span C's rule, per the Gate 2 H2 ruling resolving the span-C/AC-050 tension — PM-ratified): the panel attempts a follow-up when the projected member is **absent** — a pre-amendment service means today's v1.18.0 behaviour unchanged, current-and-idle prompting included — or when it positively says `engine-unavailable` (the fallback auto-attempt); a member **present and not `unavailable`** (`queued` or `unknown`) is **zero prompts**, zero ladder, nothing parked; a member the panel **cannot read** (service down, malformed page) means **no attempt at all** (fail-closed parse refuses the page, last-good-view discipline keeps the previous view); `unknown` is displayed and never auto-attempted, reachable only through the operator's re-offer of the existing **Re-offer parked follow-up** control (companion 9's eligibility span — same control, wider eligibility, no new affordance). AC-050's gate assertion is re-scoped to "member present and not `unavailable`" at conforming-edit time. *Alternative*: the panel inferring engine state from its own record — rejected: it would create the second writer §5 exists to avoid.
8. **`engine-queued` renders for the row's whole life; the delivered bucket stays panel-record-sourced** (§4): no Mecha Turk surface ever claims "delivered" for an engine-admitted row — `engine-queued` means *reached and engine-held*, so permanence is truthful, not queued-forever. `unknown` rows land in the **waiting** count carrying the rendered note **unconfirmed** (already in 003's delivery vocabulary — the six-word union stays intact; `unknown` is not a seventh word).
9. **Composition is shared, not duplicated.** The service's engine-path message uses the same `renderBoundedContext` / `defuseDelimiters` modules the panel composes with (`src/session.ts`, `src/context-blocks.ts` — the service already imports across `src/`, e.g. `src/ids.ts`, `src/redaction.ts`), under the follow-up's own header with the run's correlation id, measured before any engine call against the same budget floor. *Alternative*: a service-side reimplementation — rejected: two frame builders drift, and AC-050 asserts the engine payload carries the identical attribution header, delimiters, and correlation id.
10. **The store schema version does not move.** `SERVICE_SCHEMA_VERSION` stays 1: the member is absentable, named-field parsing ignores extras, and lockstep packaging (invariants 1–2, research §5 L3) means no reader in the field parses a row the writer just added it to. §2.4's "schema-versioned with the store it rides in" is satisfied by riding the store's own version, not by minting one.

## Constraint honesty (the amendment's wire claim, verified)

Verified against the amendment's own FR-107 rewrite (§3.10) as the Gate-1 handback amended it: **the claim holds exactly** — the engine-delivery member and `followUpsFrom` are the read's two absentable additions, the dispatch-result `directory` member is additive on the existing result body, and **nothing else carries it** (Gate 2 HIGH B cut the run-row projection; `SessionRef.directory` is store-internal). The handback amended the spec's wire-claims in parallel; the conforming wave re-extracts the byte-exact text (routine wave-4 discipline). No new `/v1` route appears anywhere in this plan. Four caveats carried:

1. The engine-delivery member is **per-row inside `followUps`** (a member of `HistoryFollowUp`), not a new top-level row member; its absentness is per follow-up row, and a caller that omits nothing reads the read byte-identically. The `directory` member is per the result body only; its store-side persistence is pinned by the round-trip assertion in T012 (written → re-parsed → present; absent → absent; malformed → treated absent).
2. `specs/002-agent-event-extension/contracts/panel-service.md` describes the follow-up row's contents (lines 7, 89, 93) without an "and nothing else", so v1.19.0 makes those lists **incomplete rather than false**; the amendment names no companion for this file. Wave 4 re-reads it: only if a sentence is made *false* does the wave rewrite it under the contract-files convention; the decision is recorded either way. `tests/current-project-default.test.ts`'s `ROUTE_PATHS`/`CONTRACT_FILES` pins stay unmoved and will fail the gate if a route ever creeps in.
3. The store-internal claim is pinned by test: a row **without** the `engine` member parses byte-identically to today, a row with a **malformed** member is refused fail-closed, an `unavailable` member carries **no** `cause` (H3), and the extras-ignoring parser keeps the downgrade direction safe (research §5 L3). The `directory` member follows the **opposite** malformed rule by design — treated as absent (fail-safe) rather than quarantining the run document — pinned by the same T012 round-trip; absent, it is byte-identical to today's `parseSession` output.
4. The `events-carry-forward.md:147` rewrite the amendment flagged is **deferred** (Gate 2 Cut 2 — pre-existing drift, rides a future docs wave); it is recorded above rather than carried as a task.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.
