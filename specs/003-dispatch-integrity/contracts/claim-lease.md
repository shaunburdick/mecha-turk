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
| Method/path | unchanged; query strings are already excluded from service logs (pipeline logs the pathname only) |

## Response `200`

```jsonc
{
  "events": [ /* ClaimedRun — at most one entry per claimable run */ ],
  "status": [ /* BindingStatusRow[] — unchanged member, counts now derived from runs */ ]
}
```

The `events` member name is **retained** (additive-within-v1, 005's L3 retention); its entries are now **run rows**, not delivery rows.

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
| `sourceReferences[]` | `{ deliveryId, kind, origin, sourceUrl, detectedAt, excerpt, presentAtAuthorization }[]` | capped at 20 with `referenceCount` + `referencesTruncated` siblings on the run (FR-013, plan D11). `excerpt` is the bounded trigger text (≤600 chars as detected) the context builder needs — claim-transport only, not re-stored on the run |
| `issueBodyExcerpt` | string | the primary subject excerpt (legacy field the panel's context builder already reads) |
| `detectedAt` | string | earliest source reference's detection stamp (row age) |
| `stateReason` | string | why it is waiting (rendered as the row's reason line, FR-074) |

### Semantics

1. **Atomic batch**: all eligible runs transition `pending → claimed` in one queue-chain task; two panels calling concurrently receive disjoint sets, and the second receives what remains (possibly `[]`) — it is never handed a run the first one holds.
2. **Eligibility** (FR-037): only `state === 'pending'`. Never `claimed`, `starting`, `failed`, `blocked:*`, `unconfirmed`, and **never** a run that has a recorded session (`dispatched` or any run whose `session != null`), under any condition — including a replay, a reset, or corrupted panel state.
3. **Attempt on claim**: the lease carries the run's **current** `attempt` (it does not increment it). The increment belongs to expiry, retry, and resolve — see data-model §1 and plan "Attempt counting", which is why `dispatch.lease-expired` can report a meaningful before/after.
4. **Nothing else changes**: no token is minted here (FR-021 — authorization comes only from Reserve), no attempt is consumed by being offered (FR-036: a panel that never claims, or claims nothing, burns nothing), and delivery rows are not touched.
5. **Audit**: one `dispatch.claimed` row per claimed run — actor `panel`, entity the run, details `{ leaseId, attempt, leaseExpiry, sourceReferenceCount }`, correlation = the run's id (FR-060).

## Refusals

| Status | `code` | When |
| --- | --- | --- |
| `503` | `storage-unavailable` | store unusable (unchanged from every store-backed route) |
| `401` | `unauthorized` | bearer failure (unchanged, byte-identical body) |

A claim has no per-run refusal surface: runs that fail eligibility are simply not in the answer (FR-037), which is itself the refusal.

## Invariants (contract tests)

1. Claiming twice with no dispatch between returns the runs once and `[]` the second time.
2. A seeded store containing `claimed`/`starting`/`dispatched`/`failed`/`unconfirmed`/`dead-lettered`/`blocked:*` runs yields **none** of them in a claim answer (FR-037).
3. A run whose `session` is set is never offered even if its state were mis-seeded to `pending` (FR-037's "under any condition" clause, tested directly).
4. Two concurrent claims partition the pending set — union = all pending, intersection = empty (single chain task).
5. `lease.expiresAt - issuedAt === leaseMs` from `GET /v1/config`; the sweep reclaims exactly at expiry (cross-checked in sweep suite).
6. The claim answer contains no credential-shaped string and no field the projection does not list (NFR-106).
