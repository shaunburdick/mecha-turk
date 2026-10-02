# Acceptance-criteria status — Settings: Full Service Configuration CRUD (006)

**Spec**: [spec.md](./spec.md) v1.3.0 (APPROVED) · **Recorded at**: T-030, the final gate of wave 11
**Gate evidence**: `npm run verify` (build → lint → typecheck → test) green at this commit — **99 files, 1653 tests**, zero suppressions, zero `any`, both bundles rebuilt and committed with their sources, `SERVICE_VERSION` still `0.0.1` and still pinned to `package.json` by `tests/service-server.test.ts`.

**Legend** — **met**: asserted by the test(s) named in the evidence column; **deferred**: deliberately not met, with the reason. Every criterion below is **met**; the two whose evidence is spread across a panel suite and a service suite say so rather than pointing at one file.

Traceability sweep run for this record: all **79** `FR-…` and all **55** `AC-…` numbers the spec allocates appear in [tasks.md](./tasks.md)'s coverage tables (no orphans in either direction), all **30** tasks are ticked, and every task names the test that carries it.

| AC | Status | Evidence |
| --- | --- | --- |
| AC-101 | met | `tests/settings-rows.test.ts` — row count derived from `fields.length` (eleven against the 006 fixture, thirteen against the combined one); `tests/settings-a11y.test.ts` counts one control per `DEFAULT_CONFIG` key and no twelfth |
| AC-102 | met | two halves: `tests/settings-tab.test.ts` (*the new interval is announced for the next poll, and nothing is restarted* — row words, one read + one write, no restart call) and the scheduling half in `tests/service-backoff.test.ts` (*arms the next cycle from the cycle end*) with the mid-cycle-save mechanism in `tests/service-retention.test.ts` (a save lands at the next boundary, not at the write); 006 does not touch the timer (FR-032) |
| AC-103 | met | `tests/service-config.test.ts` (*logLevel is immediate*: the first line after the acknowledgement is judged at the new level, no restart) |
| AC-104 | met | `tests/take-effect.test.ts` (every declared class reads as delivered; the `none`/`restart` harness) + `tests/settings-rows.test.ts` (no row claims *no effect in this build*) |
| AC-105 | met | `tests/settings-tab.test.ts` (*the pending marker names the boundary and is not cleared by the save*) |
| AC-106 | met | `tests/settings-rows.test.ts` — the zero-literals scan over `src/`, with exactly one allow-listed exception (`DEFAULT_EXPECTED_AGENT`) |
| AC-107 | met | `tests/settings-tab.test.ts` — three issues render in the service's order, unrewritten |
| AC-108 | met | `tests/settings-tab.test.ts` — no submitted value in the rendered surface, in `host.storage`, or in a log line |
| AC-109 | met | `tests/settings-tab.test.ts` — every field shows the last configuration the service reported after a refusal |
| AC-110 | met | `tests/settings-tab.test.ts` — an out-of-bounds value is *sent* and refused by the service |
| AC-111 | met | `tests/settings-tab.test.ts` — the cross-field issue renders named against `retryMaxMs` |
| AC-112 | met | `tests/settings-tab.test.ts` (the problem names the configuration, never the bindings list) + `tests/service-calls.test.ts` (the classifier takes the resource) |
| AC-113 | met | `tests/service-config-audit.test.ts` and `tests/service-config.test.ts` — `config.json` byte-identical across every refusal class |
| AC-114 | met | two halves: `tests/settings-rows.test.ts` (a member with no descriptor renders as a line with **no affordance**) + `tests/service-config-audit.test.ts` (the refused row records the documented names and `<withheld>` only) |
| AC-115 | met | `tests/settings-schema.test.ts` (the fail-closed reader) + `tests/settings-rows.test.ts` (*field this version does not show*, and the save is blocked with the reason) |
| AC-116 | met | `tests/settings-schema.test.ts` + `tests/settings-rows.test.ts` — unreadable members render *unreadable* and are never filled from `default` |
| AC-117 | met | `tests/settings-confirm.test.ts` — one activation of `auditRetentionDays` 180 → 30 writes nothing, and the armed copy names the field, both limits, the governs, the removal, and the survivors |
| AC-118 | met | `tests/settings-confirm.test.ts` — the armed control's second activation writes once and shows the returned document |
| AC-119 | met | `tests/settings-confirm.test.ts` — raising any retention knob writes in one activation and arms nothing |
| AC-120 | met | `tests/settings-confirm.test.ts` — a non-retention change writes in one activation and arms nothing |
| AC-121 | met | `tests/settings-confirm.test.ts` — cancelling an armed save and a staged restore both send nothing and return every field to the last-read values |
| AC-122 | met | `tests/settings-edit.test.ts` — discard restores the baseline and reports what reverted |
| AC-123 | met | `tests/settings-tab.test.ts` — unsaved edits survive another body mounting beside this one |
| AC-124 | met | `tests/settings-tab.test.ts` + `tests/settings-edit.test.ts` — no baseline means no request and a named reason |
| AC-125 | met | `tests/settings-tab.test.ts` (the returned configuration renders, not the submitted one) + `tests/settings-failures.test.ts` (the contract's `{ config, auditWritten }` shape renders too) |
| AC-126 | met | `tests/settings-tab.test.ts` + `tests/settings-edit.test.ts` — two activations, one write, and no field flips before the answer |
| AC-127 | met | `tests/service-config-audit.test.ts` — an identical document answers *already saved* and appends zero rows |
| AC-128 | met | `tests/service-retention.test.ts` (*a configuration write runs no trim*) + `tests/service-config-audit.test.ts` — a write touches `config.json` and the trail, nothing else |
| AC-129 | met | `tests/settings-failures.test.ts` — an unreachable service reads *service not running — settings read-only* with zero input controls and the save bar hidden |
| AC-130 | met | `tests/settings-failures.test.ts` — `503 storage-unavailable` renders its own cause, never the refusal copy, with no retry |
| AC-131 | met | `tests/settings-failures.test.ts` — an unauthorised read renders *not authorised* and issues exactly one request |
| AC-132 | met | `tests/settings-failures.test.ts` (the transport **write** cause, distinct from a refusal) + `tests/settings-rows.test.ts` (the unreachable read keeps static content and names the cause) |
| AC-133 | met | `tests/settings-failures.test.ts` — an undocumented failure renders `Correlation id: …` as copyable text and retries nothing |
| AC-134 | met | `tests/settings-failures.test.ts` — a failed re-read keeps the values, marks them stale with the timestamp of the read on screen, and names the cause |
| AC-135 | met | `tests/service-config-audit.test.ts` — one row per changed write, one `field`/`from`/`to` triple per changed field |
| AC-136 | met | `tests/service-config-audit.test.ts` — one refused row with `issueCount`, the documented names, and no submitted value |
| AC-137 | met | two halves: `tests/service-config-audit.test.ts` (the configuration row keeps its own identifier and stays out of a run-filtered read) + `tests/settings-failures.test.ts` (the panel renders a configuration row under its own id, and its only audit read is run-filtered) |
| AC-138 | met | `tests/service-trim.test.ts` — exactly one `audit.trimmed` row after a removal, none for a pass that removed nothing; the excerpt pass in `tests/service-excerpt-trim.test.ts` |
| AC-139 | met | two halves: `tests/service-config-audit.test.ts` (a failing append still answers success plus `auditWritten: false`, with one structured warn) + `tests/settings-failures.test.ts` (the save still shows as saved **and** a visible warning names the missing `config.changed` row) |
| AC-140 | met | `tests/settings-failures.test.ts` — static content and the reason are present, and after the route is stripped no digit at all is on screen |
| AC-141 | met | two halves: `tests/settings-a11y.test.ts` (exactly one editable rendering across six tabs; Settings says the poll interval and the four tabs that own neither value do not) + `tests/status-tab.test.ts` (Status renders `Effective interval` and `Configured interval`) |
| AC-142 | met | `tests/settings-a11y.test.ts` — no configuration control, token input, or credential on Bindings, Dispatches, Accounts, or About |
| AC-143 | met | `tests/lifecycle-proof.test.ts` — the mid-flight switch through all six tabs counts one relay loop and one dispatch (its `AC-136 / SC-108` case); referenced from `tests/settings-a11y.test.ts`, which keeps the Settings half |
| AC-144 | met | `tests/bundle.test.ts` (*the suite runs offline*: every `fetch(` targets a locally bound address, no third-party HTTP client, no credential read from the environment) + the gate itself — `npm run verify` green before each of this feature's commits |
| AC-145 | met | `tests/bundle.test.ts` — `panel/main.js` is an IIFE and is committed, `service/main.js` is ESM and is committed, and the shipped bytes carry the `SERVICE_VERSION` pinned to `package.json`; the bundles ride every commit that touched a source |
| AC-146 | met | `tests/service-trim.test.ts` — only unprotected rows removed, oldest first, survivors keep their `seq`, the trail lands at or below the cap including its own row, every chain keeps opener and outcome |
| AC-147 | met | `tests/service-excerpt-trim.test.ts` — an old `dispatched` row is cleared and marked, a `pending` row of the same age is untouched, exactly one trim row |
| AC-148 | met | `tests/service-backoff.test.ts` — every delay inside `[retryMaxMs / 2, retryMaxMs]`, guidance honoured past the ceiling, no attempt after `auth-failed`, the checkpoint retained, no catch-up |
| AC-149 | met | `tests/service-cycle-config.test.ts` — `since` = `lastScanAt − overlapMs`, and the widened replay queues nothing twice |
| AC-150 | met | `tests/service-cycle-config.test.ts` — `per_page=12`, never above the field maximum, still two pages |
| AC-151 | met | `tests/config-authority.test.ts` — no `.env`/`.env.example` and no replacement template, no `MECHA_TURK_` identifier outside `specs/**` (bundles included), no dotenv-style loader, `.gitignore` still covers `.env*` with no negation, and the handoff contract still records the removal |
| AC-152 | met | `tests/config-authority.test.ts` — the pair starts the service, a missing or malformed variable is named without its value, and the closed set of environment reads is the pair plus `HOME`; `service/config.ts` reads no environment at all |
| AC-153 | met | `tests/config-authority.test.ts` — no `poll-interval-ms` outside a comment, no integration settings on the card, no environment-derived interval, and one input: the projected `intervalMs` row bounded 15,000–300,000 ms; `DEFAULT_POLL_INTERVAL_MS` argued to be a panel constant, not an input |
| AC-154 | met | `tests/service-config.test.ts` — the three value refusals (over-length, charset, credential) and the absent/non-string member each answer `field: expectedAgent` with a remediation that never carries the submission, while a blank value round-trips as the documented *no baseline configured* |
| AC-155 | met | `tests/take-effect.test.ts` — the saved baseline is read once per verification with no restart and no cycle boundary, an in-flight verification keeps the baseline it started with, and an absent document or failed read answers the blank default with `provenance: defaulted` while a present-but-blank value answers `unset` — each recording the observed agent and comparing nothing as the run proceeds |

## Notes on the two criteria whose evidence is split

- **AC-102** and **AC-141** each span a panel half and a service half (and AC-102's service half is the timer 006 deliberately does not modify, FR-032). Each row above names both halves rather than pointing at one file; no criterion is counted on the strength of a single indirect assertion.
- **AC-114** and **AC-137** are the same shape: the service writes the record, the panel renders it, and neither suite alone proves the whole sentence.

## Criteria this feature does **not** claim

None of 006's `AC-101`–`AC-155` is deferred. The out-of-scope guard in [tasks.md](./tasks.md) is unchanged and was checked at every wave: no GitHub write, no new tab, no run-state or prompt change, no `PATCH`/per-field endpoint/revision precondition, no `requeueBudget`, no capability, storage key, `SERVICE_VERSION`, or `version` change, no status-projection change, and no configuration in `host.storage`.


## Amendment note — 2026-10-01 (acceptance evidence consolidated; spec v1.4.0)

The mappings above are the record of *what proved what* when this feature was
accepted. The suite behind them was consolidated on 2026-10-01 by product-owner
order for change efficiency: **1441 tests → 532**, across the same 101 files.

Nothing above stops being true — every criterion still has a proof — but a
criterion may now be discharged by a **representative or table-driven case**
rather than by a dedicated `it()`, and exact-wording pins were dropped where
the wording is not itself a requirement. Where a row cites a per-string
assertion, read it as citing the *behaviour* the string carried.

**Functional requirements, security rules, and AGENTS.md's invariants are
untouched.** The three security-floor proof files (`crash-permutations`,
`dispatch-end-to-end`, `redaction`) were excluded from the consolidation.
