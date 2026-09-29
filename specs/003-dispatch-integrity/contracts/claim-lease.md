# Contract: Claim & Lease (`GET /v1/events/pending`)

**Spec**: 003 FR-030, FR-031, FR-036, FR-037 · wire-delta row **Claim** · supersedes 002 contract §2.4's long-poll shape

The claim is the only way a panel acquires the right to attempt a dispatch, and eligibility is the **service's alone** (FR-037). The path is unchanged; the answer changes from "every `pending` queue row, flipped `in-flight`" to "every run in `pending`, each under a fresh lease".

## Request

```http
GET /v1/events/pending?holder=<mountId>
Authorization: Bearer <service token>
```

| Piece | Rule |
| --- | --- |
| `holder` | **new, optional query parameter.** The panel's opaque per-mount id: `[A-Za-z0-9._~-]{1,64}`, generated in memory at mount (never persisted, never a secret). Recorded on the lease and in `dispatch.claimed` so "who holds it" is answerable (FR-030). **Informational only** — authorization always rides the lease id and, later, the token; an absent or forged holder changes nothing about eligibility. Omitted → `holder: "unknown"` on the lease |
| `limit` | **new, optional query parameter** (T-039). The most runs this call may offer, as a decimal integer `1…MAX_CLAIMED_RUNS` (`50`). Absent → the cap. The cap is the **service's**, not the caller's: a limit above it is a request this answer could never satisfy, so it is refused (§Refusals) rather than clamped, echoed, or served as though it could. Everything the limit excludes stays `pending` and unleased. |
| Method/path | unchanged; query strings are already excluded from service logs (pipeline logs the pathname only) |

## Response `200`

```jsonc
{
  "events": [ /* ClaimedRun[] — at most one entry per claimable run */ ],
  "status": [ /* BindingStatusRow[] — unchanged member, counts derived from runs */ ],
  "auditWritten": true | false   // FR-063: did every dispatch.claimed row reach the trail?
}
```

The `events` member name is **retained** (additive-within-v1, 005's L3 retention); its entries are now **run rows**, not delivery rows. `auditWritten` is additive: `false` means the leases are durable and the rows are not, and the panel surfaces a visible warning naming the runs rather than implying traceability it does not have (FR-063).

### ClaimedRun (the claim projection)

| Field | Type | Notes |
| --- | --- | --- |
| `correlationId` | string | run identity on the wire; every later call is addressed by it (`mt-run-…`, one path segment) |
| `runKey`, `ordinal`, `attempt` | string / number / number | human-readable key; ordinal; the attempt this lease is issued under (FR-010, FR-030) |
| `lease` | `{ leaseId, attempt, issuedAt, expiresAt, holder }` | the claim itself (FR-030): id, attempt, issue time, expiry, holder. `expiresAt = now + leaseMs` (service clock; config `leaseMs`, default 120,000 ms, 30,000–600,000) |
| `state` | `"pending"` | always — nothing else is ever offered (FR-037) |
| `bindingId`, `repository`, `accountLogin`, `projectId`, `worktreeOption` | string | what the panel needs to guard and dispatch (002 FR-005/FR-013 shape) |
| `subjectType`, `issueNumber`, `issueTitle`, `issueUrl`, `headSha?`, `baseRef?` | … | subject coordinates; PR fields present for review-origin runs |
| `attachmentId` | string | = `correlationId`; the panel uses it verbatim as `startSession().id` (FR-029) |
| `sourceReferences[]` | `{ deliveryId, kind, origin, sourceUrl, detectedAt, excerpt, presentAtAuthorization }[]` | **every retained reference, in join order, with FR-013's full detail — the list is never shortened to fit the answer** (FR-014). Capped at `MAX_SOURCE_REFERENCES = 200` **on the run** (product-owner ruling 2026-09-28, T-038), with `referenceCount` (the **total** that ever joined), `referencesTruncated`, and `referencesNotRetained` (how many were **not** retained) beside it. `excerpt` is the bounded trigger text the context builder needs — claim-transport only, never re-stored on the run |
| `excerpt` markers | string | two explicit markers, both plain text, so the panel can tell them apart without re-deriving either: `… [truncated]` on an excerpt that was **cut** to its per-reference bound (600 chars, the bound the trigger layer already writes), and `[excerpt omitted: the claim answer carried this reference without its text]` on a reference whose excerpt did not fit the per-run budget (`RUN_EXCERPT_MAX_CHARS = 12,000`, FR-014's own per-dispatch figure). A genuinely empty excerpt (an issue with no body) is neither |
| `issueBodyExcerpt` | string | the primary subject excerpt (legacy field the panel's context builder already reads) |
| `detectedAt` | string | earliest source reference's detection stamp (row age) |
| `stateReason` | string | why it is waiting (rendered as the row's reason line, FR-074) |

### Counting the references an operator reconciles

`dispatch.claimed`'s `sourceReferenceCount` is the **retained** count — the length of the `sourceReferences` array the answer actually carried. The run's own `referenceCount` is the **total** that ever joined. **At and after the overflow the two differ, and that difference is not a bug**: it is exactly what `referencesNotRetained` records. An operator reconciling them reads the retained count against the answer and the total against the run row, and the gap between them is the not-retained count. Below the cap all three are the same number.

### Semantics

1. **Atomic batch**: all eligible runs transition `pending → claimed` in one queue-chain task; two panels calling concurrently receive disjoint sets, and the second receives what remains (possibly `[]`) — it is never handed a run the first one holds.
2. **Eligibility** (FR-037): only `state === 'pending'`. Never `claimed`, `starting`, `failed`, `blocked:*`, `unconfirmed`, and **never** a run that has a recorded session (`dispatched` or any run whose `session != null`), under any condition — including a replay, a reset, or corrupted panel state.
3. **Attempt on claim**: the lease carries the run's **current** `attempt` (it does not increment it). The increment belongs to expiry, retry, and resolve — see data-model §1 and plan "Attempt counting", which is why `dispatch.lease-expired` can report a meaningful before/after.
4. **Nothing else changes**: no token is minted here (FR-021 — authorization comes only from Reserve), no attempt is consumed by being offered (FR-036: a panel that never claims, or claims nothing, burns nothing), and delivery rows are not touched.
5. **Audit**: one `dispatch.claimed` row per claimed run — actor `panel`, entity the run, details `{ leaseId, attempt, leaseExpiry, sourceReferenceCount, holder }`, correlation = the run's id (FR-060).

### The answer is bounded, and the bound is pagination (T-039)

The answer is **projected and measured before anything is leased**, and two documented bounds stop the page:

| Bound | Value | What it stops |
| --- | --- | --- |
| `MAX_CLAIMED_RUNS` | `50` | the number of runs one call may lease, however small each one is |
| `CLAIM_EVENTS_BUDGET_CHARS` | `256,000 − 65,536 = 190,464` | the serialized size of the `events` member — derived from the transport's own response ceiling (`GUEST_REQUEST_RESPONSE_MAX`), with a documented reserve for the `status` member and the envelope |

Runs are added in document order until one of the bounds trips. **Nothing is dropped**: every eligible run past the bound stays `pending` with **no lease**, is not audited, and is answered by the panel's next call on its own clock. That is contract §1's "paginate, never truncate", and it is the whole reason the order is *project, measure, then lease* — the alternative writes a durable lease for a run the transport then refuses to answer, and the stranded run burns an attempt and a unit of the automatic requeue budget on every pass until it dead-letters (FR-032, FR-033).

The `status` member carries the true per-binding `pendingCount`, so a panel can see that more work is waiting without the lease burning.

## The lease id is a fencing token, not a capability

The lease id (`lse-…`, or `migration-…` for the synthetic lease adoption mints) is a **fencing/consistency token**. It is **not** a capability and carries no authority:

- **The service's bearer token is the only authentication gate.** Every operation on `/v1/events/*` is authenticated by it; the lease id is never sufficient for anything.
- **The single-use dispatch token is the only authorization to start a session** (FR-020, FR-021). Holding a lease id cannot start one.
- **The lease id is a deterministic function of answer-visible inputs** — the run's correlation id, the attempt, and the service clock — so an operator reading `dispatch.claimed` can recompute it from the answer, and a stored value that does not match is refused by the store's parser. `provenance` is a **typed lease member** (`panel` | `migration`), not a naming convention inside the id; the parser accepts exactly the two shapes this build mints and refuses everything else.
- **Its purpose is coordination**: which attempt's work the run is on, and when the sweep may recover it.

## Refusals

| Status | `code` | When |
| --- | --- | --- |
| `422` | `validation` | `limit` is present and is not a decimal integer in `1…MAX_CLAIMED_RUNS`. `issues[0].field = "limit"`, remediation names the cap, and the received value is **never echoed**. Refused **before** the run document is read, so no lease can exist |
| `503` | `storage-unavailable` | store unusable, **or the stored `runs.json` exists but cannot be read**. A quarantined or unreadable run document is a store that cannot serve run state — serving `[]` would report "nothing is waiting" for work the store cannot describe, which is the answer constitution II forbids |
| `401` | `unauthorized` | bearer failure (unchanged, byte-identical body) |

A claim has no per-run refusal surface: runs that fail eligibility are simply not in the answer (FR-037), which is itself the refusal.

## Invariants (contract tests)

1. Claiming twice with no dispatch between returns the runs once and `[]` the second time.
2. A seeded store containing `claimed`/`starting`/`dispatched`/`failed`/`unconfirmed`/`dead-lettered`/`blocked:*` runs yields **none** of them in a claim answer (FR-037).
3. A run whose `session` is set is never offered even if its state were mis-seeded to `pending` (FR-037's "under any condition" clause, tested directly).
4. Two concurrent claims partition the pending set — union = all pending, intersection = empty (single chain task).
5. `lease.expiresAt - issuedAt === leaseMs` from `GET /v1/config`; the sweep reclaims exactly at expiry (cross-checked in sweep suite).
6. The claim answer contains no credential-shaped string and no field the projection does not list (NFR-106).
7. **The answer is bounded** (T-039): the measured shapes that used to exceed the response ceiling — two runs with 200 retained references each, and 300 single-reference runs — both answer `200` under `CLAIM_EVENTS_BUDGET_CHARS`, and the remainder stays `pending` and unleased.
8. **No lease is stranded**: a run the answer omits has `lease === null`, an unchanged attempt, and an unchanged requeue budget, and no `dispatch.claimed` row exists for it.
9. **Excerpt markers round-trip**: both markers survive serialization unchanged, and every retained reference keeps FR-013's identity fields whichever marker its excerpt carries.
10. **A claim that leases nothing takes no write** (T-040d): with nothing waiting, the route performs no store write at all, and the document read happens outside the exclusive chain.
