# Deferred Standalone Daemon Boundary

> **Status (2026-09-27): retained evidence, superseded for production purposes.** The extension gate (S1–S7) passed and the product owner approved the extension + OpenChamber-hosted local service path; `specs/002-agent-event-extension` owns all production contracts. This file stays as the record of the daemon boundary that was *not* selected. Nothing here is deleted or redesigned; if a daemon is ever reconsidered, 002 (or a later feature) must open a new contract.

The prior unsupported external OpenChamber bridge is explicitly deferred. No endpoint, private route, CLI scraping, or local worktree fallback is approved. If the extension gate fails, a future plan must obtain an OpenChamber-owned documented bridge specifying authentication, capability/version handshake, dispatch schema, idempotency, lifecycle/result semantics, and security model before daemon implementation.
