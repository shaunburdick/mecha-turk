# Contract: The History Scope on the Binding Document

**Spec**: 002 v1.13.0, FR-053 – FR-094 (see `panel-service.md` §2.3, which this contract extends in place) · **Issue**: GitHub issue #22 · **Date**: 2026-10-05

One optional field rides the surface the product already has: `GET` / `PUT /v1/bindings`. **No new
endpoint, no new method, no new error code**, and the per-binding `PATCH /v1/bindings/:bindingId`
that §2.3 still lists as MVP-DEBT is **not** reopened — this contract reuses §2.3's own `GET` and its
whole-file grant, exactly as
[`binding-allow-list.md`](./binding-allow-list.md) did for `allowedUsers`.

**Three-way ownership, stated once**: 002 v1.13.0 owns **the field and its rules**; 003 owns **the
gate** that authorizes a dispatch (which this field does not feed — a history scope never widens who
may trigger); 005 owns **the rendering**. Two documents downstream record the delta: 005's changelog
for the editor's new control, 006's for the two of its requirements that now resolve differently.

---

## 1. The field

| Rule | Value | Spec |
| --- | --- | --- |
| Name | `historyScope` (camelCase, like every other binding member) | FR-053 |
| Type on the wire | `'new-only' \| 'recent-history'` | FR-053 |
| **Documented default** | `'new-only'` — what a binding created without a choice has, and what a binding storing no member has | FR-053, FR-058 |
| **Absent** | the documented default. A complete, valid state: the key is omitted, never sent as `''`, `null`, or a third name | FR-058 |
| `null` | **cleared to the default.** Never means "no lower bound" | FR-062 |
| Any other present value | **a refusal** — number, boolean, object, array, `''`, unrecognized string | FR-061 |
| Comparison | none: this is a selection, not a matcher | FR-068 |
| Omission in a write | **preserves** whatever the store holds | FR-057 |
| Explicit name in a write | **sets** it | FR-057 |

**Two names, and no third** — and that is the mechanism, not a slogan. Because the mode is an enum and
the look-back length is **not stored on a binding** (FR-059), **no combination of stored members can
express an unbounded replay** (FR-060). There is nothing in the record to set to zero, to `null`, or to
absent in order to ask for *everything*.

### 1.1 The look-back length is not a member of this document

| Rule | Value | Spec |
| --- | --- | --- |
| Value | **604,800,000 ms (7 days)** | FR-067 |
| Declared bound | **3,600,000 ms – 2,592,000,000 ms** | FR-059 |
| Where it lives | **one service-declared constant**, with its own bound | FR-059 |
| Where it does **not** live | **not** in `bindings.json`, **not** in `config.json`, **not** in the schema projection, **not** on the Settings tab | FR-059 |
| Who chooses it | **nobody.** The operator does not set it and cannot change it | FR-059 |

006 FR-010's and 006 FR-084's documented count of **twelve** configuration fields is **unchanged**. The
look-back length is deliberately absent from that list; recording it here is what makes the omission
read as a decision rather than an oversight.

## 2. What the mode decides, and what it does not

| Decided by the mode | Unchanged by the mode |
| --- | --- |
| The **lower bound** of a binding's first scan window (FR-066, FR-067) | Which triggers exist (FR-015) |
| Whether a **catch-up** opens on a later edit (FR-084) | Who may trigger: allow-list, bot exclusion, readable-actor rule (FR-071) |
| — | The overlap widening, the `created_at` comparison, the page walk (FR-051, FR-068) |
| — | Deduplication and the delivery key (FR-019) |
| — | The actor's re-fetch, run state, leases, and the claim-and-lease cycle (FR-081) |
| — | Every dispatch-lifecycle audit row (FR-088) |

**The mode never appears in a comparison about an individual observation** (FR-068). Once a binding has
completed a scan, the mode is not consulted at all.

## 3. The window starts, in full

| Case | Window's lower bound | Spec |
| --- | --- | --- |
| Binding has a completed scan | recorded stamp **minus `overlapMs`** | 006 FR-059(a), FR-019 |
| No completed scan, `new-only` | `createdAt` **minus `overlapMs`** | FR-066 |
| No completed scan, `recent-history` | `createdAt` **minus 604,800,000 ms** | FR-067 |
| Operator edited into `recent-history` | **now** minus 604,800,000 ms, through FR-023's rescan path | FR-084 |
| **Checkpoint cleared to recover lost work** | **recovery wins over the mode** — replays this binding's in-window work whatever the mode is | FR-073 |
| Baseline or recorded stamp unreadable | **no window, no events, a recorded reason** | FR-072 |
| Rescan at a chosen lower bound (FR-023) | **that bound** — bounded, deduplicating, identity-preserving | FR-023 |

> **FR-023's general operator-chosen-timestamp surface is out of scope and unbuilt** — it was promised by
> this document between v1.0.0 and v1.13.0, `service/routes/` never carried it, and v1.13.0 narrowed the
> requirement to the one caller above. This contract specifies **that** caller. Nothing here may be read
> as promising the general surface (`spec.md` `## Out of Scope`).

**There is no case in which a scan opens with no lower bound** (FR-065).

> **One mechanism, one caller.** FR-023 requires that exactly one rescan mechanism exist so a rescan
> cannot mean two things. This contract specifies its single required caller — the history-mode catch-up —
> and **builds nothing for the arbitrary-timestamp case**, which v1.13.0 records as known debt.

### 3.1 Two facts, kept apart

`lastScanAt` absent/null means *no completed scan*. A **separate** durable flag means *cleared to
recover lost work* (FR-074). They are written in the same atomic write (FR-018), the recovery path
alone writes the second, and **no reader infers one from the other**. While the flag is set, the
binding's health row says so (FR-078, FR-092).

## 4. Audit

One row per change, in the `binding.` prefix 003's data-model §4.2 already reserved:

```
eventType: 'binding.history-scope-updated'
actorSource: 'operator'   (a write through the panel) | 'service'   (observed in the stored document)
entity: { kind: 'binding', id: <bindingId> }
decision: 'set' | 'changed' | 'cleared'
details: { from: <previous mode | null>, to: <new mode>, actor }
```

**Nothing else.** The values are two fixed names, so the row carries no free text, no length, and no
fingerprint (FR-086). A submission resending the mode in force writes **no** row. **No dispatch-lifecycle
row is added, renamed, or reshaped** (FR-088), and `poll.observation` / `poll.checkpoint` stay reserved
and unwritten (FR-087).

### 4.1 Why an observation was *not* offered

Answerable from two durable facts and **no** per-observation row: the binding's health row carries the
**window start currently in force** and the **mode in force**, and the trail carries the mode's change
history. Together: *this event is older than the window this binding has watched since the date the mode
changed* (FR-087, FR-036, FR-092).

## 5. What the contract asserts

Each row is one assertion in the proof suite.

| # | Assertion |
| --- | --- |
| 5.1 | Both names round-trip byte-identically; an absent key and an explicit `null` both read back as the documented default |
| 5.2 | Each of a number, a boolean, an object, an array, `''`, and an unrecognized string is refused on **write** with a remediation naming **both** accepted names and **zero** characters of the submitted value |
| 5.3 | Each of those is refused on **read** of a hand-edited file the same way, the file is quarantined with a logged reason, and the poll loop scans nothing until it is repaired |
| 5.4 | Every problem in one submission is reported together and **nothing** is applied |
| 5.5 | A write omitting the member **preserves** the stored value; a pre-field document reads with **zero bytes rewritten** and **zero checkpoints reset** |
| 5.6 | The mode appears in **no** other store: not `host.storage`, not the ledger, not a run record — and the **look-back length** appears in neither shipped bundle. The mode itself *is* in the panel bundle, because FR-089 requires the editor's select to offer both names |
| 5.7 | The route table gained **no** operation — `src/` contains no new `PATCH /v1/bindings/` call and no new endpoint call |
| 5.8 | Across the whole stored-record domain, **no** state produces a scan with no lower bound |
| 5.9 | The look-back length appears in **no** configuration document, schema projection, Settings row, or route |
| 5.10 | A default-mode binding's first window is exactly `createdAt − overlapMs`, and an assignment five days before `createdAt` produces **no** event while one made since does |
| 5.11 | A look-back binding's first window is exactly `createdAt − 604,800,000 ms`; a second scan over it produces **zero** further events |
| 5.12 | The baseline is **stable**: three failed scans then a success still opens at `createdAt − overlapMs`, not at the last attempt |
| 5.13 | An unreadable `createdAt` produces **no** event, **no** run, and **no** work, with a recorded reason — in both modes |
| 5.14 | After the recovery reset, **both** modes replay; the two durable facts are distinguishable; only the recovery path writes the second; a catch-up sweep widens the retained baseline; and an **armed catch-up survives a replay that never reached its ground**, cleared only by a scan that did |
| 5.15 | A scan that starts a recovery replay and fails leaves the replay in force, and the next scan replays again — at the **retained baseline, ahead of the armed bound**, which therefore stays armed for the scan that serves it |
| 5.16 | A repeated sweep, a repeated recovery replay, and a restart each produce **zero** duplicate events and **zero** duplicate sessions |
| 5.17 | A sweep enqueues only: no session starts outside the claim-and-lease cycle, and at most one is in flight |
| 5.18 | Editing to `recent-history` opens a **bounded** catch-up **through FR-023's one rescan mechanism** — exactly one in the service, **no** general timestamp-picking surface is added, the scan-state file is written **only from inside its own chain**, and an **unreadable arming is neither a window nor cleared** — permanently pending, and reported by no projection; editing to `new-only` clears no checkpoint and alters no queued or dispatched run |
| 5.19 | Exactly one audit row per change, through the panel, inside a whole-file write, and observed in a hand-edited store; **none** for a resubmission in force |
| 5.20 | **No** per-observation row is written for a non-matching item on a cycle that matches nothing, and `poll.observation` is still unwritten |
| 5.21 | The panel renders the mode **once**, reads an unusable one as **unreadable**, renders an absent one as the default, and never renders an empty control implying a third choice |
| 5.22 | The health row carries the window start in force, the mode in force, and the forced-replay flag |

## 6. Invariants this contract does not touch

Read-only to GitHub (FR-031, FR-064) · the agent pin (FR-029) · secret containment — the mode is two
fixed names, so no secret scan needs an exemption (FR-054) · the untrusted-input posture: a swept event
is a **detection**, not a message, and reaches a session through the unchanged bounded delimited
excerpt, so a look-back sweep enqueues nothing that bypasses that fence (FR-028, FR-079) · manual
cleanup only (FR-040) · one repository per binding (FR-048) · 003's authorization-time gate (FR-076 of
003) · `host.storage` is not an audit home (FR-033, FR-034).