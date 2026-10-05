# Implementation Plan: Agent Event Extension (Production)

**Branch**: `001-agent-event-orchestrator` | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md) (v1.0.0, approved)

**Input**: Feature specification `specs/002-agent-event-extension/spec.md`; constitution `.specify/memory/constitution.md` v1.3.0; carried-forward research `specs/001-agent-event-orchestrator/research.md` (**historical path — removed 2026-09-28** in commit `110c0a2`; recover with `git show 110c0a2^:specs/001-agent-event-orchestrator/research.md`; the findings that bind this plan are restated in `spec.md`'s `## Research and Platform Decisions` table and in `research.md` §R1–§R7 of this feature).

**Historical-path note (2026-09-28, cleanup review)**: every `001 …` citation in this file — `001 research §b.9` (transport), `001 research §b.8` (no settings writer, the reason `expected-agent` is a manifest setting), `001 research Host API`, `001 §b.7` / `§b.6` (panel lifetime, uninstall wipe), `001 §a.5` (page cap), `001 §a.3` / `§a.4` (rate arithmetic), and `spike-evidence.md §4.1` (folder install) — refers to the `specs/001-agent-event-orchestrator/` directory **removed in commit `110c0a2`**. They are kept as stamped provenance; recover any with `git show 110c0a2^:specs/001-agent-event-orchestrator/<file>`. This plan's live successors are `research.md` (§R1–§R7), `spec.md` (FR-002, FR-011, FR-017, FR-029, FR-041), and `contracts/events-carry-forward.md`.

**Note**: No application code is written in phases 4–5. Every decision below is decided and justified — there are no open option pairs.

> ⚠️ **CORRECTION NOTICE (2026-10-03, spec 002 v1.12.0) — the attribution rows in this plan are obsolete.**
> This plan's requirement-coverage table and its constitution-alignment table record the
> `subject-author` proxy as the design for the `assignment` and `review` triggers, and record the
> resulting "contract limitation" — *"GitHub's list feeds expose `assignees` and
> `requested_reviewers`, never the actor"* — under Principle **I**. **Both are false.**
> **GitHub records both actors**, in `assigner` and `review_requester` on the per-item events feed
> `GET /repos/{owner}/{repo}/issues/{issue_number}/events`; the list feeds' silence was generalized
> from two endpoints to the provider. Principle **I** is therefore **satisfied rather than strained**,
> not recorded as a limitation. The rows below (`FR-044`, `service/poll/loop.ts`, Principle I) are
> preserved as the record of what was planned and **must not be implemented as written**; the
> corrected design is 002 **FR-044** *(re-cut)*, **FR-045** *(re-cut)*, **FR-049 – FR-052** *(new)*,
> and `research.md` §R8 (rewritten). Every other row, decision, and module in this plan stands.

## Summary

Ship the approved "Option B" architecture as **one OpenChamber extension package** containing (1) a **panel** — configuration, dispatch, verification, and observability UX — and (2) an **OpenChamber-hosted local guest service** — multi-account GitHub credential custody, outbound HTTPS polling with durable checkpoints and dedup, policy decisions, run lifecycle, and the service-owned audit trail. The panel reaches the service only through the documented `host.serviceRequest()` loopback proxy; the service never touches host APIs; neither half ever writes to GitHub.

The validated spike code under `extension/` (186 → 229 tests) is the foundation: pure matching/redaction/id helpers are **ported shared**, panel orchestration and dispatch are **extended**, and panel-side GitHub access, evidence records, and the `host.storage` ledger are **replaced** by service-owned equivalents (honest per-module mapping in §Reuse).

## Technical Context

| Dimension | Value |
| --- | --- |
| Language | TypeScript `6.0.3` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zero lint suppressions, no `any` |
| Panel runtime | Sandbox iframe, classic IIFE `panel/main.js` bundled by `bunx openchamber-guest-bundle` (spike-verified) |
| Service runtime | **Node ESM**, spawned by the host with `process.execPath` + `ELECTRON_RUN_AS_NODE` (GUEST_SERVICES.md §model) — no system `node` required; built with `bunx openchamber-guest-bundle --node service/main.ts service/main.js` and **committed built** |
| Service dependencies | **Node stdlib only** (`node:http`, `node:fs`, `node:path`, `node:crypto`, global `fetch`) — no framework, no native modules (a native SQLite driver would not load under the app runtime without rebuild) |
| Storage (service tier) | JSON entities + NDJSON append-only audit under `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`, atomic temp+rename) — see research.md §R2 |
| Storage (panel tier) | `host.storage` (64 KiB/value, 2 MiB namespace, **wiped on uninstall**) for UI state and bounded display mirrors only |
| Testing | vitest `5.0.2` — unit + contract tests with fixture GitHub responses, fake host, fake loopback service; live E2E on the operator's instance |
| Target platform | OpenChamber **desktop and web only** (services do not spawn on VS Code/mobile → explicit unsupported state) |
| Scale | <10 repositories, a handful of accounts, one local OpenChamber installation, one logical service instance |
| SDK pin | `@openchamber/sdk` `1.24.2` exact, re-pinned to the host release before live execution (NFR-008) |

## Architecture

### Component responsibilities (decided)

| | **Panel** (`extension/panel`, `extension/src/*`) | **Service** (`extension/service/*`) | **OpenChamber host** |
| --- | --- | --- | --- |
| Owns | Accounts/bindings/policy/runs/health UX; token entry + consent + one-shot handoff; project picker (`listProjects()`); dispatch (`startSession()`); post-dispatch agent verification; run/health display | Token custody (durable, outside `host.storage`); GitHub polling (own `fetch`, headers, ETags, `x-ratelimit-*`); checkpoints, delivery dedup, rate accounting; normalization, policy decisions, run state, audit trail | Projects, worktrees, sessions, agents; `serviceRequest` loopback proxy; capability approval; service process lifecycle; `host.storage` |
| Never | Holds a token beyond the handoff; polls GitHub; creates/mutates projects, worktrees, sessions, agents; writes to GitHub; reads `host.storage` as an audit home | Calls host APIs; spawns sessions; touches the harness; any GitHub write; renders UI | — (Mecha Turk never recreates these) |

Transport (001 research §b.9, verified against pinned `GUEST_SERVICES.md`):

```
panel --serviceRequest({method, path, query?, body?})--> host --HTTP 127.0.0.1:<ephemeral>--> service
```

- Service binds `127.0.0.1:$OPENCHAMBER_SERVICE_PORT` only; **every** request (including `/health`) requires `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN`; the panel never sees that token and never dials the port.
- Leg limits (pinned `contract.d.ts`): request body ≤ `GUEST_REQUEST_BODY_MAX` 64,000 chars (service enforces 60,000), response ≤ `GUEST_REQUEST_RESPONSE_MAX` 256,000 chars (**all list endpoints paginate**), round trip ≤ `GUEST_REQUEST_TIMEOUT_MS` 20,000 ms (long-poll capped at 10,000 ms).
- `path` starts with `/`, no scheme. Error codes surfaced to the panel: `NO_SERVICE`, `DISABLED`, `SERVICE_FAILED`, `HOST_TIMEOUT`, `HOST_UNAVAILABLE`, `BAD_PATH`, `NOT_GRANTED` (see [contracts/panel-service.md](./contracts/panel-service.md)).

### Manifest (decided, verified in research.md §R1)

```jsonc
"contributes": {
  "panel": { "id": "mecha-turk", "name": "Mecha Turk", "icon": "github", "entry": "panel/index.html" },
  "capabilities": ["sessions", "prompt"],          // declared enum only
  "integration": { /* optional, non-authoritative host-managed GitHub card (FR-011) */ },
  "service": { "entry": "service/main.js", "runtime": "host" }   // NO `permissions` key
}
```

- `service.permissions` is **optional** (`ServiceContribution` in `dist/manifest.d.ts`, 1.24.2) — a loopback-network service declares none; the approval dialog then shows no `exec`/`sockets` chips while still stating full-user-access in plain words (advisory-permissions copy is what FR-008's consent step must restate).
- `service` and `network` capabilities are **implied** (`requestedGuestCapabilities`: `contributes.service` → `service`, `contributes.integration` → `network`) and must **not** be listed in the `capabilities` array — the zod enum is `["prompt","sessions","files","model"]` and a literal `"service"` entry fails install with `invalid-capabilities`. Effective requested set = `sessions`, `prompt`, `service`, `network`.
- `service.entry` ships compiled JS; the host never compiles TypeScript. `engines.openchamber: ">=1.24.0"` and semver `version` stay.

### Event relay protocol (decided)

Request/response only (streaming is deferred by the platform). The service never pushes; the panel **long-polls**:

1. `GET /v1/dispatches?cursor=<n>&waitMs=10000` — service replies immediately if any run is dispatchable, otherwise holds the request up to 10 s (< 20 s leg timeout) and replies `{ runs: [], cursor }` on hold expiry.
2. Each relayed run carries a **dispatch lease** (`leaseId`, `expiresAt`, default 180 s — `startSession` may wait up to 180 s). The lease is the idempotency edge: only a leased run may call `startSession`, and the lease is single-use per attempt (each attempt audited).
3. Panel posts outcomes: `POST /v1/runs/:runId/dispatch-result` → `verifying_agent`; `POST /v1/runs/:runId/verification` → `dispatched` or `blocked:agent-mismatch`.
4. Approval-gated runs leave `waiting_approval` only via `POST /v1/runs/:runId/approval`, then re-enter the relay queue under the same run key.
5. Cursor is service-side; a missed notification is never lost (runs live in the durable run store, the cursor only avoids re-sending). A `SERVICE_FAILED` mid-poll surfaces as `failed` health, never as a lost run.

Rationale: with polling owned by the service and dispatch owned by the panel, the panel's only job while open is to drain the relay; while the panel frame is not mounted (extension disabled, host quit), dispatch does not occur — which is the documented "unattended = OpenChamber running" boundary (constitution Security Standard 3), not a hidden background mechanism.

### Dispatch + agent-verification flow (decided)

```
service: delivery → re-fetch source (FR-026) → policy → run(created) [or waiting_approval / blocked]
panel:   long-poll relay → run + lease
panel:   preconditions re-check (binding active, projectId from listProjects() resolves)
panel:   host.startSession({ navigation:'preserve', projectId, worktree, providerId, id:<deterministic>,
                             title, url, kind, text:<bounded delimited excerpt>, data:{correlationId, runKey} })
panel:   POST /v1/runs/:runId/dispatch-result { leaseId, sessionId, sent, worktree, directory }  → verifying_agent
panel:   host.openSession(sessionId)                       // documented UI context switch — research.md §R3
panel:   await onSession() snapshot with id === sessionId (timeout 15 s) → snapshot.agent
panel:   POST /v1/runs/:runId/verification { leaseId, observedAgent, expectedAgent }
service: observed === expected → dispatched ; else / timeout / agent absent → blocked:agent-mismatch (fail closed)
```

- **Expected agent** = manifest integration setting `expected-agent` (kebab-case, `PANEL_ID`-valid), defaulting to `project-manager` when blank. The panel cannot read Session Defaults (001 research §b.8 — no settings writer, `onSettings` pushes only declared integration fields; *historical citation — see the note at the top of this file*), so the pin is *mirrored as configuration* and enforced post-dispatch per FR-029; a mismatch message tells the operator to align Settings → Session Defaults or the `expected-agent` field. *(**Source superseded 2026-09-28** by the owner's "empty the card entirely" ruling: the manifest setting is gone — 002 FR-041 re-cut, card = zero settings — and the baseline is now `expectedAgent` in `config.json`, read through `GET /v1/config`: 002 FR-029 as amended, field at 006 FR-100. The reasoning in this bullet (no settings writer ⇒ the value must be mirrored configuration, enforced post-dispatch) still holds; only the store changed.)*
- **`navigation: 'preserve'`** keeps the operator's current chat untouched during the (up to 180 s) creation call; the single context switch happens only at verification, which is the documented, spec-accepted switch (spec Assumption "Agent verification mechanics").
- **Deterministic attach id** `mt-run-<sha256(runKey) hex[0:24]>` (≤128 chars, `AttachIssueRequest.id`) is the crash-recovery key: if the panel dies between `startSession` and posting the result, on remount it reconciles via `listSessions(projectId)` → `items[].id/data` (documented fields, 001 research Host API) and completes the run instead of re-dispatching (FR-030).

### Port plan: spike polling panel → service

| Spike module | Fate | Notes |
| --- | --- | --- |
| `src/github.ts` (host.request path builder/parsers) | **Replaced** by `service/src/github.ts` | Service owns its own `fetch`, request headers (`If-None-Match`, `If-Modified-Since`), response headers (`ETag`, `Last-Modified`, `x-ratelimit-*`), `per_page ≤ 30` pagination, status handling. Pure payload accessors move to `shared/`. |
| `src/matching.ts` (identity matching, fail-closed) | **Ported shared** → `shared/matching.ts` | Pure functions; extended with the full trigger set (assignment, review request/assignment, mention token, case-insensitive). |
| `src/evidence.ts` | **Replaced** by service `Delivery` normalization (event contract) | Panel no longer persists provider facts; `assertRedacted` discipline moves to the service store writer. |
| `src/ledger.ts` + `src/ledger-repair.ts` | **Replaced** by service audit/append store; panel keeps a **bounded display mirror** in `host.storage` | FR-034: UI state only; audit home is service-owned (FR-033). |
| `src/redaction.ts` | **Extended, shared** → `shared/redaction.ts` | Guards every panel-rendered surface *and* every service-written log/audit detail (NFR-004). |
| `src/config.ts` | **Extended** | Panel keeps UI-level settings parsing (expected-agent, filters); polling/binding/policy config moves to service-owned `config.json` + `GET/PUT /v1/config`. |
| `src/session.ts`, `src/host-verify.ts` | **Extended** | StartSession request builder + result capture stay; verification grows the `openSession`/`onSession` observer and lease reporting. |
| `src/panel-dispatch.ts` | **Extended** | Adds run lease, deterministic attach id, bounded excerpt builder (≤4,000/item, ≤12,000/dispatch, delimiters), worktree `{number}` substitution, crash reconciliation. |
| `src/panel-actions.ts` | **Rewritten around the service client** | Poll/direct-GitHub actions deleted; relay drain, handoff, binding, approval, verification actions added. Actions remain non-throwing, ledger-recorded (now mirror-recorded). |
| `src/project-picker.ts`, `src/project-actions.ts` | **Extended** | Reused verbatim for the binding flow's project step (account → project → triggers), plus `project_missing` recovery copy. |
| `src/app.ts`, `src/panel-ui.ts`, `src/panel-state.ts` | **Extended** | Tabs: Setup / Accounts / Repositories / Runs / Health / Policy; empty-state checklist (AC-019); unsupported-surface banner (AC-017). |
| `src/lifecycle.ts` | **Kept (panel tier)** + service lifecycle reporting | Panel mount/teardown markers stay; service lifecycle comes from `serviceStatus()` + `/v1/status`. |
| `src/ids.ts`, `src/json.ts` | **Ported shared** | Correlation ids and typed JSON helpers used by both halves. |
| Tests (`tests/*.ts`, 229 passing) | **Kept and extended** | Existing suites stay green; service suites and contract suites are added alongside. |

### Project structure (decided — extension root stays)

```text
extension/                          # one installable folder (absolute path install, spike-verified)
├── package.json                    # manifest: panel + integration + contributes.service; build scripts
├── panel/
│   ├── index.html
│   ├── main.ts                     # panel entry (IIFE build output: main.js, committed)
│   └── main.js                     # built classic IIFE
├── src/                            # panel TypeScript (as today, extended)
├── shared/                         # pure modules imported by BOTH bundles (no host, no node imports)
│   ├── ids.ts  json.ts  redaction.ts  matching.ts  events.ts (delivery/run keys)  types.ts
└── service/
    ├── main.ts                     # service entry (ESM build output: service/main.js, committed)
    ├── main.js                     # built ESM (ship built JS)
    ├── server.ts                   # loopback http server + auth + routing + limits
    ├── routes/                     # accounts, bindings, dispatches, runs, config, health, audit
    ├── store/                      # data dir, atomic JSON, NDJSON audit, retention
    ├── github.ts                   # outbound client (headers, ETag, rate, backoff)
    ├── poller.ts                   # scheduler, per-stream cadence, budget controller
    ├── policy.ts                   # autonomous defaults, gates, decisions
    └── audit.ts                    # append-only entries, correlation, redaction metadata
tests/                              # vitest (repo root) — panel suites + service suites + contract suites
    ├── support/                    # existing panel doubles + new fake service + fixture GitHub
    └── service/  contract/
specs/002-agent-event-extension/    # this artifact set
```

**Structure decision**: single package, two build targets. The manifest ships from `extension/package.json` (folder install of the absolute `extension/` path is the only install that worked — `spike-evidence.md` §4.1). Root `npm run build` builds panel + service; root `npm run verify` (build, lint, typecheck, test) covers both because `tsconfig.json` `include` gains `extension/service/**` and `extension/shared/**`.

### Stack decisions and why (verified against GUEST_SERVICES.md)

1. **Node stdlib, no framework** — the host spawns `service/main.js` with the app runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE`); global `fetch` exists on Node ≥20 (engines `>=20.19.0`). A framework adds supply-chain surface for a ≤15-route loopback API; constitution Principle V favors minimal self-hosted deployment.
2. **No native modules (no SQLite driver)** — native addons are compiled against a specific ABI and would need rebuilds inside Electron's runtime. JSON + NDJSON with atomic writes is ample for <10 repositories, bounded by explicit retention (FR-035) and read-through caches.
3. **Ship built JS** — "Ship `service/main.js` already built. Same packaging rule as `panel/main.js`" (GUEST_SERVICES.md); the bundler's `--node` flag keeps ESM (bundle-guest.ts: "A local service runs under Node, so `--node` keeps ESM").
4. **Long-poll relay instead of 2 s chatter** — bounded by the documented 20 s leg timeout; keeps panel CPU idle and needs no undocumented push.
5. **Leases instead of trusting the panel** — idempotency (NFR-002, FR-030) must be enforced where state is durable (service), with the panel's deterministic attach id as the reconciliation backstop.
6. **Service-owned policy/runs/audit** — panel frame lifetime is not guaranteed (001 §b.7), `host.storage` is uninstall-wiped (§b.6), and constitution v1.3.0's durability standard names audit/checkpoints/runs explicitly.

### Configuration and defaults

| Setting | Default | Bounds | Tier |
| --- | --- | --- | --- |
| Poll interval | 60,000 ms | 15,000–300,000 ms | service |
| Overlap window | 10 min | 1–120 min | service |
| `per_page` | 30 | ≤30 (leg + 001 §a.5) | service |
| Untrusted excerpt | 4,000/item, 12,000/dispatch | ±50% tunable (spec Assumption) | shared builder |
| Audit retention | 180 days / 50,000 entries | configurable; minimal refs until binding deletion | service |
| Payload excerpts | 30 days | configurable | service |
| Expected agent | `project-manager` | non-empty (≤80 chars, format-checked) | panel setting (`expected-agent`) — **superseded 2026-09-28: service configuration `expectedAgent` (006 FR-100), read via `GET /v1/config`** |
| Worktree option | `generated` per binding | `none \| generated \| new:<branch>` (`{number}` placeholder) | service binding |

*Cleanup note (2026-09-28): since `spec.md` v1.6.0 (FR-041) the manifest card carried `expected-agent` as its only panel-tier setting — **and, since the owner's card-emptied ruling the same day (002 FR-041 re-cut), the card carries nothing at all**, that row's tier moving to service configuration — the row above is the one setting that had a panel tier, and every other row is service- or binding-tier exclusively; the card's former `repository`, `expected-login`, `project-id`, `worktree-option`, and `poll-interval-ms` fields, and every `MECHA_TURK_*` environment knob, are removed (006 FR-091, FR-092).*

**Rate arithmetic (FR-022 / NFR-003, decided cadence)**: three discovery streams per repository (`issues` — assignments + issue comments anchor; `issue_comments` — mentions; `pulls` — review request/assignment + head SHA), each `per_page ≤ 30`. Default cadence polls every stream every interval: 10 repos × 3 streams × 60 ticks/h = 1,800 requests/h *attempted*; conditional requests return **304 at no primary-limit cost** (001 §a.3/§a.4), and the per-account **budget controller** de-prioritizes the mention stream (every 2nd→3rd tick) whenever projected non-304 usage would exceed 1,500/h (30%) — bringing worst case without 304 support to 10 × (60 + 60 + 20–30) ≈ 1,400–1,500/h. Detection p95 ≤ 2× interval holds under normal conditions (NFR-001); under budget pressure the delayed stream is surfaced in health rather than silently missed (NFR-009). Correctness never depends on 304s (AC-010).

## Constitution alignment (v1.3.0)

| Principle / standard | How this plan satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | Outbound HTTPS polling with versioned adapter boundaries (GitHub client, panel↔service transport) and contract tests; webhooks stay a future adapter (NFR-010). |
| **II. Safe autonomy** | Autonomous-by-default bounded by per-action gates; fail-closed on missing policy, unresolved project, identity mismatch, credential failure (FR-024/FR-027); no GitHub writes, no merge/deploy under any setting (FR-031/FR-032). |
| **III. Durable and idempotent** | Service-owned checkpoints, delivery keys, deterministic run keys, single-use dispatch leases, attach-id reconciliation; replay tests (100×) are tasks, not aspirations. |
| **IV. Human-visible auditability** | Append-only correlation-id audit trail owned by the service; every run shows source link, policy decision, state, correlation id; secrets never in logs (redaction is executable, not promised). |
| **V. Minimal, self-hosted deployment** | One extension folder + one host-spawned local service, no container requirement, no hosted control plane, stdlib-only service, portable across conforming OpenChamber installs (v1.3.0 wording quoted, not the retired container phrasing). |
| **VI. Spec before implementation** | This plan + research + contracts land before any code; the token-handoff security review is task one. |
| **VII. Thin orchestration boundary** | Panel and service both stay orchestration; projects, worktrees, sessions, agents remain host-owned; no private routes, no per-call agent selection. |
| **Security Std 3 (unattended dependency)** | Polling/dispatch stop with OpenChamber/extension/service; surfaced as health, never masked (FR-036). |
| **Security Std 4 (durable storage)** | Audit/checkpoints/runs live in the service store outside `host.storage`; uninstall survival is an explicit verification task with a live gate before any user-facing claim. |
| **Quality gates** | Strict TS + lint with zero suppressions (no `eslint-disable`, no `@ts-ignore`, no `any`), pinned SDK, capability-checked adapters, unit/contract/E2E tests per task. |

**No constitutional violations → no complexity-tracking rows.**

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agent read requires a UI context switch (`openSession`) | Verified as the only documented mechanism at 1.24.2 (research §R3); switch is explicit, after dispatch, fail-closed on timeout; documented in quickstart |
| `OPENCHAMBER_DATA_DIR` not passed to the service env | Store resolves the documented default (`~/.config/openchamber/mecha-turk`); path is exposed in health and documented for backup; custom-dir operators are told where the store is (research §R2) |
| Uninstall survival of the audit store is *expected, not proven* | Spec MUST item → dedicated live verification task before any user-facing claim (tasks T-033) |
| Panel frame not mounted → no dispatch | By design (documented boundary); relay holds runs durably; service keeps polling and checkpoints; panel drains on next mount |
| Crash between `startSession` and result post | Deterministic attach id + `listSessions().items` reconciliation before any re-dispatch (T-023) |
| Leg response cap (256,000 chars) truncation | Every list endpoint paginates with explicit cursors and a size guard in the service client |

## Artifacts

```text
specs/002-agent-event-extension/
├── plan.md                      # this file
├── research.md                  # NEW research only (R1–R9), sources stamped
├── data-model.md                # both storage tiers, states, constraints
├── contracts/
│   ├── panel-service.md         # HTTP contract: endpoints, auth, limits, errors
│   ├── token-handoff.md         # SECURITY-GATED flow (security-auditor review is T-001)
│   ├── events-carry-forward.md  # pointer + versioning note for 001 events.md
│   ├── binding-allow-list.md    # NEW 2026-10-03: `allowedUsers` on the bindings grant
│   └── README.md                # index and supersession pointers
├── quickstart.md                # dev/build/test/install walkthrough
├── pm-handoff.md                # orchestration record (superseded 2026-10-03; see the note)
└── tasks.md                     # 35 MVP tasks (delivered) + the issue-#9 block (Wave 9)
```

---

# Amendment record — 002 v1.11.0 (2026-10-03): the per-repository actor allow-list

> **This section is a dated Phase-4 record added on 2026-10-03.** Everything
> above it is the plan of 2026-09-27 and is retained as written. Nothing above
> this line is re-cut: the v1.11.0 amendment is **additive** (FR-043 – FR-048,
> NFR-011, SC-008, AC-024 – AC-027) and re-cuts no existing requirement, no
> wire path, and no stored member's shape. This record plans **002's half only**
> — the model and the field's validation. The **gate** is
> [`003-dispatch-integrity/plan.md`](../003-dispatch-integrity/plan.md)'s
> (003 v1.8.0) and the **rendering** is
> [`005-panel-ia/plan.md`](../005-panel-ia/plan.md)'s (005 v1.11.0), because
> each of those documents already owns the surface in question and this project
> has never let one feature re-specify another's.

## A.1 Scope of 002's half

| Requirement | What 002 builds | Where |
| --- | --- | --- |
| FR-043 | `actorLogin` + `actorAttribution` on the normalized event's base snapshot; additively versioned event contract **1.2** | `service/poll/events-write.ts`, `service/poll/events-parse.ts`, `contracts/events-carry-forward.md` |
| FR-044 | the closed two-value attribution basis; `direct` for comment- and issue-body mentions, `subject-author` for `assignment` and `review` | `service/poll/events-write.ts` (`actorAttributionOf`), `service/poll/triggers.ts`, `service/poll/loop.ts` |
| FR-045 | attribution is mandatory and fail-closed for **all four** kinds; `isBotAuthor` reused; the unreadable-author check beside it given a name and an export; `PollPull.authorLogin`/`authorType` added | `service/poll/triggers.ts`, `service/poll/poller-entries.ts`, `service/poll/loop.ts` |
| FR-046 | the actor **never** enters `buildEventId` | unchanged code, pinned by a byte-identity test |
| FR-047 | `BindingRecord.allowedUsers?: string[]` — three states, case-insensitive comparison, `[]` a refusal, validated on **every** read and write | `service/bindings.ts`, `service/routes/bindings.ts` (unchanged — see D4), `contracts/binding-allow-list.md` |
| FR-048 | one repository per binding, retained; no plural, no wildcard | no code — enforced by the existing single `repository` field; pinned by a test |
| NFR-011 | attribution honesty is **record shape and copy**, not just data | `actorAttribution` is a closed union the parser refuses; the panel's wording is 005's |

**Not 002's**: deciding whether a run may dispatch (003 v1.8.0's `dispatch-authorize.ts`),
rendering any of it (005 v1.11.0), and the audit vocabulary (003's).

## A.2 Module map delta (002's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `service/bindings.ts` | `BindingRecord.allowedUsers?: readonly string[]`; a fifth field reader `bindingAllowedUsersOf`; wiring in `assembleBinding` and in `parseBinding`'s collect-every-refusal second pass; exported `isActorAllowed(login, allowedUsers)` as **the one** membership comparison in the codebase | FR-047 |
| `service/poll/poller-entries.ts` | `PollPull.authorLogin` / `PollPull.authorType`, read from the pulls-list entry's `user` exactly as `readIssueEntry` / `readCommentEntry` do | FR-045 |
| `service/poll/triggers.ts` | `isMentionableAuthor` **exported and renamed** to `isAttributableAuthor` (one predicate, four kinds); `PollPull` gains the author gate on the review path; every event builder sets `actorLogin` + `actorAttribution` | FR-043 – FR-045 |
| `service/poll/loop.ts` | the `assignment` event builder sets the actor from `PollIssue.authorLogin` with basis `subject-author`, and drops an unreadable or bot-authored subject | FR-044, FR-045 |
| `service/poll/events-write.ts` | `BaseEventSnapshot` gains `actorLogin` + `actorAttribution`; `createEvent` copies them onto the row. **`buildEventId` and `discriminatorOf` untouched** | FR-043, FR-046 |
| `service/poll/events-parse.ts` | `QueuedEvent.actorLogin?: string` and `QueuedEvent.actorAttribution?: ActorAttribution` — **absentable**, both validated when present (an unrecognized basis refuses the row) | FR-043, 002 FR-024 |
| `service/routes/bindings.ts` | **no change** — see D4 | FR-047 |
| `contracts/events-carry-forward.md` | title → `v1 → v1.1 → v1.2`; a `schemaVersion 1.2` table | FR-043 |
| `contracts/binding-allow-list.md` | **new** — the field's whole wire contract, on 004's `binding-prompt.md` as template | FR-047 |
| `contracts/panel-service.md` | §2.3 gains one additive row for the member | FR-047 |

## A.3 Key decisions — actor allow-list (added 2026-10-03)

> Numbered `D1…D9` inside this amendment block. They do not continue the
> "Stack decisions and why" list above (that list is 1–6 and belongs to
> 2026-09-27); they are this amendment's own, exactly as 003's and 005's plans
> carry their own `D`-series.

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **D1** | **`schemaVersion 1.2` is a contract-document version, not a stored member.** `events.json` rows gain `actorLogin` + `actorAttribution`; nothing gains a `schemaVersion` field, and `SERVICE_SCHEMA_VERSION` stays `1`. | The shipped event row has **no** version member (`service/poll/events-parse.ts`), so "the normalized-event schema is versioned additively to `1.2`" is a statement about `contracts/events-carry-forward.md`, which is where every prior version bump (1 → 1.1) is recorded. Adding a stored `schemaVersion` would make every pre-existing row fail its own version check, which quarantines the whole file on upgrade — precisely the migration the product owner ruled out on 2026-10-03. 003 set the precedent for the store marker: "a format this build understands" (data-model §2.6), and an additive field is not a new format. | A stored `schemaVersion` per row (fail-closed at the store boundary on every pre-existing row — a migration by side effect); bumping `SERVICE_SCHEMA_VERSION` (would report two different values for identical stores). |
| **D2** | **The two actor members are absentable on the stored row and validated when present.** An unrecognized `actorAttribution` refuses the row; an absent one reads as *no attribution was recorded*. | 002 FR-043 requires both "validated on write and on read like every other member" and that "no existing member changes shape". A required member would fail every pre-existing row at parse time — D1's migration-by-side-effect again. The fail-closed duty lands at the **gate** instead: 003 FR-080 refuses a run whose references carry no readable actor, so absence is never read as permission. | Requiring both members (quarantines `events.json` on upgrade); defaulting an absent basis to `direct` (invents causation 002 FR-044 forbids). |
| **D3** | **One predicate, four kinds: `isAttributableAuthor(login, type)` replaces the module-private `isMentionableAuthor` and is exported.** | FR-045(a) extends the *existing* judgement to all four kinds "by the two judgements this product already applies… reused rather than reinvented". Two names for one rule is two rules that drift — the exact defect class 003 exists to end. The export is deliberate and is named here because the task that introduces it must not have to re-derive that it may leave `triggers.ts`' surface. | Keeping `isMentionableAuthor` private and adding a sibling for assignment/review (two spellings of one judgement); putting the check in `loop.ts` (the assignment path would then own authorship, splitting it across two modules for one rule). |
| **D4** | **`allowedUsers` rides the whole-file grant with **omission meaning unset**, not 004's omission-preserves.** The route needs **no change**: `parseBinding` treats an absent member as absent and `mergePrompts` only ever touches `startingPrompt`, so a submitted row without the key stores without it. | This is the one place the two amendments interact with no explicit ruling, so it is decided here and flagged for the gate. A login list is **enumerable** — the panel always knows it and can always state it — while a free-text prompt is genuinely ambiguous between "untouched" and "cleared", which is the whole reason 004 FR-014 preserves it. Under omission-preserves there is **no wire value that can express unset**: `[]` is a refusal (FR-047), `null` and `''` are forbidden by FR-047, and an absent key would preserve. A configured list would therefore be impossible to remove — a worse defect than the hypothetical erasure. See the flagged item in the handoff. | Extending 004 FR-014's omission-preserves to the new field (leaves unset unreachable, so the FR-047 refusal's own remediation — "remove the field" — becomes unactionable); a `policyMode` companion enum (002 v1.11.0's own entry already rejects it: it makes "restricted with nobody in it" a valid, quiet state). |
| **D5** | **`allowedUsers` is validated on the stored spelling and compared case-insensitively; no lowercasing, no trimming, no de-duplication on read.** | AC-026 requires `['Alice','bob']` to "save and read back **byte-identically** while matching `alice`, `ALICE`, and `Bob`". A stored spelling change would break that assertion. GitHub logins are case-insensitive, and this document's own mention token already folds case (FR-015). | Normalizing to lower case on write (breaks byte-identity); rejecting duplicates or surrounding whitespace as separate refusals (each is an unnamed refusal, and both are harmless: a duplicate changes no answer, and whitespace around a login GitHub never issues is a typo the gate fails closed on anyway). |
| **D6** | **No new refusals beyond the three FR-047 states, and **no list-length cap**.** The refusals are: not an array; an explicitly empty array; an element that is not a GitHub-shaped login. | FR-047 states "exactly three states and no fourth" and names the empty array as the one refusal; adding a length cap would be an unnamed refusal the operator can hit through no fault of their own. Boundedness is already carried by three existing bounds: the per-login length bound (research §R8), `MAX_BINDINGS = 100`, and the transport's own body cap. | A `MAX_ALLOWED_USERS` cap (an unnamed refusal; 100 bindings × 50 logins is 20 KB against a 60,000-character leg, so nothing unbounded is reachable). |
| **D7** | **A `[bot]` login is accepted into the list and is inert; it is not a refusal.** | FR-045(c) and the `## Out of Scope` bullet are *capability* statements — "no bot event exists to be admitted", "bots are filtered at detection for every trigger kind" — and the detection-time filter is where the exclusion already lives. AC-025's own wording is the consequence form ("**cannot cause a bot event to be created, because none is**"), which is satisfied without a validator rule. Accepting it adds no refusal the specs do not name. | Refuse `[bot]` logins at save (adds a refusal FR-047 does not name, and FR-047's remediation vocabulary would grow a fourth clause; also risks refusing a legitimate human login that merely contains the substring). **Flagged**: if the owner reads FR-045(c) as a *validator* rule rather than a capability statement, D7 inverts and the refusal set grows by one — a one-line change with one extra test. |
| **D8** | **The actor is bounded by the module's existing `AUTHOR_LOGIN_MAX_CHARS = 60`, not by a new constant.** | The value already bounds exactly this string in exactly this module (`triggers.ts`' `mentionEvent` trims the commenter with it). A second bound for the same field in the same file is two answers to one question. | A tighter GitHub-login bound on the stored actor (would truncate a real login on a legal-but-long one, producing an attribution that silently stops matching). |
| **D9** | **One comparison helper, exported from the validator's module: `isActorAllowed(login, allowedUsers)`, called by 003's gate and by nothing else.** | FR-076 forbids a second membership comparison anywhere in the product, and FR-090 forbids a client-side copy of the rule. One exported predicate in the one module that owns the field is what makes that provable rather than aspirational — the proof is a scan asserting the helper's identifier appears in exactly two files (its own, and `dispatch-authorize.ts`). | Inlining `some(u => u.toLowerCase() === login.toLowerCase())` at the call site (a second implementation the specs explicitly refuse); a generic "policy matcher" abstraction (one predicate, one caller pair — an abstraction with no second use). |

## A.4 Constitution alignment (v1.3.0) — carried forward, re-read for this amendment

> The feature specs already record their constitutional alignment and the
> product owner approved it at the gate; this table restates it for 002's half
> rather than re-litigating it. **No principle is weakened; one is strengthened
> (III) and one is applied harder than before (II).**

| Principle / gate | How this amendment satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | The contract limitation that forces `subject-author` (GitHub's list feeds expose `assignees` and `requested_reviewers`, never the actor) is **recorded as a contract limitation** with its source (research §R8), not papered over; the event contract versions additively to 1.2 exactly as 1.1 did. |
| **II. Safe autonomy by default** | The field exists for this principle. It does not weaken it in the one place it could: the **absent** state. Absent is a complete, valid, *discoverable* state (005 FR-092/FR-093 render it with a worded warning and a counted Status line), so "is this repository protected?" is never ambiguous. 002's own validator refuses the one ambiguous input (`[]`). |
| **III. Durable and idempotent work** | **Strengthened.** FR-046 keeps the actor out of `buildEventId`, so a re-detected event is still one event and a changed allow-list can never manufacture duplicate work. |
| **IV. Human-visible auditability** | Served twice: `actorAttribution` exists at all, so a row never records a guess as a fact (NFR-011); and the gate **records a refusal** rather than dropping anything silently (003 FR-077). |
| **V. Minimal, self-hosted deployment** | No new process, dependency, container, capability, or permission; no new store file; no new endpoint. |
| **VI. Specification and verification before implementation** | Why this is an amendment plus AC-024 – AC-027 and named tasks, rather than a code change. |
| **VII. Thin orchestration boundary** | No host capability, no host call, no change to `host.startSession()` framing. |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any` (invariant 7); offline deterministic suites per task; `npm run verify` at every wave boundary; committed bundles rebuilt with every source change (invariant 1). |

**`AGENTS.md` non-negotiable invariants — how 002's half touches each of the ten.**

1. **Committed bundles ship** — every task in the block that changes `service/*.ts` ends with `npm run build` and the rebuilt `service/main.js` committed in the same commit (A-task wave boundary).
2. **One document, two roles** — no `version` bump; `0.0.1` stands (a bump is a product-owner release decision). 3. **Capabilities** — untouched; `capabilities[]` stays `["sessions","prompt"]` and `contributes.service` gains no `permissions`. 4. **Kebab-case identity** — untouched; no storage key is added, renamed, or read. 5. **`SERVICE_VERSION`** — untouched, still pinned by `tests/service-server.test.ts`. 6. **SDK pin** — untouched. 7. **Zero suppressions, zero `any`** — binding to every task's gate; a new field type is `readonly string[]`, not `any`. 8. **Fail closed** — the load-bearing change: `allowedUsers` is validated on **every** read and write, `[]` is a refusal, and an unrecognized `actorAttribution` refuses a stored row. 9. **Secrets never leave the service store** — a GitHub login is public repository identity, **not a secret**; the permitted list lives only in `bindings.json` (0700/0600) and must appear in no audit row, run record, projection, ledger, `host.storage` value, or bundle (NFR-113; 003's proof task owns the scan). 10. **`extension-spike-1` is a wire contract** — untouched: the evidence schema version and the evidence record are not part of this feature, and the **event id format is explicitly not changed** (FR-046).

## A.5 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| Adding members to the delivery row breaks a byte-identity assertion elsewhere (the ledger, the claim projection, `tests/service-events.test.ts`) | the members are **additive and absentable** (D2), and the wave-1 tasks' own gates include the untouched existing suites; `buildEventId` has an explicit byte-identity test (FR-046, AC-027) |
| Attribution is added to `mention` and forgotten on `assignment`/`review` | D3's single predicate and one exported surface; the wave-1 proof task drives **all four** kinds and asserts the basis of each (AC-024) |
| `PollPull.authorLogin` is `''` for most repos' pulls in practice | that is exactly FR-045(b)'s case: **no event**, dropped as non-actionable — not an empty actor. The proof task seeds an authorless PR and asserts zero events |
| The gate reads `bindings.json` on a path that did not read it before (003's NFR-114 letter) | **flagged to the gate**; 003's plan records the reading adopted and the alternative. 002's half adds no read of its own |
| A stored `allowedUsers: []` arrives from a hand edit and takes the whole bindings document out of service | that is **intended**: FR-047 makes it a refusal on read, and `bindings-read.ts` quarantines-with-a-log rather than fail-stuck, so the other bindings still read. Recorded here so the behaviour is expected rather than discovered |

## A.6 Out-of-scope guard for the issue-#9 block (checked at every task)

No enforcement of the list anywhere in 002's files — the gate is 003's
(`dispatch-authorize.ts`), and a membership comparison in `triggers.ts`,
`loop.ts`, or the route would be a second answer to the same question (D9).
No audit row, no `blocked:` state, no `dispatch.refused` detail — 003's. No
panel rendering — 005's, except the bindings parser's new member. No
`FieldDescriptor` in `config.json` (006 is deliberately not amended). No
per-binding `PATCH /v1/bindings/:bindingId` (recorded MVP-DEBT, not reopened).
No migration, shim, fallback, or legacy default — the product owner ruled it
directly, and a stored binding without the key **is** the absent state. No
change to `buildEventId`, to `SERVICE_SCHEMA_VERSION`, to `SERVICE_VERSION`, to
any storage key, to any capability, or to the SDK pin. No bot admission. No
plural or wildcard `repository`. No shared/reusable list object.

## A.7 Phase-6 task block for this amendment

Consolidated across the three amended specs in
[`tasks.md`](./tasks.md) §"Issue #9 block (2026-10-03)", where the wave graph
and the routing recommendation live. 002's own tasks are `A-1 … A-7`.

---

# Amendment record — 002 v1.13.0 / v1.13.1 (2026-10-05): the binding's history scope (GitHub issue #22)

> **This section is the dated Phase-4 record for the binding history scope**
> (written 2026-10-05 against `spec.md` v1.13.1, approved the same day). Everything
> above this line is the plan of 2026-09-27 plus the v1.11.0 amendment of
> 2026-10-03 and is retained as written; nothing above is re-cut. The amendment
> is **additive** (`FR-053 – FR-094`, `NFR-012`, `NFR-013`, `SC-009 – SC-013`,
> `AC-032 – AC-043`) and re-cuts no existing requirement number — but it **does
> retire one behaviour**: the scan window with no lower bound stops being a window
> source, and `002 FR-051`'s and `006 FR-059(a)`'s "a binding with no recorded
> stamp replays everything" clause ends with it.
>
> **Decisions are numbered `H1 … H14`** and do not continue the `D1 – D9` series
> above, which belongs to the v1.11.0 amendment; `D` also collides with the
> `D-1 … D-12` task ids, and two decision series that differ by one character are
> worse than either. Nothing below is an open option pair except where §B.4 says so.

## B.1 Scope of 002's half, and what is *not* in it

| Requirement | What 002 builds | Where |
| --- | --- | --- |
| FR-053 – FR-060 | the member, its ownership, its read and write paths, absence-as-default, the look-back constant, and the proof that no stored state asks for an unbounded window | `service/bindings-history-scope.ts` (new), `service/bindings.ts`, `service/routes/bindings.ts`, `data-model.md` |
| FR-061 – FR-063 | one two-name rule set, refused whole, with `null` read as cleared; the panel's fail-closed read of an unusable member | `service/bindings-history-scope.ts`, `src/bindings-service.ts`, `src/bindings-*` |
| FR-064 – FR-072 | the window rule itself: a real lower bound in every state, a retained baseline, no new surface, fail closed on an unresolvable baseline | `service/poll/window.ts`, `service/poll/scan.ts`, `service/poll/loop.ts` |
| FR-073 – FR-078 | the durable distinction between "never scanned" and "cleared to recover", its survival across an incomplete scan, and its visibility | `service/poll/scan.ts`, `service/poll/events.ts` (the recovery reset), `service/routes/events.ts` |
| FR-079 – FR-085 | the bounded sweep, its one-shot construction, FR-023's one rescan mechanism and FR-084's single caller, and FR-085's nothing | `service/poll/window.ts`, `service/poll/loop.ts`, `service/routes/bindings.ts` |
| FR-086 – FR-088 | one audit row per change in the `binding.` prefix, and the four things this section does **not** add | `service/bindings-history-scope.ts` (observer) or a sibling, `service/routes/bindings.ts` |
| FR-089 – FR-094 | the operator's surface | the panel's `src/bindings-*` and `src/status-*` modules |

**Not 002's**, and deliberately: any **general operator-chosen-timestamp rescan
surface**, its input, or its route (`spec.md` `## Out of Scope`, recorded as
named debt; 002 `research.md` §R10.2b found that no such surface exists in
`service/routes/` and never has). 002 builds the **mechanism** FR-023 requires and
**only the caller FR-084 names**. Any change to 005's other tab surfaces, to 003's
gate, to the audit lifecycle vocabulary, to `buildEventId`, or to any
configuration field. The two documents downstream that record the delta — 005's
changelog for the editor's control and 006's for the two requirements that now
resolve differently — are theirs.

## B.2 Project structure delta

No file moves, no file is added outside the two named below, and **no store file
is added**: the durable facts join the scan state the product already keeps.

```text
service/
├── bindings-history-scope.ts   # NEW — the two names, the reader, the look-back constant + bound
├── history-scope-audit.ts      # NEW — the change observer, riding the existing observation chain
├── bindings.ts                 # the member, the assembly wiring, the second-pass reader, the honest creation-stamp reader
├── bindings-read.ts            # one more reader: the stored creation stamps, read only when a baseline is needed
├── poll/
│   ├── scan.ts                 # the per-binding slot gains three members; the parser validates each independently
│   ├── window.ts               # windowFor's return type changes; the "no window admits everything" arm is deleted
│   ├── events.ts               # the recovery reset writes the forced-replay flag instead of inferring one
│   └── loop.ts                 # consumes the armed rescan, clears it on completion, keeps it on failure
└── routes/
    ├── bindings.ts             # omission-preserves merge, the read-path default, the FR-084 arming, the observer call sites
    └── events.ts               # the status row gains the window in force, the mode, and the flag
src/                            # bindings-service.ts (fail-closed reader), bindings-draft/editor/rows (the control)
tests/                          # history-scope.test.ts (new), plus the existing bindings, scan-state, events, status suites
```

**Two new modules and why two.** `bindings-history-scope.ts` is the *vocabulary* — two names, one
reader, one constant, no store and no audit dependency, exactly the shape `bindings-allow-list.ts`
has. `history-scope-audit.ts` is the *observer* — store, audit and chain dependencies, the shape
`prompt-audit.ts` has. Keeping them apart is what lets the vocabulary be finished in one task and the
observer in another without either editing the other's file (task bands 2 and 3 in
[`tasks.md`](./tasks.md)).

**One documented divergence, stated rather than fixed.** `data-model.md` §Checkpoint
models checkpoints per `(account, repository, stream)`; the shipped store is **one
slot per binding** in `scan-state.json` (`service/poll/scan.ts`, `BindingScanState`).
The three new durable facts are all **per binding**, so they follow the **shipped**
representation. `data-model.md` already carries the `forceReplay` row from Phase 3;
the two members decided below add their rows in the same table.

## B.3 Module map delta (002's files only)

| Module | Change | Requirements |
| --- | --- | --- |
| `service/bindings-history-scope.ts` **(new)** | the closed union `'new-only' \| 'recent-history'`, `DEFAULT_HISTORY_SCOPE`, the two-name reader `historyScopeOf(raw)` returning `{ scope } \| { issue }`, and the look-back constant **with its own bound** | FR-053, FR-059, FR-061, FR-062 |
| `service/history-scope-audit.ts` **(new)** | the change observer: one `binding.history-scope-updated` row per change, seeded from the trail, on the existing observation chain | FR-086, FR-088 |
| `service/bindings.ts` | `BindingRecord.historyScope?`; wiring in `assembleBinding` (absent → key **omitted**) and in `parseBinding`'s collect-every-refusal second pass; one exported reader for the **stored** creation stamp | FR-053, FR-056, FR-058, FR-061, FR-062, FR-072 |
| `service/bindings-read.ts` | one more reader over the same file, carrying each binding's **stored** creation stamp as stored (`null` for absent, `null` for present-but-unreadable) | FR-072, §R10.4 |
| `service/poll/scan.ts` | the per-binding slot gains `baselineAt`, `forceReplay`, `rescanFrom`; each validated **independently**; a pre-amendment file still parses; one writer per fact | FR-018, FR-023, FR-074, FR-076 |
| `service/poll/window.ts` | `windowFor` returns a **verdict** instead of `string \| null`; `null` as a window source is gone, including the unreadable-stamp fallback; `stampInWindow` loses its `windowStart === null` arm | FR-065 – FR-069, FR-072 |
| `service/poll/loop.ts` | reads the mode once per binding per scan; the armed rescan is honoured and consumed; the sweep stays enqueue-only | FR-068, FR-070, FR-071, FR-080 – FR-085 |
| `service/poll/events.ts` | the recovery reset **writes** the forced-replay flag instead of producing a state no reader can distinguish from "never scanned" | FR-073, FR-074, FR-076 |
| `service/routes/bindings.ts` | omission-preserves merge; the read answer carries the documented default for a binding that stores no member; the change observer's two call sites; **FR-084's arming** | FR-055, FR-057, FR-084, FR-085, FR-086 |
| `service/routes/events.ts` | the per-binding status row gains the window start in force, the mode in force, and the forced-replay flag | FR-036, FR-092 |
| `service/routes/bindings.ts` | omission-preserves merge; the read answer carries the documented default for a binding that stores no member; **FR-084's arming** and FR-085's nothing; the change observer's two call sites | FR-055, FR-057, FR-084 – FR-086 |
| `contracts/binding-history-scope.md` | **written in Phase 3**; the proof suite's 22 rows are the acceptance surface | FR-053 – FR-094 |
| `data-model.md` | rows for `baselineAt` and `rescanFrom` beside the `forceReplay` row Phase 3 added | FR-066, FR-074, FR-023 |
| `src/bindings-service.ts` | the bindings answer's `historyScope` read fail-closed; the status row's three new members | FR-063, FR-036, FR-092 |
| `src/bindings-draft.ts`, `bindings-editor.ts`, `bindings-rows.ts` | the one control, its guidance, and the permitted row label | FR-089 – FR-094 |
| `service/config.ts` | **untouched.** The look-back is not in `NUMERIC_BOUNDS`, so the twelve-field count does not move | FR-059 |

## B.3a Execution shape (mirrored in `tasks.md`)

Five internal bands, and **only** the bands are parallel: `D-1 ∥ D-4 ∥ D-11` → `D-3 ∥ D-5` →
`D-2 ∥ D-7 ∥ D-8` → `D-6 ∥ D-9` → `D-10 ∥ D-12`. Three file-ownership rules hold it together, and each
exists because a draft task would otherwise collide: `D-5` touches `poll/window.ts` only (the
`loop.ts` call site that consumes the verdict is `D-6`'s); `D-3` adds a module and no route edit;
`D-10` owns `tests/history-scope.test.ts` alone while `D-12` extends only existing suites. The full
table, the reasoning, and the routing recommendation are in
[`tasks.md`](./tasks.md) §"Wave 4 — 002 v1.13.0".

## B.4 Key decisions — the history scope (added 2026-10-05)

| # | Decision | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| **H1** | **The field's vocabulary lives in one new module, `service/bindings-history-scope.ts`, mirroring `service/bindings-allow-list.ts`.** `bindings.ts` imports its reader exactly as it imports `bindingAllowedUsersOf`. | The allow-list already established the precedent: two names, one rule set, one refusal vocabulary, one place to look. Putting the look-back constant in `bindings.ts` would mix a *field* with the *derived* constant, and `bindings.ts` is the assembly — the largest file in the pair. | Declaring everything in `bindings.ts` (no new file; the constant and the reader end up in the module that assembles records and nowhere near the window rule that consumes them). |
| **H2** | **The retained baseline is `baselineAt`, a member of the per-binding slot in `scan-state.json` — not a member of the binding record.** *This is Phase-4 gate item 1, decided.* | Scan state is where the product already keeps per-binding scan facts, it has **one** writer per fact, it is serialized on `serializeScan`, and it is **not reachable by any operator surface**. A binding record is the opposite on all three counts: `writeBindings` persists records verbatim, so a derived stamp there would land in the one file the panel rewrites on every save — needing a fourth omission-preserves merge, its own refusal rule, and a hand-edit hazard nobody asked for. The argument that the binding record is "what the operator's surface can read directly" does not survive contact with the requirements: `FR-092` asks the surface for the **window start in force**, which is *derived* from the baseline and is what actually gets reported, so the baseline itself never needs a direct read. `data-model.md` already put `forceReplay` on the checkpoint/scan side, so this also agrees with Phase 3. | A member on the binding record: an operator-editable document would carry a machine-written time authority, one hand edit away from re-arming a sweep (exactly R10.9's rejected `replayAt`), and every panel save would have to preserve a field the panel cannot render. |
| **H3** | **The baseline is derived from the **stored** creation stamp, read through one purpose-built reader — not from the assembled `binding.createdAt`.** An **absent** stored stamp falls back to the assembled stamp (a panel-created row legitimately has none); a **present but unreadable** one refuses (FR-072). | `assembleBinding` runs `stampOrKeep(raw.createdAt, nowIso())`, so the assembled stamp is `now` for both "no stamp was submitted" and "the stamp is corrupt". Deriving from it means FR-072's case silently becomes a window of `now − overlapMs`, and AC-038 has nothing to test. Reading the stored row is the only way to tell those two apart, and the codebase already has the precedent: 003's gate reads the live document through `readBindingsForAuthorization` because "a gate reading a stale policy is worse than no gate". Cost: one extra `readJson` **only in a cycle where some binding has no baseline yet**, so nothing in steady state, and it needs no new route, capability, or host call (FR-064). | Deriving from `binding.createdAt` and accepting that FR-072 is then unreachable for a corrupt `createdAt` (cheapest; **requires narrowing FR-072 and AC-038 to the recorded-stamp half**, which is a specification change and not a planning choice); refusing an unusable `createdAt` outright (a new refusal on a field this amendment does not otherwise touch, and it would quarantine the whole document when FR-072 asks for one binding to stop). |
| **H4** | **The forced replay is `forceReplay`, a boolean in the same slot, written by the recovery reset alone.** `lastScanAt`, `baselineAt`, `forceReplay` and `rescanFrom` are validated **independently** by `parseStoredScanState`, so a pre-amendment file parses and an absent stamp is never read as a flag. | FR-074 demands the two facts be "neither the same value nor inferred from one another". Four distinct members with three distinct types, one validator each, and one writer each is what makes that structurally true rather than a convention. `data-model.md` already fixed the name. | Inferring the replay from the cleared stamp — today's state, and precisely what FR-074 forbids; a `replayFrom` stamp beside `lastScanAt` (a second stamp that can disagree with the first, R10.9); an in-memory flag (works until any other reader of the file appears, then degrades silently into "never scanned"). |
| **H5** | **FR-023's one rescan mechanism is `rescanFrom`: a durable chosen lower bound for one binding's next scan, in the same slot.** *This is Phase-4 gate item 3, decided.* | FR-023's own words are "a chosen lower bound for one binding's next scan", so the mechanism **is** that member — one representation, one rule set, so a rescan cannot mean two things. Putting it beside the baseline rather than on the binding record keeps one file, one chain, and one place the window in force is computed from (which is also what `FR-092`'s health row reports). It is bounded by construction: a member that must hold a parseable stamp cannot ask for *everything* (FR-060). | Reusing `baselineAt` for the catch-up (it would overwrite the recovery baseline and change what a later recovery replay covers — the two have different jobs); a second file; on the binding record (H2 again). |
| **H6** | **The catch-up is armed only for a binding that has completed a scan.** A binding with no completed scan follows its own baseline, which the mode edit changes and which is the **wider** of the two bounds. | FR-084's own rationale is that an edit affecting only never-scanned bindings "would do nothing at all on any binding that has ever scanned" — the requirement is written for the has-scanned case. For a never-scanned binding, FR-066/FR-067's baseline already follows the current mode, and `createdAt − 7 days` is **wider** than `now − 7 days`, so the baseline drops nothing (FR-079 forbids dropping). One rule per state, and the wider bound is the safe direction. | Arming the catch-up unconditionally (a narrower window for a never-scanned binding than the rule that would have applied — a silent loss, and a second rule for one edit). |
| **H7** | **An armed catch-up survives an incomplete scan and is cleared only by the first scan that completes** — the same durability FR-076 gives the forced replay. | FR-076 names only the recovery flag; this extends it to the second one-shot by the same argument. A credential error on the cycle after the edit must not silently swallow an explicit operator request — that is the exact failure mode constitution II exists to prevent, and it is invisible afterwards because the binding still scans normally. Cleared in the same atomic write that advances `lastScanAt` (FR-018). | Consuming it on the first attempt regardless of outcome (one transient failure permanently discards a deliberate request; **would require widening FR-076's sentence to say so**). |
| **H8** | **The recovery reset changes no window — and the flag exists for honesty, precedence and visibility, not for a different bound.** | After a reset the binding has no recorded stamp, so FR-065's second branch applies and the **baseline** governs: `createdAt − overlapMs` for `new-only`, `createdAt − 7 days` for `recent-history`. Both cover everything the binding was ever responsible for, which is exactly what the lost queue's rows carried. That is why no replay bound has to be invented, and it is worth stating plainly because the flag looks load-bearing and is not: what it buys is that recovery is **never governed by the mode** (FR-073), that it **takes precedence** where a sweep is also in force, and that the operator can be **told** which of the two is happening (FR-078, FR-092, constitution IV). | A stored `replayFrom` stamp written by the reset (a second stamp that can disagree with `lastScanAt`, and a value whose only writer is a path an operator cannot reach — the shape FR-060 exists to prevent). |
| **H9** | **The mode is read once per binding per scan, and the window is computed once and passed down. No mode reaches any per-observation comparison.** | FR-068 forbids it, and R10.3 says why it is cheap to honour: five consumers read `windowStart` and **all five already handle a real stamp**. The moment the mode appeared in one of them, that one would need a rule the other four do not have. The proof is structural — the mode is not an input to `stampInWindow`, `pageEndsWalk`, or any detector's signature — plus an assertion that a widened window changes only *which* observations are in-window. | Passing the mode beside the window (one extra parameter to thread, and a future edit that uses it has no test telling it not to). |
| **H10** | **The look-back is one constant with its own bound, in `bindings-history-scope.ts`, outside `ServiceConfig` and outside `NUMERIC_BOUNDS`.** | `NUMERIC_BOUNDS` is **exported for exactly one reader**: the Settings schema projection. Putting the length there would make it a configuration field — a Settings row, and 006 FR-010's and FR-084's documented **twelve** would become thirteen, which FR-059 forbids. The **validation posture** is the one `overlapMs` gets; the **declaration site** deliberately is not (R10.8). | `NUMERIC_BOUNDS` (operator-visible, and the count moves); a `config.json` member (worse); a per-binding `historyWindowMs` (rejected at v1.13.0 — see `## Out of Scope`). |
| **H11** | **`windowFor` returns a verdict, not `string \| null`, and `stampInWindow` loses its "no window admits everything" arm.** The five downstream consumers are untouched. | This is how "the window with no lower bound is retired as a window source" (FR-065) becomes **structurally** true rather than a rule someone has to remember: with no `null` to return, there is no branch that admits every observation, and a scan that cannot compute a bound must say so (FR-072) instead of widening. The old arm is the one that made `windowStart === null` mean *true* for every stamp, which is the defect this wave exists to remove. | Keeping `string \| null` and returning `null` only for the refusal (two meanings for one value, and the arm that admits everything stays reachable); a sentinel string such as `''` (worse: a stamp `''` would parse as an epoch and compare nonsense). |
| **H12** | **One audit type, `binding.history-scope-updated`, in the `binding.` prefix, reusing the existing per-store observation chain and its trail-seeded baseline discipline.** The `from` value is seeded as "one of the two names, or `null`" — the same "trust only a shape a row should have carried" rule `prompt-audit.ts` applies to a fingerprint. | `data-model.md`'s `eventType` row already reserves `binding.*`, so this adds no type outside the prefix (FR-086, FR-088) and no dispatch-lifecycle row moves. Two fixed names mean no text, no length, no fingerprint, and no credential-shaped value, so no redaction rule and no secret-scan exemption (FR-054). Reusing the existing chain is what makes "exactly one row per change" a property of **serialisation** rather than of timing — the hazard 003 already found and fixed by putting the gate on `inQueueChain`. A second chain over the same document would reintroduce exactly the interleaving that produced one-writer-two-readers bugs twice in this codebase. | A second observer module with its own chain and baseline (two chains reading and diffing one document); a row per change written from the merge alone (misses the hand-edited document, which FR-086 names as a third path); fingerprinting the two names (a fingerprint over two values is ceremony). |
| **H13** | **The bindings answer carries the documented default for a binding that stores no member; the panel reads an **unusable** member fail-closed and treats **absent** as the default.** | FR-055 asks one source of truth for the operator's surface and FR-058 gives absence exactly one reading, so the service projects the default and the panel does not invent one. The panel's fail-closed arm is still required (FR-063, FR-093) because an answer it cannot judge must not be rendered as the default: the same posture `readAllowedUsers` already takes, and an answer from a build that does not report the member is answered by absence, not by refusal. | Filling the default on the panel side only (two answers for one question, and 005's editor renders from whichever it read); refusing an absent member in the panel (an older service's answer would render every binding *unreadable* — the honest absence would read as a fault). |
| **H14** | **The write order is: the bindings document first, then the armed catch-up — both under the route's existing chain order, and a failed catch-up write is a logged `warn` naming the binding, never a rollback.** | The operator's saved mode is the durable fact and must stand; the catch-up is a consequence of it. Rolling the document back because a derived write failed would discard a choice the operator can see and keep, which is the worse of the two failures. The failure is therefore recorded rather than hidden, which is the constitution-IV obligation H12 already accepts for the audit append. | Arming before writing the document (a catch-up for a save that then failed); refusing the whole save when the arming fails (an operator cannot clear a mode because a derived write was unavailable — a stop condition where the requirement names none). |

## B.5 The window in force — one table, three facts, one source

The whole rule in one place, because §R10.3's finding (**five consumers, all of
which already handle a real stamp**) is what makes the change small and the table
is what makes it checkable.

| Per-binding durable state | `lastScanAt` | `baselineAt` | `forceReplay` | `rescanFrom` | Window's lower bound |
| --- | --- | --- | --- | --- | --- |
| Never scanned, `new-only` | `null` | `createdAt − overlapMs` | `false` | `null` | `baselineAt` |
| Never scanned, `recent-history` | `null` | `createdAt − 604,800,000 ms` | `false` | `null` | `baselineAt` |
| Has scanned | stamp | (written at first scan, never consulted again) | `false` | `null` | `lastScanAt − overlapMs` |
| Mode edited to `recent-history` on a scanned binding | stamp | unchanged | `false` | **`now − 604,800,000 ms`** | `rescanFrom` — cleared by the first scan that completes |
| Recovery replay in force | `null` | unchanged | **`true`** | unchanged | `baselineAt`, **whatever the mode is** |
| Creation stamp present but unreadable | any | **`null` (never written)** | any | any | **none — refused, with a reason on that binding** |

Two rows of that table are worth reading twice. The **recovery** row changes no
bound (H8) — it changes who governs it, which wins, and what the operator is told.
And the **refused** row is the only state in which a binding produces no window at
all, which is the point: it is a refusal with a recorded reason, not a widening.

## B.6 Constitution alignment (v1.3.0) — re-read for this amendment

| Principle / gate | How this amendment satisfies it |
| --- | --- |
| **I. Polling-first, contract-first** | The rule is a *lower bound on an existing poll*, not a new adapter. Every GitHub endpoint and its parameters are untouched, and **no `since` is added to any endpoint** — the per-item events feed still takes only `per_page` and `page` (FR-051), which the change to `windowFor` makes structurally impossible to forget (H11). |
| **II. Safe autonomy by default** | **Strengthened, and the two new paths are where it is tested.** Both widen a window, which is exactly when a dedupe gap becomes duplicate *work*: the sweep and the catch-up are bounded (FR-079, FR-083), enqueue-only (FR-081), and deduplicate through the unchanged delivery key (FR-019, FR-075, FR-082). An unresolvable baseline **blocks** rather than admitting every observation (FR-072, FR-069, FR-024). No stored state can ask for an unbounded replay (FR-060). And the general operator-chosen-timestamp surface — the one place this feature could have handed an operator a time authority over every future scan — is **not built** (H5, `## Out of Scope`). |
| **III. Durable and idempotent work** | **The principle under most pressure, and the one this wave is shaped around.** Three durable facts, three writers, one atomic write, four independently validated members (H4, H5, FR-018). The baseline cannot slide forward on a failing scan (FR-066) because it is derived from a stored stamp and retained (H3). Neither one-shot is consumed by a scan that did not complete (H7, FR-076). A recreated binding starts over (FR-077). The acceptance surface is a **duplicate matrix across five sequences** — sweep, repeated sweep, recovery replay, repeated recovery replay, restart — at zero duplicates (SC-010, SC-011, NFR-002). |
| **IV. Human-visible auditability** | The answer to *"why was this event never offered?"* is two durable facts and no new row: the window in force and the mode on the binding's own surface, plus the mode's change history in the trail (FR-087, FR-092, FR-036). A recovery replay is visible while it is in force and is never presented as the operator's look-back choice (FR-078, FR-088). A mode change is one row naming the binding, the previous mode, the new mode, the decision and the actor, and nothing else (FR-086). |
| **V. Minimal, self-hosted deployment** | No new process, dependency, store file, endpoint, capability, permission or manifest key. One new **module** and one new **test file**. |
| **VI. Specification and verification before implementation** | Why this is an amendment with 42 requirements, 12 acceptance criteria and 5 success criteria rather than a code change, and why the two representation questions are decided here (B.4) instead of being resolved by whichever implementer picked up the file. |
| **VII. Thin orchestration boundary** | No host capability, no host call, no change to `host.startSession()` framing. A swept event is a **detection** and reaches a session only through the unchanged bounded delimited excerpt (FR-028, FR-079). |
| **Quality gates** | Strict TS + lint, zero suppressions, no `any` (invariant 7); the look-back constant is a typed literal, not a config field; offline deterministic suites per task (temp-dir store, fixture provider, loopback service — no live host, no PAT, no network); `npm run verify` at the wave boundary; **both** rebuilt bundles committed with the wave (invariant 1 — the field, the window rule, the status row and the editor control all change bundled source). |

**`AGENTS.md`'s ten invariants, one line each.**

1. **Committed bundles ship** — the wave boundary commits `service/main.js` **and** `panel/main.js`; `D-5`, `D-7` and `D-9` each change bundled source.
2. **One document, two roles** — no `version` bump; `0.0.1` stands (a release decision is the product owner's).
3. **Capabilities** — untouched. `capabilities[]` stays `["sessions","prompt"]`, `contributes.service` gains no `permissions`, and FR-064's "no new surface" is an asserted proof row (contract §5.7).
4. **Kebab-case identity** — untouched: no storage key is added, renamed or read. NFR-012 extends the *posture* of invariant 4 to a stored **value**: the two mode names are a persisted vocabulary and are not renamed without an explicit migration decision.
5. **`SERVICE_VERSION` mirrors `package.json`** — untouched, still pinned by `tests/service-server.test.ts`.
6. **SDK pinned exactly** — untouched. This amendment adds no host call, so no re-pin is implied (R10.8).
7. **Scoped suppressions, zero `any`** — the union is a closed type, `parseStoredScanState` validates three new members without a cast, and a refusal is a described line-level suppression if one is ever needed (none is planned).
8. **Fail closed** — the load-bearing one: one rule set with no coercion and no in-place default (FR-061), `null` read as cleared and never as unbounded (FR-062), a hand-edited bad value quarantining the file with a logged reason naming the field and both names, an unresolvable baseline producing **no** window (FR-072), an unusable member rendering *unreadable* in the panel (FR-063, FR-093).
9. **Secrets never leave the service store** — the mode is **two fixed names**: no free text, no length, no fingerprint, nothing credential-shaped, so no redaction rule, no scan exemption and no new assertion are required (FR-054, the explicit contrast with 004's free-text prompt). The mode is never written to `host.storage`, the ledger, a run record or a bundle (contract §5.6).
10. **`extension-spike-1` is a wire contract** — untouched. The evidence schema and record are not part of this feature, and **`buildEventId` is explicitly not changed**: a widened window re-observes the same items and the deterministic id drops them, which is the whole of NFR-002's mechanism here.

## B.7 Risks and mitigations (this amendment only)

| Risk | Mitigation |
| --- | --- |
| The forced-replay flag is read as *the* recovery mechanism and someone "simplifies" the window rule by deleting the baseline | the baseline is the recovery path's **window** (H8) and the flag is its **explanation**; the table in B.5 is the spec, and contract §5.14 asserts both facts are present and distinguishable |
| A widened window on the sweep or catch-up path produces duplicate **work**, not a duplicate log line | NFR-002 names these two paths specifically; the wave's proof is the five-sequence duplicate matrix at zero (SC-010, SC-011), plus the sweep's enqueue-only assertion (FR-081) so the burst cannot bypass the lease |
| The mode is threaded one layer too deep and appears in a per-observation comparison | H9 makes it structurally impossible (it is not a parameter of `stampInWindow`, `pageEndsWalk`, or any detector), and the mode table asserts two bindings differing **only** in mode differ **only** in which observations are in-window |
| `stampOrKeep` slides the baseline forward, or hides a corrupt creation stamp | H3: the derivation reads the **stored** stamp through its own reader, the baseline is retained on first write, and a present-but-unreadable stamp refuses (FR-072, AC-038) |
| The catch-up is armed but never consumed, or consumed by a failed scan | H7 — consumed only by a completing scan, in the same atomic write that advances the checkpoint; and the armed bound is visible on the binding's surface, so an armed-but-never-run catch-up is answerable rather than silent |
| A `new-only` binding's first scan after the upgrade **skips** its backlog | This is FR-058's stated and accepted consequence, in the requirement itself and in User Story 5's fourth acceptance scenario. It is recorded in `quickstart.md` and `README.md` (D-11) so an operator meets it as documentation rather than as a defect |
| The bindings answer gains a member an older panel misreads | R10.5: the panel's status-row reader is lenient about unknown members and fail-closed about the ones it knows; both directions are asserted |
| A hand-edited `bindings.json` carries a mode the operator changed without the panel | FR-086 names it a third path and the existing observation chain already catches it for the prompt; the mode observer rides the same chain and writes one row with actor `service` |

## B.8 Out-of-scope guard for the Wave-4 block (checked at every task)

No operator-chosen-timestamp surface, no input for one, and no route for one — the
**mechanism** is built, the **caller** is FR-084's and no other (H5; `D-10`'s
contract §5.18 is the check). No look-back length in `config.json`, in
`NUMERIC_BOUNDS`, in the schema projection, or on the Settings tab — the
twelve-field count stands (H10). No second replay surface. No migration, shim,
fallback or legacy default: a stored binding without the key **is** the absent
state, and the upgrade writes **nothing** (FR-058). No count cap, truncation or
sampling on a sweep (FR-079), and no raising the page bound to complete one
(FR-083). No per-observation audit row, and `poll.observation` / `poll.checkpoint`
stay reserved and unwritten (FR-087). No new audit event type outside `binding.`,
no dispatch-lifecycle row gaining, losing or renaming a member (FR-088). No new
route, method, error code, capability, permission or manifest key (FR-056, FR-064).
No per-binding `PATCH /v1/bindings/:bindingId` (recorded MVP-DEBT, not reopened).
No change to `buildEventId`, `SERVICE_SCHEMA_VERSION`, `SERVICE_VERSION`, any
storage key, or the SDK pin. No second rendering of the mode anywhere in the
panel (FR-091), and nothing derived from the mode outside the editor control and
the permitted row label (FR-092). No history view, backfill report, or "what would
this have caught" preview.

## B.9 Phase-4 gate items, resolved

| Item | Resolution |
| --- | --- |
| **1 — where the retained baseline lives** | **A slot beside `lastScanAt` in per-binding scan state** (`baselineAt`), per **H2**. Scan state is where the product keeps scan facts, it has one writer per fact and no operator surface reaches it; the binding record is the operator's document, it is rewritten wholesale by every save, and a machine-written stamp there would need a fourth omission-preserves merge and its own refusal rule. `FR-092` needs the **window start in force**, which is derived and reported — the baseline never needs a direct read. `data-model.md` had already put `forceReplay` on the scan side. Contract §5.12 ("three failed scans then a success still opens at `createdAt − overlapMs`") is unchanged by this choice. |
| **2 — the shape of the operator edit into `recent-history`** | **Settled by the product owner on 2026-10-05**, before this phase: build only what FR-084 requires. Recorded here as **H5 + H6 + H7** — one mechanism (`rescanFrom`), one caller (FR-084), armed only for a binding that has scanned, consumed only by a completing scan. Contract §5.18 is the check. |
| **3 — where the catch-up's per-binding window is recorded** | **In the same per-binding scan-state slot, as its own member** (`rescanFrom`), per **H5** — which is also the answer to (1)'s question for that caller, and *not* the retained baseline, because the two have different jobs: the baseline is what a later recovery replay must cover, and overwriting it would change that. |

## B.10 Phase-6 task block for this amendment

Wave 4 (`D-1 … D-12`) in [`tasks.md`](./tasks.md) §"Wave 4 — 002 v1.13.0: the
binding history scope", where the reconciled requirement brackets, the corrected
dependency graph, the corrected parallelism set and the **Wave-4-specific** Phase-6
routing recommendation live. The `FR-…` brackets on those tasks were reconciled
against the final v1.13.1 numbering on 2026-10-05; `D-10`'s old bracket
(`FR-032 – FR-043`) named pre-existing requirements and is corrected there.
