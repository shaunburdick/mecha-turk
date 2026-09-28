# Implementation Plan: Agent Event Extension (Production)

**Branch**: `001-agent-event-orchestrator` | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md) (v1.0.0, approved)

**Input**: Feature specification `specs/002-agent-event-extension/spec.md`; constitution `.specify/memory/constitution.md` v1.3.0; carried-forward research `specs/001-agent-event-orchestrator/research.md` (**historical path — removed 2026-09-28** in commit `110c0a2`; recover with `git show 110c0a2^:specs/001-agent-event-orchestrator/research.md`; the findings that bind this plan are restated in `spec.md`'s `## Research and Platform Decisions` table and in `research.md` §R1–§R7 of this feature).

**Historical-path note (2026-09-28, cleanup review)**: every `001 …` citation in this file — `001 research §b.9` (transport), `001 research §b.8` (no settings writer, the reason `expected-agent` is a manifest setting), `001 research Host API`, `001 §b.7` / `§b.6` (panel lifetime, uninstall wipe), `001 §a.5` (page cap), `001 §a.3` / `§a.4` (rate arithmetic), and `spike-evidence.md §4.1` (folder install) — refers to the `specs/001-agent-event-orchestrator/` directory **removed in commit `110c0a2`**. They are kept as stamped provenance; recover any with `git show 110c0a2^:specs/001-agent-event-orchestrator/<file>`. This plan's live successors are `research.md` (§R1–§R7), `spec.md` (FR-002, FR-011, FR-017, FR-029, FR-041), and `contracts/events-carry-forward.md`.

**Note**: No application code is written in phases 4–5. Every decision below is decided and justified — there are no open option pairs.

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
├── research.md                  # NEW research only (R1–R7), sources stamped
├── data-model.md                # both storage tiers, states, constraints
├── contracts/
│   ├── panel-service.md         # HTTP contract: endpoints, auth, limits, errors
│   ├── token-handoff.md         # SECURITY-GATED flow (security-auditor review is T-001)
│   ├── events-carry-forward.md  # pointer + versioning note for 001 events.md
│   └── README.md                # index and supersession pointers
├── quickstart.md                # dev/build/test/install walkthrough
└── tasks.md                     # 35 tasks, security gate first, wave-ordered
```
