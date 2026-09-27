# Contracts index — `002-agent-event-extension`

**Date**: 2026-09-27 · **Status**: planning artifacts (phases 4–5)

| File | Role |
| --- | --- |
| [panel-service.md](./panel-service.md) | Binding HTTP contract between panel and local service: loopback transport, `OPENCHAMBER_SERVICE_TOKEN` auth, endpoints (accounts, bindings, relay/dispatch, runs, audit, health, config), limits, error catalog, contract-test invariants |
| [token-handoff.md](./token-handoff.md) | **SECURITY-GATED** credential flow: two-part approval gate, exact handoff sequence, panel-state enter/clear table, redaction rules, failure modes F1–F12, custody rules, reviewer scope. Gate G1 (tasks T-001/T-002) must close before any token code |
| [events-carry-forward.md](./events-carry-forward.md) | Carries 001's `contracts/events.md` (v1) forward as the reference schema; defines the additive v1.1 `Delivery` fields and the dispatch attachment mapping |

## Supersession pointers (what 001 left behind, and where it now lives)

| 001 artifact | Status for 002 |
| --- | --- |
| `001/contracts/events.md` | **Reference schema, carried forward** — see events-carry-forward.md |
| `001/contracts/openchamber.md` | Spike-gate contract, **evidence only**; its amendments 1–4 (camelCase fields, `prompt` capability, kebab-case setting ids, project-picker precedence) remain in force for 002's panel. Production manifest/session flow is defined by 002 `plan.md` + panel-service.md §2.4 |
| `001/contracts/config.md` | Deferred daemon YAML — **not used**; production config = service `config.json` + manifest integration settings (panel-service.md §2.1) |
| `001/contracts/daemon-deferred.md` | Boundary stays deferred; unchanged |
| `001/research.md` §a/§b | Canonical platform research — cited, never re-researched; new findings only in 002 `research.md` |
| `001/data-model.md` (daemon tables) | Historical; production model is 002 `data-model.md` |
