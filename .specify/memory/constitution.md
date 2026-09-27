# Mecha Turk Constitution

## Core Principles

### I. Polling-first, contract-first integration
External activity is discovered through explicit, versioned provider contracts. The MVP uses outbound polling so it works behind a firewall; providers are adapters, not business logic, and webhook delivery is a future adapter rather than an MVP dependency.

### II. Safe autonomy by default
The product is designed for unattended operation, but autonomy must be bounded by explicit policy, least privilege, scoped repositories, and configurable approval gates. A missing, stale, or ambiguous authorization is a stop condition—not permission to guess.

### III. Durable and idempotent work
Polling is not work completion. Every checkpoint, overlap scan, discovered event, decision, attempt, retry, and terminal outcome is durably attributable and replay-safe. Restarts, clock skew, pagination, and repeated observations must not create duplicate agent work or duplicate external side effects.

### IV. Human-visible auditability
Operators must be able to explain why an event was accepted, ignored, paused, retried, or executed. Secrets never appear in logs. User-facing actions identify the automation and preserve links to source events, sessions, worktrees, and tickets.

### V. Minimal, portable deployment
The default deployment is one self-hosted container with persistent storage and documented network/security requirements. Infrastructure complexity must be justified by a measurable reliability or security need; integrations must not require a proprietary hosted control plane.

### VI. Specification and verification before implementation
Requirements are testable and technology-neutral where practical. Provider behavior, API versions, permissions, failure modes, and uncertainty are documented before code. Tests must cover security boundaries, idempotency, retries, policy gates, and integration contracts.

### VII. Thin orchestration boundary
The service normalizes GitHub activity, evaluates policy, stores durable state, and dispatches work to OpenChamber. Project setup, repository setup, worktrees, agent sessions, workflow execution, questions, and result handling belong to the OpenChamber integration whenever its supported interface provides them; the service must not recreate that harness internally.

## Security and Operational Standards

- Use outbound HTTPS only for MVP GitHub and the configured OpenChamber endpoint. When webhook support is added later, verify signatures against raw request bytes before parsing or dispatching.
- Prefer narrowly scoped credentials. Store secrets outside source control, redact them from logs, and support rotation/revocation without data loss.
- Treat event payloads, issue text, repository content, and agent output as untrusted input. Prompts must preserve source boundaries and may not silently override system policy.
- Provide health/readiness signals, structured logs, correlation IDs, durable cursors, overlap windows, bounded retries with backoff, dead-letter/manual replay, and safe shutdown behavior.
- All external writes and agent-triggering actions must be policy-checked and auditable.

## Development Quality Gates

- Strict type checking and linting are mandatory; suppressions require a documented, reviewed exception.
- Unit tests cover deterministic routing and policy logic; contract tests cover GitHub polling, credential/permission behavior, and the documented OpenChamber boundary; future webhook adapters will add signature-verification tests; end-to-end tests cover representative GitHub issue and PR flows.
- No implementation begins until the constitution and feature specification are approved. Planning and tasking are separate gated phases.
- Compatibility-sensitive external APIs must be pinned or version-detected. OpenChamber capabilities must be adapter-abstracted and checked at runtime; unsupported operations must fail safely rather than being reimplemented through private APIs.

## Governance

This constitution is the project authority for phases 1–6. A feature specification may add constraints but may not weaken these principles without an explicit constitutional amendment. Amendments require a version bump, rationale, migration impact, and user approval. Every plan and review must state its constitution alignment and identify exceptions.

**Version**: 1.2.0 | **Ratified**: 2026-09-26 | **Last Amended**: 2026-09-26
