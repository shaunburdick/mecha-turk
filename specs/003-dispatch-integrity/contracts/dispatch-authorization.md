# Contract: Dispatch Authorization & Run Operations

**Spec**: 003 FR-020–FR-029 (authorization), FR-033/FR-041/FR-042 (operator actions), FR-043 (verification) · wire-delta rows **Reserve, Result, Abandon, Retry, Resolve** + the two operations the Audit Vocabulary implies (Block report, Verification report) and FR-033's Requeue

Every operation below is **run-scoped**: the path segment is the run's **correlation id** (`mt-run-…`), not a delivery id (wire delta: "Addressed by the run, not the delivery"). Paths keep their existing suffixes where they exist (`/dispatched`, `/retry`); new operations take verb suffixes under the same `/v1/events/:correlationId/` prefix. Co-ship assumption: [README](./README.md).

**Common body fields**: `correlationId` (echo of the path id — FR-051) on every operation, and `attempt` **where the section's body carries it (§1–§6)**, plus `leaseId` / `dispatchToken` where a section states them. §7 and §8 declare neither an attempt nor a lease: their request shapes below are the whole of what they require, and requiring a member they do not carry would be a wire change this contract does not ask for. The service validates **all** of what a section names; a mismatch of any is a refusal, never a partial apply.

---

## 1. Reserve — `POST /v1/events/:correlationId/reserve`

**Declare intent to start a session; receive the single-use dispatch token.** FR-021, FR-022; wire-delta row *Reserve*.

```jsonc
// request
{ "correlationId": "mt-run-…", "leaseId": "lse-…", "attempt": 1 }
// 200 response
{ "correlationId": "mt-run-…", "attempt": 1,
  "dispatchToken": "dtk-<sha256(runKey|attempt) hex[0:32]>",
  "tokenExpiresAt": "<RFC3339 — the lease the reservation was made under>",
  "resultDeadlineAt": "<RFC3339 — now + resultDeadlineMs, the moment the sweep wedges the run>",
  "state": "starting" }
```

`tokenExpiresAt` and `resultDeadlineAt` answer different questions and both are
returned so neither can be mistaken for the other: the **lease** says when the
*claim* dies, the **deadline** says when the *authorization* is reported or
wedged. The authorization outlives the lease — a report is judged against the
reservation, not the claim (§2) — so a panel reading only `tokenExpiresAt` would
conclude its token dies at that instant, skip the report, and strand the run in
`unconfirmed`.

**Service actions, in order, inside the queue chain**: validate **no recorded
session** → validate lease (exists, matches, unexpired, holder irrelevant) →
validate no live reservation → validate run state `claimed` → mint token
deterministically (data-model §2.2) → persist
`reservation { dispatchToken, attempt, reservedAt, now+resultDeadlineMs,
consumed:false }`, state `starting` → write `dispatch.reserved` (details: lease
id, attempt, token, attachment id) → answer.

The order is the verdicts' precedence, and each move exists because the obvious
order made a documented refusal unreachable: the **session** check runs first
because an applied result clears the lease, so a real `dispatched` run holds no
lease — read the lease first and FR-022's "the refusal MUST name the existing
session" (AC-112) could never fire. The **reservation** check runs ahead of the
state check for the same reason: a `starting` run is not `claimed`, so reading
the state first would answer `invalid-transition` where the table promises
`already-reserved`. `invalid-transition` remains the answer for every other
live-lease state.

| Refusal | Status | `code` | Distinct reason (FR-022) |
| --- | --- | --- | --- |
| lease unknown / expired / for another attempt | 409 | `stale-lease` | "the lease is expired or does not match this run" — **the panel must not call `host.startSession()` after this** (AC-109) |
| run already holds a live reservation | 409 | `already-reserved` | names the reservation's attempt and deadline; one run holds at most one live authorization |
| run already has a recorded session | 409 | `already-dispatched` | **names the existing session id** (FR-022, AC-112) |
| run not in `claimed` | 409 | `invalid-transition` | names the current state (`pending`, `starting`, `dispatched`, `failed`, `unconfirmed`, `dead-lettered`, `blocked:*`) |
| unknown run / bad id shape | 404 | `unknown-run` | unchanged catalog |

A refused reserve never writes `dispatch.reserved` (no reservation exists); it writes the single **refusal row** described in §9. `dispatch.reserved` is written only on the 200 path (FR-003, FR-060).

**Result deadline**: `now + resultDeadlineMs` (config; default 120,000 ms, 30,000–600,000). After it passes, the sweep moves the run to `unconfirmed` — never back to waiting (FR-023).

> **004's additive delta (built)**: `dispatch.reserved`'s `details` gain four
> required keys — `bindingId`, `promptPresent`, `promptFingerprint`,
> `promptLength` — written by the service from the run's own snapshot, never
> from the request body. No existing detail key is renamed or removed, the
> entity stays the run, and the correlation id stays the run's id (FR-062: the
> fingerprint is derived from the prompt text, never minted per row).
> Authoritative text:
> [`004-starting-prompt/contracts/dispatch-prompt.md`](../../004-starting-prompt/contracts/dispatch-prompt.md) §3.

---

## 2. Result — `POST /v1/events/:correlationId/dispatched`

**Report the outcome of the attempt** (the host call happened). Wire-delta row *Result*; FR-024's report leg; FR-040.

```jsonc
// success shape
{ "correlationId": "mt-run-…", "attempt": 1, "dispatchToken": "dtk-…", "sessionId": "ses_…" }
// no-session shape (host call completed, returned no session)
{ "correlationId": "mt-run-…", "attempt": 1, "dispatchToken": "dtk-…", "problem": "bootstrap-failed" }
// 200
{ "correlationId": "mt-run-…", "state": "dispatched" | "failed", "auditWritten": true }
```

**Service actions**: validate token against the run's recorded reservation (see staleness matrix) → apply outcome: `sessionId` non-empty → `dispatched` (terminal, SessionRef stored); `problem` → **`failed` with the cause** (never `dispatched` — FR-040) → consume the reservation → append the attempt record → write `dispatch.result` (`decision: dispatched|failed`, attempt, token, sessionId **or** failure reason).

> **004's additive delta (built)**: `dispatch.result`'s `details` gain the
> same four required keys — `bindingId`, `promptPresent`, `promptFingerprint`,
> `promptLength` — from the run's snapshot, beside the existing `attempt`,
> token fingerprint, and `sessionId` **or** failure reason. No existing detail
> key is renamed or removed. Authoritative text:
> [`004-starting-prompt/contracts/dispatch-prompt.md`](../../004-starting-prompt/contracts/dispatch-prompt.md) §3.

### Staleness / idempotency matrix (plan D7 — this is the heart of AC-109/AC-110/AC-112)

| Condition | Answer | Audit |
| --- | --- | --- |
| token not recorded on this run | 409 `stale-lease` | refusal row |
| token carried by the **live** reservation, but an **earlier** attempt record already closed it — a dead-letter return (§7) re-mints byte-identical bytes, so a report from the spent chain and this one's own report are indistinguishable on the wire | 409 `stale-lease` | refusal row (the attempt history, not the reservation, tells the chains apart; AC-110) |
| token already consumed, **identical** outcome | **200**, state unchanged | `dispatch.duplicate-report` (`no-change`, attempt, token, the state it repeated) — exactly one row per repeat (FR-025 idempotency, edge case "report arriving twice") |
| token already consumed, **different** outcome | 409 `invalid-transition` | refusal row (a session id can never be overwritten by a problem, nor swapped) |
| token recorded, unconsumed, run in `starting` (lease may have expired — the reservation, not the lease, authorizes a *report*) | **200**, applied | `dispatch.result` |
| token recorded, unconsumed, run `unconfirmed` | **200**, applied — run reconciles to its recorded outcome instead of staying open (FR-025, edge case "result after the run was requeued but before a new claim") | `dispatch.result` |
| token recorded, unconsumed, run holds a **newer** reservation or a newer attempt (superseded) | 409 `stale-lease` | refusal row (a slow panel can never overwrite a newer attempt — AC-109) |
| run already `dispatched` with this session | 200 (idempotent) | `dispatch.duplicate-report` |

`auditWritten: false` in a 200 means the state change is durable but the lifecycle row failed to append — the panel surfaces a visible warning naming the run; the state is **never** rolled back (FR-063, AC-119).

---

## 3. Abandon — `POST /v1/events/:correlationId/abandon`

**A reserved attempt that created no session because the panel aborted after reserving** (guard discovered post-reserve, host call never made). Wire-delta row *Abandon*; FR-026.

```jsonc
{ "correlationId": "mt-run-…", "attempt": 1, "dispatchToken": "dtk-…", "reason": "project unresolved after reserve" }
// 200 → { "state": "failed", … }
```

Run → `failed` with the reason, reservation consumed, **retryable** (FR-041), audit `dispatch.abandoned` (`no-session`, attempt, token, reason). Same staleness matrix as Result (it is a result report whose outcome is *no session*). Distinguished from Result's `problem` shape by *when it is true*: Result = the host call happened and returned nothing; Abandon = no host call happened. Both end in `failed`; both are honest (FR-040, FR-026).

---

## 4. Block report — `POST /v1/events/:correlationId/blocked`

**A fail-closed guard refused the dispatch before any host call.** FR-042; audit `run.blocked` is actor **panel**, which requires this report.

```jsonc
{ "correlationId": "mt-run-…", "leaseId": "lse-…", "attempt": 1,
  "blockedReason": "project-missing" | "binding-missing" | "credential" | "policy",
  "detail": "project \"prj_9\" is not registered in OpenChamber",
  "guidance": "register the project in OpenChamber, then retry" }
// 200 → { "state": "blocked:project-missing", … }
```

Valid **only from `claimed` with the live lease** (a guard runs after claim, before reserve); lease rules as in Reserve. Run → `blocked:<reason>` with `stateReason = detail`; `attempt` unchanged (a guard refusal consumes nothing — gate Q3); audit `run.blocked` (`blocked`, blocked reason, prior state, guidance offered). Retryable only once the cause clears (§6). `blockedReason` is validated against the four-value set so states stay parseable (data-model §2.2).

---

## 5. Verification report — `POST /v1/events/:correlationId/verification`

**Post-dispatch agent read-back result** (FR-043; audit `agent.verified` / `agent.mismatch` / `agent.uncompared` are panel-actor rows and the audit trail is service-owned).

```jsonc
{ "correlationId": "mt-run-…", "attempt": 1, "sessionId": "ses_…",
  "observedAgent": "project-manager" | null, "expectedAgent": "project-manager" | "",
  "baselineProvenance": "configured" | "defaulted" | "unset",
  "ok": true | false, "note": "agent differs from the expected baseline" | null }
// 200 → { "state": "dispatched", "verification": { … } }   // state never changes here
```

Valid only for a run with a recorded session whose id matches. `baselineProvenance` is **required** and is checked against `expectedAgent`'s emptiness, fail closed: `configured` exactly when the baseline is non-blank, `defaulted` or `unset` exactly when it is empty — a body that claims otherwise (or omits the member, or names a value outside the three) is a `422` naming `baselineProvenance`, never a partially applied report (002 FR-029 case (ii); FR-051). The three words are 002's own: `configured` = a real value was read, `defaulted` = the config document could not be read, `unset` = it was read and found blank.

The row written is chosen by **whether a comparison was possible**, never by whether an agent was seen:

| `expectedAgent` | `ok` | Row | Decision |
| --- | --- | --- | --- |
| non-blank | `true` | `agent.verified` | `verified` |
| non-blank | `false` | `agent.mismatch` | `warn` |
| `""` — whatever `ok` says | — | `agent.uncompared` | `observed` |

All three carry details `{ sessionId, observedAgent, expectedAgent, note }`; `agent.uncompared` additionally carries the required `baselineProvenance`, and its `expectedAgent` is the **empty string** — the absence itself, never a name the operator never chose. A blank baseline therefore cannot produce `agent.mismatch`, even when the read-back itself failed: with `observedAgent: null` and the `note` naming the timeout, the row still says *not compared*, because there was nothing to differ from. Every report stores `run.verification` for the run-history projection and **changes no state** — warn-only: a mismatch never blocks, kills, or gets further automated handling (FR-043, AC-125), and an uncompared read-back warns about nothing at all — it is evidence, not a verdict.

---

## 6. Retry — `POST /v1/events/:correlationId/retry`

**Operator retry of a failed or blocked run under the same run key.** FR-041; wire-delta row *Retry*.

```jsonc
{ "correlationId": "mt-run-…", "attempt": 2 /* the run's current attempt */,
  "causeCleared": true, "causeReport": "project resolves again (checked this mount)" | null }
// 200 → { "state": "pending", "attempt": 3, … }   // attempt incremented server-side
```

| From | Answer |
| --- | --- |
| `failed` | 200 → `pending`, `attempt += 1`, reservation + lease cleared, source references and prior attempt records preserved, same run key, audit `dispatch.retry` (`retry`, prior state, attempt before/after, `causeReportedCleared`) |
| `blocked:<reason>` where the service can corroborate the cause (`binding-missing`: the binding exists again) | 200 as above, reason recorded as corroborated |
| `blocked:<reason>` where only the panel can check (`project-missing`: `listProjects()` now resolves) | 200 with `causeReport` audited as **reported** cleared — the vocabulary's own wording ("cause reported cleared"); the service cannot call host APIs (002 architecture), so the panel's same-mount check is the evidence and it is audited as evidence, not as proof |
| `pending` | 409 `invalid-transition` — "already waiting" (distinct reason) |
| `dispatched` | 409 `invalid-transition` — "already dispatched; a dispatched run cannot be retried" (distinct reason) |
| `unconfirmed` | 409 `invalid-transition` — "resolve this run instead" (distinct reason; the two resolutions are the only paths — FR-027) |
| `claimed`, `starting` | 409 `invalid-transition` — "an attempt is in flight" |
| `dead-lettered` | 409 `invalid-transition` — "use return-to-waiting" (§7), so the attempt **reset** is never taken by accident |

A refused retry consumes nothing and writes one refusal row (AC-113; 005 will render these three verdicts verbatim).

---

## 7. Requeue (return to waiting) — `POST /v1/events/:correlationId/requeue`

**The single control that resolves a dead-lettered run.** FR-033 (select-then-act idiom in 003; the per-row affordance is 005's).

```jsonc
{ "correlationId": "mt-run-…", "confirm": true }
// 200 → { "state": "pending", "attempt": 1, "requeuesUsed": 0, … }
```

Valid only from `dead-lettered` (else 409 `invalid-transition`). **Resets `attempt` to 1 and `requeuesUsed` to 0** (FR-033: "with the attempt count reset"), clears lease/reservation, keeps source references and attempt history, writes `dispatch.retry` with `priorState: "dead-lettered"` and details naming the reset.

Token-consumption scoping across the reset: [research](../research.md) §R3 / plan D6 — consumption is recorded on the attempt history, and **the history survives the reset**. Because FR-020 pins the token to `sha256(runKey|attempt)`, the reset's attempt 1 re-mints chain 1's byte-identical bytes, so a token whose record already closed can never authorize a report again — not even inside the new chain (§2's second row). Reserve still works: it consults no history, which is what keeps this control from dead-ending a run. The reset itself is the audit row that makes the boundary legible; what makes it *safe* is that the boundary does not un-spend anything.

---

## 8. Resolve — `POST /v1/events/:correlationId/resolve`

**The operator's two explicit resolutions of an `unconfirmed` run.** FR-027; wire-delta row *Resolve*; operator-confirmed only, never automatic.

```jsonc
{ "correlationId": "mt-run-…", "decision": "session-created", "sessionId": "ses_…",
  "note": "found in OpenChamber's session list by attachment id" }
// or
{ "correlationId": "mt-run-…", "decision": "no-session",
  "note": "no session with that attachment id" }
// 200 → { "state": "dispatched" | "pending", … }
```

| Decision | Effect | Audit |
| --- | --- | --- |
| `session-created` (naming it) | run → `dispatched` (terminal), SessionRef stored from the supplied id, reservation consumed | `dispatch.resolved` (`dispatched`, prior state, note, **the guidance the operator was shown** — project, worktree option, attachment id) |
| `no-session` (safe to dispatch again) | run → `pending`, `attempt += 1`, reservation cleared — **the only path that re-dispatches an `unconfirmed` run** (FR-027) | `dispatch.resolved` (`no-session`, prior state, note, guidance) |

Only from `unconfirmed` (else 409 `invalid-transition`). The panel must present a confirmation stating *what is being asked of the operator to verify* and must warn that a session may still exist, naming project + worktree option + attachment id (FR-027, FR-029). The service records the decision it is told; the honesty of the operator's check is the operator's, and the row says who decided.

---

## 9. The refusal row — `dispatch.refused`

**FR-003 requires an audit row for every refusal in this specification**, while `## Audit Vocabulary`'s seventeen types each describe a *successful* transition or its dedicated outcome (a refused reserve is not a `dispatch.reserved`; a refused retry is not a `dispatch.retry`). One additional type carries them, so the seventeen stay exactly as specified:

| `eventType` | Actor | Written when | `decision` | required `details` |
| --- | --- | --- | --- | --- |
| `dispatch.refused` | `service` | a **state verdict** (`409`) on a run that exists, or a **`422`** whose path names a run that exists | `refused` | attempted operation, refusal `code`, prior state, attempt (and lease/token reference when the refusal was a staleness verdict) |

The row set is deliberately narrower than "any `4xx`". A state verdict is
refused inside its operation module, which reads the run and owes the row; a
`422` is refused in the route layer before any operation runs, so the route
reads the run for `priorState` and `attempt` inside the chain and then writes the
same row — that is the whole of what "a `422` on an existing run" adds. Two `4xx`
answers write nothing, both because **there is no run to name**: `404
unknown-run` (no entity, no prior state, no attempt), and a `422` whose path id
is not a run this service holds. Neither invents an entity to attach a row to.

Rules: entity = the run, correlation = the run's id, reason = the same secret-free cause the response carries (never the token, never a received value beyond the identifiers), exactly one row per refusal. **Scope reading**: a refusal *by the panel* that never reached the service (FR-035's "do not dispatch what was not offered") changes no run and is recorded in the panel's ledger for that mount — the service cannot audit a request it never received, and inventing a report call for a no-op would add a wire operation the spec does not ask for. Panel refusals that *do* change a run already have their own vocabulary row (`run.blocked`), and operator-facing refusals the service answers (`retry`, `resolve`, `requeue`, `reserve`, `result`) all land here.

## Naming a dispatch token in a row: the fingerprint, never the value

**No audit row in this directory may carry a `dtk-` value** (FR-061; T-040c). An unconsumed dispatch token is a **live authorization to report a result**, `audit.ndjson` is operator-facing, and it is retained for months — so a row that embeds one stores a working capability in a file whose entire purpose is to be read.

Rows that must identify the authorization record it as a **fingerprint** instead:

| `details` member | Value |
| --- | --- |
| `dispatchTokenFingerprint` | `tokfp-<16 hex>` — `sha256(dispatchToken)` truncated to 16 hex characters, derived by the service and reproducible by it |

The fingerprint is derived from the **token value**, not from the run key, so it identifies *that* authorization: **within one attempt chain** two attempts mint two different tokens and therefore produce two different fingerprints, which is exactly what makes the row answer "which token was outstanding". **Across a dead-letter return (§7) that uniqueness does not hold**: the reset returns the run to attempt 1 and FR-020 pins the derivation to `(runKey, attempt)`, so chain 1's attempt 1 and chain 2's attempt 1 mint byte-identical bytes and therefore the *same* fingerprint. The row stays honest — it still names the authorization whose bytes were outstanding, and the `dispatch.retry` reset row beside it says where one chain ended — but the fingerprint does not distinguish the chains and must never be read as if it did. What distinguishes them is the attempt history itself, and what prevents a spent token from being reused is §7's spend check, not this identifier.

**The prefix is deliberately not `dtk-`.** A fingerprint that shared the token's prefix would be indistinguishable from a leaked token to the standing scan below and to an operator grepping the trail.

`SECRET_PATTERNS` is **not** extended to cover `dtk-`: 003 T-019 legitimately stores dispatch tokens in panel storage (`mecha-turk:dispatches`, data-model §3), so a redaction guard that refused them would break the feature it is meant to protect. The defence is the **scan**, not redaction — a test drives every audit-writing path this build has and asserts that **no** row written anywhere matches `/dtk-[0-9a-f]{8,}/`. `dispatch.unconfirmed` is the one row of the three Wave 2 ships that names a token; when Wave 3's rows are built, they name it the same way, and the same scan enforces it.

## What a dispatch token is: a non-secret sequencing value

A dispatch token is **derived from answer-visible inputs** — the run key and the
attempt number, both of which the claim answer already carries — and it guards
nothing **by secrecy**. Anyone who can read the claim answer holds the bytes, and
that is deliberate: FR-020 requires a deterministic derivation from exactly that
pair, so the token is reproducible by the service that minted it and by nobody
else who cannot see the answer.

**The service's bearer token is the only authentication gate.** This extends the
lease-id ruling already recorded in [`claim-lease.md`](./claim-lease.md): both ids
are coordination values, not capabilities, and the same reading applies to the
dispatch token's *protection* while not erasing what it *is*. It remains a live,
single-use authorization to report a result while its reservation is
unconsumed — §2's matrix is what spends it — and it is the panel's proof that the
service authorized this particular attempt.

**What actually prevents a second session is the state machine plus the
attempt-history spend check:**

1. §1's verdict order — session, lease, reservation, state — refuses an
   authorization a run could not already hold (FR-022, AC-112).
2. §2's staleness matrix refuses every report that is not the live reservation's
   own unconsumed token on the run's current attempt (FR-025, AC-109).
3. §7's spend check refuses any token the attempt history has already closed —
   which is what makes the byte-identical re-mint across a dead-letter reset
   harmless, and what an otherwise-correct reservation check cannot see (FR-020,
   FR-028, AC-110).

Secrecy is not on that list, so nothing treats the token as a secret:
`SECRET_PATTERNS` deliberately does not cover `dtk-` (003 T-019 stores tokens in
panel storage by design, and a redaction guard that refused them would break the
feature it protects), and the guarantee that no audit row carries one is the
**scan** described above rather than a redaction refusal. The two statements are
compatible by construction: the token is a live capability *and* a value whose
safety never depended on being unknown.

## Error-code additions to 002 contract §4

| HTTP | `code` | Meaning | Panel copy family |
| --- | --- | --- | --- |
| 404 | `unknown-run` | no run with this correlation id (new; `not-found` keeps its transport meaning) | "this run no longer exists — refresh" |
| 409 | `stale-lease` | expired / superseded / unknown lease-or-token on a *reserve*; unknown / superseded / **already spent by the attempt history** token on a *result*; and an **attempt-number mismatch** on any operation that validates the member — reserve, block report, retry, verification — where the run stands on a different attempt than the request names | "another attempt owns this run — nothing was started" (never retry automatically); the attempt-number mismatch carries the service's own message instead, and 005 renders both verbatim |
| 409 | `already-reserved` | reserve on a run holding a live reservation | "this run is already authorized to start" |
| 409 | `already-dispatched` | reserve on a run with a recorded session — **message names the session** | "a session already exists: `<id>`" |
| 409 | `invalid-transition` | existing code, widened: retry/resolve/requeue/result refusals, each with a **distinct message naming the source state** | quote the service's message verbatim (005 renders it) |
| 409 | `cause-not-cleared` | (retained from 002 §4; used when a blocked retry's corroborated cause still fails — e.g. binding still absent) | "the cause has not cleared: `<detail>`" |

No existing code changes meaning; `422 validation` continues to cover malformed bodies without echoing values.

## Invariants (contract tests)

1. **Impossibility (FR-028)** — for every operation: a session id is recorded for a run only when, at that moment, the run was `claimed`+token-live+lease-unexpired+attempt-current+no-session; the suite seeds each precondition violated in turn and asserts a refusal *before* any `host.startSession()` in the panel harness.
2. **One live authorization**: reserve → reserve (same run) ⇒ second refused; two panels, one live lease ⇒ the other panel's reserve is `stale-lease` (AC-109).
3. **Idempotency**: replaying an identical result 10× ⇒ one `dispatch.result` + nine `dispatch.duplicate-report` rows, state byte-stable (NFR-102).
4. **No zombie success**: `problem` results never yield `state: 'dispatched'` anywhere in the answer or the projection (FR-040, AC-113).
5. **Attempt discipline**: retry and resolve-no-session each increment exactly once; guard reports increment never; dead-letter return resets both counters (AC-106, gate Q3).
6. Every 2xx that changes state writes exactly one lifecycle row with the run's correlation id; every refusal writes exactly one row naming its cause (AC-115, AC-116, FR-003).
