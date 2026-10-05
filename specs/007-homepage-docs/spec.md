# Feature Specification: Documentation Site and MIT Licence

**Feature ID**: `007-homepage-docs`

**Feature Branch**: `issues-11-homepage-docs` (spec-kit keeps the spec directory and the git branch independent; implementation stays on this branch per `AGENTS.md` git conventions.)

**Created**: 2026-10-05

**Last Updated**: 2026-10-05 — see [changelog.md](changelog.md) for what changed and why

**Version**: 1.3.0

**Status**: Draft, submitted for product-owner approval. The three confirmations in `## Clarifications` are **answered** (2026-10-05) and no longer open: Q1 is encoded at FR-074, Q2 added FR-077, and Q3 closed with no requirement to correct. v1.2.0 carries one further product-owner amendment, **the prose budget's unit**: AC-016 and NFR-006 measure documentation prose in **words** rather than in lines (Q5 in `## Clarifications`; rationale, requirement-level record, and migration impact in [changelog.md](changelog.md) → `### v1.2.0`). **v1.3.0 re-cuts FR-008's ordering clause** — issue #17 raised the root floor to `>=24.15.0` and the owner then raised the site's to match, so the two legitimately declare the same number ([changelog.md](changelog.md) → `### v1.3.0`). **This specification is not approved**, and neither predecessor amendment is — 002 v1.13.0 and 005 v1.16.0 are drafts of record and the owner approves all three together, in one package.

**Dependencies**: Feature 002 `002-agent-event-extension` (v1.12.0 — **amended to v1.13.0 by this specification**: FR-042's documentation-synchronisation requirement and its scan gain the site as a bound document, and the site is named authoritative where a claim appears in both places), feature 005 `005-panel-ia` (v1.15.0 — **amended to v1.16.0 by this specification**: its operator-facing vocabulary rule and its mapping-table requirement gain the site as a place a human reads and as a home). Features 003 `003-dispatch-integrity`, 004 `004-starting-prompt`, and 006 `006-settings-crud` are **read, not amended** — this feature documents what they specified and changes no requirement text of theirs. Dispatch semantics, credential custody, the run/lease/state model, the wire contract (`AGENTS.md` invariant 10), the six-tab shell, and the read-only-to-GitHub posture all carry forward **unchanged**.

**Input**: GitHub issue #11 — *"This tool could use a GitHub Pages homepage that has some documentation and help. It can be semi-basic but use some tooling like Astro. Have a landing page that explains what it does and some help style documentation on how to install, configure, use, and debug it."* Plus six product-owner decisions locked 2026-10-05 and three further confirmations answered by the owner the same day (both recorded verbatim in `## Clarifications`), and the verified premises in [research.md](research.md).

**Constitution**: `.specify/memory/constitution.md` **v1.3.0** — Approved 2026-09-27. **This feature requires no amendment and none is made.** The reasoning is in `research.md` §4 and `## Clarifications` Q4. Governing principles: **VI (specification and verification before implementation)** is the discipline this document is written under; **V (minimal, self-hosted deployment)** is honoured rather than extended — the site adds no infrastructure to the product's deployment and no proprietary control plane; **IV (human-visible auditability)** is served by documentation that names the same states, tokens, and trails the panel renders. Two §Security and Operational Standards items are load-bearing and are cited where they are discharged, not re-invented as new requirements — see the subsection below.

### Load-bearing constitution items (quoted, not invented)

Two §Security and Operational Standards entries bear directly on what this feature publishes. They are cited here so that the plan discharges the constitution rather than restating it:

> Unattended operation depends on the operator's OpenChamber installation running. Polling and dispatch stop when OpenChamber stops, when the extension is disabled, or when its local service is not running; **this dependency must be documented, surfaced as health/status, and never masked by an undocumented background mechanism.**
> — §Security and Operational Standards

> **Durable state must match the storage it actually lives in.** State that survives reload but is erased on extension uninstall (for example host extension storage) is not a sufficient home for audit history; checkpoints, runs, and audit records must live in storage whose retention the operator controls and can back up.
> — §Security and Operational Standards

The first is discharged by FR-014 (the landing page states the dependency in its own words), FR-019 (the landing page names where the honest state is read) and FR-042 (the debug page states it again where an operator with a symptom will look); the second by FR-016 (both locations, their contents, and their retention) and FR-043 (the data directory, its permissions, and what survives uninstall). Neither is satisfied by *this document* — they are satisfied by the **published pages**, which is why each has its own acceptance criterion.

---

## Problem Statement

Mecha Turk ships a working product and one long README. `README.md` is 384 lines and carries requirements, install, setup, the layered starting prompt, the first dispatch, the failed-dispatch table, data locations, security posture, uninstall, troubleshooting, and contributor commands — and the second copy of that material is `specs/002-agent-event-extension/quickstart.md`, whose §6 alone spends 94 lines on the service store. Two consequences follow, and they are what issue #11 is about.

**A reader who found the repository cannot tell which document is current.** Install steps sit in a README that has already drifted once in a way a reader would notice and act on wrongly: `README.md` §Install tells the reader the approval dialog *"asks for exactly these four things"* and names `network` as the fourth. The shipped manifest asks for **two** capabilities (`sessions`, `prompt`) plus the `service` capability implied by `contributes.service`, and `AGENTS.md` invariant 3 records that `network` was removed by product-owner order on 2026-09-30 and is *"no longer requested at all."* A reader who grants four permissions to satisfy the README has been told something false about the product they are installing.

**The prose has no owner.** Every documentation fact lives in at least two documents, none of which is authoritative, and the drift above is the predictable result. The product's own specifications anticipated this and bound the documents by name — 002 FR-042 requires the walkthrough and the README to be kept *"in agreement with the surfaces this document and features 003–006 specify"*, and 005 FR-020 forbids the word "Run" for a work unit *"everywhere a human reads it: tab labels, … `README.md`"*. Those requirements name two documents. A third documentation surface would be the one surface no requirement covers, which is the drift mechanism itself.

This feature gives the documentation a single home and a gate. The site becomes the canonical documentation: one landing page that explains what the product is, and exactly four documentation pages — **install, configure, use, debug**. The README reduces to a short summary and a link. A documentation link appears in the panel's About tab, so the operator who already has the extension installed finds the documentation from inside it. The site builds on every pull request, so a broken page fails the pull request rather than reaching `main`, and publishes to GitHub Pages from a workflow on push to `main`. A full MIT licence file lands at the repository root, which `package.json` already declares and the README already claims.

The constraint that shapes every requirement below: **this is a move, not an expansion.** The prose that moves is the prose that already exists, re-sourced against the shipped code rather than remembered. No topic is authored twice at two lengths, and the repository's prose budget does not grow to accommodate a third copy.

---

## Governing Relationship to Features 002 and 005

### Why this amends two predecessors rather than only adding to them

| Predecessor | Requirement | Relationship |
| --- | --- | --- |
| 002 | **FR-042** — documentation synchronisation, binding `README.md` and `specs/002-agent-event-extension/quickstart.md` to the shipped surfaces, with **AC-022** scanning both | **Extended.** The bound document list gains the site, and the scan widens to it. A canonical documentation surface that no synchronisation requirement covers is the exact gap that let the `network` row rot, so leaving FR-042 as written would make this feature the first unscanned operator surface in the project. **Not weakened** — one more document is bound, not one fewer. |
| 005 | **FR-020** — operator-facing copy MUST use **Dispatches** and **Bindings** and MUST NOT use "Run"/"Repositories", *"everywhere a human reads it: … `README.md`"*; enforced by **SC-107** and **AC-140** | **Extended.** The site is a place a human reads. The site's prose is bound by the same vocabulary rule (FR-047). |
| 005 | **FR-029** — the mapping table MUST be reproduced in `README.md` so an operator who reads `run` in an audit row can find the surface that produced it | **Conformance gap closed, home relocated.** The table is **not currently in the README**; this is an existing undischarged requirement, not a defect this feature causes. The site is the home it was meant to have — the About tab deliberately renders none of it (005 FR-029 as amended by v1.6.0's scrub), so a home has to exist somewhere, and the site gives it one without re-adding it to a page the owner removed it from. |

Both predecessors' requirement text **is re-cut, in the predecessor rather than here** — 002's **FR-042** and **AC-022** in [`002-agent-event-extension/spec.md`](../002-agent-event-extension/spec.md), and 005's **FR-020**, **FR-029**, **SC-107**, and **AC-140** in [`005-panel-ia/spec.md`](../005-panel-ia/spec.md) — each superseded wording preserved beside the new body as *Was:*, because a requirement body a reader consults must state only the current intended behaviour. A re-cut is required rather than an addendum: 002 FR-042 bound a closed list of two documents *"by literal name"* and said so in its own words, so leaving its body untouched would have made it false the moment this feature shipped.

The authoritative record of each amendment is that predecessor's **own** changelog entry — [`002-agent-event-extension/changelog.md`](../002-agent-event-extension/changelog.md) → `### v1.13.0`, and [`005-panel-ia/changelog.md`](../005-panel-ia/changelog.md) → `### v1.16.0` — each carrying all five elements the project's constitution §Governance requires: **a version bump, a stated rationale, a requirement-by-requirement record, a migration-impact statement, and an approval status**. This document's own [changelog.md](changelog.md) table says only where each record lives; it is a pointer, not a second authority.

**Approval status: Draft.** Neither predecessor amendment is in force yet. The product owner approves this specification and both predecessor amendments **together, in one package**; until then 002 v1.13.0 and 005 v1.16.0 are drafts of record, and nothing may be implemented against them.

### Invariants this feature must not weaken

Every one of these is `AGENTS.md`, and none of them moves.

- **Invariant 1 — committed bundles ship.** The About-tab link is a `src/` change, so `npm run build` runs and the rebuilt `panel/main.js` is committed in the same commit (FR-062).
- **Invariant 2 — one document, two roles, and no `workspaces`.** The root `package.json` gains no dependency, no script that builds the site, no `workspaces` key, and no version bump (FR-007).
- **Invariant 3 — capabilities stay `sessions` and `prompt`.** The site documents the capabilities the manifest declares, and no page names a capability the manifest does not request (FR-022, FR-048).
- **Invariant 4 — kebab-case identity, `mecha-turk:` storage namespace.** Untouched. The site's base path is the repository name, which is the same word in a different namespace, and nothing is renamed (FR-005).
- **Invariant 5 — `SERVICE_VERSION` mirrors `package.json`.** Untouched; the site never renders a version literal of its own, and the About tab's version still has exactly one source (FR-053).
- **Invariant 6 — the SDK is pinned exactly.** The site's build tool is pinned exactly for the same reason (FR-006).
- **Invariant 7 — scoped suppressions, zero `any`, no suppressions.** The site's directory is **excluded from the root lint scope**, which is not a rule suppression; no lint rule is disabled anywhere and no type suppression is added anywhere to accommodate it (FR-070, FR-072).
- **Invariant 8 — fail closed.** No page documents a path that guesses, defaults, or partially applies; every documented failure names its cause and its remediation (FR-041, FR-045).
- **Invariant 9 — secrets never leave the service store.** No page carries a credential, and the site's build output is scanned for credential material (FR-054, NFR-005).
- **Invariant 10 — `extension-spike-1` is a wire contract.** Untouched. The site documents the wire surface as it is, mirrors the identifier mapping, and changes no schema (FR-048, FR-051).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A prospective operator decides whether this is the right tool (Priority: P1)

*A GitHub user has heard of Mecha Turk and opens the published site.* **Given** they arrive at the landing page, **When** they read it, **Then** they can say in one sentence what the product does and in which direction the work flows, **And** they learn what the product will *not* do — no GitHub writes, no projects or worktrees created, nothing running while OpenChamber is off — before they install anything.

**Why this priority**: it is the only page a reader who has not installed anything will see, and the one whose failure mode is a marketing page that overstates. Without it the four documentation pages have no doorway.

**Independent Test**: load the landing page with no prior knowledge; the reader can answer "what is this, what does it touch, and what will it never do" without leaving the page.

**Acceptance Scenarios**:

1. **Given** the landing page, **When** a reader looks for what the product does, **Then** one paragraph states the direction of work (GitHub activity → OpenChamber sessions) and one states that polling, storage, and dispatch happen on the reader's own machine with no hosted control plane.
2. **Given** the landing page, **When** a reader looks for the limits, **Then** all four honest boundaries are stated: it never creates projects or worktrees, nothing runs while OpenChamber is off, the only GitHub traffic is the service's outbound polling, and it has no GitHub write access.
3. **Given** the landing page, **When** a reader looks for where their data would live, **Then** both locations are named with what each holds and which survive an uninstall.
4. **Given** the landing page, **When** a reader finishes, **Then** the four documentation pages and the licence are reachable from it.

---

### User Story 2 — An operator installs the extension and reaches a first dispatch (Priority: P1)

*An operator has decided to install.* **Given** they read the install page, **When** they follow it, **Then** every step is a step OpenChamber actually offers, and **And** the approval step tells them the truth about what is being asked for — so the first thing they are not surprised by is a permission they never agreed to.

**Why this priority**: install is the highest-consequence page. A wrong step costs an operator their time; a wrong permission claim costs them their trust in every other statement on the site.

**Independent Test**: an operator with a fresh OpenChamber follows only the install page; the extension is installed, enabled, and the panel opens, with no permission listed on the page that the approval dialog does not show.

**Acceptance Scenarios**:

1. **Given** the install page, **When** the reader adds the extension, **Then** the steps are: run OpenChamber on web or desktop → **Settings → Extensions → Add** → paste the repository URL → review the approval → open the Mecha Turk icon on the rail.
2. **Given** the install page, **When** the reader reaches the approval step, **Then** the permission table names `sessions`, `prompt`, and the implied `service`, and names nothing else.
3. **Given** the install page, **When** the reader wants a specific version, **Then** it says how to pin one and explains that an update carries over permissions, accounts, and settings, and that re-approval is needed only if the new version asks for more.
4. **Given** the install page, **When** the reader is on an unsupported surface, **Then** it says which surfaces do not run extension services and what the panel shows there.

---

### User Story 3 — An operator configures accounts, bindings, settings, and prompts (Priority: P1)

*An operator has the extension installed and wants work to start arriving.* **Given** they read the configure page, **When** they follow it, **Then** they know exactly which panel surface owns each piece of configuration, what each field accepts, when a change takes effect, and — for the fields that can delete history — what a confirmation is about to do to them.

**Why this priority**: configuration is where an operator's data is at risk and where the product has the most precisely specified behaviour, so the page has the most to get right and the most value in getting right.

**Independent Test**: an operator with the extension installed and no accounts, bindings, or configuration follows only the configure page and reaches one connected account and one bound repository.

**Acceptance Scenarios**:

1. **Given** the configure page, **When** the reader adds a GitHub account, **Then** the disclaimer's facts are stated before the field: the token goes to the local service, is stored outside extension storage at file permissions, is unencrypted on disk, the connection is recorded as an occurrence only, and there is nothing to accept or decline.
2. **Given** the configure page, **When** the reader opens Settings, **Then** every configuration field is listed with its value, unit, bounds or format, and when a change takes effect — and the list is the service's own field list, not a retyped copy.
3. **Given** the configure page, **When** the reader considers lowering a retention limit or restoring defaults, **Then** it states what will be deleted, when the trim pass runs, and what survives, and says that raising a limit deletes nothing.
4. **Given** the configure page, **When** the reader sets a starting prompt, **Then** the three tiers and their fixed order are stated, an unset tier is said to contribute nothing, and the per-tier character cap and the four refusals are stated.
5. **Given** the configure page, **When** the reader looks for a way to configure the product, **Then** it says the Settings tab and `GET`/`PUT /v1/config` are the whole surface — no environment file, no environment variable, no manifest setting.

---

### User Story 4 — An operator uses the product day to day (Priority: P2)

*An operator has work arriving and is watching it.* **Given** they read the use page, **When** a dispatch appears, **Then** they can tell what state it is in, what that state means, and which control moves it — using the same words the panel shows them.

**Why this priority**: the use page is what an operator returns to daily, but it is the least costly page to get wrong: the panel already labels its own states. It ranks below install and configure because the reader can survive its absence; the reader cannot survive a wrong install step.

**Independent Test**: an operator with one binding reads only the use page and can explain what `unconfirmed` means and what they are allowed to do about it.

**Acceptance Scenarios**:

1. **Given** the use page, **When** the reader performs a first dispatch, **Then** the sequence is stated: trigger the work, a row appears within about two poll intervals, the session is created, the dispatch is marked dispatched with a link, and the audit history is reachable from the row.
2. **Given** the use page, **When** the reader reads the state table, **Then** every state the panel can show appears, with its meaning and the control that moves it, and the words are the panel's own.
3. **Given** the use page, **When** the reader asks about a dispatch that never confirmed, **Then** it says an unconfirmed dispatch is never re-dispatched automatically, and that only an explicit operator decision can resolve it.

---

### User Story 5 — An operator diagnoses a failure (Priority: P2)

*Something is not working.* **Given** they read the debug page, **When** they hit a symptom, **Then** they can match what they see to a named cause and a remediation, **And** they know where their data is and how to read it.

**Why this priority**: the README already carries a troubleshooting table and it is the single most useful thing on it. Moving it risks losing it; getting it wrong costs an operator an afternoon. It ranks below install and configure because it is consulted after something is already broken.

**Independent Test**: given a symptom string the panel renders, a reader finds that exact string on the debug page with a cause and an action.

**Acceptance Scenarios**:

1. **Given** the debug page, **When** the reader sees a symptom token, **Then** that exact token is in the table with what it means and what to do.
2. **Given** the debug page, **When** the reader wants to inspect their data, **Then** the data directory, what is in it, its file permissions, and which of it survives uninstall are stated, and the page says where the absolute path is shown in the product.
3. **Given** the debug page, **When** the reader asks why polling looks stale, **Then** the page says both OpenChamber and its service must be running, and where the honest state is read.

---

### User Story 6 — A reviewer never merges a broken page (Priority: P1)

*A maintainer opens a pull request that edits a documentation page.* **Given** the pull request, **When** CI runs, **Then** the site is built and type-checked, **And** if that fails the pull request fails — so the address `main` serves is never known-broken.

**Why this priority**: without it every other requirement is a promise about a page that may not exist at the address the README and the panel link to. It is P1 for the same reason the panel's bundle rule is: the artifact and its sources must ship together.

**Independent Test**: introduce a deliberate error in a page; the pull request check goes red; remove it; the check goes green.

**Acceptance Scenarios**:

1. **Given** a pull request that changes the site, **When** the site build job runs, **Then** it installs from the site's own lockfile, builds, and type-checks, and a failure in any of the three fails the pull request.
2. **Given** a merge to `main`, **When** the publish job runs, **Then** the built site is deployed to the Pages address and the deployment records that address.
3. **Given** a change that touches `src/`, **When** the repository gate runs, **Then** the gate reaches the panel and the service exactly as it does today, and does not reach the site directory.

---

### User Story 7 — A contributor builds and reviews the site locally (Priority: P3)

*A contributor wants to see a page as it will be published.* **Given** the site directory and the quickstart, **When** they install and run it, **Then** they can see every page at the address it will be served from, without affecting the repository's own toolchain.

**Why this priority**: it is a contributor convenience rather than a user capability, and the workarounds are known. It is specified because the subpath means a contributor who does not know about it will look at the wrong URL and conclude the site is broken.

**Independent Test**: on a clean clone, following only [quickstart.md](quickstart.md) produces a running local preview serving every page at the site's published base path.

**Acceptance Scenarios**:

1. **Given** a clean clone, **When** the contributor follows the quickstart, **Then** the site's own dependencies install and its preview serves every page under `/mecha-turk/`.
2. **Given** the contributor is on a Node release below the site's floor, **When** they follow the quickstart, **Then** it tells them which release they need and why the repository's own floor is not the site's.
3. **Given** a contributor who edits a page, **When** they run the site's own check, **Then** a type error in the site's sources fails that check.

---

### Edge Cases

- **A reader reaches the site with JavaScript disabled.** Every page is fully readable; nothing is revealed only by script (NFR-002).
- **A reader reaches a documentation page directly, from a search engine, or from a bookmark.** It is reachable by its own address and carries navigation to the landing page and the other three pages (FR-004).
- **The published base path is wrong.** Every asset and internal link 404s while the site's own preview still works. This is the single largest correctness risk in the feature and is therefore an acceptance criterion, not a configuration detail (FR-005, AC-014).
- **The repository is renamed.** The site's published address changes with it, and every hard-coded absolute address in the site would silently 404. The site therefore carries exactly one place its own base path is declared (FR-005).
- **A capability is added to the manifest in a later feature.** The install page's permission table becomes stale unless it is derived from the manifest; FR-022 and FR-048 make the derivation the rule, so the failure is a failing check rather than a wrong page.
- **A field is added to the service configuration in a later feature.** Same shape: the configure page's field list is the service's own declaration, and the check that compares them is what catches the drift (FR-029, FR-049).
- **A dispatch state is added.** The use page's state table would omit it. The table is checked against the shipped vocabulary, so the omission fails the check (FR-038, FR-048).
- **The service cannot be reached when the reader is looking at the documentation.** Nothing on the site depends on the service, the panel, or a running instance; every page is static (FR-003, NFR-001).
- **A reader asks the site something it does not answer.** No page is a stub, no page carries a "coming soon", and there is no FAQ page to absorb the question (FR-009, FR-052).
- **The repository is cloned without `node_modules`.** Nothing in the root install pulls in the site's dependencies; the site installs separately from its own lockfile (FR-008, FR-070).
- **A pull request adds a file under the site directory that a root tool would claim.** The site's own tooling owns that directory, and the root gate does not reach it (FR-070, FR-071).

---

## Requirements *(mandatory)*

### Functional Requirements

#### Block A — The site as a shipped artifact

- **FR-001**: The site MUST consist of exactly **five** published pages: one landing page at the site root, and exactly four documentation pages — **install**, **configure**, **use**, **debug**. No further page, section index, glossary, FAQ, changelog page, or top-level route MAY ship.
- **FR-002**: The site MUST be the canonical documentation for the product. Where a claim appears in both the site and the repository README, the site is authoritative, and the README's wording MUST NOT extend, qualify, or contradict it.
- **FR-003**: Every page MUST be readable as a static document, requiring no running OpenChamber, no local service, no extension installation, and no credential of any kind.
- **FR-004**: Every page MUST carry navigation to the landing page and to all four documentation pages, so no page is an orphan reachable only by direct address.
- **FR-005**: The site MUST be published at `https://shaunburdick.github.io/mecha-turk/`, MUST resolve every asset and every internal link under that base path, and MUST declare its own base path in exactly one place so a repository rename has one edit to make.
- **FR-006**: The site's build tool MUST be pinned to an exact version with no range operator.
- **FR-007**: The site MUST be a self-contained subproject with its own manifest and its own committed lockfile. The repository's root `package.json` MUST gain no dependency, no development dependency, no `workspaces` key, and no version change, and its declared Node floor MUST remain unchanged.
- **FR-008**: The site's own manifest MUST declare a Node floor that satisfies its build tool, and that floor MUST NOT be lower than the repository root's floor; the site keeps its own `engines` declaration in its own manifest, and both floors MUST be documented in [quickstart.md](quickstart.md). *Was: "The site's own manifest MUST declare a Node floor that satisfies its build tool, and that floor MUST be higher than the repository root's floor; the two floors are different requirements for different subtrees and both MUST be documented in [quickstart.md](quickstart.md)." — `higher than` became `not lower than` at v1.3.0: **issue #17 raised the root floor to `>=24.15.0`** and the product owner then raised the site's floor to match, so the two legitimately declare the same number and a strict ordering assertion is false. The clause's substance is unchanged and **not weakened** — the site's floor is still its own declaration in its own manifest, still checked against the root's at run time rather than against a recorded number, and still has to satisfy Astro's own `>=22.12.0`; what is withdrawn is only the claim that they must **differ**, which is what made the "different requirements for different subtrees" sentence true and is no longer.*
- **FR-009**: The site MUST contain no screenshots, no image of any kind, no FAQ page, and no search facility.
- **FR-010**: The site MUST make **no** request to any origin other than its own. No remote font, script, stylesheet, image, analytics endpoint, consent service, or content-delivery network MAY be referenced by any page or by any asset any page loads.
- **FR-011**: The site MUST add no runtime behaviour to the extension or the service: no manifest key, no capability, no host call, no store file, no audit row, no configuration field, and no new `host.storage` key.
- **FR-012**: The site MUST NOT introduce a content-collection framework, internationalisation, a search index, or a build step that requires a credential to fetch anything.

#### Block B — The landing page

- **FR-013**: The landing page MUST state, in prose a reader can follow without prior knowledge, what the product does and in which direction work flows — GitHub activity in, OpenChamber sessions out — and MUST state that polling, storage, and dispatch happen on the reader's own machine with no hosted control plane.
- **FR-014**: The landing page MUST state all four honest boundaries: the extension never creates projects or worktrees; nothing runs while OpenChamber is off, and that dependency is documented rather than masked; the only GitHub traffic is the service's outbound polling, with no inbound connections and no webhooks; and the product has no GitHub write access. *(Constitution §Security and Operational Standards — "this dependency must be documented … and never masked by an undocumented background mechanism.")*
- **FR-015**: The landing page MUST name the six panel tabs in their shipped order with one line each, so a reader knows what they are getting.
- **FR-016**: The landing page MUST name both storage locations, what each holds, and which survive an uninstall. *(Constitution §Security and Operational Standards — "durable state must match the storage it actually lives in.")*
- **FR-017**: The landing page MUST state the prerequisites — OpenChamber desktop or web; a registered OpenChamber project per repository to be bound; a read-only fine-grained personal access token per account with the exact required scopes and **no write scopes**; and the recommended default-agent pin with its matching verification baseline.
- **FR-018**: The landing page MUST carry a link to each of the four documentation pages and to the repository licence, and MUST NOT carry a link to a page the site does not publish.
- **FR-019**: The landing page MUST state where the product reports its honest state when something is not running, naming the Status tab, so a reader is directed to the surface rather than left to infer.

#### Block C — The four documentation pages

- **FR-020**: The **install** page MUST number its steps in the order an operator performs them, and every step MUST be a step OpenChamber actually offers: run OpenChamber on web or desktop; **Settings → Extensions → Add**; paste the repository's git URL; review the approval dialog; open the Mecha Turk icon on the rail.
- **FR-021**: The **install** page MUST state how to pin a specific version, and MUST state the update behaviour: git installs are checked for a newer version at most once an hour, an explicit check is available, an update carries over permissions, accounts, and settings, and re-approval is needed only if the new version asks for more than the old one.
- **FR-022**: The **install** page's permission table MUST name **exactly** the capabilities the shipped manifest requests — `sessions` and `prompt` — together with the `service` capability implied by the manifest's service contribution, each with a one-line meaning, and MUST NOT name any capability the manifest does not request. The page MUST NOT state a count of permissions that disagrees with its own table.
- **FR-023**: The **install** page MUST state which OpenChamber surfaces do not run extension services, and what the panel shows on them.
- **FR-024**: The **install** page MUST state that a registered OpenChamber project is required per repository, and that the extension cannot create one.
- **FR-025**: The **configure** page MUST give the three setup steps in order — register the projects; add a GitHub account; bind a repository — and for each, name the panel surface that owns it.
- **FR-026**: The **configure** page MUST state the accounts disclaimer's facts before the account field: the token goes to the local service, which has the operator's own user access; it is stored outside extension storage, at file permissions, **unencrypted on disk**; the connection is recorded in the audit trail as an occurrence only; the disclaimer is always visible; and there is nothing to accept or decline.
- **FR-027**: The **configure** page MUST state the per-account expected-login constraint: it is supplied when the account is created, an empty value means no constraint, and a value that disagrees with the provider's answer is refused rather than applied.
- **FR-028**: The **configure** page MUST present the Settings tab as the single configuration input, and MUST list every configuration field the service declares, each with its value, unit, bounds or format, and **when a change takes effect** — immediately, from the next poll, or from the next dispatch.
- **FR-029**: The **configure** page's field list MUST be the service's own field list rather than a retyped copy, and a mismatch between the page and the shipped declaration MUST fail a check.
- **FR-030**: The **configure** page MUST state that one save writes the whole configuration document and that the service is the only validator — an out-of-range value is sent and refused by the service, which names the field and the remediation, rather than blocked in the panel.
- **FR-031**: The **configure** page MUST state what lowering a retention limit or restoring defaults will do, before the operator does it: what will be deleted, when the trim pass runs, what survives it, and that raising a limit deletes nothing. *(The product applying its own Principle II posture — an irreversible consequence is stated, never guessed at — to the two controls that delete.)*
- **FR-032**: The **configure** page MUST state that the configuration is stored in a file under the service data directory at restrictive file permissions, that the file is operator-backable, and that a hand-edited document which fails validation is set aside with the documented defaults taking over.
- **FR-033**: The **configure** page MUST state that nothing is configured through an environment file, an environment variable, or a manifest setting, and that the Settings tab and its configuration endpoints are the whole surface.
- **FR-034**: The **configure** page MUST document the layered starting prompt: the three tiers, their fixed order from most general to most specific, that they stack rather than replace one another, that an unset tier contributes nothing at all, that no tier label appears in the delivered text, and where each tier is set.
- **FR-035**: The **configure** page MUST state the starting prompt's guarantees: the text is literal with no substitution; the prompt cannot select an agent; the per-tier character cap after trimming, refused rather than silently truncated; a credential-shaped value is refused and never stored anywhere; and a reserved containment marker is refused.
- **FR-036**: The **use** page MUST give the first-dispatch sequence a reader can follow: trigger the work on GitHub, expect a dispatch row within about two poll intervals, the session is created by OpenChamber's own harness, the dispatch is marked dispatched with a link to the session, and the dispatch's audit history is readable from its row.
- **FR-037**: The **use** page MUST state that at most one session is created per dispatch, that an already-dispatched dispatch never re-dispatches, and that a dispatch which made no session keeps a retry control.
- **FR-038**: The **use** page MUST contain a state table covering **every** state the panel can display — each with what it means and which control moves it — and the wording MUST be the panel's own. The `blocked:` family MUST be described as a family with its causes, never as a fixed list of four reasons.
- **FR-039**: The **use** page MUST state that closing the panel never strands work: a claim whose lease expires returns to waiting on its own with the attempt counted and the reason audited, and a dispatch whose result never arrived is held and is **never** re-dispatched automatically.
- **FR-040**: The **use** page MUST describe the panel's setup-prerequisites section: how many prerequisites there are, that each carries its own state, that one of them is reported as *not checkable by the panel* because the panel genuinely cannot read it, that each carries its own remediation, and that an unmet checkable prerequisite is raised as a notice.
- **FR-041**: The **debug** page MUST contain a symptom table whose first column is the **exact** token or string the product renders, covering every symptom the panel and service surface today, each with what it means and what to do.
- **FR-042**: The **debug** page MUST state that both OpenChamber and its local service must be running for polling and dispatch, and MUST name the surface where the honest state is read — as constitution §Security and Operational Standards requires the dependency to be *"documented, surfaced as health/status, and never masked"*.
- **FR-043**: The **debug** page MUST state the data directory, what it holds, its directory and file permissions, and which of its contents survive an uninstall, and MUST state that the absolute path is shown inside the product rather than guessed.
- **FR-044**: The **debug** page MUST state which trail answers which question — the durable audit trail and the redacted ledger — what a correlation identifier is, and that no credential appears in either. *(Constitution IV — human-visible auditability.)*
- **FR-045**: The **debug** page MUST state what a hand-edited store file that fails validation does: it is quarantined with the reason logged and the file's reason naming the field, never the value, and work that depended on it stops until it is repaired. No file is silently rewritten and nothing is silently dropped.
- **FR-046**: No page MAY instruct anything that writes to GitHub, and no page MAY ask the reader to paste a credential into anything other than the Accounts tab's own field.

#### Block D — Fidelity, vocabulary, and the single-source rule

- **FR-047**: Every operational claim on every page MUST be traced to a named surface in this repository **before** it is published, and a claim whose trace target does not exist MUST NOT be published. The trace targets are the manifest, the panel tabs and their rendered strings, the service's declared configuration fields and bounds, the shipped dispatch-state vocabulary, the setup-prerequisite records, the troubleshooting tokens, and the store layout — not an author's memory of the product.
- **FR-048**: No page may name a capability, endpoint, field, state, or control the shipped build does not have. Where a page enumerates something the shipped code enumerates — the requested capabilities, the configuration fields and their bounds, the dispatch states — the enumeration MUST be derived from that declaration, and a check MUST fail when the page and the declaration disagree.
- **FR-049**: No topic may be authored at more than one length. Content moves: each section of the repository README maps to exactly one site page, and no section's substance is left in full in both the README and the site. The operator-facing walkthrough's install, first-run, store, and troubleshooting sections reduce to pointers to the site; its build and verification sections, which are contributor commands rather than operator documentation, remain.
- **FR-050**: Operator-facing prose across the site MUST use the panel's reserved vocabulary: **Dispatches** for the unit of work and **Bindings** for the watched-repository configuration, and MUST NOT use "run" or "repositories" as nouns for either. *(005 FR-020, as extended to this surface.)*
- **FR-051**: The site MUST carry the identifier-mapping table an operator needs to read a wire-level or log-level name and find the surface that produced it. *(005 FR-029, which requires this table to exist in the operator documents and which `README.md` does not currently carry.)*
- **FR-052**: No page may contain a placeholder, a template marker, a "coming soon", an empty section heading, or an instruction to fill something in later.
- **FR-053**: No page may render a version number of the product except one read from the shipped manifest at build time; no version literal may be authored in the site's sources. The About tab's version keeps its single source, read from the service.
- **FR-054**: No page may contain a credential, a token, a real account identifier, a correlation identifier, a filesystem path outside the documented data directory, or any repository secret — in the site's sources **or** in its build output, which MUST be scanned for credential material by the same patterns the repository applies to its committed bundles.
- **FR-055**: A change to a page is live only after it is merged to the default branch and published; the site MUST NOT be served from a branch, a preview environment, or any address other than the one FR-005 names.
- **FR-077**: `README.md` MUST NOT retain the claim that the approval dialog *"asks for exactly these four things"*, and MUST NOT name `network` or any other capability the shipped manifest does not request. Whether the paragraph is removed outright under FR-057 or survives as part of the reduced summary, **any** capability reference it keeps MUST be read from the same manifest declaration the install page's table is derived from (FR-022) — `sessions` and `prompt`, with `service` implied — and a check MUST fail when the README names a capability the manifest does not request, or omits one it does. This is the README-side half of the comparison AC-008 makes for the page, and it is what stops the stale row being carried into the canonical source by being copied out of the README that is being retired. *(The product owner's answer to `## Clarifications` Q2, settled 2026-10-05: **corrected here**, not deferred to issue #16's follow-up. The alternative would have left the canonical site and a knowingly-wrong README beside each other — the same drift 002 FR-042 exists to prevent, on a surface 002 FR-042's amended three-document list would then bound and correct.)* *(Allocated at v1.1.0 as the next free number in this document's sequence: Block D's own run `FR-047`–`FR-055` is fully allocated, so the number continues the sequence rather than renumbering or borrowing — the same convention 005 records. Its placement is topical, not numeric.)*

#### Block E — Entry points

- **FR-056**: The repository README MUST carry a documentation link near its top — above the first section of explanation — labelled as documentation, pointing at the site.
- **FR-057**: The README MUST reduce to: the product's identity, a short summary of what it is and that it runs on the operator's own OpenChamber, the documentation link, a pointer to the licence, and a contributor pointer. Its requirements, install, setup, starting-prompt, first-dispatch, failed-dispatch, data-location, security, uninstall, and troubleshooting prose move to the site.
- **FR-058**: The README's licence section MUST name MIT and link the licence file in the repository.
- **FR-059**: The panel's About tab MUST carry a documentation link that opens through the host's URL-opening path — the same path the repository link uses — so the panel's sandboxed frame never navigates itself away.
- **FR-060**: A refusal to open the documentation link MUST render on its own line, leave the address readable, and never be swallowed; and the About tab's static content MUST render whether or not the service is reachable.
- **FR-061**: The About tab MUST gain **no** interactive control: the documentation link is a link, not a button, input, select, or list, and the tab's control set is unchanged. Its version line keeps its single source and still prints no digit when the service is unreachable.
- **FR-062**: Any change under `src/` ends with the repository build run and the rebuilt panel bundle committed in the same commit, and the repository's secret-scan assertions over the shipped bundles remain green. *(AGENTS.md invariant 1.)*
- **FR-063**: Two module-level comments that assert the About tab's complete contents — the one describing the page as *"name, version, description, repository link"* and the one describing it as *"the whole page after the 2026-10-01 scrub"* — MUST be updated to match the page as shipped, because a comment that misstates the page is the defect this project exists to prevent.
- **FR-064**: The panel's existing About-tab assertions over its control set, its repository link, its version source, and its version-shaped-literal scan MUST remain green, and a check MUST assert the documentation link is present.

#### Block F — Build, verification, publishing

- **FR-065**: The site MUST be built on every pull request, and a build failure MUST fail the pull request.
- **FR-066**: The site MUST be published to GitHub Pages from a workflow when the default branch is updated. Publishing MUST NOT depend on branch-based publishing, and the repository's configured Pages source MUST be reconciled so that no stale branch-and-path setting is mistaken for the publishing mechanism.
- **FR-067**: Every action referenced by either the site's build workflow or its publish workflow MUST be pinned to a commit SHA, and the publish workflow MUST be granted **only** the permissions a Pages deployment requires. The repository's existing read-only gate workflow MUST keep the read-only permissions it declares today.
- **FR-068**: The site's build job MUST install from the site's own committed lockfile with a clean install, so a build is reproducible from what is committed.
- **FR-069**: The site's build job MUST type-check the site's own sources as well as build them, so a type error in a page or a component fails the pull request.
- **FR-070**: The site's directory MUST be excluded from the repository's root lint scope, and MUST NOT be added to the repository's root TypeScript project. The repository's root verification command MUST reach the panel, the service, and the tests exactly as it does today and MUST NOT lint, type-check, or build the site.
- **FR-071**: The site's build output and its build-tool cache directory MUST be ignored by version control, and the site's dependency directory MUST already be covered by the repository's existing ignore rule.
- **FR-072**: No lint rule may be disabled, and no type suppression may be added anywhere in the repository, to accommodate the site. *(AGENTS.md invariant 7.)*
- **FR-073**: The site's own Node floor MUST be satisfied by the Node release the site's workflows use, and that release MUST be one the repository already verifies green on.

#### Block G — The licence

- **FR-074**: The repository root MUST carry an MIT licence file containing the **full** MIT licence text — every grant, condition, disclaimer, and warranty waiver of the standard template, not a summary, not an excerpt, and not a substitute notice — and the copyright line **`Copyright (c) 2026 Shaun Burdick`**, exact and verbatim. *(The product owner's answer to `## Clarifications` Q1, settled 2026-10-05: the repository owner's name as GitHub renders it. That question's two alternatives — a `Mecha Turk contributors` line, and omitting the holder entirely — are **closed, not deferred**; only the holder string was open, and the year is fixed at 2026.)* Every page of the site links this file from its footer (FR-076).
- **FR-075**: The licence declared in the repository manifest and the licence file MUST agree, and no second licence may be asserted anywhere.
- **FR-076**: Every page of the site MUST carry a footer link to the licence file in the repository.

### Key Entities

- **Page**: one published document at one address under the site's base path. Five exist (FR-001): the landing page and four documentation pages. Each carries the product name, navigation to the other four, and a footer with the repository and licence links.
- **Documentation topic**: the subject a page is authoritative for — one of *what it is*, *install*, *configure*, *use*, *debug*. Each topic has exactly one home (FR-049), which is what makes "the site is canonical" an enforceable property rather than a preference.
- **Trace target**: the named surface in this repository a documentation claim is read from — a manifest field, a panel-rendered string, a declared configuration field and its bounds, a shipped state token, a prerequisite record, or a store path. Every operational claim names one (FR-047, FR-048).
- **Declaration**: a list the shipped code already owns and the documentation must mirror — the requested capabilities, the configuration fields with bounds and effect classes, the dispatch states, the prerequisites. A check compares each declaration against its page (FR-048).
- **Entry point**: a place from which a reader reaches the site — the README's near-top link (FR-056) and the panel's About-tab link (FR-059). Both are required; neither is sufficient alone.
- **Site build gate**: the pull-request job that builds and type-checks the site and fails the pull request on failure (FR-065, FR-069). It is the site's only gate, which is why it is specified rather than assumed.

### Non-Functional Requirements

- **NFR-001 — Static and self-contained**: every page is a static document; no page requires a server, a runtime, or a credential to render. **Verified by**: the published output contains no server entry point and every page loads with scripting unavailable.
- **NFR-002 — Zero client-side scripting**: no page ships JavaScript. **Verified by**: the built output contains no script file, and no page's HTML references one. This is the measurable form of NFR-001 and it is achievable because the site has no interactive component.
- **NFR-003 — No third-party request**: a page view results in requests to the site's own origin only, and to no third-party host (FR-010). **Verified by**: scanning every page and every asset it references for off-origin URLs, and by inspecting the build's emitted asset list.
- **NFR-004 — Accessibility floor**: one top-level heading per page in order; a labelled navigation landmark; every link with discernible text; every state and warning conveyed in text as well as colour; full keyboard reachability; and a text contrast ratio of at least 4.5:1 for body text. **Verified by**: the site's own check plus an automated audit of the built pages.
- **NFR-005 — Credential-free output**: neither the site's sources nor its build output contains credential material. **Verified by**: the same secret-scan the repository applies to its committed bundles, run over the site's build output (FR-054).
- **NFR-006 — Prose budget**: this feature is a move. The site's content plus the reduced README MUST NOT contain more documentation prose **words** than the README and the operator walkthrough contain today, excluding per-page navigation and footer furniture. **Verified by**: comparing the measured prose **words** before and after — the spend against those two documents' own pre-feature word figures, which the enforcing test carries as recorded constants rather than re-deriving, so the comparison needs no repository history. **The `.project-health` baseline is a different measurement, not this one's reference**: `.project-health/baseline.json`'s `allDocProseLines` (`10833`) is a tracked metric *of the project-health skill* over a different population — every documentation prose line in the whole repository, not these four documents' — and that number is its owner's to regenerate deliberately; it is read, never pinned, and carried into the test's failure output as the surrounding repository-wide reference so the comparison AC-016 asks for is on the record. **A budget that punishes the required format is measuring the wrong thing**, which is why the unit is words: the prose *line* is a unit of layout rather than of reader burden, and the format this document requires — five distinct pages (FR-001), a one-line-per-tab list (FR-015), generated field tables (FR-028, FR-029) — is structurally shorter per line than the paragraphs it replaced. *Was: "…comparing the measured prose **lines** before and after against `.project-health/baseline.json` (`allDocProseLines: 10833`), which the repository's most recent commit moved in the direction of reduction." — re-cut at v1.2.0 (GitHub issue #11) by product-owner amendment: the unit becomes **words** and the baseline is named as what it is, a neighbouring tracked metric, rather than as this requirement's reference. The obligation itself — a move, not an expansion, net documentation prose not larger than before — is unchanged.*
- **NFR-007 — Gate integrity**: the repository's existing verification command keeps its meaning, its steps, and its budget, and the existing bundle-freshness check is untouched. **Verified by**: the root gate's step list and timeout being byte-identical before and after, and `git diff --exit-code` still failing a source change that did not bring its bundle.
- **NFR-008 — Contributor loop**: a contributor on a clean clone can install, preview, and check the site using only the repository's own documentation, and every command in it is stated with its expected output (see [quickstart.md](quickstart.md)). **Verified by**: following the quickstart on a clean clone.
- **NFR-009 — Accessibility of the panel's new link**: the About tab's documentation link renders and reads as a link, in the same manner as the repository link beside it, and introduces no control the tab did not already have (FR-061).

### Success Criteria

#### Measurable Outcomes

- **SC-101**: The published address `https://shaunburdick.github.io/mecha-turk/` returns HTTP 200 for the landing page and for all four documentation pages, and returns no 404 for any asset or internal link those pages reference. *(Today the same address returns 404 — the baseline is measured, not assumed.)*
- **SC-102**: Exactly five pages are published; a build of the site produces no page beyond those five.
- **SC-103**: A pull request that breaks the site build, or introduces a type error in the site's sources, fails its checks; the same pull request green means the site builds.
- **SC-104**: Every operational claim on every page names a trace target that exists in this repository, and every enumeration on every page matches the shipped declaration it mirrors — verified by an automated comparison for capabilities, configuration fields and bounds, and dispatch states.
- **SC-105**: Every symptom token the panel or service renders today appears in the debug page's symptom table, matched exactly.
- **SC-106**: The README contains no section whose substance is also present in full on a site page; each README section maps to exactly one site page.
- **SC-107**: The repository's own verification command is green before and after this feature, its step list is unchanged, and its test count does not decrease.
- **SC-108**: A licence file exists at the repository root containing the full MIT text, the year 2026, and a holder line; the manifest's declared licence and the README's licence section agree with it.
- **SC-109**: The About tab renders the documentation link with the service both reachable and unreachable, its control count is unchanged, and its version line still has exactly one source.
- **SC-110**: Measured documentation prose does not increase (NFR-006).

---

## Acceptance Criteria

*Binary. Each is checkable by running a command or reading a file, with no interpretation.*

**Site shape and identity**

- [ ] **AC-001**: The site publishes exactly five pages — a landing page at the site root and `/install/`, `/configure/`, `/use/`, `/debug/` (or equivalent stable addresses) — and the built output contains no further page.
- [ ] **AC-002**: The site's base path is declared in exactly one file, and the built output serves every asset and internal link under `https://shaunburdick.github.io/mecha-turk/`: fetching the landing page and following every link and every referenced asset returns a non-404 response.
- [ ] **AC-003**: Every page contains a link to the landing page and to all four documentation pages, and every one of those links resolves.
- [ ] **AC-004**: No page references a remote font, script, stylesheet, image, analytics endpoint, or content-delivery host; the built output contains no image file and no script file.
- [ ] **AC-005**: Every page contains exactly one top-level heading, a navigation region, and a footer containing a link to the licence file in the repository.
- [ ] **AC-006**: No page contains a screenshot, a "coming soon", a template placeholder, an empty section, or a TODO.

**Content fidelity**

- [ ] **AC-007**: The install page's permission table names `sessions`, `prompt`, and the implied `service`, names no other capability, and its stated count equals the number of rows it lists.
- [ ] **AC-008**: A check compares the install page's permission table against the manifest's declared capabilities and fails if the page names a capability the manifest does not request, or omits one it does.
- [ ] **AC-009**: A check compares the configure page's field list against the service's declared configuration fields — names, bounds, units, defaults, and take-effect classes — and fails on any difference. Eleven numeric fields, the log level, the agent-verification baseline, and the global starting prompt are all present.
- [ ] **AC-010**: A check compares the use page's state table against the shipped dispatch-state vocabulary, including the open `blocked:` family described as a family, and fails if any shipped state is absent.
- [ ] **AC-011**: Every symptom token the panel and service render today appears verbatim in the debug page's symptom table; the check enumerates the tokens from the source and fails if any is absent from the page.
- [ ] **AC-012**: No page contains the word "run" as a noun for a unit of work or "repositories" as a noun for bindings, and the site uses **Dispatches** and **Bindings** where those subjects are named.
- [ ] **AC-013**: The site contains the identifier-mapping table, mapping each wire-level and log-level name a reader may encounter to the surface that produces it.

**Prose discipline**

- [ ] **AC-014**: Each section of the README maps to exactly one site page; no README section's substance is also present in full on a site page; and the README is a summary plus a documentation link, a licence pointer, and a contributor pointer.
- [ ] **AC-015**: The operator walkthrough's install, first-run, store, and troubleshooting sections point to the site rather than restating it, and its build and verification sections are unchanged.
- [ ] **AC-016**: Measured documentation prose **words** — site content plus README — do not exceed the README plus the operator walkthrough's prose words as measured before this feature, excluding per-page navigation and footer furniture, with the measurement command and both figures recorded in the pull request. The prose **line** count of the same set is measured and recorded beside the words but is **not** an enforced ceiling: a prose line is a unit of layout rather than of reader burden, and the format this document requires (FR-001's five distinct pages, FR-015's one-line-per-tab list, FR-028/FR-029's generated field tables) is cut into more, shorter units than the paragraphs it replaces — so a line budget would penalise the specified format while measuring template structure. *Was: "Measured documentation prose — site content plus README — does not exceed the README plus the operator walkthrough as measured before this feature, excluding per-page navigation and footer furniture, with the measurement command and both figures recorded in the pull request." — the unit is re-cut at v1.2.0 by product-owner amendment from an unnamed unit to **prose words**, with the prose line count demoted from a ceiling to a reported and pinned figure. The spend, the budget, the exclusion, and the recording duty are unchanged, and the id is not renumbered.*

**Tooling isolation**

- [ ] **AC-017**: The repository's root `package.json` is byte-identical before and after this feature: it declares no dependency on the site's build tool, no `workspaces` key, and the same `version`, `engines.node`, and `openchamber` block.
- [ ] **AC-018**: The repository's root verification command runs the same steps in the same order with the same timeout as before, passes, and its test count does not decrease.
- [ ] **AC-019**: Running the repository's lint over the tree reports no file under the site directory, and running the repository's TypeScript project reports no file under the site directory.
- [ ] **AC-020**: No lint rule is disabled and no type suppression is added anywhere in the repository as part of this feature; the repository-wide scan for suppressions reports no new occurrence.
- [ ] **AC-021**: The site's build output and cache directory are untracked after a local build, and the site's dependency directory is untracked, with no untracked-file exception needed.
- [ ] **AC-022**: A pull request that introduces a syntax error in a page fails its checks; reverting it makes them pass.

**Build, publish, entry points**

- [ ] **AC-023**: The site's workflows reference every action by commit SHA, and the publish workflow's declared permissions are exactly those a Pages deployment requires; the existing repository gate workflow's permissions are unchanged.
- [ ] **AC-024**: A merge to the default branch produces a successful deployment, and the deployment records the address it published to.
- [ ] **AC-025**: `https://shaunburdick.github.io/mecha-turk/` returns 200, and each of the five pages returns 200.
- [ ] **AC-026**: The About tab renders the documentation link with the service reachable and with the service unreachable; its control count is unchanged from before the feature; its version line carries no digit in the unreachable state; and the documentation link is asserted by a test.
- [ ] **AC-027**: The About tab's module comment and the suite comment that assert the page's complete contents state the page as shipped, and no comment in the repository describes the About tab as four items.
- [ ] **AC-028**: The rebuilt panel bundle is committed with the `src/` change in the same commit, and the repository's existing bundle-freshness check and secret-scan assertions pass.

**Licence**

- [ ] **AC-029**: A licence file exists at the repository root, contains the full MIT licence text, states the year 2026, and carries a copyright holder line; the manifest's declared licence and the README's licence section agree with it.

**Constitution discharge**

- [ ] **AC-030**: The landing page states that nothing runs while OpenChamber is off and names where the honest state is read, satisfying the requirement that this dependency be documented and surfaced rather than masked.
- [ ] **AC-031**: The landing page and the debug page state both storage locations, what each holds, and which survive an uninstall, and no page claims audit history lives in storage the operator cannot back up.

---

## Out of Scope

Each exclusion was offered and declined by the product owner on 2026-10-05, or belongs to another issue. Nothing here is deferred pending a decision.

| Excluded | Why |
| --- | --- |
| **Screenshots or any image in the site** | Offered and declined. The repository already has an offline screenshot harness (`npm run shot`, git-ignored output); committed images would add a binary artifact surface and a staleness obligation for no reader gain. |
| **A FAQ page** | Offered and declined. A fifth-plus page re-opens the multi-home problem FR-049 exists to close. |
| **Site search** | Offered and declined. Five pages do not need an index, and a search index is a build artifact that must be kept current. |
| **A dark-mode toggle** | Beyond the build tool's default behaviour. |
| **A troubleshooting *reference* page beyond the debug page** | Would be a second home for FR-041's symptom table. |
| **Raising the repository's root Node floor** | Tracked as **issue #17**, and **resolved outside this feature**: merged 2026-10-05 as `>=24.15.0`. This feature touches neither the root manifest's floor nor FR-007's prohibition, and declares the site's own floor separately (FR-007, FR-008). *(At v1.0.0 – v1.2.0 this row read "Tracked as **issue #17**. This feature leaves `engines.node` at `>=20.19.0`…" — the number moved because #17 landed, not because this feature moved it.)* |
| **Any change under `service/`** | The poll loop, the store, the credential files, and the event queue are untouched. The site's debug page *documents* them; it does not change them. |
| **Any change to dispatch semantics, the wire contract, or `extension-spike-1`** | `AGENTS.md` invariant 10. |
| **A new manifest capability, `host.storage` key, or `network` capability** | `AGENTS.md` invariant 3; the `network` capability was removed by product-owner order on 2026-09-30. The site documents what is requested and nothing more (FR-022, FR-048). |
| **A content-collection framework, i18n, analytics, a cookie banner, or any third-party script or font** | FR-010, FR-012, NFR-003. |
| **A version bump** | `AGENTS.md` invariant 2 — a release bump is a release, not a documentation change (FR-007). |
| **A domain name or custom `cname` for the site** | The Pages address is the site's address. |
| **Changing how the panel reaches the service, or adding a documentation *fetch* to the panel** | The panel reads no documentation over the network and gains no capability; the About link opens in the operator's browser through the existing host path (FR-059). |

---

## Assumptions

- The operator has a web browser and a network connection to reach the published site. The site is documentation for humans, not an offline artefact, and no offline copy is shipped.
- The site's content is derived from this repository at the revision it is built from. A page is never ahead of the code it documents.
- The Pages site stays enabled and public, and the repository name stays `mecha-turk`. A rename changes the site's address (FR-005); nothing in this feature assumes otherwise.
- The four documentation pages are enough to replace the README's operator prose. If a fifth topic emerges from the content move, it becomes a section of the page that owns its subject rather than a sixth page (FR-001).
- The MIT licence's holder is the repository's owner. **Settled** 2026-10-05 (`## Clarifications` Q1): the copyright line is exactly `Copyright (c) 2026 Shaun Burdick` (FR-074). No open question remains on this line.
- No page needs to be written for a user who has not installed the product *and* wants a reference of the HTTP endpoints. **Ruled** by the product owner 2026-10-05 (`## Clarifications` Q3): the debug page documents the **panel and files** surface only, and names no endpoint. The service listens on a loopback port with a host-provided token, so a reader has no supported way to reach it from a shell.
- The site's build runs on the Node release the repository's CI already uses, so no new Node version is introduced into this repository's workflows.
- Astro's own base-path handling is relied upon rather than reimplemented; the feature's obligation is to verify the published result, not to implement subpath routing.

---

## Clarifications

Six product-owner decisions are **locked** and encoded above; they are recorded, not re-opened.

| # | Locked decision | Encoded at |
| --- | --- | --- |
| L-1 | The site is the canonical documentation; the README's documentation prose moves to it and the README shrinks to a short summary plus a link. | FR-002, FR-049, FR-057 |
| L-2 | Page scope is exactly one landing page plus four documentation pages (install, configure, use, debug). No screenshots, no FAQ, no search — all three were offered and declined. | FR-001, FR-009, `## Out of Scope` |
| L-3 | The site is built on every pull request (a broken site fails the check) and published to GitHub Pages on push to `main`. | FR-065, FR-066 |
| L-4 | Both entry points are required: a short link near the top of the README, and a documentation link in the panel's About tab. | FR-056, FR-059 |
| L-5 | A full MIT licence file lands at the repository root with the year 2026 and the copyright line `Copyright (c) 2026 Shaun Burdick`; the site's footer links it. | FR-074, FR-076 |
| L-6 | Pages publishing is workflow-driven, not branch-publish. | FR-066 |

### Three confirmations, answered by the product owner 2026-10-05

All three were put to the product owner with an encoded default so that planning need not wait for an answer. **The owner has now answered all three. Each answer below is settled, not a default** — Q1 and Q3 changed what a requirement says, and Q2 added **FR-077**. None is open, and none blocked Phase 4. The defaults are retained below only as the record of what each answer displaced.

**Q1 — Who is the MIT copyright holder? — Answered: `Shaun Burdick, 2026`.**
*Why it matters:* the licence file needs a holder line and only the product owner can supply the exact string; a wrong name on a licence is a legal artefact with the author's name on it, not a typo.
**Ruling (2026-10-05):** the repository owner's name as GitHub renders it, with the year **2026** — so the licence file carries the **full** MIT licence text and the copyright line **`Copyright (c) 2026 Shaun Burdick`**, exact and verbatim. Encoded in **FR-074**; the site's footer link was already **FR-076**. **The two alternatives are closed, not deferred**: the `Copyright (c) 2026 Mecha Turk contributors` fallback, and omitting the holder line entirely — the latter never recommended, because the MIT template's copyright line is what the licence is granted under.

**Q2 — Does correcting the stale `network` row in the README's install table belong to this feature, or to issue #16's follow-up? — Answered: correct it here, in this feature.**
*Why it matters:* `README.md` §Install tells the reader the approval dialog *"asks for exactly these four things"* and names `network`; the shipped manifest requests `sessions` and `prompt` with `service` implied, and `AGENTS.md` invariant 3 records that `network` was removed by product-owner order on 2026-09-30. This feature rewrites the install page from the manifest (FR-022) and reduces the README (FR-057), so the stale row would otherwise be **copied into the canonical source** or left behind beside it.
**Ruling (2026-10-05):** **corrected here.** The encoded default is now the owner's decision, not a fallback. FR-022 and AC-007/AC-008 already bind the *install page's* table; correcting only the page would have satisfied them while the README kept making the false claim, so the ruling is carried by a **new requirement, FR-077**, which binds the README side to the same manifest declaration and adds the README-half of the comparison AC-008 makes. **No requirement id is renumbered.** Deferral to issue #16's follow-up — the state in which the site is correct and the README is knowingly wrong until that issue lands — is closed.

**Q3 — Does the debug page document the local service's HTTP surface? — Answered: no. Panel and files only.**
*Why it matters:* "debug" could mean *panel and files* or *the API*. The service listens on a loopback port whose port and token are provided by the host, so an operator has no supported way to reach it from a shell; documenting `curl` calls would document a path the product does not support, and would put a token in a reader's copy-paste history.
**Ruling (2026-10-05):** the debug page covers the panel's rendered symptoms, the state table, the data directory and its permissions, the two trails, and hand-edited-file recovery (FR-041 – FR-045), and names **no** HTTP endpoint. `GET /v1/status` and `GET /v1/config` stay off the debug page entirely — the option that framed them as read-only diagnostics is **closed**, not deferred, and the port-and-token story it would have required is not written.
*Verified rather than asserted:* **no requirement in this document implied the opposite, so none needed correcting.** The only place 007 names a `/v1/` endpoint at all is **User Story 3** scenario 5 — the **configure** page saying that `GET`/`PUT /v1/config` is the whole configuration surface — and the requirement beside it, **FR-033**, makes the same statement without a path (*"the Settings tab and its configuration endpoints are the whole surface"*). Both are about how the product is *configured*, not about debugging it. **FR-042** asks the debug page to name *"the surface where the honest state is read"* — the Status tab, as constitution §Security and Operational Standards intends — not an endpoint that surfaces it.

### Phase 3 record — 2026-10-05

**Q4 — Does this feature require a constitutional amendment? — No, and none is made.**

`.specify/memory/constitution.md` stays at **v1.3.0** (ratified 2026-09-26, last amended 2026-09-27). The reasoning, against the actual text rather than a general impression:

- **No principle text is made obsolete.** The single amendment in the history (v1.3.0) was justified because Principle V "described the deployment target as *one self-hosted container*, which was accurate for the fallback daemon architecture the project started with" — *factually obsolete, not violated*. Nothing here makes a principle's text false. This feature adds a documentation site and a licence file to the repository; it adds no polling, no provider adapter, no policy gate, no durable state, no audit row, no orchestrator split, and no runtime requirement.
- **Principle V is honoured, not extended.** It governs *the product's deployment*: self-hosted inside the operator's OpenChamber, no proprietary hosted control plane, infrastructure complexity justified by a measurable need. A static documentation site is none of those things — it requires no infrastructure from the operator, no container, no service, and no control plane, and it removes nothing from the product's deployment. It is squarely inside the principle's intent.
- **§Governance permits this outright**: *"A feature specification may add constraints but may not weaken these principles without an explicit constitutional amendment."* This feature adds constraints (no third-party requests, zero client-side scripting, a prose budget, a base-path acceptance criterion) and weakens none.
- **The two load-bearing §Security and Operational Standards items are discharged, not reinterpreted.** The "unattended operation depends on the operator's OpenChamber installation running … must be documented, surfaced as health/status, and never masked" item is satisfied *by publishing pages* that say so and name where the state is read (FR-014, FR-019, FR-042, AC-030). The "durable state must match the storage it actually lives in" item is satisfied by publishing the two locations with their retention facts (FR-016, FR-043, AC-031). Neither is satisfied by inventing a requirement in this document; both are satisfied by the artefact, which is why each carries its own acceptance criterion.
- **The outbound-HTTPS item needs no amendment and is not weakened.** It reads *"Use outbound HTTPS only for MVP GitHub and the configured OpenChamber endpoint"* — its subject is the **product's runtime**, and in this product the local service is the only thing that makes an outbound request. A static documentation page is not that runtime: it holds no token, opens no GitHub connection, and exists only when a reader's browser fetches it. This feature nonetheless adopts a **stricter** posture anyway — a reader's browser makes zero requests to any origin but the site's own (FR-010, NFR-003) — which is a constraint the constitution permits a specification to add, not one that requires the constitution to change. Recorded as `research.md` R-8 so a reviewer can check the reading rather than inherit it.
- **The full §Development Quality Gates are unaffected.** Strict checking and linting remain mandatory (FR-069, FR-070, FR-072); no implementation begins before this specification is approved (it is not); compatibility-sensitive external APIs stay pinned (FR-006); and no capability is reimplemented through a private API — the site's About link uses the host path the panel already uses (FR-059).

**One honest consequence, stated rather than discovered later.** Because the site must be a self-contained subproject (research.md §2), the repository's root verification command **cannot** reach it, so the site's own pull-request job becomes its only gate. That is a real reduction in what one command proves, and it is the reason FR-069 requires the build job to type-check as well as build, and FR-065 makes its failure fail the pull request. It is a consequence of a locked decision (self-contained subproject, forced by the Node-floor conflict), not a gap in this specification.

### Q5 — Which unit does the prose budget measure? — Answered: words. (Product-owner amendment, v1.2.0, 2026-10-05)

*Why it matters:* FR-049's *"a move, not an expansion"* has to be falsifiable, or it is an intention. A budget supplies the falsification, and the unit supplies the trap: AC-016 as written at v1.0.0 named no unit, and the enforcing test resolved it to **prose lines**, which measured 462 against the pre-feature 446 and recorded a sixteen-line miss.

**Ruling (2026-10-05):** the budget measures prose **words**. The measurements, all taken with the same markup-stripping rule:

| | prose lines | prose words |
| --- | --- | --- |
| `README.md` + operator walkthrough at `d2d3f40` (the budget) | 446 | **5,770** |
| the five site pages + the reduced README now (the spend) | 462 | **5,040** |
| difference | +16 (+3.6%) | **−730 (−12.6%)** |

The documentation **shrank by 730 words** while growing sixteen lines. The sixteen are **structural, not a wrap artefact**: the site's content is cut into more, shorter units — headings, list items, definition terms, table cells — giving **10.9 words per line against the documents' 12.9**. That was **measured rather than assumed**, the decisive check being a full re-flow of the site at the pre-feature 80 columns, which still measures **450** lines: re-wrapping is not the lever. **Rejected alternative — keep the line ceiling and shrink the site to 446 lines**: a budget that punishes the format the specification requires (FR-001's five distinct pages, FR-015's one-line-per-tab list, FR-028/FR-029's generated tables) measures template structure rather than reader burden, and reaching it would mean writing the required format less clearly to satisfy a number. Words make the same claim falsifiable without that cost, which is the only reason prose was measured at all. **The words metric is ratcheted, not merely re-reported**: growth past 5,770 fails the gate, and the pre-feature figures stay **recorded constants** so the comparison needs no repository history — `actions/checkout` in `verify.yml` is at default depth, and a gate that works in a developer's clone and not in CI is worse than none. The prose **line** count is still measured, still reported beside the words, and still pinned to a recorded figure so it cannot move unnoticed — but it is **no longer a ceiling**: it records a structural fact rather than bounding reader burden, and AC-016 says so in its own body.

**Zero clarification markers remain in this document**, at v1.2.0, v1.1.0 and v1.0.0. The three confirmations above are now **answered** rather than open — recorded as a question and its ruling, following this repository's own convention that 002, 005, and 006 all carry a `## Clarifications` section in exactly this shape — rather than as inline markers. An automated scan for clarification markers over `specs/007-homepage-docs/` reports nothing.