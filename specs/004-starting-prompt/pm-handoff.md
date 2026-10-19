# PM Handoff: Dispatch rename instruction (amends 004/002)

- Spec / Plan / Tasks / Constitution: `specs/004-starting-prompt/spec.md` (FR-030), `specs/004-starting-prompt/changelog.md`, `specs/002-agent-event-extension/spec.md` (FR-028 judgment), `.specify/memory/constitution.md` — plan/tasks: none (Small lane: engineer pass + Gate 3)
- Branch: `fix/session-rename-line`
- Phase: Implement (engineer pass) · Completed: intake, root-cause (host titles guest sessions `<attach id> <attach title>`), rename-capability probe (agent self-rename works), size gate, user approval (option a) · In progress: engineer dispatch · Blocked: none
- Decisions:
  - Option 4 only — a trusted frame line instructing the agent to self-rename; user declined any upstream OpenChamber request (option b)
  - No correlation-id/attachment-id format change — invariant 10 wire contract untouched
  - Session name format `Issue #<n>: <title>` / `PR #<n>: <title>` (matches existing linked-issue titles)
  - Idempotent wording — the frame is shared, a repeated frame must be a harmless no-op; no follow-up-specific branch
  - Fail-open — no panel-side rename, no verification/read-back, no enforcement; non-compliance = status quo
  - Budget: +~80 chars against the 12,000 bound (worst case ≈7,700) — no budget redesign; `budgetFloorProblem` untouched
- Next: Gate 3 diff challenge on the branch diff; then Pre-PR close-out (update this file, task/spec status); operator-gated live check = the next real dispatch's session shows a readable sidebar name
- User preferences: cheapest lane that answers the ask; sidebar scannability is the goal; session `ses_ece04166dffe01vEBf9uL5KYoD` was renamed live as proof and now carries the decided format — revert or edit freely
