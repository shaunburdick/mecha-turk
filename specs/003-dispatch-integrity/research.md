# Research: Dispatch Integrity & Recovery — new findings only

**Feature**: `specs/003-dispatch-integrity` · **Spec**: v1.3.0 → **v1.8.0** · **Date**: 2026-09-28 · **Amended**: 2026-10-03 (§R5, for the actor allow-list gate — GitHub issue #9)

This file answers only the questions **003** raises. Everything a platform question would otherwise re-open is already settled with stamped sources elsewhere; those are listed first and are *cited, not re-researched*.

## Settled before this feature (cited, not re-researched)

| Question | Settled by |
| --- | --- |
| Guest service transport, loopback bind/auth, leg limits (`GUEST_REQUEST_*`), error codes | 002 `contracts/panel-service.md` §1; 002 research §R4 (historical 001 §b.9) |
| Store location, 0700/0600, atomic writes, quarantine funnel | 002 research §R2; `service/store/` (shipped) |
| Agent verification mechanism (`openSession` + `onSession().agent`, warn-only) | 002 research §R3; 003 FR-043 (warn-only stands) |
| SDK pin, host capability floor, no per-call agent/model | 002 research §R7; 003 NFR-110 (pin unchanged, **no re-pin**) |
| No dependable session enumeration for the extension → reconciliation uses the panel's own record; operator resolution uses displayed project + worktree + attachment id | 003 spec `## Assumptions` (normative; the 002-era `listSessions()` reconciliation idea is superseded by FR-024/FR-025/FR-027) |
| Delivery id format, evidence schema `extension-spike-1`, kebab-case identity, committed bundles, `SERVICE_VERSION` mirroring | `AGENTS.md` invariants 1–10; 003 FR-012 / AC-104 |
| Polling-first, no webhook, rate budget, overlap windows | 002 research §R6, 002 FR-017–FR-022 (unchanged by 003) |
| Lease bounds, result-deadline bounds, requeue budget = 3, `unconfirmed` never expires, follow-up trigger opens a new ordinal | 003 `## Assumptions` + `## Resolved Gate Questions` 1–3 (product owner, 2026-09-28) — product decisions, not research |

**No external or platform research was required for this feature**: 003 changes only Mecha Turk's own durable state and its own panel↔service wire, both of which this repository owns end to end. Nothing below needs a network call, a live host, or a newer SDK.

## R1. Where the lease-expiry / result-deadline sweep lives

- **Decision**: a new `service/poll/sweep.ts` with two entry points — `sweepOnce(deps)` (one pass, chain-serialized like every other queue mutation) and `startSweep(deps)` (an unref'd timer) — armed from `service/main.ts` so the boot pass is **awaited before the HTTP server starts listening**, then repeats every `min(leaseMs, resultDeadlineMs) / 2`.
- **Rationale**: FR-032 requires the sweep "at service start, before the first claim is served" and "at least once per lease duration while the service is up". The poll timer cannot carry it: a configured 300 s poll interval is longer than the 120 s lease, so piggybacking would silently violate the cadence. A dedicated timer also keeps the sweep out of scan-cycle failures (a rate-limited scan must not stall lease recovery).
- **Alternatives considered**: (a) sweep inside `service/poll/timer.ts`'s cycle — rejected, cadence bound above; (b) sweep lazily inside the claim handler (check leases on read) — rejected as insufficient alone: `unconfirmed` must be produced even while nobody claims (FR-023), and a service nobody polls against must still dead-letter on budget exhaustion; a lazy check is retained as nothing — one path would make recovery depend on an operator opening the panel, which is the defect being fixed.

## R2. How a legacy `dispatchResult` string is classified during adoption

- **Decision**: the shipped panel's problem vocabulary is a **closed set derivable from this repository's own source** — `binding-missing-at-dispatch`, `no-session`, `bootstrap-failed`, `session-create-failed`, `project "<id>" is not registered in OpenChamber`, `projects snapshot reported state "error"`, `listProjects failed: …` (`src/relay.ts`, `src/session.ts`). Adoption classifies a value in that set (exact match, or the `listProjects failed: ` prefix) as a **problem → `failed`**; every other value is treated as a **session id → `dispatched`**. The branch is recorded in the `run.migrated` audit row's details.
- **Rationale**: the shipped route stored `sessionId ?? problem` into one field, so the shape carries no discriminator. For anything the shipped build could have written, the classification is exact. For a value it could not have written (hand edit, foreign file), the fail-closed direction is *assume a session exists*: misreading a session as failed is the catastrophic direction (it authorizes a second `startSession`), while misreading a problem as dispatched only withholds a retry — and constitution II makes ambiguity a stop condition, never permission to dispatch again.
- **Alternatives considered**: (a) regex-shape the session id (a session id that looks problem-like becomes re-dispatchable — rejected, wrong-direction failure); (b) mark unrecognised values `unconfirmed` — rejected: `unconfirmed` is defined by FR-023 as *a reservation with no result*, so labelling an adoption row that way would falsify the state's meaning; (c) ask the operator during upgrade — rejected: adoption is automatic and must not block service start (NFR-103).

## R3. Dispatch-token derivation, storage key naming, and the redaction/key guards

- **Decision**: `dispatchToken = dtk-<sha256(runKey + '|' + attempt) hex[0:32]>`, minted at reservation only, and the field is named **`dispatchToken` on the wire, in the panel record, and in audit details**.
- **Rationale**: two guards in `src/redaction.ts` shape what can be persisted: `stripCredentialKeys` drops keys matching `^(token|pat|…)$` (a field literally named `token` would be silently removed from the panel's durable record, destroying FR-024 reconciliation), and `findSecretLeak` matches `gh[pousr]_…`, `github_pat_…`, `Authorization:…`, `Bearer …` **value** shapes — a `dtk-<32 hex>` value matches none of them, so `assertRedacted` and the audit redaction pass carry it intact while the NFR-106 scans still find zero credential occurrences. The `dtk-` prefix also makes the token visually distinct from a credential in any rendered or logged surface.
- **Verification task**: `tests/bundle.test.ts` and the redaction suites gain a case asserting a stored `dispatchToken` survives `assertRedacted`/`redact` byte-identically while a PAT anywhere near it still throws — the guard stays armed, the authorization artifact passes (NFR-106's "MUST NOT weaken the suites" is honoured by adding, never exempting).
- **Alternatives considered**: (a) field name `token` — rejected, key guard strips it; (b) random token — rejected, FR-020 mandates deterministic derivation from the run key/attempt pair (it is what lets the service re-derive and validate without storing a token table); (c) HMAC with a stored secret — rejected, it adds a secret to protect a loopback-authorized artifact the bearer-authenticated service already gates (constitution V: justify complexity or don't).

## R4. Cross-file durability: run write before delivery write

- **Decision**: enqueue performs one chain task that (1) resolves coalescing and writes `runs.json`, then (2) writes the delivery rows to `events.json`, then (3) appends the `run.created` / `run.coalesced` / `delivery.detected` audit rows; a failure at any step surfaces, and the intermediate states are chosen so that the *interrupted* one self-heals.
- **Rationale**: crash between (1) and (2) leaves a run whose joining delivery was never stored — the next scan re-detects that observation (its delivery id was never written, so dedup does not suppress it) and coalesces into the same still-open run: no loss, no duplicate (FR-011, NFR-103). The reverse order would leave a delivery whose run does not exist, which nothing can repair (dedup would suppress the re-detection forever). Audit rows are written last because FR-063 already fixes the posture: an audit failure never rolls back durable state, it is logged and surfaced.
- **Alternatives considered**: one merged file for both layers — rejected in plan.md D1 (a parser regression would take out both layers at once, and FR-012 puts the run link on the delivery, which presumes the delivery store survives); two-phase commit — rejected as disproportionate for a single-writer stdlib store at <10 repositories (constitution V).

## R5. Where the gate's policy read goes, and what it costs (added 2026-10-03, for FR-076 / NFR-114)

- **Decision**: `reserveDispatch` reads the bindings document **inside its `operateRun` chain
  task**, through `service/bindings-read.ts`, once per reserve; `judgeActorPolicy` is handed the
  binding it found (plan D13).
- **Rationale**: FR-076 requires the *live* stored policy at the moment of authorization, and the
  only reader that can supply it is the bindings read path — the same one the poll loop, the claim
  route, and `GET /v1/bindings` use. The read is one small JSON file; its frequency is bounded by
  **dispatch rate** (one per authorization) rather than by request rate, and it is entirely off the
  hot path: the minute-scale call it precedes is `host.startSession()`.
- **The finding that makes this a research item rather than a decision**: **NFR-114's premise is
  false of the shipped code.** It states *"The gate reads the binding table the authorization path
  already reads"* — but `reserveDispatch` today reads `CONFIG_FILE` (the result deadline) and the run
  document, and **no** bindings document. Read strictly, adding the read violates NFR-114's letter.
  The intent behind the sentence is a *latency* promise (p95 unchanged, no extra round trip, no
  network), and that intent is met: one local file read, no HTTP, no extra panel↔service call, and
  `B-7` asserts the round-trip count on the authorized path is **unchanged**. The letter is recorded
  as a **flagged wording defect** in plan §B.5 with a recommended replacement, not silently
  reinterpreted.
- **Alternatives considered**:
  (a) **a `writeBindings`-invalidated in-process cache** — rejected: `ServiceStore` exposes
  `readJson`/`writeJson`/`appendLine`/`writeLines` and **no `stat`**, so a hand-edited
  `bindings.json` would never be observed until a restart. 002 FR-047 requires the field to be
  validated "on every read and every write", and a cache that cannot see a hand edit is a store
  read whose result can be wrong. Trading one honest read for a silent staleness hole is the wrong
  direction for a security control.
  (b) **read the policy from the run's snapshot at enqueue** — rejected: that is the
  "decided at enqueue" behaviour FR-076 exists to forbid, and it would mean a tightened list takes
  effect only on **new** runs, leaving every queued run dispatchable under the old policy.
  (c) **cache keyed on file mtime** — rejected for now: it needs the store to grow a `stat`
  surface, which is a change to the store's public contract for a file whose read is already
  bounded and cheap. Recorded here so the option is not rediscovered as if it did not exist.
- **No external research was required.** The gate is this repository's own operation over its own
  store; nothing here needs a network call, a live host, or a newer SDK.

## Open items this research leaves

None blocking. Two items are *recorded decisions*, not open questions, and both are carried in plan.md: the attempt-count reading (plan "Attempt counting") and the FR-020 ↔ FR-033 token/reset tension (plan D6). Neither needs a product answer — each is the reading under which the spec's own normative sentences and acceptance criteria are simultaneously satisfiable — and both are pinned by tests in [tasks.md](./tasks.md) so a future reader argues with evidence, not with this file.

**v1.8.0 adds none.** R5 settles the only question the gate raised — where its policy read goes — from the shipped code (`dispatch-authorize.ts` reads `config.json`; `ServiceStore` exposes no `stat`), and it leaves **one flagged item** rather than an open question: NFR-114's premise about an existing bindings read is false of the shipped build, and the wording is recommended for amendment at the gate (plan §B.5).
