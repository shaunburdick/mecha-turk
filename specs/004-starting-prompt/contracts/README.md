# Contracts index — `004-starting-prompt`

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.1.0 · **Date**: 2026-09-28 · **Status**: binding for Phase 6; the *semantics* are fixed by the specification (`## Dispatch Message Composition`, `### Audit Vocabulary Delta`, FR-010–FR-054) and the field names, refusal copy, and detail keys below are this Phase-4 contract work, exactly as that section delegates "the exact field names of the machine-readable envelope" to Phase 4.

These files specify **only what changes on the panel↔service wire** (or in the store document the wire serves). Transport rules, auth, body/size caps, the error envelope, and every unchanged operation stay in 002's [panel-service.md](../../002-agent-event-extension/contracts/panel-service.md) and 003's [contracts/](../../003-dispatch-integrity/contracts/) and are not restated here.

| File | Covers |
| --- | --- |
| [binding-prompt.md](./binding-prompt.md) | `startingPrompt` on the binding document: `GET`/`PUT /v1/bindings` semantics (omission-preserves), the four refusals and their envelope, the store-file quarantine reason, and the `binding.prompt-updated` audit row |
| [dispatch-prompt.md](./dispatch-prompt.md) | The snapshot on the wire: claim-answer members, the run-history projection trio, the four audit detail scalars, the attachment `data` scalars, and the composition's byte-identity and budget rules |

## What amends what (read before implementing)

1. **002 contract §2.3 (bindings)** — extended, not replaced: the whole-file `PUT /v1/bindings` the shipped code implements (the per-binding `PATCH`/`POST` rows of §2.3 were never built — 002's MVP-DEBT) gains the field and the omission-preserves rule in [binding-prompt.md](./binding-prompt.md). The `422 validation` envelope of §1/§4 is unchanged; no new error code is added.
2. **003 contract [claim-lease.md](../../003-dispatch-integrity/contracts/claim-lease.md)** — `ClaimedRun` gains four members (`promptPresent`, `promptFingerprint`, `promptLength`, `promptText`). No existing member is renamed, retyped, or removed; the claim's eligibility, lease, and audit semantics are untouched.
3. **003 contract [run-history-audit.md](../../003-dispatch-integrity/contracts/run-history-audit.md)** — `RunHistoryRow` gains three members (presence/fingerprint/length, never text). 003's own §1 note already reserved this: *"004's additive delta (not built here)."* The `GET /v1/audit` read is unchanged and simply returns the new detail keys inside stored rows.
4. **003 contract [dispatch-authorization.md](../../003-dispatch-integrity/contracts/dispatch-authorization.md)** — §1 (`dispatch.reserved`) and §2 (`dispatch.result`) gain four required `details` keys. Every existing detail, refusal, staleness rule, and the `dispatch.refused` row is unchanged.
5. **Evidence/attachment schema** — `extension-spike-1` **does not change** (002 v1.3.0 migration note: 004 "versions neither the delivery schema nor the delivery key"); the three `data` scalars are additive members under 002 contract §1's "additive changes only within v1" rule (plan D9).
6. **Composition** — `## Dispatch Message Composition` of the specification is normative for ordering, fencing, and bounds; [dispatch-prompt.md](./dispatch-prompt.md) §5 states only the rules the tests assert (byte identity, reservation, host caps).

**Co-ship assumption** (003 contracts README): `panel/main.js` and `service/main.js` ship in one commit, so the new members are read and written by the same build — no versioned client exists to break, and an old-shape answer to a new panel cannot occur.

**Universal rules inherited** (003 contracts README §"Universal rules"): fail closed with a distinct secret-free code for every refusal; correlation echo unchanged (the run's id, never a fresh one); service clock only; credential-free everywhere (the fingerprint is `mtp-…`, an identity, never a credential); every rendered string goes through the panel's non-HTML path.
