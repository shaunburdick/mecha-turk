# Contract: Run History & Audit Read

**Spec**: 003 wire-delta rows **Run history** and **Audit read** · FR-005, FR-015, FR-029, FR-040, FR-043, FR-053, FR-064

## 1. Run history — `GET /v1/events` (widened projection)

Read-only, never claims (unchanged behaviour), newest detected first, capped at `MAX_LISTED_EVENTS = 100` (unchanged — the cadence and pagination/filters of this list are 005's).

```jsonc
{ "events": [ /* RunHistoryRow[] */ ] }   // member name retained (additive-within-v1)
```

### RunHistoryRow

| Field | Type | Spec |
| --- | --- | --- |
| `id` | string | **the run's correlation id** (row key and the path segment every run operation takes; the old panel would 404 — co-ship assumption) |
| `state` | `pending \| claimed \| starting \| dispatched \| failed \| blocked:<reason> \| unconfirmed \| dead-lettered` | `## Dispatch State Model`; validated as prefix + non-empty reason for `blocked:` |
| `stateReason` | string | why the run sits there — rendered as the row's reason line (FR-074, NFR-108) |
| `runKey` | string | human-readable tuple (FR-010), shown beside the correlation id |
| `ordinal`, `attempt` | number | run ordinal; current attempt |
| `correlationId` | string | same value as `id` (explicit member for the panel's copy affordance, 005 FR-049; FR-053) |
| `attachmentId` | string | = correlation id; displayed so an operator can find the session (FR-029) |
| `projectId`, `worktreeOption` | string | the dispatch target, snapshotted (AC-124) |
| `leaseExpiresAt` | string \| null | live lease expiry, else `null` (wire delta) |
| `sourceReferences[]` | `{ deliveryId, kind, origin, sourceUrl, detectedAt, presentAtAuthorization }[]` + `referenceCount`, `referencesTruncated`, `referencesNotRetained` | FR-013/FR-015: the panel draws the primary label from the earliest reference, shows how many more reasons fired, and marks post-authorization references; excerpts are **not** projected here (untrusted text stays on the claim answer). `referenceCount` is the **total** that ever joined and `referencesNotRetained` is how many the 200-reference cap did not retain, so a row is never silently lossy (T-038) |
| `session` | `{ sessionId, attachmentId, dispatchedAt } \| null` | SessionRef pointer (FR-028's proof) |
| `verification` | `{ observedAgent, expectedAgent, ok, note } \| null` | FR-043 — visible on the row, mismatch renders as a warning (AC-125) |
| `kind`, `repository`, `issueNumber`, `issueTitle`, `issueUrl`, `detectedAt`, `bindingId`, `headSha?`, `baseRef?` | as shipped | identity/age fields the existing row already renders |
| `dispatchResult` | string \| null | retained: session id or recorded cause (existing field; `failed` runs carry their cause here too) |

Credential-free by construction: nothing in the projection is or can be a credential (002's `EventRunRow` discipline extended field-by-field).

**Legacy rows**: none reach this endpoint — every stored queue row has been adopted into a run before the service answers (data-model §1). A pre-003 *panel* would not parse the new states; the co-ship assumption makes that impossible.

**004's additive delta (not built here)**: prompt presence / fingerprint / length join this row when 004 lands (003 v1.1.0 record — no field above is renamed, retyped, or removed by that addition).

### Refusals

`503 storage-unavailable` only (a read claims nothing and can refuse nothing else).

## 2. Audit read — `GET /v1/audit` (new)

Implements the row 002 contract §2.5 already specified, with the correlation filter FR-053/FR-064 require. Read-only; the on-disk trail stays append-only.

```http
GET /v1/audit?correlationId=<mt-run-…>&limit=100&cursor=<seq>
```

| Parameter | Rule |
| --- | --- |
| `correlationId` | optional. When present: **only** rows whose `correlationId` matches exactly (byte-identical — FR-051's "byte-identical values" makes this a string equality, not a derivation). Non-run rows (poll, consent, `account.*`, checkpoints) never match a run id, so a run-filtered read excludes them by construction (FR-052) |
| `limit` | default 100, max 200 (002 §2.5 bounds); out-of-range values are clamped, never echoed as an error |
| `cursor` | `seq` cursor: rows with `seq > cursor`, ascending; absence starts at the oldest retained row |

```jsonc
// 200
{ "entries": [ /* AuditEntry[] exactly as stored */ ],
  "nextCursor": 1234 | null,     // null = end of the filtered set
  "count": 42 }
```

`AuditEntry` is the stored shape verbatim (seq, timestamp, correlationId, eventType, actorSource, entity, decision, reason, redaction, details) — the read projects nothing and redacts nothing anew: rows were redaction-passed **at write** (FR-061), so a credential-free answer is a property of the store, not of this route. Response stays under `GUEST_REQUEST_RESPONSE_MAX` by the limit bound (200 rows × bounded details ≪ 256,000 chars; the transport guard still measures and answers `500 response-too-large` rather than truncating data).

### Refusals

| Status | `code` | When |
| --- | --- | --- |
| `503` | `storage-unavailable` | store unusable |
| `401` | `unauthorized` | bearer failure (unchanged) |

An unknown `correlationId` is a **200 with zero entries**, not a 404: "no rows yet" and "no such run" are indistinguishable at this layer and an empty set is the honest, non-oracle answer (consistent with §1, which lets the panel show the run itself when it exists).

## 3. Operator surface (FR-053, AC-117, SC-105)

The route alone is not operator-reachable (the bearer token is service-side, the operator holds no credential), so 003 ships a panel view: select a run row → **Audit history** → fetch by that row's correlation id → render rows as plain text (event type, seq, timestamp, actor, decision, reason; details as truncated text through the non-HTML path). That is retrieval "by correlation identifier alone, credential-free, without file access". The copy control for the identifier itself is 005 FR-049's (003 v1.2.0 record); the view works from the selected row either way.

## 4. Invariants (tests)

1. Every lifecycle row for a seeded run is returned by one `correlationId` query, in `seq` order, and **no** lifecycle row carries a fresh uuid (AC-116, SC-104).
2. `delivery.detected` rows for the run's deliveries match the run filter (correlation table: assigned at enqueue); `consent` / `account.verified` rows never do (FR-052, AC-118).
3. Pagination: a 250-row filtered set pages as 100 + 100 + 50 with `nextCursor` chaining and no duplicates/gaps.
4. Credential scan over 200 seeded rows ⇒ zero occurrences (AC-120).
5. Hostile content: a run whose issue title, repository name, and state reason contain `<img onerror=…>` renders as text in the history row and the audit view (NFR-109, AC-120's "no new HTML sink" clause).
6. The projection parser refuses an unknown `state` (fail closed — the list is a record the operator reads) while accepting all eight states incl. `blocked:*` families.
