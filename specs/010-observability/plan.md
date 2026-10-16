# Implementation Plan: Lifecycle service-log viewer (the Logs tab)

**Branch**: `010-observability` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md) (v1.0.0, Gate 1 passed 2026-10-15 after three challenger passes — decision-closed; the product-owner calls are recorded on issue #53 and are not re-opened here)

**Input**: Feature specification `specs/010-observability/spec.md` (v1.0.0); the two specs it amends, already re-cut on this branch and **not edited by this phase** — `specs/005-panel-ia/spec.md` (**v1.22.0**, seven tabs) and `specs/002-agent-event-extension/spec.md` (**v1.19.1**, FR-042's one phrase) with `specs/002-agent-event-extension/contracts/panel-service.md` (the one §2.5 row this feature adds, planned below); constitution `.specify/memory/constitution.md` (v1.3.0); repo directives `AGENTS.md`; and the shipped code itself (read for this plan: `service/{log,main,server,http}.ts`, `service/routes/{index,types,status,audit,config}.ts`, `service/poll/cycle-config.ts`, `src/{tabs,tab-bodies,panel-state,status-tab,status-lines,status-document,service-calls,app}.ts`, `panel/index.html`, `tools/visual/{shot,panel-a11y,fixtures,host,browser,assert-body}.js` + `fixtures.json`, `tests/{tabs,status-refresh,lifecycle-proof,visual-structure,render-a11y,service-server,service-config,settings-a11y,bundle}.test.ts`, `tests/support/{service,panel,service-routes}.ts`, `site/src/pages/index.astro`, `site/tests/landing-page.assertions.mjs`, `DESIGN.md`, `AGENTS.md`).

**Gate status**: this file plus [tasks.md](tasks.md) is the **unapproved Phase-4/5 handoff**. Gate 2 and user approval come before any implementation commit; nothing is committed with these documents.

## Summary

The service already writes one redacted JSON line per event to stdout; 010 gives the panel a **watch surface** for it. A **bounded ring of the service's own emitted lines** (1 000, drop-oldest, per-process monotonic `seq`) is teed inside `createLogger`'s emit path — one serialize/redaction pass, the stdout sink untouched — and one new loopback read, **`GET /v1/logs?cursor=&limit=`**, answers `{ entries, startedAt, intervalMs }` from memory (never the store: an unusable store does not refuse it). The panel grows a **seventh tab, Logs, last after About**, that reads on activation, polls on an activation-scoped cadence armed from **its own answer's `intervalMs`** (the same effective value `GET /v1/status` reports), holds at most the same 1 000 lines newest-first, states restart and failure in words, and keeps nothing in `host.storage`. Every surface outside `specs/` that counts the tabs is caught up to seven (FR-008), and the one contract file gains a dated §2.5 row attributed to 010.

Not one word of manifest, capability, SDK, `SERVICE_VERSION`, package `version`, configuration field, or storage key moves; redaction and the store are untouched.

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, zero `any` (AGENTS.md invariant 7) |
| Panel runtime | Sandbox iframe; `panel/main.js` (IIFE) bundled by `bunx openchamber-guest-bundle` and **committed with its source** (invariant 1) |
| Service runtime | Node ESM, stdlib only; `service/main.js` (ESM) committed; the shipped surface stays Node-20-era API only |
| Wire | **One new operation**: `GET /v1/logs` on the existing loopback transport — bearer auth, `401`, the 256 000-char `500 response-too-large` guard and the error catalog are inherited by registration, not re-implemented |
| Storage | **Nothing.** No file, no schema version, no audit row, no `host.storage` key; the ring is process memory (constitution III tension, accepted in issue #53) |
| Configuration | **No field added.** `intervalMs` and `logLevel` are existing fields read/applied through existing paths |
| Testing | vitest, fully offline: real loopback service on temp dirs (`tests/support/service.ts`), fake host + fake DOM + driven clock (`tests/support/{panel,dom}.ts`, `vi.useFakeTimers`), the visual harness (`tools/visual/`), the site's own `node --test` gate. No live OpenChamber, PAT, or network |
| Version posture | `0.3.1` **no bump** (invariant 2); `SERVICE_VERSION` byte-pinned by `tests/service-server.test.ts` (invariant 5) and unchanged; SDK `2.3.1` exact, no re-pin (invariant 6) |

## Constitution Check (v1.3.0) — what the implementation must not violate

*The spec's own Constitution section is the summary; these are the lines a reviewer checks the diff against.*

- **Loopback-only, nothing pushed (I, VII)**: the tab reads one versioned loopback route through `host.serviceRequest`, exactly as every other tab does; no SSE/webhook/long-poll, no `host.request()` caller appears, `capabilities[]` stays `sessions` + `prompt`, `contributes.service` gains no `permissions` key (invariant 3).
- **Redaction untouched (IV, invariant 9)**: the ring taps the line **after** `service/log.ts`'s own `serialize` has run `redact`; `src/redaction.ts`, the audit writer, and the secret-scan suites are edited by no task. AC-002 is the proof that no token-shaped byte reaches ring, answer, or tab.
- **Store untouched (III)**: no task writes or reads a store document to answer the logs read; `store === null` is a **200**, not a 503; `SERVICE_SCHEMA_VERSION` stays 1 and no store file gains a member.
- **Durable record stays the audit trail (III)**: the ring survives no restart, and FR-006's restart note is what keeps the memory window from reading as history.
- **Specification before implementation (VI)**: every acceptance criterion is discharged by an offline task below; no operator-gated check is added.
- **Quality gates**: strict TS, `npm run verify` at each wave boundary, committed bundles rebuilt with their source, fail-closed parse everywhere an answer enters the panel (invariant 8), and the evidence/NDJSON contract (invariant 10) is read by nothing this feature touches.

**No constitutional violations, therefore no complexity-tracking rows and no exceptions to record.**

## Requirement → module mapping

| Spec group | Service | Panel | Proven by |
| --- | --- | --- | --- |
| **FR-001** (the ring) | `service/log-ring.ts` (new) + the tee in `service/log.ts` | — | `tests/service-logs.test.ts`: AC-001, AC-009 |
| **FR-002** (`GET /v1/logs`) | `service/routes/logs.ts` (new), `routes/index.ts`, `routes/status.ts` (export its config reader) | — | AC-003 + the store-null and interval-equals-status assertions |
| **FR-003** (the seventh tab) | — | `src/panel-state.ts`, `src/tab-bodies.ts`, `src/tabs.ts` | AC-004, `tests/tabs.test.ts` |
| **FR-004** (render newest-first, held bound, read states) | — | `src/logs-service.ts`, `src/logs-rows.ts`, `src/logs-tab.ts` (all new) | AC-011, AC-002 (render half), AC-010 (panel half) |
| **FR-005** (activation read + cadence) | — | `src/logs-tab.ts`, `src/tabs.ts`, `src/status-lines.ts` (`cadenceLine` label) | AC-005, AC-006 |
| **FR-006** (restart stated) | — | `src/logs-tab.ts`, `src/logs-rows.ts` | AC-007 |
| **FR-007** (honest failure) | — | `src/logs-tab.ts`, `src/logs-rows.ts` | AC-008 |
| **FR-008** (count catch-ups, exhaustive by category) | — | prose sweeps in `src/`, `panel/index.html`, `tools/visual/`, `site/`, `tests/`, `DESIGN.md`, `AGENTS.md` + the 002 contract row | AC-004 (tools/site halves), grep audit in the closing task |

## Project Structure

### Documentation (this feature)

```text
specs/010-observability/
├── spec.md              # Gate 1 passed (input; not edited by this phase)
├── plan.md              # this file
└── tasks.md             # Phase 5 output (same handoff)

specs/002-agent-event-extension/contracts/panel-service.md   # §2.5: ONE new row + one dated note
                                                             # attributed to 010; 002's version unmoved,
                                                             # every other byte of that file untouched
site/src/pages/index.astro            # FR-008(b): the "six tabs" sentence + the <dl> gains Logs
site/tests/landing-page.assertions.mjs# FR-008(b): label list, count, five count-prose sites
DESIGN.md, AGENTS.md                  # FR-008(c): two lines each (the measured-coverage line STAYS)
```

### Source Code (repository root)

```text
service/
├── log-ring.ts          # NEW — LOG_RING_CAPACITY = 1_000, LogRingEntry {seq,line},
│                        #   createLogRing(): per-process monotonic seq assigned on append,
│                        #   drop-oldest, entries() ascending (FR-001)
├── log.ts               # EXTEND — createLogger builds the ring and appends every accepted line
│                        #   beside the sink call (post-threshold, post-serialize/redact);
│                        #   ServiceLogger gains retained() (FR-001; stdout sink path unchanged)
├── routes/logs.ts       # NEW — GET /v1/logs: cursor 422-with-remediation and no echo,
│                        #   limit default 200 clamped 1..LOG_RING_CAPACITY, absent cursor = tail,
│                        #   body {entries, startedAt: context.startedAt, intervalMs} exactly,
│                        #   NO store check (FR-002; Wire Surface Delta; invariant 8)
├── routes/index.ts      # EXTEND — register logsRoute beside the other reads (FR-002)
└── routes/status.ts     # EXTEND — export the existing private readConfig (one keyword, zero
                         #   behaviour change) so both cadence tabs read one number (FR-002)

src/
├── service-calls.ts     # EXTEND — LOGS_PATH = '/v1/logs' beside the other path constants (FR-004)
├── logs-service.ts      # NEW — fail-closed reader: entries/startedAt required and narrow,
│                        #   intervalMs readable-finite → number, anything else → null and the
│                        #   answer still loads (FR-004, FR-005; invariant 8)
├── logs-rows.ts         # NEW — pure rendering: newest-first rows (timestamp, level as text,
│                        #   message, fields), non-JSON line renders its own text, read-state /
│                        #   restart / cadence copy (FR-004, FR-006, FR-007; AC-011)
├── logs-tab.ts          # NEW — LogsTabState + initialLogs(), loadLogs (in-flight guard,
│                        #   restart reset, 1 000-line hold, arm/disarm), armLogsRefresh/
│                        #   stopLogsRefresh (status-tab's shape), mount/repaint/dispose (FR-004–FR-007)
├── status-lines.ts      # EXTEND — cadenceLine gains an optional control label; Status's rendered
│                        #   strings stay byte-identical (FR-005, AC-006)
├── panel-state.ts       # EXTEND — TabId + 'logs' LAST, TAB_IDS, LOGS_TAB, PanelState.logsTab,
│                        #   PanelRuntime.logsRefreshTimer/logsRefreshMs/logsUi; count prose re-cut (FR-003)
├── tab-bodies.ts        # EXTEND — the seventh spec { id:'logs', label:'Logs', … } after About (FR-003)
└── tabs.ts              # EXTEND — the two STATUS_TAB special cases become a local cadence table
                         #   { status, logs } (read on activation + re-activation, stop on leaving);
                         #   count prose + the css-escape suppression reason re-cut (FR-003, FR-005)

tools/visual/
├── shot.js              # EXTEND — TABS gains Logs; probe offsets derive from TABS.length and
│                        #   PROBE_COLORS grows to 16 sentinels; help/capture comments (AC-004, FR-008(a))
├── panel-a11y.js        # EXTEND — TABS gains Logs; header/comment count prose (AC-004, FR-008(a))
├── fixtures.json        # EXTEND — a `logs` answer (entries + startedAt + intervalMs 60_000)
├── fixtures.js          # EXTEND — ['GET /v1/logs', answer(data.logs)] so the capture shows data,
│                        #   which this module's own header promises (AC-004)
└── browser.js, assert-body.js, host.js   # EXTEND — one-word count prose each (FR-008(d))

tests/
├── support/service.ts   # EXTEND — TestService exposes the running instance's logger, the seam
│                        #   AC-001/AC-009 drive the process's own emissions through (test support)
├── service-logs.test.ts # NEW — AC-001, AC-002 (service), AC-003, AC-009, AC-010 (page cap),
│                        #   FR-002's store-null answer and interval-equals-status pin
├── logs-refresh.test.ts # NEW — driven clock in status-refresh.test.ts's shape: AC-005, AC-006,
│                        #   AC-008's cadence halves, AC-010's one-request-per-period
├── logs-tab.test.ts     # NEW — AC-007, AC-008, AC-011, AC-002's render half, AC-010's held bound,
│                        #   FR-019 read states over the fake host + fake DOM
├── tabs.test.ts, lifecycle-proof.test.ts, visual-structure.test.ts, render-a11y.test.ts,
│   containment-proof, settings-a11y, bindings-actors, bindings-prompt, bundle.test.ts,
│   status-refresh.test.ts, startup-*, support/prompt-tiers.ts
│                        # EXTEND — seven-tab enumerations/assertions (AC-004) and the
│                        #   renderSixTabs/SixTabs + count-prose catch-ups (FR-008(e))
panel/main.js, service/main.js   # rebuilt bundles, committed with their source (invariant 1)
```

**Supporting artifacts skipped, and why**: `research.md` — no third-party premise exists (every fact this plan leans on is in this repository's own code, read above). `data-model.md` — nothing persisted is added or changed; the ring is memory and the panel's held set is deliberately not persisted (spec `## Not doing`). `contracts/` — the new surface is an internal loopback read the spec itself specifies; the one external-looking document, 002's `panel-service.md`, gains its row as a named task rather than as a new contract file. `quickstart.md` — verification uses only documented commands (`npm run verify`, `npm run shot`, `node tools/visual/panel-a11y.js`, `cd site && npm test`).

## Key Decisions (plan-phase pins; chosen over the alternative each was made from)

1. **Ring wiring: a tee inside `createLogger`'s emit, with the ring owned by the logger** (`service/log-ring.ts`, read back through `ServiceLogger.retained()`). The logger appends the very line it hands its sink — post-threshold, post-serialize, post-redaction — so stdout's bytes and the ring's bytes cannot diverge, and the route cannot read a buffer its own process never fed. *Alternative*: a ring threaded as a separate `StartServiceOptions.logs` → `RouteContext.logs` dependency — rejected: nothing in the type system stops a caller handing a logger and a ring that do not match, and the route would then answer an empty buffer while stdout carried the lines — the exact "literal a running process contradicts" class 005 exists to end. *Alternative*: a second logger — rejected outright by the spec (a second threshold, a second serialization: the retained line must **be** the line stdout received). *Alternative*: composing the tee through the existing `sink` option — rejected: it re-implements the default stdout sink in a second place, so two places would have to agree on where stdout goes.
2. **Seq is assigned in `append` from a per-process counter incremented on every append**; a full ring drops its oldest entry and the counter keeps climbing, so a dropped number is never reused and a surviving cursor resumes correctly (AC-001). *Alternative*: deriving `seq` from the array position — rejected: positions shift on every drop, which is precisely the cursor corruption FR-001's monotonic clause forbids.
3. **Capacity is one exported constant (`LOG_RING_CAPACITY = 1_000`) that both the ring and the route's `limit` clamp read** — so the clamp can never hide a retained line behind a second request (Wire Delta's `limit` clause). Drop-oldest, no allocation knob: the spec's *Not doing* forbids a buffer-size dial.
4. **`startedAt` and `intervalMs` are read from the status route's own sources, not re-derived**: `context.startedAt` (the same stamp `uptimeMs` is computed from) and `service/routes/status.ts`'s existing private `readConfig`, exported by adding one keyword. *Alternative*: a second config read in the logs route — rejected: two readers of `config.json` are two numbers that can disagree (005 NFR-112, the exact objection 005's row 53 records). *Alternative*: `service/poll/cycle-config.ts`'s `currentIntervalMs` — rejected: `GET /v1/status` does not report from it, and the spec pins "the same value `GET /v1/status` reports"; reusing status's reader gives byte-identical values **and** identical failure modes, including the store-null `DEFAULT_CONFIG` fallback.
5. **The route mirrors `/v1/audit`'s cursor/limit helpers with its one named departure** — absent or blank cursor means *the newest `limit` entries* (a watch view opens on the tail), present cursor means `seq > cursor` ascending, a non-`/^[0-9]{1,15}$/` cursor is `422 validation` naming `cursor` with a remediation and echoing nothing, a non-numeric `limit` takes 200 and a numeric one is **clamped** into `1..1000`. The body carries exactly the Wire Delta's three members — no `nextCursor`, no `count` — because the panel derives its cursor from the newest line it holds. The handler performs **no store check** (FR-002's "an unusable store does not refuse it"), and the transport's auth and 256 000-char guard arrive by registration, with no truncation path added.
6. **Panel module layout follows the house shape**: `src/logs-service.ts` (fail-closed reader), `src/logs-rows.ts` (pure rendering), `src/logs-tab.ts` (state slice + read + cadence + mount), `LOGS_PATH` beside the other constants in `service-calls.ts`. *Alternative*: a fourth `logs-state.ts` module — rejected: Settings and About carry their slice in the tab module, and splitting one tab's state from its reader buys nothing. *Alternative*: extending `status-tab.ts` — rejected: one responsibility per module, and the two cadence tabs must be independently disposable.
7. **The cadence is status's mechanism, copied in shape, with two explicit slots** (`rt.logsRefreshTimer` / `rt.logsRefreshMs`, two slots for one fact per 005 NFR-112): arm only after a landed answer carrying a readable `intervalMs`, arm guarded by `disposed` and `activeTab === LOGS_TAB`, idempotent for an unchanged period (so reads do not push the schedule forward), in-flight refusal through `phase === 'loading'` (a tick during a read issues nothing and queues nothing), failure never disarms and never shortens, teardown clears. `src/tabs.ts`'s two `STATUS_TAB` special cases become one local cadence table keyed by tab id — read on both activation paths, stop when a cadence tab is left. *Alternative*: a third and fourth literal special case in `activate` — rejected: FR-014's rule would be spelled three times in one function. *Alternative*: a generic timer map in `panel-state.ts` — rejected: it would rewrite the proven Status path and its driven-clock suite for no behavioural gain.
8. **A cadence statement and its timer are never allowed to disagree**: an answer whose `intervalMs` is unreadable still renders the stream (`intervalMs: null` in the view) but arms nothing **and disarms anything armed**, so "not refreshing itself" stays true of the actual timer (AC-006). The interval-less sentence reuses `cadenceLine` with a control label (`Refresh logs`) rather than growing a second period renderer — two period renderers drift, and the machine-string defect this sentence class already caused was caught by `npm run shot` once. *Alternative*: keeping a previously armed tick through an interval-less answer — rejected: the tab would print a cadence the timer no longer backs.
9. **The panel's cursor is derived from its held set** — the newest `seq` it holds — with no separate cursor slot. A restart (answer `startedAt` differs) therefore clears lines **and** cursor by one act, and the next read is a tail read by construction (FR-006, one fact one source).
10. **The held set is a ≤1 000-line list capped drop-oldest on merge**, rendered newest-first through the non-HTML path with the level as a word; a trailing newline is trimmed for **display only** — the ring and the wire keep the serialized line byte-for-byte (FR-004).
11. **Status stays the landing tab; Logs reads only on activation** (`activeTab: STATUS_TAB` untouched; no mount-time `loadLogs` in `app.ts`): the panel opens where the answer to "is it working" lives, and FR-005 gives Logs its read at first activation instead.
12. **Copy the spec leaves open, pinned here**: the retry affordance is one button labelled **`Refresh logs`** (005 FR-019's *Refresh status* idiom — one control that is both the manual read and the retry); the lines render in a second block headed **`Stream`** under the tab's title block `Logs` (the one-rule-across-the-tabs shape every other tab uses).

## Constraint honesty (the spec's wire claim, verified against this tree)

Verified by reading the transport and the route table, not assumed:

1. **Exactly one new operation, additive within `/v1`.** `service/routes/index.ts` gains one literal `GET`; no existing route, member, status code, or error code changes meaning, and no existing route file is edited except `routes/status.ts`'s one-keyword export.
2. **Nothing else on the wire moves.** No existing answer gains or loses a member; the panel's only new outbound path is `host.serviceRequest` to `/v1/logs` (`host.request()` still has no caller — invariant 3 holds unchanged).
3. **No manifest, capability, SDK, `SERVICE_VERSION`, package `version`, configuration field, or storage key change** — nothing in the task list touches `package.json`, `service/routes/health.ts`, `service/config.ts`'s schema, or any `STORAGE_KEY` (spec `## Not doing`; invariants 2–6).
4. **Redaction and the store are read by no new write path.** The tee sits downstream of the existing `redact`; the route reads `context.log` and `context.startedAt` only, plus the status route's config reader (a read that already runs today).
5. **`specs/` edits are closed**: 010's `spec.md`, 005's and 002's spec/changelog texts are not touched by any task; the single authorized `contracts/panel-service.md` §2.5 row is planned as T031 and attributed to 010; 006/007's *six-tab* mentions stay as dated records per `## Amending 005`.

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Seven labels may not fit the ≤380px strip rule** (the prose records a six-label measurement: 413px of a 314px strip at full size) | the 320px fit claim in `panel/index.html` becomes false, or Logs needs a sideways scroll to reach (005 FR-082 must keep holding at seven) | T025 **measures before it writes**: run `panel-a11y.js` at 320px with seven labels, re-cut the measured numbers in place; if the strip overflows, the **outcome binds** — seven labels fit at 320px with no horizontal scrollbar — and the levers are pre-decided: the same media block's smaller `padding-inline` first, its `font-size` a notch down if padding alone is not enough (per T025), never a mid-flight surprise |
| **The FR-008 sweep misses a count site** | a surface still says six; AC-004/FR-008 fail late | the inventory is **re-derived from the tree at execution time** (`grep -rn 'six' src/ tests/ tools/ panel/ site/src DESIGN.md AGENTS.md`) with the semantic filter below, and T032 audits the leftover list before closing |
| **The tee sits on the one line every logger writes** | a mistake corrupts stdout or bloats memory | the existing `service-log.test.ts`/redaction suites run untouched; T006 asserts the sink still receives each line and that the ring's bytes are the sink's bytes; the ring is bounded at 1 000 entries per logger |
| **`src/tabs.ts` generalization regresses Status's cadence** | both cadence tabs break together | `tests/status-refresh.test.ts` is the shipped, untouched proof of every Status clause — it must stay green with **no edit to its assertions** (only its four count-bearing comments are re-cut in T022) |
| **A full 1 000-entry page of real lines exceeds the 256 000-char guard** | `500 response-too-large` on a wide read | intended: inherited, never truncated (Wire Delta), and the tab shows it as FR-007's failed read; AC-001's fixture uses short lines by design |

**Semantic filter for the sweep (what "six" must NOT touch)**: `six` counting lifecycle states (`accounts-rows`), reason words, prerequisites, sentences, or steps stays; `six` counting tabs, tab bodies, or the strip becomes `seven`; the `CHANGELOG.md` release line, `DESIGN.md`'s measured-coverage line (*36 tab/width reviews*), `AGENTS.md`'s *six gated phases*, and every `specs/` mention stay verbatim per FR-008's own exclusions.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.
