# Acceptance status: 003 Dispatch Integrity & Recovery

**Feature**: `specs/003-dispatch-integrity` · **Spec**: v1.5.0 · **Recorded**: 2026-09-29 (Wave 8, T-036)

Per-AC status for **AC-101 – AC-129**, written as the final gate's record and
kept small enough to paste into the pull-request description. Every "met" line
points at the suite that proves it; all of them run offline in `npm run
verify` (no live OpenChamber instance, no real PAT, no network).

| AC | Status | Evidence |
| --- | --- | --- |
| AC-101 | met | `tests/crash-permutations.test.ts` — 100 dual-trigger trials (half with both triggers in one scan, half with the mention in a later scan) each produce one run, one session, and two named references; coalescing itself is `tests/service-run-enqueue.test.ts`, the "+N more reasons" row is `tests/dispatches.test.ts` |
| AC-102 | met | `tests/service-run-enqueue.test.ts` (a delivery after a terminal run opens the next ordinal; one while it is open joins it) + `tests/audit-vocabulary.test.ts` and `tests/dispatches.test.ts` (a reference that arrived after authorization is marked as possibly unseen) |
| AC-103 | met | `tests/service-run-enqueue.test.ts` — "coalesces a pull-request assignment and review request under the PR subject": one run, two references |
| AC-104 | met | `tests/service-events.test.ts` (delivery ids byte-identical to the shipped format; a replayed id queues nothing) + `tests/service-sweep-honesty.test.ts` |
| AC-105 | met | `tests/session.test.ts` (delimited, bounded excerpt with a marker per cut source) + `tests/relay-integrity.test.ts` (200 references held inside FR-014's 12,000-character budget) |
| AC-106 | met | `tests/service-sweep.test.ts` and `tests/service-run-wire.test.ts` (expiry requeues with prior state, attempt before/after, and reason) + `tests/crash-permutations.test.ts` "close after claim" |
| AC-107 | met | `tests/service-sweep.test.ts` (ten ticks leave `unconfirmed` untouched) + `tests/crash-permutations.test.ts` "close after authorization" |
| AC-108 | met | `tests/service-sweep.test.ts` (a waiting run burns nothing) + `tests/crash-permutations.test.ts` "close before claim" |
| AC-109 | met | `tests/service-run-authorize.test.ts` (the refusal matrix: stale-lease / already-reserved / already-dispatched) + `tests/crash-permutations.test.ts` "stale result" and "slow panel" |
| AC-110 | met | `tests/crash-permutations.test.ts` — every enumerated permutation asserts sessions-per-run ≤ 1 except an explicit operator *no-session*; the cross-chain replay fence is `tests/service-run-operations.test.ts` |
| AC-111 | met | `tests/reconcile.test.ts` (reconcile before the first claim, idempotent repeat, bounded failure warns) + `tests/crash-permutations.test.ts` "lost result" |
| AC-112 | met | `tests/service-run-authorize.test.ts` (a second authorization is refused; an existing session is named) + `tests/service-run-wire.test.ts` |
| AC-113 | met | `tests/service-run-operations.test.ts` (retry under the same run key, references and prior attempts preserved) + `tests/dispatches.test.ts` (a failure is never toned as a success) + `tests/crash-permutations.test.ts` "operator retry" |
| AC-114 | met | `tests/service-run-authorize.test.ts` (block report) and `tests/relay-integrity.test.ts` (guard refusals post `blocked`, never a result) + `tests/project-picker.test.ts` (no project-creation call exists) |
| AC-115 | met | `tests/audit-vocabulary.test.ts` (all sixteen vocabulary entries present with their required `details`) + `tests/service-audit-read.test.ts` (one run's chain reconstructs in order; prior state and cause on the rows that record a transition — claim/reserve/result name their hop, and the vocabulary's hop→state table supplies the pair) |
| AC-116 | met | `tests/audit-vocabulary.test.ts` (no lifecycle row carries a fresh uuid) + `tests/service-audit-read.test.ts` (every row is byte-identical to the run's correlation id) |
| AC-117 | met | `tests/service-audit-route.test.ts` (correlation filter, pagination, entries verbatim) + `tests/service-audit-read.test.ts` (one query reconstructs the run) + `src/audit-view.ts` (the operator's surface) |
| AC-118 | met | `tests/service-audit-route.test.ts` and `tests/service-audit-read.test.ts` — poll/consent/credential rows keep their own identifiers and never match a run's filter, while the run's own detections still do |
| AC-119 | met | `tests/service-audit-read.test.ts` — a simulated `appendLine` failure leaves the durable state standing, answers `auditWritten:false`, puts the run's id in the panel warning, and writes the service's structured log line |
| AC-120 | met | `tests/bundle.test.ts` (T-033: every new surface scanned with the project's own detector, no HTML sink in either bundle or on a 003 field) + `tests/redaction.test.ts` (the dispatch token survives redaction byte-identically) + `tests/audit-vocabulary.test.ts` |
| AC-121 | met | `tests/project-picker.test.ts` — the "not listed?" affordance names all three routes, the binding stays recoverable, and the static scan finds zero project-creation calls |
| AC-122 | met | `tests/prerequisites.test.ts` — all six prerequisites with state and remediation, the Default Agent pin reads *not checkable*, and an unmet checkable item raises a notice |
| AC-123 | met | `tests/dispatches.test.ts` — every state renders with a label and a reason line, and the affordance table offers an action only where the service accepts one (retry / resolve / return to waiting) |
| AC-124 | met | `tests/session.test.ts` (project, worktree option, attachment id = correlation id, bounded excerpt) + `tests/relay-integrity.test.ts` (the host is called with the run's id) |
| AC-125 | met | `tests/agent-verify.test.ts` (matched → `agent.verified`; mismatch/unreadable → `agent.mismatch` with a warning and no state change) + `tests/service-run-operations.test.ts` + `tests/dispatch-end-to-end.test.ts` |
| AC-126 | met | `tests/service-migration.test.ts` — T-005's mapping cases and T-030's full upgrade script: every row adopted, windows byte-identical, zero quarantine files, one `run.migrated` per run, the shipped problem result rendered `failed` and retryable, dispatched rows still terminal |
| AC-127 | met | `tests/relay-integrity.test.ts` — one dispatch's detection-to-session timeline is the shipped round trip (the claim) plus exactly one more: the reserve. Round trips are counted, per the plan's risk register; no wall-clock assertion runs in CI |
| AC-128 | met | `tests/bundle.test.ts` — every module under `src/` and `service/` is scanned, a GitHub API reference appears only in the three read-only gateways, no gateway builds a non-GET method, and the patterns carry bite-checks; `tests/project-picker.test.ts` covers the host surface |
| AC-129 | met | `tests/relay-integrity.test.ts` (T-034: reference, attempt-history, recorded-attempts, and run-history caps each exercised past the cap) + `tests/service-claim-bounds.test.ts` + `tests/dispatch-record.test.ts` + `tests/service-run-history.test.ts` |

**Deferred**: nothing in AC-101 – AC-129. Items the spec defers by name —
verification-to-blocking, retention/export, dedupe-index eviction, the
`requeueBudget` config field, multi-instance leases — sit in
`spec.md ## Out of Scope` and are not acceptance criteria here.

**Final gate**: `npm run verify` green (build → lint → typecheck → test),
both committed bundles rebuilt with the wave, `SERVICE_VERSION` still mirroring
`package.json` `0.0.1`, zero suppressions and no `any` introduced, and
`tests/dispatch-end-to-end.test.ts` walking one dispatch the whole way round —
claim → guards → reserve → `host.startSession()` → result → acknowledged →
verification — against the loopback service and its durable store.
