# PM Handoff: Dispatch rename instruction (amends 004)

- Spec / Plan / Tasks / Constitution: `specs/004-starting-prompt/spec.md` (FR-030, AC-152), `specs/004-starting-prompt/changelog.md` (v1.5.0), `specs/004-starting-prompt/ac-status.md`, `.specify/memory/constitution.md` — plan/tasks: none (Small lane: engineer pass + Gate 3)
- Branch: `fix/session-rename-line` · Commits: `b3bede5`, `97f797c`, `8e39d85`, plus this file
- Phase: Pre-PR · Completed: intake; root cause (OpenChamber titles guest sessions `<attach id> <attach title>`, so sidebar rows read `mt-run-<24hex> …`); self-rename capability proven live on `ses_ece04166dffe01vEBf9uL5KYoD`; size gate; user approval (option a); engineer pass; Gate 3 round 1 PASS (cut list dispositioned); **design pivot** (user option a — rules line supersedes direct command); engineer revision; Gate 3 round 2 PASS; round-2 cut list applied; verify green (1580 tests / 120 files) · In progress: PR preparation · Blocked: none
- Decisions:
  - **Rules-based pure-literal frame line, zero interpolation** — shipped: `Rule: name this session "Issue #n: <subject>" (PRs: "PR #n: <subject>"), ~60 chars; if its name already fits, leave it.` The pivot dissolved Gate 3 NOTE 1 (untrusted title as grammatical object of a trusted imperative) structurally rather than by quoting patch.
  - Determinism of the sidebar title **explicitly traded away** after measuring that no machine-facing consumer reads it (audit/ledger/service key off the correlation id).
  - No correlation/attachment-id format change — invariant 10 wire contract untouched.
  - No upstream OpenChamber request (user choice b); host title composition left as-is.
  - Fail-open: no panel-side rename, no verification/read-back, no enforcement/retry.
  - `pm-handoff.md` kept over Gate 3 round-1 cut (provenance precedent: 003's became the recorded scope source for 004–006).
  - Comment trims applied per Gate 3 round 1 + round 2 cut lists; changelog quote corrected to shipped bytes.
  - Follow-up frames carry no rename line (rule asked once at dispatch) — challenger NOTE: not stated in spec; parked as accepted behavior, reversible if ever wanted (the wording is idempotent).
- Next: push branch, open PR, link it to this session; CI's required checks (`verify (node 24)`, `verify (node 24.15.0)`, `build`) gate the merge; operator-gated live check = the next real dispatch shows a readable sidebar name.
- User preferences: cheapest lane that answers the ask; sidebar scannability is the goal; determinism traded only where nothing consumes it; demo session `ses_ece04166dffe01vEBf9uL5KYoD` renamed live to `Issue #41: De-tax the test suite`.
