# Data Model: Settings — Full Service Configuration CRUD

**Feature**: `specs/006-settings-crud` · **Spec**: v1.3.0 · **Date**: 2026-09-28

Everything below is a **delta** against the shipped store and wire shapes. 006 adds **no store file** and renames **no** field, key, path, or vocabulary; the two files a trim pass rewrites (`audit.ndjson`, `events.json`) keep their formats byte-for-byte apart from the one added marker, and `config.json` gains one member.

---

## 1. `config.json` — the configuration document

### 1.1 `ServiceConfig` delta

| Field | Type | Bounds / constraint | Default | Take-effect | Owner |
| --- | --- | --- | --- | --- | --- |
| `intervalMs` | number | 15,000–300,000 ms | 60,000 | `next-cycle` | as shipped (002 FR-017) |
| `overlapMs` | number | 60,000–7,200,000 ms | 600,000 | `next-cycle` | as shipped; **consumer added by 006** |
| `perPage` | number | 1–30 items per page | 30 | `next-cycle` | as shipped; **consumer added by 006** |
| `retryMaxAttempts` | number | 1–10 attempts | 5 | `next-cycle` | as shipped; **consumer added by 006** |
| `retryBaseMs` | number | 1,000–60,000 ms | 5,000 | `next-cycle` | as shipped; **consumer added by 006** |
| `retryMaxMs` | number | 5,000–300,000 ms | 60,000 | `next-cycle` | as shipped; cross-field rule `retryBaseMs ≤ retryMaxMs` retained |
| `auditRetentionDays` | number | 7–3,650 days | 180 | `next-cycle` | as shipped; **consumer added by 006** |
| `auditMaxEntries` | number | 1,000–1,000,000 entries | 50,000 | `next-cycle` | as shipped; **consumer added by 006** |
| `excerptRetentionDays` | number | 1–365 days | 30 | `next-cycle` | as shipped; **consumer added by 006** |
| `logLevel` | enum `debug \| info \| warn \| error` | closed set | `info` | **`immediate`** | as shipped; **consumer added by 006** |
| **`expectedAgent`** | **string** | non-empty after trim; ≤ 80 chars; `letters, digits, and . _ - @ : /`; credential-shaped values refused | **`project-manager`** | **`next-dispatch`** | **NEW — 006 FR-100** |
| `leaseMs` *(after 003 T-008)* | number | 30,000–600,000 ms | 120,000 | `next-cycle` *(declared by 006, confirmable by 003)* | 003 plan D9/C14, 003 data-model §2.7 |
| `resultDeadlineMs` *(after 003 T-008)* | number | 30,000–600,000 ms | 120,000 | `next-cycle` *(declared by 006, confirmable by 003)* | as above |

**Field-count dynamics**: **eleven** is 006's criterion of record (FR-084, AC-101); **thirteen** is the combined tree once 003's two land — they arrive through **003's own amendment**, and 006 renders them because the projection is derived from the declaration rather than from a count. See [plan.md](./plan.md) § *Config-field count dynamics* for how the tests hold both truths.

### 1.2 Type shape (the validator and the projection read one declaration)

```ts
// service/config.ts
type ServiceConfigField = keyof ServiceConfig;          // exhaustiveness source
type TakeEffect = 'immediate' | 'next-cycle' | 'next-dispatch' | 'restart' | 'none';

interface ServiceConfig { /* …the eleven above… */ readonly expectedAgent: string; }

const TAKE_EFFECT: Record<ServiceConfigField, TakeEffect> = {
    intervalMs: 'next-cycle', /* …nine next-cycle… */
    logLevel: 'immediate',
    expectedAgent: 'next-dispatch',
};
```

- `Record<ServiceConfigField, TakeEffect>` is **exhaustive**: adding a member to `ServiceConfig` without declaring a class is a type error, so "a field gained no consumer" cannot survive `npm run typecheck` (plan D2).
- `kind` is a closed set `integer | enum | string`; the **string** kind exists only for `expectedAgent` and carries `format` (service-authored prose) + `maxLength` in place of `min`/`max`, and **no unit** (FR-021).

### 1.3 `expectedAgent` validation (FR-100(c))

One declaration, additive 422, `field` + `remediation`, **submitted text echoed nowhere**:

| Rule | Refusal remediation (service-authored, value-free) |
| --- | --- |
| non-empty after trimming | `set expectedAgent to a non-empty agent name` |
| ≤ 80 characters | `set expectedAgent to at most 80 characters` |
| only `A–Z a–z 0–9 . _ - @ : /`, a single token | `set expectedAgent to letters, digits, and . _ - @ : / with no spaces` |
| not credential-shaped (`findSecretLeak`) | `set expectedAgent to an agent name, not a credential` |

The **stored value is the trimmed value** — matching the card setting's behaviour (`src/config.ts` `parseExpectedAgent` trims), so a save/load round trip is stable and the audit `from`/`to` pair records the value as it stands.

### 1.4 `DEFAULT_CONFIG`

```ts
export const DEFAULT_CONFIG: ServiceConfig = {
    intervalMs: 60_000, overlapMs: 600_000, perPage: 30,
    retryMaxAttempts: 5, retryBaseMs: 5_000, retryMaxMs: 60_000,
    auditRetentionDays: 180, auditMaxEntries: 50_000, excerptRetentionDays: 30,
    logLevel: 'info',
    expectedAgent: 'project-manager',        // NEW (FR-100(b))
    // leaseMs: 120_000, resultDeadlineMs: 120_000  — 003's, added by 003 T-008
};
```

`DEFAULT_CONFIG.expectedAgent` is **also** the value 002 FR-029 specifies for a missing or unreadable baseline (FR-100(b)) — one source for both the store default and the projection's `default` entry.

---

## 2. Upgrade path for a pre-existing `config.json`

**The question**: FR-100(b) makes `expectedAgent` a *required* member of the whole-document configuration ("an absent key is refused like any other missing field"), while 006's v1.3.0 migration impact requires a **ten-field document to keep reading** with `expectedAgent` rendered *as a declared default, not as a configured value*. Strict whole-file validation on the **read** path would quarantine that document and show the operator **every** value as a default — losing nine configured values over one missing key.

**The answer — two validators with two different jobs:**

| Path | Missing **documented** key | Unknown key | Malformed value |
| --- | --- | --- | --- |
| **`PUT /v1/config`** (operator submission) | **refused** — `422`, one issue, nothing written (FR-040, FR-041, FR-100(b)) | **refused** (`<withheld>` when secret-shaped) | **refused** |
| **`parseStoredConfig`** (a document a previous build wrote) | **filled from `DEFAULT_CONFIG`** and reported in `defaultsApplied` | **quarantined** (invariant 8 — never partially applied) | **quarantined** |

Backfilling a *known, documented* key with its *documented* default is schema evolution, not partial application: every value that is present is still validated in full, and anything the build does not understand still refuses the whole document.

### 2.1 Sequence for an existing installation

```text
pre-006 store                     after 006 starts                     first operator save
─────────────────                 ───────────────────────               ────────────────────
config.json: 10 fields      →     read: all ten validated,             PUT sends the full document
(no expectedAgent)                 expectedAgent filled from            (last-read values ∪
                                   DEFAULT_CONFIG, reported in          projection defaults for
                                   defaultsApplied:['expectedAgent']    missing keys ∪ edits)
                                  GET: source:'stored'                        ↓
                                  panel row reads *default*            config.json: 11+ fields,
                                                                     complete and strict-valid
```

- **A read writes nothing** (FR-049, NFR-104): the file stays ten-field until an operator saves. That is deliberate — the service must not mutate durable configuration because it was asked what the configuration is.
- **No operator action and no invented value is required**: the panel's draft builder unions the last-read document with the projection's `default` for every key the document lacks, so the first save writes the complete document (006 v1.3.0 migration impact, verbatim).
- **Quarantine is unchanged** for a genuinely invalid document: `source: 'quarantined'`, defaults served, and the tab says the stored configuration was unusable and set aside — **not** that the operator's values are current.
- **Same mechanism for 003**: 003's T-008 requirement "existing config documents still parse (additive)" is satisfied by this one rule (plan X6). If 003 ships it first, 006's task reduces to adding the `defaultsApplied` reporting; if not, 006 ships both.

---

## 3. The `GET /v1/config` projection

### 3.1 Envelope

```jsonc
{ "config": ServiceConfig,          // the effective document (unchanged member)
  "fields": FieldDescriptor[],      // NEW — the declaration, projected
  "source": "stored" | "default" | "quarantined",   // NEW — where `config` came from
  "defaultsApplied": string[] }     // NEW — documented keys filled from DEFAULT_CONFIG on read
```

| `source` | Meaning | Panel rendering |
| --- | --- | --- |
| `stored` | `config.json` read and validated | values are configured; rows in `defaultsApplied` read **default** |
| `default` | no `config.json` (fresh store) | every row reads **default** |
| `quarantined` | present but unusable, set aside | *the stored configuration was unusable and set aside*; no value presented as configured |

### 3.2 `FieldDescriptor` — a closed discriminated union

```ts
type FieldDescriptor =
    | { name: string; kind: 'integer'; unit: string; min: number; max: number;
        default: number; takesEffect: TakeEffect }
    | { name: string; kind: 'enum';    unit: null;  values: readonly [LogLevel, LogLevel, LogLevel, LogLevel];
        default: LogLevel; takesEffect: TakeEffect }
    | { name: string; kind: 'string';  unit: null;
        format: string;       // service-authored prose: allowed characters, rendered as text only
        maxLength: number;    // 80 for expectedAgent
        default: string; takesEffect: TakeEffect };
```

- **Derivation**: built from `NUMERIC_BOUNDS` ∪ `LOG_LEVELS` ∪ `EXPECTED_AGENT_RULE` ∪ `DEFAULT_CONFIG` ∪ `TAKE_EFFECT` — never from a parallel table (plan D1). SC-101's test mutates one bound in the declaration and asserts the projection **and** the validator's remediation both moved.
- **Closed vocabularies**: `kind` ∈ {`integer`,`enum`,`string`}; `takesEffect` ∈ {`immediate`,`next-cycle`,`next-dispatch`,`restart`,`none`}. A value outside either is refused or passed through verbatim, never mapped to a guess (FR-021, 005 FR-003).
- **No fabricated members**: a `string` entry carries no `unit` and no `min`/`max`; a renderer must not be able to find a numeric bound for a text field (FR-014, FR-021).
- **Ordering**: `fields` is emitted in declaration order (the same order `collectIssues` uses), so the panel's rows and the service's issue list share one order (AC-107).

---

## 4. Audit trim state (`audit.ndjson`)

### 4.1 What a pass reads, decides, and writes

```text
read  : every parseable entry (existing readAuditEntries)
compute: protected set  →  trimmable remainder  →  removals under BOTH limits
write : ONE atomic writeLines(AUDIT_FILE, [...survivors, trimRow])   // plan D4
```

- **Limits**: `auditRetentionDays` (age) and `auditMaxEntries` (count), whichever trips first (002's data model: days **or** entries).
- **Cap accounting**: the pass counts the `audit.trimmed` row it is about to append **before** deciding how many to remove, so the trail lands at or below `auditMaxEntries` including its own row — a cap of N cannot oscillate around N one row per cycle.
- **Order**: oldest first; survivors keep their original `seq`; **a trim never renumbers**, and `seq` gaps are the trim's visible signature (FR-055, FR-073).
- **Nothing removed ⇒ no write and no row** (FR-053).

### 4.2 The protected set (FR-056) — computed by rule, never by a list

| Rule | Protected rows | Why |
| --- | --- | --- |
| **(a) opener** | for every correlation chain that contains a **run-scoped** row: the **earliest** `seq` in that chain | *what the work was and where it came from* |
| **(b) outcome** | the same chains: the **latest run-scoped** row | *the decision that ended it* — protecting opener **and** outcome together makes "a chain with an outcome but no opener" structurally impossible |
| **(c) entity** | rows whose `entity.kind` is `account` or `binding`, **while that subject still exists** | 002's data model: minimal references kept until the account/binding is deleted |
| **(d) decision** | rows whose `eventType` is `policy.decision` or `config.changed` | policy and configuration decisions are never trimmed |

- **Run-scoped** means `entity.kind === 'run'` **or** a `run.*` / `dispatch.*` / `agent.*` `eventType` — i.e. exactly 003's 16 lifecycle rows plus `dispatch.refused`, read as *categories* so a vocabulary row 003 adds later is protected without a 006 change (plan X4).
- **What is deliberately *not* protected**: the middle observations of a chain — `delivery.detected`, intermediate dispatch rows. Those are exactly what retention removes; the gap is explained by the `audit.trimmed` row's `oldestSeq`/`newestSeq`. FR-056's floor is *minimal references needed to explain a run*, not the whole chain.
- **Where the floor meets the cap**: if the protected set alone exceeds `auditMaxEntries`, the cap applies to the trimmable remainder and the trail may exceed the cap by exactly the protected set; `details.minimalReferencesPreserved` records it so a trail larger than its own cap is an explained fact, not a bug.

### 4.3 The trim row (FR-073)

```jsonc
{ "seq": <next in the trail's own sequence>,
  "timestamp": "…", "correlationId": "<its OWN id, never a run's>",
  "eventType": "audit.trimmed",            // 002's reserved name — never a new spelling
  "actorSource": "service",
  "entity": { "kind": "service", "id": "<the configuration>" },
  "decision": "trimmed",
  "reason": "<which limit was reached, secret-free>",
  "details": { "entriesRemoved": 17,
               "oldestSeq": 41, "newestSeq": 212,
               "limitReached": "day-window" | "entry-cap" | "excerpt-days",
               "minimalReferencesPreserved": 6 } }
```

Built through the same composer `appendAudit` uses, so the redaction pass and `seq` assignment have exactly one implementation (plan N2/D4).

---

## 5. Excerpt trim state (`events.json`)

### 5.1 The marker

| Field | Type | Written when | Notes |
| --- | --- | --- | --- |
| `issueBodyExcerpt` | string | at enqueue (≤ 600 chars, `''` when the issue had no body) | **cleared to `''`** by the excerpt trim on eligible rows |
| **`excerptTrimmedAt`** *(NEW)* | RFC 3339 string, **absentable** | by the excerpt trim, alongside the clearing | survives a store round trip; distinguishes *trimmed* from *never had a body* |

- The marker is **absentable** and additive: rows written before 006 parse identically, and `GET /v1/events` never returned the excerpt anyway (FR-057), so no contract fixture changes shape.
- A cleared row keeps **everything else** — id, state, claim/dispatch stamps, repository and issue identity, correlation identifier — so dedupe, history, and correlation are untouched.

### 5.2 Eligibility (exactly FR-057's two conditions)

```text
eligible ⇔ age(row) > excerptRetentionDays
         ∧ isDispatchedTerminal(row)          // ONE shared predicate, exported from events.ts
never    ⇔ state is 'pending' or 'in-flight'  // at any age — context for a dispatch not yet sent
```

- `isDispatchedTerminal` is the **same predicate `serializedQueue`'s tail cap uses**, extracted so 006's pass and the existing retention rule can never disagree — and so 003's move of terminality onto `runs.json` lands in one place (plan D6, X5).
- **Coexistence with 003's frozen rows, stated**: 003 freezes `state`/`claimedAt`/`dispatchedAt`/`dispatchResult` as migration input on *legacy* rows; `issueBodyExcerpt` is a detection field 003's migration never reads, and clearing its text leaves every frozen field byte-identical. A legacy row adopted by 003 is unaffected by a later trim, and a trimmed row still projects through 003's migration table.

---

## 6. Store rewrite atomicity

| File | Writer | Mechanism | Crash result |
| --- | --- | --- | --- |
| `config.json` | `PUT /v1/config` | existing `writeJsonAtomic` (temp `0600` → `fsync` → `rename`) | old document or new document, never torn |
| `audit.ndjson` | **new** `ServiceStore.writeLines` | the **same** three-syscall pattern applied to a line file (research Q2) | old trail, or survivors **plus** their `audit.trimmed` row — never a removal without its record, never a `seq` that can be re-seeded below an used number |
| `events.json` | excerpt trim | existing `writeJsonAtomic` inside the queue's own chain | old queue or new queue with markers applied |
| `scan-state.json` | unchanged | unchanged | unchanged |

One IO path per file kind: no trim module hand-rolls `fs` calls beside the store (invariant: the store owns `0700`/`0600` and quarantine behaviour).

---

## 7. Validation scenarios (drive the suites)

1. **Upgrade seed**: a ten-field `config.json` reads with all ten values intact, `source: 'stored'`, `defaultsApplied: ['expectedAgent']`; a `PUT` of that same ten-field body is **refused** with `field: expectedAgent`; after one save the file holds the complete document (§2.1).
2. **Unknown stored key**: a hand-added `"surprise": 1` quarantines the file, `source: 'quarantined'` answers, defaults serve, and the tab says *unusable and set aside*.
3. **Projection ≡ declaration**: mutate one bound in `NUMERIC_BOUNDS` ⇒ the projection's `min`/`max` **and** the validator's remediation string both move (SC-101); revert ⇒ both return.
4. **Class exhaustiveness**: add a `ServiceConfig` member without a `TAKE_EFFECT` entry ⇒ `tsc --noEmit` fails (plan D2).
5. **Histogram of record**: over 006's eleven names the projection counts **nine `next-cycle`, one `immediate`, one `next-dispatch`**, zero `restart`, zero `none` (AC-104, SC-106); in the combined tree every *extra* entry still carries a declared class (SC-107).
6. **String-field refusals**: empty-after-trim, 81 chars, an internal space, and a PAT-shaped value each answer `422` with `field: expectedAgent`, no submitted text anywhere in the body or in the audit row (AC-154).
7. **Trim preservation**: a seeded trail mixing all seventeen 003 event types with trimmable middle rows removes **only** unprotected rows, oldest first, keeps every survivor's `seq`, lands at or below `auditMaxEntries` including the trim row, and leaves every run chain with opener **and** outcome under the same correlation id (AC-146, SC-114).
8. **Cap under an oversized protected set**: protected rows alone above `auditMaxEntries` ⇒ nothing protected is removed, the trail exceeds the cap, `minimalReferencesPreserved` records the excess.
9. **Trim crash**: fail the write ⇒ the file is byte-identical to before and no `audit.trimmed` row exists.
10. **Excerpt trim**: an old `dispatched` row's text is cleared and marked; a `pending` row of the same age is untouched; id/state/stamps/correlation survive; **exactly one** `audit.trimmed` row with `limitReached: 'excerpt-days'` — and a pass that clears nothing appends none (AC-147, SC-115).
11. **No-op write**: an identical document answers `200`, reports *already saved*, and appends **no** audit row (AC-127).
12. **Refused write**: a document violating every rule at once ⇒ exactly one `config.changed` row with `decision: 'refused'`, `issueCount`, documented field names, `<withheld>` for the foreign key, and **no** submitted value, length, or hash; the stored document is byte-identical (AC-113, AC-136).
13. **Correlation independence**: a `config.changed` row and a `dispatch.*` row in the same trail carry different correlation ids, neither adopts the other's, and a run-filtered read excludes the configuration row (AC-137, SC-110).
14. **`immediate`**: with a captured sink, a `PUT {logLevel:'debug'}` is followed by a debug line at the new threshold with no restart; a refused `PUT` changes no threshold (AC-103, SC-105).
15. **Backoff bounds**: with an injected clock and jitter source, every recorded delay lies in `[retryMaxMs / 2, retryMaxMs]`, a supplied `retry-after` longer than `retryMaxMs` is honoured, no attempt follows `auth-failed`, and `lastScanAt` is unchanged after exhaustion (AC-148, SC-116).
16. **Window and page**: the next cycle's `since` equals `lastScanAt − overlapMs` and the widened replay enqueues nothing twice; the next list request carries `per_page=<configured>` and never a value above 30, with `MAX_LIST_PAGES` still 2 (AC-149, AC-150, SC-117).
17. **Configuration authority**: no `.env`/`.env.example`, no `!.env.example` negation, no `MECHA_TURK_` outside `specs/**`, no dotenv loader, exactly one poll-interval input (AC-151, AC-153).
