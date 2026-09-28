# Specification Quality Checklist: Per-Binding Starting Prompt

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No unresolved clarification markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification

## Notes

- **Content Quality / "No implementation details"**: this feature is *about* two security boundaries the requirements bind to — the panel↔service protocol and the untrusted-source delimiter contract. Named platform surfaces (`host.startSession()`, `host.storage`, `host.serviceRequest()`) and the shipped composition markers (`--- BEGIN …` / `--- END …`) therefore appear deliberately: they are the documented contract the requirements constrain, not implementation choices. Requirements that are genuinely architecture-neutral (the agent pin cannot be selected by text; a credential must never come to rest; the dispatch budget must not starve the source excerpt) are stated without technology detail. Composition order, field names, and the fingerprint's construction are left to Phase 4.
- **"No implementation details leak"** therefore remains unchecked by design: a standing, reasoned exception for a platform-integration spec, carried from feature 002's and 003's checklists, not an oversight.
- **All mandatory template sections are present and in order**: `## Problem Statement`, `## User Scenarios & Testing` *(mandatory)* (5 prioritized stories, each with *Why this priority*, *Independent Test*, and numbered Given/When/Then scenarios), `## Requirements` *(mandatory)* → `### Functional Requirements` (FR-001–FR-074 in eight topic groups) and `### Key Entities`, `## Success Criteria` (SC-120–SC-129), `## Assumptions`. Additive sections (`## Governing Principles and Relationship to Features 002 and 003`, `## Architecture Impact`, `## Dispatch Message Composition`, `## Non-Functional Requirements` (NFR-120–NFR-129), `## Acceptance Criteria` (AC-130–AC-145), `## Out of Scope`, `## Clarifications`, `## Resolved Gate Questions`, `## Amendment Map`, `### Audit Vocabulary Delta`) extend the template without displacing any mandatory heading.
- **Requirement numbering is block-reserved, not consecutive** (A `FR-001`–`005`, B `010`–`019`, C `020`–`029`, D `030`–`039`, E `040`–`044`, F `050`–`054`, G `060`–`064`, H `070`–`074`) — 003's convention, adopted so a clarification lands in its own group without renumbering. 55 FRs, 10 NFRs, 10 SCs, 16 ACs, 5 user stories, 23 edge cases, 21 clarification rows, 4 resolved gate entries. The unallocated numbers in each block are declared unallocated in the spec, not missing.
- **The four Gate Questions are resolved, and nothing is left to interpretation.** The cap of 2,000 code points, refuse-don't-warn on a credential-shaped value, fingerprint-don't-text on audit rows, and omission-preserves in the whole-file `PUT` are each stated as a numbered FR with their rejected alternatives recorded, so a reader can disagree with a decision without finding the spec ambiguous about what it currently says. The product owner confirmed the first three **on 2026-09-28 against the defaults already encoded**; the fourth was confirmed as a **technical default** — it follows from the whole-file replacement semantics of the existing surface and was never a product preference. Recorded in `## Clarifications` rows 18–21 and in `## Resolved Gate Questions`. **No requirement text changed on approval**, so the FR/NFR/SC/AC numbering and text are byte-identical to the version submitted at the gate; the spec status is now `Approved (v1.0.0)` and the version is unchanged at 1.0.0.
- **The one design decision with a real cost** is recorded in full at FR-024 and was **confirmed by the product owner on 2026-09-28**: a save carrying a credential-shaped string is **refused outright** rather than warned about, because the project's existing `RedactionError` path blocks the write rather than logging through it (`AGENTS.md` invariant 9) and a warn-and-store path would put a credential at rest. The cost is real and stays visible in the spec: a prompt that *discusses* token handling could be refused, since the shape set (GitHub token prefixes, an `Authorization:` header spelling, a bearer credential) is narrow but not zero-width. The warn-and-refuse hybrid and its cost — the refusal becomes a partial disclosure — are recorded so the confirmation can be revisited on evidence rather than re-derived from scratch.
- **The composition is pinned, not described.** `## Dispatch Message Composition` gives the exact ordered blocks, the fence and delimiter lines, the trim rule, and one fully worked example, so "trusted operator intent first, auto-built source below" is a checkable string rather than a principle. Every other clause of the shipped frame is left as-is, and the FR that composes them states that the excerpt's bounds and delimiters are unchanged.
- **Backward compatibility is stated as behaviour, not intent**: absence and explicit `null` both read as unset, a present non-text value is refused rather than coerced, a client that omits the field preserves the stored value, and **no migration step exists** (FR-017, FR-018). SC-121 and SC-128 make both halves measurable — 0 composed messages differ from the pre-upgrade composition, and 0 files are quarantined by the upgrade.
- **Cross-document consistency verified 2026-09-28**: zero `[NEEDS CLARIFICATION]` markers; zero `TODO`/`TBD`/`FIXME`; every referenced `FR-`/`NFR-`/`SC-`/`AC-` identifier resolves to a definition in this spec, 002, or 003, with no dangling number; all cross-document references are explicitly prefixed `002 ` or `003 `, verified by script, so 004's own `FR-001`–`FR-074` series (which numerically overlaps both predecessors) cannot be misread; code fences balanced. The 11 amended 002 items and the 13 amended 003 items appear in **all three documents** — this spec's `## Amendment Map`, 002 v1.3.0's `## Amendment History`, and 003 v1.1.0's `## Amendment History` — as an exact set match, all pointing the same direction (**extended**; 004 supersedes nothing in either predecessor).
- **Nothing was left for Phase 4 that belongs in a requirement.** Phase 4 owns: the exact field names on the binding record and the run projection, the fingerprint's construction and length, the code-point-counting implementation, the precise character budget split inside the shipped 4,000-char frame, and the error codes. It does not own: whether a credential is refused, whether a retry reuses the snapshot, whether audit rows carry text, whether a marker is refused, or whether absence means unset.
- **Not written, by instruction and correctly so**: `plan.md`, `research.md`, `data-model.md`, `tasks.md`. The feature has no new external technology to research — every platform constraint it encodes is already settled with stamped sources in 002's research record — and the plan, data model, contracts, and task breakdown are Phase 4 and Phase 5 deliverables.
