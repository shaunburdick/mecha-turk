# Tasks: Dispatch Integrity & Recovery (003)

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md), [contracts/](./contracts/) — all Phase-4 outputs; [spec.md](./spec.md) v1.3.0 is the source of truth (FR/AC numbers below are quoted as written).

**Bar**: the shipped loop keeps working while every route to a second session closes. Tests are offline and deterministic per `AGENTS.md`: fake host (`tests/support/panel.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub — **no live OpenChamber, no PAT, no network**. `[P]` = parallel-safe (different files, no dependency). **`npm run verify` runs at every wave boundary, and any wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt bundles committed in the same commit (invariant 1).**

## What's already built — do NOT re-touch

- **Service**: loopback server/auth/body-caps (`server.ts`, `http.ts`, `auth.ts`, `pipeline.ts`), consent, throttles, account custody + verify + rotate (`accounts/`, `routes/{accounts,verify,credential}.ts`), bindings (`bindings.ts`, `routes/bindings.ts`), polling/triggers/windows/rate budget (`poll/{poller-github,poller-entries,triggers,loop,timer}.ts`), store mechanics 0700/0600 + quarantine funnel (`store/*`), audit writer seq/redaction chain (`audit.ts` — 003 *calls* it, never rewrites it), config/health (`routes/{config,health}.ts`), **`routes/status.ts` polling block (005's)**.
- **Panel**: token handoff + consent + account mirror, bindings/repos UI (`repos*.ts`), evidence (`evidence.ts`), redaction guards (`redaction.ts`), ledger write path (`ledger.ts`), project resolution (`session.ts` `resolveProject`), the `openSession`/`onSession` verification *mechanic* (`agent-verify.ts`), lifecycle mount bookkeeping (`lifecycle.ts`), spike `startDispatch` path (`panel-dispatch.ts` — untouched legacy flow; the relay is 003's surface).
- **Invariants**: delivery id format (`buildEventId`), evidence schema `extension-spike-1`, manifest ids/capabilities, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` (`0.0.1` — **no bump in 003**), `SERVICE_SCHEMA_VERSION = 1`, the existing 563-test suite (stays green throughout).

## Out-of-scope guard (check before any task feels like "just one more")

No GitHub write of any kind (FR-002, AC-128). No `service/routes/status.ts` projection change (005). No runs-list interval cadence, no per-row action restructure, no rename of copy/modules/routes (005). No starting prompt (004). No settings CRUD UI (006) — only the two config *fields* the lease needs (T-008). No policy profiles, retention trimming, export/restore, dedupe-index eviction, webhook, multi-instance lease, work-completion tracking, automatic cleanup, or verification-to-blocking (003 `## Out of Scope`). `requeueBudget` is never a config field (003 v1.3.0 / 006 `## Deferred`).

---

## Wave 1 — Run model & migration (service foundation) — blocks every later wave

**Goal**: runs exist, deliveries link to them, legacy rows adopt without loss. Independent test: seed a shipped store, start the service against it, inspect `runs.json` + audit.

- [ ] **T-001** [P] [US1] Create the derivation module `service/poll/run-key.ts`: run key (`github|account|repo|subjectType|number|ordinal`), correlation id `mt-run-<sha256(runKey) hex[0:24]>`, dispatch token `dtk-<sha256(runKey|attempt) hex[0:32]>` (minted only when asked), attachment id = correlation id, subject key for the ordinal counter. Path-safe single segments, `GUEST_ATTACH_ID_MAX` ≤128. *Tests*: determinism (same key ⇒ same bytes), ordinal-sensitive keys differ, token differs per attempt, byte-format assertions; a token passes `assertRedacted` byte-identically while a PAT beside it still throws (research §R3).
- [ ] **T-002** [P] [US1] Create `service/poll/runs-parse.ts`: `RunsDocument` type + fail-closed validator (`schemaVersion`, `subjects` map, `runs[]`), `Run` row validator incl. `blocked:<reason>` prefix+suffix rule, nullable lease/reservation/session/verification, bounded attempts array. *Tests*: writer→reader round-trip on real bytes; every malformed shape quarantines-equivalent (returns null → caller refuses); all eight states parse; `blocked:` with empty reason refuses.
- [ ] **T-003** [US1] Create `service/poll/runs.ts`: run CRUD serialized onto the **existing `inQueueChain`** (queue + runs share one chain), `subjects` next-ordinal allocation, source-reference join with cap (`MAX_SOURCE_REFERENCES = 20` + truncation flag), attempt-history append, state transitions as named functions (`claimRun`, `reserveRun`, `applyResult`, `abandonRun`, `blockRun`, `retryRun`, `requeueRun`, `resolveRun`, `requeueExpiredRun`, `deadLetterRun`, `markUnconfirmed`). *Tests*: chain serialization (interleaved enqueue/claim/sweep never lost-update), ordinal continuity after terminal-run eviction, reference cap, one-live-lease/one-session invariants (FR-011, FR-013, NFR-107).
- [ ] **T-004** [US1] Evolve the delivery side `service/poll/events-parse.ts` + `events-write.ts`: new rows carry `runCorrelationId` + `subjectType` (captured from `isPullRequest` at detection), omit legacy lifecycle fields; legacy rows keep every byte; parser widens `state`/`claimedAt`/`dispatchedAt`/`dispatchResult` to absentable. **`buildEventId` unchanged** (FR-012, AC-104). *Tests*: old-shape and new-shape rows both parse; a pre-M7 row still parses; new row bytes contain no `state`; id bytes for fixture detections identical to the shipped format.
- [ ] **T-005** [US1] Create `service/poll/runs-adopt.ts`: the one-shot adoption pass (data-model §1 table) — invoked on first `runs.json` read when absent; projects each legacy row into a run (`pending`, `claimed`+already-expired synthetic lease, `starting` for the reservation branch, `dispatched`, `failed` per research §R2 classification), writes **one** `run.migrated` row per adopted run naming the branch, touches **no** `scan-state.json` and **no** legacy row. *Tests* (`tests/service-migration.test.ts` part 1): all five table rows; classification both ways; idempotent (second start adopts nothing, writes nothing); zero quarantine files; zero window resets; adoption recorded exactly once per run (FR-005, NFR-103).
- [ ] **T-006** [US1] Rewire enqueue coalescing in `service/poll/events.ts` (+ the call sites in `service/poll/loop.ts`): inside one chain task — dedupe by delivery id, resolve open run by subject key, **join** (append reference, `run.coalesced` row) or **create** (next ordinal, `run.created` row), write `runs.json` **first**, then delivery rows; `delivery.detected` rows now carry the run's correlation id (FR-050 correlation table). *Tests*: dual-trigger same scan ⇒ one run, two references, one `run.created` + one `run.coalesced` + two `delivery.detected` rows all sharing the run's id (AC-101, FR-016/FR-017); different-scan join; post-terminal delivery opens the next ordinal (AC-102); crash-between-writes self-heals on re-detect (research §R4).

**Wave 1 boundary**: `npm run build && npm run lint && npm run typecheck && npm run test` (i.e. `npm run verify`) green; rebuilt `service/main.js` committed with the wave.

---

## Wave 2 — Claim, lease, sweep (User Story 2, P1) — closing the panel never strands work

**Goal**: claims lease, expiry recovers, budget dead-letters, `unconfirmed` wedges fail-closed. Independent test (spec US2): close the panel at each point and observe the spec's outcome with no operator action.

- [ ] **T-007** [US2] Rework the claim in `service/poll/events.ts` + `service/routes/events.ts`: `GET /v1/events/pending?holder=` claims **runs** per [contracts/claim-lease.md](./contracts/claim-lease.md) — atomic batch, only `state === 'pending'`, never a run with a recorded session (FR-037), lease `{leaseId, attempt, holder, issuedAt, expiresAt}` (FR-030), one `dispatch.claimed` row per run, answer = `ClaimedRun[]` + unchanged `status` member. *Tests*: eligibility matrix (seed every state ⇒ only `pending` answered), seeded-run-with-session never offered, concurrent claims partition the set, lease expiry derived from `leaseMs`, claim answer credential-free (FR-037, NFR-106).
- [ ] **T-008** [P] [US2] Add `leaseMs` + `resultDeadlineMs` to `service/config.ts` and `service/routes/config.ts`: bounds 30,000–600,000 ms, default 120,000, additive to `GET/PUT /v1/config`, fail-closed validation in the existing voice (values never echoed). **No other config field; no `requeueBudget`.** *Tests*: defaults, bounds refusals (422 with field+remediation), existing config documents still parse (additive), `PUT` round-trip.
- [ ] **T-009** [US2] Create `service/poll/sweep.ts`: `sweepOnce` (chain task) + `startSweep` (unref'd timer at `min(leaseMs, resultDeadlineMs)/2`). Rules: `claimed`+no reservation+lease expired → requeue (`attempt++`, `requeuesUsed++`, `dispatch.lease-expired` with attempt before/after; budget 3 exhausted → `dead-lettered` + `run.dead_lettered` with attempts consumed); `starting` past deadline → `unconfirmed` + `dispatch.unconfirmed`; **nothing else is touched** (FR-036); only the service clock (NFR-112). *Tests* (`tests/service-sweep.test.ts`): each transition + its audit details; budget exhaustion at exactly three requeues (AC-106, gate Q3); ten ticks leave `unconfirmed` untouched (AC-107); `pending` runs burn nothing (AC-108); migrated claim requeues **once** as migration recovery without consuming budget (data-model §1).
- [ ] **T-010** [US2] Wire the sweep into `service/main.ts`: boot pass awaited **before the server listens**, then `startSweep`; shutdown stops the timer. *Tests*: pre-seeded `in-flight` row is requeued before the first claim answers (boot ordering); restart-with-stranded-claim recovery; timer unref'd (process exits); service logs name the sweep's actions without secrets.

**Wave 2 boundary**: `npm run verify` + bundles.

---

## Wave 3 — Authorization family (service; User Stories 1 & 3)

**Goal**: single-use tokens make a second session impossible service-side. Independent test: the refusal matrix and idempotency matrix from [contracts/dispatch-authorization.md](./contracts/dispatch-authorization.md).

- [ ] **T-011** [US1] Reserve: `POST /v1/events/:correlationId/reserve` in new `service/routes/dispatch.ts` — lease validation, one-live-authorization, no-session precondition, deterministic token mint + durable reservation + `resultDeadlineAt`, state → `starting`, `dispatch.reserved` row; refusals `stale-lease` / `already-reserved` / `already-dispatched` (names the session) / `invalid-transition`, each + one `dispatch.refused` row (contract §9). *Tests*: full refusal matrix (AC-109, AC-112); no token is minted on any refusal; token equals T-001's derivation (FR-020, FR-021, FR-022).
- [ ] **T-012** [US3] Result + Abandon: extend `service/routes/events.ts`'s dispatched handler (or move it into `service/routes/dispatch.ts`) per contract §2/§3 — token+attempt body, **staleness matrix** (identical duplicate → 200 + exactly one `dispatch.duplicate-report` row; conflicting duplicate → 409; superseded → `stale-lease`; unconsumed from `starting`/`unconfirmed` → applied), `sessionId` → `dispatched` + SessionRef, `problem` → **`failed`** (never dispatched), attempt record appended, `dispatch.result` / `dispatch.abandoned` rows, `auditWritten:false` surfaced on audit failure without rollback (FR-063, AC-119). *Tests*: idempotency ×10 (NFR-102 item), problem-never-dispatched (FR-040, AC-113), unconfirmed reconciliation path (edge case "result after requeue"), abandon → retryable `failed` (FR-026).
- [ ] **T-013** [US1] Block report: `POST /v1/events/:correlationId/blocked` in `service/routes/dispatch.ts` (contract §4) — block from `claimed` with live lease → `blocked:<reason>` + `run.blocked` (actor panel, prior state, guidance), attempt unchanged (a guard consumes no budget); refusal paths reuse the contract §9 row. *Tests*: blocked reason validation against the four-value set; guard refusal consumes no budget and writes exactly one `run.blocked` row with the run's correlation id (FR-042, AC-114).
- [ ] **T-014** [P] [US2] Run operations in new `service/routes/run-ops.ts` (separate module from the authorization family — parallel-safe): **Retry** + **Requeue** + **Resolve** + **Verification report** (contracts §5/§6/§7/§8) — retry from `failed`/`blocked:*` with cause-corroboration (binding re-check service-side; `causeReport` audited as reported), attempt++, refs+history preserved, distinct 409s from `pending`/`dispatched`/`unconfirmed` (+ `claimed`/`starting`/`dead-lettered` with their own messages), each refusal + `dispatch.refused`; requeue from `dead-lettered` resets `attempt`+`requeuesUsed` (FR-033); resolve from `unconfirmed` with the two decisions (`session-created` → terminal; `no-session` → `pending` + attempt++, the **only** re-dispatch path), `dispatch.retry`/`dispatch.resolved` rows with prior state (FR-027, FR-041); verification for a recorded session → `run.verification` + `agent.verified`/`agent.mismatch`, **state never changes** (warn-only, FR-043). *Tests*: refusal-reason distinctness (the three named reasons asserted separately), token chain across reset (research §R3 / plan D6: consumed token refused within a chain, reserve works after reset), resolve outcomes + audit details, mismatch visible in projection while the run stays `dispatched` (AC-113, AC-107's two resolutions, AC-125).
- [ ] **T-015** [US3] Register every new route in `service/routes/index.ts` (literal before parameterised, `404`/`405` behaviour preserved). *Tests*: route-table test (`tests/service-server.test.ts` extended) — each path answers its method, wrong method → `405` + `Allow`, unknown → `404`, auth before routing unchanged.

**Wave 3 boundary**: `npm run verify` + bundles.

---

## Wave 4 — Run history, audit read, vocabulary (User Story 4, P2)

**Goal**: the operator can explain any run from the product. Independent test (US4): copy a run's correlation id, reconstruct its history through `GET /v1/audit` alone.

- [ ] **T-016** [P] [US4] Run-history projection in `service/routes/events.ts`: `RunHistoryRow` per [contracts/run-history-audit.md](./contracts/run-history-audit.md) §1 (all wire-delta fields, source references + truncation members, lease expiry, session ref, verification, `stateReason`), credential-free, cap 100 retained. *Tests*: projection carries every field the spec names; hostile title/reason round-trip as plain strings; credential scan; cap ordering (FR-015, FR-029, FR-040, FR-043, NFR-106).
- [ ] **T-017** [P] [US4] Audit read `service/routes/audit.ts`: `GET /v1/audit?correlationId=&limit=&cursor=` per contract §2 — exact-string filter, clamped limit (default 100, max 200), `seq` cursor, 200 + zero entries for an unknown id, entries verbatim. *Tests*: filter excludes non-run rows (FR-052, AC-118), pagination chains without dup/gap, size guard, auth (AC-117).
- [ ] **T-018** [US4] Vocabulary + correlation suite `tests/audit-vocabulary.test.ts`: drive one run through **every** transition (data-model §4.3) against the loopback service and assert — each of the 16 spec types appears with its required `details` keys (AC-115 sample), `dispatch.refused` appears for one refusal of each refusing operation (FR-003), every lifecycle row's `correlationId` is byte-identical to the run's (never a fresh uuid — FR-062, AC-116), actor sources match the table, and no row carries credential material (NFR-106).

**Wave 4 boundary**: `npm run verify` + bundles.

---

## Wave 5 — Panel dispatch integrity (User Stories 1 & 3, P1)

**Goal**: the panel can no longer double-dispatch, and a lost report travels. Independent test (US3): kill the panel between `startSession` and the report, remount, observe reconciliation and exactly one session.

- [ ] **T-019** [P] [US3] Create `src/dispatch-record.ts`: read/write `mecha-turk:dispatches` (`dispatch-attempts-1`), record-after-host-call/before-report ordering enforced by its API shape, `acknowledged` flip, cap 50 evicting oldest-acknowledged-first, `assertRedacted` on every write. *Tests*: ordering helper, cap/eviction rules, wipe-safe (absent key ⇒ empty), token survives redaction byte-identically (FR-024, NFR-107).
- [ ] **T-020** [P] [US1] `src/session.ts`: attachment id = correlation id in `buildStartSessionRequest` (FR-029; `data.correlationId` unchanged field, new value), and `buildBoundedContext` widened for multiple sources — one bounded excerpt per reference (≤4,000 chars each, ≤12,000 total), delimiter-safe, **visible truncation marker per cut source** (FR-014, AC-105). *Tests*: single-source output remains shape-compatible; two/three sources all present; hostile source text cannot break delimiters or reach past budget; frame + excerpt < `GUEST_ATTACH_TEXT_MAX`.
- [ ] **T-021** [US1] Rebuild the relay in `src/relay.ts` (+ `src/panel-state.ts`): reconcile-first mount order (delegates to T-022), claim → per-run guards (binding present+active, `resolveProject`) → **`POST …/blocked`** on guard failure (replacing today's problem-report "drain") → **`POST …/reserve`** → `src/dispatch-record` write → `host.startSession` → record outcome → result POST → `acknowledged` → verification report; handled list keyed `correlationId#attempt`, cleared only on terminal state or a new service lease+attempt (FR-034); **no dispatch of anything not offered claimed** (FR-035); no `startSession` after any refusal (FR-028 panel half). *Tests* (`tests/relay-integrity.test.ts`): call ordering instrumented on the fake host, reserve-refused ⇒ zero `startSession` calls, guard-refusal posts `blocked` (never `dispatched`), handled-key rules (failed report does not authorize re-dispatch — FR-034), per-mount suppression still holds (existing `relay-arming` expectations updated).
- [ ] **T-022** [US3] Create `src/reconcile.ts` + wire in `src/app.ts`: unacknowledged attempts re-reported **before** `startRelayPolling()`, `RECONCILE_BUDGET_MS = 5000` total, idempotent repeats, bounded failure → visible warning naming the run (never silent), refusal copy recorded for the panel note. *Tests* (`tests/reconcile.test.ts`): mount order (no claim before reconcile settles), repeat ⇒ `dispatch.duplicate-report` + no state change (AC-111), 503-everywhere ⇒ warning + panel still polls, wiped-storage ⇒ zero reports + zero `startSession` (FR-025).
- [ ] **T-023** [P] [US1] `src/service-calls.ts` path helpers for all run operations + `src/runs-service.ts` DTO/parser widened to the eight states (strict: unknown state fails the body) and the new row fields. *Tests*: parser accepts all states incl. `blocked:*`, refuses unknown, round-trips a fixture claim/history body (FR-074's data layer, contract §1).

**Wave 5 boundary**: `npm run verify` + bundles (`panel/main.js` changes here for the first time in 003).

---

## Wave 6 — Honest outcomes & readability (User Story 4 + FR-074)

- [ ] **T-024** [US4] `src/runs-rows.ts`: label + `stateReason` line for every state (incl. `unconfirmed`, `dead-lettered`, `blocked:*`), tone map where **failure is never success-toned** (FR-040, AC-113), verification mismatch rendered as a warning (FR-043), source-reference subtitle: primary label from earliest reference + "+N more reasons" count with each reference's kind + detection time, post-authorization reference marked (FR-015's full reveal control is 005's — subtitle only here), `canRetry` offered only where the service accepts (`failed`, `blocked:*`; `dead-lettered` → return-to-waiting; never `pending`/`dispatched`/`unconfirmed`) (FR-041, FR-074, AC-123). *Tests*: per-state strings + tones, hostile reason renders as text, retry-validity table, dual-reference subtitle (AC-101's row listing).
- [ ] **T-025** [US4] Operator actions in `src/runs.ts` (+ dispatch wiring): retry (failed/blocked with cause report), **Return to waiting** for `dead-lettered` stating the attempt reset before it happens, **Resolve** for `unconfirmed` with the two explicit confirmations stating what is being verified and warning that a session may exist (project + worktree option + attachment id shown) (FR-027, FR-033), each through the existing select-then-act idiom, each surfacing the service's distinct verdict. *Tests*: confirmation copy present (states the verification being asked), refusal verdicts rendered from the service message, resolve only reachable from `unconfirmed`.
- [ ] **T-026** [P] [US4] Create `src/audit-view.ts`: select a run → **Audit history** → `GET /v1/audit?correlationId=` → rows rendered as plain text (event type, seq, timestamp, actor, decision, reason, truncated details) through the non-HTML path; empty + error + loading states with copy; unreachable-service warning. *Tests*: fetch keyed by the selected run's id (AC-117, FR-053), hostile detail text renders inert (NFR-109), bounded list.
- [ ] **T-027** [US4] `src/agent-verify.ts`: post the read-back outcome to `POST /v1/events/:correlationId/verification` after the result report; warn-only behaviour, 15 s budget, and `expectedAgent` source **unchanged** (002 FR-029 as amended); skipped cleanly when no session was created. *Tests*: matched → `agent.verified`; mismatch/unreadable/timeout → `agent.mismatch` + panel warning and **no** state change; verification never blocks the next relay tick (AC-125, FR-043).

**Wave 6 boundary**: `npm run verify` + bundles.

---

## Wave 7 — The two operator surfaces (User Story 5, P2)

- [ ] **T-028** [P] [US5] `src/project-picker.ts` (+ repos UI wiring): explicit **"Not listed?"** affordance stating the three manual routes (command palette → Add project, sidebar **+**, folder browser), guidance reachable without leaving the panel, binding stays in its recoverable state until a registered project is chosen, **no project-creation call anywhere** (FR-070, AC-121). *Tests*: affordance copy asserts all three routes; picker refuses non-listed selection (existing `project_missing` state preserved); static scan still finds zero project-create calls.
- [ ] **T-029** [US5] Create `src/prerequisites.ts` + render in `src/panel-ui.ts`/`src/app.ts`: six prerequisites (FR-071) — Default Agent pin (**not checkable by the panel**, per FR-072 — never "met"), OpenChamber running, desktop-or-web surface, GitHub token scopes with no write scopes, registered project per binding (zero bindings ⇒ met, plan D12), service-capability approval incl. the in-panel consent step — each with state + remediation line; any **checkable + not-met** prerequisite also raises a visible notice outside the section; met-and-checkable items never nag (FR-073, AC-122). *Tests* (`tests/prerequisites.test.ts`): all six render on a fresh install with state+remediation, Default Agent reads *not checkable*, unmet scopes ⇒ notice, no false "met" for the pin; no new `host` capability used.

**Wave 7 boundary**: `npm run verify` + bundles.

---

## Wave 8 — Proof (cross-cutting acceptance suites) + docs

**Goal**: the spec's measurable outcomes as automated, offline tests; nothing here adds behaviour.

- [ ] **T-030** [P] [US2] Finish `tests/service-migration.test.ts`: full NFR-103/AC-126 upgrade script — seed shipped store (all five row shapes + audit + bindings + windows) → boot upgraded service → assert every row adopted, every window byte-identical, zero quarantines, one `run.migrated` per run, pre-existing problem-result renders `failed` and retries, dispatched rows terminal, claim works on adopted `pending` rows.
- [ ] **T-031** [P] [US3] Create `tests/crash-permutations.test.ts`: the enumerated set — close before claim, close after claim, close after authorization, lost result, duplicated result, stale result, slow panel, service restart, panel storage wipe, operator retry — asserting **sessions created per run id ≤ 1** except an explicit operator *no-session* (NFR-102, AC-110, SC-102), plus a 100-trial dual-trigger trial asserting one run/one session and both references named (AC-101, SC-101). No timers-as-sleep: sweep driven by `sweepOnce` with injected stamps (NFR-112 keeps the service clock injectable at the seam).
- [ ] **T-032** [P] [US4] Correlation + visibility suite `tests/service-audit-read.test.ts` (+ AC-119 case): one seeded run reconstructs from `GET /v1/audit?correlationId=` alone in order with prior/new state + reason (AC-115/AC-116/AC-117, SC-104/SC-105); non-run rows excluded (AC-118); simulated `appendLine` failure ⇒ state stands, `auditWritten:false` → panel warning names the run, service log line present (AC-119, FR-063).
- [ ] **T-033** [P] Extend the secret and sink scans `tests/bundle.test.ts` + redaction suites: runs/references/attempts/tokens/audit rows/history projection/panel record/audit view ⇒ zero credential occurrences, `dispatchToken` survives redaction (AC-120, NFR-106); static scan asserts no HTML sink on any new field (NFR-109); the no-GitHub-write import scan covers every new module (AC-128); both committed bundles contain no token-shaped string.
- [ ] **T-034** [P] Latency + bounds assertions in `tests/relay-integrity.test.ts`: round-trip count for one dispatch = shipped count **+1** (reserve) (NFR-101, AC-127); reference cap, attempt-history cap, recorded-attempts cap, and run-history cap exercised so bounded growth is asserted, not assumed (AC-129, NFR-107).
- [ ] **T-035** [US5] Documentation sync: update `specs/002-agent-event-extension/quickstart.md` and `README.md` **only for 003's changed truths** — the in-panel prerequisites section now exists (002 FR-038's gap closed), the dispatch recovery states and their operator actions, the audit-history view, and the store's new `runs.json`. No rename, no settings-tab copy, no prompt copy (005/006/004 own those; 002 FR-042's full sync lands feature by feature). *Check*: `AGENTS.md` module maps gain the new `src/` + `service/` modules.
- [ ] **T-036** Final gate: `npm run verify` green (build → lint → typecheck → test), `panel/main.js` + `service/main.js` rebuilt and committed with the wave, `SERVICE_VERSION` still mirroring `package.json` `0.0.1` (test pinned), zero suppressions/`any` introduced, `git status` shows no unintended files. Record per-AC status for AC-101–AC-129 in the PR/commit body.

**Wave 8 boundary**: `npm run verify` — this is the release candidate gate for 003's Phase 6.

---

## Dependencies & execution order

```
Wave 1 (T-001…T-006)  ──blocks──▶ Wave 2 (T-007…T-010) ──blocks──▶ Wave 3 (T-011…T-015)
                                                     │                    │
                                                     ▼                    ▼
                              Wave 4 (T-016, T-017 ‖ after W1; T-018 after W3)
                                                                         │
Wave 5 (T-019, T-020, T-023 ‖ after W3's wire is stable; T-021 → T-022)  │
                                                                         ▼
                              Wave 6 (T-024…T-027) ──▶ Wave 7 (T-028, T-029 ‖ P)
                                                                         ▼
                              Wave 8 (T-030…T-036, mostly [P]) ── final verify
```

- **Parallel-safe within a wave**: T-001 ∥ T-002; T-008 ∥ T-007; T-014 ∥ T-011/T-012/T-013 (separate route modules: `run-ops.ts` vs `dispatch.ts`); T-016 ∥ T-017; T-019 ∥ T-020 ∥ T-023; T-026 ∥ T-024/T-025; T-028 ∥ T-029; T-030…T-034 all [P]. T-011/T-012/T-013 share `service/routes/dispatch.ts` — they are ordered inside Wave 3, not parallel.
- **Hard dependencies**: T-005 needs T-002+T-003+T-004; T-006 needs T-005; T-009 needs T-007+T-008; T-011–T-014 need T-003's transitions and T-007's claim; T-015 needs every route; T-018 needs every transition route; T-021 needs T-011/T-012/T-013's endpoints; T-022 needs T-019; T-025 and T-027 need T-014's endpoints; T-031 needs T-009+T-021+T-022.
- **Story coverage**: US1 → W1, W3 (T-011/T-013), W5 (T-020/T-021), W8 (AC-101/103/105); US2 → W2, W8 (T-030); US3 → W3 (T-012/T-014), W5 (T-019/T-021/T-022), W8 (T-031); US4 → W4, W6, W8 (T-032/33); US5 → W7 + T-035.
- **MVP slice for a first demo** (if delivery is cut): Wave 1 + Wave 2 + T-011/T-012 + T-021 — coalescing, leases, and reserve-before-start are the three defects that matter most; but **no wave boundary ships without `npm run verify` green and bundles rebuilt.**

## Test expectations summary (per task's own gate)

Every task names its files and its suite above; the standing rules: tests are written to **fail first** against current behaviour where behaviour changes (claim, result, handled list, states), offline only (fake host / loopback service + temp dirs), no `sleep`-based timing (inject stamps; the sweep exposes `sweepOnce` precisely so tests never wait on a clock), and zero suppressions — a red lint or a red test is fixed, never muted.
