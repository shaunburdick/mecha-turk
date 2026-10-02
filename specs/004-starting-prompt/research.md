# Research: Per-Binding Starting Prompt — new findings only

**Feature**: `specs/004-starting-prompt` · **Spec**: v1.1.0 · **Date**: 2026-09-28

## Status: no open questions

**004 raises no genuinely open research question.** It adds one optional text field to a shipped
entity and one text block to a composed string: no new language, library, service, host API,
storage mechanism, or protocol is introduced (004 FR-004, NFR-125, NFR-129 — "no host call, no new
service route beyond the existing bindings surface, no new permission, no new audit surface").
Every platform fact this feature depends on is already settled with a stamped source, and every
product question was closed at the phase gate (spec `## Resolved Gate Questions`, `## Clarifications`
rows 18–21). The design decisions that remain after those gates — field names, the fingerprint's
construction, code-point counting, the budget split, error codes — are Phase 4's to make and are
made, with rejected alternatives recorded, in [plan.md](./plan.md) §Key decisions.

## Settled before this feature (cited, not re-researched)

| Question this feature would otherwise raise | Where it is already settled | Settled answer used here |
| --- | --- | --- |
| Host attachment limits: how long may the composed `text` / `data` be, what does the host do on overflow | 002 research §R1/§R4 (stamped provenance) + the pinned SDK (`@openchamber/sdk` `1.24.2`, `contract.js`) | `GUEST_ATTACH_TEXT_MAX = 16_000`, `GUEST_ATTACH_DATA_MAX = 16_000`, `GUEST_ATTACH_ID_MAX = 128`; `clampAttachRequest` trims and slices — so the composed message must stay under the cap (plan Composition arithmetic: worst case ≈ 14,500) |
| Where durable configuration lives, and what `host.storage` may hold | 002 FR-033/FR-034, 002 research §R2, constitution "durable state" standard | Prompt is service-owned configuration in `bindings.json` (0700/0600); never in `host.storage`, never in the ledger (004 FR-011) |
| The panel↔service transport, auth, body/size caps, error envelope, `422` issue shape | 002 contract [`panel-service.md`](../002-agent-event-extension/contracts/panel-service.md) §1, §4 | Refusals ride the existing `422 validation` with `issues[] { field, remediation }`; no new code, no echo of received values (SEC-10/SEC-11) |
| Secret shapes the product recognises, and the refusal posture when a value must not persist | 002 FR-007 / 002 NFR-004, `src/redaction.ts` `SECRET_PATTERNS` + `RedactionError` ("refusing … matches `<label>`"), 004 FR-024 | Reuse `findSecretLeak` verbatim — same labels, same no-echo message discipline; a refusal blocks the write |
| Non-HTML rendering of service-supplied strings in the panel | 002 contract §3 rule 11, 003 NFR-109 | Presence/fingerprint/length render through the existing text-node path (004 NFR-127) |
| Agent pin: no per-call agent/model/variant; verification warn-only | 001 §b.2 (stamped provenance), 002 FR-029, 003 FR-043, 003 research §R3 | A prompt is text, never a selector (004 FR-040/FR-041); nothing new is sent to the host |
| Run/lease/token/state/correlation model and the dispatch-lifecycle audit vocabulary | 003 spec, 003 [plan.md](../003-dispatch-integrity/plan.md), 003 `data-model.md` §4, 003 research §R1–§R4 | 004 rides inside it: snapshot on the run, rows addressed by the run's correlation id, `binding.` prefix reserved for 004's one event type, fingerprint derived (never minted) so 003 FR-062 holds |
| Delivery id, evidence schema, and event-contract compatibility surfaces | `AGENTS.md` invariant 10, 002 v1.3.0 migration note ("004 versions neither the delivery schema nor the delivery key") | `extension-spike-1` unchanged; the two `data` scalars are additive (plan D9) |
| Line endings, Unicode counting, hashing primitives in this codebase | TypeScript/Node stdlib already in use (`node:crypto` in `service/auth.ts`; `[...string].length` semantics) | CRLF/CR→LF at save; code points via spread; SHA-256 via `createHash` (plan D1, D3) |
| Whether an operator-facing surface can be researched from docs alone | 005 gate record (Diagnostics must keep noticing a schema-version change) | informs D9's rejected alternative (bumping the version would churn that surface) |

## Open items this research leaves

**None for 004.** Two adjacent items are recorded so they are not mistaken for open ones:

1. **The Phase-4 brief vs. 004 FR-062** ("prompt edit surface on the Bindings UI" vs. the spec's
   MUST NOT) is not a research question — it is a conflict between an instruction and an approved
   requirement, surfaced to the requester in [plan.md](./plan.md) §Cross-feature coordination item 5.
   This plan follows the specification; a different answer requires a spec amendment, not research.
2. **003's implementation has not landed yet** (its tasks are unchecked). That is a sequencing fact
   recorded in the plan, not an unknown: nothing 004 needs from 003 is undecided — its plan,
   data-model, and contracts fix every shape 004 composes with.
