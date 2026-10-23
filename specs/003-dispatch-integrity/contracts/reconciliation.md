# Contract: Reconciliation on Mount

**Spec**: 003 FR-024, FR-025, FR-026, FR-045, FR-046 · wire-delta consequence of **Result/Abandon** (there is no separate reconcile *operation* — reconciliation re-reports what the panel durably recorded, and surfaces what it cannot report)

The panel's durable attempt record and its mount-time report are two halves of one contract; both sides are specified here because the ordering between them is the defect this feature exists to fix (a lost report must never become a second session).

## 1. The panel's durable attempt record (panel ↔ `host.storage`)

Key `mecha-turk:dispatches` (existing prefix — AGENTS.md invariant 4), document `schemaVersion: 'dispatch-attempts-2'`, wiped on uninstall like every panel key. A stored `dispatch-attempts-1` document MUST still read: it holds no `unknown` outcome, so it is a valid v2 document.

```jsonc
{ "schemaVersion": "dispatch-attempts-2",
  "attempts": [
    { "correlationId": "mt-run-…", "runKey": "github|…|0", "attempt": 1,
      "leaseId": "lse-…" | null,
      "dispatchToken": "dtk-…", "projectId": "…" | null, "worktreeOption": "…" | null,
      "outcome": "unknown" | "dispatched" | "failed",
      "sessionId": "ses_…" | null, "reason": "…" | null,
      "authorizedAt": "RFC3339" | null, "recordedAt": "RFC3339",
      "settledAt": "RFC3339" | null, "acknowledged": false }
  ],
  "followUps": [ /* 002 FR-104 delivery records — unchanged by every write above */ ] }
```

`authorizedAt` is the **authorization** stamp and is `null` on a record read from a `dispatch-attempts-1` document; `recordedAt` is when the record was written or last given its resolved outcome. `settledAt` is written only on an `unknown` record whose attempt FR-045's audit evidence proves past. `sessionId` and `reason` are both `null` on an `unknown` record. `projectId` and `worktreeOption` are the run's dispatch target as the claim answered it, so the FR-025 warning can name them even when the run's row is not in the list the panel loaded. **Migration nullability:** `projectId`, `worktreeOption`, `settledAt` and `leaseId` are `string | null` and read `null` on a row read from a `dispatch-attempts-1` document; a v2 write from the intent writer always carries the run's project and worktree option, so `null` there means only "read from a v1 document" (the outcome writer's append, which has no record to copy from, is the one other case), and `null` in `settledAt` means only "not settled" — neither is ever guessed at, and neither makes a row unusable.

`leaseId` is the **reservation's** identifier, taken from the claim answer and required on a v2 write from the intent writer, and it reads `null` on a row that predates the member (a `dispatch-attempts-1` document, or a v2 row written before this amendment): it is what distinguishes two reservation cycles that reuse an attempt number, because neither the number nor the token can (the operator's return-to-waiting resets a dead-lettered run to attempt 1, and the dispatch token is deterministic over run key plus attempt). The intent writer is **idempotent for the same `(correlationId, attempt, leaseId)`** — a matching write succeeds without changing the record — and a record at the same `(correlationId, attempt)` carrying a **different** lease id is a new reservation cycle and is **replaced** by the new reservation's record, never refused: a refusal there would report "storage refused" when storage refused nothing.

**Write ordering (FR-024, FR-046, non-negotiable)**:

```
reserve ──▶ WRITE intent record (outcome "unknown", authorizedAt, projectId, worktreeOption)
                     │
                     ▼
          host.startSession() returns
                     │
                     ▼
   REPLACE the same record in place (outcome, recordedAt, sessionId|reason)
                     │
                     ▼
          POST result/abandon ──▶ 2xx ──▶ acknowledged := true
```

1. The intent record is written **after** the reservation answers and **before** `host.startSession()`. If it cannot be written, the panel calls `host.startSession()` **not at all** and abandons the reservation (FR-046), with the storage refusal as the abandon's reason. There is no third path. The budget and worktree floors run **after** the reserve and therefore after the intent write, so an intent record can exist for an attempt the panel then refuses before the host call: that record resolves to the failed outcome the refusal reports, and if the panel is torn down before it does, the warning **over-warns** — it names an attempt on which no session was ever attempted — and can never under-warn.
2. The resolved outcome **replaces** the record keyed by `correlationId` + `attempt` — it never appends a second record for one attempt. The writer finds that record by **its own lease identifier**, and when no record carries it, it looks at `(correlationId, attempt)`: **no record there at all** (evicted) is real evidence and is appended; **a record there carrying a different lease id** is a **superseded** reservation, whose outcome is **not persisted** — the outcome is still reported to the service and the panel's ledger already records it, and the service's own spent-token rule governs what it does with a late report. A superseded outcome stored beside the current cycle's record would be re-reported on every mount with a token the service refuses, and were it applied it would carry an earlier cycle's session into a later attempt. `authorizedAt` survives the replacement and `recordedAt` moves to the outcome write. The replacement happens **after the host call returns and before the result report is issued**, so every stored record with a resolved outcome is reportable. The intent writer's own key is `(correlationId, attempt, leaseId)`: the same reservation is idempotent, and a different lease at the same attempt is a new cycle whose record replaces the old one.
3. An `unknown` record is never POSTed as a result or an abandonment: the panel does not know the outcome, and either report would be a lie (FR-026). It is surfaced by reconciliation instead (§2, §3) — unless settlement has already written it down.
4. `acknowledged` flips only on a 2xx for that exact attempt (idempotent 200s count as acknowledged; a 4xx does not — the refusal row tells the operator why). When the outcome write failed but the report landed, the **acknowledging write carries the resolved outcome**, so no acknowledged record is left `unknown`; if that write also fails, the record stays unacknowledged and is settled on the next mount's evidence rather than being presented as resolved by the panel.
5. Every attempts-side write preserves the document's `followUps` records unchanged — the pre-amendment writers returned `{ schemaVersion, attempts }` and dropped them, which is the defect this amendment closes: the intent, outcome and acknowledging writers (`appendAttempt`, `acknowledgeDispatch`) all carry them (FR-024, T-046).
6. The record holds at most `MAX_RECORDED_ATTEMPTS = 50`; the cap evicts the oldest record that is **acknowledged or settled**, and never evicts a record that is both unacknowledged and unsettled (NFR-107). Settlement is what keeps an unknown record from being pinned against the cap forever.
7. The record contains a `dispatchToken` (`dtk-…`, authorization artifact — [research §R3](../research.md)) and zero credentials; it joins the NFR-106 scan list (add, never exempt).
8. **v1 → v2 reading rule.** A `dispatch-attempts-1` record has one stamp, `recordedAt`, which was the outcome write's time. Read as v2, `authorizedAt`, `projectId`, `worktreeOption`, `settledAt` and `leaseId` all read `null` — v1 recorded none of them, the reader MUST NOT invent one, and the migration nulls MUST NOT make the row unusable, so no surface may present `recordedAt` as an authorization time. No unacknowledged attempt is dropped, re-timestamped, or re-reported differently, and the next write stores the v2 shape.
9. **The reservation is the identity.** An attempt number is reusable and the token is deterministic over run key plus attempt, so neither identifies a cycle: the record's `leaseId` does. Its settle anchor is the `dispatch.reserved` row in the same read carrying that attempt **and** that lease id (§2).

## 2. Reconciliation sequence (panel `app.ts` mount order)

```text
mount
  ├─ load ledger, bindings, state                      [unchanged]
  ├─ reconcile():                                       [NEW — must complete before any claim]
  │     for each stored attempt with a resolved outcome and acknowledged === false:
  │         POST …/dispatched  (or …/abandon) with the stored correlationId/attempt/dispatchToken
  │         2xx  → acknowledged := true                [idempotent: duplicate → dispatch.duplicate-report]
  │         4xx  → keep unacknowledged; record the refusal copy for the panel note
  │     for each stored attempt with outcome === 'unknown' and settledAt === null:
  │         report nothing; settle it from the audit read, or add it to the visible warning (FR-025, FR-045)
  │         the audit read walks limit=200 pages by nextCursor until nextCursor is null
  │         a settle writes settledAt on the record, so this pass never repeats it
  │     total wall time bounded (RECONCILE_BUDGET_MS = 5,000 across all attempts and pages)
  │     bound exceeded / service unreachable → visible warning naming the run(s) — never a silent skip
  └─ startRelayPolling()                                [first claim happens here, after reconciliation]
```

**FR-025's clauses, pinned**:

| Clause | Contract answer |
| --- | --- |
| "report every dispatch attempt it recorded but has not seen acknowledged" | the first loop above; the reported set is exactly the `acknowledged === false` records **with a resolved outcome** |
| "MUST NOT report a record whose outcome is `unknown`" | the second loop adds such a record to the warning and posts nothing for it; resolved attempts in the same pass are still reported |
| "before it issues its first claim" | `reconcile()` is awaited in `app.ts` before `startRelayPolling()`; a test asserts no `GET /v1/events/pending` happens until reconciliation settles (AC-111, AC-135) |
| "idempotent: a repeated report of an already-reconciled attempt MUST change no state and MUST add exactly one audit row recording the repeat" | a repeat of a *consumed* token with the identical outcome answers 200 unchanged and writes exactly one `dispatch.duplicate-report` row per repeat (dispatch-authorization §2) — nine repeats ⇒ nine rows, zero state changes |
| "bounded in time … a bounded failure MUST surface as a visible warning" | `RECONCILE_BUDGET_MS`; on bound or transport failure the panel renders a warning naming each unacknowledged run and continues to claim (reconciliation failure must not wedge the panel), with the attempts staying unacknowledged for the next mount's retry |
| unknown attempts and the budget | an unknown record is surfaced, not reported; its settlement read is part of the same budget, and a budget that stops the walk leaves the warning saying the panel could not check |
| "a warning … naming the run … the project and worktree option … the attachment identifier" | the warning's **run list** — every unsettled run with its verdict — survives the banner's `MAX_WARNING_CHARS` bound intact and is never truncated away, so a second unresolved attempt still appears. Each run's detail line follows the run list, is individually bounded, and its tail may be cut visibly and point at that run's row in Dispatches, which shows those fields |
| settled records | a record whose `settledAt` is set is neither re-reported nor surfaced, on this mount or any later one |

**Settle predicate (FR-045).** For an unsettled `unknown` record at attempt *n*, the anchor is the `dispatch.reserved` row in the same read carrying attempt *n* **and** the record's `leaseId`. The correlation-filtered audit read `GET /v1/audit?correlationId=&limit=200&cursor=` must be **walked to exhaustion inside the reconciliation budget** (`nextCursor` chained, per [run-history-audit.md](./run-history-audit.md) §2) and return one of: `dispatch.result` or `dispatch.abandoned` naming *n* in `details.attempt` with a `seq` **after** that anchor; or a `dispatch.resolved` for the run whose `seq` is greater than that anchor's. A row whose attempt reference is absent or not a number is not evidence, and a `dispatch.reserved` row carrying a different lease id is not that record's anchor. **No anchor in the read means no evidence**: the warning stays and says the panel could not check, rather than guessing. The dispatch token cannot serve as the anchor — it is deterministic over the run key and attempt, so it is identical across two reservation cycles that reuse an attempt number. `AUDIT_ROW_LIMIT` (100) is the audit view's display cap and MUST NOT bound this read; the read's own bound is the route's 200. Evidence is ordered by the service's sequence and stated attempt numbers only — never by comparing the panel's clock with the service's (NFR-112). `dispatch.unconfirmed` is not evidence (FR-045). If the read fails, or the budget stops the walk before exhaustion, the record is not settled and the warning stays, saying the panel could not check — never a silent skip.

## 3. What reconciliation can and cannot conclude

| Stored record | Report | Service verdict |
| --- | --- | --- |
| `outcome: 'dispatched'` | Result with the session id | run reconciles to `dispatched` — even from `unconfirmed` or a re-opened `pending` (dispatch-authorization §2 matrix: unconsumed token, no newer attempt ⇒ applied) — **exactly one session ever existed** (US3 AC-111) |
| `outcome: 'failed'` | Result with the stored problem (or abandon) | run → `failed`, retryable (FR-026) |
| `outcome: 'unknown'` (`settledAt === null`) | **nothing is reported** | the run ages into `unconfirmed` if no result arrives (FR-023); the panel surfaces the attempt with the run, the two resolutions the row offers once `unconfirmed`, and the project and worktree option from the record with the attachment identifier derived from the correlation identifier, never re-dispatches it, and stops surfacing it when the settle predicate writes `settledAt` (FR-045) — a trim of the trail afterwards does not bring it back |
| `outcome: 'unknown'`, `settledAt` set | **nothing is reported, and nothing is surfaced** | the panel has recorded that the attempt is past, never what the host returned; the record stays `unknown` |
| no record at all (crash before the intent write, or wiped storage) | **nothing is reported** | reservation ages into `unconfirmed` (FR-023); the panel does not invent an outcome, does not re-dispatch, and the operator resolves through FR-027 with project + worktree option + attachment id displayed (US3 AC-111's second scenario) |
| record present, run already terminal with a different outcome | Result as stored | 409 `invalid-transition` (conflicting evidence) + `dispatch.refused` row; the panel surfaces the verdict, never retries automatically |

## 4. Invariants (tests)

1. Mount order: reconciliation completes before the first claim (fake service records call order) — AC-111.
2. Repeat reconciliation against an already-reconciled attempt: zero state changes, exactly one `dispatch.duplicate-report` per repeat — FR-025.
3. Bounded failure: service answering 503 throughout ⇒ visible warning naming the run, panel still reaches its polling loop, no exception escapes — FR-025.
4. Wiped-storage permutation: empty `mecha-turk:dispatches` + service-side `unconfirmed` ⇒ no `host.startSession()` call in the harness, run untouched (crash-permutation suite, NFR-102).
5. Ordering: instrumented `host.startSession` asserts the intent record exists before the host call and that its resolved outcome replaces it in place before the result POST — FR-024, AC-134.
6. Fail-closed intent: a refused intent write ⇒ zero `host.startSession()` calls, exactly one abandon carrying the storage refusal as its reason and a ledger entry naming it; the service's answer makes the run `failed` and retryable, and an unreachable service leaves it `unconfirmed` at the deadline — FR-046, AC-134.
7. Unknown is never reported: a torn-down record posts neither result nor abandonment while the other unacknowledged attempts are still re-reported — FR-025, AC-135.
8. Settling: `dispatch.result` / `dispatch.abandoned` naming the attempt with a `seq` after the anchor, or a `dispatch.resolved` sequenced after that anchor — the `dispatch.reserved` row carrying the attempt **and** the record's `leaseId` — writes `settledAt` and stops the warning; a remount after the trail is trimmed does not resurface it; `dispatch.unconfirmed` is not evidence; a row whose `details.attempt` is missing or not a number settles nothing; a reserved row with a different lease id is not the anchor; no anchor in the read, a failed read, or a budget that stops the walk leaves the warning saying the panel could not check — FR-045, AC-135.
9. Paging: a run whose correlation-filtered trail exceeds one page (more than 100 rows, the newest `dispatch.result` last) still settles, because the read walks `limit=200` pages to exhaustion inside the budget; a budget that stops the walk surfaces "could not check" instead of settling — FR-045, AC-135.
10. v1 reading: a stored `dispatch-attempts-1` document reads with every unacknowledged attempt intact, `authorizedAt` and `leaseId` null on every row, and no surface presenting `recordedAt` as an authorization time — FR-024, AC-134.
11. Follow-up preservation: an intent write and an outcome write over a document holding a follow-up record leave that record byte-identical — FR-024, AC-134.
12. Acknowledged-unknown repair: an outcome write that fails is carried by the acknowledging write when the report lands, so no acknowledged record is left `unknown` — FR-024, AC-134.
13. Reservation identity: after a dead-letter → return-to-waiting (attempt reset to 1) → claim → reserve, the new intent record replaces the prior cycle's at the same `(correlationId, attempt)` because its `leaseId` differs; the same `(correlationId, attempt, leaseId)` write is an idempotent success that changes nothing; and the prior cycle's `dispatch.result` does not settle the new record, because its `seq` precedes the new anchor — FR-024, FR-045, AC-134, AC-135.
14. Banner bound: two unsettled unknown records produce a warning carrying both runs and both verdicts, with each run's detail line individually bounded and pointing at that run's row — FR-025, AC-135. The Dispatches read is awaited before reconciliation, so the warning is not written against an in-flight read; because that read is one page of a possibly filtered set, absence from it is not by itself proof the row could not be read, so the detail line says the row is **not in the list this panel loaded** and points at it in Dispatches.
15. One record per attempt: the outcome writer replaces the record carrying its own lease id, appends only when no record exists at `(correlationId, attempt)` at all, and persists nothing when the record there carries a different lease id — the attempt still holds exactly one record, the current cycle's — FR-024, AC-134.
