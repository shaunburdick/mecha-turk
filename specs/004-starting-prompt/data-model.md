# Data Model: Per-Binding Starting Prompt

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.1.0 · **Date**: 2026-09-28

Conventions (inherited from 002 `data-model.md` and 003 `data-model.md`, unchanged):

- **Service tier** = durable store under `$HOME/.config/openchamber/mecha-turk/` — directory `0700`, files `0600`, atomic temp+rename writes, NDJSON append for audit. Authoritative for bindings, runs, deliveries, and the audit trail.
- **Panel tier** = `host.storage` (extension-namespaced, wiped on uninstall) — **004 adds no key and no value** (004 FR-011, AC-144).
- JSON fields are camelCase; timestamps RFC 3339; code points, not UTF-16 units, when the spec says "characters" (004 FR-020).
- **No credential is a field anywhere below.** Prompt text is refused at the save boundary if it is credential-shaped (004 FR-024), so nothing downstream can hold one; the fingerprint is a content hash and **not** a credential (004 FR-016).

---

## 1. Binding record delta (`bindings.json`)

`BindingRecord` (`service/bindings.ts`) gains **exactly one optional field** (004 FR-010, 002 `## Key Entities` amendment):

| Field | Type | Constraints / source |
| --- | --- | --- |
| `startingPrompt` | `string`, **key absent when unset** | Operator-authored text: at most `STARTING_PROMPT_MAX_CODE_POINTS = 2_000` Unicode code points after trim+normalisation; validated by `validateStartingPrompt` (§2) on **every** read and write of the file. Explicit stored `null` also reads as unset and is rewritten as an *absent key* on the next write (004 FR-017, FR-022). Present-but-non-text (number/boolean/object/array) is **unusable**: the file refuses (quarantine + logged reason) and the write path refuses (422) — never coerced, cast, defaulted, or dropped (004 FR-017, FR-028, AC-131) |

Every other binding field, the binding state machine (`active | disabled` in shipped code), and the file's top-level **array-of-records** shape are unchanged. There is no schema version on this file and none is added (004 FR-018): absence is the correct reading of "unset", so nothing needs to be computed at upgrade.

**Ownership** (004 FR-011): service-owned configuration. Not panel UI state, never written to `host.storage`, never mirrored into the panel ledger.

**Where the field is stored and read**:

```
bindings.json ── readBindings ──▶ BindingRecord[]            (GET /v1/bindings, poll loop, PUT's preservation read)
            └── PUT /v1/bindings ── validate + preserve ──▶ write ──▶ binding.prompt-updated rows
```

**Unusable stored prompt** (004 FR-019, AC-141): `parseBindingsFile` returns `null` → the store's existing quarantine funnel renames the file → `readBindings` logs the reason as `field: remediation` (captured from the validator through a closure — **never the value**) and returns `[]` → the poll loop scans nothing until the operator repairs the file. No silent rewrite, no dropped binding, no scan-window change.

---

## 2. The prompt domain (validation order and fingerprint)

### 2.1 `validateStartingPrompt(raw: unknown)` — one validator, called on read and write

Returns `{ ok: true, prompt: string | null }` (the normalised text, or `null` for unset) or
`{ ok: false, issue: { field: 'startingPrompt', remediation } }`. Order is normative because two
edge cases depend on it (CRLF is a line ending, not a refusal; empty-after-trim is a clear, not a
refusal):

| # | Step | Outcome on violation | Spec |
| --- | --- | --- | --- |
| 1 | Type: absent → `null` (unset); explicit `null` → `null`; string → continue | **refuse** — "must be text; send it absent or null to leave the starting prompt unset" | FR-017, FR-028 |
| 2 | Trim leading/trailing whitespace only | — (internal bytes are the instruction) | FR-022 |
| 3 | Empty after trim → unset (`null`), stored as an **absent key** | never a refusal, never an "empty instruction" state | FR-022, FR-071 |
| 4 | Normalise line endings: `\r\n` → `\n`, lone `\r` → `\n` | — (before step 6, so CRLF pastes are not refused as control characters) | FR-023 |
| 5 | Code points of the normalised text (`[...text].length`) ≤ **2,000** | **refuse** — "must be at most 2000 characters (Unicode code points) after trimming"; no silent truncation | FR-020, AC-132 |
| 6 | No null character and no control character other than `\n`/`\t` — i.e. reject `[\u0000-\u0008\u000B-\u001F\u007F-\u009F]` (step 4 has already normalised every `\r` away, so a CRLF paste is never refused here) | **refuse** — "must not contain null or control characters other than newline and tab" | FR-026 |
| 7 | No line begins with a reserved prefix: `--- BEGIN ` or `--- END ` (trailing space included, so `--- BEGINNING …` is ordinary text) | **refuse** — names the marker **family**, never the line | FR-025, AC-134 |
| 8 | `findSecretLeak(text)` (shipped `src/redaction.ts` `SECRET_PATTERNS`) | **refuse** — names the matched **label** (`github-token-classic`, `github-token-fine-grained`, `authorization-header`, `bearer-credential`), never the value | FR-024, AC-133 |

The set is closed: length, credential shape, reserved marker, well-formedness — **no content policy**
(004 FR-029). Remediation strings live in `service/prompt.ts` in the shipped `BindingIssue` voice;
no refusal quotes the submitted text (004 FR-003, AC-132/AC-133).

### 2.2 `promptFingerprint(text)` — PromptFingerprint

```
promptFingerprint = "mtp-" + sha256(utf8Bytes(normalisedText)).hex.slice(0, 32)
wire/format guard : /^mtp-[0-9a-f]{32}$/          (36 chars, one URL-safe path segment)
```

- **Input**: the normalised, trimmed text **only** — no salt, no configuration, no clock, no binding id (004 FR-016; AC-140: same text ⇒ same value across restarts, hosts, reinstalls, and machines).
- **Properties used elsewhere**: fixed length (log/audit/URL safe), deterministic, and — because step 8 refuses credential-shaped prompts before anything is stored — never a hash of a secret (004 FR-024's closing clause).
- **Not stored on the binding**: derived on demand from the text (004 `### Key Entities`: the binding gains *one* field). It **is** stored where it is recorded rather than derived at read time: on the run snapshot, in audit details, and on projections — so historical references survive an algorithm change (plan D11: the run parser checks the *format*, not the derivation).

### 2.3 `PromptSnapshot`

```ts
interface PromptSnapshot {
    readonly text: string;        // normalised, ≤ 2,000 code points, never empty
    readonly fingerprint: string; // ^mtp-[0-9a-f]{32}$
    readonly length: number;      // [...text].length
}
```

`promptSnapshotOf(binding)` returns the snapshot, or `null` when the binding's prompt is unset.

---

## 3. Queued-record snapshot — the run (`runs.json`, 003's document)

| Field | Type | Constraints / source |
| --- | --- | --- |
| `prompt` | `PromptSnapshot` \| `null`, **absentable** | Snapshotted at enqueue from the **same binding object that produced `projectId` and `worktreeOption`** (`scanBinding` → `enqueueEvents` → run creation), inside the queue chain (004 FR-015). `null`/absent = no prompt at detection. Never re-read from the binding afterwards: a binding edit, a clear, or a delete changes nothing about a stored run (AC-138); a retry (003 FR-041) reuses it and therefore composes a byte-identical message |

- **Exactly two persisted places hold the text** (004 FR-053): the binding record (§1) and this
  snapshot. **Delivery rows (`events.json`) gain no field** — the delivery keeps its detection
  fields (`projectId`, `worktreeOption`, excerpts) byte-identical, so `buildEventId`, dedupe, and
  the NDJSON event contract are untouched (002 FR-012, `AGENTS.md` invariant 10).
- **Retention**: payload of the run — it is retained while the run is retained and dies with the
  run's terminal-tail eviction; it must not outlive the record (004 FR-019, NFR-122; 003 NFR-107).
- **Run parser validation** (004 FR-028 fail closed, C8): `prompt` must be `null`/absent or an
  object with `text` a non-empty string ≤ 2,000 code points, `fingerprint` matching
  `/^mtp-[0-9a-f]{32}$/`, `length` a non-negative integer equal to `[...text].length`, and `text`
  free of secret shapes. Any violation refuses the **document** (quarantine + logged reason) — the
  same posture as a violating bindings file, and the reason `promptText` on the claim answer can
  never be credential-shaped. The fingerprint is **not** recomputed (plan D11).

### 3.1 What never becomes a copy

| Surface | Prompt text? | Reference fields |
| --- | --- | --- |
| Claim answer entries (`GET /v1/events/pending`) | **yes — transport only** (`promptText`), like `sourceReferences[].excerpt`; never re-stored | `promptPresent`, `promptFingerprint`, `promptLength` |
| Run history rows (`GET /v1/events`) | no | `promptPresent: boolean`, `promptFingerprint: string \| null`, `promptLength: number \| null` (pre-004 run ⇒ `false` / `null` / `null`) |
| Attachment `data` (`host.startSession`) | no (004 FR-037 forbids a second copy) | same three scalars |
| Panel ledger, `host.storage`, status copy, logs, toasts, error bodies | **never** (004 FR-053, NFR-121) | — |
| Audit rows (all) | **never** (004 FR-050, FR-053) | see §4 |

---

## 4. Audit row shapes (`audit.ndjson` — one new event type, four new detail scalars)

`AuditEntry`'s shape is unchanged (003 data-model §4): seq, timestamp, correlationId, eventType,
actorSource, entity, decision, reason, redaction metadata, details; the writer's redaction pass
still runs and a redaction refusal still blocks the write.

### 4.1 `binding.prompt-updated` (new — 004 `### Audit Vocabulary Delta`)

| Column | Value |
| --- | --- |
| `eventType` | `binding.prompt-updated` — **non-lifecycle**: the `binding.` prefix 003's data-model §4.2 already reserved; no 003 row is edited (003 FR-060 extension) |
| `actorSource` | `operator` when the change arrived through the panel (the `PUT /v1/bindings` path), `service` otherwise (a change observed in the store file — the poll loop, a GET, the PUT's own preservation read) — 004 FR-051's actor rule: the record never claims a human did what a script did |
| `entity` | `{ kind: 'binding', id: <bindingId> }` |
| `correlationId` | a fresh generated id — `binding.*` is a **non-run** row, so it carries its own id exactly as 003's correlation table (§4.1) prescribes; it is never a run's id (003 FR-052) and never derived from the fingerprint (003 FR-062) |
| `decision` | `set` (unset → set) \| `changed` (set → different set) \| `cleared` (set → unset) |
| `reason` | `null` — the details carry the facts; no free text, therefore nothing to redact |
| `details` | `{ bindingId: string, promptPresent: boolean, promptFingerprint: string \| null, promptLength: number, previousFingerprint: string \| null }` — **never the text**; `promptFingerprint` is `null` iff `promptPresent` is `false`; `previousFingerprint` is `null` when no earlier row records one (fresh baseline, or a trimmed trail) |
| When | Exactly one row per change: the PUT's write task for a submitted change (actor `operator`); the observation chain task for a difference found on read (actor `service`). Bindings removed from a document are not prompt changes and write no row |

### 4.2 Detail scalars added to two 003 rows (003 FR-061 extension)

On **`dispatch.reserved`** and **`dispatch.result`** — the rows that record what was sent — four
required keys are added, written by the **service from the run's snapshot** (never from panel
input, never from the request body):

```jsonc
{ "bindingId": "bnd-…",
  "promptPresent": true,
  "promptFingerprint": "mtp-…",   // null when promptPresent is false
  "promptLength": 340 }           // null when promptPresent is false
```

Everything 003 specifies for those rows stands: entity = the run, correlation = the run's id,
the existing details (lease id, attempt, `dispatchToken`, attachment id, session id or reason) are
untouched, and no lifecycle type is renamed or removed. Because the fingerprint is derived from the
text and not minted per row, every row for one prompt carries the identical value (003 FR-062
reaffirmed; 004 FR-050).

### 4.3 Correlation discipline (unchanged, re-stated for this feature)

| Row family | `correlationId` |
| --- | --- |
| `dispatch.reserved`, `dispatch.result` (and every other lifecycle row) | the **run's** id, byte-identical (003 FR-062; 004 FR-038) |
| `binding.prompt-updated` | its own generated id (non-run row, 003 correlation table) |
| Delivery / poll / consent / account rows | as shipped — untouched |

---

## 5. State: none added

The binding state machine gains **no transition** (002 amendment record: "a binding is not
`blocked`, and no new transition exists, for a missing or refused prompt"); 003's eight-state
dispatch model, leases, tokens, attempts, and requeue budget are untouched (004
`## Out of Scope`). "Prompt set / not set" is a field value, not a state.

---

## 6. Relationships

```
Account (1) ──< RepositoryBinding (1)──startingPrompt?          [field added, entity unchanged]
RepositoryBinding (1) ──> PromptSnapshot on its runs (0..1 each) [captured at each run's enqueue]
Run (1) ──> prompt: PromptSnapshot | null                        [snapshot; dies with the run]
Every entity ──> AuditEntry (0..N):
    binding.prompt-updated → entity binding, own correlation id
    dispatch.reserved / dispatch.result → entity run, run's id, +4 prompt scalars
```

---

## 7. Validation scenarios (drive the suites)

1. **Field acceptance matrix**: absent → unset; `null` → unset; `""` and whitespace-only → unset
   (key absent on write); 2,000 code points → accepted; 2,001 → refused naming field+cap; a
   surrogate-pair string counted by code points, not UTF-16 units (AC-132).
2. **Refusal matrix**: number / boolean / object / array, control characters, each reserved-prefix
   line, each of the four secret labels → one issue each, `field: 'startingPrompt'`, remediation
   present, **submitted value absent from issue, message, log, and audit** (AC-131/AC-132/AC-133).
3. **Additive-atomic PUT**: submission with one bad prompt and one bad other field ⇒ 422 listing
   both (plus any other problem in any binding), file untouched, previous prompt still in force
   (004 FR-027).
4. **Omission preserves / explicit sets**: panel-shaped PUT (no `startingPrompt` anywhere) ⇒ stored
   prompts byte-identical; explicit value sets; explicit `null`/empty clears exactly the named
   binding (AC-137).
5. **Fingerprint determinism**: same text ⇒ same `mtp-…` across service restarts and two temp
   stores; CRLF and LF pastes of "the same text" fingerprint identically; format matches
   `/^mtp-[0-9a-f]{32}$/` (AC-140, FR-023).
6. **Exactly one audit row**: set → change → clear ⇒ three rows total, actors `operator`,
   decisions `set`/`changed`/`cleared`, `previousFingerprint` chaining; a hand edit observed on the
   next read ⇒ one `service` row; restart with the file unchanged ⇒ **zero** new rows; PUT racing a
   poll-cycle read ⇒ still exactly one row per change (SC-125, AC-139).
7. **Snapshot at enqueue**: set prompt → detect → edit prompt → claim ⇒ claim carries the original
   text/fingerprint; retry ⇒ byte-identical composition; coalesced second delivery does not replace
   the snapshot (AC-138).
8. **Byte identity (golden)**: seeded event on a prompt-less binding ⇒ composed message equals a
   literal captured from the pre-004 `buildBoundedContext`; stored `null` behaves identically; no
   fence, no placeholder (SC-121, AC-131).
9. **Budget**: 2,000-code-point prompt + long body ⇒ prompt appears in full, excerpt shortened with
   a visible marker, composed `text` < `GUEST_ATTACH_TEXT_MAX` (AC-145).
10. **Quarantine**: `bindings.json` with `startingPrompt: 42` (or any §2 violation) ⇒ quarantined,
    logged reason `startingPrompt: <remediation>`, bindings list empty ⇒ no scanning, no silent
    rewrite (AC-141); a pre-004 file ⇒ **no** quarantine (AC-142).
11. **Containment scan**: seed a prompt, run save → detect → claim → dispatch → retry → audit read;
    then scan the bindings store, `runs.json`, `events.json` (unchanged), `audit.ndjson`, the panel
    ledger, `host.storage`, captured logs, and both committed bundles: the text appears in **exactly
    two** persisted places (binding + run snapshot) and nowhere else; a refused value appears
    **nowhere at all** (FR-053, NFR-121, AC-133, AC-143).
12. **Projection**: pre-004 run ⇒ `promptPresent false`, `promptFingerprint null`; post-004 run with
    a prompt ⇒ all three scalars; no projection field ever carries text (AC-139).
