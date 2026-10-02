# Contract: Dispatch List — `GET /v1/events` (paging + server-side filters)

**Spec**: 005 `## Wire Surface Delta` row **Dispatch list** · FR-042, FR-043, FR-023, FR-041 · SC-106 · AC-121, AC-122

## 0. What is retained

- **The path is not renamed.** `/v1/events` keeps its name, as do `/v1/events/pending`, `/v1/events/:id/retry`, and `/v1/events/:id/dispatched` (FR-023 — confirmed by the product owner 2026-09-28 as Gate Question 1). The panel maps the *Dispatches* concept onto the retained path internally; `## Vocabulary Mapping` records the deferral.
- **The order is retained**: newest detected first, 003's `RunHistoryRow` projection unchanged field-for-field, the `events` array member name unchanged (003's contract §1 — additive-within-v1).
- **`recentRuns()` remains the unpaged primitive** this read builds on (005 `## Wire Surface Delta`).
- The shipped `MAX_LISTED_EVENTS = 100` cap becomes the **maximum page size**, not the end of the reachable history: **the 101st dispatch is now reachable** (FR-042).

```http
GET /v1/events?limit=25&cursor=<opaque>&bindingId=<id>&state=<state>
```

## 1. Query parameters

| Parameter | Type | Rule |
| --- | --- | --- |
| `limit` | integer | **default 25**. Accepted values `10`, `25`, `50`, `100`. Any other value → `422 validation` (`field: 'limit'`, remediation naming the four accepted values); it is **clamped into range only for a value inside the accepted set's span**, never echoed |
| `cursor` | opaque string | page boundary produced by a previous answer. **The panel never parses it.** Absent → first page of the filtered set. An unknown/unparseable cursor → `422 validation` (`field: 'cursor'`), never a silent reset to page 1 (a silent reset would strand the operator's position as a "successful" first page) |
| `bindingId` | string | optional. Exact match against the run's `bindingId`. An id that matches no stored binding is a **200 with an empty set**, not a 404 — "no such binding" and "no dispatches for it" are indistinguishable at this layer and an empty set is the honest, non-oracle answer |
| `state` | string | optional. Either one exact state token from 003's `## Dispatch State Model` — `pending`, `claimed`, `starting`, `dispatched`, `failed`, `unconfirmed`, `dead-lettered` — or the literal **`blocked`** matching the whole `blocked:*` family, or an exact `blocked:<reason>`. **A value outside that vocabulary → `422 validation` (`field: 'state'`), never silently ignored** (FR-003: an unknown filter must not widen the set) |

Filters **compose** with the page: both describe the same set (Gate Question 3, confirmed 2026-09-28). Applying no parameters is the closest analogue of today's behaviour (first 25 newest rows instead of 100).

## 2. Answer

```jsonc
// 200
{ "events": [ /* RunHistoryRow[] — unchanged projection, at most `limit` entries */ ],
  "page": {
    "limit": 25,
    "nextCursor": "eyJkIjoi…",   // null when this page is the last of the filtered set
    "hasMore": true,
    "total": 137,                 // number | null — null when the service cannot honestly supply one
    "snapshotAt": "2026-09-28T12:00:00Z",
    "filter": { "bindingId": null, "state": "failed" }
  } }
```

| Member | Rule |
| --- | --- |
| `limit` | echo of the effective page size (after defaulting) |
| `nextCursor` | boundary token for the next page in the retained order; `null` at the end |
| `hasMore` | `true` iff a further page exists **in the same filtered set** |
| `total` | size of the **filtered set** when it can be computed honestly, else `null`. **The page size is never reported as a total** (NFR-112). The panel renders `null` as *total unavailable* |
| `snapshotAt` | the label the service puts on this read, so the tab can say which read it is showing and a refresh can be seen as one (FR-014, FR-042's snapshot edge case) |
| `filter` | echo of the applied filters, so the tab's visible filter state is the service's answer rather than the panel's assumption (FR-043: active filters visible at all times) |

### Ordering and cursor stability

Sort key: `detectedAt` descending, tiebroken by `id` descending. The tiebreak is what makes the cursor deterministic when several rows share a detection stamp — without it a page boundary could drop or duplicate a row, which SC-106/AC-121 forbid.

## 3. Refusals

| Status | `code` | When |
| --- | --- | --- |
| `503` | `storage-unavailable` | store unusable (unchanged) |
| `401` | `unauthorized` | bearer failure (unchanged) |
| `422` | `validation` | out-of-range `limit`, unparseable `cursor`, or an out-of-vocabulary `state` — `issues[].{ field, remediation }`, **values never echoed** |

An unknown-but-well-formed `bindingId` is **not** a refusal (see §1).

## 4. Panel-side page state

The panel keeps `cursorStack` + `pageIndex` + `limit` + `filters` (see [data-model.md](../data-model.md) §3.2) so **Previous** works without a server-side backward cursor and an explicit refresh resumes on the page the operator was reading. A filter or page-size change resets to the first page of the new set; a failed read leaves the page state untouched and marks the retained rows stale (FR-019).

Empty-set semantics the tab must honour:

- **no rows and no filter** → *no dispatches yet* (the honest empty),
- **no rows and a filter set** → *the filter matched nothing*, with an offer to clear it (AC-122) — never *there are no dispatches*.

## 5. Invariants (tests)

1. **SC-106 / AC-121**: a 250-row fixture pages through with `limit=100` as 100 + 100 + 50, `nextCursor` chaining with **no duplicates and no gaps**, and every row reachable.
2. **AC-122**: a filter matching nothing answers `200` with `events: []`, `total: 0`, and `filter` echoed; the tab renders *the filter matched nothing* and offers to clear it.
3. **Filter × page compose**: seeding three bindings with interleaved rows and reading with `bindingId` + `limit=10` asserts every returned row matches both, across all pages.
4. **`state=blocked` family**: seeded `blocked:project-missing` and `blocked:binding-removed` rows are both returned; `state=failed` returns only `failed`.
5. **Unknown filter refuses**: `state=bogus` and `limit=7` each answer `422 validation` with a remediation, and the stored rows are untouched.
6. **Order stability**: rows sharing one `detectedAt` do not move between two consecutive identical reads.
7. **Honest total**: a fixture where the total is withheld answers `total: null`; a fixture where it is supplied never answers a value equal to `limit` unless it genuinely equals `limit`.
8. **Credential scan** over every page answer (NFR-102).
