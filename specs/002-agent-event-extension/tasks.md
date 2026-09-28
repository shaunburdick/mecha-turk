# Tasks: MVP — Agent Event Extension (re-cut 2026-09-27)

**Bar: "works reliably for me, self-hosted." Validate the loop live BEFORE hardening.**
Rules for this cut: build the missing product loop; tests only where they keep us honest about the loop working; no review waves; no remediation loops (debt list instead); existing hardened service code stays as-is — we do not remove or refactor it.

## What's already built (no tasks — do NOT re-touch)
- Service: spawn/HTTP/auth, durable store 0600/0700, account verify/persist/rotate, consent, throttles, status (T-003–T-009 + remediations, 429 tests green)
- Spike panel: polling, matching (assigned issues), evidence, dispatch to host.startSession + worktree options, project picker, lifecycle (proven live S1–S7)

## Slice 1 — Minimal working loop (validate TODAY)
- [x] **M1** Service minimal poll loop: poll bound repos' issues on interval (reuse existing github client), detect issue assignment to a bound account → enqueue event. Simple in-memory/file state; no checkpoint architecture. **(the main engine piece)** *(commit ad052da)*
- [x] **M2** Relay: panel long-poll (single endpoint ok) or simple interval fetch of pending events from service; lease optional (dedupe by event id is enough for one panel). *(commit ad052da)*
- [x] **M3** Repos tab: add repo (owner/name) → account picker → project picker → triggers checkboxes (assignment, mention) → enabled toggle. Panel storage. **(the missing UI piece)** *(commit ad052da)*
- [x] **M4** Wiring: panel receives event → dispatch (reuse spike dispatch + picker + worktree option + PM prompt) → mark event dispatched in service. *(commit ad052da)*
- [x] **M5** Live validation on operator's OpenChamber: create account, bind 1 repo w/ project, assign an issue, see PM session start in a worktree. Record what breaks. *(VALIDATED 2026-09-28: two issues → two worktree sessions; full loop live. Fixes during M5: repos pane mount, accounts assign, adopt-on-duplicate, scan status surface, events parser round-trip, first-scan replay (product decision).)*

## Slice 2 — Complete MVP (after slice 1 proves)
- [ ] **M6** Mentions trigger (comment scan for `@<login>`, bot-author ignored)
- [ ] **M7** Review-request trigger (PRs requested as reviewer for the account)
- [ ] **M8** Runs list UI (recent events, state, link to session) + manual "dispatch failed → retry"
- [ ] **M9** Agent verification after dispatch (openSession read-back → warn if not project-manager) — keep simple, no blocked-state machinery

## Debt list (post-MVP hardening — do NOT do now)
From Wave-2 reviews (input-clear fix, mirror scopeCheck, copy drift, O(1) audit seq, projection reads, invariant-1 test gaps, hostile-DOM test, throttled rotation test, 502/reasonClass ratifications); checkpoint durability; rate budget controller; policy profiles; retention; export/restore; multi-account E2E polish; T-036 shared/redaction move.

## Stopped/cancelled
- Wave 2 remediation wave (T-009k–q) — partially done (k,l,m,n,o committed pre-interrupt), remainder folded into debt list above.
- Reviewer-per-wave cadence. Contract-amendment-on-every-deviation cadence.
