# PM Handoff: Agent Event Extension (002)

## Context
- **Spec**: specs/002-agent-event-extension/spec.md (v1.0.0, APPROVED 2026-09-27)
- **Plan**: specs/002-agent-event-extension/plan.md (APPROVED)
- **Tasks**: specs/002-agent-event-extension/tasks.md (35 tasks, 11 waves, 2 gates — APPROVED)
- **Constitution**: .specify/memory/constitution.md (v1.3.0, APPROVED)
- **Branch**: `001-agent-event-orchestrator` (local-only, no remote)
- **Orchestration state**: specs/002-agent-event-extension/orchestration.md

## Current State
- **Phase**: Phase 6 (implementation), Waves 0+1 dispatched
- **Completed**: 001 spike (S1–S7 PASS, superseded); constitution v1.2.0→v1.3.0; research consolidation; spec 002 v1.0.0; plan; tasks
- **In Progress**: T-001 security audit of contracts (security-auditor); T-003–T-006 service core (modern-architect-engineer)
- **Blocked**: T-007–T-009 blocked by G1 (closes after T-001/T-002)

## Decisions Made
- Architecture: OpenChamber extension (panel) + hosted local service (Option B, multi-account)
- Extension read-only to GitHub; agent owns all GitHub write-back
- Agent pinning: `expected-agent` setting (default `project-manager`) + `openSession()` verification, fail-closed `blocked:agent-mismatch`
- Token handoff panel→service is approved but G1-gated (security review first)
- Service data dir: default `~/.config/openchamber/mecha-turk/` (Option 1 deviation, documented + health-surfaced)
- Retention: audit 180d/50k entries, payload excerpts 30d; export/restore post-MVP
- Poll: 60s default, service-side, per_page ≤ 30, shared rate budget ≤1,500 req/h
- Manual cleanup; no project creation; picker-only; desktop/web only (no VS Code/mobile services)
- Persistence: service durable store for accounts/audit; host.storage for panel UI state (uninstall-wipe documented)

## Next Steps
1. Complete T-001→T-002, close G1, checkpoint with product owner
2. Complete Wave 1 service core, wave-close verify, checkpoint
3. Continue wave-by-wave per tasks.md; user confirmation after each wave
4. T-033/T-034 live gates need operator's OpenChamber (record host build version)
5. T-035 confirms retention + integration-card gate questions with product owner

## User Preferences
- Product owner approves at every wave gate; autonomy default = no approval for agent actions
- Silence until agent responds (no ack reactions)
- <10 repos, N accounts, panel-centric UX (Accounts/Repos/Runs tabs)
- Conventional commits with AI attribution; never push/merge (no remote anyway)
