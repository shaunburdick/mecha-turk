# Changelog — 010-observability

Why a requirement changed, and when. Moved out of `spec.md` so that
document states only the current intended behaviour: a reader of
`## Functional Requirements` gets correct behaviour from that section
alone. Requirement ids are never renumbered here — other documents
cite them.

Amendments follow the same procedure and shape as the project's
constitution (`.specify/memory/constitution.md` §Governance) and as
005's, 007's, and 002's own changelogs: a version bump, a stated
rationale, a record of what changed and what did not, a migration-impact statement, and an approval status. **Where an amendment changes a requirement's wording, that change lands in this feature's own `spec.md`, never in this file** — the record and the
body are separate documents, so a reader of `## Functional
Requirements` is given only the current intended behaviour.

### v1.1.0 — 2026-10-16 (product-owner review of PR #57; counts come out of comments, prose, titles, and identifiers)

- **Rationale**: reviewing PR #57 (issue #53) on 2026-10-16, the product owner wrote: *"Wow, half this PR is renaming `six` to `seven` in a bunch of comments. These types of comments are unmaintainable and greatly increase the blast radius of changes like this. They need to go. Review all those 6->7 changes and pull the counts from the comments. Most of them could just be replaced with `all`."* The policy this encodes: **counts come out of prose and naming; counts stay where they are the contract.** FR-008 at v1.0.0 instructed the opposite for its comment categories — a ***one-word change inside an existing line***, six → seven — which is exactly the unmaintainable, blast-radius-increasing prose the review rejects; left as written, the live spec would mandate the defect. FR-008 is re-cut in place: its categories and exhaustiveness claim stand, the instruction becomes count-free phrasing, and quotations of comment text that will no longer exist anywhere are dropped. Id unchanged; no other requirement moves.
- **In scope (what FR-008's re-cut policy covers)**:
  1. Comment and JSDoc lines in `src/`, `tests/`, `tools/`, `panel/index.html`, and `site/` that the change took from six to seven, or that carried a brittle tab count beside it — reworded count-free (*all bodies*, *one rule across all tabs*, *the tab shell*, *the tabs that own no cadence*, *the top-level surfaces*) or deleted where the count was the line's whole content.
  2. `eslint-disable` reason lines — count-free premise, still naming the premise that fails (AGENTS.md invariant 7), e.g. *`TabId` is fixed literals; escape is the identity*.
  3. Test `describe`/`it` titles — prose labels, not assertions.
  4. Count-bearing helper/type identifiers this feature introduced or renamed — `renderSevenTabs` → `renderAllTabs`, `SevenTabs` → `AllTabs`, and any siblings.
  5. Docs prose and help strings — `AGENTS.md` (shot line → *screenshot all panel tabs*; *the tab shell*; the cadence sentence naming Status and Logs), `DESIGN.md` prose, the site landing sentence, `shot.js`'s *(default: all tabs)* help.
  6. The measured-fit comment block in `panel/index.html` — pixel numbers stay (they are the measurement), tab counts go (*The tabs fit at 320px*, *its labels*).
- **Out of scope (counts stay — the lock and the arithmetic)**: every test assertion, label/id list, `TAB_IDS`, count assertion (`toHaveLength`, `tabMounted.size`, `assert.equal(listed.length, 7)`), sentinel/index arithmetic, and fixture data — AC-004 and 005 SC-103 make these the deliberate lock; all spec text — requirements state current behaviour and are not comments: the 44 amended requirement lines of `specs/005-panel-ia/spec.md` (incl. SC-103's *exactly seven … no eighth*, FR-016's *2 of 7*), 002 FR-042's correction, and 010's own FR-008 as re-cut by this entry; non-tab arithmetic — *the five oldest of a thousand-and-five*, *six pages of 200*, *each of the twelve*, `DESIGN.md`'s measured-coverage line, `AGENTS.md`'s *six gated phases*, root `CHANGELOG.md` history; and user-visible behaviour and copy — button labels, tab labels, cadence sentences, layout.
- **What did NOT change**: FR-001 – FR-007 byte-identical; FR-008's id, its categories (a)–(e), its exhaustiveness claim, and its named exclusions (the `specs/` tree, root `CHANGELOG.md`'s release line, `DESIGN.md`'s measured-coverage line, *six gated phases*) stand; every AC — **AC-004's assertion-level count demands untouched** — plus the `## Wire Surface Delta`, `## Edge Cases`, and `## Not doing` sections; no layout, behaviour, or user-visible copy moves with this entry.
- **Migration impact**: spec text only — no code, test, or document outside this directory changes with this entry. The prose-and-naming pass it records lives in the implementer's own commits on this branch; its `src/` half ships with the rebuilt bundles under AGENTS.md invariant 1, and assertions, id lists, and the count lock are untouched by it.
- **Approval status**: **the direction is the product owner's**, given in the PR #57 review on 2026-10-16 (issue #53) and quoted verbatim above; it is in force for FR-008. The specification remains **approved** and in PR at **v1.1.0** — the bump is a requirement re-cut (minor, per this project's precedent), not a typo fix. `plan.md` and `tasks.md` keep their dated phase wording untouched; zero `[NEEDS CLARIFICATION]` markers remain in the document.
