# Contracts: Documentation Site and MIT Licence

Two contracts, each for something two parties must agree on and a change to which would break an approved requirement.

| File | What it binds | Requirement |
| --- | --- | --- |
| [`pages-workflow.md`](./pages-workflow.md) | `.github/workflows/site.yml` — triggers, the permissions contract, the action sequence, the published address, and the reconciliation of the repository's stale Pages `source` block | FR-066, FR-067, FR-073 |
| [`site-build-output.md`](./site-build-output.md) | `site/dist/` — the shape of the artefact GitHub Pages serves, and the properties the build job asserts before it is uploaded | FR-001, FR-002, FR-005, FR-009, FR-010, NFR-002, NFR-003 |

## What is deliberately **not** a contract

- **No API or wire contract.** The site is a purely static publish with no server component, nothing to call, and no credential (FR-003, FR-012). There is no interface between two runtime participants to describe. The service's own wire contract is `specs/002-agent-event-extension/contracts/panel-service.md` and is **untouched** by this feature — `AGENTS.md` invariant 10.
- **No `extension-spike-1` contract.** The evidence schema version and the NDJSON event contract are compatibility surfaces this feature only *reads* in order to document them. Nothing about them changes, so nothing about them is contracted here.
- **No data model.** Five static documents have no entities, schema, or state worth modelling. The pages' four tables are **generated from declarations the product already owns** (`package.json`, `service/config.ts`, `service/routes/events-page.ts`), which is the mechanism behind FR-048 and is asserted by `tests/docs-sync.test.ts` rather than described here. See [plan.md](../plan.md) §Why there is no data model.
- **No content contract for the documentation itself.** The pages' *content* is bound by the specification — 77 requirements across seven blocks — not by a contract document. A contract describing what the install page says would be a second copy of `spec.md` FR-020 – FR-024, and two copies of one requirement is how two requirements drift.
