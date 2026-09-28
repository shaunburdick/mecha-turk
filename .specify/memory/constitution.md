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

### V. Minimal, self-hosted deployment
The default deployment is self-hosted inside the operator's own OpenChamber environment: a documented extension (panel) plus, where the design requires it, an OpenChamber-hosted local service, with persistent storage and documented network/security requirements. Infrastructure complexity must be justified by a measurable reliability or security need, and integrations must not require a proprietary hosted control plane. Packaging is a means, not the architecture: no specific container or process format is mandated, a container may still wrap individual pieces later where it measurably simplifies operation, and deployment must remain portable across any conforming OpenChamber installation.

### VI. Specification and verification before implementation
Requirements are testable and technology-neutral where practical. Provider behavior, API versions, permissions, failure modes, and uncertainty are documented before code. Tests must cover security boundaries, idempotency, retries, policy gates, and integration contracts.

### VII. Thin orchestration boundary
The orchestrator normalizes GitHub activity, evaluates policy, stores durable state, and dispatches work to OpenChamber. Project setup, repository setup, worktrees, agent sessions, workflow execution, questions, and result handling belong to the OpenChamber integration whenever its supported interface provides them; the orchestrator must not recreate that harness internally. Where the orchestrator itself is split across an OpenChamber extension and an OpenChamber-hosted local service, each half stays within the same boundary: the extension and service orchestrate, the host harness executes.

## Security and Operational Standards

- Use outbound HTTPS only for MVP GitHub and the configured OpenChamber endpoint. When webhook support is added later, verify signatures against raw request bytes before parsing or dispatching.
- Prefer narrowly scoped credentials. Store secrets outside source control, redact them from logs, and support rotation/revocation without data loss.
- Treat event payloads, issue text, repository content, and agent output as untrusted input. Prompts must preserve source boundaries and may not silently override system policy.
- Provide health/readiness signals, structured logs, correlation IDs, durable cursors, overlap windows, bounded retries with backoff, dead-letter/manual replay, and safe shutdown behavior.
- All external writes and agent-triggering actions must be policy-checked and auditable.
- Unattended operation depends on the operator's OpenChamber installation running. Polling and dispatch stop when OpenChamber stops, when the extension is disabled, or when its local service is not running; this dependency must be documented, surfaced as health/status, and never masked by an undocumented background mechanism.
- Durable state must match the storage it actually lives in. State that survives reload but is erased on extension uninstall (for example host extension storage) is not a sufficient home for audit history; checkpoints, runs, and audit records must live in storage whose retention the operator controls and can back up.

## Development Quality Gates

- Strict type checking and linting are mandatory; suppressions require a documented, reviewed exception.
- Unit tests cover deterministic routing and policy logic; contract tests cover GitHub polling, credential/permission behavior, and the documented OpenChamber boundary; future webhook adapters will add signature-verification tests; end-to-end tests cover representative GitHub issue and PR flows.
- No implementation begins until the constitution and feature specification are approved. Planning and tasking are separate gated phases.
- Compatibility-sensitive external APIs must be pinned or version-detected. OpenChamber capabilities must be adapter-abstracted and checked at runtime; unsupported operations must fail safely rather than being reimplemented through private APIs.

## Governance

This constitution is the project authority for phases 1–6. A feature specification may add constraints but may not weaken these principles without an explicit constitutional amendment. Amendments require a version bump, rationale, migration impact, and user approval. Every plan and review must state its constitution alignment and identify exceptions.

## Amendment History

### v1.3.0 — 2026-09-27 (submitted for product-owner approval with the 001 close-out)

- **Rationale**: Principle V described the deployment target as "one self-hosted container," which was accurate for the fallback daemon architecture the project started with. The 001 spike (S1–S7, passed 2026-09-27) and the product owner's subsequent "Option B" decision replace that target with an OpenChamber extension plus an OpenChamber-hosted local service, self-hosted within the operator's own OpenChamber environment. Principle V was factually obsolete, not violated, so it was rewritten to state what it was actually protecting — minimal, self-hosted, no proprietary control plane, portable — rather than a packaging format that is no longer the architecture.
- **Principles reviewed, unchanged in substance**: I (polling-first, contract-first) is unaffected — discovery is still outbound polling over documented contracts. II (safe autonomy), III (durable and idempotent), IV (human-visible auditability), and VI (specification and verification before implementation) were re-read against the extension-plus-service reality and still apply without amendment; none was weakened.
- **Principles adjusted**: VII (thin orchestration boundary) gained one clarifying sentence — when the orchestrator is split across an extension and a host-local service, both halves remain orchestration and the OpenChamber host remains the harness. The Security and Operational Standards gained two entries capturing genuine operational changes: unattended operation now requires OpenChamber (and its service, if any) to be running, and durable state must account for host storage that is wiped on extension uninstall.
- **Migration impact**: no approved requirement is invalidated. Feature specs that referenced a single container deployment (for example 001's FR-035, NFR-005, AC-012) keep their recorded wording as historical evidence; the production spec `specs/002-agent-event-extension` is the surface where deployment-shape requirements are restated against this version. Plans and checklists that cite Principle V must quote v1.3.0 rather than the container phrasing.
- **Approval status**: Approved 2026-09-27 by product owner.

**Version**: 1.3.0 | **Ratified**: 2026-09-26 | **Last Amended**: 2026-09-27
