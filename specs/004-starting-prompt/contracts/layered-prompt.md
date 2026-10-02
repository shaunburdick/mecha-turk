# Contract: The Layered Starting Prompt — Global, Account, Binding

**Spec**: 004 v1.4.1 FR-070 – FR-072, FR-080 – FR-089 · amends 004 contracts [binding-prompt.md](./binding-prompt.md) and [dispatch-prompt.md](./dispatch-prompt.md) additively, 006 contract [config-schema.md](../../006-settings-crud/contracts/config-schema.md) for one field, and rides 005 contract [account-display-name.md](../../005-panel-ia/contracts/account-display-name.md)'s **account profile write** *(§2 re-cut 2026-10-02 at 004 v1.4.0 / 005 v1.10.0: the dedicated `…/starting-prompt` endpoint is retired and this tier travels the profile `PUT` beside `displayName`)*

One field name, three namespaces: **`startingPrompt`** in `config.json` (global), in the account record (account), and on the binding document (binding — unchanged, [binding-prompt.md](./binding-prompt.md) still governs it). One validator, one cap, one refusal vocabulary. Resolution and fingerprinting happen **once, at enqueue**; the wire beyond that carries one composed block and one ordered source list.

## 1. The global tier — `startingPrompt` in the configuration document

Rides `GET/PUT /v1/config` (006 contract §1–§2). No new endpoint, no new method, no new error code.

| Rule | Value | Spec |
| --- | --- | --- |
| Name / type | `startingPrompt: string` — a required member of `ServiceConfig`, documented default `""` | 004 FR-081; 006 FR-084 (twelfth field) |
| Empty or `""` | **unset** — stored as the empty string (config has no "absent" state on the write path; the stored read fills a key the file predates with `""` and reports it in `defaultsApplied`) | FR-081, FR-018 |
| Bounds | ≤ **2,000** code points after trim + normalisation; same four refusals as every tier | FR-083, FR-020 – FR-029 |
| Descriptor | `kind: "string"`, `unit: null`, `format` = the validator's own rule prose, `maxLength: 2000`, `default: ""`, `takesEffect: "next-cycle"` | FR-081; 006 FR-020, FR-021 |
| `TAKE_EFFECT` entry | `startingPrompt: 'next-cycle'` — the exhaustive table gains the key, so a config member without a declared class still fails `tsc`; the class is a tested claim (006 FR-031): a detection in the cycle after a save composes with the new text, a queued run does not | 006 FR-030, FR-031; 004 FR-081 |
| Closed union | `StringFieldDescriptor.name` widens from `'expectedAgent'` to `'expectedAgent' \| 'startingPrompt'`; **no new `kind`** — the panel's closed parser accepts the field with the union it already knows | 006 FR-021; fail closed on anything outside the union |
| Read | `GET /v1/config` returns the value inside `{ config, fields }` — the configuration read for this tier, and the only surface outside Settings that carries the text | 004 FR-081, FR-012 |
| Write | `PUT /v1/config`, whole-document, validated before storage; the validator routes this member through `validateStartingPrompt` and reports `field: "startingPrompt"` in the same additive `422` as any other field | FR-083; 006 FR-040, FR-041 |
| Quarantine | A hand-edited `config.json` with an invalid value quarantines the document and serves documented defaults, exactly as any invalid configuration; nothing is coerced or dropped | 004 FR-017, FR-028; 006 edge case |

### The `config.changed` row for this field is value-free

```jsonc
// applied (details.changes, existing keys unchanged for every other field)
{ "field": "startingPrompt", "from": null | "mtp-<32 hex>", "to": null | "mtp-<32 hex>",
  ... }   // takesEffect["startingPrompt"] = "next-cycle"
```

| Rule | Value | Spec |
| --- | --- | --- |
| `from` / `to` | the **fingerprint** of the previous / next normalised block tier text, or `null` = unset. **Never the text** | 004 FR-088, FR-053; 006 FR-071 as amended |
| Observed change | a difference observed in the stored document without a `PUT` writes one `config.changed` row, `actorSource: "service"`, same `from`/`to` rule; baseline seeded from the highest-sequence row for the field, `null` when the trail has none (honest, not missing — the binding observer's posture) | 004 FR-088, FR-051 |
| Refused write | unchanged: `decision: "refused"`, issue count + documented field names, **no value of any kind** | 006 FR-072 (unchanged) |
| No-op | an unchanged document still writes nothing | 006 FR-048 |

**Rejected alternative**: recording the old and new text — banned by 004 FR-053 (text lives in the store record and the run snapshot, nowhere else), and a config row outlives both.

## 2. The account tier — `startingPrompt` on the account record

Rides the **account profile write** specified in [account-display-name.md](../../005-panel-ia/contracts/account-display-name.md) §2 — one route, one handler, one contract for both operator-editable members — with prompt rules instead of label rules. *(Was, v1.3.0: "Mirrors account-display-name.md field-for-field, with prompt rules instead of label rules," with its own dedicated `PUT …/starting-prompt` endpoint below — re-cut at 004 v1.4.0 by the product owner's 2026-10-02 gate ruling: **"Approved except the separate endpoint for prompts. I think the prompts should be part of the record instead of separate CRUD."** That file owns the shared body's shape, its closed-set refusal, its no-op refusal, and its all-or-nothing rule.)*

### Response side — `GET /v1/accounts`

```jsonc
{ "accounts": [ {
    "numericUserId": "123456", "login": "octocat",
    "startingPrompt": "Always reproduce before patching.",   // string | null; null = unset
    /* …every existing member unchanged; `credential` never appears here… */ } ] }
```

- `string | null`; absent or `null` in a stored record reads as `null` (unset) — no migration, upgrade writes nothing (FR-018, FR-082).
- The DTO's type-level credential guard is untouched; the secret-scan suites gain a case, not an exemption (FR-082, NFR-121).

### Write side

```http
PUT /v1/accounts/:numericUserId
Content-Type: application/json

{ "startingPrompt": "Always reproduce before patching." }   // or null / "" to clear; displayName may ride the same body
```

```jsonc
// 200
{ "account": { /* AccountDto, including startingPrompt */ } }
```

| Step | Rule | Failure |
| --- | --- | --- |
| 1 Type | string or explicit `null`; other types refused, never coerced or dropped | `422 validation`, `field: "startingPrompt"` |
| 2–6 | **`validateStartingPrompt`** in full: trim, normalise, ≤ 2,000 code points, credential shape, reserved `--- BEGIN `/`--- END ` marker lines, control characters other than newline/tab — identical labels and remediations to the bindings write | `422 validation`, field + remediation, **zero characters of the value echoed** |
| Clear | `null`, `""`, or whitespace-only ⇒ unset | — |
| Absent member | `startingPrompt` missing from the body ⇒ **unchanged** (004 FR-014's omission-preserves posture applied to this record) | — |
| Scope | the write changes the **supplied** operator members and `updatedAt` and **no other member** — deep-comparable; the client never submits a record (whitelist-by-construction) | — |
| Closed body | the body is a closed set of `{ displayName?, startingPrompt? }`; any other key — notably `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt` — is refused by name with no echo of its value; a body carrying neither member is refused as a no-op | `422 validation`, one issue per cause |
| All-or-nothing | issues are collected additively and **any issue refuses the whole write**: a refusal on `displayName` leaves `startingPrompt` untouched and vice versa — neither member, no `updatedAt`, no audit row | — |

- `404 unknown-account` for an unknown numeric user id; `401` and `503` unchanged.
- A refused write leaves the stored value exactly as it was (FR-003), and the retired `PUT /v1/accounts/:numericUserId/starting-prompt` endpoint (004 v1.3.0) exists nowhere — the gate ruling of 2026-10-02 removed it before it was built, with no alias (004 `## Clarifications` row 33).

### Cascade and lifecycle

| Event | Effect on the tier | Spec |
| --- | --- | --- |
| `DELETE /v1/accounts/:id` (bindings reference it, no `force`) | `409` refusal — nothing changes | 002's accounts contract |
| `DELETE /v1/accounts/:id?force=1` | account record (and its tier) **deleted**; referencing bindings disabled (`binding.disabled`, reason `account deleted with force=1`); `account.deleted` written — all as today | FR-082 |
| Queued runs at deletion time | keep snapshot, fingerprint, sources — dispatch unchanged | FR-015, FR-082 |
| Re-added account (same id) | tier unset; no seeding | FR-071, FR-082 |
| Rotation / login rename | tier untouched (the `displayName` rule) | FR-082 |

### The `account.prompt-updated` audit row

```jsonc
{ "seq": …, "timestamp": "…", "correlationId": "<fresh, non-run id>",
  "eventType": "account.prompt-updated",
  "actorSource": "operator" | "service",
  "entity": { "kind": "account", "id": "123456" },
  "decision": "set" | "changed" | "cleared",
  "reason": null,
  "redaction": { "redacted": false, "fields": [] },
  "details": { "promptPresent": true, "promptFingerprint": "mtp-…", "promptLength": 340,
               "previousFingerprint": null | "mtp-…" } }
```

Exactly one row per change (`operator` via the write op, `service` when observed in the store), never the text, fresh non-run correlation id — `binding.prompt-updated`'s shape under the `account.*` family 003's vocabulary already carries (FR-088).

## 3. Resolution, snapshot, and `promptSources` on the wire

Field-name conventions (identical on every surface — one parser rule, one renderer rule):

| Member | Type | Meaning |
| --- | --- | --- |
| `promptSources` | `('global' \| 'account' \| 'binding')[] \| null` | tiers that contributed, **most general first**, duplicate-free, a subsequence of that order; `null` iff `promptPresent === false` |

Everything [dispatch-prompt.md](./dispatch-prompt.md) defines keeps its name and meaning; **one member joins it everywhere the fingerprint is**:

| Surface | Members after this contract | Notes |
| --- | --- | --- |
| Queued-record snapshot (store) | `prompt`, `promptFingerprint`, `promptLength`, `promptSources` | resolved once at enqueue, beside project + worktree option (FR-015, FR-080) |
| Claim answer `GET /v1/events/pending` | + `promptSources` | `promptText` stays claim-transport only; unset runs answer `false, null, null, null, null` |
| Run history `GET /v1/events` | + `promptSources` | never `promptText`; no legacy case exists — the feature has never been released (spec row 32), so every record that carries a prompt carries `promptSources` |
| Audit details `dispatch.reserved` / `dispatch.result` | + `promptSources` | beside presence/fingerprint/length; no text, ever (FR-088) |
| Attachment `data` | + `promptSources` | additive within `extension-spike-1` (002 §1's additive rule); ≈ +30 chars, far under `GUEST_ATTACH_DATA_MAX` |

**Fail-closed reader rule** (extends [dispatch-prompt.md](./dispatch-prompt.md) §1): the closed parser accepts `promptSources` only when it is a non-empty list iff `promptPresent`, every element is one of the three tier names, and the order is a subsequence of `global, account, binding`. Unknown tier, wrong order, duplicate, or presence/sources disagreement ⇒ **refuse the entry**, and one refused entry refuses the whole answer (the reader's standing posture; AGENTS.md invariant 8). `readPromptReference`'s existing iff-discipline extends to this member.

## 4. Composition rules the tests assert (FR-084, FR-085)

The normative shape is the specification's `## Dispatch Message Composition`; this contract pins what a test can pin:

1. **One fence** — `--- BEGIN OPERATOR STARTING PROMPT ---\n<body>\n--- END OPERATOR STARTING PROMPT ---` then one blank line, then the unchanged frame. `<body>` = set tiers joined by one blank line (`\n\n`) in order global → account → binding. The fence constants are fixed literals emitted by the composition; no tier label is emitted (FR-084).
2. **Byte identity per case — golden-string oracles, not upgrade promises** (no build holding any of this was released — spec row 32): binding-only ⇒ equals the single-tier golden string *and* its golden fingerprint (the body is those bytes); no tier set ⇒ equals the pre-004 golden string (no fence, no blank line, no placeholder); global-only or account-only ⇒ fully determined strings (order fixed, separator fixed). Golden-string tests for all four (FR-084, AC-146).
3. **Budget** — the block is subtracted from the dispatch budget before the excerpt budget is computed, exactly as today, with `promptBlockChars` measuring the *stacked* body + fence (≤ **6,080** at default caps = 6,004 body — 3 × 2,000 + two blank-line gaps × 2 — plus the 76-char fence; ≤ 9,080 at FR-021's 3,000 ceiling = 9,004 + 76). Maximal block + frame + maximal excerpt = 7,680 ≈ 7,700 ≤ `CONTEXT_MAX_CHARS` (12,000) < `GUEST_ATTACH_TEXT_MAX` (16,000); at the 3,000 ceiling 10,680 ≈ 10,700, still inside. If a legal composition could still exceed the bound — only a store validated past its own rules gets there — **refuse the dispatch before `startSession()`** with a remediation naming the tiers: no session, no truncation of tier, frame, or marker (FR-085).
4. **Fingerprint** — `promptFingerprint = mtp-<sha256(normalised block body)[0:32]>`, computed by the service from the body alone (FR-086); `promptLength` = code points of the body (what the fence wraps), `null` iff presence is false.
5. **One composition** — the panel's single composition function builds the message from the snapshot's four members; nothing on any surface re-renders or re-splits it (FR-036, FR-084).

## 5. Invariants (contract tests)

1. Three tiers set ⇒ first message = global, blank line, account, blank line, binding, inside one fence, frame unchanged beneath; `promptSources` on claim, run row, both audit rows, and attachment `data` reads `["global","account","binding"]` (AC-146).
2. Binding-only ⇒ message equals the single-tier golden string and its fingerprint the golden fingerprint; no tier set ⇒ the pre-004 golden string (AC-146, SC-121) — pinned as golden strings, since no earlier build was released (spec row 32).
3. The same credential-shaped sentinel is refused at all three save paths with identical shape labels and zero characters of the value anywhere in the responses, logs, or stores; a refusal at one tier leaves the other two byte-identical (AC-150) — and on the account profile write, a refusal at either body member leaves **both** stored members byte-identical, with no `updatedAt` bump and no audit row (004 FR-082, 005 `account-display-name.md` §4).
4. `DELETE ?force=1` removes record and tier together; a re-added account reads `null`; a queued run's snapshot is byte-identical before and after (AC-149).
5. `audit.ndjson` scanned for a seeded sentinel tier text ⇒ 0 occurrences; `config.changed`'s `from`/`to` for this field match `/^(mtp-[0-9a-f]{32}|null)$/` in every row (AC-148, AC-151).
6. A claim entry carrying `promptSources: ["binding","global"]` (out of order) or `["repo"]` (unknown) is refused, and the whole answer is refused with it (AC-151).
7. No record carrying a prompt without `promptSources` exists to project — the feature has never been released (spec row 32) — and the reader refuses such an entry rather than defaulting it if one ever arrived (FR-087, AC-151).
8. Maximal three tiers + maximal excerpt ⇒ composed length ≤ `CONTEXT_MAX_CHARS` and < `GUEST_ATTACH_TEXT_MAX`, excerpt markers intact, no tier shortened; a seeded over-budget input is refused, starting no session (AC-147).
9. Every binding, config, and accounts store answer scans clean against the shipped secret patterns with all three tiers populated (NFR-121).
