# PM Handoff: follow-up delivery rework (issue #48) + SDK 2.3.1 re-pin

- Spec / Plan / Tasks / Constitution: `specs/008-follow-up-delivery/` (spec amendment — Gate 1 closed pass-with-cuts; PO decisions folded in 2026-10-13); plan/tasks not yet created; constitution `.specify/memory/constitution.md`
- Branch: `chore/sdk-2.3.1` → **PR #49 open** (Gate 3 passed + verification proof: verify exit 0, bundles byte-identical) → `008-follow-up-delivery` (PR B, to be created)
- Phase: **Phase 6 implementation** · Completed: spec (approved), plan+tasks (Gate 2 passed with cuts applied, 25 tasks / 4 sequential waves), SDK re-pin PR #49 open · In progress: Wave 1 (T001 fake-host lifecycle harness) · Blocked: none
- Branch: `008-follow-up-delivery` (stacked on `chore/sdk-2.3.1` @ 51dcb2d / PR #49). Phase 6 runs one engineer dispatch per wave; each wave ends verify-green with a commit; pre-PR = spec-alignment + code-quality reviews; PR body carries `Closes #48`.
- Decisions:
  - Follow-up rework judges autonomously (like dispatch); busy target → wait for idle, never toast-and-retry (product owner, 2026-10-13, issue #48).
  - Prefer host queue/steer if guest-reachable; verified NOT guest-reachable in 2.x — the composer queue is UI-only, `prompt({send:true})` while busy is still `SESSION_BUSY`.
  - Idle signal of record: `onSessionLifecycle` (2.x host push; busy/retry → started, idle → completed, late-listener replay) with `ready.session.busy`/`onSession` as fallback.
  - `openSession` remains a view-yank ("opens the chat and closes the page"); `prompt` addresses only the current session — cross-session delivery navigation is the open ideation question for Gate 1 (navigate-once-at-idle vs visible park when target not current).
  - SDK re-pin is PR A (small lane: engineer pass + Gate 3), spec amendment is PR B (full lane). Engine floor goes `>=1.24.0` → `>=2.0.0`.
  - No version bump with the re-pin; `SERVICE_VERSION`/release stay at 0.2.0 until a release decision.
- Next: Gate 3 on PR A diff; Gate 1 (`spec-challenger`) on the spec draft; user approves spec; then plan+tasks → Gate 2 → Phase 6 → Gate 3.
- User preferences: fix mechanism over patching symptoms; SDK upgrade wanted ("we are way behind"); tracking issue #48 on GitHub.
- PO decisions (2026-10-13, both recommendations accepted): **B+ park + auto-rearm** mandated for non-current-target follow-ups (A′ recorded as rejected alternative); **NFR-001 clock arms at detection with observed-target-busy intervals excluded** from the measured window.
- Environment notes: `openchamber session.link` rejected valid payloads 4× with a usage error ("link needs url, title, and kind") — possible host bug, unfixed as of 2026-10-13; link recorded in this file and the issue body instead.
