# Tasks: Extension-First Agent Event Orchestrator

No task is started in phases 4–5. `[P]` marks safe parallel work. The first implementation gate is the extension spike; daemon work is conditional and must not start early.

## Wave 0 — extension spike gate

- [x] T001 Record the OpenChamber build/version and pin a compatible `@openchamber/sdk` version; verify official manifest `apiVersion: 1`, engine floor, and current install behavior. **Pinned `1.24.2` exactly in both manifests; `apiVersion: 1` and the `>=1.24.0` engine floor verified against the official SDK parser/helpers (offline).** *Blocked: the OpenChamber host build/version and folder-install behavior are PENDING LIVE VERIFICATION — `spike-evidence.md` §1/§4.1.*
- [x] T002 Create the minimal local extension harness with `package.json`, panel HTML, TypeScript source, bundled IIFE output, and no service/filesystem capability; verify installation from an absolute folder path. **Depends on T001.** **Built (`extension/panel/main.js`, classic IIFE) and asserted by `tests/bundle.test.ts`; manifest declares no service/files/background capability.** *Blocked: absolute-folder installation is PENDING LIVE VERIFICATION — `spike-evidence.md` §4.1.*
- [x] T003 [P] Add a panel test ledger format using `host.storage`, correlation IDs, redaction assertions, and explicit mounted/closed/paused/removed/server-switch phases. **`extension/src/ledger.ts` + `tests/ledger.test.ts` (round-trip, schema validation, truncation, credential stripping, gap verdicts).**
- [x] T004 [P] Document the test repository, one issue matching rule, expected project ID, worktree option, and PAT setup without committing credentials. **`spike-runbook.md` §1–§4 + `.env.example` (PAT line commented out, `.env*` ignored).**
- [x] T005 Implement the declared GitHub integration flow using `host.request()` for `/user`, one repository issue list, and issue detail; verify host-managed token attachment and matching identity. **Depends on T002/T004.** **`extension/src/github.ts` + `matching.ts` covered by `tests/github.test.ts`/`tests/matching.test.ts`.** *Blocked: live host-managed token attachment is PENDING LIVE VERIFICATION — `spike-evidence.md` §4.2.*
- [x] T006 Implement one normalized issue evidence record and one `host.startSession()` call with project ID, issue attachment, worktree option, and bounded context. **Depends on T005.** **`evidence.ts` + `panel-dispatch.ts` covered by `tests/evidence.test.ts`/`tests/session.test.ts`.** *Blocked: the live `startSession()` result is PENDING LIVE VERIFICATION — `spike-evidence.md` §4.3.*
- [x] T007 Verify host-owned project/worktree/session behavior with `listProjects`, `listWorktrees`, `listSessions`, `onProjects`, `onWorktrees`, `onSessions`, and `onSessionLifecycle`; record partial bootstrap failures and never manipulate a worktree locally. **Depends on T006.** **`session.ts` + `host-verify.ts` covered against a fake host in `tests/session.test.ts`.** *Blocked: live snapshots are PENDING LIVE VERIFICATION — `spike-evidence.md` §4.4.*
- [x] T008 Execute lifecycle experiment while mounted, after panel close, after pause/removal, and after server switch; record whether polling continues or is unloaded using ledger/session evidence. **Depends on T003/T007.** **Plan and execution hooks implemented (`lifecycle.ts`, mount/`pagehide` hooks, `analyzeLastCloseGap` verdicts) and unit-tested.** *Blocked: the live L1–L5 execution is PENDING LIVE VERIFICATION — `spike-evidence.md` §4.5.*
- [ ] T009 Run the exact spike acceptance checklist S1–S7 from `quickstart.md`, publish evidence and a pass/fail decision, and stop implementation at the gate. **Depends on T008.** *BLOCKED: `spike-evidence.md` §4.6 publishes the checklist with every live item marked PENDING LIVE VERIFICATION; the pass/fail decision cannot be taken until an operator completes §4.1–§4.5 on a live OpenChamber instance with a GitHub PAT.*

## Wave 1 — decision after spike (choose exactly one path)

- [ ] T010 If S6 demonstrates reliable unattended monitoring, update the approved architecture to extension-first and define production lifecycle, storage, multi-repository limits, and user approval UX before implementation.
- [ ] T011 If S6 fails or is unproven, document the failure and obtain product approval for the next path; do not use a hidden panel worker or undocumented host mechanism. **Depends on T009.**
- [ ] T012 [P] If a host local service is proposed, research its documented service manifest/lifecycle, explicit permissions, secret provisioning, and service-to-host limitations; produce a separate contract and security gate. **Depends on T011.**
- [ ] T013 [P] If a standalone daemon is proposed, carry forward the approved GitHub polling/data/policy design and obtain an OpenChamber-owned documented dispatch contract before implementation. **Depends on T011.**

## Conditional Wave 2 — only after path approval

- [ ] T014 Implement only the approved production path’s configuration and credential lifecycle; preserve dynamic PAT identity, read permissions, autonomous defaults, and secret redaction.
- [ ] T015 Implement GitHub repository streams, overlap/checkpoints, normalization, deduplication, rate handling, and tests from the approved fallback design if the daemon path is selected.
- [ ] T016 Implement policy, audit, retries, dead letters, replay, and security tests for the approved runtime.
- [ ] T017 Implement OpenChamber dispatch/session integration only through the approved documented extension/service/bridge contract; add capability and idempotency tests.
- [ ] T018 Add end-to-end issue/PR flows, restart/lifecycle tests, retention tests, Docker or extension packaging validation, and AC mapping.

## Dependencies and stop conditions

T001–T009 are the complete first gate and must precede all production implementation. T010 and T011 are mutually exclusive decisions based on the evidence. T012/T013 are research/contract tasks, not permission to implement both paths. T014–T018 cannot start without an approved path and contract. Private UI routes, undocumented external APIs, direct local worktrees, and secret handoff to a service remain prohibited.
