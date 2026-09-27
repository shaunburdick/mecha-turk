# Feature Specification: Agent Event Orchestrator MVP

**Feature Branch**: `001-agent-event-orchestrator`  
**Created**: 2026-09-26  
**Last Updated**: 2026-09-26  
**Version**: 1.2.0  
**Status**: Approved v1.2.0; extension-first spike added as the next gated milestone  
**Dependencies**: None (new project)  
**Input**: Product-owner decisions for a thin GitHub event orchestrator whose OpenChamber-native extension path is validated before any standalone daemon.

## Problem Statement

An OpenChamber-hosted agent needs a durable event body that can discover GitHub activity without requiring inbound firewall exposure. The MVP must poll configured repositories using a securely supplied machine-account PAT, identify mentions, issue assignments, and pull-request review requests/assignments, normalize and deduplicate them, evaluate policy, persist run/audit state, and dispatch work through OpenChamber. Polling must remain correct across overlap, pagination, rate limits, outages, restarts, and repeated observations without Mecha Turk taking ownership of harness operations.

## Goals and Scope

The approved fallback MVP is one self-hosted Docker deployment with outbound HTTPS to GitHub and a configured OpenChamber boundary. Before that fallback is implemented, the next milestone is an OpenChamber-native extension spike using only documented host APIs. The eventual system supports:

- New issue/PR comments mentioning the configured machine-account identity.
- Issues assigned to that identity.
- Pull-request review requests and assignments for that identity.
- Repository-scoped polling with durable cursors/checkpoints, overlap windows, IDs/timestamps, deduplication, rate-limit handling, retry/backoff, and restart recovery.
- Configurable approval gates, auditability, and dispatch of project-manager-led work/review through OpenChamber.

The next implementation gate is an OpenChamber-native extension spike before any standalone Docker daemon. The spike is intentionally narrow: a panel uses only documented SDK APIs to authenticate to GitHub, poll one configured repository for one matching issue, call `host.startSession()`, verify project/worktree/session behavior, and test monitoring after the panel closes.

Inbound webhooks, Discord, hosted multi-tenancy, autonomous merge/deploy, and arbitrary automation scripts are deferred or out of scope.

## User Scenarios & Testing

### User Story 1 — Discover and work an assigned issue (Priority: P1)

As a repository maintainer, I assign an issue to the configured machine account so that the service discovers it during polling and dispatches controlled agent work through OpenChamber without an inbound webhook.

**Independent Test**: Seed a configured repository with a new assignment, run the poller through a checkpoint boundary, and observe one durable work run and one OpenChamber dispatch or an explicit blocked state.

**Acceptance Scenarios**

1. **Given** a configured repository and the machine account is assigned, **When** polling observes the assignment, **Then** the service records the source ID/time, classifies it as `work`, evaluates policy, and dispatches the request to OpenChamber with the configured project reference and workflow settings.
2. **Given** an assignment is observed again inside the overlap window, **When** deduplication runs, **Then** no second run or OpenChamber dispatch is created.
3. **Given** the OpenChamber project reference is absent or invalid, **When** the assignment is observed, **Then** the run is durably blocked and no agent work starts.

### User Story 2 — Discover and review an assigned/requested PR (Priority: P1)

As a maintainer, I request a review from or assign a PR to the machine account so that the service polls the repository and dispatches a review through OpenChamber with the observed PR context.

**Independent Test**: Seed a review request/assignment, poll it, and verify a `review` run records the observed head SHA/base ref and dispatches through OpenChamber.

**Acceptance Scenarios**

1. **Given** a matching PR review request or assignment, **When** it is discovered, **Then** the service passes base/head metadata and configured project/workflow references to OpenChamber; OpenChamber manages the session/worktree as supported.
2. **Given** the PR head changes before processing, **When** the service re-fetches it, **Then** it detects SHA drift, pauses the run, and requires a new configured trigger rather than silently reviewing a different commit.
3. **Given** a review result and external writes are allowed, **When** OpenChamber reports completion, **Then** the service records the result and dispatch outcome; any GitHub write is performed only through the supported OpenChamber workflow or an explicitly supported integration action.

### User Story 3 — Discover an explicit mention (Priority: P1)

As a maintainer, I mention the configured machine-account identity in a new issue or PR comment so that the next repository poll turns the request into agent work.

**Independent Test**: Add a new comment containing the configured identity mention, poll across the comment cursor/overlap boundary, and verify one routed run.

**Acceptance Scenarios**

1. **Given** a newly created comment containing the configured mention in an allowlisted repository, **When** polling discovers it, **Then** the comment is normalized as an untrusted explicit request and routed through the same policy gates as assignment work.
2. **Given** an edited, deleted, bot-authored, or non-matching comment, **When** it is observed, **Then** it is ignored or audited as non-actionable and never triggers from deleted content.

### User Story 4 — Operate safely behind a firewall (Priority: P1)

As a self-hosting operator, I provide the machine-account credential and configure repositories, polling, mappings, and policy so the service operates with outbound HTTPS only and survives restarts.

**Independent Test**: Run the container without an inbound public listener, interrupt it during polling and agent execution, restart it with its persistent volume, and verify checkpoint recovery, bounded re-observation, auditability, and no duplicate work.

**Acceptance Scenarios**

1. **Given** a valid credential and outbound HTTPS access, **When** the configured poll interval elapses, **Then** each repository poll advances its durable checkpoint only after the fetched page/window is safely recorded.
2. **Given** a timeout, rate limit, or GitHub outage, **When** polling fails, **Then** the prior safe checkpoint is preserved, retry/backoff state is recorded, and no events are skipped.
3. **Given** default policy and fully authorized activity, **When** a matching event is discovered, **Then** work starts without approval; configured gates pause the affected action until an auditable approval.

## Functional Requirements

### Polling and event discovery

- **FR-001**: The system MUST poll only explicitly configured GitHub repositories and MUST require a valid, securely supplied credential before enabling production polling.
- **FR-002**: The system MUST use the authenticated GitHub PAT identity as the machine account used for matching and API reads/writes, verify the authenticated user ID/login at startup, and support an optional explicit login override only as a validation constraint; no account name may be hardcoded in configuration or code.
- **FR-003**: The system MUST use outbound HTTPS for GitHub API calls and MUST NOT require inbound webhook exposure, public ingress, or webhook configuration for the MVP.
- **FR-004**: For each repository and polling stream, the system MUST persist a durable checkpoint containing the endpoint/filters, last safely observed item ID and timestamp, pagination position where applicable, conditional-request validators such as ETag/Last-Modified where supplied, poll time, and credential/account scope.
- **FR-005**: The system MUST poll with a configurable overlap window (default 10 minutes) behind the last timestamp and MUST deduplicate by stable provider identity plus repository/account scope; ID-only cursors MUST NOT be treated as sufficient for all streams.
- **FR-006**: The system MUST process paginated results completely or retain the prior safe checkpoint; it MUST not advance past an unprocessed page or partially persisted response.
- **FR-007**: The system MUST discover, at minimum, these event classes: (a) new issue/PR comments mentioning the authenticated machine-account identity, (b) issues assigned to that identity, and (c) PR review requests or assignments for that identity.
- **FR-008**: The system MUST distinguish newly observed comments from edits and MUST fetch the current source object before execution; deleted, inaccessible, or ambiguous source content MUST not trigger new work.
- **FR-009**: The system MUST use conditional requests (`ETag`/`If-None-Match` or `Last-Modified`/`If-Modified-Since`) where supported, honor `X-Poll-Interval`, paginate within provider limits, and avoid unnecessary concurrent requests.
- **FR-010**: The system MUST honor GitHub primary/secondary rate-limit signals, retry-after/reset headers, network timeouts, and transient 5xx responses with bounded exponential backoff and jitter. It MUST expose the next poll/retry time and preserve the safe checkpoint.
- **FR-011**: The system MUST recover polling schedules and checkpoints after restart, resume from the overlap window, and audit any replayed observations as duplicates or previously processed items.
- **FR-012**: The system MUST allow a controlled operator rescan/replay from a chosen timestamp without weakening deduplication or changing the original source identity.
- **FR-013**: The system MUST fail closed for unconfigured repositories, identity mismatch, invalid/expired credentials, unsupported API responses, and ambiguous event classification.

### GitHub authentication and API limitations

- **FR-014**: The MVP MUST document the machine-account credential type, scope, rotation, storage, and revocation procedure. A fine-grained PAT is the preferred initial credential when its repository and organization policy permits it.
- **FR-015**: A fine-grained PAT MUST be validated against the exact endpoint matrix before activation. Expected minimum repository permissions are `Metadata: read`, `Issues: read` for issue/comment/assignment discovery, `Pull requests: read` for PR and requested-reviewer discovery, and `Contents: read` only if the service passes repository metadata to OpenChamber; `Issues: write` and `Pull requests: write` are not required by the thin service unless a supported OpenChamber operation explicitly needs them. The service MUST report missing permissions rather than silently downgrade behavior.
- **FR-016**: The specification MUST treat the Notifications API as unavailable for the chosen fine-grained PAT: current GitHub documentation states notification endpoints support classic PAT authentication and do not work with fine-grained PATs or GitHub App tokens. Notifications therefore MUST NOT be the MVP discovery source.
- **FR-017**: The GitHub adapter MUST use repository-scoped polling instead: issue comments ordered by stable ID/time, repository issue/assignment data, PR requested-reviewer/assignment data, and detail fetches as needed. Exact endpoint selection and API-version compatibility MUST be isolated in the adapter and verified during planning/testing.
- **FR-018**: The service MUST treat the machine account as a bot identity with no user-interactive approval assumption; every external write remains subject to local policy gates and audit.
- **FR-019**: Webhook support, webhook signature verification, and webhook delivery replay are deferred to a future provider adapter. No MVP requirement may depend on webhook headers, delivery IDs, or inbound acknowledgements.

### Project, worktree, and agent orchestration

- **FR-020**: The system MUST maintain a per-repository project reference and workflow settings for OpenChamber and MUST block when the reference is absent or invalid; automatic project creation is delegated to OpenChamber when its supported interface allows it.
- **FR-021**: The next implementation milestone MUST dispatch the spike's normalized issue request through the documented OpenChamber extension SDK, preserving repository identity, source issue, project reference, workflow context, policy decision, and correlation ID; OpenChamber owns project lookup, repository setup, worktree lifecycle, sessions, questions, and result handling.
- **FR-022**: The primary MVP integration path MUST remain an OpenChamber-native extension using `connectHost()`, a declared GitHub integration with `host.request()`, and `host.startSession()` plus documented project, worktree, session, and lifecycle APIs. No private UI route, undocumented external API, or direct worktree management is permitted.
- **FR-023**: A standalone Docker daemon and any external OpenChamber dispatch adapter are deferred until the extension spike demonstrates that the documented extension lifecycle can or cannot support unattended polling. If a daemon remains necessary, its transport MUST be separately documented and capability-checked; unsupported operations MUST block safely.
- **FR-024**: The system MUST pass the project-manager role and applicable spec-driven workflow to OpenChamber through configured workflow settings; it MUST not implement the project-manager workflow itself.
- **FR-025**: The system MUST persist only the normalized run, dispatch, capability, and audit references needed for reconciliation; OpenChamber remains the source of truth for sessions, worktrees, project state, questions, and results.
- **FR-026**: The system MUST treat ticket text, repository files, API payloads, agent messages, and generated instructions as untrusted data and delimit them so they cannot change system policy, credentials, approval requirements, or tool scope.
- **FR-027**: Clarification questions and result publication MUST be requested through OpenChamber when supported and policy allows; otherwise the run MUST be blocked or held for operator action.
- **FR-028**: The system MUST NOT autonomously merge, close, deploy, modify repository settings, alter permissions, or create arbitrary branches outside the configured OpenChamber workflow.
### Approval, security, and operations

- **FR-029**: The system MUST provide configurable gates for dispatching work, requesting questions/results through OpenChamber, and future write/merge actions. The default MUST be no approval for fully authorized MVP dispatches.
- **FR-030**: Every policy decision MUST record policy version, actor/source, requested action, decision, timestamp, and reason. Missing policy MUST fail closed for that action.
- **FR-031**: The system MUST keep an append-only logical audit trail for polls, checkpoints, observations, routing, credential identity (never token), OpenChamber dispatches/capability results, approvals, retries, failures, and terminal outcomes. Payload retention MUST be redacted or retention-limited by configuration.
- **FR-032**: Credentials MUST be supplied through documented environment/file-secret configuration, excluded from logs/status/error bodies, and rotatable without destroying event history. MVP does not require encryption at rest.
- **FR-033**: The system MUST provide liveness/readiness health, structured logs, correlation IDs, metrics/counters for polls/observations/runs/retries/failures, and operator-visible status including checkpoint age, next poll, and OpenChamber capability/health state.
- **FR-034**: The system MUST support graceful shutdown, bounded queue/resource limits, restart recovery, and manual replay of dead-lettered observations with duplicate protection.
- **FR-035**: If the post-spike daemon path is approved, the system MUST ship as one self-hostable Docker image/deployment with persistent-volume, outbound-network, backup/restore, upgrade, and secret requirements documented. Neither the spike nor the daemon path requires an inbound webhook listener.
- **FR-036**: The system MUST document retention defaults and provide deletion/redaction controls without deleting minimal audit references required to explain a run.
- **FR-037**: Configuration validation MUST detect missing/incompatible GitHub permissions, repository configuration, polling settings, OpenChamber endpoint/auth/workflow settings, and storage/health settings before production operation.
- **FR-038**: Before standalone daemon implementation, the project MUST complete a documented extension spike for one repository and one matching issue using only documented SDK APIs and a declared GitHub integration; the spike MUST record project, worktree, session, lifecycle, credential, and panel-close behavior.
- **FR-039**: The extension spike MUST determine whether polling continues after the panel is closed, paused, removed, or the OpenChamber server switches. It MUST not assume a panel is a durable background process. If monitoring stops, the next milestone MUST be an explicitly approved documented host/service or daemon path.

## Non-Functional Requirements

- **NFR-001 Reliability**: After any successful poll checkpoint commit, every item in the covered result/window is either durably recorded for processing or durably recorded as ignored/duplicate; a crash before commit causes only bounded overlap reprocessing.
- **NFR-002 Polling correctness**: Replaying the same repository window 100 times produces no duplicate run or OpenChamber dispatch, or duplicate idempotent external write.
- **NFR-003 Polling efficiency**: The service honors provider poll intervals, uses conditional requests where supported, paginates safely, and exposes request/rate-limit telemetry; default polling frequency MUST be configurable rather than hard-coded.
- **NFR-004 Security**: Invalid/missing credentials, identity mismatch, unauthorized repositories, disallowed writes, and untrusted-content policy violations fail closed; secrets are absent from logs and audit exports.
- **NFR-005 Availability**: A single container restart with its persistent volume recovers checkpoints and pending runs without a full manual rescan.
- **NFR-006 Network isolation**: MVP operation requires outbound HTTPS to GitHub and the configured OpenChamber endpoint only; no inbound Internet connection is required.
- **NFR-007 Observability**: An operator can trace a source observation through checkpoint, routing, policy, OpenChamber dispatch/capability state, retries, and writes using one correlation identifier.
- **NFR-008 Maintainability**: GitHub polling and OpenChamber dispatch are adapter boundaries with contract/capability tests; future webhook support can be added without changing routing/policy semantics.

## Configuration Model

Configuration is intentionally small and conceptually consists of:

- **GitHub connection**: PAT source, API host/version, authenticated identity validation, and optional login override.
- **Repositories**: allowlisted repository list, per-repository trigger enablement, and OpenChamber project reference/workflow reference.
- **OpenChamber**: endpoint, authentication source, supported workflow/agent settings, and capability-check behavior.
- **Policy**: autonomous default, approval gates, allowed event classes, and external-action limits.
- **Polling**: schedule, overlap window, page size/limits, and retry/backoff policy.
- **Storage/retention**: durable state location and redaction/retention settings.
- **Health/operations**: health exposure, logging/metrics, replay, and shutdown behavior.

The implementation MUST avoid speculative per-provider or per-agent knobs until required by a supported capability.

## Key Entities

- **MachineAccount**: GitHub user ID/login discovered from the PAT, optional expected-login constraint, credential reference, allowed scopes, and rotation status.
- **RepositoryBinding**: GitHub repository identity, polling streams/settings, allowlist status, project location, and policy profile.
- **PollingCheckpoint**: Repository/stream cursor, timestamp, overlap, page/validator metadata, safe-commit time, retry state, and next poll time.
- **Observation**: Immutable normalized provider fact with source endpoint, stable source ID, source timestamp, payload/reference, and discovery/checkpoint correlation.
- **Run**: Stable work/review request derived from an observation, policy decision, lifecycle state, attempts, and source links.
- **OpenChamberDispatch**: Request, endpoint/capability version, project/workflow references, dispatch ID/status, and blocked reason when unsupported.
- **Approval**: Requested action, policy, requester, decision, expiry, and audit reference.
- **AuditEntry**: Append-only record of polling, security, routing, orchestration, external writes, and lifecycle events with redaction metadata.

## State and Failure Semantics

Polling checkpoints are `uninitialized`, `active`, `backing_off`, `stale`, `blocked`, or `disabled`. Observations are `discovered`, `ignored`, `duplicate`, `queued`, `processing`, `waiting_approval`, `waiting_clarification`, `retrying`, `blocked`, `completed`, or `dead_lettered`. A checkpoint advances only after its fetched page/window is durably represented. A manual rescan creates new observation attempts under the same stable source identity. Authorization, identity, permission, policy, and unsupported-capability failures block; transient network, 5xx, and rate-limit failures retry with backoff. OpenChamber remains authoritative for project, worktree, session, question, and result lifecycle.

## Edge Cases

- Clock skew or delayed GitHub indexing: overlap by timestamp and deduplicate by repository/account/source ID.
- IDs are not globally ordered across endpoints: keep endpoint-specific cursor state and timestamp overlap; never assume a single global cursor.
- Pagination is interrupted: retain the previous checkpoint and repeat the full safe window.
- Comment edits/deletions occur between discovery and execution: re-fetch, compare identity/version, and do not execute deleted content.
- Assignment is removed after discovery: re-check current assignment before external writes and record the discrepancy.
- PR head is force-pushed: detect SHA drift and pause for a new trigger.
- Same issue is observed through assignment and mention: normalize to a deterministic run key and avoid duplicate work while preserving both source references.
- Token lacks a required fine-grained permission or organization approval: mark the stream blocked and explain the exact capability without exposing the token.
- Notifications endpoint returns unsupported authentication: use repository-scoped streams; never silently fall back to an unbounded user notification scan.
- Rate limit or secondary abuse response: preserve checkpoint, obey reset/retry guidance, and expose delayed status.
- OpenChamber is unavailable or lacks a requested capability: retry transient connection errors; otherwise block safely with context preserved and no local harness fallback.
- Storage is unavailable: report not-ready and refuse to claim durable progress.

## Acceptance Criteria

- **AC-001**: A valid machine-account PAT is verified against the authenticated GitHub identity; a missing credential or optional-login mismatch prevents production polling, and no account name is hardcoded.
- **AC-002**: A configured repository poll discovers a new mention, assignment, and PR review request/assignment from repository-scoped API data and classifies each correctly.
- **AC-003**: Each polling stream persists cursor/timestamp/ID, overlap, pagination, validators, last successful poll, retry/backoff, and next-poll state; restart resumes safely.
- **AC-004**: A failed or interrupted page/window does not advance the safe checkpoint, and the subsequent overlap scan recovers all eligible observations.
- **AC-005**: Repeated observations, cross-stream duplicates, and a 100-times replay produce no duplicate run or OpenChamber dispatch, or duplicate idempotent external write.
- **AC-006**: Conditional requests, provider poll intervals, pagination, rate-limit resets, bounded backoff, and dead-letter/manual replay are demonstrated by contract/integration tests.
- **AC-007**: Notifications API is not required; the documented fine-grained PAT limitation is enforced and repository-scoped polling is used instead.
- **AC-008**: Issue work and PR review runs record the configured OpenChamber project/workflow reference, observed PR SHA where applicable, dispatch/capability result, policy, and audit trail—or an explicit blocked state; Mecha Turk does not create or own a worktree.
- **AC-009**: Default autonomous policy starts authorized work; configured gates pause and resume only after auditable approval.
- **AC-010**: Restart during polling, queued, processing, approval, and clarification states recovers without silent loss or duplicate side effects.
- **AC-011**: Logs/status/audit include correlation IDs, checkpoint age, next poll, and OpenChamber capability state, but no credential values or sensitive secret material.
- **AC-012**: A single-container deployment operates with persistent storage and outbound HTTPS only; no inbound webhook endpoint is required or configured.
- **AC-013**: Webhook functionality is absent from MVP acceptance tests and explicitly documented as a future adapter.
- **AC-014**: A local OpenChamber extension can be installed from a documented folder path, approved with only declared capabilities, authenticate to GitHub through host-managed token attachment, poll one configured repository, detect one matching issue, and invoke `host.startSession()` with the configured project and issue attachment.
- **AC-015**: The spike records `startSession()` result fields, lists the target project/worktrees/sessions, observes lifecycle events, and verifies whether OpenChamber creates or reuses the expected project/worktree/session without Mecha Turk manipulating a worktree.
- **AC-016**: The spike explicitly closes the panel and tests monitoring at multiple intervals; it reports whether polling continues, stops, or is paused/removed, with evidence from durable extension storage or an observable host session. No result is inferred from an open panel.
- **AC-017**: If panel-close monitoring is not supported, the phase gate rejects unattended extension operation and approves only the next documented path (host local service if its lifecycle/credential boundaries satisfy requirements, or a separately planned daemon); no undocumented background mechanism is introduced.

## Research Findings and Decisions (2026-09-26)

1. **Polling decision**: GitHub recommends webhooks over polling, but also documents efficient polling when webhooks cannot be used: fixed schedules, `X-Poll-Interval`, authenticated conditional requests, and avoiding unnecessary concurrency. The product-owner firewall constraint makes polling the MVP choice.
2. **Machine account**: The PAT's authenticated GitHub user is the machine identity and API identity. The service must verify `/user` identity at startup and use that identity for matching and writes; an optional login override is only a validation constraint. A machine-account PAT is simpler for this single self-hosted deployment than an App installation flow.
3. **Fine-grained PAT capability**: Current GitHub endpoint documentation indicates fine-grained PAT support for repository issue/comment reads, issue reads, PR reads, and corresponding write operations when needed. The exact endpoint matrix must be checked because organization approval and endpoint-specific permissions can still constrain access. Baseline expected permissions are stated in FR-015; missing permissions block rather than downgrade.
4. **Notifications limitation**: GitHub’s current REST Notifications documentation states notification endpoints only support classic PAT authentication and do not work with fine-grained PATs or GitHub App tokens. Notifications also represent user notification threads rather than a complete repository event log. They are therefore explicitly rejected as the MVP discovery source.
5. **Repository-scoped strategy**: Poll issue comments, repository issues/assignment data, PR requested-reviewer/assignment data, and detail endpoints with endpoint-specific cursors, timestamp overlap, stable IDs, pagination, ETags/Last-Modified, and bounded rate-aware scheduling. This is more request-intensive than Notifications and has a detection-latency/rate-budget tradeoff that must be measured during planning.
6. **API rate limits**: Authenticated GitHub requests have materially higher limits than anonymous requests, but primary and secondary limits still apply. Conditional 304 responses can avoid primary-rate consumption when correctly authorized; the service must still honor poll intervals and backoff signals.
7. **OpenChamber boundary**: Current official docs document an extension SDK (`connectHost`, declared integrations, `host.request`, `host.startSession`, project/worktree/session listing, lifecycle subscriptions, and persistent extension storage) and an OpenChamber-managed GitHub integration. They do not document a standalone external work-request API. The extension path is therefore the first gated validation; any external bridge remains deferred. Private UI routes and direct worktree management are prohibited.
8. **Webhooks**: Webhook signature verification and delivery semantics remain future-adapter concerns. No inbound listener, webhook secret, or delivery ID is needed for MVP operation.

## Decisions Needing Product-Owner Review at Phase Gate

- Confirm the default polling interval and overlap window. The specification defaults overlap to 10 minutes but leaves frequency deployment-configurable because repository volume and latency expectations affect rate usage.
- Confirm whether `Issues: write` and `Pull requests: write` should be enabled in the initial PAT even when approval gates may pause public comments/reviews, or whether MVP starts read-only and enables writes explicitly later.
- Confirm acceptable detection latency and repository count for the first deployment; repository-scoped polling has a higher API request cost than webhooks/Notifications.
- Confirm retention duration for raw/redacted poll responses and ticket/PR bodies used for replay.

## Out of Scope

- Inbound GitHub webhooks, webhook secrets, delivery acknowledgements, and webhook replay; future adapter only.
- GitHub Notifications API as an MVP event source.
- Discord or any non-GitHub provider.
- Hosted multi-tenant control plane, billing, or SaaS authentication.
- Autonomous merge, deployment, repository administration, permission changes, or arbitrary shell orchestration.
- Implementing OpenChamber's harness or depending on private UI APIs; direct local worktree/session management. A standalone external OpenChamber bridge is deferred pending extension-spike results and a separately documented contract.
- Phase 4 plan, technology-specific data model, API contracts, task breakdown, or application implementation.

## Assumptions

- The operator can supply a machine-account PAT, grant it access to each configured repository, and approve fine-grained PAT organization access where required.
- GitHub.com REST API is the initial provider target; GitHub Enterprise compatibility requires a later review.
- The service has outbound DNS/TLS connectivity to GitHub and the configured OpenChamber endpoint, but does not need inbound Internet connectivity.
- A durable local database/file store is available through the container persistent volume.
- One logical orchestrator instance runs initially; safe multi-instance polling leases are deferred.
- GitHub repository APIs expose sufficient IDs/timestamps to implement endpoint-specific overlap and deduplication; any endpoint limitation blocks that stream rather than silently reducing correctness.

## Clarifications Applied

- **2026-09-26**: MVP changed from webhook-first to outbound polling-first for firewall-compatible self-hosting.
- **2026-09-26**: The PAT-authenticated GitHub user is dynamically the machine identity and API identity; any explicit login is optional validation only.
- **2026-09-26**: Durable per-repository/per-stream checkpoints, overlap windows, IDs/timestamps, validators, pagination, deduplication, rate-limit handling, backoff, and restart recovery are mandatory.
- **2026-09-26**: Notifications API is rejected for MVP because current documentation limits it to classic PAT authentication; repository-scoped polling is required instead.
- **2026-09-26**: MVP network requirement is outbound HTTPS only to GitHub and OpenChamber; inbound webhooks are deferred.
- **2026-09-26**: OpenChamber is the primary harness integration; project/worktree/session/workflow/question/result operations are passed through its supported boundary rather than managed by Mecha Turk.
- **2026-09-26**: Secrets remain outside committed configuration and are redacted from logs/status; encryption at rest is not an MVP requirement.
- **2026-09-26**: Autonomous-by-default configurable policy gates, project/workflow references, auditability, and safe failure semantics are preserved.
- **2026-09-26**: Product owner directed an OpenChamber-native extension spike before committing to a standalone Docker integration boundary; panel lifecycle and unattended monitoring are explicit acceptance gates.
