# Contract: Destructive-Confirmation Copy — Settings (panel-side; crosses no wire)

**Spec**: 006 FR-016, FR-050–FR-054 · SC-108 · AC-117–AC-122

## 0. Disposition: this contract adds **no** wire member

The confirmation is a **panel affordance** (FR-054) built from material the panel already holds: the projection from `GET /v1/config` ([config-schema.md](./config-schema.md) §1–§2) and the trim semantics the specification fixes. It uses 005's existing arm-then-act idiom (005 FR-084, 005 FR-055); `confirm()` does not exist inside the service frame and is not reintroduced through another route.

**Nothing below travels to the service.** `PUT /v1/config` is issued only by the *armed* activation, and it carries exactly the whole document it always carried. There is no confirmation token, no precondition header, and no revision field — gate answer 2 confirmed last-writer-wins with no revision precondition, and this contract does not smuggle one in sideways.

Recorded as a contract anyway, because the copy is **normative**: it is what stops a lowered retention limit from deleting history the operator did not expect to lose, and FR-031's discipline ("a declared claim is a tested claim") applies to the confirmation's promises exactly as it applies to a row's take-effect line.

## 1. What arms, and what never arms

| Change | Arms? | Why |
| --- | --- | --- |
| `auditRetentionDays` **lowered** | **yes, two steps** | entries older than the new window will be deleted at the next trim pass |
| `auditMaxEntries` **lowered** | **yes, two steps** | the oldest unprotected entries beyond the new cap will be removed at the next trim pass |
| `excerptRetentionDays` **lowered** | **yes, two steps** | stored payload excerpts older than the new window will be cleared at the next trim pass |
| any retention knob **raised** | no — one activation writes it | raising deletes nothing, and the confirmation must **say** so (FR-052) |
| any non-retention field | no — one activation writes it | nothing is deleted (AC-120) |
| **Restore defaults** (FR-016) | **yes, two steps** | it is a whole-document write that changes every field away from the current one; it must name every field it will change |

A confirmation that appears for an action with no consequence trains the operator to click through the one that matters (FR-051) — which is why the "no arm" rows are as normative as the armed ones.

## 2. The armed content (FR-052 — the whole truth, not half of it)

The arm state names, in the product's own words:

| # | Content | Source |
| --- | --- | --- |
| 1 | the field's documented name | `fields[].name` |
| 2 | the current limit and the proposed limit | last-read `config` value → the draft value |
| 3 | **what the limit governs** — the audit trail, the entry cap, or the stored payload excerpts | per-field copy keyed by `name` (006 FR-036) |
| 4 | **what will be removed** — audit entries older than the proposed window, the oldest unprotected entries beyond the proposed cap, or stored payload excerpts older than the proposed window | per-field copy keyed by `name` |
| 5 | **when** — at the next trim pass, which runs at the poll-cycle boundary after the change is in force **and once at service start** | trim semantics (FR-055, FR-057) |
| 6 | **what survives** — the minimal references that keep a run explainable (the row that opens a run's chain, the row that records its outcome, account/binding rows, decision rows) are never removed, and the trim appends an `audit.trimmed` row recording exactly what it took | FR-056, FR-073 |
| 7 | **that raising a limit deletes nothing** | FR-052 |
| 8 | **that trimming is irreversible** — this feature adds no restore path | 006 `## Out of Scope` |

For `auditMaxEntries` the copy additionally states that **nothing protected is ever removed to satisfy a cap** and that the trail may exceed the cap by exactly the protected set that was deliberately kept (AC-118's sibling scenario, edge case *the protected set alone exceeds `auditMaxEntries`*).

For a **non-retention** armed action (restore defaults) content items 4–8 are omitted — they describe a deletion that will not happen — and the arm instead names **every field the write will change** with its current → default value (FR-016).

## 3. The two steps, mechanically

```text
first activation   → arm   : nothing written; the row/bar shows the armed copy; focus moves to
                             the armed control; Cancel and Escape both disarm
second activation  → write : exactly one PUT /v1/config with the whole document; disarm; the
                             tab renders the configuration the service returned
```

| Rule | Requirement |
| --- | --- |
| one activation ⇒ zero writes | asserted per knob (AC-117) |
| armed ⇒ one more activation ⇒ exactly one write | AC-118, FR-046 (a second activation during the write is refused by the busy gate, not queued) |
| cancel / navigate away | nothing written; fields return to the last-read values (AC-121) |
| keyboard | the arm, the confirm, and the cancel are operable alone, with visible focus and no trap; the copy is reachable in DOM order (FR-018, NFR-107) |
| rendering | every string renders through the SDK's non-HTML path — the copy is composed partly from service-declared names and units (FR-054, NFR-101) |
| last-writer-wins statement | **before** any commit (armed or not), the panel states that a save replaces the whole configuration and names the fields it is about to change (FR-045, gate answer 2) |

## 4. Invariants (tests)

1. **SC-108, per knob**: lowering each of the three retention fields cannot complete in one activation, and the armed copy contains all of content items 1–8 for that knob; raising each one completes in one activation and states that nothing is deleted.
2. **AC-117**: with `auditRetentionDays` at 180 → 30, the armed copy names the field, 180, 30, *audit history*, *entries older than 30 days will be deleted at the next trim pass*, and what survives.
3. **AC-119 / AC-120**: a raise and a non-retention change each write in one activation and arm nothing.
4. **AC-121 / AC-122**: cancel and discard both leave the stored document untouched and restore the last-read values, each saying what reverted.
5. **No `confirm()`**: a static scan asserts no dialog-confirmation primitive is introduced anywhere in `src/`.
6. **Copy honesty**: a string scan fails if any armed copy claims that no trimming runs, promises a trim outcome for a state it has not read, or omits the irreversibility line (FR-036, FR-052, NFR-112).
