# Contract: The Starting Prompt on the Binding Document

**Spec**: 004 FR-010–FR-014, FR-017–FR-028, FR-051, FR-062 · amends 002 contract §2.3 (bindings) in place

One optional field rides the surface the product already has: `GET/PUT /v1/bindings`. No new
endpoint, no new method, no new error code (004 NFR-129).

## 1. The field

| Rule | Value | Spec |
| --- | --- | --- |
| Name | `startingPrompt` (camelCase, like every other binding field) | 004 FR-010 |
| Type on the wire | `string` | 004 FR-010 |
| Absent | the prompt is **unset** — a complete, valid state; the key is omitted, never sent as `""` or `null` by this service | 004 FR-010, FR-022 |
| Stored `null` (hand-written) | reads as unset; the next write stores the key **absent** | 004 FR-017 |
| Bounds | ≤ **2,000** Unicode code points after trim + normalisation (`\r\n`/`\r` → `\n`) | 004 FR-020, FR-023 |
| Where it lives | service store `bindings.json` only — never `host.storage`, never the ledger | 004 FR-011 |
| Who reads it | **every** `GET /v1/bindings` answer (configuration read — the only read that returns the text) | 004 FR-012 |
| Who never reads it | run/dispatch/audit surfaces (fingerprint only), the ledger, logs | 004 FR-012, FR-053 |

### GET `200 { bindings, status }` (shape unchanged, entries gain the optional member)

```jsonc
{ "bindings": [ { "bindingId": "bnd-…", /* …every existing field… */
                  "startingPrompt": "Reproduce first, then patch." } ],   // omitted entirely when unset
  "status":   [ /* BindingStatusRow[] — unchanged */ ] }
```

The panel's shipped binding parser is tolerant of unknown members and builds its own write objects
field-by-field, so an answer carrying `startingPrompt` neither breaks the panel nor leaks into its
next PUT (see §2).

## 2. PUT — omission preserves, an explicit value sets (004 FR-014)

Request stays `PUT /v1/bindings` with `{ bindings: [...] }` (whole-file replacement).

| Submitted binding | Effect on its stored prompt |
| --- | --- |
| **no `startingPrompt` key** | **preserved** — the stored value is attached before the write. A client that cannot see the field must not be able to erase it (004 FR-014; gate default #4) |
| key present, non-empty string | validated (§3); on success the validated, trimmed, normalised text is stored |
| key present, `""`, whitespace-only, or `null` | **cleared** to unset (key absent in the stored record) |
| key present, invalid | the **whole submission** is refused (§3) — nothing is written, previous values stay in force |

Preservation reads the stored document **inside the same chain that performs the write** (fresh
read, so read → diff → write → baseline linearize; see [plan.md](../plan.md) §"The prompt-change
observer"), so a concurrent read cannot observe a half-merged document. If the stored document itself is unusable (quarantined), there is nothing to
preserve: the PUT writes the submitted list, exactly as the shipped surface behaves today.

**This contract's client of record**: the shipped panel builds `PreparedBinding` without the field,
so every panel save exercises row 1 — which is why row 1 is the load-bearing rule of this feature.

## 3. Validation and the refusal envelope (004 FR-003, FR-013, FR-020–FR-029)

Validation runs on **every write** and on **every read** of the stored file, through the one
validator (`service/prompt.ts` `validateStartingPrompt`, order and rules in
[data-model.md](../data-model.md) §2.1).

Refusals answer through the unchanged envelope:

```jsonc
// 422
{ "error": { "code": "validation",
             "message": "startingPrompt: <remediation>; repository: <remediation>; …",
             "issues": [ { "field": "startingPrompt", "remediation": "<remediation>" }, … ] } }
```

| Condition | `remediation` (verbatim intent; never echoes the value) | Spec |
| --- | --- | --- |
| present but not text (number/boolean/object/array) | `startingPrompt must be text; send it absent or null to leave the starting prompt unset` | FR-017, FR-028 |
| over the cap | `startingPrompt must be at most 2000 characters (Unicode code points) after trimming` | FR-020 |
| null / control character (other than newline or tab) | `startingPrompt must not contain null or control characters other than newline and tab` | FR-026 |
| line begins with `--- BEGIN ` or `--- END ` | `startingPrompt must not contain a line beginning with "--- BEGIN " or "--- END " (reserved composition markers)` | FR-025 |
| credential-shaped material | `startingPrompt must not contain credential-shaped material (matched shape: <label>)` — label from the shipped detector (`github-token-classic`, `github-token-fine-grained`, `authorization-header`, `bearer-credential`) | FR-024 |

Envelope rules that bind this contract: **every** problem in the submission is collected into one
answer (the binding validator now accumulates per-binding issues instead of stopping at the first —
004 FR-013/FR-027); no submitted value, whole or partial, ever appears in `message`, `issues`,
a log line, or an audit row (FR-003, AC-132/AC-133); a refusal writes **no** state and **no** audit
row (the change never happened).

**Store-file read (004 FR-019, AC-141)**: a stored document violating any rule above is refused by
the parser → the store's existing quarantine funnel renames the file → `readBindings` logs
`stored bindings were unusable and have been set aside` with `quarantinePath` **and the reason
`startingPrompt: <remediation>`** (field + remediation only) → the answer to any read is an empty
list, so nothing scans until the operator repairs the file. A file written before this feature
parses unchanged (no quarantine, no rewrite, no window reset — FR-018, AC-142).

## 4. The prompt-change audit row (004 FR-051, `### Audit Vocabulary Delta`)

```jsonc
{ "seq": 42, "timestamp": "2026-09-28T…", "correlationId": "<fresh, non-run id>",
  "eventType": "binding.prompt-updated",
  "actorSource": "operator" | "service",
  "entity": { "kind": "binding", "id": "bnd-…" },
  "decision": "set" | "changed" | "cleared",
  "reason": null,
  "redaction": { "redacted": false, "fields": [] },
  "details": { "bindingId": "bnd-…", "promptPresent": true,
               "promptFingerprint": "mtp-…", "promptLength": 340,
               "previousFingerprint": null | "mtp-…" } }
```

| Rule | Value |
| --- | --- |
| Actor | `operator` when the change arrived through `PUT /v1/bindings`; `service` when it was observed in the store file (poll read, GET, PUT preservation read) — never a claim the panel made a hand edit |
| Cardinality | **exactly one row per change** (set/change/clear), enforced by serialising every bindings read/write/diff/baseline advance on one per-store chain (SC-125) |
| Text | never present in `reason` or `details` (FR-051, FR-053) |
| Correlation | a fresh generated id — `binding.*` is a non-run row under 003's correlation table; it never mints or reuses a run id (003 FR-051/FR-062) |
| Baseline | seeded once per store handle from the highest-`seq` `binding.prompt-updated` row per binding, so `previousFingerprint` survives restarts; a trimmed trail yields `previousFingerprint: null`, which is honest, not missing |
| Failure | an append failure logs `warn` (binding id + fingerprint, never text), state stands, nothing rolls back — 003 FR-063's posture applied to a configuration row |

## 5. Invariants (contract tests)

1. A panel-shaped PUT with no `startingPrompt` anywhere leaves every stored prompt byte-identical (FR-014, AC-137).
2. Explicit `null` / `""` / whitespace-only clears exactly the binding it names; other bindings' prompts are untouched.
3. One submission with a bad prompt **and** a bad other field ⇒ one 422 listing both; the file is byte-identical afterwards; the previous prompt still dispatches (FR-027).
4. Every refusal's `message` and `issues` contain the field name and remediation and **zero characters of the submitted value** (asserted by planting a sentinel value and scanning the whole response).
5. A stored file with a non-text prompt quarantines with the reason logged; a pre-004 file never does (AC-141, AC-142).
6. set → change → clear ⇒ exactly three rows, chained `previousFingerprint` values, correct actors; a restart with an unchanged file writes **zero** rows; a hand edit observed once writes **one** `service` row even when it races a PUT (SC-125).
7. The bindings answer and every audit row scan clean against the shipped secret patterns (NFR-121).
