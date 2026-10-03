# Contract: The Actor Allow-List on the Binding Document

**Spec**: 002 FR-043, FR-044, FR-045, FR-046, FR-047, FR-048 · NFR-011 · amends 002 contract §2.3 (bindings) in place · **Date**: 2026-10-03

One optional field rides the surface the product already has: `GET` / `PUT /v1/bindings`. **No new
endpoint, no new method, no new error code**, and the per-binding
`PATCH /v1/bindings/:bindingId` that §2.3 still lists as MVP-DEBT is **not** reopened — this contract
reuses §2.3's own `GET` and its whole-file grant, which is the surface
[`binding-prompt.md`](../../004-starting-prompt/contracts/binding-prompt.md) already extended the
same way for the starting prompt. The shape of this file is 004's; the semantics are 002 v1.11.0's.

**Three-way ownership, stated once**: 002 v1.11.0 owns **the field and its rules**; 003 v1.8.0 owns
**the gate** that enforces them (`service/poll/dispatch-authorize.ts`); 005 v1.11.0 owns **the
rendering**. No two of them re-specify another's part, and this file is 002's and 002's alone.

---

## 1. The field

| Rule | Value | Spec |
| --- | --- | --- |
| Name | `allowedUsers` (camelCase, like every other binding field) | FR-047 |
| Type on the wire | `string[]` | FR-047 |
| **Absent** | no policy is configured and **any human actor may trigger** this repository. A complete, valid state: the key is omitted, never sent as `[]`, `null`, or `''` | FR-047 |
| **Non-empty** | **exactly** those logins may trigger | FR-047 |
| **Explicitly empty `[]`** | **a refusal.** Not "any user", not "nobody". An empty array is ambiguous in exactly the way this product refuses to be ambiguous | FR-047 |
| Comparison | **case-insensitive**; the stored spelling is preserved verbatim and only the comparison folds case | FR-047 |
| Per-element shape | a GitHub login: ≤ **39** characters, alphanumeric with **single interior** hyphens, never a leading or trailing hyphen (facts + sources: [`../research.md`](../research.md) §R9) | FR-047, FR-024 |
| List length | **no cap of its own.** Boundedness is carried by the per-login bound, `MAX_BINDINGS = 100`, and the transport's body cap | plan D6 |
| A `[bot]` login | **accepted and inert.** Bots are filtered at detection for every trigger kind, so no bot event exists to be admitted (FR-045(a)/(c)) | FR-045 |
| Where it lives | service store `bindings.json` only — **never** `host.storage`, never the ledger, never an audit row, never a run record, never a projection, never either committed bundle | NFR-113 |
| Who reads it | **every** `GET /v1/bindings` answer (the editor field's own value) and the service's own authorization gate | FR-047, 003 FR-076 |
| Who never reads it | the run/dispatch/audit surfaces (which record only the *shape*, `'open' \| 'restricted'`), the ledger, the logs, and every projection | NFR-113, 003 FR-079 |

### GET `200 { bindings, status }` (shape unchanged; entries gain the optional member)

```jsonc
{ "bindings": [ { "bindingId": "bnd-…", /* …every existing field… */
                  "allowedUsers": ["Alice", "bob"] } ],   // omitted entirely when unset
  "status":   [ /* BindingStatusRow[] — 005's `actorPolicy` member is added there, not here */ ] }
```

`BindingRecord` is not a closed object on the wire: the panel's binding parser
reads the members it knows field-by-field, so an answer carrying `allowedUsers`
neither breaks the parser nor leaks into its next `PUT` (see §2). `status` is
untouched by this contract; 005 v1.11.0 adds its own `actorPolicy` member to
each `repositories[]` row in its own contract.

---

## 2. PUT — the whole-file grant, with one rule that differs from `startingPrompt`

Request stays `PUT /v1/bindings` with `{ bindings: [...] }` (whole-file replacement, 005 FR-050).

| Submitted binding | Effect on its stored `allowedUsers` |
| --- | --- |
| key present, a valid non-empty array | validated (§3); on success the array is stored **with the submitted spelling preserved** |
| key present, `[]` | **the whole submission is refused** (§3) — nothing is written, every previous value stays in force |
| key present, not an array / a bad element | **the whole submission is refused** (§3) |
| **no `allowedUsers` key** | **unset** — the stored record carries no key |

> **This is the one rule that differs from `startingPrompt`, and it is deliberate.**
> 004 FR-014 preserves an omitted prompt, because a free-text instruction is genuinely
> ambiguous between *"I did not touch this"* and *"I cleared it"*. A login list is
> **enumerable**: the panel always knows it and can always state it, so omission is
> unambiguous. Preserving an omitted list would leave **no wire value that can express
> unset** — `[]` is a refusal, `null` and `''` are forbidden by FR-047, and an absent key
> would preserve — and a configured list would therefore be impossible to remove, which
> makes the remediation FR-047 *requires* the refusal to name ("remove the field to allow
> everyone") unactionable. Rationale, alternatives, and the residual risk are recorded as
> [plan.md D4](../plan.md) and as a flagged item in [`../pm-handoff.md`](../pm-handoff.md).
> **No route code change is required:** the shipped `parseBinding` already treats an absent
> member as absent and the shipped `mergePrompts` only ever touches `startingPrompt`.

**Client of record**: the shipped panel must send the member **explicitly on every row** — the
array when the binding has one, and **the key omitted** when it has none. A panel that omitted
the key to mean "preserve" would erase the list; one that sent `[]` to mean "unset" would be
refused. Both are asserted (tasks A-3, C-3).

---

## 3. Validation and the refusal envelope

Validation runs on **every write** and on **every read** of the stored file, through the one
reader in `service/bindings.ts` (one rule set, or neither — 002 FR-024), in the same
collect-every-refusal posture `startingPrompt` uses (`parseBinding` returns
`{ binding } | { issues }`, every issue is `{ field, remediation }`, and one bad binding **and** a
bad repository arrive in the same `422`).

```jsonc
// 422 validation — unchanged envelope, unchanged status, unchanged code
{ "error": { "code": "validation",
             "issues": [
               { "field": "allowedUsers",
                 "remediation": "allowedUsers must name at least one GitHub login; to let anyone \
                                 trigger this repository, remove the field instead of sending an \
                                 empty list" }
             ] } }
```

| Submitted value | Issue `field` | What the remediation says |
| --- | --- | --- |
| `[]` | `allowedUsers` | an empty list is refused, **and it names both honest alternatives**: remove the field to let any human trigger this repository, or name at least one login. The way to stop **every** trigger is to **disable the binding**, which `state` already models — and the remediation says so, because "nobody" is not one of the field's meanings (FR-047) |
| not an array | `allowedUsers` | it must be an array of GitHub logins, or absent |
| an element that is not a GitHub login | `allowedUsers` | it must name GitHub logins (≤ 39 characters, alphanumeric with single interior hyphens) |
| anything else about a binding | its own field | unchanged — this contract adds no refusal and changes no other field's voice |

**Rules the refusals obey**, both of which are existing project discipline rather than new
requirements: **no submitted value is ever echoed** (002 FR-024 / 005 FR-085 — the remediation names
the *shape*, never the text an operator typed), and **a refusal writes nothing at all** (005
FR-058 — because the grant is all-or-nothing after validation, a bad list is a bad *save*, and the
panel renders that as "nothing changed" rather than as a half-applied edit).

### Read-side behaviour

A stored `bindings.json` carrying `allowedUsers: []` is **refused on read the same way** (FR-047).
`bindings-read.ts` already quarantines-and-logs rather than fail-stuck, so the operator sees a log
naming the field and every *other* binding still reads. This is the intended behaviour, not an
incident: an empty list has two plausible readings and this product never picks one silently.

---

## 4. What this field is deliberately not

- **Not a gate.** Nothing in `service/poll/triggers.ts`, `service/poll/loop.ts`, or this route
  compares an actor against the list. Detection **records** the actor (002 FR-043) and **decides
  nothing**; the single membership comparison lives in the service's authorization operation
  (003 v1.8.0 FR-076), so there is exactly one answer to "may this run start a session?".
- **Not a policy mode.** No `policyMode`, no `'open' \| 'restricted' \| 'closed'` companion, no
  sentinel — a companion mode makes "restricted with nobody in it" a valid, quiet state and adds a
  second field to every binding to express what one absent key already says (002 v1.11.0's own
  entry).
- **Not shared.** N bindings repeat the list. A shared/reusable list object would need its own
  identity, lifecycle, validation, and audit story, and buys an operator typing the same two logins
  twice (002 `## Out of Scope`).
- **Not plural over repositories.** A binding is the edge `repo → project`; one repository per
  binding is **permanent and load-bearing** (FR-048). The issue's three scenarios are **N bindings**.
- **Not a `config.json` field.** `GET /v1/config` describes one global document and a per-binding
  value cannot live in it — the precedent is 002's own `expectedLogin`, a per-*account* constraint
  that lives on the credential-verify route and the Accounts form. **006 is deliberately not
  amended**; its closed `FieldDescriptor` union and its twelve-field count are untouched.
- **Not a migration.** No shim, no fallback reader, no legacy default. A stored binding without the
  key **is** the absent state (product owner, 2026-10-03: *"there are no migrations needed as we
  haven't released yet. keep it simple as I can delete my one local install and start over
  easily."*).

---

## 5. Invariants (tests)

1. **The three states (AC-026).** Absent reads valid and means any human may trigger;
   `['Alice','bob']` round-trips **byte-identically** through `GET` after `PUT` while matching
   `alice`, `ALICE`, and `Bob`; `[]` is refused on write *and* on read, with a field-level
   remediation naming both honest alternatives and **no submitted value echoed**.
2. **Bad shapes.** A non-array, a non-text element, and a login over 39 characters or with a
   leading/trailing hyphen are each refused naming `allowedUsers`; every issue in one submission
   arrives in one `422`; a refusal leaves every other binding byte-identical.
3. **One rule set.** The same reader produces the same verdict for a panel `PUT` and for a
   hand-edited file (002 FR-024, 004 FR-019's precedent).
4. **No new surface.** The route table answers exactly the operations it answered before: `GET`
   and `PUT /v1/bindings` only, and `src/` contains **no** `PATCH /v1/bindings/` call (005 FR-050).
5. **The list never escapes `bindings.json` (NFR-113).** After a dispatch authorized under a
   populated list, a scan over every audit row the build can write, the run record, the run-history
   projection, the audit read, and both committed bundles finds **no permitted login** — only the
   shape — while the gate's own refusal row still names every **denied** login with its basis.
   (The gate is 003's; the field is 002's; the assertion is recorded in both plans.)
6. **One comparison.** A source scan asserts the membership helper's identifier appears in exactly
   two files: its own module and `service/poll/dispatch-authorize.ts` (plan D9, 003 FR-076).