# Contract: Configuration Read/Write — `GET` / `PUT /v1/config`

**Spec**: 006 `## Wire Surface Delta` rows **Config read** and **Config write** · FR-020–FR-028, FR-040–FR-049, FR-070–FR-074, FR-100 · SC-101, SC-109, SC-110 · AC-101, AC-107–AC-116, AC-127, AC-135–AC-137, AC-154

## 0. Disposition against the predecessors

**002's `panel-service.md` §1 rule 3 and §2.1 `Config` row are annotated, not superseded.** 002 records that both operations "answer `{ config }`" and that validation errors "list field + remediation, **never received values**". 006 keeps the second half byte-identical and widens the first half additively: the answer becomes `{ config, fields, source, defaultsApplied }`. The paths, the methods, the auth order, the `422` envelope, the value-free remediation, the atomic write, and the `503 storage-unavailable` degradation are all relied on exactly as shipped (FR-040, FR-041).

**003's contracts are unaffected.** A `config.changed` row carries its own correlation id and no run reference, so it is excluded from run-filtered reads by 003 FR-052's own rule — 006 honours that rule, it does not amend it (FR-074).

Everything not listed below stays as 002 specified it: bearer auth before routing, body caps, `{ error: { code, message, issues? } }`, and `invalid-json` never echoing the body.

## 1. `GET /v1/config` — the envelope

```jsonc
// 200 OK
{
  "config": {
    "intervalMs": 60000, "overlapMs": 600000, "perPage": 30,
    "retryMaxAttempts": 5, "retryBaseMs": 5000, "retryMaxMs": 60000,
    "auditRetentionDays": 180, "auditMaxEntries": 50000, "excerptRetentionDays": 30,
    "logLevel": "info",
    "expectedAgent": ""                 // "" = no baseline configured (006 v1.5.0)
    // "leaseMs": 120000, "resultDeadlineMs": 120000  — present once 003's T-008 lands
  },
  "fields": [ /* FieldDescriptor[], §2 */ ],
  "source": "stored",              // 'stored' | 'default' | 'quarantined'
  "defaultsApplied": []            // documented keys this stored document lacked
}
```

| Member | Rule |
| --- | --- |
| `config` | **unchanged in name, type, and semantics**: the effective `ServiceConfig`. Values are the stored document's, the documented defaults when there is no usable document, and never a mix presented as configured |
| `fields` | **new** — one descriptor per documented field, **in declaration order** (the same order `collectIssues` produces issues in, so AC-107's "service's order" and the row order agree) |
| `source` | **new** — where `config` came from (§3) |
| `defaultsApplied` | **new** — `string[]` of documented keys filled from `DEFAULT_CONFIG` during this read; `[]` whenever `source` is not `stored`, because in those cases *every* value is the default and `source` already says so |

- **Degradation is unchanged**: store unavailable ⇒ `503 storage-unavailable` with the setup-prerequisite framing; no envelope member is invented to describe a store the service cannot open.
- **Additive only**: a reader that ignores `fields`, `source`, and `defaultsApplied` still gets exactly the document it got before.

## 2. `fields[]` — the field descriptor

A **closed discriminated union** on `kind`. The panel's parser refuses anything outside it (FR-021: a value outside a closed vocabulary is refused or passed through verbatim, never mapped to a guess).

```jsonc
[ { "name": "intervalMs", "kind": "integer", "unit": "milliseconds",
    "min": 15000, "max": 300000, "default": 60000, "takesEffect": "next-cycle" },

  { "name": "logLevel", "kind": "enum", "unit": null,
    "values": ["debug", "info", "warn", "error"],
    "default": "info", "takesEffect": "immediate" },

  { "name": "expectedAgent", "kind": "string", "unit": null,
    "format": "letters, digits, and . _ - @ : / (a single token, no spaces); empty means no baseline",
    "maxLength": 80, "default": "", "takesEffect": "next-dispatch" } ]
```

| Descriptor member | Rule |
| --- | --- |
| `name` | a documented `ServiceConfig` key, verbatim |
| `kind` | exactly `integer` \| `enum` \| `string` |
| `unit` | the range's unit for `integer`; **`null`** for `enum` and `string` — a string field has no unit and none may be fabricated (FR-014, FR-021) |
| `min`, `max` | **`integer` only**, inclusive; **absent on the other kinds** (no numeric bound exists for a text field) |
| `values` | **`enum` only**, the accepted set verbatim |
| `format`, `maxLength` | **`string` only**: service-authored prose describing the allowed characters, and the length ceiling. The panel renders `format` as text and derives **no** validation from it (FR-023) |
| `default` | the documented default, from the same `DEFAULT_CONFIG` the store falls back to |
| `takesEffect` | exactly `immediate` \| `next-cycle` \| `next-dispatch` \| `restart` \| `none`. 006's eleven declare **nine `next-cycle`, one `immediate`, one `next-dispatch`**; no field declares `restart` or `none` (FR-030, FR-037, AC-104) |

**One declaration, read twice**: `fields` is projected from `NUMERIC_BOUNDS`, `LOG_LEVELS`, `EXPECTED_AGENT_RULE`, `DEFAULT_CONFIG`, and `TAKE_EFFECT` — the *same* objects `validateConfig` reads. SC-101 asserts this by changing a bound in the declaration and requiring the descriptor **and** the validator's remediation string to move together.

**Unknown descriptor members are not used**: a panel that meets a descriptor member it does not know ignores that member; a **field name** it does not know triggers FR-027 (§6).

## 3. `source` — a fact the operator must see

| Value | When | Panel wording |
| --- | --- | --- |
| `stored` | `config.json` read and validated | values are configured; rows named in `defaultsApplied` read **default** |
| `default` | no `config.json` (fresh store) | every row reads **default** |
| `quarantined` | present but unusable; renamed aside | *the stored configuration was unusable and set aside* — **never** "your values are current" |

`quarantined` is the wire half of the spec's edge case *a hand-edited `config.json` that fails validation*; the quarantine log line already exists and is unchanged.

## 4. `PUT /v1/config` — semantics unchanged, two additions

**Unchanged and relied on exactly as shipped** (FR-040, FR-041):

- whole-document replacement; the body must be a complete `ServiceConfig`;
- validation runs **before any storage access** — a client error stays a client error while the disk is broken;
- unknown keys refused (`<withheld>` for a secret-shaped name); missing documented keys refused, **including `expectedAgent`** (FR-100(b));
- every bad field reported in one `422` with `error.issues[].{ field, remediation }` in declaration order, **received values never echoed**;
- the write is atomic; a refusal leaves the stored document byte-identical (NFR-103);
- store unavailable ⇒ `503 storage-unavailable`.

**New validation this feature adds** — `expectedAgent`, in the existing voice (v1.5.0: **empty is accepted** and means *no baseline configured*, so it needs no remediation):

| Refused input | `field` | `remediation` (service-authored; the submission appears nowhere) |
| --- | --- | --- |
| absent, or not a string (the member is still required) | `expectedAgent` | `set expectedAgent to a string; leave it empty for no baseline` |
| longer than 80 characters | `expectedAgent` | `set expectedAgent to at most 80 characters` |
| contains a space / control character / character outside `. _ - @ : /` and alphanumerics | `expectedAgent` | `set expectedAgent to letters, digits, and . _ - @ : / with no spaces` |
| credential-shaped (secret-shape rule) | `expectedAgent` | `set expectedAgent to an agent name, not a credential` |

**Addition 1 — no-op detection** (FR-048): a body equal to the stored document answers `200` with the same `config`, is reported by the panel as *already saved*, and appends **no** audit row. Equality is field-by-field over the validated document.

**Addition 2 — the answer carries its audit outcome** (FR-070's edge case, AC-139):

```jsonc
// 200 OK — accepted (changed or no-op)
{ "config": { … }, "auditWritten": true }

// 422 validation — unchanged envelope
{ "error": { "code": "validation",
             "message": "retryMaxMs: set retryMaxMs to a value greater than or equal to retryBaseMs; …",
             "issues": [ { "field": "retryMaxMs", "remediation": "…" } ] } }
```

| Member | Rule |
| --- | --- |
| `auditWritten` | `true` when the `config.changed` row reached disk; **`false` when the configuration write succeeded but the row did not** — the configuration write is the durable record and still stands (FR-047), the panel shows the save **and** a visible warning naming the missing row, and the service logs a structured warn. Never a rollback, never a silent swallow |

- **`logLevel` on an accepted write is applied before the answer is sent** (FR-033): the first log line emitted after the acknowledgement is judged at the new threshold, with no restart.
- **A configuration write does nothing else** (FR-047): no scan triggered, no binding/account/run/checkpoint touched, no retention trim run, no other tab's projection invalidated.

## 5. Audit rows

Both names are **reserved by 002's data model** and are filled, never invented (FR-070, FR-073).

```jsonc
// accepted and changed something
{ "seq": 412, "timestamp": "…", "correlationId": "<its OWN id>",
  "eventType": "config.changed", "actorSource": "operator",
  "entity": { "kind": "service", "id": "<the configuration>" },
  "decision": "applied",
  "reason": "configuration replaced",           // secret-free
  "details": { "changes":   [ { "field": "intervalMs", "from": 60000, "to": 120000 },
                              { "field": "logLevel",   "from": "info", "to": "debug" } ],
               "takesEffect": { "intervalMs": "next-cycle", "logLevel": "immediate" } } }

// refused by validation
{ "eventType": "config.changed", "actorSource": "operator",
  "entity": { "kind": "service", "id": "<the configuration>" },
  "decision": "refused",
  "reason": "configuration refused",
  "details": { "issueCount": 3,
               "fields": ["retryMaxMs", "expectedAgent", "<withheld>"] } }

// written by either trim pass, only when something was removed
{ "eventType": "audit.trimmed", "actorSource": "service",
  "entity": { "kind": "service", "id": "<the configuration>" },
  "decision": "trimmed",
  "reason": "<which limit was reached>",
  "details": { "entriesRemoved": 17, "oldestSeq": 41, "newestSeq": 212,
               "limitReached": "day-window" | "entry-cap" | "excerpt-days",
               "minimalReferencesPreserved": 6 } }
```

| Rule | Detail |
| --- | --- |
| actor | `operator` for a write that arrived through the panel (the only writer is a bearer-token holder acting for the operator — the convention `routes/accounts.ts` already uses); `service` for the trim passes |
| one row per event | **exactly one** per accepted write that *changed* something; **exactly one** per refused write; **zero** for a no-op; **zero** for a pass that removed nothing (FR-048, FR-053, FR-070) |
| `changes` | one `{ field, from, to }` per **changed** field, **ordered by field name**, documented fields only; `from`/`to` are bounded integers, one of the four level names, or `expectedAgent`'s documented string format |
| refusal rows | **no submitted value of any kind** — not the value, not an accepted value, not a length, not a hash — and **no foreign key name**: an unrecognised key appears as `<withheld>` (FR-072) |
| correlation | each row **mints its own id** and records **no run reference**; retrievable under its own id, excluded from run-filtered reads (FR-074, 003 FR-052) |
| redaction | every row passes `appendAudit`'s redaction pass; **a redaction refusal blocks the write** rather than being logged past (003 FR-061, 002 FR-007) |
| trim ordering | the `audit.trimmed` row is written **in the same atomic replace** as the removals it describes, so no crash can leave a removal without its record or a `seq` that a restart would re-use (FR-053, FR-055; data-model §6) |

## 6. Panel-side rules these members make possible

These are **not** wire behaviour; they are recorded here because the wire is what feeds them.

| Rule | Requirement |
| --- | --- |
| every rendered label, hint, bound, step, option list, default, and class comes from `fields` | FR-022; AC-106's scan requires **zero** configuration literals in `src/` |
| no client-side rejection: `min`/`max`/`values` shape the control and the hint only, an out-of-range value is sent and refused by the service | FR-023, AC-110 |
| a `config` member with **no** descriptor renders as *field this version does not show*, gets no affordance, and blocks the save with the reason | FR-027, AC-115 (panel-side fail-closed rule; see [research.md](../research.md) Q4) |
| a document the panel cannot fully parse renders parsed fields, marks unparsed ones *unreadable*, and **never** fills a field from `default` on its own initiative | FR-028, AC-116 |
| every issue renders in the service's order, with the service's wording, none omitted/merged/reworded, and no submitted value anywhere | FR-024, AC-107, AC-108, AC-111, AC-112 |
| after any refusal every field shows the last configuration the service reported | FR-025, AC-109 |
| the problem string for a configuration refusal **names the configuration**; `service refused the bindings list` appears nowhere on this path | FR-043, AC-112 |

## 7. Invariants (tests)

1. **SC-101**: mutate a bound in `service/config.ts` ⇒ the descriptor's `min`/`max` **and** the validator's remediation both change in the same run; revert ⇒ both return. The projection and the validator have one source.
2. **AC-101 / SC-102**: `fields.length === Object.keys(DEFAULT_CONFIG).length`; for each of 006's eleven names a row renders with name, unit-or-*none*, bounds-or-format, value, and class. Row count is derived, so a combined-tree fixture renders thirteen without a `006` change.
3. **AC-104 / SC-106**: over 006's eleven names the class histogram is nine `next-cycle`, one `immediate`, one `next-dispatch`, **zero `restart`, zero `none`**; every descriptor in the projection carries a declared class (SC-107).
4. **AC-113 / NFR-103**: capture `config.json` before and after **every** refusal class ⇒ byte-identical.
5. **AC-127**: an identical body ⇒ `200`, `auditWritten: true` is irrelevant to the no-op claim, and **zero** audit rows are appended.
6. **SC-109 / AC-135 / AC-136**: one changed write ⇒ one `applied` row with one triple per changed field; one refused write ⇒ one `refused` row with `issueCount`, documented names, `<withheld>`, and no submitted value anywhere in the rendered surface or the row.
7. **SC-110 / AC-137**: a `config.changed` row and a `dispatch.*` row carry different correlation ids; a run-filtered read excludes the configuration row.
8. **AC-154**: an absent or non-string member, >80 chars, internal space, and credential-shaped `expectedAgent` values each answer `422` with `field: expectedAgent` and never appear in the body, the audit row, or a log line — while a **blank** value answers `200` and reads back as `""` (the documented *no baseline configured*).
9. **`source` fidelity**: absent file ⇒ `default`; valid file ⇒ `stored`; invalid file ⇒ `quarantined` **and** `defaultsApplied: []`.
10. **Upgrade path**: a ten-field stored document ⇒ `source: 'stored'`, `defaultsApplied: ['expectedAgent']` (filled with the **blank** default), all ten stored values intact; `PUT` of that same body ⇒ `422` naming `expectedAgent`; after one save the file holds the complete document (data-model §2.1). A document that **carries** `expectedAgent: ""` is configured, not missing: it reads back with `defaultsApplied: []` (absence, not emptiness, is what the backfill keys off).
11. **Secret scan**: the whole envelope passes the existing secret suites with new cases and **no exemption** (NFR-102).
