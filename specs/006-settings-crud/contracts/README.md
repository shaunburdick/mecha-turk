# Contracts index — `006-settings-crud`

**Feature**: `specs/006-settings-crud` · **Spec**: v1.3.0 · **Date**: 2026-09-28 · **Status**: binding for Phase 6. The *semantics* are fixed by the specification's `## Wire Surface Delta`; the exact member names, discriminant values, and response members below are this Phase-4 contract work, exactly as that section delegates them ("Phase 4 finalizes exact field names…").

These files specify **only what changes on the panel↔service wire** (plus the one panel-side copy contract that changes with it). Transport rules, auth, body/size caps, the error envelope, and every unchanged operation stay in 002's [panel-service.md](../../002-agent-event-extension/contracts/panel-service.md) and 003's [contracts](../../003-dispatch-integrity/contracts/README.md), and are not restated here.

| File | Covers | 006 requirement |
| --- | --- | --- |
| [config-schema.md](./config-schema.md) | `GET /v1/config` widening (`fields`, `source`, `defaultsApplied`), `PUT /v1/config` refusals + no-op + `auditWritten`, and the two audit row shapes | FR-020–FR-028, FR-040–FR-048, FR-070–FR-074, FR-100; SC-101, SC-109, SC-110 |
| [settings-confirmation.md](./settings-confirmation.md) | The destructive-confirmation copy contract — **panel-side, crosses no wire** | FR-050–FR-054, FR-016; SC-108 |

## Checklist against 006's `## Wire Surface Delta`

| Operation row | Disposition | Contract file |
| --- | --- | --- |
| **Config read** | **CHANGED** — `{ config }` → `{ config, fields, source, defaultsApplied }`. Additive; no member renamed; `config` keeps its type and its values | config-schema.md §1–§3 |
| **Config write** | **SEMANTICS UNCHANGED, two additions** — whole-file replacement, additive 422 with `field`+`remediation`, value-free remediation, atomic write, `503` when the store is unavailable, all relied on exactly as shipped. Additions: no-op detection, one `config.changed` row per changed write and per refusal, and `auditWritten` on the answer | config-schema.md §4–§6 |
| **Log level** | **CHANGED, no wire member** — the logger adopts the stored `logLevel` at store open and on an accepted write. Nothing on the wire changes | *none (service-internal; plan C4/C5)* |
| **Poll interval** | **UNCHANGED** — `next-cycle` is shipped behaviour (FR-032) | *none* |
| **Scan window** | **CHANGED, no wire member** — `since = lastScanAt − overlapMs`, read once at cycle start (FR-059a) | *none (service↔GitHub; plan C7)* |
| **List paging** | **CHANGED, no wire member** — `per_page` is the configured `perPage` (≤ 30); `MAX_LIST_PAGES` stays 2 (FR-059b) | *none (service↔GitHub; plan C8)* |
| **Poll request retry** | **ADDED, no wire member** — bounded jittered backoff honouring `retry-after`, never on `auth-failed`, checkpoint retained (FR-058) | *none (service-internal; plan C9, data-model §6)* |
| **Retention trimming** | **ADDED, no wire member** — two passes at store open and the cycle boundary, atomic file replacement, one `audit.trimmed` row when something is removed (FR-055, FR-057) | *none (store-internal; data-model §4–§6)* |
| **Audit vocabulary** | **FILLED, not invented** — `config.changed` and `audit.trimmed` are the names 002's data model already reserved; no event type is added, renamed, or removed | config-schema.md §5 |
| **Audit read** | **UNCHANGED in shape** — a configuration row is retrievable under **its own** correlation id and excluded from run-filtered views (FR-074) | config-schema.md §5 |
| **Status** | **UNCHANGED** — 006 populates only the Settings half of 005 FR-039's pair | *none (005's)* |
| **Health / version** | **UNCHANGED** — `SERVICE_VERSION` still pinned to `package.json` by test | *none* |
| **Bindings / Accounts** | **UNCHANGED** — no configuration value reaches either route | *none* |
| **GitHub** | **NO SURFACE** — outbound reads gain a configured page size and a bounded retry; the posture itself is unchanged (no write, no endpoint, no webhook) | *none* |

**No contract under `specs/002-agent-event-extension/contracts/` or `specs/003-dispatch-integrity/contracts/` is superseded by these files.** 002's `panel-service.md` §1 rule 3 and §2.1's `Config` row are **annotated, not replaced**: the wrapper answer grows two members and the validation row's `field`+`remediation` rule is unchanged. 003's contracts are untouched — a configuration row is *excluded* from run views by 003 FR-052's own rule, which 006 honours rather than amends.

## Co-ship assumption (read first)

The panel and the service are **one committed bundle** (`AGENTS.md` invariant 1): `panel/main.js` and `service/main.js` ship together in the same commit as their sources, and OpenChamber never mixes builds of the two halves. Therefore:

- **new response members are additive** and no existing member is renamed — `config` keeps its name, its type, and its values; `error.issues[]` keeps its `{ field, remediation }` pair.
- **`source` and `defaultsApplied` are readable by an older reader that ignores them** (unknown members are additive on the read path), so the widening cannot strand a stale panel bundle.
- a request that fails panel-side parsing answers the operator with *unreadable*, never with a partially rendered record (FR-028's fail-closed rule).

## Universal rules for every operation in this directory

1. **Fail closed** (FR-003, 002 FR-024, constitution II): any ambiguity — an unknown descriptor, an unreadable document, a malformed envelope — is a refusal with a distinct `code` and a secret-free `message`, never a partial apply and never a guessed default.
2. **Never echo the submitted value** (FR-024, FR-072, 002 SEC-10/SEC-11): `422` issues carry `field` + `remediation` only, and the refused-write audit row carries **no value of any kind** — not the offending value, not an accepted value, not a length, not a hash.
3. **Credential-free** (NFR-102): every body, answer, and error here is scanned by the existing secret suites; the suites gain cases for the Settings surfaces, never exemptions.
4. **Rendered fields** (FR-029, NFR-101): every string these operations return reaches the DOM through the panel's non-HTML path — remediation prose, `format` text, accepted-value labels, and echoed key names all render as text.
5. **No GitHub write** (FR-002): nothing in this directory induces a GitHub state change.
6. **Honest unknowns** (NFR-112): where a configuration cannot be read, the answer carries `source` plus the panel's own wording — never a plausible number presented as configured.
