# Contracts index — `005-panel-ia`

**Feature**: `specs/005-panel-ia` · **Spec**: v1.11.0 · **Date**: 2026-09-28 · **Amended**: 2026-10-02 for the account profile write (the 4–5 gate ruling) · **Amended**: 2026-10-03 for the actor allow-list's rendering (GitHub issue #9) · **Status**: binding for Phase 6. The *semantics* are fixed by the specification's `## Wire Surface Delta`; the field names, status codes, query parameters, and error codes below are this Phase-4 contract work, exactly as that section delegates them ("Phase 4 finalizes exact field names, status codes, and error codes").

These files specify **only what changes on the panel↔service wire**. Transport rules, auth, body/size caps, the error envelope, and every unchanged operation stay in 002's [panel-service.md](../../002-agent-event-extension/contracts/panel-service.md) and 003's [contracts](../../003-dispatch-integrity/contracts/README.md), and are not restated here.

| File | Covers | 005 requirement |
| --- | --- | --- |
| [status-projection.md](./status-projection.md) | `GET /v1/status` — `polling` computed, `repositories` populated, `agentPin.lastVerification` widened | FR-031, FR-032, FR-033, FR-034; SC-101, SC-102 |
| [dispatch-list.md](./dispatch-list.md) | `GET /v1/events` — cursor pagination + server-side `bindingId`/`state` filters over the retained path and order | FR-042, FR-043; SC-106 |
| [about-version.md](./about-version.md) | `GET /v1/health` as the About tab's single version source — **no route added** | FR-074; SC-109 |
| [account-display-name.md](./account-display-name.md) | **Account profile write** `PUT /v1/accounts/:numericUserId` — `AccountDto.displayName` **and** `startingPrompt` in one closed two-member body, the refusals, and the **retired** `/display-name` route (file name kept; concern renamed 2026-10-02 at 005 v1.10.0) | FR-066, FR-067; 004 FR-082 (004 v1.4.0); AC-128, AC-129, AC-130 |

## Checklist against 005's `## Wire Surface Delta`

| Operation row | Disposition | Contract file |
| --- | --- | --- |
| **Status** | **CHANGED** — three members stop being literals, and v1.11.0 adds one member per `repositories[]` row (`actorPolicy`). **This row supersedes 003's `## Wire Surface Delta` entry for `Status`, which 003 marked "Unchanged"** (005 FR-001; 003's contracts README §4 already carries the forward pointer) | status-projection.md |
| **Dispatch list** | **CHANGED** — paging + filters; **the path itself is not renamed** (FR-023, confirmed by the product owner 2026-09-28). **Extended at v1.11.0**: the projection carries each source reference's `actorLogin` + `actorAttribution` and the run's `actorPolicy` — **003's** members, specified in [003's run-history-audit.md](../../003-dispatch-integrity/contracts/run-history-audit.md); 005 renders them (FR-094) | *none (003's contract)* |
| **Claim / result / abandon / retry / resolve** | **UNCHANGED by 005** — 003's paths and semantics stand; 005 renders them | *none (003's contracts)* |
| **Bindings** (`GET`/`PUT /v1/bindings`) | **CHANGED at v1.11.0 — one additive member, still no per-binding endpoint** (FR-090, FR-050 reaffirmed). `BindingRecord` gains the optional `allowedUsers` array: **key absent when unset**, an explicitly empty array **refused**, carried by the existing whole-file grant whose prompt-key stripping and "nothing changed" refusal apply to it unchanged. The per-binding `PATCH /v1/bindings/:bindingId` MVP-DEBT is **not reopened** | [`002-agent-event-extension/contracts/binding-allow-list.md`](../../002-agent-event-extension/contracts/binding-allow-list.md) — **002 owns this member**; 005's own rendering obligations live in block J of its spec |
| **Accounts** | **CHANGED by exactly one DTO member**, `displayName`, **plus one new operation** — the account profile `PUT /v1/accounts/:numericUserId` carrying `{ displayName?, startingPrompt? }` (absent = unchanged; closed two-member body) — and **minus the retired `PUT …/display-name`**, which v1.10.0 deletes outright with no alias or redirect (nothing released) | account-display-name.md |
| **Config** (`GET`/`PUT /v1/config`) | **UNCHANGED by 005** — 005 renders `GET` only and MUST NOT call `PUT` (FR-070). *Annotated: eleven fields once 006 FR-100 lands; twelve are already present once 003's `leaseMs`/`resultDeadlineMs` exist — see research Q2* | *none* |
| **Health / About** (`GET /v1/health`) | **UNCHANGED** — becomes the About tab's single version source; **no `/v1/about` or `/v1/version` route is added** | about-version.md |
| **Audit read** (`GET /v1/audit`) | **UNCHANGED** — 005 surfaces the correlation id on the row (FR-049) | *none (003's contracts)* |

**No contract under `specs/002-agent-event-extension/contracts/` or `specs/003-dispatch-integrity/contracts/` is superseded by these files**, with one explicit exception that 005's own specification records: the `Status` wire row, which 003 marked "Unchanged" and 005 changes. That supersession is stated in [status-projection.md](./status-projection.md) §0 and mirrored here.

## Co-ship assumption (read first)

The panel and the service are **one committed bundle** (`AGENTS.md` invariant 1): `panel/main.js` and `service/main.js` ship together in the same commit as their sources, and OpenChamber never mixes builds of the two halves. Therefore:

- **new response members are additive** and no existing member is renamed — `repositories` keeps its name (FR-026), the `events` array keeps its name, and `AccountDto` gains its operator-editable members additively (`displayName`, 005 FR-066; `startingPrompt`, 004 FR-082 — both `string | null`).
- **query parameters are additive**: a request with no parameters behaves exactly as the shipped build did (within the new page size), so an unread parameter is never a way to widen or narrow the set by accident.
- a request that fails panel-side parsing answers the operator with *unreadable*, never with a partially rendered record (FR-041's fail-closed rule for the list, FR-003 generally).

## Universal rules for every operation in this directory

1. **Fail closed** (FR-003, 002 FR-024, constitution II): any ambiguity — unknown filter token, unreadable row, unparseable document — is a refusal with a distinct `code` and a secret-free `message`, never a partial apply and never a silent default.
2. **Never echo the submitted value** (FR-085, 002 SEC-10/SEC-11): `422` issues carry `field` + `remediation` only. This binds `displayName` and the filter parameters equally.
3. **Credential-free** (NFR-102, FR-067): every body, answer, and error here is scanned by the existing secret suites; the suites gain cases for the new surfaces, never exemptions.
4. **Rendered fields** (FR-080, 003 NFR-109): every string these operations return reaches the DOM through the panel's non-HTML path — hostile issue titles, repository names, state reasons, and correlation ids render as text.
5. **No GitHub write** (FR-002): nothing in this directory induces a GitHub state change.
6. **Honest unknowns** (NFR-112): where a value cannot be measured or supplied, the answer carries `null` plus the panel's own *not measured yet* / *total unavailable* / *not available* wording — never a plausible number.
7. **One policy comparison, one rendering** (added at v1.11.0): the actor allow-list is **compared** in exactly one place — the service's authorization decision (003 FR-076) — and **rendered** in exactly one place — the binding editor field (FR-091). A row summary may show the **count**; Status may show a **counted line** and a **shape** (`actorPolicy`); no surface may show the logins themselves, and no rendered string may present a binding as protected/restricted/secure unless the service reported it `restricted` (NFR-113).
