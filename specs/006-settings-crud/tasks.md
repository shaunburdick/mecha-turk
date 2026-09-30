# Tasks: Settings — Full Service Configuration CRUD (006)

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md), [contracts/](./contracts/) — all Phase-4 outputs; [spec.md](./spec.md) v1.3.0 is the source of truth (FR/AC numbers below are quoted as written, and every cross-spec reference is prefixed: `002 FR-019`, `003 FR-052`, `005 FR-071`).

**Bar**: every declared take-effect class is *delivered*, not labelled. Tests are offline and deterministic per `AGENTS.md`: fake host (`tests/support/panel.ts`), DOM helpers (`tests/support/{dom,ui-stubs}.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture GitHub (`tests/support/github.ts`), **injected clock for backoff/cycle/trim timing (no sleeps)**, **seeded `audit.ndjson` / `events.json` fixtures for the trim passes**, **captured log sink for `logLevel`** — no live OpenChamber, no PAT, no network. `[P]` = parallel-safe (different files, no dependency). **`npm run verify` runs at every wave boundary, and any wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the rebuilt bundles committed in the same commit (invariant 1).**

**Prerequisite**: 003, 004, and 005 have completed Phase 6 (roadmap order 003 → 004 → 005 → 006). If any has not, the tasks that consume its surface **block** — T-018 and everything after it (005's `settings-tab.ts`/`settings-rows.ts` shell), T-012 and T-013 (003's vocabulary, correlation chains, and frozen delivery rows), T-026 (005's emptied manifest card under 002 FR-041) — rather than re-implementing it.

## What's already built — do NOT re-touch

- **Service transport/security**: `service/{server,http,auth,pipeline,consent,throttle,body,log}.ts` — loopback bind, bearer auth with `timingSafeEqual`, body/response caps, route table, consent gate, throttles. 006 **adds no route** and renames no path.
- **The validator**: `service/config.ts`'s `NUMERIC_BOUNDS`, `LOG_LEVELS`, `DEFAULT_CONFIG`, additive `validateConfig`, `retryOrderIssue`, `unknownFieldIssue` (`<withheld>`), `parseStoredConfig`'s quarantine contract, `validationResponse`. 006 **extends the declaration**; it does not re-cut a rule.
- **Bootstrap environment**: `service/env.ts` — host-provided pair, fail closed, value never echoed. 006 changes nothing here (FR-090) and only *asserts* it (T-026).
- **Poll scheduling**: `service/poll/timer.ts` already re-reads the interval each cycle and an armed timer keeps its delay — **the timer is not touched** (FR-032).
- **Discovery/dedupe**: `service/poll/{triggers,poller-entries,scan}.ts`, `buildEventId`, `enqueueEvents`'s dedupe, `MAX_DISPATCHED_EVENTS = 500`, `MAX_LIST_PAGES = 2`.
- **Store mechanics**: `service/store/*` — `0700`/`0600`, quarantine-and-repair reads, atomic `writeJsonAtomic`, `appendJsonLine`. 006 adds `writeLines` **beside** them, never inside a trim module.
- **Audit writer**: `service/audit.ts` — `seq` seeded once per handle, per-store write chain, `redactDeep` over every row, redaction refusal blocks the write. 006 **calls** it and adds two exports beside it (T-011); it never rewrites the writer.
- **Panel substrate**: `src/{redaction,json,ids,storage-write,service-calls,agent-verify,relay}.ts`, `tests/support/*`, `tests/{bundle,manifest,redaction}.test.ts`, the committed-bundle pipeline.
- **005's shell**: `src/tabs.ts`, `src/settings-tab.ts` + `src/settings-rows.ts` (read-only rows + the panel-side declaration pinned by `tests/settings-rows.test.ts`), the arm-then-act idiom, `GET /v1/status`, the emptied manifest card. **006 edits inside that shell; it adds no tab, sub-tab, or drawer** (FR-010).
- **003's dispatch machinery**: run model, leases, tokens, the 17-row vocabulary, correlation discipline, frozen legacy delivery rows, `GET /v1/audit`. **006 renders none of it and re-implements none of it**; it keeps run chains intact when trimming (FR-056).
- **Invariants**: delivery id format, evidence schema `extension-spike-1`, manifest ids/capabilities/panel id `mecha-turk`, SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` `0.0.1` (**no bump in 006**), `SERVICE_SCHEMA_VERSION = 1`, the existing suite staying green throughout.

## Out-of-scope guard (check before any task feels like "just one more")

No GitHub write of any kind (002 FR-031, 003 FR-002, FR-002). No new tab/sub-tab/drawer/second configuration surface (FR-010). No change to the six-tab shell, mount-once rule, or teardown discipline (005 FR-013/FR-017, FR-080). No run state, lease, token, transition, or dispatch-lifecycle audit row (003's; FR-074). No prompt composition, validation, or storage (004's; FR-082). No `PATCH`, no per-field endpoint, no partial document, **no revision precondition** (FR-040, FR-045 — gate answer 2). No `MAX_LIST_PAGES`, `MAX_DISPATCHED_EVENTS`, or `poll.duplicate` change. No correlation-indexed read API, no restore/export of trimmed data. **No `requeueBudget`** (FR-083 — gate answer 4). No status-projection change (005 FR-031 owns it). No capability, permission, host API, SDK re-pin, storage key, `SERVICE_VERSION`, or `version` bump (FR-004, FR-005, FR-087). No `host.storage` write of configuration state (FR-005).

---

## Wave 1 — Declaration & projection (service foundation) — blocks every later wave

**Goal**: the configuration document knows `expectedAgent`, a pre-existing document keeps reading, and the wire can carry the declaration. Independent test (spec US1's read half): `GET /v1/config` answers the widened envelope against a temp-dir store.

- [x] **T-001** [P] [US1] Add the eleventh field in `service/config.ts`: `ServiceConfig.expectedAgent: string`, the `EXPECTED_AGENT_RULE` declaration (non-empty after trim, ≤ 80 chars, `letters/digits/._-@:/` only, credential-shaped values refused via `findSecretLeak`), `DEFAULT_CONFIG.expectedAgent = 'project-manager'`, `buildConfig` read, `isKnownField` widening, and a value-free `expectedIssue` in `collectIssues`'s existing order. Store the **trimmed** value. *Tests* (`tests/service-config.test.ts`): each of the four refusals answers with `field: expectedAgent` and a remediation that never contains the submission (AC-154); a valid value round-trips trimmed; the default answers a fresh store; **`PUT` of a document missing the key is refused** while the *stored* read path is not (see T-002) (FR-100(b)). **(FR-100(a)(b)(c)(d), FR-084, AC-154)**
- [x] **T-002** [US1] Implement the upgrade path in `service/config.ts`: `parseStoredConfig` fills a **missing documented key** from `DEFAULT_CONFIG` and reports which ones, while **unknown keys and malformed values still quarantine**; `PUT` keeps the strict whole-file rule. Thread the filled-key list out to `configFromStore` as `defaultsApplied`. *Tests*: the ten-field seed reads with all ten values intact and `defaultsApplied: ['expectedAgent']`; the same body PUTs back as `422`; an unknown stored key quarantines; a malformed stored value quarantines; `config.json` is **byte-identical after every read** (AC-113, NFR-103, NFR-104). **(FR-003, FR-028, FR-100(b), NFR-103)** — *in this combined tree the pre-006 document carries **twelve** fields (003's `leaseMs`/`resultDeadlineMs` have landed), so the backfill is generic over every documented key: the twelve-field seed reads with `defaultsApplied: ['expectedAgent']` exactly as written, and the ten-field `PRE_RUN_LAYER` seed reads with `['leaseMs', 'resultDeadlineMs', 'expectedAgent']` — the same rule, one tree wider.*
- [x] **T-003** [P] [US1] Create the projection in `service/config.ts`: `TakeEffect` closed type, the exhaustive `TAKE_EFFECT: Record<ServiceConfigField, TakeEffect>` table (nine `next-cycle`, `logLevel: 'immediate'`, `expectedAgent: 'next-dispatch'`; `leaseMs`/`resultDeadlineMs: 'next-cycle'` **only if 003's fields are already in the tree**), and `configSchema()` building the closed `FieldDescriptor` union **from** `NUMERIC_BOUNDS`/`LOG_LEVELS`/`EXPECTED_AGENT_RULE`/`DEFAULT_CONFIG`/`TAKE_EFFECT`. A `string` descriptor carries `format` + `maxLength`, **no `unit`, no `min`/`max`**. *Tests*: SC-101 — mutate one bound, assert the descriptor **and** the validator's remediation both move, revert and assert both return; descriptor order equals `collectIssues` order; class histogram over 006's eleven names is 9/1/1 with zero `restart` and zero `none`; adding a `ServiceConfig` member without a class fails `tsc --noEmit` (SC-106, D2). **(FR-020, FR-021, FR-030, FR-037, SC-101, SC-106)** — *landed in `service/config-schema.ts`, a sibling module that imports `config.ts`'s own `NUMERIC_BOUNDS`/`LOG_LEVEL_VALUES`/`EXPECTED_AGENT_RULE`/`DEFAULT_CONFIG`: `service/config.ts` crossed the 500-line lint gate with the field rule and the projection together, and suppressing that gate is not an option. One declaration is preserved — the projection reads the validator's objects rather than restating them (SC-101 still mutates a bound and watches both move), and `config.ts` does not import the projection, so the dependency stays one-way.*
- [x] **T-004** [US1] Widen `handleGetConfig` in `service/routes/config.ts` to answer `{ config, fields, source, defaultsApplied }`, deriving `source` from the read result (`stored` / `default` / `quarantined`) without changing the quarantine log line. `PUT`'s answer and semantics are untouched in this task. *Tests* (`tests/service-config.test.ts`): `source` fidelity for all three cases; `defaultsApplied: []` whenever `source ≠ 'stored'`; `503 storage-unavailable` unchanged; an older reader that ignores the new members still reads `config` (co-ship assumption). **(FR-020, FR-022, NFR-106, AC-101)**

**Wave 1 boundary**: `npm run verify` green; rebuilt `service/main.js` + `panel/main.js` committed with the wave.

---

## Wave 2 — `logLevel` is `immediate` (User Story 1)

**Goal**: the stored level is honoured at start-up and changes with no restart. Independent test (spec US1 scenario 3): capture the sink, save `debug`, assert the next line is debug.

- [x] **T-005** [P] [US1] In `service/log.ts`, stop capturing the threshold as a construction constant: `createLogger` returns a logger carrying `setLevel(level: LogLevel)`, the emit path reads the **current** threshold per entry, and the exported types gain a `LoggerControl` so `StartServiceOptions.log` and `RouteContext.log` can require it. Every logger in the tree already comes from `createLogger`, so no fake changes. *Tests*: threshold lowering admits a previously-dropped level; raising drops it; the sink and the redaction pass are unchanged; a `debug`-threshold logger still redacts. **(FR-033, FR-037, NFR-109)**
- [x] **T-006** [US1] Adopt and apply the level: in `service/server.ts`, read the stored configuration **immediately after `openStoreSafe`** and `setLevel` before the listener accepts (store unavailable ⇒ keep the initial level); in `service/routes/config.ts`, call `setLevel` with the validated `logLevel` **on an accepted write only**, before the answer is sent. *Tests* (`tests/service-config.test.ts` + captured sink): a store seeded with `logLevel: 'debug'` emits a debug line during start-up with no restart (AC-103); an accepted save flips the very next line with no second write (SC-105); a **refused** write changes no threshold; `logLevel: 'error'` silences the cycle's `warn`/`info` lines as the edge case says. **(FR-033, FR-037, AC-103, SC-105)**

**Wave 2 boundary**: `npm run verify` + bundles.

---

## Wave 3 — Poll consumers: window, page size, backoff (User Story 1)

**Goal**: one config read per cycle feeds three consumers. Independent test (spec `## Per-Field Contract` rows): a driven cycle observes `since = lastScanAt − overlapMs`, `per_page = <configured>`, and a delay inside its bounds.

- [x] **T-007** [US1] Read the configuration **once** at the start of `runScanCycle` in `service/poll/loop.ts` (`configFromStore` + `readJson`, falling back to `DEFAULT_CONFIG` exactly as `currentIntervalMs` does) and carry it on `ScanContext`. *Tests* (`tests/service-cycle-config.test.ts`): `readJson(CONFIG_FILE, …)` is called **once per cycle** even with several bindings; an unreadable document degrades to defaults with a warn line; the cycle never throws on a bad read. **(FR-055, FR-057–FR-059's "one read, once per cycle", FR-003)**
- [x] **T-008** [US1] Widen the scan window: `windowFor(binding, scanned, overlapMs)` returns `ISO(Date(lastScanAt) − overlapMs)` and still `null` when there is no stamp (a binding with no stamp replays with no window, exactly as today); pass `config.overlapMs` from the cycle context. *Tests*: AC-149 — seeded `lastScanAt` + saved `overlapMs` ⇒ the next `since` equals `lastScanAt − overlapMs`; the widened replay enqueues **no** second event for an item the previous cycle already recorded (deterministic id); the queue-recovery reset still opens an unbounded window. **(FR-034, FR-059(a), AC-149, SC-117, 002 FR-019)** — *landed as `windowFor({ binding, scanned, overlapMs })` in `service/poll/window.ts`, re-exported from `loop.ts`: the `llm-core/max-params` gate caps a function at two positional parameters, so the three-argument shape became an options object instead of a suppression, and the split keeps `loop.ts` inside the 500-line gate as well.*
- [x] **T-009** [P] [US1] Replace `const PAGE_SIZE = 30` in `service/poll/poller-github.ts` with the configured `perPage` carried on each list query: set `per_page`, and use the same value in the "page was full" test. **`MAX_LIST_PAGES = 2` stays 2.** *Tests*: AC-150 — `perPage: 12` ⇒ `per_page=12` on the captured request; no request ever carries a value above 30 (the field's own `max`); a full first page still triggers exactly one more page and never a third. **(FR-034, FR-059(b), AC-150, SC-117, 002 FR-020)** — *the size and ladder travel on each list query as `pace`, built once per cycle from the stored document, because the poller itself is constructed once at start-up while `perPage` is `next-cycle`.*
- [x] **T-010** [US1] Create `service/poll/backoff.ts` (pure arithmetic + delay driver with **injected `sleep` and `random`**) and wire it into `listPages`: up to `retryMaxAttempts` attempts **including the first**, `delay(n) = min(retryMaxMs, retryBaseMs × 2^(n−2)) × jitter ∈ [0.5, 1.0]`, `retry-after`/reset guidance **wins even above `retryMaxMs`** and is logged as a structured line naming length and source; **`auth-failed` never retries**; exhaustion returns the last failure so the existing `skipOf` produces one honest skip reason and the cycle walks on. Change the checkpoint write in `service/poll/loop.ts` so a skipped scan **retains** the prior `lastScanAt` (never advances, never clears) while the queue-recovery reset still clears it. *Tests* (`tests/service-backoff.test.ts`, injected clock — **no real sleeps**): AC-148 — every recorded delay lies in `[retryMaxMs / 2, retryMaxMs]`; a supplied `retry-after` longer than `retryMaxMs` is honoured; no attempt follows `auth-failed`; `lastScanAt` unchanged after exhaustion; the next cycle is scheduled from the cycle's end (no catch-up); log lines carry no secret. **(FR-035, FR-058, AC-148, SC-116, 002 FR-022, 002 FR-018/FR-020)** — *reading recorded for AC-148's interval: the formula `min(cap, base × 2^(n−2)) × jitter` puts an **uncapped** ladder below `retryMaxMs / 2`, so `[retryMaxMs / 2, retryMaxMs]` is asserted over a capped ladder (`retryBaseMs === retryMaxMs`, the regime the AC's own interval describes), while every computed delay — capped or not — is separately asserted never to exceed the ceiling. The no-catch-up claim is observed on vitest's fake clock: the next cycle arms from the cycle's **end**, so a wait inside it pushes the schedule out instead of being made up. No test in the suite sleeps.*

**Wave 3 boundary**: `npm run verify` + bundles.

---

## Wave 4 — The two trim passes (User Story 1 + 5)

**Goal**: the three retention knobs become true. Independent test (spec US3/US5): seed a mixed trail on temp dirs, drive one pass with a clock, assert survivors and the trim row.

- [x] **T-011** [P] [US1] Add the two mechanical primitives the passes need: `ServiceStore.writeLines(relativePath, entries)` in `service/store/{index,ndjson}.ts` (temp `0600` → `fsync` → `rename`, the exact pattern `writeJsonAtomic` uses), and two `service/audit.ts` exports beside the writer — a chain join (`serializeAudit`) and an entry composer that applies `redactInput` and assigns `seq`/`timestamp` without writing. **The writer itself is otherwise untouched.** *Tests* (`tests/service-store.test.ts`, `tests/service-audit.test.ts`): `writeLines` produces a line file `readLines` parses, mode `0600`, atomic (a failed rename leaves the old bytes); the composer's output equals `appendAudit`'s for the same input; the chain join serialises two tasks. **(FR-055, FR-073, NFR-103, AGENTS invariant 8)**
- [x] **T-012** [US5] Create `service/audit-trim.ts`: read the trail, compute the **protected set by rule** — (a) the earliest row of any correlation chain containing a run-scoped row, (b) the latest run-scoped row of that same chain, (c) `account`/`binding` entity rows while the subject still exists, (d) `policy.decision` and `config.changed` — then remove oldest-first until both limits are satisfied, counting the `audit.trimmed` row it is about to write, and perform **one** `writeLines(AUDIT_FILE, [...survivors, trimRow])` through T-011's primitives. A pass that removes nothing writes nothing. *Tests* (`tests/service-trim.test.ts`, seeded `audit.ndjson` fixtures — **no network, temp dirs**): AC-146/SC-114 — a trail seeded with **all seventeen** 003 event types plus trimmable middle rows removes only unprotected rows, oldest first, keeps every survivor's `seq`, lands at or below `auditMaxEntries` **including** its own trim row, and leaves every run chain with opener **and** outcome sharing one correlation id; protected set alone above the cap ⇒ nothing protected is removed and `minimalReferencesPreserved` records the excess; a failed write leaves the file byte-identical and appends no row; `seq` never renumbers across two consecutive passes. **(FR-055, FR-056, FR-053, FR-073, AC-138, AC-146, SC-114, 002 FR-035, 003 FR-052)** — *reading recorded at implementation: the pass counts its own `audit.trimmed` row only when the trail is **already over** `auditMaxEntries` — a pass inside the limit writes no row and must not reserve a slot for one, which is what keeps a trail sitting exactly at the cap from deleting one row per cycle; the entity id this row and `config.changed` share is `CONFIGURATION_ENTITY_ID`, exported beside `AUDIT_FILE`; and a subject list that cannot be read protects every row naming one, so a destructive decision fails closed.*
- [x] **T-013** [P] [US1] Create the excerpt trim: add the absentable `excerptTrimmedAt` marker to `service/poll/events-parse.ts`, extract the **shared terminality predicate** beside `serializedQueue` in `service/poll/events.ts` (both the tail cap and the trim import it), export the queue's chain join, and create `service/poll/excerpt-trim.ts` — clear `issueBodyExcerpt` and set the marker only on rows older than `excerptRetentionDays` **and** terminal; never on `pending`/`in-flight` at any age; keep id, state, stamps, and correlation untouched; one `audit.trimmed` row with `limitReached: 'excerpt-days'` only when something was cleared. *Tests* (`tests/service-excerpt-trim.test.ts`, seeded `events.json`): AC-147/SC-115 — an old `dispatched` row is cleared and marked, a `pending` row of the same age is untouched, the marker survives a store round trip and is distinguishable from an empty body, exactly one trim row — and a pass that clears nothing appends none. **(FR-057, AC-147, SC-115)** — *reading recorded at implementation: the excerpt row carries `entriesRemoved`, `limitReached`, and `minimalReferencesPreserved` but no `oldestSeq`/`newestSeq`, because this pass removes no audit **entry** — that range describes trail removals (FR-073) and inventing one for a queue that has no `seq` would be worse than omitting it. Eligibility also skips a row that already carries the marker (idempotence) and a row whose excerpt is already `''` (nothing to clear), which is what keeps a never-bodied row unmarked.*
- [x] **T-014** [US1] Wire both passes at **store open** (`service/server.ts`, after `openStoreSafe`, before the listener accepts) and at the **cycle boundary** (inside `runScanCycle`, immediately after T-007's single config read), reading the stored configuration each time. A configuration write must still run **no** trim (FR-047). *Tests*: a store opened with an over-limit trail trims once at open; a mid-cycle save is in force at the **next** boundary, not at the write; a `PUT` that lowers a retention limit writes no trim row itself; an unreadable config at the boundary degrades to defaults rather than skipping the pass silently. **(FR-055, FR-057, FR-047, FR-036, AC-128)** — *landed in `service/retention.ts`, a sibling module exporting `runRetentionAtOpen` (one call in `server.ts` after `adoptStoredLogLevel`, still before `listen`) and `runRetentionPasses` (one call in `loop.ts` immediately after T-007's single config read, so the boundary adds no second read); each pass is guarded independently, so one failure still runs the other and a boundary never throws. The wiring therefore stays out of both near-gate modules.*

**Wave 4 boundary**: `npm run verify` + bundles.

---

## Wave 5 — Configuration audit rows (User Story 5)

**Goal**: a settings change is explainable months later. Independent test (spec US5): drive accepted, no-op, and refused writes against a temp-dir store and assert the row shapes.

- [x] **T-015** [US5] Complete `service/routes/config.ts`: detect a **no-op** (validated candidate equals the stored document, field by field) and answer without an audit row; otherwise append exactly one `config.changed` row — `applied` with `details.changes` (one `{field, from, to}` per changed field, **ordered by field name**, documented fields only) plus `details.takesEffect` from the projection; on a refusal append exactly one `refused` row carrying `issueCount`, the **documented** field names, `<withheld>` for a foreign key, and **no submitted value of any kind**; write the row **after** the durable config write in a `try/catch` that answers `auditWritten: false` and logs a structured warn on failure. `actorSource: 'operator'`, `entity: {kind:'service', id:<the configuration>}`, **its own correlation id, no run reference**. *Tests* (`tests/service-config-audit.test.ts`): SC-109/AC-135 — one row per changed write with one triple per changed field; **AC-127** — an identical document ⇒ *already saved* and **zero** rows; **AC-136** — a document violating every rule at once ⇒ exactly one `refused` row whose `details` contain no submitted value, no length, no hash, and no foreign key name; **AC-113** — stored bytes identical after the refusal; **SC-110/AC-137** — a `config.changed` row and a `dispatch.*` row carry different correlation ids and a run-filtered read excludes the configuration row; **AC-139** — a failing append still reports success plus `auditWritten: false`. **(FR-048, FR-070, FR-071, FR-072, FR-074, AC-113, AC-127, AC-135, AC-136, AC-137, AC-139, SC-109, SC-110, 003 FR-052/FR-061)** — *landed in `service/config-audit.ts` (the row writers plus `configChanges`, which doubles as the no-op detector) so `routes/config.ts` stays a coordinator; `details.fields` **collapses every non-documented name to `<withheld>`** — a foreign key, the `body` sentinel, and the validator's own marker alike — because the durable trail is strictly narrower than the refusal body the panel renders, and `details` on a refusal carries exactly `issueCount` and `fields`, so no member exists that could hold a value, a length, or a hash. The entity id is `CONFIGURATION_ENTITY_ID`, shared with the trim row.*

**Wave 5 boundary**: `npm run verify` + bundles. **The service half is now complete.**

---

## Wave 6 — The projection reaches the panel (User Story 1 + 2, read side)

**Goal**: 005's stand-in is replaced by the wire; the tab is still read-only but now labelled from the service. Independent test: render the tab against the real projection with zero configuration literals in `src/`.

- [x] **T-016** [P] [US2] Extend the shared wrapper set in `src/service-calls.ts` — **extended, not forked**: the classifier takes the resource it describes, `servicePutConfig` answers `{ok:false, problem:'service refused the configuration', code, issues}` with `error.issues[].{field, remediation}` extracted in the service's order, and `service refused the bindings list` is never produced on this path. *Tests* (`tests/service-calls.test.ts` or the nearest existing wrapper suite): the configuration problem string names the configuration; the issue list survives byte-identical; `503`/`401`/transport answers stay distinct from a validation refusal; a bindings refusal still says bindings (nothing regresses). **(FR-043, AC-112, 005 FR-088)** — *landed as `servicePutConfig` in `service-calls.ts` over a classifier extracted to `src/service-envelope.ts` (the file crossed the 500-line gate with the classifier and the wrappers together): `httpProblem` now takes the resource it describes, the four shared wrappers pass one `LEGACY_RESOURCE` constant so a bindings refusal keeps its exact sentence, and `envelopeIssuesOf` keeps a paired `field`/`remediation` entry in the service's order while dropping an unpaired one rather than half-reading it.*
- [x] **T-017** [P] [US2] Create `src/settings-schema.ts`: a **fail-closed** reader for `{ config, fields, source, defaultsApplied }` producing closed types — an unknown `kind`, an unknown `takesEffect`, a descriptor missing its kind's required members, or a `config` member the reader cannot type all refuse rather than partially apply; a `config` member with **no** descriptor is surfaced as *field this version does not show*. *Tests* (`tests/settings-schema.test.ts`): every malformed envelope shape refuses; unknown vocabulary values pass through verbatim rather than being guessed; AC-115 — a member with no descriptor is flagged and blocks the save path; AC-116 — an unparseable document keeps the fields that parsed and marks the rest *unreadable*, **never** filling one from `default`. **(FR-021, FR-027, FR-028, FR-003, AC-115, AC-116)** — *reading recorded at implementation: "refuses" and "passes through verbatim" are split by what the reader is holding. The **descriptor** and the **source** are refused outright when they fall outside their closed sets (a row the panel cannot type must not be half-rendered, and the quarantine wording is a promise), while the vocabularies the reader has no reason to interpret — an enum's accepted values and the `defaultsApplied` list — pass through untouched rather than being mapped to a guess. A `config` member is refused **as a value** (it lands in `unreadable`, its neighbours keep rendering) and the fit is judged against the member's descriptor, so `intervalMs: "soon"` is unreadable where a bare string under no descriptor is not.*
- [x] **T-018** [US1] Retire 005's stand-in and render from the projection: **delete** the panel-side bounds declaration in `src/settings-rows.ts`, make `src/settings-tab.ts` iterate `fields` (row order = descriptor order), keep every row's five attributes (name, unit-or-*none*, bounds-or-format, value, class), and **reverse** `tests/settings-rows.test.ts`'s cross-check into AC-106's **zero-literals scan** over `src/` (the single documented exception from plan X7 is asserted to be exactly one entry). Also assert the row count is derived: `rows.length === fields.length`, eleven against the 006-only fixture, thirteen against the combined fixture. *Tests*: AC-101 (eleven editable rows, no twelfth offered), AC-106 (no configuration literal), AC-104 (per-row class words; no row claims *no effect in this build*), SC-102 (render test over the **real** projection that fails at ten rows or one missing attribute alike), and the take-effect line is part of each field's accessible name (FR-039). **(FR-014, FR-022, FR-023, FR-029, FR-030, FR-039, AC-101, AC-104, AC-106, SC-102, 005 research Q1/005 plan X8 stand-in retired)** — *reading recorded at implementation: `src/settings-rows.ts` **survives as the row builder** (plan C14) — what is deleted is the declaration inside it and the cross-check that pinned it; the rows are now derived from `fields`, so the count is `fields.length + undisplayed.length` and neither 11 nor 13 is written anywhere. The reversed scan reads `src/` for the five classes AC-106 names — unit phrases as string literals, declaration-shaped numerics (`min:`/`max:`/`defaultValue:` followed by a number), the level set's sentinel, the default strings, and a class token appearing within six lines of a field name (a declaration is a block, not a line) — with the allow-list carrying exactly one entry, `DEFAULT_EXPECTED_AGENT`, pinned to `DEFAULT_CONFIG.expectedAgent`; it also asserts the forbidden "changes nothing in this build" phrasing is gone and that every rule still flags a pasted stand-in. Take-effect **words** are panel copy keyed by the service's token: the map names no field, so it claims nothing about any row. AC-101's *editable* half and AC-115's save-block are not here — they arrive with the edit surface (T-019, T-020).*

**Wave 6 boundary**: `npm run verify` + bundles.

---

## Wave 7 — The edit surface (User Stories 1 and 2)

**Goal**: one save, whole document, honest refusal. Independent test (spec US1/US2): mount against the fake host + temp-dir service and drive saves end to end.

- [x] **T-019** [US1] Create `src/settings-edit.ts` — the pure state machine: the **draft** built as *last-read config ∪ projection defaults for keys the document lacks ∪ edits*; the dirty set; save states `idle | editing | saving | saved | refused | failed`; the pending set (configured ≠ effective, carrying the governing boundary) that clears only when a read reports the new value effective; **no baseline ⇒ no save and a named reason with zero requests** (AC-124); discard restores last-read values and says what reverted; the busy gate refuses a second activation rather than queueing. *Tests* (`tests/settings-edit.test.ts`, fake host): AC-122 discard; AC-123 unsaved edits survive a tab switch; AC-124 never-read ⇒ no request issued; AC-126 one write for two activations and **no field flips before the answer**; AC-105 pending marker names the boundary and is not cleared optimistically; NFR-104 — opening/switching/reading issues **zero** writes. **(FR-012, FR-013, FR-015, FR-041, FR-042, FR-046, FR-049, FR-038, AC-122, AC-123, AC-124, AC-126, NFR-104)** — *reading recorded at implementation: FR-042's three refusals each get their own named reason (`NO_BASELINE_REASON`, `UNDISPLAYED_REASON`, `READ_FAILED_REASON`), so a failed re-read blocks a save rather than offering one against a stale document; `recordRefused` **restores the baseline draft**, because AC-109 asks for the last reported configuration in every field rather than for what was typed; and an input's text becomes an integer only when it parses as one, so an out-of-range or out-of-shape value is *sent* for the service to refuse (FR-023, AC-110). The shell-level halves — AC-123, AC-124, AC-126, NFR-104 — are asserted against the mounted body in `tests/settings-tab.test.ts` and `tests/settings-rows.test.ts`.*
- [x] **T-020** [US1/US2] Give `src/settings-tab.ts` the controls: an input per row shaped by (but not gated by) its descriptor, one **save** bar beneath the rows, discard and restore-defaults (non-primary), the error region, and the read states 005 specified. On success render **the configuration the service returned**; on refusal render **every issue in the service's order with the service's wording**, restore every field to the last-reported configuration, and show no submitted value anywhere; distinguish *the service refused these values* from *the service could not be reached or could not write*. *Tests* (`tests/settings-tab.test.ts` + the DOM helpers): AC-107 three issues render in order, unrewritten; AC-108 the rendered surface, `host.storage`, and the captured log contain **no** submitted value; AC-109 no optimistic value after a refusal; AC-110 an out-of-bounds value is **sent** and refused by the service; AC-111 the cross-field issue renders named against `retryMaxMs`; AC-113/AC-112 panel half; AC-125 the returned document renders, not the submitted one; AC-102 the row reads *in effect from the next poll*. **(FR-010, FR-011, FR-014, FR-024, FR-025, FR-040, FR-044, FR-045, AC-102, AC-107, AC-108, AC-109, AC-110, AC-111, AC-112, AC-125)** — *reading recorded at implementation: each descriptor mounts one control whose **label** carries name, unit-or-*none*, and the class words (FR-018, FR-039) and whose **helper** carries bounds/format and the default (FR-023 — presentation only); the save bar is **hidden**, not disabled-and-visible, whenever `blocked` names a reason (FR-011's "no editable-looking controls that cannot save"); a refusal is distinguished from a failure by the envelope's `code === 'validation'` alone, so a `503` renders as *the write could not be completed* rather than as a refusal (FR-061, FR-063); and **Restore defaults stages the declared defaults into the draft** — a draft change, never a write — because FR-016's two-step confirmation is T-022's task and staging is the honest extent of what it can do until then. The tab's 500-line gate moved the state and copy to `settings-state.ts`, the effects to `settings-actions.ts`, and the regions to `settings-mount.ts`.*
- [x] **T-021** [P] [US6] Composition and accessibility sweep over the finished surface: keyboard-only operation of every field, save, discard, reset, and both confirmation steps with visible focus and no trap; accessible names carrying field name **and** unit; the Status/Settings split (Status effective, Settings configured, both naming a difference); exactly **one** editable rendering of the configuration across all six tabs; the Bindings/Dispatches/Accounts/About tabs gain no configuration control, token input, or credential; one relay loop across a Settings detour during an in-flight dispatch. *Tests* (`tests/settings-a11y.test.ts` + existing suites): AC-141, AC-142, AC-143, SC-113, NFR-107. **(FR-017, FR-018, FR-019, FR-080, FR-081, FR-082, AC-141, AC-142, AC-143, SC-113)** — *reading recorded at implementation: `tests/settings-a11y.test.ts` mounts all six bodies and counts — one editable rendering of the configuration (SC-113 fails at zero and at two), zero configuration controls and zero `password: true` fields on every other tab (AC-142, with credential words matched as **whole words**, since `dispatch` contains the letters `pat`), and a name/unit/boundary/handler on every one of the thirteen controls (FR-018, FR-039, NFR-107). **AC-143 and NFR-104 stay where the loop and the shell live**: `tests/lifecycle-proof.test.ts`'s `AC-136 / SC-108` case drives a mid-flight switch through all six tabs — Settings included — and counts one relay loop and one dispatch, and its `FR-014` case asserts that activating tabs issues no write; this task asserted those suites rather than duplicating them.*

**Wave 7 boundary**: `npm run verify` + bundles.

---

## Wave 8 — Destructive confirmation and restore defaults (User Story 3)

**Goal**: lowering a retention limit tells the whole truth before anything is written. Independent test (spec US3): drive each knob and read the armed copy.

- [ ] **T-022** [US3] Create `src/settings-confirm.ts` (pure content builder per [contracts/settings-confirmation.md](./contracts/settings-confirmation.md)) and wire the arm-then-act step into `src/settings-tab.ts`: lowering any of the three retention knobs arms and states field, both limits, what the limit governs, **what will be removed, when, and what survives**, that raising deletes nothing, and that trimming is irreversible; `auditMaxEntries` additionally states that nothing protected is ever removed to satisfy a cap; raising and every non-retention change write in one activation and arm nothing; **Restore defaults** arms, names every field it will change, and uses the same two-step confirm; cancel/dismiss writes nothing and returns the fields to their last-read values; no `confirm()` anywhere. *Tests* (`tests/settings-confirm.test.ts`): AC-117, AC-118, AC-119, AC-120, AC-121, SC-108 (per knob), the copy-honesty string scan (no claim that nothing is deleted; irreversibility present), and a static scan for dialog primitives. **(FR-016, FR-050, FR-051, FR-052, FR-053, FR-054, FR-036, AC-117, AC-118, AC-119, AC-120, AC-121, SC-108)**

**Wave 8 boundary**: `npm run verify` + bundles.

---

## Wave 9 — Failure states and audit visibility (User Stories 4 and 5)

**Goal**: the state an operator meets when something is wrong names its own cause. Independent test (spec US4): one mount per state.

- [ ] **T-023** [P] [US4] Render the four distinct causes in `src/settings-tab.ts`: *service not running — settings read-only* (static content kept, **zero** input controls and zero save affordances), `503 storage-unavailable` (setup-prerequisite framing, distinct from a value refusal, no automatic retry, the edit not presented as saved), *not authorised* (no retry loop), transport failure (distinct from a refusal, no unread value shown), and an unexpected failure rendering its correlation id as copyable text with no retry; plus the stale-read marker naming when the values were last read and why the current read failed. *Tests* (`tests/settings-failures.test.ts`): AC-129, AC-130, AC-131, AC-132, AC-133, AC-134, AC-140, SC-111 — three distinct causes, zero input controls, and **no number that did not come from a read**. **(FR-060, FR-061, FR-062, FR-063, FR-064, FR-089, AC-129, AC-130, AC-131, AC-132, AC-133, AC-134, AC-140, SC-111)**
- [ ] **T-024** [P] [US5] Surface the audit outcome on the panel: when a save answers `auditWritten: false`, render a **visible warning naming the missing row** while still showing the save as successful, and never imply traceability the panel does not have; expose the correlation id of an unexpected failure as copyable text. *Tests*: AC-139 with a store double whose `appendLine` throws; AC-137's panel half (a configuration row's id is shown, a run-filtered view does not claim one). **(FR-070, FR-074, AC-137, AC-139, NFR-111)**

**Wave 9 boundary**: `npm run verify` + bundles.

---

## Wave 10 — Configuration authority (block J)

**Goal**: one input per field, and the obsolete template is gone. Independent test (spec US4/AC-151): repository scans.

- [ ] **T-025** [US4] Perform the file operations FR-091 requires: **delete `.env.example`** (not rewritten, no replacement template), drop `.gitignore`'s `!.env.example` negation while **keeping** the `.env*` rules, and add `tests/config-authority.test.ts` asserting — no `.env` or `.env.example` in the tree, no `MECHA_TURK_` identifier in any **tracked file except `specs/**`** (the specification corpus quotes it as the record of its removal) *or* in either committed bundle, no dotenv-style loader in `service/`, `.gitignore` still ignores `.env*` with no negation, and `contracts/token-handoff.md` still records the removal. **This task is scheduled, not performed, by Phases 4–5** (this feature's planning task writes markdown only). **(FR-091, AC-151)**
- [ ] **T-026** [P] [US4] Assert configuration authority in `tests/config-authority.test.ts`: the service reads exactly `OPENCHAMBER_SERVICE_PORT`/`OPENCHAMBER_SERVICE_TOKEN` and exits naming a missing/malformed variable **without its value** (AC-152); and exactly **one** poll-interval input exists across manifest, panel source, and service source — the Settings row, whose projection carries 15,000–300,000 ms from the service's own declaration — with no `poll-interval-ms` read from `ctx.settings` and no environment-derived interval (AC-153). Also assert `package.json` still declares **zero** `contributes.integration.settings` entries (002 FR-041) and `capabilities[]` is still exactly `sessions` + `prompt` with no `permissions` key on `contributes.service` (FR-004). **(FR-090, FR-092, FR-004, AC-152, AC-153)**

**Wave 10 boundary**: `npm run verify` + bundles.

---

## Wave 11 — Proof, docs, and the release gate (User Story 6)

**Goal**: every declared class is observed, every invariant is asserted, both user-facing documents agree. Independent test: the full offline suite.

- [ ] **T-027** [US6] Create the take-effect observation suite `tests/take-effect.test.ts`: **one observation per declared class** and **one per consumer** — the widened `since` stamp, the configured `per_page`, a backoff delay inside `[retryMaxMs/2, retryMaxMs]`, a trim pass that removes what the new limit says and preserves every protected row, the first log line after an acknowledgement at the new threshold, and **`next-dispatch`**: drive one verification against a configuration read whose `expectedAgent` was just saved and assert the **new** baseline is compared with no restart and no cycle boundary, that a verification already in progress keeps the baseline it started with, and that a missing/unreadable baseline uses `project-manager` **with its provenance recorded** and never alone marks the run `blocked:agent-mismatch`. Keep the `none` harness in the suite for the day a genuinely inert field is added. *Tests*: SC-106 class histogram over 006's eleven, SC-107 "a declared class with no backing observation fails", AC-104, AC-155. **(FR-031, FR-032, FR-100(e), FR-100(f), AC-104, AC-155, SC-106, SC-107, 002 FR-029)**
- [ ] **T-028** [P] [US6] Extend the cross-cutting suites: `tests/bundle.test.ts` and the secret scans gain Settings-surface cases (no credential in either bundle, no submitted value in any rendered or logged surface) with **no exemption** (NFR-102); `tests/manifest.test.ts` keeps asserting kebab-case identity, unchanged storage-key prefixes, and the empty settings array (FR-004, FR-005); the offline assertion proves no test needs a live host, a real token, or network (AC-144); the bundle-shape assertions prove `panel/main.js` is an IIFE, `service/main.js` is ESM, and both are committed with their sources with `SERVICE_VERSION` still pinned to `package.json` (AC-145, AC-144). **(FR-004, FR-005, FR-085, FR-086, FR-087, NFR-102, AC-144, AC-145, SC-112)**
- [ ] **T-029** [US6] Complete the documentation sync under **002 FR-042** for this feature's claim: `README.md` and `specs/002-agent-event-extension/quickstart.md` describe the Settings tab as the **single configuration input for the whole service configuration** — the eleven documented fields plus `expectedAgent`, the take-effect line each row carries, the retention confirmation, and where the configuration lives (`config.json`, operator-backable) — extending **005's T-033** rather than repeating it. Assert neither document instructs an operator to type `MECHA_TURK_*` values or configure through `.env`, and that no unlabelled `specs/001-agent-event-orchestrator/` path appears. **(002 FR-042, 006 FR-091, FR-092)**
- [ ] **T-030** [US6] Final gate: run the traceability sweep against the tables below (every FR and AC has a task; every task has a test), run `npm run verify` one last time, rebuild and commit both bundles with the final sources, and confirm no out-of-scope-guard line was crossed. **(FR-087, SC-112, AC-144)**

**Wave 11 boundary**: `npm run verify` green; both bundles committed with their sources.

---

## Dependencies & execution order

```text
Wave 1 (T-001..T-004)   ── blocks everything: the declaration feeds every consumer
Wave 2 (T-005..T-006)   ── after W1's route edits (same file)
Wave 3 (T-007 ──► T-008 ∥ T-009 ∥ T-010)   ── T-007's shared config read first
Wave 4 (T-011 ──► T-012 ∥ T-013 ──► T-014) ── primitives first, then the two passes, then wiring
Wave 5 (T-015)          ── after W1 (validation) and W2 (setLevel)
Wave 6 (T-016 ∥ T-017 ──► T-018)           ── reader before rendering; stand-in retired in T-018
Wave 7 (T-019 ──► T-020 ──► T-021)          ── state machine before controls before sweep
Wave 8 (T-022)          ── after W7's controls
Wave 9 (T-023 ∥ T-024)  ── after W7
Wave 10 (T-025 ∥ T-026) ── independent of every source task (file ops + scans)
Wave 11 (T-027 ──► T-028 ∥ T-029 ──► T-030)
```

- **Parallel-safe within a wave**: T-001 ∥ T-003 (different declarations in the same file are ordered only if the reviewer prefers; they touch disjoint symbols); T-005 ∥ T-006's route half is sequential; T-008 ∥ T-009 ∥ T-010 after T-007; T-012 ∥ T-013 after T-011; T-016 ∥ T-017; T-023 ∥ T-024; T-025 ∥ T-026.
- **Hard dependencies**: T-004 needs T-001–T-003; T-006 needs T-005; T-007 precedes all of Wave 3; T-014 needs T-012 and T-013; T-015 needs T-004 and T-006; T-018 needs T-017; T-020 needs T-019 and T-016; T-022 needs T-020; T-030 needs every task.
- **Blocked rather than rebuilt** if a prerequisite's Phase 6 has not run: T-018 and later (005's `settings-*`), T-012/T-013 (003's vocabulary and frozen rows), T-026 (002 FR-041/005's emptied card).

## FR → task coverage (006's own numbering; blocks A–K)

| Block | Requirement | Task(s) |
| --- | --- | --- |
| A | FR-001 (authority) | T-030, T-015 |
| A | FR-002 (read-only to GitHub) | T-028, T-030 |
| A | FR-003 (fail closed) | T-002, T-017, T-019, T-023 |
| A | FR-004 (no capability) | T-026, T-028 |
| A | FR-005 (one durable file, no storage key) | T-002, T-014, T-028 |
| B | FR-010, FR-011 | T-020, T-023 |
| B | FR-012, FR-013 | T-019 |
| B | FR-014 | T-018, T-020 |
| B | FR-015 | T-019 |
| B | FR-016 | T-022 |
| B | FR-017, FR-018 | T-021 |
| B | FR-019 | T-021 |
| C | FR-020 | T-003, T-004 |
| C | FR-021 | T-003, T-017 |
| C | FR-022 | T-018 |
| C | FR-023 | T-018, T-020 |
| C | FR-024 | T-020, T-016 |
| C | FR-025 | T-020 |
| C | FR-026 | T-020 |
| C | FR-027 | T-017, T-018 |
| C | FR-028 | T-002, T-017 |
| C | FR-029 | T-018, T-020, T-022 |
| D | FR-030 | T-003, T-018, T-027 |
| D | FR-031 | T-027 |
| D | FR-032 | T-027 (timer untouched) |
| D | FR-033 | T-005, T-006 |
| D | FR-034 | T-008, T-009 |
| D | FR-035 | T-010, T-020, T-021 |
| D | FR-036 | T-014, T-022 |
| D | FR-037 | T-003, T-006, T-027 |
| D | FR-038 | T-019 |
| D | FR-039 | T-018, T-021 |
| E | FR-040, FR-041 | T-019, T-020 |
| E | FR-042 | T-019 |
| E | FR-043 | T-016 |
| E | FR-044, FR-045 | T-020 |
| E | FR-046 | T-019 |
| E | FR-047 | T-014, T-015 |
| E | FR-048 | T-015 |
| E | FR-049 | T-019 |
| F | FR-050, FR-051 | T-022 |
| F | FR-052, FR-054 | T-022 |
| F | FR-053 | T-012, T-013, T-015 |
| F | FR-055 | T-007, T-011, T-012, T-014 |
| F | FR-056 | T-012 |
| F | FR-057 | T-013, T-014 |
| F | FR-058 | T-010 |
| F | FR-059 | T-008, T-009 |
| G | FR-060, FR-061 | T-023 |
| G | FR-062, FR-063, FR-064 | T-023 |
| H | FR-070, FR-071, FR-072 | T-015 |
| H | FR-073 | T-011, T-012, T-013 |
| H | FR-074 | T-015, T-024 |
| I | FR-080, FR-081 | T-021 |
| I | FR-082 | T-021, T-026 |
| I | FR-083 | out-of-scope guard (no task adds a field) |
| I | FR-084 | T-001, T-003, T-017, T-027 |
| I | FR-085 | T-016, T-028, T-030 |
| I | FR-086 | T-028, T-030 |
| I | FR-087 | T-028, T-030 |
| I | FR-088 | T-021, T-028 |
| I | FR-089 | T-023 |
| J | FR-090 | T-026 |
| J | FR-091 | T-025, T-029 |
| J | FR-092 | T-026, T-029 |
| K | FR-100(a)–(d) | T-001, T-004 |
| K | FR-100(e), (f) | T-027 |
| K | FR-100(g) | T-015 |

## AC → task coverage (006's `AC-101`–`AC-155`; always prefixed when quoted into a shared artifact)

| AC | Task(s) | | AC | Task(s) |
| --- | --- | --- | --- | --- |
| 006 AC-101 | T-004, T-018 | | 006 AC-129–AC-134 | T-023 |
| 006 AC-102 | T-020 | | 006 AC-135 | T-015 |
| 006 AC-103 | T-006 | | 006 AC-136 | T-015 |
| 006 AC-104 | T-003, T-018, T-027 | | 006 AC-137 | T-015, T-024 |
| 006 AC-105 | T-019 | | 006 AC-138 | T-012, T-013 |
| 006 AC-106 | T-018 | | 006 AC-139 | T-015, T-024 |
| 006 AC-107 | T-020 | | 006 AC-140 | T-023 |
| 006 AC-108 | T-015, T-020 | | 006 AC-141, AC-142 | T-021 |
| 006 AC-109 | T-020 | | 006 AC-143 | T-021 |
| 006 AC-110 | T-018, T-020 | | 006 AC-144, AC-145 | T-028, T-030 |
| 006 AC-111 | T-020 | | 006 AC-146 | T-012 |
| 006 AC-112 | T-016, T-020 | | 006 AC-147 | T-013 |
| 006 AC-113 | T-002, T-015, T-020 | | 006 AC-148 | T-010 |
| 006 AC-114 | T-015 | | 006 AC-149 | T-008 |
| 006 AC-115 | T-017, T-018 | | 006 AC-150 | T-009 |
| 006 AC-116 | T-017 | | 006 AC-151 | T-025 |
| 006 AC-117–AC-121 | T-022 | | 006 AC-152, AC-153 | T-026 |
| 006 AC-122–AC-126 | T-019, T-020 | | 006 AC-154 | T-001 |
| 006 AC-127 | T-015 | | 006 AC-155 | T-027 |
| 006 AC-128 | T-014, T-015 | | | |

## Cross-feature obligations carried by this plan

| Obligation | Task |
| --- | --- |
| **003's `leaseMs`/`resultDeadlineMs` render with the rest** | T-003 (declaration entries when present), T-004, T-018 (row count derived — 11 or 13, never hard-coded) |
| **005's bounds stand-in is replaced by 006's wire mechanism** | T-018 (declaration deleted; cross-check reversed into the zero-literals scan) |
| **005's row-count stand-in: rows follow the document, criterion is 006 AC-101** | T-018 (both fixtures asserted) |
| **006 FR-091 file operations** (specs-only in Phases 4–5) | T-025 |
| **002 FR-042 doc sync overlapping 006's surface claims** | T-029 (extends 005 T-033) |
| **003's vocabulary/correlation protected by FR-056** | T-012 (seeds all seventeen event types) |
| **003's frozen legacy delivery rows coexist with the excerpt trim** | T-013 (shared terminality predicate; marker is an absentable detection-axis field) |
| **Pre-existing `config.json` upgrade path** (shared with 003's T-008) | T-002 |

## Out-of-scope guard (restated — check at every wave)

No GitHub write. No new tab/drawer/second surface. No shell, mount, or teardown change. No run state, lease, token, transition, or dispatch-lifecycle row. No prompt work. No `PATCH`, no partial document, no revision precondition. No `MAX_LIST_PAGES`/`MAX_DISPATCHED_EVENTS`/`poll.duplicate` change. No correlation-indexed read API, no restore/export. No `requeueBudget`. No status-projection change. No capability, permission, host API, SDK re-pin, storage key, `SERVICE_VERSION`, or `version` bump. No configuration in `host.storage`.
