# Data Model

SQLite timestamps are RFC3339 UTC text and provider IDs are strings. Secrets are never columns.

## Extension spike evidence (host storage, not production state)

While the lifecycle gate was pending (it closed 2026-09-27 with S1–S7 PASS), the only planned persistence was a bounded JSON ledger in the extension's `host.storage` namespace. Each `SpikeEvidence` record contains `schema_version`, `correlation_id`, phase (`mounted|closed|paused|removed|server_switched`), repository/issue IDs and URL, discovered login (never token), detection time, panel generation, `startSession` result fields, lifecycle events, and host snapshot references. It contains no Authorization header, PAT, or unrestricted issue body. The ledger is evidence for the gate and is deleted with the extension; it must not be mistaken for durable orchestrator state.

## In-memory configuration

`GitHubConfig` (API origin/version, credential reference, expected login, timeout); `RepositoryBinding` (provider ID, owner/name, enabled streams, project/workflow references, policy profile); `OpenChamberConfig` (endpoint, auth reference, adapter version, capabilities); `PolicyConfig` (event classes, autonomous dispatch, approvals, forbidden actions); `PollingConfig` (interval, overlap, page size, concurrency, backoff); `RetentionConfig` and `OperationsConfig` (database, health, queue, shutdown).

Validation requires HTTPS origins, resolvable secret refs, bounded nonzero durations, overlap less than retention, enabled bindings with project/workflow refs, and rejects unknown fields.

## Tables

- `machine_accounts`: provider, unique account ID, login, expected login, credential reference, permission snapshot, validated time, status. Never token material.
- `repository_bindings`: unique repository ID, owner/name, enabled, project/workflow refs, policy version, timestamps.
- `polling_checkpoints`: key `(repository_id, stream)`; query fingerprint, last ID/time, overlap start, page, ETag/Last-Modified, safe commit/poll/next times, retry/error, state (`uninitialized|active|backing_off|stale|blocked|disabled`), account ID.
- `observations`: UUID, unique `(provider, account, repository, source_type, source_id)`, source time, stream, kind, redacted payload/reference, correlation ID, state (`discovered|ignored|duplicate|queued|processing|waiting_approval|waiting_clarification|retrying|blocked|completed|dead_lettered`).
- `runs`: UUID, unique deterministic run key, observation/source links, kind (`work|review`), repository, base/head refs, project/workflow, policy decision/version/reason, state/attempt/lease/error/correlation. `run_observations` links multiple triggers.
- `openchamber_dispatches`: unique idempotency key, run, adapter/capability snapshot, request hash, status, external ID, redacted response ref, attempts/next attempt/timestamps. No session/worktree state.
- `approvals`: run/action, policy, requester, decision, expiry, reason, audit reference.
- `audit_entries`: append-only timestamp, category, actor/source, action/decision/reason, correlation/entity refs, redacted details, retention class (`detailed_30d|audit_1y|minimal`).
- `dead_letters`: run/observation, failure class, redacted error, attempts, created/replayed times and replay correlation.

## Invariants and transitions

Checkpoint advances only in the transaction that durably represents its full page/window. Stable source facts cannot create two runs or dispatches. Dispatch key is deterministic from run key and adapter version. Secret values and auth headers are excluded from logs/audit.

Checkpoint: uninitialized→active; transient→backing_off→active; auth/permission/unsupported→blocked; operator→disabled. Observation: discovered→ignored/duplicate/queued→processing→completed/retrying/waiting/blocked/dead_lettered. Run approval/clarification returns to queued only after valid decision; SHA drift, missing project, forbidden policy, and unsupported capability block.
