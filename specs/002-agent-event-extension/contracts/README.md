# Contracts index — `002-agent-event-extension`

**Date**: 2026-09-27 · **Status**: planning artifacts (phases 4–5)

| File | Role |
| --- | --- |
| [panel-service.md](./panel-service.md) | Binding HTTP contract between panel and local service: loopback transport, `OPENCHAMBER_SERVICE_TOKEN` auth, endpoints (accounts, bindings, relay/dispatch, runs, audit, health, config), limits, error catalog, contract-test invariants |
| [token-handoff.md](./token-handoff.md) | **SECURITY-GATED** credential flow: two-part approval gate, exact handoff sequence, panel-state enter/clear table, redaction rules, failure modes F1–F12, custody rules, reviewer scope. Gate G1 (tasks T-001/T-002) must close before any token code |
| [events-carry-forward.md](./events-carry-forward.md) | Carries 001's `contracts/events.md` (v1) forward as the reference schema; defines the additive v1.1 `Delivery` fields and the dispatch attachment mapping |

## Supersession pointers (what 001 left behind, and where it now lives)

> **Historical-path note (2026-09-28, cleanup review).** The `specs/001-agent-event-orchestrator/` directory was **removed** in commit `110c0a2` when `README.md` and `AGENTS.md` shipped. Every `001/…` path below is a **stamped provenance citation, not a live link** — recover any of them with `git show 110c0a2^:specs/001-agent-event-orchestrator/<file>`. Live replacements: the event schema → [events-carry-forward.md](./events-carry-forward.md); the platform research → `../spec.md` `## Research and Platform Decisions` plus `../research.md` §R1–§R7; the production data model → `../data-model.md`; the spike contracts (`openchamber.md`, `config.md`, `daemon-deferred.md`) → **evidence only**, with their surviving amendments summarised in `../plan.md` and `../spec.md`.

| 001 artifact | Status for 002 |
| --- | --- |
| `001/contracts/events.md` | **Reference schema, carried forward** — see events-carry-forward.md. *File removed 2026-09-28; v1 recoverable from git history at `110c0a2^`* |
| `001/contracts/openchamber.md` | Spike-gate contract, **evidence only**; its amendments 1–4 (camelCase fields, `prompt` capability, kebab-case setting ids, project-picker precedence) remain in force for 002's panel. Production manifest/session flow is defined by 002 `plan.md` + panel-service.md §2.4. *File removed 2026-09-28* |
| `001/contracts/config.md` | Deferred daemon YAML — **not used**; production config = service `config.json` only, plus bindings and accounts — and, since the 2026-09-28 cleanup, **no other configuration surface at all**: there is no environment-file configuration (006 FR-090, FR-091), and since 2026-09-30 there is **no manifest card either** (002 FR-011 re-cut at v1.8.0; the card that briefly carried only `expected-agent` under 002 FR-041 was removed with the install-time credential). The "manifest integration settings" half of the old wording here is superseded by those requirements. *File removed 2026-09-28* |
| `001/contracts/daemon-deferred.md` | Boundary stays deferred; unchanged. *File removed 2026-09-28* |
| `001/research.md` §a/§b | Canonical platform research — cited, never re-researched; new findings only in 002 `research.md`. *File removed 2026-09-28; the findings that bind 002 are restated in `../spec.md`'s research table and FR numbers* |
| `001/data-model.md` (daemon tables) | Historical; production model is 002 `data-model.md`. *File removed 2026-09-28* |
