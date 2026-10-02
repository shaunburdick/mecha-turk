# Contracts index — `003-dispatch-integrity`

**Feature**: `specs/003-dispatch-integrity` · **Spec**: v1.3.0 · **Date**: 2026-09-28 · **Status**: binding for Phase 6; the *semantics* are fixed by the specification (`## Wire Surface Delta`), the field names, status codes, and error codes below are this Phase-4 contract work, exactly as that section delegates them.

These files specify **only what changes on the panel↔service wire** (or between the panel and its own durable record). Transport rules, auth, body/size caps, the error envelope, and every unchanged operation stay in 002's [panel-service.md](../../002-agent-event-extension/contracts/panel-service.md) and are not restated here.

| File | Covers |
| --- | --- |
| [claim-lease.md](./claim-lease.md) | `GET /v1/events/pending` as a **run claim**: lease semantics, holder, claim eligibility, projection of a claimable run |
| [dispatch-authorization.md](./dispatch-authorization.md) | Reserve, Result, Abandon, Block report, Verification, Retry, Requeue (dead-letter return), Resolve — the run-scoped operations, their bodies, refusals, and the error-code additions |
| [reconciliation.md](./reconciliation.md) | Mount-time reconciliation: ordering, idempotency, bounds, the panel's durable attempt record |
| [run-history-audit.md](./run-history-audit.md) | `GET /v1/events` run projection (widened) and the new `GET /v1/audit` correlation-filtered read |

## Supersession pointers

1. **002 contract §2.4 (long-poll `/v1/dispatches` with leases, `/v1/runs/:runKeyHash/*`) is superseded.** That surface was never built in the MVP cut (003 `## Wire Surface Delta`, final paragraph), and 003's table is now its replacement: the lease semantics 003 requires are implemented over the existing claim-and-report shape under `/v1/events*`. 002 §2.4's rows about `dispatch-result`, `verification`, `approval`, `reconcile`, `retry` map as follows — `dispatch-result` → **Result** below; `verification` → **Verification report** below; `retry` → **Retry** below (run-scoped, widened sources); `reconcile` → replaced by [reconciliation.md](./reconciliation.md) (report-based, no separate attach-id probe — 003 `## Assumptions`: the panel's own record is the reconciliation source); `approval` → not built (003 `## Out of Scope`: policy gates remain documentation-only).
2. **002 contract §2.5 `GET /v1/runs*` / `GET /v1/deliveries`** were never built; the run history is `GET /v1/events` (path retained per 005's confirmed L3 deferral), and the audit read arrives here as `GET /v1/audit` — the row 002 §2.5 already specified.
3. **002 contract §4 error catalog** gains the codes listed in [dispatch-authorization.md](./dispatch-authorization.md) §Error codes; no existing code changes meaning.
4. **The `Status` operation is not touched** — 003's `## Wire Surface Delta` row is superseded by 005 (v1.2.0 record).

## Co-ship assumption (read first)

The panel and the service are **one committed bundle** (AGENTS.md invariant 1): `panel/main.js` and `service/main.js` ship together, and OpenChamber never mixes builds of the two halves. Therefore:

- the `:id` path segment's **namespace changes from delivery id (`evt-…`) to run correlation id (`mt-run-…`)** on the operations that already exist — same paths, new identity, called out per operation below. No third-party client exists to break, and contract §1's `/v2` rule is about published API stability, not about one panel talking to its own service.
- new **response members are additive**; where a member is *renamed* this contract says so, and none is renamed in v1 — the claim and history answers keep their `events` array name while the entries inside become run rows (deliberately, to keep the change additive; 005 keeps `/v1/events*` as well).
- a request from the *other* direction (an old panel id posted to a new service) answers `404 not-found`, never a state change.

## Universal rules for every operation in this directory

1. **Fail closed** (003 FR-003): any ambiguity — unknown run, unknown token, mismatched attempt, unreadable state — is a refusal with a distinct `code` and a secret-free `message`, never a partial apply; every refusal writes an audit row naming the cause.
2. **Correlation echo** (FR-051): a body or answer that concerns a run carries the run's `correlationId`; the service persists exactly the value it was given and never mints one for a caller; a caller that does not know the id gets a refusal, never a fresh id.
3. **Staleness axes** (plan D7): `reserve` is bound by the **lease**; `result`/`abandon` are bound by the **token** (unknown / consumed-with-a-different-outcome / superseded by a newer attempt). Details and the full matrix are in [dispatch-authorization.md](./dispatch-authorization.md).
4. **Clock discipline** (NFR-112): no request carries a time that participates in a lease, expiry, or deadline decision. Bodies carry identifiers and attempts; the service reads its own clock only.
5. **Credential-free** (NFR-106): every body, answer, and error in this directory is scanned by the existing secret suites; `dispatchToken` is an authorization artifact (`dtk-…`), never a credential, and no operation echoes a token-shaped *credential* under any status code.
6. **Rendered fields** (NFR-109): every string these operations return reaches the DOM through the panel's existing non-HTML path; hostile titles, repository names, state reasons, and correlation ids render as text.
