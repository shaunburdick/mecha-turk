# Contract: The Prompt Snapshot on the Wire and in the Message

**Spec**: 004 FR-015, FR-030–FR-039, FR-050, FR-052, FR-053 · amends 003 contracts [claim-lease.md](../../003-dispatch-integrity/contracts/claim-lease.md), [run-history-audit.md](../../003-dispatch-integrity/contracts/run-history-audit.md), and [dispatch-authorization.md](../../003-dispatch-integrity/contracts/dispatch-authorization.md) additively

Everything here is **additive**: four members on a claim entry, three on a run-history row, four
detail keys on two audit rows, three scalars in the attachment `data`. No 003 field, state,
semantic, or vocabulary entry changes (003 v1.1.0 record; 004 `## Amendment Map` — every status
**extended**).

Field-name conventions used throughout (identical names on every surface, so one parser rule and
one renderer rule serve them all):

| Member | Type | Meaning |
| --- | --- | --- |
| `promptPresent` | `boolean` | a prompt was set at the moment this record's snapshot was taken |
| `promptFingerprint` | `string \| null` | `mtp-<sha256 hex[0:32]>`; `null` iff `promptPresent === false` |
| `promptLength` | `number \| null` | Unicode code points of the normalised text; `null` iff `promptPresent === false` |
| `promptText` | `string \| null` | the normalised text — **claim answer only** (transport), never re-stored |

## 1. Claim answer — `GET /v1/events/pending` (003 claim-lease.md §"ClaimedRun" extended)

Each claimed entry gains:

| Field | Type | Notes |
| --- | --- | --- |
| `promptPresent` | `boolean` | from the run's snapshot (`run.prompt !== null`) |
| `promptFingerprint` | `string \| null` | reference for the attachment `data` and the ledger's absence-of-text rule |
| `promptLength` | `number \| null` | the composition's length reference |
| `promptText` | `string \| null` | the text the composition fences; **claim-transport only** — exactly like `sourceReferences[].excerpt`: carried so the panel can build the message, never written anywhere by the panel |

- **Unset runs answer all four explicitly** (`false`, `null`, `null`, `null`) — the co-ship build
  (invariant 1) parses them, and an explicit `null` is a truer answer than an absent key for a
  boolean the panel must act on.
- **Size**: the answer grows by ≤ ~2,100 chars per claimed run (a cap-length `promptText` plus three
  reference scalars); a maximal batch stays under
  `GUEST_REQUEST_RESPONSE_MAX` (256,000) at the product's scale (<10 repositories), and the
  transport guard answers `500 response-too-large` rather than truncating (002 contract §1).
- **Credential-free by construction**: the run parser refuses credential-shaped snapshot text, so
  the answer cannot carry a secret (004 NFR-121).

## 2. Run history — `GET /v1/events` (`RunHistoryRow` extended; 003 run-history-audit.md §1 amended)

| Field | Type | Notes |
| --- | --- | --- |
| `promptPresent` | `boolean` | pre-004 run ⇒ `false` (a true statement about the run, not a hole) |
| `promptFingerprint` | `string \| null` | present iff `promptPresent` |
| `promptLength` | `number \| null` | present iff `promptPresent` |

**No `promptText` here — ever** (004 FR-052: the projection names the prompt; it does not reproduce
it). No existing row field is removed, renamed, or retyped. Refusals unchanged (`503
storage-unavailable` only).

## 3. Audit details — `dispatch.reserved` and `dispatch.result` (003 dispatch-authorization.md §1/§2 amended)

Four required keys join the existing details, written **by the service from the run's snapshot**:

```jsonc
// dispatch.reserved (details, existing keys unchanged)
{ "leaseId": "lse-…", "attempt": 1, "dispatchToken": "dtk-…", "attachmentId": "mt-run-…",
  "bindingId": "bnd-…", "promptPresent": true,
  "promptFingerprint": "mtp-…", "promptLength": 340 }

// dispatch.result (details, existing keys unchanged)
{ "attempt": 1, "dispatchToken": "dtk-…", "sessionId": "ses_…" /* or the failure reason */,
  "bindingId": "bnd-…", "promptPresent": true,
  "promptFingerprint": "mtp-…", "promptLength": 340 }
```

Rules: entity stays the run; correlation stays the run's id (003 FR-062 — the fingerprint is
derived, never minted, so every row of one prompt carries the same value); the scalars are
credential-free by construction (003 FR-061); **no prompt text ever enters any audit row** (004
FR-050, AC-139). Rows that do not record what was sent (`dispatch.claimed`,
`dispatch.lease-expired`, `dispatch.retry`, …) are untouched — the vocabulary delta names exactly
these two rows.

`GET /v1/audit` needs no change: it returns stored rows verbatim, so the new keys ride the existing
correlation-filtered read.

## 4. Attachment `data` — `host.startSession()` (envelope extended, schema version unchanged)

```jsonc
data: { schemaVersion: "extension-spike-1", correlationId: "mt-run-…", repository: "…",
        issueId: "…", detectedAt: "…", panelGeneration: "…",
        promptPresent: true, promptFingerprint: "mtp-…", promptLength: 340 }   // ← three new scalars
```

- **A second copy of the text is forbidden** (004 FR-037, AC-130): the text travels in the
  message's `text`; the data carries only the reference.
- `extension-spike-1` **stays** (plan D9; 002 v1.3.0 migration note). Serialized size grows by
  ≈ 110 chars ≪ `GUEST_ATTACH_DATA_MAX` (16,000).
- `id`, `title`, `url`, `kind`, `text`, `projectId`, `worktree` behave exactly as today.

## 5. Composition rules the tests assert

The normative shape (ordering, fence lines, blank line, frame, delimiters) is the specification's
`## Dispatch Message Composition`; this contract fixes only what a test can pin:

1. **Byte identity when unset** — with `promptPresent === false` the message is byte-identical to
   the pre-004 composition for the same event: no fence, no blank line, no placeholder (004 FR-032,
   SC-121). Golden-string test.
2. **Fence** — `--- BEGIN OPERATOR STARTING PROMPT ---\n<text>\n--- END OPERATOR STARTING PROMPT ---`
   then one blank line, then the unchanged frame. The fence is emitted by the composition and never
   appears in stored text (004 FR-031); a stored line beginning `--- BEGIN `/`--- END ` was refused
   at save (binding-prompt.md §3), so the fence markers of any composed message are always the
   composition's own (004 FR-043, AC-134, SC-129).
3. **Reservation, not truncation** — the prompt block (2,076 chars at the cap) + its blank line is
   subtracted from the composition's dispatch-level budget *before* the excerpt budget is computed;
   every per-item cap and truncation marker then applies to the remainder. The prompt is never
   sliced, ellipsised, re-indented, escaped, or substituted (`{number}` and frame-imitating lines
   arrive literally) (004 FR-035, FR-039, AC-134, AC-145).
4. **Host caps** — composed `text` < `GUEST_ATTACH_TEXT_MAX` (16,000) at every legal input; `data`
   < `GUEST_ATTACH_DATA_MAX`.
5. **One composition** — exactly one function produces the message; nothing on any surface
   re-renders it (004 FR-036).
6. **The prompt changes nothing else** — no agent/model/variant member exists in the request; the
   untrusted delimiters, the correlation id, the resolved project, and the worktree option are
   unchanged; no credential can appear in `text` or `data` (004 FR-038, AC-135, AC-136).

## 6. Invariants (contract tests)

1. A claimed run with a prompt yields a first message whose leading block equals the stored text
   byte for byte inside the fence; a claimed run without one yields today's message byte for byte
   (AC-130, AC-131, SC-121).
2. `data` carries the three scalars and never the text; a scan of the serialized `startSession`
   request for the seeded prompt text finds exactly one occurrence — inside `text` (AC-130).
3. `GET /v1/events` returns the trio for post-004 runs and `false`/`null`/`null` for older ones;
   no row field carries text (AC-139).
4. A seeded run's `dispatch.reserved` + `dispatch.result` rows both carry the four keys with the
   run's binding id and snapshot fingerprint; a correlation-filtered audit read surfaces them and
   no row anywhere in `audit.ndjson` contains the prompt text (AC-139, SC-124).
5. Retry after a binding edit composes a message byte-identical to the first attempt's (AC-138).
6. Maximal prompt + maximal excerpt + frame < 16,000 chars; the excerpt is the part that shortens,
   with a visible marker (AC-145).
