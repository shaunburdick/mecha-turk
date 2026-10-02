# Data Model: The Layered Starting Prompt (004 v1.4.0)

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.4.0 · **Date**: 2026-10-02 (the gate
re-cut: the account tier's write surface is now the account profile write; supersedes the
2026-10-02 v1.3.0 pass, which supersedes the 2026-09-28 v1.1.0 pass — all preserved in git history)

Conventions (inherited from 002/003 `data-model.md` and this feature's first pass, unchanged):

- **Service tier** = durable store under `$HOME/.config/openchamber/mecha-turk/` — directory
  `0700`, files `0600`, atomic temp+rename writes, NDJSON append for audit. Authoritative for the
  configuration, bindings, accounts, runs, deliveries, and the audit trail.
- **Panel tier** = `host.storage` (extension-namespaced, wiped on uninstall) — **004 adds no key
  and no value** at any tier (FR-011, FR-081, AC-144).
- JSON fields are camelCase; timestamps RFC 3339; **code points**, not UTF-16 units, wherever the
  specification says "characters" (FR-020, FR-085).
- **No credential is a field anywhere below.** Each tier is refused at its save boundary if it is
  credential-shaped (FR-024, FR-083), so nothing downstream can hold one; a fingerprint is a
  content hash and **not** a credential (FR-016).
- **Three tiers, one field name**: `startingPrompt` in `config.json`, on the account record, and on
  the binding record. The tier is identified by the store and the surface that hold it — never by
  a marker in the text (FR-084).

---

## 1. Binding record delta (`bindings.json`) — shipped, unchanged

`BindingRecord.startingPrompt?: string` (key absent when unset) exactly as the v1.1.0 pass built
it: 2,000-code-point cap after trim+normalisation, `validateStartingPrompt` on every read and
write, omission-preserves on the whole-file PUT, quarantine with a logged `field: remediation`
reason when a stored value violates the rules. **Nothing in v1.3.0 or v1.4.0 changes this record's shape or
its rules** — the binding tier is simply the third input to §4's resolver.

## 2. Configuration document delta (`config.json`) — the global tier *(new at v1.3.0)*

`ServiceConfig` (`service/config.ts`) gains **exactly one required member** (FR-081; 006 FR-010,
FR-084 — the twelfth documented field):

| Field | Type | Constraints / source |
| --- | --- | --- |
| `startingPrompt` | `string`, **documented default `""`** | The global tier. Validated by `validateStartingPrompt` (§4) through `collectIssues`, so `PUT /v1/config` refuses a bad value in the same additive `422` as any other field and a stored document that fails validation quarantines the file and serves documented defaults (006's quarantine posture). **Empty string means unset** — config has no "absent" state on the write path |

- **Read fill, not migration**: a stored file predating the member is filled from `""` by
  `parseStoredConfig` and the key is reported in `defaultsApplied` — never as a configured value
  (006 FR-028; FR-018's no-migration rule). The fill writes no audit row: `""` maps to the unset
  fingerprint `null`, which equals a fresh observer baseline (plan N7).
- **Descriptor** (the declaration `configSchema()` projects; one source, read twice — 006 SC-101):

```jsonc
{ "name": "startingPrompt", "kind": "string", "unit": null,
  "format": "<the validator's own rule prose, carrying FR-063's guidance>",
  "maxLength": 2000, "default": "", "takesEffect": "next-cycle" }
```

- `TAKE_EFFECT.startingPrompt = 'next-cycle'` keeps the table exhaustive (a member without a class
  fails `tsc` — 006 SC-106). The class is a tested claim: a detection in the cycle after a save
  composes with the new text; a queued run keeps its snapshot (FR-015, FR-081).
- `StringFieldDescriptor.name` widens from `'expectedAgent'` to `'expectedAgent' | 'startingPrompt'`
  — **no new `kind`**, so the panel's closed parser accepts the field with the union it already has.

## 3. Account record delta (`accounts/<numericUserId>.json`) — the account tier *(member new at v1.3.0; its write surface re-cut at v1.4.0)*

`Account` (`service/accounts/model.ts`) gains **one optional member** (FR-082):

| Field | Type | Constraints / source |
| --- | --- | --- |
| `startingPrompt` | `string \| null`, **absent reads `null`** | The account tier, validated by `validateStartingPrompt` (§4) on **read** as well as write: a stored non-text, oversized, credential-shaped, or marker-imitating value **refuses the record**, so the store quarantines that account file with a logged `field: remediation` reason (never the value) and the account does not scan until the operator repairs it — the bindings store's FR-019 posture applied to this store |

- `AccountDto` gains the same member **by name** (`string | null`); the projection's type-level
  credential guard is untouched, so the credential-free property stays testable by construction.
- **Lifecycle**: rotation, login rename, and credential refresh spread the record and leave the
  member byte-identical (the `displayName` rule). `DELETE ?force=1` removes the record — and with
  it the tier — while still disabling referencing bindings and writing `account.deleted`; a
  re-added account (same numeric id) reads `null`: **no seeding** (FR-071). Queued runs keep their
  snapshot (FR-015).
- **Write — the account profile write** (005 contract
  [`account-display-name.md`](../005-panel-ia/contracts/account-display-name.md) §2, *Account
  Profile Write*; 004 `## Clarifications` row 33): **`PUT /v1/accounts/:numericUserId`**, body
  `{ "displayName"?: string | null, "startingPrompt"?: string | null }` → `200 { account }`. One
  handler carries both operator-editable members; the record itself is never accepted from the
  client.

  | Rule | Detail |
  | --- | --- |
  | Absent member = unchanged | omission means *"I did not change it"* (FR-014's posture applied to this record) — the operation sets, changes, or clears the members it is given and `updatedAt`, nothing else (deep-comparable) |
  | Closed two-member body | the body is read as exactly `{ displayName?, startingPrompt? }`; **any other key** — the eleven custody/identity keys `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt` — is refused `422 validation`, one issue **naming that key** with a field-level remediation, and **no echo of its value** anywhere |
  | No-op refusal | a body carrying **neither** member ⇒ `422 validation`, `field: "body"` — never a silent `200` |
  | All-or-nothing | issues collected additively in one pass (unknown keys and member validation together); **any issue refuses the whole write** — neither member changes, no `updatedAt`, no audit row |
  | Whitelist by construction | the handler writes the **server-read** record spread with the validated operator keys present in the body plus a fresh `updatedAt` — a custody field cannot be overwritten because it is never read out of the body |
  | Validation | `startingPrompt` through the single `validateStartingPrompt` (§4.1); `displayName` through the shipped six-step label rule (type, trim, empty/`null` ⇒ clear, 80-code-point cap, credential shape, control characters) |
  | Audit | a write that changes `startingPrompt` appends exactly one `account.prompt-updated` (§7.2); a **`displayName`-only** write appends **no row** — a label is not a tier, and 005 adds no event type |
  | Refusals | `401 unauthorized`, `404 unknown-account`, `422 validation`, `503 storage-unavailable` — the same set the dedicated member route specified; a refused write leaves both members byte-identical |

  The dedicated `PUT …/starting-prompt` endpoint (004 v1.3.0 — never built) and `PUT
  …/display-name` (shipped, unreleased) both **resolve nowhere**: deleted, with no alias,
  redirect, or legacy handler (005 v1.10.0, 004 row 33 — zero tags, `version` 0.0.1, PR #8).

## 4. The prompt domain — one validator, one resolver, two shapes *(introduced v1.3.0; the account write side re-cut at v1.4.0)*

### 4.1 `validateStartingPrompt(raw: unknown)` — unchanged, now called at three boundaries

The eight-step order (type → trim → empty=unset → normalise → cap → control characters → reserved
markers → `findSecretLeak`) and the closed four-refusal set are **byte-identical to the shipped
rule**; only the call sites multiplied (FR-083):

| Boundary | Call site | Field voice |
| --- | --- | --- |
| Binding write **and** read | `service/bindings.ts` `parseBinding` | `startingPrompt` on the binding document |
| Config write **and** read | `service/config.ts` `collectIssues` | `startingPrompt` in `PUT /v1/config`'s additive `422` |
| Account write **and** read | `service/routes/accounts.ts` (the profile PUT's body reader) + `service/accounts/model.ts` (file) | `startingPrompt` on the account resource |

A refusal at one tier never reads, writes, or reports another tier's stored value (AC-150), and no
submission is ever partially applied (FR-027). On the profile write this last rule is the body's
own: `displayName` rides the same request but validates through its **own** six-step rule under its
own field name — the two validators never share a call site, only a body — and a failure at either
refuses both (§3, all-or-nothing).

### 4.2 Two shapes: a tier, and the composed snapshot

```ts
/** One tier's validated text — what a per-tier change row records. */
interface TierPrompt {
    readonly text: string;        // normalised, ≤ STARTING_PROMPT_MAX_CODE_POINTS, never empty
    readonly fingerprint: string; // ^mtp-[0-9a-f]{32}$ — this TIER's own fingerprint (FR-086)
    readonly length: number;      // code points of the tier text
}

/** The queued record's snapshot — the COMPOSED block body (FR-080, FR-086, FR-087). */
interface PromptSnapshot {
    readonly text: string;        // set tiers joined by exactly one blank line, global → account → binding
    readonly fingerprint: string; // promptFingerprint(text): one mtp- scalar over the body
    readonly length: number;      // code points of the BODY (what the fence wraps)
    readonly sources: readonly PromptSource[]; // ordered, duplicate-free, never empty
}
```

- `promptTierOf(record)` → `TierPrompt | null` (renamed from `promptSnapshotOf`; the rename is the
  compile error that forces every call site to choose which shape it means).
- `resolvePromptSnapshot({ global, account, binding })` → `PromptSnapshot | null` — validates each
  tier, keeps the set ones, joins with `\n\n` in fixed order, hashes the body, derives `sources`.
  **`null` when no tier is set**: no body, no fingerprint, no sources — the composition then emits
  no fence and the message equals the pre-004 golden string (FR-071, FR-032).
- **Fingerprint** (FR-086): `mtp-` + `sha256(utf8(body))[hex 0:32]`, no salt, no configuration —
  a pure function of the body, so a binding-only run's fingerprint is *exactly* the value the
  single-tier build produced (the binding tier alone **is** that golden string, and so is its
  fingerprint). Per-tier fingerprints exist only on the per-tier change rows (§7).
- **Stack bound** (FR-085, research **R-1**): `PROMPT_STACK_MAX(n) = n × 2_000 + 2 × (n − 1)`
  code points — 6,004 at the default cap for three tiers, 9,004 at FR-021's ceiling.

## 5. Queued-record snapshot — the run (`runs.json`)

| Field | Type | Constraints / source |
| --- | --- | --- |
| `prompt` | `PromptSnapshot` \| `null`, **absentable** | Resolved once at enqueue from the three records the cycle already read (§4.2), beside `projectId`/`worktreeOption` (FR-015, FR-080). Never re-read afterwards: an edit to **any** tier, a clear, or an account deletion changes nothing about a stored run (AC-138, AC-149); a retry reuses it and composes byte-identically |

**Reader rules** (`parseStoredPromptSnapshot`, fail closed — the document is refused, never
half-read): `text` non-empty string; `fingerprint` matching `/^mtp-[0-9a-f]{32}$/`; `length` a
positive integer equal to `[...text].length`; `sources` a non-empty array whose elements are
`global|account|binding`, in that relative order, without duplicates, and whose count satisfies
`length ≤ n × 2_000 + 2 × (n − 1)`; `text` free of secret shapes and within that ceiling. The
fingerprint is checked against its **format**, not recomputed (plan D11). **A stored `prompt`
without `sources` refuses the document** — no defaulting branch exists, because no released record
can carry one (row 32, FR-087).

Retention: the snapshot is payload of the run — retained while the run is retained, never outliving
it (FR-019, NFR-122; 003 NFR-107). Delivery rows (`events.json`) still gain **no field**, so
`buildEventId` and the NDJSON event contract are untouched (invariant 10).

## 6. The wire: `promptSources` and what never becomes a copy

`PromptSource = 'global' | 'account' | 'binding'` — one closed vocabulary, declared once in
`src/prompt.ts` (browser-safe) and re-exported by the service's prompt module.

| Surface | Members after v1.4.0 | Carries text? |
| --- | --- | --- |
| Binding document (`GET`/`PUT /v1/bindings`) | `startingPrompt?` | **yes** — binding tier, configuration read |
| Configuration document (`GET`/`PUT /v1/config`) | `startingPrompt: string` | **yes** — global tier, configuration read (FR-081) |
| Account DTO (`GET /v1/accounts`) | `startingPrompt: string \| null` | **yes** — account tier, configuration read (FR-082); never a credential |
| Account profile write (`PUT /v1/accounts/:numericUserId`) | request body `startingPrompt?`, `displayName?` (closed two-member set) | **yes** — the account tier's **only** write path (either or both members, absent = unchanged); a refused submission is never echoed in the answer (§3) |
| Queued-record snapshot (`runs.json`) | `prompt: { text, fingerprint, length, sources } \| null` | **yes** — the work unit's own record |
| Claim answer (`GET /v1/events/pending`) | `promptPresent`, `promptFingerprint`, `promptLength`, `promptText`, **`promptSources`** | **`promptText` only, claim transport** (like `sourceReferences[].excerpt`, never re-stored); unset answers `false, null, null, null, null` |
| Run history (`GET /v1/events`) | presence, fingerprint, length, **`promptSources`** | no (FR-052, FR-087) |
| Audit details (`dispatch.reserved`, `dispatch.result`) | `bindingId`, presence, fingerprint, length, **`promptSources`** | no (FR-050, FR-087) — written by the **service from the run's snapshot**, never from panel input |
| Attachment `data` (`host.startSession`) | presence, fingerprint, length, **`promptSources`** | no — a second copy of the text is forbidden (FR-037); additive within `extension-spike-1` (≈ +30 chars ≪ `GUEST_ATTACH_DATA_MAX`) |
| Panel ledger, `host.storage`, status copy, logs, toasts, error bodies, bundles | **never** (FR-053, NFR-121) | — |

**Invariants on every surface** (FR-087): `promptPresent === true` ⇔ `promptSources` is a
**non-empty** list, ordered as a subsequence of `global, account, binding`, duplicate-free;
`promptPresent === false` ⇔ `promptSources === null`. One violation refuses the entry, and one
refused entry refuses the whole answer (AGENTS invariant 8; AC-151).

## 7. Audit row shapes (`audit.ndjson`)

`AuditEntry`'s shape is unchanged (003 data-model §4); the writer's redaction pass still runs and a
redaction refusal still blocks the write. **No row of any kind carries any tier's text** (FR-053,
FR-088).

### 7.1 `binding.prompt-updated` *(shipped; unchanged)*

Entity `{ kind: 'binding', id }`; own generated correlation id (non-run row); decision
`set | changed | cleared`; details `{ bindingId, promptPresent, promptFingerprint, promptLength,
previousFingerprint }` — the **binding tier's own** fingerprint (FR-086), never the composed body's
unless the binding tier happens to be the only set tier.

### 7.2 `account.prompt-updated` *(new at v1.3.0)*

```jsonc
{ "seq": …, "timestamp": "…", "correlationId": "<fresh, non-run id>",
  "eventType": "account.prompt-updated",
  "actorSource": "operator" | "service",
  "entity": { "kind": "account", "id": "<numericUserId>" },
  "decision": "set" | "changed" | "cleared",
  "reason": null,
  "redaction": { "redacted": false, "fields": [] },
  "details": { "promptPresent": true, "promptFingerprint": "mtp-…", "promptLength": 340,
               "previousFingerprint": null | "mtp-…" } }
```

Actor `operator` for the profile write when `startingPrompt` changes, `service` for a change
observed in the stored record; a **`displayName`-only** write appends **no row** (a label is not a
tier; 005 adds no event type). Exactly
one row per prompt change; baseline seeded once from this event type's own trail (plan N8); an append
failure logs `warn` and the baseline still advances (003 FR-063 posture).

### 7.3 `config.changed` *(006's row, value-free for this field)*

- `details.changes[]` gains `{ field: "startingPrompt", from, to }` where the pair is the field's
  **`mtp-` fingerprint or `null`** — never the text (004 FR-053 outranks 006 FR-071's value-carrying
  default *for this field*; 006 FR-071 as amended), plus `takesEffect["startingPrompt"] =
  "next-cycle"`. Every other field's `from`/`to` is untouched.
- `configChanges()` still compares **raw strings** — it remains the no-op detector (006 FR-048: an
  unchanged document writes nothing).
- **Observed change without a write**: one `config.changed` row with `actorSource: "service"`,
  same `from`/`to` rule; the baseline is the highest-seq `changes[].to` recorded for the field
  (`null` when the trail has none — honest, not missing).
- Refused writes stay value-free exactly as 006 FR-072 requires: issue count + documented field
  names, **no value of any kind**.

### 7.4 The two dispatch rows *(extended)*

`dispatch.reserved` and `dispatch.result` gain **`promptSources`** beside the four scalars already
there — written by the service from the run's snapshot; entity, correlation (the run's id), and
every existing detail unchanged (003 FR-061/FR-062). A run that never reached authorisation still
projects presence, fingerprint, length, and sources through the run-history row, so "which tiers
*would* this run have used" is answerable for every run.

### 7.5 Correlation discipline *(unchanged)*

Lifecycle rows carry the run's id byte-identical; `binding.prompt-updated` and
`account.prompt-updated` carry their own generated ids; `config.changed` carries its own
configuration id. The fingerprint is **derived, never minted**, so 003 FR-062 holds for every new
scalar.

## 8. State: none added

The binding state machine, the eight-state dispatch model, leases, tokens, attempts, and requeue
budgets are untouched (004 `## Out of Scope`). "Prompt set / not set" and "which tiers" are field
values, not states, and **no new `blocked:` reason is added** (plan D22).

## 9. Relationships

```
ServiceConfig (1) ── startingPrompt: string                     [global tier]
Account (1)        ── startingPrompt: string | null             [account tier; deleted with the record]
RepositoryBinding (1) ── startingPrompt?: string                [binding tier]
        │
        │  resolved ONCE at detection (global ∥ account ∥ binding → one body)
        ▼
Run (1) ── prompt: { text, fingerprint, length, sources } | null  [snapshot; dies with the run]

Every entity ──> AuditEntry (0..N):
    binding.prompt-updated  → entity binding, own id, tier fingerprint
    account.prompt-updated  → entity account,  own id, tier fingerprint
    config.changed          → entity service,   own id, fingerprint from/to for this field
    dispatch.reserved / dispatch.result → entity run, run's id, + sources
```

## 10. Validation scenarios (drive the suites)

1. **Resolution matrix**: all three set → body in order, one blank line apart, `sources` all three;
   global only → `['global']`; account + binding → `['account','binding']`; none → `null` and the
   pre-004 golden message (AC-146, SC-121, SC-130).
2. **Layering, not fallback**: a set global tier with no binding tier still contributes (US6
   scenario 2); a missing general tier never suppresses a set specific one.
3. **Per-tier refusals**: the same credential-shaped sentinel refused at all three save paths with
   identical shape labels and **zero characters** of the value anywhere; a refusal at one tier
   leaves the other two byte-identical (AC-150, AC-133).
4. **Config field**: default `""` = unset; 2,000 code points accepted, 2,001 refused; a stored file
   lacking the member fills + reports `defaultsApplied` **and writes no `config.changed` row**; a
   `PUT` missing the member is a `422` (006 FR-041); no-op `PUT` writes no row (006 FR-048).
5. **Config audit**: a `PUT` changing the global tier writes one row whose `from`/`to` match
   `/^(mtp-[0-9a-f]{32}|null)$/`; a **hand edit** observed at the next cycle writes one `service`
   row; a restart with the file unchanged writes none (AC-148, AC-151).
6. **Account lifecycle**: `DELETE ?force=1` removes record + tier, disables referencing bindings,
   writes `account.deleted`; a re-added account reads `null`; rotation and rename leave the tier
   byte-identical; queued runs keep snapshot/fingerprint/sources (AC-149).
7. **Account audit**: set → change → clear ⇒ three `account.prompt-updated` rows, actors
   `operator` for the profile write and `service` for an observed hand edit, `previousFingerprint`
   chaining, exactly one row per change — and a `displayName`-only write (and every refusal)
   appends **none** (FR-088, SC-125's rule at tier granularity).
8. **Snapshot immutability**: set three tiers → detect → edit every tier → claim ⇒ the original
   body/fingerprint/sources; retry ⇒ byte-identical composition (AC-138).
9. **Golden strings (four oracles)**: binding-only ⇒ single-tier golden message **and** golden
   fingerprint; no tier ⇒ pre-004 golden; global-only and three-tier ⇒ fully determined strings
   (AC-146, FR-084).
10. **Budget**: three maximal tiers + maximal excerpt ⇒ composed ≤ `CONTEXT_MAX_CHARS` <
    `GUEST_ATTACH_TEXT_MAX`, excerpt markers intact, no tier shortened; a seeded over-budget claim
    is refused **before `host.startSession()`** with a remediation naming the tiers (AC-147,
    SC-132).
11. **Closed reader**: a claim entry with `promptSources: ["binding","global"]` (out of order),
    `["repo"]` (unknown), `["global","global"]` (duplicate), or presence/sources disagreement is
    refused, and one refusal refuses the whole answer (AC-151).
12. **Run reader**: a stored `prompt` without `sources`, or with `length` beyond
    `n × 2_000 + 2 × (n − 1)`, refuses the **document** (quarantine + logged reason) — never
    defaulted, never coerced (FR-087, invariant 8).
13. **Containment**: seed three tiers and run save → refuse → detect → claim → dispatch → retry →
    audit read; scan `config.json`, `accounts/`, `bindings.json`, `runs.json`, `events.json`,
    `audit.ndjson`, the panel ledger, `host.storage`, captured logs, and both committed bundles:
    each tier's accepted text appears in **exactly two** persisted places (its store record + the
    run snapshot) and a refused value appears **nowhere at all** (FR-053, NFR-121, AC-143).
14. **One rendering per value**: seed three tiers with three distinct sentinels, render all six
    tabs, count elements carrying each sentinel — every count exactly 1, with row summaries at
    presence/length only (005 SC-105, AC-123; FR-089).
15. **Arrival writes nothing**: documents predating all three members boot with zero quarantines by
    arrival, zero scan-window resets, unchanged delivery ids / run keys / correlation ids
    (FR-018, FR-089, SC-128, AC-142).
16. **Account profile write (closed body)**: a one-member body leaves the other member and every
    non-supplied field byte-identical (deep-compare — contract invariant 5); a body containing any
    of the eleven custody/identity keys answers `422` naming that key with **no characters of its
    value** anywhere and leaves the stored record byte-identical, **no `updatedAt` bump** (contract
    invariant 6); a body with neither member answers `422` `field: "body"` (contract invariant 4); a
    forbidden key **plus** a failing allowed member answers one complete issue list and writes
    nothing; `PUT …/display-name` and the never-built `PUT …/starting-prompt` resolve **nowhere**
    — unknown-route refusal, no alias (contract invariant 8; 004 FR-082, 005 FR-066).
