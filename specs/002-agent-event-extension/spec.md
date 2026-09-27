# Feature Specification: Agent Event Extension (Production)

**Feature ID**: `002-agent-event-extension`
**Feature Branch**: `001-agent-event-orchestrator` (spec-kit keeps the working branch and the feature directory independent; this production spec is written and committed on the branch that carries the 001 → 002 transition)
**Created**: 2026-09-27
**Last Updated**: 2026-09-27
**Version**: 1.0.0
**Status**: Draft — ready for phase-gate review
**Dependencies**: Feature 001 `001-agent-event-orchestrator` — supersedes it for production. The trigger set, deduplication/idempotency rules, policy and approval-gate semantics, audit and observability requirements, and the normalized event contract (`specs/001-agent-event-orchestrator/contracts/events.md`) carry over into this specification.
**Input**: Product-owner decisions locked 2026-09-27 — "Option B" architecture (OpenChamber extension panel + OpenChamber-hosted local guest service), N-account credential custody, extension read-only to GitHub, Default-Agent pinning with fail-closed verification, bounded autonomy, service-owned durable state. All locked decisions are encoded in the Functional Requirements and listed in `## Clarifications`.
**Constitution**: `.specify/memory/constitution.md` v1.3.0 — Approved 2026-09-27 by product owner.

## Problem Statement

Mecha Turk must turn GitHub activity — issue assignments, pull-request review requests and assignments, and comment mentions — into agent-led work sessions inside the operator's own OpenChamber installation, without inbound firewall exposure, without a hosted control plane, and without Mecha Turk reimplementing the harness.

Feature 001 proved the extension path end-to-end as a spike (S1–S7 all passed, 2026-09-27) but as a single-account, panel-scoped prototype. Production needs are strictly larger: **N GitHub accounts** each with its own credential and rate-limit pool, **multi-repository polling** with durable checkpoints and correct deduplication across restarts and replays, **post-dispatch agent verification** so work is provably handled by the project-manager agent, and a **durable audit trail that survives an extension uninstall** (constitution v1.3.0, Security and Operational Standard 4 — `host.storage` alone is not an audit home). No single platform surface provides all of this: the panel is sandboxed and single-account, and the platform allows exactly one `integration` card per manifest (`001/research.md` §b.3).

This specification therefore describes the production system as an **OpenChamber extension (panel) plus an OpenChamber-hosted local guest service** — the product owner's approved "Option B" path. The panel is the configuration, dispatch, and observability surface; the service owns credential custody, GitHub polling over its own outbound HTTPS, and normalized event relay. OpenChamber keeps ownership of projects, worktrees, sessions, and agents.

## Architecture Decision (locked, 2026-09-27)

Two components, one extension package, one approval flow:

| Component | Owns | Never does |
| --- | --- | --- |
| **Panel** (extension iframe) | Configuration UX (accounts, repository bindings, triggers, policy, worktree option), account-token entry and one-shot handoff, project picker (`host.listProjects()`), dispatch via `host.startSession()`, run list, health display, post-dispatch agent verification | Holding tokens beyond the handoff, polling GitHub directly, creating/deleting projects, worktrees, sessions or agents, writing to GitHub |
| **Service** (OpenChamber-hosted local guest service) | Multi-account token custody in durable storage, GitHub polling over its own outbound HTTPS (headers, ETags, `x-ratelimit-*`), checkpoint/dedup/rate accounting, normalized event relay to the panel, service-owned audit history | Calling host APIs, spawning sessions, touching the harness, any GitHub write |
| **OpenChamber host** | Projects, worktrees, sessions, agents, the `serviceRequest` loopback transport, capability approval, the service process lifecycle | — (Mecha Turk never recreates these) |

Transport: `panel --serviceRequest--> host --HTTP 127.0.0.1:<ephemeral port>--> service`, request/response only (`001/research.md` §b.9). GitHub traffic never crosses the panel→host leg; it originates in the service with its own credentials.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Configure GitHub accounts and repositories (Priority: P1)

As a self-hosting operator, I paste a GitHub personal access token for each GitHub account I work with, verify each account, and bind each repository to one account, one existing OpenChamber project, and a set of triggers — so that Mecha Turk knows what to watch and under which identity.

**Why this priority**: Nothing else in the system can run without accounts and bindings; this is the first screen an operator touches and the one every other story depends on.

**Independent Test**: On a clean install, add two accounts (paste token → verified login returned), bind one repository to an account and an already-registered project, enable issue-assignment and mention triggers, and observe the binding become `active` — without any CLI, any GitHub write, and with zero token bytes in persisted panel state, logs, or audit.

**Acceptance Scenarios**:

1. **Given** no accounts exist, **When** the operator pastes a fine-grained PAT, **Then** the service verifies it against GitHub `/user`, stores it outside `host.storage`, returns the numeric user id and login, and the panel displays `Connected as <login>`; the token appears in no storage, ledger, log, toast, or audit record.
2. **Given** the `service` capability has not been approved, **When** the operator attempts a token handoff, **Then** the handoff is refused with the approval instruction, and no token leaves the panel.
3. **Given** a verified account, **When** the operator adds a repository, **Then** they choose the account, then an existing project from the `listProjects()` picker, then per-repo triggers; if the desired project is not registered, the panel shows the manual "Add project" guidance and the binding stays in the recoverable `project_missing` state — no project is ever created by the extension.
4. **Given** two accounts with overlapping repository interests, **When** each repository is polled, **Then** each account polls only its own bound repositories under its own identity and its own rate budget.

---

### User Story 2 — An event arrives and a project-manager session is created (Priority: P1)

As a repository maintainer, I assign an issue to one of my configured account identities (or request a PR review, or mention it in a comment) so that Mecha Turk discovers the event, applies policy, and starts an OpenChamber session attached to the source with the project-manager agent — without an inbound webhook and without me copying context by hand.

**Why this priority**: This is the product's core value: unattended conversion of GitHub activity into bounded agent work.

**Independent Test**: With one active binding and default policy, seed a new issue assignment for the bound identity, run the poller through a checkpoint boundary, and observe exactly one run and exactly one `host.startSession()` call whose session verifies to the `project-manager` agent — or an explicit blocked state that explains why not.

**Acceptance Scenarios**:

1. **Given** an active binding and default autonomous policy, **When** polling observes an issue assignment to the bound account identity, **Then** the service normalizes a delivery, records policy approval, relays it to the panel, and the panel dispatches `host.startSession()` with the resolved `projectId`, the issue attachment, a bounded delimited untrusted-context excerpt, the configured worktree option, and the correlation id.
2. **Given** the same assignment observed again inside the 10-minute overlap window (or replayed 100 times), **When** deduplication runs, **Then** no second delivery, run, or session is created.
3. **Given** the dispatched session reports `onSession().agent` equal to the operator's Session Defaults → Default Agent, **When** verification completes, **Then** the run becomes `dispatched` and is listed with a link to the session.
4. **Given** the observed agent differs from the pinned default (or cannot be read), **When** verification fails, **Then** the run is marked `blocked:agent-mismatch`, an audit entry and a panel warning are recorded, and no further automated action occurs for that run.
5. **Given** a configured approval gate on "start work", **When** a matching event arrives, **Then** the run waits in `waiting_approval` and starts only after an auditable approval.

---

### User Story 3 — Observe runs and system health (Priority: P2)

As an operator, I see, in one panel, which accounts are connected, when each repository last polled, how much of each account's GitHub rate budget is spent, what the service is doing, whether the agent pin is holding, and every run with its source link and status — so that I can trust and explain unattended operation.

**Why this priority**: Constitution Principle IV makes unattended operation unacceptable without visibility; this story is what makes stories 1 and 2 operable over time rather than demo-able once.

**Independent Test**: With two accounts and three repositories running, open the panel after a service restart and confirm every health field renders from real state (service status, per-repo last poll, per-account rate usage, agent pin status), then trace one run from source issue to session using its correlation id.

**Acceptance Scenarios**:

1. **Given** a running system, **When** the panel opens, **Then** it shows per-account identity, per-repository last successful poll time and checkpoint age, per-account rate usage against budget, `serviceStatus()`, and the agent-pin verification result — with no secret material anywhere.
2. **Given** the extension is disabled, **When** polling stops, **Then** the panel (once re-enabled) reports the stopped interval honestly rather than masking it; while OpenChamber itself is not running, no polling occurs at all and this dependency is documented and surfaced as health.
3. **Given** a run in `blocked:agent-mismatch` or `blocked:project-missing`, **When** the operator inspects it, **Then** the panel states the exact cause and the manual step that clears it.

---

### User Story 4 — Recover safely from failure (Priority: P2)

As an operator, I want failures — a crashed service, a revoked token, a rate limit, a force-pushed PR head, a removed assignment — to stop work with a precise, auditable reason instead of silently retrying, duplicating, or guessing, so that I can fix the cause and resume without cleanup.

**Why this priority**: Unattended operation is only safe if failure handling is deterministic; this story is the operational half of constitution Principles II and III.

**Independent Test**: Kill the service mid-poll, revoke a token, and force-push a watched PR head; in each case confirm the checkpoint is preserved, the run states an exact blocked/retrying reason, no duplicate session exists, and clearing the cause resumes cleanly under the same run key.

**Acceptance Scenarios**:

1. **Given** a service crash, **When** the host reports `SERVICE_FAILED`, **Then** polling stops, checkpoints remain durable, the panel offers a manual retry, and no silent restart loop occurs.
2. **Given** a revoked or scope-insufficient token, **When** the next poll fails authentication, **Then** the affected streams block with the exact capability named, the token is never echoed, and other accounts continue unaffected.
3. **Given** PR head SHA drift or an assignment removed after discovery, **When** the service re-fetches before execution, **Then** the run pauses and requires a new trigger rather than acting on changed source state.
4. **Given** cleared causes, **When** the operator retries or replays, **Then** the original delivery identity and dedup rules are preserved and no duplicate work results.

---

### Edge Cases

- **Same issue reached by two triggers** (assignment + mention): two deliveries with distinct delivery keys normalize to one deterministic run key → one run, both source references preserved.
- **Clock skew / delayed GitHub indexing**: timestamp overlap (10 min) plus delivery-key dedup; never a single global cursor — each endpoint/stream keeps its own cursor.
- **IDs not globally ordered across endpoints**: endpoint-specific checkpoint state; ordering assumptions never cross streams.
- **Pagination interrupted mid-window**: prior checkpoint retained, full safe window re-scanned; checkpoint advances only after the whole window is durably represented.
- **Comment edited or deleted between discovery and execution**: re-fetch the current source object; deleted, inaccessible, or ambiguous content is non-actionable and never triggers new work.
- **PR head force-pushed after discovery**: SHA drift detected at re-fetch → run pauses, new trigger required.
- **Assignment removed after discovery**: re-check before any downstream action, record the discrepancy, do not proceed as if assigned.
- **Token revoked, expired, or missing a required scope**: that account's streams block with the exact capability named; no token bytes in any error surface; other accounts unaffected.
- **Rate limit (primary or secondary) hit**: checkpoint preserved, `retry-after`/reset obeyed, bounded backoff with jitter, delayed status shown, no catch-up burst.
- **304 responses unavailable or unsupported on some endpoint**: correctness identical — conditional requests are an optimization only, never a dependency.
- **Project not registered in OpenChamber**: binding enters recoverable `project_missing`, dispatch blocked with the manual Add-project guidance; the extension never creates a project.
- **Agent pin absent or verification inconclusive**: run marked `blocked:agent-mismatch` (fail-closed); a session may exist but is never reported as valid work.
- **Service capability not approved / consent not given**: no token handoff, no polling, panel states the required approval.
- **Unsupported surface (VS Code, mobile)**: explicit unsupported/disabled state; no claim that polling runs.
- **Service process crashes**: `SERVICE_FAILED`, manual retry, no silent loop, durable state intact.
- **Extension uninstalled**: panel UI state in `host.storage` is wiped (documented); service-owned durable records are the audit home and their uninstall behavior is verified and documented — audit history is never dependent on `host.storage` alone.
- **Empty state (fresh install)**: panel shows the setup-prerequisites checklist and an empty run list, not an error.
- **Error state (4xx/5xx/timeout from GitHub)**: bounded retry with backoff, checkpoint preserved, exact reason surfaced in health with correlation id.

## Requirements *(mandatory)*

### Functional Requirements

#### A. Architecture and platform boundary

- **FR-001**: The production system MUST consist of exactly one OpenChamber extension package containing a panel and one OpenChamber-hosted local guest service ("Option B"). The panel MUST provide configuration, dispatch, and status/run surfaces; the service MUST provide multi-account credential custody, GitHub polling over its own outbound HTTPS, normalized event relay to the panel, and service-owned durable state. OpenChamber remains the sole owner of projects, worktrees, sessions, and agents (Constitution Principle VII).
- **FR-002**: The manifest MUST declare `contributes.service` together with the minimum capability set required to operate (`sessions`, `prompt`, `service`, plus the `network` implied by the declared integration). The host MUST spawn the service on first `serviceRequest`; the service MUST listen on `127.0.0.1` only, MUST require `Authorization: Bearer <service token>` on every request including `/health`, and MUST be observable through `serviceStatus()` (`stopped | starting | ready | failed`).
- **FR-003**: The supported service surfaces are OpenChamber **desktop and web**. On surfaces where services are not spawned (VS Code, mobile) the panel MUST present an explicit unsupported/disabled state and MUST NOT claim that polling, custody, or relay is operating.
- **FR-004**: The panel MUST NOT create, delete, or mutate projects, worktrees, sessions, or agents. Repository-to-project resolution MUST use `host.listProjects()`; "project not registered" MUST be a first-class recoverable state with operator guidance, never an error and never an implicit creation.
- **FR-005**: All dispatch MUST go through the documented `host.startSession()` with issue/PR attachment (source id, title, url, kind, text, data), the resolved `projectId`, and the configured worktree option. No private UI route, undocumented API, or direct worktree/session manipulation is permitted.

#### B. Accounts and credential custody

- **FR-006**: The system MUST support N GitHub accounts. Adding an account is: panel input pastes a token → one-shot handoff to the service via `serviceRequest` → the service verifies the token against GitHub `/user` using its own fetch → the service persists the credential in service-owned durable storage outside `host.storage` → the service returns the numeric user id and login to the panel.
- **FR-007**: The panel MUST NOT retain any token beyond the transient handoff. Tokens MUST NOT be written to `host.storage`, the ledger, logs, toasts, run records, audit entries, or error bodies at any point. Panel-side handling is write-through only, and every surface that renders request/response material MUST apply redaction.
- **FR-008**: A security gate MUST precede any token handoff. The gate has two mandatory parts: (a) the operator has approved the extension's declared capabilities (including `service`) at install time, and (b) the panel presents an explicit consent step before the first handoff that states, in plain language, that service permissions are advisory in Phase 1 and an allowed service has the operator's full user access. The occurrence of consent MUST be recorded in audit without any token material.
- **FR-009**: Account identity MUST be keyed by the numeric GitHub user id discovered from `/user` (durable); the login is display-only and MUST NOT be used as a durable key. If an operator-supplied expected-login constraint exists and disagrees with `/user`, the account MUST be rejected (fail closed).
- **FR-010**: The system MUST document and validate the credential scope matrix: `Metadata: read`, `Issues: read`, `Pull requests: read` (and `Contents: read` only if repository metadata is passed to OpenChamber). Write scopes are NOT required. Missing permissions MUST block the affected stream with the exact capability named, never silently downgrade. The GitHub Notifications API MUST NOT be used as a discovery source.
  - **Single-verdict note (Wave 2, documented by T-009m — FR numbering unchanged, L5)**: today the matrix is emitted as **one shared verdict for all four capabilities**, because GitHub reports a single granted-scope set per token: each capability reads `ok`/`missing` from the classic scopes GitHub returned, or `unknown` when it returned none (fine-grained PATs, GitHub App tokens). The fail-closed rules are unchanged by that shape — `missing` still pre-blocks the affected stream with the capability named, `unknown` is resolved by the first real 403, and neither ever silently downgrades (FR-010's operative requirement). Per-capability divergence would need response-specific probing and is deferred to a later wave rather than implied by Wave 2 output.
- **FR-011**: The manifest declares exactly one `integration` card, and it MUST be treated as **optional and non-authoritative**: a host-managed GitHub token card (`apiOrigin: https://api.github.com`, `account.path: /user`, `scheme: bearer`) used only for (a) displaying a connected-login identity badge in the panel and (b) an optional read-only connectivity/identity diagnostic when the service is unavailable. It MUST NOT be used as a polling, discovery, or dispatch credential; all GitHub traffic for those flows originates in the service. The product MUST be fully functional with this card unconnected, and the panel MUST label it as optional so its state is never confused with service-managed accounts.
- **FR-012**: Credential rotation and revocation MUST be supported without data loss: revoke on GitHub, replace the token through the account handoff flow, and retain all existing checkpoints, deliveries, runs, and audit history for that account.

#### C. Repository binding and triggers

- **FR-013**: Adding a repository MUST follow the sequence: choose account → choose an existing OpenChamber project from the `listProjects()` picker → enable per-repository triggers. The supported target scale is fewer than 10 repositories per deployment.
- **FR-014**: Project creation is out of scope (no platform API exists). The picker MUST include a "not listed?" affordance that documents the manual steps (command palette → Add project, sidebar **+**, or folder browser) and MUST leave the binding in a recoverable state until a registered project is selected.
- **FR-015**: The trigger set MUST include, each independently toggleable per repository: (a) issue assignment to a configured account identity, (b) pull-request review request or review assignment for that identity, and (c) a new issue/PR comment containing a configurable mention token. The mention token defaults to `@<login>` of the bound account, matches case-insensitively, and MAY be overridden per repository (for example a shared bot handle).
- **FR-016**: All trigger matching MUST be scoped to the identity bound to that repository. Events for other identities, bot-authored duplicates, and non-matching content MUST be ignored or audited as non-actionable, and MUST NOT create work.

#### D. Polling and discovery (service-side)

- **FR-017**: Discovery MUST be outbound HTTPS polling performed by the service, with a default interval of **60,000 ms** (configurable within 15,000–300,000 ms). No inbound listener, webhook endpoint, or webhook configuration exists in this feature. Discovery MUST use repository-scoped endpoints only.
- **FR-018**: For each account + repository + stream the service MUST persist a durable checkpoint containing endpoint/filters, last safely observed item id and timestamp, pagination position, conditional validators (`ETag`/`Last-Modified`) where captured, poll time, and credential/account scope. A checkpoint MUST advance only after the fetched page/window is durably represented in full.
- **FR-019**: Polling MUST overlap the last observed window by **10 minutes** by default (configurable) and MUST deduplicate by a stable **delivery key** scoped to provider, account, repository, source type, source id, and event kind. Identifier-only cursors MUST NOT be treated as sufficient.
- **FR-020**: Pagination MUST be processed completely or the prior checkpoint retained; `per_page` MUST NOT exceed 30, and responses MUST be paginated rather than fetched at provider page limits.
- **FR-021**: Because the service owns its own request and response headers, it MAY send conditional requests (`If-None-Match`/`If-Modified-Since`), read `ETag`/`Last-Modified`, and read `x-ratelimit-*` headers. Correctness MUST NOT depend on any of this: 304 handling is a feature-detected optimization, and every requirement in this specification MUST hold identically when conditional requests are unavailable.
- **FR-022**: Rate budget MUST be accounted **per GitHub account and shared across all repositories bound to that account**. The steady-state design point is approximately 600–1,500 requests/hour at the default interval for up to 10 repositories, within the documented 5,000 requests/hour authenticated limit. The service MUST honor primary and secondary rate-limit signals, `retry-after`/reset guidance, network timeouts, and transient 5xx responses with bounded exponential backoff plus jitter, and MUST expose next poll/retry time and remaining budget.
- **FR-023**: Polling schedules and checkpoints MUST survive restart, resume within the overlap window, and audit any replayed observation as duplicate or previously processed. A controlled operator rescan/replay from a chosen timestamp MUST be supported without weakening deduplication or altering source identity.
- **FR-024**: The system MUST fail closed for unconfigured repositories, identity mismatch, invalid or expired credentials, unsupported API responses, ambiguous event classification, missing policy, and unresolved projects — blocking with an explanation rather than proceeding or degrading silently.

#### E. Normalization, policy, and dispatch

- **FR-025**: Events MUST be normalized to the carried-forward event contract (`specs/001-agent-event-orchestrator/contracts/events.md`): kinds `mention`, `issue_assignment`, `review_request`, `review_assignment`; source identity scoped by provider/account/repository/type; untrusted, delimited content; correlation id. This feature may version the schema; the v1 record remains the reference.
- **FR-026**: Before any downstream action the service MUST re-fetch the current source object. Deleted, edited, inaccessible, or ambiguous content is non-actionable; assignment removal and PR head SHA drift MUST pause the run and require a new trigger, with the discrepancy recorded.
- **FR-027**: Policy MUST be autonomous-by-default for authorized actions, with per-action toggles (starting work now; future write/merge gates exist only as documented policy statements because this feature never writes to GitHub). A missing policy MUST fail closed for that action. Every policy decision MUST record policy version, actor/source, requested action, decision, timestamp, and reason.
- **FR-028**: Dispatch MUST call `host.startSession()` with: the resolved `projectId`, the source attachment, the configured worktree option (`none` | `generated` | `new:<branch-name>` with a `{number}` placeholder substituted from the source issue/PR number), a **bounded untrusted-context excerpt** (default: ≤4,000 characters per source item, ≤12,000 characters per dispatch, explicit truncation markers), explicit delimiters that prevent source text from altering system policy, credentials, approval requirements, or tool scope, and the correlation id.
- **FR-029**: **Agent pinning** MUST be configured through OpenChamber's own Settings → Sessions → Session Defaults → Default Agent (documented setup step: set it to `project-manager`); the extension MUST NOT attempt to pass an agent, model, or variant per call (the platform strips those fields). After every dispatch the extension MUST verify the agent via `onSession().agent`; if the observed agent differs from the pinned default, or cannot be read, the run MUST be marked `blocked:agent-mismatch`, audited, surfaced in the panel with a warning, and MUST NOT receive further automated handling (fail closed).
- **FR-030**: Dispatch MUST be idempotent: every run carries a deterministic run key (provider, account, repository, subject type, subject number, action class). A run with a successful non-empty `sessionId` MUST NEVER be dispatched again; runs in `blocked` or failed states MAY retry only after the underlying cause clears, under the same run key, with each attempt audited.
- **FR-031**: The extension and service MUST be **read-only with respect to GitHub**: no comments, reviews, reactions, acknowledgements, labels, state changes, or any other write. There is deliberately no ack reaction — silence is preserved until the responding agent acts inside its own session. All GitHub writes are the agent's responsibility within its session.
- **FR-032**: Autonomous merge, deployment, repository administration, permission changes, and arbitrary shell orchestration MUST NOT exist in this feature under any policy setting (Constitution Principles II and IV).

#### F. Persistence, audit, and health

- **FR-033**: The service MUST durably own accounts, tokens, configuration, checkpoints, deliveries, runs, and audit history in storage that exists **outside `host.storage`**, located under the operator's OpenChamber data directory with operator-restricted file permissions and a location the operator can back up. The uninstall behavior of this store MUST be verified during planning and documented; it MUST NOT be assumed.
- **FR-034**: Panel UI state (selections, filters, last-viewed, bounded display mirrors) MUST live in `host.storage` with documented uninstall-wipe semantics. UI state MUST NOT be the sole home of audit history, checkpoints, or runs — `host.storage` alone does not satisfy the durability standard in constitution v1.3.0.
- **FR-035**: An append-only, bounded audit trail MUST record polls, checkpoints, observations, routing, credential identity (numeric id/login only, never a token), consent events, policy decisions, dispatches, agent verification results, retries, failures, and terminal outcomes — each with a correlation id and redaction metadata. Retention defaults MUST be documented and configurable without deleting the minimal references required to explain a run.
- **FR-036**: Health MUST be exposed and displayed: `serviceStatus()`, per-account identity and connection state, per-repository last successful poll and checkpoint age, per-account rate usage against budget, and agent-pin verification status. Disabling the extension MUST stop polling. The dependency that unattended operation requires OpenChamber (and its service) to be running MUST be documented and surfaced, never masked by an undocumented background mechanism (Constitution, Security and Operational Standard 3).
- **FR-037**: The system MUST support graceful shutdown, bounded queue and resource limits, bounded retries with backoff, dead-letter capture with manual replay under duplicate protection, and a non-looping crash response (`SERVICE_FAILED` → operator-initiated retry).

#### G. Setup and operations

- **FR-038**: The system MUST ship a documented setup-prerequisites section covering: Session Defaults → Default Agent = `project-manager`, OpenChamber running (unattended operation depends on it), desktop/web-only service support, and GitHub PAT scopes (see `## Setup Prerequisites`).
- **FR-039**: Configuration validation MUST run before production operation and detect: missing/insufficient credential scopes, unverified or rejected accounts, repository bindings without a resolved project, disabled service capability, invalid polling settings, and unavailable storage — reporting each explicitly rather than starting in a degraded state.
- **FR-040**: Cleanup MUST be manual only: the platform exposes no session/worktree deletion API to extensions, so the panel MUST route the operator to OpenChamber's own surfaces for cleanup and MUST NOT implement automatic session, worktree, or project cleanup.

### Key Entities

- **Account**: GitHub identity used for matching and polling — durable `numericUserId`, display `login`, optional expected-login constraint, credential reference held only by the service, verified-at timestamp, scope check result, connection state.
- **RepositoryBinding**: one repository under one account — GitHub repository id/owner/name, bound account, resolved OpenChamber `projectId`, per-trigger enablement flags, mention token override, worktree option, policy profile, enabled state.
- **Checkpoint**: per account + repository + stream cursor — endpoint/filters, last observed id/timestamp, pagination position, validators, overlap window, last poll time, retry/backoff state, next poll time.
- **Delivery (normalized event)**: immutable normalized provider fact — schema version, provider, account id, repository, source type/id/updated_at/url, event kind, subject (type/number/base ref/head sha), bounded content reference, correlation id, **delivery key**.
- **Run**: work unit derived from one or more deliveries — deterministic **run key**, policy decision, lifecycle state, attempts, worktree option used, dispatch result, verification result, source links.
- **SessionRef**: pointer to the host-owned session — `sessionId`, title, source url, dispatch timestamp, observed agent/model, verification status. OpenChamber remains authoritative; the extension stores only the reference.
- **PolicyProfile**: per-action autonomy/approval configuration — action name, gate on/off, policy version, effective timestamp.
- **AuditEntry**: append-only record — timestamp, correlation id, event type, actor/source, decision/reason, redaction metadata; never contains a token.
- **ServiceHealth**: `serviceStatus()` value plus per-account rate usage, per-repository last poll/checkpoint age, and agent-pin verification status.

### States

- **Account**: `pending_handoff → verifying → active | rejected`, plus `revoked` and `error` transitions out of `active`. Only `active` accounts may poll.
- **RepositoryBinding**: `draft → project_missing → active | blocked | disabled`. `project_missing` is recoverable; `blocked` carries an explicit reason; `disabled` stops polling for that repository.
- **Checkpoint**: `uninitialized | active | backing_off | stale | blocked | disabled`. Advances only after a fully durable window.
- **Delivery**: `discovered → ignored | duplicate | queued → processing → dispatched | dead_lettered`, with `blocked` available before dispatch.
- **Run**: `created → dispatching → verifying_agent → dispatched`, or `waiting_approval`, `blocked` (incl. `blocked:agent-mismatch`, `blocked:project-missing`, `blocked:credential`, `blocked:policy`), `retrying`, `completed`, `dead_lettered`. Transitions out of `blocked` occur only when the cause clears, under the same run key.
- **Service**: `stopped | starting | ready | failed`, plus the panel-only `unsupported_surface`. Crashes map to `failed` with manual retry.

## Setup Prerequisites

Documented and shipped with the feature (FR-038); each prerequisite is also surfaced in the panel's first-run checklist.

1. **Default Agent pin (required for dispatch)**: In OpenChamber, set **Settings → Sessions → Session Defaults → Default Agent** to `project-manager`. The platform does not let an extension name an agent per call, and the guest-send path checks this setting first, so this is the only deterministic pin (`001/research.md` §b.2). Side effect to document: new user sessions also default to it until changed. The panel cannot read this setting, so the pin is enforced **post-dispatch** by verification (FR-029), not pre-flight.
2. **OpenChamber must be running**: Unattended operation means "unattended while the operator's OpenChamber is up". Polling and dispatch stop when OpenChamber stops, when the extension is disabled, or when the service is not running (constitution v1.3.0, Security and Operational Standard 3).
3. **Desktop or web surface**: Guest services spawn on desktop and web only; VS Code and mobile do not spawn services, so those surfaces show the unsupported state (FR-003).
4. **GitHub PAT scopes**: fine-grained PAT preferred, with `Metadata: read`, `Issues: read`, `Pull requests: read` (+ `Contents: read` only if repository metadata is passed to OpenChamber). No write scopes. Organization approval policies for fine-grained PATs must be granted where the organization requires them. The Notifications API is not used (classic-PAT-only limitation, `001/research.md` §a.6).
5. **Registered project**: each bound repository's project must exist in OpenChamber (command palette → Add project, sidebar **+**, or folder browser). The extension cannot create it.
6. **Service capability approval**: approve the extension's declared capabilities at install; token handoff additionally requires the in-panel consent step (FR-008).

## Non-Functional Requirements

- **NFR-001 Detection latency**: Under normal rate conditions, p95 from GitHub event timestamp to run creation MUST be ≤ 2 × the poll interval (default ≤ 120 seconds), measured with ≤10 repositories and no rate-limit pressure.
- **NFR-002 Idempotency**: Replaying any repository window 100 times MUST produce zero duplicate deliveries-in-run, duplicate runs, duplicate sessions, or duplicate external side effects.
- **NFR-003 Rate safety**: Steady-state polling MUST stay within the design point of ~600–1,500 requests/hour per account (≤30% of one account's 5,000/h budget at 10 repositories), MUST respect secondary limits, and MUST never enter a catch-up burst after backoff.
- **NFR-004 Secret containment**: Zero occurrences of any token value in persisted panel state, ledger, logs, audit entries, toasts, error bodies, or committed files, verified by automated scan in tests.
- **NFR-005 Fail-closed safety**: Every failure class listed in FR-024 MUST block rather than proceed, with an explanation naming the exact cause and no secret material.
- **NFR-006 Durability**: After any crash or restart in any state, checkpoints, deliveries, runs, and audit entries recover without silent loss and without duplicate side effects; the audit history home MUST survive extension uninstall.
- **NFR-007 Observability**: One correlation id MUST trace a source observation through checkpoint, routing, policy, dispatch, agent verification, and terminal state, in both the panel and the audit trail.
- **NFR-008 Compatibility**: The OpenChamber SDK version MUST be pinned exactly and re-pinned to the host's own release before execution (spike record: `@openchamber/sdk` `1.24.2`, `001/spike-evidence.md` §1). Host capabilities MUST be adapter-abstracted and capability-checked at runtime; unsupported operations MUST fail safely instead of being reimplemented through private APIs.
- **NFR-009 Surface honesty**: On any surface where a required capability is unavailable, the panel MUST state what is disabled and why; it MUST never display healthy-looking state for non-operating subsystems.
- **NFR-010 Maintainability**: GitHub discovery and the panel↔service transport MUST be adapter boundaries with contract tests; a future webhook adapter MUST be addable without changing routing or policy semantics; strict type checking and linting apply with no suppressions (constitution, Development Quality Gates).

## Success Criteria

### Measurable Outcomes

- **SC-001**: A new operator connects their first account and binds their first repository end-to-end in under 5 minutes using only the panel (no CLI, no file edits).
- **SC-002**: At default settings, a matching GitHub event becomes a created OpenChamber session within 2 minutes (p95) of the event timestamp.
- **SC-003**: 100-window replay testing yields 0 duplicate runs, 0 duplicate sessions, and 0 duplicate external side effects.
- **SC-004**: Automated secret scans of persisted state, logs, audit, and error surfaces find 0 token occurrences across the full test suite.
- **SC-005**: With 10 repositories at the 60-second default, steady-state polling consumes ≤1,500 requests/hour per account (≤30% of that account's budget).
- **SC-006**: 100% of runs in the panel display their source link, policy decision, current state, and correlation id — every run is explainable without reading raw logs.
- **SC-007**: After extension uninstall, service-owned audit history remains readable per its documented retention, and the operator can state exactly which panel UI state was wiped.

## Acceptance Criteria

- [ ] **AC-001**: Pasting a token completes the handoff → `/user` verification → durable service-side storage → returned login; an automated scan of `host.storage`, ledger, logs, audit, and error surfaces finds no token bytes.
- [ ] **AC-002**: With the `service` capability unapproved, handoff is refused with instruction; after approval and explicit consent, handoff succeeds and the consent event is audited without token material.
- [ ] **AC-003**: Three accounts can be added; each returns its own login and numeric id from `/user`; duplicate or invalid tokens are rejected with a clear reason and no token echo.
- [ ] **AC-004**: Account records key on numeric user id; a login rename updates display only; an expected-login mismatch rejects the account (fail closed).
- [ ] **AC-005**: The add-repository flow enforces account → existing-project picker → per-repo triggers; a missing project yields `project_missing` with manual guidance; no project-creation call exists anywhere in the codebase.
- [ ] **AC-006**: Issue assignment, review request, review assignment, and comment mention are each classified correctly against the bound identity; default `@login` and a custom mention token both match case-insensitively; non-matching and other-identity events are ignored/audited as non-actionable.
- [ ] **AC-007**: Every checkpoint persists endpoint/filters, id/timestamp, pagination, validators, poll time, retry state, and account scope; an interrupted page does not advance it; restart resumes within the overlap window and audits re-observed items as duplicates.
- [ ] **AC-008**: 100× replay of the same window produces 0 additional deliveries-in-run, runs, or sessions (delivery key and run key both exercised, including the assignment+mention collision case).
- [ ] **AC-009**: Rate accounting is shared per account across its repositories; simulated 403/429 responses trigger backoff honoring `retry-after`, preserve the checkpoint, expose next-poll time, and show budget usage in health.
- [ ] **AC-010**: Running discovery with conditional requests forcibly disabled produces identical deliveries, runs, and sessions as with them enabled (304s are optimization only).
- [ ] **AC-011**: Default policy starts authorized work with no approval; enabling the "start work" gate pauses runs until an auditable approval; removing policy blocks the action; every decision records version, actor/source, action, decision, timestamp, and reason.
- [ ] **AC-012**: A dispatched `host.startSession()` carries the resolved `projectId`, source attachment, configured worktree option (`none`, `generated`, and `new:<branch-name>` with `{number}` substitution all exercised), correlation id, and a bounded delimited untrusted-context excerpt that cannot alter policy or scope.
- [ ] **AC-013**: With Session Defaults → Default Agent set to `project-manager`, post-dispatch verification observes `onSession().agent === 'project-manager'` and marks the run `dispatched`; a simulated mismatch or unreadable agent marks the run `blocked:agent-mismatch` with audit entry and panel warning, and no further automated handling occurs.
- [ ] **AC-014**: A captured network trace shows zero GitHub write requests from the panel or service; no ack reaction, comment, review, or label is ever issued; GitHub writes appear only as agent activity inside its own session.
- [ ] **AC-015**: One correlation id traces a seeded event from checkpoint through policy, dispatch, and agent verification to terminal state, with no token material in any hop; audit records survive a documented uninstall scenario per FR-033/FR-034.
- [ ] **AC-016**: Health renders `serviceStatus()`, per-account identity, per-repo last poll and checkpoint age, per-account rate usage, and agent-pin status; disabling the extension stops polling; closing the panel leaves polling running while OpenChamber runs and stops it when OpenChamber exits.
- [ ] **AC-017**: On an unsupported surface the panel shows the explicit unsupported/disabled state and no subsystem reports healthy while non-operating.
- [ ] **AC-018**: Killing the service process yields `SERVICE_FAILED`, stops polling, preserves all durable state, offers manual retry, and never auto-loops.
- [ ] **AC-019**: Configuration validation blocks production start on any missing scope, unverified account, unresolved project, unapproved service capability, invalid polling setting, or unavailable storage, each reported explicitly; the setup-prerequisites checklist is present and accurate.
- [ ] **AC-020**: No code path deletes sessions, worktrees, or projects; disabling a repository binding stops its polling; cleanup guidance routes the operator to OpenChamber's own surfaces.

## Research and Platform Decisions (referenced, not re-researched)

Settled platform questions are **not** re-researched here. This specification relies on:

| Source | What it settles for this spec |
| --- | --- |
| `specs/001-agent-event-orchestrator/research.md` (canonical, still current) | §a.1 repository-scoped discovery endpoints · §a.2 fine-grained PAT scopes · §a.3 5,000/h limits, per-account pools, budget arithmetic · §a.4 `host.request` header stripping vs. service header control · §a.5 `per_page ≤ 30` truncation trap · §a.6 Notifications rejected · §b.1 host-managed token · §b.2 no per-call agent/model selection, Session Defaults pin, `onSession().agent` verification · §b.3 exactly one `integration` per manifest · §b.4 `listProjects()` only, no project creation · §b.5 no delete APIs · §b.6 `host.storage` limits and uninstall wipe · §b.7 panel lifecycle and OpenChamber-running boundary · §b.8 settings are read-only to the panel · §b.9 guest service transport, loopback auth, environment isolation, advisory permissions, desktop/web-only surfaces |
| `specs/001-agent-event-orchestrator/feasibility-report.md` Q1–Q5 | Provenance and confidence for agent pinning, multi-account constraints, project creation, rate arithmetic, and the service path |
| `specs/001-agent-event-orchestrator/spike-evidence.md` | S1–S7 live verification (2026-09-27), SDK pin `1.24.2`, install path, worktree option behavior, live idempotency and secret-handling confirmation |
| `specs/001-agent-event-orchestrator/contracts/events.md` | Normalized event contract v1 — carries forward unchanged as the reference schema |
| Constitution v1.3.0 | Deployment shape (extension + host-local service), unattended-operation dependency, durable-state standard for audit |

Decisions carried over unchanged from 001's research record: polling over webhooks; dynamic machine identity from `/user`; repository-scoped discovery with no Notifications; extension-first validated by spike; Option B approved over the Option A single-account recommendation.

No new external research was required for this specification: every platform constraint it encodes was already settled with stamped sources in the 001 record.

## Configuration Model

- **Accounts**: service-held credentials keyed by numeric user id, verified logins, expected-login constraints, scope check results.
- **Repository bindings**: account, project id, per-trigger enablement, mention-token override, worktree option, policy profile.
- **Policy**: autonomous default plus per-action approval toggles (start work now; future write gates documented only).
- **Polling**: interval (default 60,000 ms), overlap window (default 10 minutes), `per_page` (≤30), retry/backoff bounds.
- **Retention**: audit and payload retention defaults, configurable within documented bounds.
- **Health**: log level, correlation-id exposure, rate-usage reporting.

The implementation MUST avoid speculative per-provider or per-agent knobs until a supported capability requires them.

## Out of Scope

The following are explicitly **not** part of this feature:

- Discord or any non-GitHub provider.
- Export/restore of configuration or audit data (post-MVP).
- Label triggers, and any trigger outside the FR-015 set.
- Webhook ingress, webhook secrets, delivery acknowledgements, webhook replay (future adapter only).
- Automatic cleanup of sessions, worktrees, or projects (manual cleanup only).
- Docker packaging (may wrap individual pieces later per constitution Principle V; packaging is not the architecture).
- Hosted/multi-tenant operation, billing, or SaaS authentication.
- Any GitHub write by the extension or service — comments, reviews, reactions, acks, merges, closes, labels.
- Merge, deploy, repository administration, or permission changes under any policy.
- Project creation or registration from the extension.
- Per-call agent, model, or variant selection (platform-stripped; not an attemptable feature).
- Direct panel-side `fetch()` to GitHub (undocumented, unsupported).
- GitHub Notifications API as a discovery source.
- Phase 4 plan, data model, contracts, task breakdown, or application implementation.

## Assumptions

- **Worktree default**: per-repository worktree option defaults to `generated` (isolates autonomous work from the operator's working tree); `none` and `new:<branch-name>` are selectable. Both `none` and `generated` were exercised live in the spike; `new:` shares the same host-owned path.
- **Branch-name placeholder**: `new:<branch-name>` supports the single literal placeholder `{number}`, substituted with the source issue/PR number; no other templating exists.
- **Untrusted-context bounds**: ≤4,000 characters per source item and ≤12,000 characters per dispatch, with explicit truncation markers — chosen to stay far below host/service body limits and to keep prompts focused; tunable in planning without a spec change only within ±50%.
- **Retention defaults**: audit entries 180 days or 50,000 entries (whichever is reached first); raw/redacted payload excerpts 30 days; minimal audit references (ids, links, decisions) retained until the operator deletes the account/repository binding. Export/restore remains out of scope (see Gate Questions).
- **Mention token default**: `@<login>` of the bound account, case-insensitive; GitHub logins are case-insensitive, so matching must be too.
- **Agent verification mechanics**: reading `onSession().agent` requires the surface to be attached to the dispatched session, so verification opens the created session (a documented UI context switch). The pinned SDK has no silent alternative; planning MUST verify the exact mechanism against the pinned `dist/*.d.ts` and MUST NOT invent an undocumented one.
- **Service-owned storage durability**: service data written outside `host.storage` is expected to outlive extension uninstall because the host's documented uninstall action kills the service process and wipes extension storage, not third-party files; this MUST be verified in planning and documented before the claim appears in user-facing copy.
- **SDK pin**: `@openchamber/sdk` pinned exactly (spike: `1.24.2`), re-pinned to the host's release before execution if the host is newer (`001/spike-evidence.md` §1).
- **Scale**: fewer than 10 repositories, a handful of accounts, one local OpenChamber installation, one logical service instance; multi-instance leasing is deferred.
- **Provider**: GitHub.com REST API; GitHub Enterprise compatibility requires a later review.
- **Connectivity**: outbound DNS/TLS to GitHub only; no inbound Internet connectivity; OpenChamber's own endpoint is loopback.

## Clarifications

### Session 2026-09-27

All product decisions for this feature were locked by the product owner on 2026-09-27 before specification; each is encoded below as a requirement.

- Q: Which architecture ships — standalone daemon, single-account extension, or extension + host-local service? → A: **"Option B"** — OpenChamber extension (panel) + OpenChamber-hosted local guest service; OpenChamber host owns projects/worktrees/sessions/agents. → FR-001, FR-002, FR-005
- Q: How do N accounts get their credentials, and where do tokens live? → A: Panel paste → one-shot `serviceRequest` handoff → service verifies via `/user` with its own fetch → service persists outside `host.storage` → login returned; panel never retains tokens (transient write-through only, never in ledger/logs/state). → FR-006, FR-007, FR-009
- Q: What gates the secret handoff? → A: A security gate is mandatory: capability approval at install plus explicit in-panel consent describing Phase-1 advisory permissions; approved-but-gated. → FR-008
- Q: How is the single allowed `integration` card used? → A: Declared as an **optional, non-authoritative** host-managed account used only for identity display and an optional read-only diagnostic; never a polling credential; product fully functional while unconnected (proposal documented, confirmation recorded as a non-blocking gate question). → FR-011
- Q: How are repositories added, and are projects created? → A: Add repo → choose account → choose existing project via `listProjects()` picker → per-repo triggers; <10 repos; **no project creation** — picker plus helper guidance only. → FR-013, FR-014
- Q: Which events trigger work, and under which identity? → A: Issue assignment to a configured account identity, PR review request/assignment, comment mentions with a configurable token (default `@login`); agent identity per account discovered via `/user`, numeric id durable, login display-only (001 rules carry over). → FR-015, FR-016, FR-009
- Q: How is dispatch performed, and which agent runs it? → A: `host.startSession()` with issue/PR attachment, worktree option (`none`/`generated`/`new:branch-name`), bounded untrusted context; DEFAULT agent is the operator's Session Defaults → Default Agent (setup: set to `project-manager`); post-dispatch verification via `onSession().agent` with `blocked:agent-mismatch` on failure (fail-closed); no per-call agent/model selection. → FR-028, FR-029, FR-005
- Q: Does the extension acknowledge GitHub activity? → A: **No** — the extension is read-only to GitHub; all comments/reviews/questions are the agent's job inside its session; no ack reactions, silence until the agent responds. → FR-031, FR-032
- Q: Where does state live, given the uninstall wipe? → A: Service durably stores accounts/tokens/config/checkpoints/runs/audit outside `host.storage`; panel UI state in `host.storage` with documented uninstall-wipe semantics; audit bounded; host.storage alone is insufficient for audit (constitution standard); export/restore out of scope. → FR-033, FR-034, FR-035
- Q: What are the polling parameters? → A: 60s default interval, service-side, shared rate budget across repos (per account), `per_page ≤ 30`, no reliance on 304s (usable as an optimization because the service controls headers), 10-minute overlap, durable checkpoints, dedup by delivery key, ~600–1,500 req/h within 5,000/h. → FR-017 through FR-022
- Q: How autonomous is the system? → A: Fully autonomous defaults for authorized actions, with policy toggles per action; future write gates are documentation-only because the extension never writes; merge/deploy/repo-admin never in scope. → FR-027, FR-032
- Q: What are the lifecycle and health expectations? → A: Unattended = OpenChamber running (documented); `serviceStatus()` for service health; disable stops polling; panel displays identity, last poll per repo, rate usage, service status, and agent-pin status. → FR-036, FR-003, FR-038
- Q: Is there any automatic cleanup? → A: **Manual cleanup only** — no session/worktree deletion APIs exist or are used. → FR-040
- Q: What is explicitly excluded? → A: Discord/other providers, export/restore, label triggers, webhook ingress, auto-cleanup, Docker packaging, hosted/multi-tenant. → `## Out of Scope`

| # | Question | Answer | Requirement Added |
|---|----------|--------|-------------------|
| 1 | Architecture | Option B: extension panel + host-local service | FR-001–FR-005 |
| 2 | Multi-account custody | Paste → handoff → `/user` verify → durable service storage; panel never retains | FR-006, FR-007, FR-009 |
| 3 | Secret handoff gate | Capability approval + explicit in-panel consent | FR-008 |
| 4 | Single integration card | Optional, non-authoritative: identity display + read-only diagnostic | FR-011 |
| 5 | Repository onboarding | Account → project picker → triggers; no project creation | FR-013, FR-014 |
| 6 | Trigger set and identity | Assignment, review request/assignment, mention token; numeric-id identity | FR-015, FR-016 |
| 7 | Dispatch and agent pin | `startSession` + worktree option + bounded context; Default Agent + fail-closed verification | FR-028, FR-029 |
| 8 | GitHub write posture | Extension read-only; no ack reactions | FR-031, FR-032 |
| 9 | Durability split | Service owns durable/audit; panel owns wipeable UI state | FR-033–FR-035 |
| 10 | Polling parameters | 60s, service-side, per-account budget, ≤30/page, 10-min overlap, delivery-key dedup, 304 optional | FR-017–FR-022 |
| 11 | Autonomy | Autonomous defaults with per-action toggles; fail-closed on missing policy | FR-027 |
| 12 | Lifecycle and health | OpenChamber-running dependency, `serviceStatus()`, disable stops polling, full health panel | FR-036, FR-038 |
| 13 | Cleanup | Manual only | FR-040 |

## Gate Questions (non-blocking — defaults already encoded)

These do not block specification approval; each has a defensible default written into the requirements above and can be changed by configuration or a minor spec revision.

1. **Audit and payload retention defaults** — encoded: audit 180 days / 50,000 entries, payload excerpts 30 days, minimal references until binding deletion. Confirm or adjust at the phase gate (001 flagged retention as a product-owner decision; export/restore stays out of scope either way).
2. **Single integration card posture** — encoded: declared, optional, non-authoritative (FR-011). Confirm the product owner prefers keeping an optional host-managed card over omitting `contributes.integration` entirely; the alternative is a spec-only change with no architecture impact.
