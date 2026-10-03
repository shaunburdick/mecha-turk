# Contract: Status Projection — `GET /v1/status`

**Spec**: 005 `## Wire Surface Delta` row **Status** · FR-030–FR-034, FR-026, FR-003 · **FR-093 (v1.11.0)** · SC-101, SC-102, **SC-113** · AC-102–AC-107, **AC-144, AC-146** · **Amended**: 2026-10-03 (the actor allow-list's Status surface; GitHub issue #9)

## 0. Supersession

**This contract supersedes 003's `## Wire Surface Delta` entry for `Status`, which 003 marked "Unchanged."** 003 deliberately left the projection alone ("belongs to 005's Status tab"); 005 changes exactly three members of the document and adds one member to one row. 003's contracts [README §4](../../003-dispatch-integrity/contracts/README.md) already carries the forward pointer. **No other operation in either predecessor's contract set is affected.**

Everything not listed below is unchanged from 002's [panel-service.md §2.1](../../002-agent-event-extension/contracts/panel-service.md): the path, the method, the auth order, the `200` answer shape, and the store-degraded behaviour (`status: 'degraded'`, `schemaVersion: null`, `storage.writable: false`).

## 1. `polling` — computed, never literal (FR-031)

```jsonc
"polling": {
  "intervalMs": 60000,                  // effective configuration value (unchanged)
  "nextPollAt": "2026-09-28T12:01:00Z",  // scheduled stamp WHILE polling runs; null while it does not
  "paused": false,                       // true ONLY when the loop is genuinely not running
  "pausedReason": ""                     // empty while running; otherwise a closed-vocabulary code
}
```

| Field | Rule |
| --- | --- |
| `paused` | `false` whenever the poll loop is running, regardless of any other condition. The shipped literal `paused: true` is the defect this row corrects |
| `nextPollAt` | RFC 3339 stamp of the next scheduled cycle while running; `null` while not running. **A past stamp is a valid answer** (the timer has not fired yet) — the panel renders *overdue* and never substitutes the configured interval |
| `pausedReason` | `''` while running. While paused: one of `config-incomplete` \| `no-active-bindings` \| `store-unavailable` \| `stopping`. **A value outside that vocabulary is passed through verbatim** — the panel renders the machine code rather than mapping an unknown code to a friendly guess (FR-003) |

**Source discipline**: the three values are computed from a read-only view over `service/poll/timer.ts` and `service/poll/loop.ts` plus the config/store reads the route already performs. Neither the timer nor the loop is modified, and the route holds no second implementation of scheduling.

**Closed vocabulary (normative):**

| Code | Meaning |
| --- | --- |
| `config-incomplete` | no account, or an invalid/absent configuration the loop cannot start from |
| `no-active-bindings` | accounts exist, but no binding is `active` |
| `store-unavailable` | the data directory cannot serve reads |
| `stopping` | the service is shutting down |

### Refusals

None new: `GET /v1/status` still answers `200` even when the store is down (that is exactly when the operator needs to read it). No status code changes meaning.

## 2. `repositories[]` — one row per stored binding (FR-032)

The member name stays **`repositories`** (FR-026, confirmed Gate Question 1). The panel renders it under the heading **Bindings**.

```jsonc
"repositories": [
  { "bindingId": "bnd_…", "repository": "owner/name", "projectId": "…",
    "accountLogin": "octocat", "active": true,
    "lastScanAt": "2026-09-28T11:59:00Z", "lastError": null, "pendingCount": 2,
    "readable": true,
    "actorPolicy": "open" | "restricted" }   // ADDED at 005 v1.11.0 (FR-093); never the logins
]
```

| Field | Rule |
| --- | --- |
| `bindingId`, `repository`, `projectId`, `accountLogin`, `active`, `lastScanAt`, `lastError`, `pendingCount` | built from the **same** `readStatusRows` the Bindings tab reads, so the two surfaces cannot disagree about a binding |
| `readable` | **new**. `false` when the binding's scan row could not be read. **An unreadable binding appears with an unreadable marker; it is never omitted** — an omitted binding reads as a deleted one (AC-105) |
| `actorPolicy` | **new at v1.11.0 (FR-093)**. The closed union `'open' \| 'restricted'`, derived from the binding this row is already built from: `'open'` when the binding carries **no** `allowedUsers`, `'restricted'` when it carries a non-empty one. **It never carries a login** — the permitted set's home is `bindings.json` and a copy of it in a document the panel renders is the liability, not the control (003 NFR-113, FR-091). `'restricted'` therefore always means **at least one** login, because an empty list cannot reach here (002 FR-047 refuses it at save *and* on read). **The panel's reader refuses an unrecognized value** rather than defaulting (fail-closed, `AGENTS.md` invariant 8) |

- **Zero bindings → `[]`**, and that is an honest empty, not a placeholder. In that case the
  panel's counted line renders as a **positive statement** — *every binding restricts who may
  trigger* — never as an absent row or silence (FR-093, AC-144).
- The projection reads `scan-state.json` and `events.json` through their existing readers; a row whose underlying scan state fails to parse yields `readable: false`, never a dropped entry. `actorPolicy` is derived from the **binding**, not from the scan state, so it remains truthful on a row that is otherwise unreadable.
- **`actorPolicy` also rides the claim answer's `status` array**, because it is derived in the one `readStatusRows` projection that the Status route, the claim answer, and the Bindings tab all read (plan D17). That is additive within v1; the claim's other members are untouched, and 003 v1.8.0 adds **no** claim-answer member of its own.

## 3. `agentPin.lastVerification` — widened (FR-033)

```jsonc
"agentPin": {
  "expectedAgent": "project-manager",            // or null; value now sourced from GET /v1/config (§5)
  "lastVerification": { "observedAgent": "…", "expectedAgent": "…",
                        "ok": true, "at": "2026-09-28T12:00:00Z" }
                | { "available": false, "reason": "no-service-mirror" }
                | null
}
```

| Value | Meaning |
| --- | --- |
| object | the most recent verification outcome the service holds (matched, mismatched, or unreadable) with its stamp |
| `{ available: false, reason: 'no-service-mirror' }` | **explicitly not available** — the service holds no mirror (003 records it as backlog). The marker names that the outcome lives on the dispatch row and in the audit trail |
| `null` | **only** when no dispatch has ever been verified |

`null` never renders as "ok". 002 FR-029's mismatch warning is satisfied on the dispatch row (005 FR-047); Status points at it rather than inventing it.

## 4. Rate block — shape unchanged, honesty enforced (FR-034)

`rate.{remaining, limit, resetAt}` remain `null` before the first measurement; `rate.usedLastHour` is a real count. The panel renders `null` as **not measured yet** — never `0`, never `unlimited`, never a full bar (AC-107).

## 5. `agentPin.expectedAgent` — source note (not a shape change)

The member already exists. After 002 FR-041 empties the manifest card, the panel's comparison baseline is read from `GET /v1/config`'s `expectedAgent` (006 FR-100's field) with 002 FR-029's two-case fail-closed split: **field absent or unreadable → documented default `project-manager`, the run proceeds to verification, and the outcome records which baseline was used**; only an observed-agent mismatch or an unreadable *observed* agent blocks. The status member continues to report what the service knows; it is not the panel's read path.

## 6. Invariants (tests)

1. **SC-101 / AC-102**: with a running loop, `paused` is `false`, `nextPollAt` is a future stamp, `pausedReason` is `''` — read from a live store. With a stopped loop and no active binding: `true` / `null` / `no-active-bindings` (AC-103). **Zero hardcoded literals remain** — asserted by a test that drives both states through the same route.
2. **SC-102 / AC-104**: `repositories` has one row per stored binding at **zero, one, and five** bindings, each with `lastScanAt`, `lastError|null`, `pendingCount`.
3. **AC-105**: a binding whose scan row cannot be read appears with `readable: false` and is not omitted.
4. **AC-106**: with no verification on record, `lastVerification` is `null` or the explicit not-available marker — never an "ok" shaped object.
5. **Unknown reason passthrough**: seeding an out-of-vocabulary `pausedReason` asserts it arrives byte-identical (FR-003).
6. **Member-name stability**: the response still contains `repositories` (not `bindings`) and no existing member is renamed (FR-026, FR-023).
7. **Credential scan**: the whole document passes the existing secret suites with no new exemptions (NFR-102).
8. **`actorPolicy`, added at v1.11.0 (FR-093).** (a) A binding with no `allowedUsers` answers `'open'`; one with a populated list answers `'restricted'`; the value is derived from the binding, never from the panel or from a stored projection. (b) **No login appears anywhere in the document** — a scan over the whole answer, and over both committed bundles, finds no permitted login (003 NFR-113, FR-091). (c) An out-of-vocabulary `actorPolicy` **refuses the answer** in the panel's reader rather than defaulting (fail-closed). (d) The counted line renders *N of M bindings…*, renders **zero** as a positive statement, renders a service-unreachable status as **not available**, and names **no login and no repository** (AC-144). (e) No user-facing string uses *protected*, *restricted*, or *secure* about a binding this document reported as anything other than `restricted` (NFR-113, AC-146).
