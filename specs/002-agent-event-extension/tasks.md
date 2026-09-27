# Tasks: Agent Event Extension (Production)

**Feature**: `specs/002-agent-event-extension` · **Spec**: v1.0.0 · **Plan**: [plan.md](./plan.md) · **Date**: 2026-09-27

Rules: dependency-ordered, each task completable in one sitting, tests land **with** the implementation task (not after it), `[P]` marks tasks safe to run in parallel, and every gate is explicit. No task begins before its listed dependency/gate is checked. Quality bar for every task: `npm run verify` green — strict types, zero lint suppressions, no `any`. **35 tasks, 11 waves, 2 gates.**

**Gates**

- **G1 — Security gate**: closes when T-001 findings are resolved and signed off in `contracts/token-handoff.md` §8. **No credential, account-handoff, or token-persistence code exists before G1.** → **CLOSED 2026-09-27** (T-002 sign-off; SEC-01…SEC-17 all resolved, none rejected).
- **G2 — Live durability gate**: closes when T-033 proves the audit store survives uninstall on a live instance. **No user-facing copy may claim audit survival before G2.**

---

## Wave 0 — Security gate FIRST (contract review before any secret code)

- [x] **T-001** Dispatch the `security-auditor` agent to review `contracts/token-handoff.md` + `contracts/panel-service.md` and the FR-008 consent copy: bearer auth on loopback, token custody lifecycle, F1–F12 failure modes, oracle/timing surface, response redaction, advisory-permission honesty, at-rest file permissions. Output: findings list with severity. **First gate task — Wave 2 cannot start until it passes.** *(Done 2026-09-27: PASS-with-fixes, SEC-01…SEC-17.)*
- [x] **T-002** Resolve every G1 finding: update the two contracts (or record a justified rejection), then record reviewer, findings, resolution, and `Gate G1 status: CLOSED` in `token-handoff.md` §8. **Closes G1. Blocks: T-007, T-008, T-009.** *(Done 2026-09-27: SEC-01…SEC-17 all Resolved-by-amendment — none rejected — both contracts amended, token floor 16 → 32 in `extension/service/env.ts` + tests, §8 sign-off recorded, **G1 CLOSED**.)*
- [ ] **T-036** [P] Move panel redaction to `shared/redaction.ts` per plan.md layout (service consumes it); update imports in panel + service; port tests. **After T-012 creates `shared/`.**

## Wave 1 — Service core (parallel with Wave 0 — no secrets involved)

- [x] **T-003** [P] Add `contributes.service` (`entry: service/main.js`, `runtime: "host"`, no `permissions`) to `extension/package.json`; add the `--node` ESM build script; extend `tests/manifest.test.ts` to assert the implied capability set (`sessions`, `prompt`, `service`, `network`) via the SDK's own `requestedGuestCapabilities` and to assert `"service"` never appears inside `capabilities[]` (research R1); extend `tests/bundle.test.ts` for `service/main.js` (ESM, committed, importable, no IIFE markers).
- [x] **T-004** Service HTTP skeleton: `service/server.ts` — `127.0.0.1:$OPENCHAMBER_SERVICE_PORT` bind, `OPENCHAMBER_SERVICE_TOKEN` bearer middleware (`timingSafeEqual`, uniform 401), `GET /health`, JSON body cap 60,000, method/path validation, request logging without secrets, graceful shutdown on SIGTERM. Tests: fake env harness (port/token), auth matrix on every route, oversize/malformed bodies, shutdown drain.
- [x] **T-005** [P] Durable store foundation: `service/store/` — data-dir resolution (`$HOME/.config/openchamber/mecha-turk`, research R2), `0700`/`0600` modes, atomic temp+rename JSON writer, NDJSON append, corruption quarantine (never fail-stuck), schema version in `state.json`. Tests: permission bits, atomic overwrite, torn-write recovery, unwritable-dir → `storage-unavailable`.
- [x] **T-006** Service config + status: `ServiceConfig` model (interval 15k–300k ms, overlap, perPage ≤30, retry bounds, retention, log level) with field-remediation validation; `GET/PUT /v1/config`; `GET /v1/status` skeleton (service, dataDir, surface.supported, polling state). **Blocked by T-004, T-005.** Tests: bounds rejection, unknown-field rejection, status shape.

## Wave 2 — Token custody & accounts (**G1 CLOSED 2026-09-27 — unblocked**)

- [x] **T-007** *(blocked by T-002)* GitHub credential verification in the service: `POST /v1/accounts/verify` — shape-check → own `fetch` to `/user` + `/rate_limit` (15 s abort), numeric-id keying, case-insensitive `expectedLogin` fail-closed reject, duplicate id `409`, scope-matrix results (`ok/missing/unknown` per capability). Tests with a fake `fetch` (200/401/403/SSO/mismatch/duplicate); assert no token bytes in any response body. *(Done 2026-09-27: shape-before-network, consent gate + idempotent `consent` occurrence, SEC-04 throttles (`verify-busy`/`rate-limited` + `retry-after`), GitHub classification to `422 credential-rejected` reason classes / `429` / `502 upstream-unavailable`, FR-010 scope matrix, duplicate `409`, registered-token scans of responses/logs/audit plus the forced-500 log scan — commit `44513a8`.)*
- [x] **T-008** *(blocked by T-002)* Credential persistence + rotation: `accounts/<id>.json` at `0600` with atomic replace; `POST /v1/accounts/:id/token` preserves checkpoints/deliveries/runs/audit (FR-012); `GET /v1/accounts` (no credential fields by construction); `DELETE` with binding-reference refusal. Tests: file modes, rotation invariance, response secret scan, structural type test that account DTOs cannot carry `credential`. *(Done 2026-09-27: `0600` atomic custody (temp `0600` inside the target dir, fsync, rename, dir `0700` correction, debris sweep), rotation invariance diff (credential/login/scopeCheck/verifiedAt only; id mismatch → `422` + byte-identical store), credential-free DTO by construction (compile-time test), `DELETE` with binding refusal + `?force=1` audits, F13 startup reconciliation, plus the contract-mandated `service.storage.writable` on `GET /v1/status` — commit `cd6f564`.)*
- [x] **T-009** *(blocked by T-002; needs T-004, T-007)* Panel one-shot handoff: consent gate UI (FR-008 copy verbatim from contract §1), `POST /v1/accounts/verify` via `serviceRequest`, `finally`-clear of the token variable and input, `Connected as <login>` render, consent mirror in `host.storage`. Tests: consent refusal path (AC-002), token-cleared assertions on success and every failure (F1–F12), storage-write secret scan (AC-001). *(Done 2026-09-27: `CONSENT_COPY_V1` rendered verbatim from contract §1.1 (single-source test), `consentVersion` on every handoff, module-scoped token cleared in `finally` on success and every F1–F16 path, `GET /v1/status` pre-flight gate (F10) + status re-read on `HOST_TIMEOUT` (F4), host/service error-code copy map, textContent-only DOM adapter with `type=password`/`autocomplete=new-password`, consent + account mirrors behind `assertRedacted` — commit `7253fa5`. **Corrected by T-009k (2026-09-27, review H1/W2-1): the check-off overstated input clearing** — only the module-scoped *variable* was cleared; `setTokenValue('')` had no production call site and the "cleared" assertion compared an untouched default. The input half of contract §2 step ⑧ lands in T-009k — capture-time write-through + `finally` clear + DOM-driven tests.)**

## Wave 2 remediation — post-wave reviews (2026-09-27: code-quality + security, both PASS-with-fixes)

- [ ] **T-009k** [P] Clear credential input on every handoff exit (`setTokenValue('')` in submit finally + capture-time write-through); replace vacuous `record.tokenValue` assertion with a real DOM-driven test (success + each F-class failure); correct T-009 check-off claim. *(Review H1/W2-1, contract §2 step ⑧, FR-007 — MUST before T-019.)*
- [ ] **T-009l** [P] Panel batch: add `scopeCheck` to account mirror + pinned test (M1); classify `TimeoutError` → `detail:'timeout'` (W2-7); reconcile panel copy with §4 catalog — PAT/token/scope-missing/account-rejected/F16 wording, mark canonical side (W2-4/W2-8); widen textContent static scan to all of `extension/src` (F-E).
- [ ] **T-009m** Contract/docs ratification batch: 502 `upstream-unavailable` row in §4 + F9 (M2); `error.reasonClass?` in §1 envelope grammar (M3); rotation state-recovery sentence in §6 (M4); §1.1 records JSON mirror + `**`-strip as permitted transform + version-bump checklist (L1/W2-5); `invalid-transition` reuse note for DELETE (L13); data-model `updatedAt` wording + stale `pending_handoff/verifying` transition notes; FR-010 single-verdict note (L5); `github.ts` module-doc abort-signal correction (L6). Also extend consent test: copy+version pinned in one literal.
- [ ] **T-009n** Service integrity/perf: consent occurrence behind throttle slot or per-version write memo + `Promise.all` two-request test asserting exactly one consent row/seq (W2-2); audit `nextSeq` cached at store open (seed from file once) + regression test, same for consent version set (M6 — MUST before Wave 4 poller writes); widen `ErrorBody`/`ErrorDetails` to model `issues?`/`reasonClass?` (L13).
- [ ] **T-009o** [P] Test-gap batch: invariant-1 additions — same-length wrong-value 401 byte-identical + unknown-path-invalid-bearer 401 (W2-3); rotation throttle test (M5b); registered-token scan of rotation/DELETE response bodies (M5c); move `await reconciled` above file reads in F13 tests (nit); hostile `<img onerror>` login DOM assertion (M5a — use a minimal fake Document if no test dep is desired).
- [ ] **T-009p** [P] Service read-path: credential-free projection read for `/v1/status` + `GET /v1/accounts` so tokens are not parsed from disk per poll (M7); shared abort signal for `/user` + `/rate_limit` (L6). Note for T-020: move `bindingsReferencing`/`disableBindings` behind a single bindings-file owner + serialize store mutations (L8).
- [ ] **T-009q** Re-run `npm run verify`, rebuild bundles, check off T-009k–T-009p, commit.

## Wave 3 note (encoded obligation)

- T-011/T-014 MUST derive pre-blocked streams from account `scopeCheck` before any poll (FR-010/F6 — M8: missing scopes must not silently downgrade on first poll).


## Wave 3 — Poller port (panel → service)

- [ ] **T-010** [P] Service GitHub client `service/github.ts`: request headers (`If-None-Match`/`If-Modified-Since`), response header capture (`ETag`, `Last-Modified`, `x-ratelimit-*`, `retry-after`), `per_page ≤ 30` pagination loop with interrupt-safety, 304 as feature-detected optimization, 401/403/429/5xx classification, bounded exponential backoff + jitter. Fixture-driven contract tests per endpoint stream (research §R6); conditional-requests-disabled variant runs the same fixtures (AC-010).
- [ ] **T-011** Checkpoint store: one file per `(account, repository, stream)` with the full FR-018 field set; atomic advance-only-after-durable-window rule; 10-minute overlap resume; interrupted-page retains prior checkpoint. **Blocked by T-005, T-010.** Tests: crash mid-page, resume within overlap, validators round-trip, state transitions (AC-007).
- [ ] **T-012** Port matching/normalization to `shared/matching.ts` + `shared/events.ts`: four kinds (assignment, review request, review assignment, mention), identity scoping to the bound account, case-insensitive mention token (default `@login` and override), bot/other-identity/non-match → `ignored` with audit reason; delivery/run key derivation. **Blocked by T-010.** Tests: port the spike's `matching.test.ts` cases and extend for the full trigger set (AC-006).
- [ ] **T-013** Delivery store + dedup: delivery-key index with retention, `discovered → duplicate/ignored/queued` transitions, collision (assignment+mention) → single run key. **Blocked by T-011, T-012.** Tests: 100× same-window replay produces zero new deliveries/runs at store level (AC-008 unit half), duplicate observations audited (FR-023).
- [ ] **T-014** Poll scheduler + rate budget controller: per-account shared budget (FR-022), cadence per plan.md arithmetic, `x-ratelimit-*` accounting, secondary-limit obeying, no catch-up burst after backoff, `nextPollAt`/remaining-budget exposure, stream de-prioritization only under budget pressure (surfaced in health). **Blocked by T-011.** Tests: simulated 403/429 honor `retry-after`, checkpoint preserved, budget usage numbers (AC-009), steady-state ≤1,500/h projection at 10 repos.

## Wave 4 — Event relay & run lifecycle

- [ ] **T-015** Run store + policy engine: run key, state machine (data-model.md), `PolicyProfile`/`PolicyEntry` with autonomous defaults, `start_work` gate, missing-policy fail-closed, decision records (version, actor/source, action, decision, timestamp, reason). **Blocked by T-013.** Tests: AC-011 matrix (allow / require-approval / deny / missing policy), invalid transitions rejected.
- [ ] **T-016** Relay endpoints: `GET /v1/dispatches` long-poll (≤10,000 ms) with atomic single-use leases; `dispatch-result`, `verification`, `approval`, `reconcile`, `retry` routes per panel-service.md §2.4. **Blocked by T-015.** Contract tests: lease single-use, stale lease `409`, replayed posts idempotent, approval only from `waiting_approval`, response size guard (NFR-002, NFR-005).
- [ ] **T-017** Re-fetch before dispatch (FR-026): service re-fetches the current source object when a run reaches `created`; deleted/inaccessible/ambiguous → non-actionable; assignment removed or `headSha` drift → run pauses (`blocked:source-changed`) with discrepancy recorded in audit, new trigger required. **Blocked by T-015.** Tests: drift/removal fixtures (US4.3 edge cases).

## Wave 5 — Panel accounts & repositories UX

- [ ] **T-018** [P] Panel service client: typed `serviceRequest` wrapper (endpoints, JSON parse, error catalog mapping `NO_SERVICE`/`DISABLED`/`SERVICE_FAILED`/`HOST_TIMEOUT`, 256,000-char response guard, long-poll driver with cursor handling). Tests: error mapping matrix, timeout → soft miss (cursor unchanged), oversize guard.
- [ ] **T-019** Accounts tab: consent → paste → connected states, rotation flow, expected-login field, per-account connection state and scope results, failure copy for F1–F12. **Blocked by T-009, T-018.** Tests with fake service + panel doubles: renders, refusal copy, no token in any rendered string or storage write.
- [ ] **T-020** Repositories tab: binding sequence account → `listProjects()` picker → per-repo triggers → mention override → worktree option → policy profile; `project_missing` recovery guidance ("not listed?" affordance); disable binding stops polling; **no project-creation call exists anywhere** (static test asserting absence, AC-005). **Blocked by T-016, T-018.** Tests: binding state machine UI, picker precedence (001 amendment 4 retained).

## Wave 6 — Dispatch + agent verification

- [ ] **T-021** Dispatch pipeline (extends `panel-dispatch.ts`): lease check → binding/project preconditions → bounded excerpt builder (≤4,000/item, ≤12,000/dispatch, explicit delimiters, truncation markers) → `host.startSession` with `navigation:'preserve'`, worktree `none|generated|new:<branch>` incl `{number}` substitution, deterministic `attachItemId`, `data:{correlationId, runKeyHash}` → post `dispatch-result`. **Blocked by T-016, T-020.** Tests: AC-012 matrix (all three worktree options, bounds, delimiters cannot alter policy fields), partial-failure capture (`sessionId:null`).
- [ ] **T-022** Agent verification: subscribe `onSession` before dispatch → `host.openSession(sessionId)` → resolve snapshot matching `sessionId` within 15 s → compare `agent` to `expected-agent` (default `project-manager`) → post verification; mismatch/absent/timeout → `blocked:agent-mismatch` + audit + panel warning, no further automated handling. **Blocked by T-021.** Tests: verified, mismatch, unreadable, timeout paths (AC-013); documented context-switch note rendered in UI.
- [ ] **T-023** Crash reconciliation: panel in-flight marker written to `host.storage` before `startSession`; on remount, reconcile via `listSessions(projectId)` items (`items[].id === attachItemId`) → recover `sessionId` and post result, else `blocked:dispatch-unknown`. **Blocked by T-021.** Tests: killed-before-post, killed-after-post, session-never-created (FR-030, NFR-002).

## Wave 7 — Run list / health / policy UX

- [ ] **T-024** Runs tab: paginated list with source link, policy decision, state, correlation id, attempts, blocked-cause + remediation copy (`blocked:agent-mismatch`, `blocked:project-missing`, `blocked:credential`, `blocked:policy`, `blocked:source-changed`); run detail with audit-trail slice. **Blocked by T-016, T-018.** Tests: SC-006 completeness (every row has link/policy/state/correlation), blocked-copy matrix (US3.3).
- [ ] **T-025** Health tab: `serviceStatus()`, per-account identity + rate usage vs budget, per-repo last successful poll + checkpoint age, agent-pin status, extension-disabled honesty (stopped interval reported, not masked), OpenChamber-running dependency copy, unsupported-surface state for VS Code/mobile. **Blocked by T-006, T-014, T-018.** Tests: render from real `/v1/status` fixtures incl. `failed`, `stopped`, unsupported (AC-016, AC-017, NFR-009).
- [ ] **T-026** Policy & setup UX: per-action gate toggles (start-work now; write/merge gates documented-only), approval actions for `waiting_approval` runs, first-run setup-prerequisites checklist (FR-038), pre-production configuration validation screen surfacing every FR-039 failure explicitly. **Blocked by T-015, T-024.** Tests: checklist accuracy, validation-blocks-start matrix (AC-019), approval audit linkage.

## Wave 8 — Persistence, audit, resilience

- [ ] **T-027** Audit trail: append-only NDJSON writer with correlation index, redaction metadata, retention (180 d / 50,000 entries; excerpts 30 d; minimal refs until binding deletion) with trim recorded as `audit.trimmed`; `GET /v1/audit` pagination. **Blocked by T-005, T-015.** Tests: append-only enforcement, retention boundaries, correlation-id lookup, redaction of detail payloads (FR-035, NFR-007).
- [ ] **T-028** Panel storage tier: bounded `runs-mirror`/`health-mirror`/`ui`/`consent` keys with eviction, wipe-semantics copy, `handoff-guard` assertion key (any token-shaped write fails), precedence rules retained for the project picker. **Blocked by T-024, T-025.** Tests: eviction at byte budget, uninstall-wipe documentation test (keys enumerated + asserted token-free), no audit/checkpoint/run data lives only in `host.storage` (FR-034).
- [ ] **T-029** Lifecycle resilience: graceful shutdown (drain in-flight, persist checkpoints, close store), bounded queue/dead-letter capture, manual replay under duplicate protection, `SERVICE_FAILED` non-looping behavior (panel retries only on operator action). **Blocked by T-016, T-027.** Tests: shutdown mid-poll, dead-letter replay → duplicates refused, retry-loop absence assertion (FR-037, AC-018 offline half).

## Wave 9 — E2E / lifecycle / security tests

- [ ] **T-030** End-to-end idempotency suite against fake GitHub + fake host + real service: 100× window replay, assignment+mention collision, restart resume within overlap, rescan-from-timestamp. Asserts 0 duplicate deliveries-in-run/runs/sessions (AC-008, NFR-002, SC-003). **Blocked by T-017, T-023.**
- [ ] **T-031** Secret-containment suite: register live test tokens with the harness; scan persisted panel state, service store (non-credential files), logs, audit, error bodies, toasts, and the full test-run output for token patterns — 0 occurrences (NFR-004, SC-004); static assertion that panel/service issue no GitHub writes (AC-014 trace). **Blocked by T-009, T-027.**
- [ ] **T-032** Service lifecycle suite: kill service → `serviceStatus()=failed` + `SERVICE_FAILED` + durable state intact + manual retry resumes under same run keys; disable extension stops polling; host-quit semantics; unsupported-surface honesty (AC-016–AC-018, AC-017). **Blocked by T-029.**
- [ ] **T-033** **[MUST — spec FR-033/SC-007]** Live-verify **audit-store survival** on the operator's instance: build → folder-install → add account/bindings → generate audit → uninstall → confirm `~/.config/openchamber/mecha-turk/` intact and readable → reinstall → confirm history loads and the panel states which UI state was wiped. Record evidence (with the host build version — still unrecorded since 001) in `durability-evidence.md`. **Blocked by T-027. Closes G2; docs audit-survival claims blocked until it passes.**
- [ ] **T-034** Performance/limits verification: detection-latency measurement ≤2× interval at default settings (NFR-001/SC-002), steady-state request-rate accounting ≤1,500/h at 10 repos (NFR-003/SC-005), response-size guard under max pages, plus the AC→test mapping table (every AC-001…AC-020 row points at a named test or live evidence). **Blocked by T-030, T-032.**

## Wave 10 — Packaging & docs

- [ ] **T-035** *(audit-survival copy blocked by G2/T-033)* Packaging & documentation: rebuild and commit both bundles, README + quickstart final pass (setup prerequisites, cleanup routing, data-dir/backup warning, expected context-switch note, unsupported surfaces), retention/gate-question copy for the product owner (spec Gate Questions 1–2), manifest/SDK-pin check, full `npm run verify`, then Conventional Commits commits with AI attribution.

---

## Dependency summary

```
T-001 → T-002 ──G1──┬→ T-007 → T-008 ─┐
                     └→ T-009 ─────────┤
T-003 T-004 T-005 (parallel) → T-006  │
T-010 → T-011 → T-013 → T-015 → T-016 → T-017
T-010 → T-012 ─┘   T-011 → T-014 ─┘ (health)
T-018 (parallel) → T-019 (needs T-009), T-020 (needs T-016)
T-016, T-020 → T-021 → T-022, T-023
T-016, T-018 → T-024 → T-026 ; T-006, T-014, T-018 → T-025
T-005, T-015 → T-027 ; T-024, T-025 → T-028 ; T-016, T-027 → T-029
T-017, T-023 → T-030 ; T-009, T-027 → T-031 ; T-029 → T-032
T-027 → T-033 (G2) ; T-030, T-032 → T-034 ; G2 → T-035
```

Stop conditions (inherited from 001, still in force): no private UI routes, no undocumented host APIs, no direct worktree/session/project mutation, no GitHub writes, no token code before G1, no audit-survival claims before G2.
