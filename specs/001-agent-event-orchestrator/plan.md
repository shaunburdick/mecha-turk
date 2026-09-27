# Implementation Plan: Extension-First Agent Event Orchestrator

**Status:** Phase 4 revision; the extension spike is the first implementation gate. No application code is included.

> **001 close-out (2026-09-27):** the spike gate passed (S1–S7) and the product owner approved the Option B extension + OpenChamber-hosted local service path. This plan is retained as the record of the gate that was run. Two pointers: the "Constitution alignment" paragraph below was written against Principle V v1.2.0 ("one self-hosted container") — Principle V is now v1.3.0 (extension + host-local service, no mandated packaging), and no principle was weakened by that amendment; the "Deferred architecture" paragraph describes the standalone Docker fallback, which remains unselected and is deferred in `contracts/daemon-deferred.md`. Production planning happens in `specs/002-agent-event-extension`.

## Decision

Do not commit to a standalone Docker daemon or external OpenChamber bridge before validating the documented OpenChamber extension path. Build the smallest possible panel spike first: one declared GitHub integration, one repository, one matching issue, one `host.startSession()` call, and host-observable project/worktree/session verification. The spike must test panel close, pause/removal, and server-switch behavior. It is a bounded validation, not a hidden production architecture.

If the host lifecycle cannot support unattended polling after the panel closes, stop extension-first implementation. The next path must be explicitly selected from: a documented OpenChamber local service with acceptable lifecycle and credential boundaries, or a separately planned outbound daemon with a documented integration contract. No private route, browser automation, or assumed background panel survives this gate.

## Official surface and concrete stack

The spike uses the documented `@openchamber/sdk` API version 1 and manifest engine floor `>=1.24.0` (verify the installed OpenChamber version before execution). A folder extension contains `package.json`, `panel/index.html`, and bundled IIFE `panel/main.js`; OpenChamber does not build TypeScript on install. Use Bun and `openchamber-guest-bundle` as documented, with TypeScript source only in the spike workspace and committed built output when testing installation.

The extension declares `integration` for GitHub with `apiOrigin: https://api.github.com`, bearer token scheme, and `/user` account display. GitHub PAT attachment is host-managed; the token never reaches panel JavaScript or `ctx`. GitHub requests use `host.request()` only. `host.startSession()` uses `projectId`, an issue item, and `worktree` options; `host.listProjects`, `host.listWorktrees`, `host.listSessions`, `host.onSessionLifecycle`, `host.onProjects`, `host.onWorktrees`, and `host.onSessions` verify host-owned state.

## Lifecycle design

The panel records a small redacted spike ledger in `host.storage` (poll attempt, source issue ID, session result, lifecycle events, panel-generation, and close/reopen timestamps). It must unregister subscriptions and call `dispose()` on teardown. The ledger is evidence only; it is not a durable production queue. The spike compares activity while mounted, after panel close, after extension pause/removal, and after server switch. Host docs state subscriptions are cleared on unmount/pause/removal/server switch, and a panel is not documented as a background worker; the experiment must confirm runtime behavior rather than infer it.

Local services are not used in the first spike. Official docs say services require explicit `service` capability, have a separate lifecycle/status, run with full local access, and do not automatically receive host secrets or host API access; `serviceRequest()` is only a panel-to-service bridge. A service can be considered only in the next gate after a separate credential and lifecycle design review.

## Constitution alignment

Principles I and VII are strengthened by using only documented SDK/provider contracts and leaving projects, worktrees, sessions, and results to OpenChamber. II/III remain product requirements for the eventual orchestrator, but the spike ledger is explicitly not a production durability substitute. IV is met through redacted evidence and correlation IDs. V is temporarily superseded only for validation by an installed extension; no deployment decision is made. VI requires contract/lifecycle/security tests before daemon planning. No constitutional principle is weakened.

## Deferred architecture

The full polling, normalization, checkpoint, policy, audit, retry, retention, and Docker design remains approved as the fallback daemon architecture and preserves 60-second polling, 10-minute overlap, approximately 25 repositories, 30-day detail retention, and one-year audit retention. Its OpenChamber transport is deferred; `contracts/openchamber.md` now describes the extension boundary and records the daemon decision gate rather than inventing an external API.
