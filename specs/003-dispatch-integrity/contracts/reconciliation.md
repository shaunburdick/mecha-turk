# Contract: Reconciliation on Mount

**Spec**: 003 FR-024, FR-025, FR-026 · wire-delta consequence of **Result/Abandon** (there is no separate reconcile *operation* — reconciliation re-reports what the panel durably recorded)

The panel's durable attempt record and its mount-time report are two halves of one contract; both sides are specified here because the ordering between them is the defect this feature exists to fix (a lost report must never become a second session).

## 1. The panel's durable attempt record (panel ↔ `host.storage`)

Key `mecha-turk:dispatches` (existing prefix — AGENTS.md invariant 4), document `schemaVersion: 'dispatch-attempts-1'`, wiped on uninstall like every panel key.

```jsonc
{ "schemaVersion": "dispatch-attempts-1",
  "attempts": [
    { "correlationId": "mt-run-…", "runKey": "github|…|0", "attempt": 1,
      "dispatchToken": "dtk-…", "outcome": "dispatched" | "failed",
      "sessionId": "ses_…" | null, "reason": "…" | null,
      "recordedAt": "RFC3339", "acknowledged": false }
  ] }
```

**Write ordering (FR-024, non-negotiable)**:

```
reserve ──▶ host.startSession() returns ──▶ WRITE attempt record (outcome, token, sessionId|reason)
                                                   │
                                                   ▼
                                        POST result/abandon ──▶ 2xx ──▶ acknowledged := true
```

1. The record is written **after the host call returns and before the result report is issued** — so every stored record already carries an outcome. A crash *before* the record exists means the service's reservation is the only evidence, and the run correctly becomes `unconfirmed` (FR-023) rather than being guessed at (spec `## Assumptions`: the host offers no dependable session enumeration; the panel's record is the reconciliation source).
2. `acknowledged` flips only on a 2xx for that exact attempt (idempotent 200s count as acknowledged; a 4xx does not — the refusal row tells the operator why).
3. The record holds at most `MAX_RECORDED_ATTEMPTS = 50`; eviction removes the oldest **acknowledged** record first and never an unacknowledged one (NFR-107).
4. The record contains a `dispatchToken` (`dtk-…`, authorization artifact — [research §R3](../research.md)) and zero credentials; it joins the NFR-106 scan list (add, never exempt).

## 2. Reconciliation sequence (panel `app.ts` mount order)

```text
mount
  ├─ load ledger, bindings, state                      [unchanged]
  ├─ reconcile():                                       [NEW — must complete before any claim]
  │     for each stored attempt with acknowledged === false:
  │         POST …/dispatched  (or …/abandon) with the stored correlationId/attempt/dispatchToken
  │         2xx  → acknowledged := true                [idempotent: duplicate → dispatch.duplicate-report]
  │         4xx  → keep unacknowledged; record the refusal copy for the panel note
  │         total wall time bounded (RECONCILE_BUDGET_MS = 5,000 across all attempts)
  │         bound exceeded / service unreachable → visible warning naming the run(s) — never a silent skip
  └─ startRelayPolling()                                [first claim happens here, after reconciliation]
```

**FR-025's three clauses, pinned**:

| Clause | Contract answer |
| --- | --- |
| "report every dispatch attempt it recorded but has not seen acknowledged" | the loop above; the set is exactly `acknowledged === false` records, each with an outcome by construction (§1) |
| "before it issues its first claim" | `reconcile()` is awaited in `app.ts` before `startRelayPolling()`; a test asserts no `GET /v1/events/pending` happens until reconciliation settles (AC-111) |
| "idempotent: a repeated report of an already-reconciled attempt MUST change no state and MUST add exactly one audit row recording the repeat" | a repeat of a *consumed* token with the identical outcome answers 200 unchanged and writes exactly one `dispatch.duplicate-report` row per repeat (dispatch-authorization §2) — nine repeats ⇒ nine rows, zero state changes |
| "bounded in time … a bounded failure MUST surface as a visible warning" | `RECONCILE_BUDGET_MS`; on bound or transport failure the panel renders a warning naming each unacknowledged run and continues to claim (reconciliation failure must not wedge the panel), with the attempts staying unacknowledged for the next mount's retry |

## 3. What reconciliation can and cannot conclude

| Stored record | Report | Service verdict |
| --- | --- | --- |
| `outcome: 'dispatched'` | Result with the session id | run reconciles to `dispatched` — even from `unconfirmed` or a re-opened `pending` (dispatch-authorization §2 matrix: unconsumed token, no newer attempt ⇒ applied) — **exactly one session ever existed** (US3 AC-111) |
| `outcome: 'failed'` | Abandon (or Result with the stored problem) | run → `failed`, retryable (FR-026) |
| no record at all (crash before the record write, or wiped storage) | **nothing is reported** | reservation ages into `unconfirmed` (FR-023); the panel does not invent an outcome, does not re-dispatch, and the operator resolves through FR-027 with project + worktree option + attachment id displayed (US3 AC-111's second scenario) |
| record present, run already terminal with a different outcome | Result as stored | 409 `invalid-transition` (conflicting evidence) + `dispatch.refused` row; the panel surfaces the verdict, never retries automatically |

## 4. Invariants (tests)

1. Mount order: reconciliation completes before the first claim (fake service records call order) — AC-111.
2. Repeat reconciliation against an already-reconciled attempt: zero state changes, exactly one `dispatch.duplicate-report` per repeat — FR-025.
3. Bounded failure: service answering 503 throughout ⇒ visible warning naming the run, panel still reaches its polling loop, no exception escapes — FR-025.
4. Wiped-storage permutation: empty `mecha-turk:dispatches` + service-side `unconfirmed` ⇒ no `host.startSession()` call in the harness, run untouched (crash-permutation suite, NFR-102).
5. Ordering: instrumented `host.startSession` asserts the attempt record write precedes the result POST for every successful dispatch — FR-024.
