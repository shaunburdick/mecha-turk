# Quickstart: validating feature 003 (Dispatch Integrity & Recovery)

**Purpose**: the Phase-4/5 runbook — how to build, exercise, and *prove* 003's behaviour offline. Operator-facing install/usage stays in the repository `README.md` and 002's `quickstart.md` (synced by task T-035).

## Prerequisites

- Node ≥ 20.19, `npm ci` (toolchain: TypeScript 6.0.3, vitest 5.0.2, bun via `bunx` for bundling).
- No network, no PAT, no OpenChamber instance: every suite below runs against the fake host (`tests/support/panel.ts`), the loopback service on a temp data dir (`tests/support/service.ts`), and fixture GitHub responses (`tests/support/github.ts`).

## Commands

```sh
npm run verify      # build → lint → typecheck → test — THE gate; run at every wave boundary
npm run build       # rebuilds panel/main.js (IIFE) + service/main.js (ESM) — commit both (invariant 1)
npm test            # full offline suite
npx vitest run tests/crash-permutations.test.ts   # the NFR-102 proof, by itself
npx vitest run tests/service-migration.test.ts    # the upgrade/adoption proof (AC-126)
```

## Validation scenarios (each maps to the spec's measurable outcomes)

1. **One subject, one session** (AC-101, SC-101): `tests/crash-permutations.test.ts` seeds an issue carrying an assignment *and* a body mention through one scan and asserts one run, two source references, one `host.startSession()` — repeated 100×.
2. **Close the panel mid-claim** (AC-106, US2 independent test): claim a run, drive `sweepOnce` past the lease expiry, assert `pending`, attempt 1→2, and a `dispatch.lease-expired` row naming prior state, attempt before/after, and reason.
3. **Close the panel after authorization** (AC-107): reserve, drive the sweep past the result deadline, assert `unconfirmed`, then ten more sweep ticks asserting **no** state change and no re-dispatch.
4. **Waiting burns nothing** (AC-108): `pending` runs through N sweep ticks ⇒ attempts unchanged, no requeue, no dead-letter.
5. **Lost report, remount** (AC-111, US3 independent test): instrument the fake host, kill after `startSession` but before the report, remount ⇒ reconciliation posts the stored outcome first (call order asserted), one session ever exists, repeat adds exactly one `dispatch.duplicate-report` row.
6. **Wiped panel storage** (US3 second scenario): empty `mecha-turk:dispatches` + service-side `unconfirmed` ⇒ zero `startSession` calls; the run offers exactly the two operator resolutions (FR-027).
7. **Stale / second panel** (AC-109, AC-112): expired-lease reserve → `stale-lease`; reserve on a run with a session → `already-dispatched` naming it; the live-lease panel unaffected.
8. **Upgrade from the shipped build** (AC-126, SC-111): `tests/service-migration.test.ts` boots the service against a store written in `pending | in-flight | dispatched` and asserts adoption, intact windows, zero quarantines, one `run.migrated` per run, and a problem-result row rendering `failed` + retryable.
9. **Crash permutation set** (AC-110, NFR-102, SC-102): all ten enumerated permutations ⇒ sessions-per-run ≤ 1 except an explicit operator *no-session* — automated, never a manual checklist.
10. **Explain any run from the product** (AC-115–AC-117, SC-104/105): drive one run through every transition, then retrieve its complete history from `GET /v1/audit?correlationId=` alone; every lifecycle row carries the run's correlation id, every transition's prior/new state and reason present, zero credential occurrences.
11. **Bounded, safe, honest** (AC-120, AC-129, NFR-109): secret scans across every new record and both committed bundles; reference/attempt/list caps asserted; hostile title/reason rendered inert in the run row and the audit view.
12. **Latency** (AC-127, NFR-101): the relay test counts round trips for one dispatch — shipped count + 1 (the reserve).

## Expected output

`npm run verify` ends `Test Files  passing` / `Tests  passing` with **zero failures and zero skipped-for-suppression**, lint clean with **no `eslint-disable`/`@ts-ignore` anywhere**, typecheck clean, and `git status` showing `panel/main.js` + `service/main.js` rebuilt whenever `src/`, `panel/*.ts`, or `service/*.ts` changed.

## Manual walkthrough (operator's OpenChamber, post-merge — operator-gated, recorded not asserted)

Per `AGENTS.md`, live checks are operator-gated: assign an issue *and* mention the account → one session with both reasons visible; close the panel mid-dispatch → reopen → one session with a lease-expiry audit row; open a run's Audit history and reconstruct it under its correlation id. Record results in the PR body; the offline suites remain the executable truth.
