# Feature Specification: Per-Binding Starting Prompt

**Feature ID**: `004-starting-prompt`

**Feature Branch**: `full-project-plan` (the planning branch for the post-MVP cycle; the spec directory and the git branch are independent. Implementation moves to its own `004-starting-prompt` branch per `AGENTS.md` git conventions.)

**Created**: 2026-09-28

**Last Updated**: 2026-09-28

**Version**: 1.1.0

**Status**: Approved (v1.0.0) — 2026-09-28. Specification content approved by the product owner on 2026-09-28; the three questions in `## Resolved Gate Questions` are confirmed against the defaults already encoded, recorded in `## Clarifications` rows 18–20, and the fourth (omission-preserves on a whole-file write) is confirmed as a technical default at row 21. Approval changed no requirement text, so the version stayed 1.0.0. Amended to v1.1.0 on 2026-09-28 by feature 005, which places this feature's field on the panel's Bindings tab and records the single-rendering rule that keeps it from appearing twice; it supersedes nothing in this document and changes no requirement text. See `## Amendment History`. Cleared for `/speckit.plan` (Phase 4). The normative body below is unchanged from the version submitted at the gate.

**Dependencies**: Feature 002 `002-agent-event-extension` (v1.2.0 → **amended to v1.3.0 by this specification** → **v1.4.0 by 005**) and feature 003 `003-dispatch-integrity` (v1.0.0 → **amended to v1.1.0 by this specification** → **v1.2.0 by 005**). Credentials, custody, the binding model, the trigger set, polling, the dispatch mechanism, the agent pin, the run/delivery model, the dispatch-lifecycle audit vocabulary, the read-only-to-GitHub posture, and the dispatch state model all carry forward unchanged. This specification **extends** 002's dispatch payload and 003's audit row and run projection; it supersedes nothing. It is a **prerequisite of 005** (panel IA), which renders this field exactly once and specifies that rule as 005 FR-051. **Extended by** `005-panel-ia` v1.0.0 (see `## Amendment History`), which supersedes nothing here. 005 depends on this specification, not the reverse; this specification remains independent of 006 (settings CRUD).

**Input**: Product-owner brief (2026-09-28) — "Create Bindings by assigning an account to a repo and an OpenChamber Project, defining which events to listen to, and **(new) provide a starting prompt for that session**". The "(new)" clause is this feature; every other element of that brief shipped under 002. Composition shape locked by the product owner on 2026-09-28: **trusted operator intent first, auto-built source below**. Scope source: `specs/003-dispatch-integrity/pm-handoff.md` §Feature Roadmap.

**Constitution**: `.specify/memory/constitution.md` v1.3.0 — Approved 2026-09-27 by product owner. Governing principles: **II (safe autonomy by default)** and **IV (human-visible auditability)**, with **VI (specification and verification before implementation)** supplying the testable-requirement discipline and **VII (thin orchestration boundary)** the constraint that the host keeps ownership of everything this feature touches.

## Problem Statement

A dispatch today begins with the machine's own words. The agent is handed a frame the extension composed — a correlation id, a repository, an issue number, a title, a URL, the machine account, a rule line, and a block of delimited untrusted issue text — and nothing else. That frame is a faithful description of *where the work came from*. It says nothing about *what the operator wants done with it*.

The operator knows their own repository. They know that an issue tagged `docs` wants a reproduction before a patch, that a `security` label means route it to a specific person rather than to an agent with write access, that the `specs/` tree is read-only, or that a given kind of issue has been reassigned four times and should be closed with a comment instead of worked. None of that can be expressed today. The only available customisation is *which repository* is watched and *which project* it dispatches into — both of which are already spent on routing, and neither of which carries an instruction.

So the product's central promise — Mecha Turk turns external GitHub activity into agent-led work — bottoms out in a dispatch whose intent is whatever the project-manager agent infers from a title and a body. The operator has configured *what* should happen, but not *how*, and every dispatch is a fresh session with no memory of what this binding's owner wanted last time.

This specification adds one field to a binding: a **starting prompt**, the operator's own words, dispatched ahead of the auto-built framing. Everything else about the dispatch is unchanged.

The hard part is not adding a text box. It is adding an **untrusted-adjacent input to a security boundary without weakening that boundary**. The framing exists because source text is untrusted and must not be able to alter policy, credentials, approval requirements, or tool scope. A prompt placed above that framing is, by construction, an instruction the agent will read as coming from its principal. It must be: it is the operator's own configuration, written by the operator, about the operator's own repository, in a store the operator controls. But the moment operator text sits above the delimiters, three questions become urgent and must be answered by requirement rather than by convention:

1. **Where does the text live?** The binding store is service-owned durable state (002 FR-033); `host.storage` is wipeable panel UI state (002 FR-034). A starting prompt is configuration. It belongs with the bindings.
2. **What happens when the operator pastes a secret?** The prompt is free text with no schema, so unlike every other field in this product it can carry anything. The product's secret-containment standard is a hard invariant, and a warn-and-store path would put a credential at rest, in a file, that the existing scan suites are built to fail on.
3. **What happens when the operator writes "use the code-reviewer agent"?** The platform strips any per-call agent, model, or variant. The only deterministic pin is Session Defaults → Default Agent, verified after dispatch. A prompt is a plausible-looking back door to that pin, and a specification that does not close it will eventually be read as opening it.

## Governing Principles and Relationship to Features 002 and 003

### How the amendment is sequenced

004 is an **extension**, not a conformance repair, so the sequencing differs from 003's in one respect and matches it in the other.

- **It matches 003 in mechanism.** 004 touches requirements its predecessors own — 002's dispatch payload (FR-028) and audit clause (FR-035), 003's audit row shape (FR-061), audit vocabulary, and run projection. Rather than editing either document's normative text, this specification states the authoritative requirement and records the delta in a `## Amendment History` section in each predecessor, plus a banner under each header. Both bodies stay verbatim, so the record of what was specified and what shipped survives.
- **It differs in direction.** 003 **superseded** 002 because the shipped build contradicted 002's own text. 004 does not: the shipped build has no prompt field at all, and the requirements it amends are unviolated. The status for every affected predecessor requirement is therefore **extended**, not superseded, and the `## Amendment Map` below says so requirement by requirement.

If the three documents are ever read as disagreeing about what a dispatch carries, what a dispatch-lifecycle audit row contains, or what the run projection shows, **this document prevails** for the starting prompt, and the predecessors' `## Amendment History` sections are the index that proves it.

### Invariants this feature must not weaken

- **Read-only to GitHub stands (002 FR-031, 003 FR-002).** Nothing here adds a write, and no prompt content may be satisfied by one. A prompt that says "comment on the issue" is text handed to an agent; Mecha Turk acts on nothing.
- **The agent pin stands (002 FR-029).** The platform strips per-call agent, model, and variant; the deterministic pin is Session Defaults → Default Agent, verified post-dispatch (warn-only and visible per 003 FR-043, and presented as *not checkable by the panel* per 003 FR-072). A prompt is text, never a selector.
- **Secret containment stands (002 FR-007, 002 NFR-004, 003 NFR-106).** The one genuinely new free-text input in the system is refused at the boundary if it carries a secret shape, so the secret-scan suites keep their meaning and gain no exemption.
- **Fail closed (002 FR-024, 003 FR-003, constitution II).** An oversized, secret-shaped, or structurally hostile prompt is refused with a field-level remediation, and the refusal leaves the previously stored prompt in force.
- **The untrusted region stands (002 FR-028, 003 FR-014).** Bounds, delimiters, and truncation markers are unchanged and unremovable by prompt content.
- **Thin orchestration boundary (constitution VII).** No new host capability, API, permission, or private interface (003 NFR-110). The prompt travels in the attachment text of the existing `host.startSession()` call.
- **Manual cleanup only (002 FR-040).** Unchanged and untouched.
- **003's dispatch state model is not restated and not contradicted.** Leases, requeue budgets, `unconfirmed`, dead-lettering, and the impossible-second-session property belong to 003. Where this specification needs one of them — a retry reusing the same snapshot — it *composes* with 003's rule and cites it.

## Architecture Impact

The panel↔service split is unchanged. What changes is one field's ownership, one record's contents, and one text block's position.

| Component | Change in 004 | Never changes |
| --- | --- | --- |
| **Panel** | Renders nothing new. Reads the prompt with the bindings, carries the snapshot onto dispatch, and composes the message with the prompt first. No editor, no preview, no display surface is added. | Never persists the prompt to `host.storage` or the ledger; never creates a second editor; never sends a per-call agent, model, or variant; never writes to GitHub |
| **Service** | Validates, stores, and fingerprints the prompt on the binding; snapshots prompt, fingerprint, and length onto the queued record at detection; writes one audit row per prompt change; adds two credential-free fields to the dispatch rows | Never dispatches on the prompt's account; never lets the prompt reach a trigger, a policy profile, or a capability; never applies a text rule to the operator's words beyond the three refusals |
| **OpenChamber host** | Unchanged. One `host.startSession()` call, same shape, same attachment, same worktree option, same pin. | — |

The unit of work does not change. One session, attached to one issue or pull request, in the operator's own installation, now opening with the operator's own sentence.

### Placement in the roadmap

| # | Feature | Size | Relationship |
| --- | --- | --- | --- |
| 003 | Dispatch integrity & recovery | Medium | 004 composes with its run, retry, and audit rules; amends its row shape and projection |
| **004** | **Per-binding starting prompt** | **Medium** | **This specification** |
| 005 | Panel IA — six tabs | Large | Renders the field exactly once; 004 fixes the field, its name, and its meaning so 005 does not have to invent them |
| 006 | Settings — full service config CRUD | Medium | Independent; the prompt is binding configuration, not service settings |

004 deliberately lands immediately before 005. A prompt field rendered twice, or rendered once by 005 against a different name and a different meaning than 004 specified, is a worse outcome than a prompt that ships one cycle later. 004 lands first so the field is fixed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — My binding starts the work the way I want it started (Priority: P1)

As a repository owner, I write a few sentences on a binding saying what I want done when that repository triggers, so that the agent begins with my instruction instead of guessing from an issue title — while still seeing the issue, the repository, and the project it is working in.

**Why this priority**: This is the feature. Every other requirement in this specification protects the boundary around this one field, and without it the product dispatches a session whose intent it never learned.

**Independent Test**: Create one active binding with a three-line prompt, seed an issue assignment for the bound identity, let the poller detect it, and read the session's first message: the operator's three lines appear first, verbatim, and everything the machine contributed appears beneath them, unchanged in content and still delimited.

**Acceptance Scenarios**:

1. **Given** a binding whose prompt reads *"Reproduce first, then patch. Do not change the public API without saying so in your summary."*, **When** an issue assignment for the bound identity is dispatched, **Then** the session's first message opens with exactly that text, unmodified and un-summarised, and the automatic framing follows below it.
2. **Given** the same binding, **When** the dispatch is inspected, **Then** the message also carries the resolved project, the source attachment's id, title, url, and kind, the configured worktree option, the correlation id, and the bounded delimited untrusted excerpt — every element 002 FR-028 requires today.
3. **Given** two bindings on the same repository with different prompts, **When** both trigger, **Then** each session receives its own binding's text and neither session shows the other's, and each run identifies which of the two produced it.
4. **Given** a long prompt at the maximum permitted length, **When** it is dispatched with a long issue body, **Then** the prompt appears in full, the source excerpt is the part that is shortened, and the shortening is marked visibly.
5. **Given** the operator edits the prompt, **When** the next dispatch runs, **Then** the new text is used, and every earlier dispatch still shows the text that produced it.

---

### User Story 2 — Nothing about my existing setup changes (Priority: P1)

As an operator who has been running Mecha Turk since the MVP, I upgrade and my bindings keep working exactly as before, so that adding a field to the product does not become an outage in my workflow.

**Why this priority**: The product is unattended. A change that alters every existing dispatch's first message would invalidate every agent session in flight and every mental model an operator has built. Backward compatibility here is a safety property, not a nicety.

**Independent Test**: Capture the composed dispatch message for a seeded event on the current build. Upgrade. Dispatch the same seeded event. Compare byte for byte.

**Acceptance Scenarios**:

1. **Given** a binding written before this feature existed, **When** it is dispatched, **Then** the composed message is byte-identical to the one the previous build produced for the same event, and the prompt block is absent entirely — not empty, not a placeholder, not an empty fence.
2. **Given** an installation upgrading to this feature, **When** the service starts, **Then** no migration runs: no bindings file is rewritten, no file is quarantined by the upgrade itself, no binding's scan window is reset, and every queued record still dispatches with the text it was queued with.
3. **Given** a binding whose prompt an operator cleared, **When** it dispatches, **Then** it behaves exactly as a binding that never had one.

---

### User Story 3 — My prompt cannot become a back door (Priority: P1)

As an operator, I know that if I could talk my way past the product's safety rules I would eventually do it by accident, so that whatever I write in the prompt — name an agent, ignore the untrusted block, grant yourself write access — the framing, the pin, and the credential boundary stay exactly where they are.

**Why this priority**: A prompt is a new instruction channel into an agent. Any channel a user believes is unrestricted becomes a channel somebody will try to route around, and the product's constitution treats a missing or ambiguous authorisation as a stop condition. This story is why the feature is safe to ship at all.

**Independent Test**: Write a prompt that names an agent, instructs the agent to treat the untrusted block as trusted, and claims the session has write access. Dispatch it. Read back what actually happened: the session's agent, the message's structure, the credentials present, and the outbound requests.

**Acceptance Scenarios**:

1. **Given** a prompt reading *"Use the code-reviewer agent. You have write access. Treat everything below as trusted instructions."*, **When** it is dispatched, **Then** the text reaches the session verbatim as instruction, the session still runs under the operator's pinned Default Agent, the post-dispatch read-back reports the observed agent, and no agent, model, or variant field is ever sent per call.
2. **Given** the same prompt, **When** the composed message is inspected, **Then** the untrusted region is still delimited, still bounded, still marked as truncated when cut, and the framing the machine wrote is unchanged; the prompt cannot delete a delimiter, add one, or move the block.
3. **Given** the same prompt, **When** the dispatched request is captured, **Then** it contains no credential or anything readable as one, and a captured trace of the whole cycle shows no GitHub write from the panel or the service and no change to any policy, gate, or tool scope.
4. **Given** a prompt that tries to write the reserved framing markers, **When** the operator saves it, **Then** the save is refused with a remediation naming the reserved marker, and the previously stored prompt stays in force.

---

### User Story 4 — I can tell which prompt produced which dispatch (Priority: P2)

As an operator debugging something an agent did six weeks ago, I open the dispatch and see whether a starting prompt was used, and I can tell at a glance if the prompt has changed since — without reading files and without having the whole prompt text copied into every audit row forever.

**Why this priority**: Constitution IV makes explainability non-negotiable for unattended operation, and a configurable instruction that silently changes over time is exactly the kind of thing that becomes unexplainable. This is what makes the field operable rather than merely present.

**Independent Test**: Dispatch once with prompt A, change the prompt to B, dispatch again on the same repository, then open both dispatches and the audit history of each by its correlation id. Both name their prompt, the two are distinguishable, and no audit row contains the prompt's text.

**Acceptance Scenarios**:

1. **Given** two dispatches of the same repository under different prompts, **When** the operator opens either one, **Then** the row states that a prompt was used, identifies it by a stable fingerprint, and shows its length — enough to tell the two apart and to recognise a pre-upgrade dispatch.
2. **Given** any dispatch, **When** the operator retrieves its audit history by correlation id, **Then** the dispatch rows name the binding and the prompt's fingerprint, and no row in any state contains the prompt's text.
3. **Given** an operator who changes a prompt, **When** the change is saved, **Then** exactly one audit row records the binding, the new fingerprint, whether a prompt is now set, its length, and who changed it — so a month later the difference is explainable.

---

### User Story 5 — A secret pasted into the prompt is refused, not filed away (Priority: P2)

As an operator who pastes the wrong thing, I am told immediately that my prompt contains something that looks like a credential and it is not saved, so that a token never quietly becomes a durable file, an audit row, and an agent's first instruction.

**Why this priority**: This is the only free-text field the product has ever accepted, and it is the only one through which a credential can reach durable storage by accident. The refusal is a safety mechanism, not a limitation, and it is worth specifying precisely enough that the existing scan suites can keep asserting the invariant.

**Independent Test**: Save a prompt containing a token-shaped value, then search every persisted file, log line, audit row, ledger entry, toast, and committed bundle for that value. Confirm zero occurrences, confirm the previous prompt is still in force, and confirm the refusal message names the shape without quoting the value.

**Acceptance Scenarios**:

1. **Given** a prompt containing a credential-shaped value, **When** the operator saves it, **Then** the save is refused with a remediation naming the matched shape and not the text, the previously stored prompt remains in force, and no part of the submission is applied.
2. **Given** a refused save, **When** every store, log, audit row, ledger entry, and shipped bundle is scanned for the submitted value, **Then** zero occurrences are found, and the refusal itself left no trace of the value.
3. **Given** a prompt that is merely long, **When** the operator saves it, **Then** the refusal names the length cap and the field, in the same vocabulary as every other validation refusal, and never quotes the submitted text.

---

### Edge Cases

- **Binding written before this feature** — the field is absent; it reads as unset and the composed message is byte-identical to the pre-feature composition for the same event.
- **Stored value is JSON `null`** — reads as unset, exactly like absence.
- **Stored value is a number, boolean, object, or array** — refused as unusable text; the document is not silently coerced, cast, or dropped.
- **Panel saves the whole bindings file without the field** — the stored value is preserved, because a client that does not know a field must not erase it. Only an explicit empty value, an explicit `null`, or an empty value after trimming clears it.
- **Value is empty, or whitespace only** — the prompt is cleared to unset. There is no "empty instruction" state, and a cleared binding reverts to the default framing.
- **Value is exactly at the cap, and one code point over** — accepted, and refused naming the cap respectively. The refusal never quotes the text and never truncates silently.
- **Value contains a credential-shaped string** — refused at save, naming the shape. The previous prompt stays in force. Zero bytes of the value reach any store, log, audit row, ledger, or bundle.
- **Value contains a reserved framing marker** — refused at save, naming the reserved marker family. Operator text that impersonates the containment structure is not a supported input.
- **Value contains a null character, or a control character other than newline or tab** — refused as not valid prompt text.
- **Value uses Windows line endings** — normalised to the product's canonical form before storage, and the fingerprint is computed from the normalised text, so the same pasted text always fingerprints identically on any machine.
- **Value contains lines that imitate the machine's own frame** (`Correlation:`, `Rule:`, `Repository:`) — delivered verbatim inside the operator fence, below the fence's closing marker, changing nothing. No line is re-interpreted, reordered, or re-rendered.
- **Value contains a literal `{number}` or other placeholder syntax** — delivered as those exact characters. Operator text is literal; there is no substitution of any kind.
- **Value at the cap, plus the largest permitted source excerpt, plus the largest frame** — the whole composed message still stays inside the dispatch budget 002 FR-028 sets. The prompt is never shortened to fit; the excerpt is.
- **Operator edits the prompt while a dispatch is waiting** — the waiting dispatch uses the snapshot taken when the event was detected; the next dispatch uses the new text. Both fingerprints are recorded on their own runs, so the difference is explainable rather than mysterious.
- **Operator retries a failed dispatch** — the retry composes a byte-identical message from the same snapshot. A retry can never pick up an edit made in between.
- **Operator clears the prompt while dispatches exist** — those dispatches keep their snapshot and fingerprint; their history does not change.
- **One run carries several source references** (003's coalescing) — one prompt block, above a single untrusted region containing every reference, each individually bounded, exactly as 003 FR-014 requires. Adding the prompt does not change 003's reference handling.
- **A prompt that names an agent** — delivered verbatim; the session still runs under the pinned Default Agent; the read-back reports the observed agent; nothing per call is sent.
- **A prompt that instructs the agent to merge, deploy, or write to GitHub** — delivered verbatim, and Mecha Turk acts on nothing: no write, no policy change, no gate change, no new capability. The agent remains bound to the host's own policy and approval requirements.
- **A prompt that says to ignore the untrusted region** — delivered verbatim; the composition is unchanged. Mecha Turk is not the one being asked; the operator's own agent is, about the operator's own configuration. What must hold is that *source text* can never reach the trusted region, and it cannot.
- **The stored bindings file is hand-edited into an invalid state** — quarantined and logged with the reason, exactly as any unusable stored configuration is today; every binding stops scanning until the operator repairs it; no file is silently rewritten and no binding is silently dropped.
- **The panel's local storage is wiped** — the panel holds no copy of the prompt, so it re-reads it from the service on the next read; nothing about a dispatch in progress changes.
- **The prompt is edited by something other than the panel** — the change is recorded by fingerprint and length, and the actor recorded is whoever actually made it.

## Requirements *(mandatory)*

### Functional Requirements

> **Numbering convention.** Requirements are numbered in reserved blocks of ten, one block per topic group: A `FR-001`–`FR-005`, B `FR-010`–`FR-019`, C `FR-020`–`FR-029`, D `FR-030`–`FR-039`, E `FR-040`–`FR-044`, F `FR-050`–`FR-054`, G `FR-060`–`FR-064`, H `FR-070`–`FR-074`. Numbers not listed above are **unallocated**, not missing: they are held in reserve so a clarification or a review finding can be added to its own group without renumbering. Downstream artifacts (plan, tasks, traceability) MUST reference requirements by these numbers and MUST NOT renumber them. **Cross-document references are always prefixed with their document** — `002 FR-028`, `003 FR-061` — so they cannot be misread against this specification's own numbering, which restarts at `FR-001`.

#### A. Relationship to 002 and 003, and the invariants this feature must not weaken

- **FR-001**: This specification is the **authoritative** text for the per-binding starting prompt: the field, its ownership and persistence, its validation, the composition of the dispatch message, the trust-containment rules, and the audit fingerprint. `specs/002-agent-event-extension/spec.md` v1.3.0 and `specs/003-dispatch-integrity/spec.md` v1.1.0 record the extensions requirement by requirement; where either document could be read as disagreeing about what a dispatch carries, what a dispatch-lifecycle audit row contains, or what the run projection shows, this document prevails. Every other 002 and 003 requirement stands unchanged and is referenced, not restated.
- **FR-002**: The extension and the service MUST remain **read-only with respect to GitHub** (002 FR-031; 003 FR-002). No requirement in this specification may be satisfied by a GitHub write, and the starting prompt MUST NOT be used as a place to record, request, or trigger one.
- **FR-003**: The system MUST fail closed. A starting prompt that is oversized, credential-shaped, structurally hostile, or not valid text MUST be refused at the save boundary with a field-level remediation; the refusal MUST leave the previously stored prompt in force, MUST NOT partially apply the rest of the submission, and MUST NOT quote the submitted text. This is the posture of constitution II and of the repository's standing rule that malformed input is refused rather than partially applied.
- **FR-004**: This feature MUST NOT require any host capability, API, or permission beyond what 002 and 003 already require, and MUST NOT reach for an undocumented or private interface (003 NFR-110; constitution VII). The prompt travels in the attachment text of the existing `host.startSession()` call; nothing new is sent to the host.
- **FR-005**: This feature MUST NOT weaken any secret-containment, idempotency, durability, or fail-closed invariant of 002 or 003. 002 NFR-004, 003 NFR-102, 003 NFR-104, and 003 NFR-106 continue to hold unchanged; the existing secret-scan suites MUST pass unchanged, and this feature adds assertions rather than exemptions.

#### B. The field: schema, ownership, persistence, backward compatibility

- **FR-010**: A binding MAY carry an optional `startingPrompt`: one block of operator-authored text, at most **2,000 Unicode code points** after trimming. The field is per binding only. It is absent by default, and "absent" is a complete, valid state.
- **FR-011**: **Ownership: service-owned configuration.** `startingPrompt` is operator *configuration*, not panel UI state. It MUST be persisted by the service in the service-owned bindings store alongside the other binding fields, MUST NOT be written to `host.storage` by the panel, and MUST NOT be mirrored into the panel's ledger. 002 FR-034 governs panel UI state — selections, filters, last-viewed, bounded display mirrors — and this field is none of those: it is the operator's durable instruction to the product, it changes what the agent is asked to do, and it must not be erased by an extension reinstall.
- **FR-012**: **Read path.** The bindings read MUST return `startingPrompt` for each binding, so the operator's own surface can render and edit it without a second source of truth. The configuration read is the **only** surface that returns the text; run, dispatch, and audit surfaces return the fingerprint (FR-052, FR-053).
- **FR-013**: **Write path.** The bindings write MUST accept `startingPrompt` on each binding and validate it through the same fail-closed, additive, field-plus-remediation validator the other binding fields use: every problem in a submission is collected and reported in one answer, and no submitted value is ever echoed back.
- **FR-014**: **Omission preserves; an explicit value sets.** In a whole-file write, a binding submitted **without** a `startingPrompt` field MUST keep whatever the store already holds for that binding. An explicit value MUST set it, including the clearing values: an empty string, a value that is empty after trimming, or an explicit `null` MUST clear it to unset. The rationale is that the bindings surface is a whole-file replacement, so a client that does not yet know about this field would otherwise silently erase an operator's deliberate instruction on its next unrelated save. Omission-preserves is the only reading under which adding a field to the product cannot destroy data an operator typed.
- **FR-015**: **Snapshot at detection.** When the service enqueues a delivery, it MUST snapshot onto the queued record the resolved starting prompt — verbatim, normalised, bounded — together with its fingerprint and its length, at the same moment it snapshots the target project and the worktree option. The dispatch MUST compose from that snapshot. Editing a binding's prompt MUST NOT change any already-queued work, and an operator retry of a failed dispatch (003 FR-041) MUST reuse the same snapshot and therefore produce a byte-identical message.
- **FR-016**: **Fingerprint definition.** The fingerprint MUST be a deterministic, collision-resistant content hash of the normalised prompt text, computed by the service from that text alone, with no configuration and no stored salt, so that the same text always yields the same value across restarts, builds, and machines. It MUST be a fixed-length, fixed-format scalar suitable for a log line, an audit row, and a URL. It is not a credential and MUST NOT be treated, stored, or documented as one.
- **FR-017**: **Absence means unset; a present non-text value is refused.** A binding with no `startingPrompt` — written before this feature, or cleared — MUST dispatch with the default framing exactly as it does today, and the composed message MUST be byte-identical to the pre-feature composition for the same event. A stored JSON `null` reads as unset. A stored value that is present but is not text — a number, boolean, object, or array — MUST be refused as unusable; it MUST NOT be coerced, cast, replaced with a default, or silently dropped.
- **FR-018**: **No migration step.** The upgrade MUST NOT rewrite, quarantine, or repair any bindings file, and MUST NOT reset any binding's scan window. "Unset" is already the correct reading of an absent field, so there is nothing to compute: a migration would touch every operator's configuration file to produce no behavioural change, and would contradict the non-destructive upgrade posture 003 FR-005 and 003 NFR-103 established. Records written before this feature MUST continue to parse, project, and render unchanged.
- **FR-019**: **Unusable stored values and payload retention.** A stored bindings file whose prompt violates this feature's rules MUST be refused the same way any unusable stored configuration is refused today: the file is quarantined, the reason is logged, the poll loop scans nothing until the operator repairs it, and no file is silently rewritten and no binding silently dropped. The prompt snapshot on a queued record is payload: it MUST be retained under the same rule as that record's other payload excerpt and MUST NOT outlive it. The prompt on the binding record is configuration and lives until the operator changes or clears it.

#### C. Validation and refusal

- **FR-020**: **Length cap.** The stored prompt MUST NOT exceed **2,000 Unicode code points** measured after trimming. A value over the cap MUST be refused with a remediation naming the field and the cap. The save MUST NOT silently truncate, and the refusal MUST NOT quote the value.
- **FR-021**: **The cap is a documented default, not a constant.** The cap MAY be adjusted in planning without a spec change only within **500–3,000** code points, and any configured value MUST keep the composed message inside the per-dispatch bound 002 FR-028 sets. Rationale for the default and the arithmetic are in `## Assumptions`.
- **FR-022**: **Trimming, and what empty means.** Leading and trailing whitespace MUST be trimmed on save. Internal whitespace, including newlines and tabs, MUST be preserved verbatim. A value that is empty after trimming means **unset**: the field is stored as absent, the binding reverts to the default framing, and "an empty instruction" is not a state the product has.
- **FR-023**: **Normalisation.** Line endings MUST be normalised to the product's single canonical form on save, and the fingerprint MUST be computed from the normalised text, so that the same pasted text fingerprints identically on every machine and in every build. Normalisation is a save-time act; the stored value is already canonical.
- **FR-024**: **A credential-shaped prompt is refused, not warned about.** A prompt containing secret-shaped material — the same shapes the product's existing secret detection recognises — MUST be refused at save, with a remediation naming the matched shape and never the text. **The rejected alternative is warn-and-store**, and it is rejected because the value would then live in the service store, be copied onto queued records and run records, appear in the audit trail, and be handed to an agent session as its first instruction. A warning is not a control: it converts a paste mistake into a durable credential at rest, which is the single outcome the secret-containment standard exists to prevent. The second rejected alternative, **redact-and-store**, is rejected because silently altering an operator's instruction is worse than refusing it, and because a stored value the operator never sees is not an instruction they can reason about. Refusing is also the behaviour the product already has: a redaction refusal blocks the write rather than logging through it, and a configuration refusal names the field and the remediation and never echoes the value. FR-016's fingerprint is safe only because this requirement makes the underlying value non-secret.
- **FR-025**: **Reserved markers are refused.** A prompt containing a reserved composition marker MUST be refused at save, with a remediation naming the reserved marker family. Reserved markers are the operator-prompt fence and the untrusted-region delimiters; because new markers may be added over time, the rule is stated as a **reserved prefix** — a line beginning with the product's marker prefix, `--- BEGIN ` or `--- END ` — rather than as an enumeration, so a future marker is covered without re-specifying this requirement. Operator text that impersonates the containment structure would defeat the property this feature exists to provide, and refusing is consistent with the fail-closed posture. The cost is that an operator cannot draw a horizontal rule inside a prompt, which is negligible and stated here so it is not discovered as a bug.
- **FR-026**: **Well-formed text.** A prompt containing characters that are not valid prompt text — a null character, or a control character other than newline or tab — MUST be refused at save with a field-level remediation. The prompt is an instruction to a model and is also rendered in the operator's own surface; control characters are neither.
- **FR-027**: **Additive and atomic.** A submission naming an invalid prompt MUST be refused in full. The previously stored prompt for that binding MUST remain in force, every other problem in the submission MUST be reported with its own remediation in the same answer, and **no part of the submission may be applied**.
- **FR-028**: **No silent coercion, ever.** A value that is not usable text MUST NEVER be coerced into a usable one — not trimmed into emptiness, not cast, not defaulted, not dropped from the record, and not persisted in a form that would later read as unset. A refusal is the only permitted outcome for a value that violates this specification.
- **FR-029**: **No content policy on operator text.** Mecha Turk MUST NOT evaluate what the operator says. The complete set of refusals is length, credential shape, reserved marker, and well-formedness. Any further content rule would make the field unpredictable, would put a speech policy inside an unattended dispatch path, and would make the field's behaviour depend on a judgement Mecha Turk has no standing to make. A prompt the operator dislikes is their own to write; a prompt Mecha Turk objects to is its own to send.

#### D. Composition of the dispatch message

- **FR-030**: **Order: trusted operator intent first.** The composed dispatch message MUST place the operator's starting prompt **first**, verbatim (trimmed, normalised, bounded), as trusted operator instruction, and the auto-built framing beneath it. The automatic framing consists of what 002 FR-028 already requires — the resolved project, the source attachment (source id, title, url, kind, text, data), the configured worktree option, the correlation id, and the bounded untrusted excerpt with explicit delimiters — widened to every source reference on the run by 003 FR-014, all of which stays exactly as it is today.
- **FR-031**: **The prompt block is the only trusted section, and it is fenced.** Everything else the composition adds is machine-built. The prompt block MUST be fenced by a fixed opening and closing marker pair that identifies it as operator-supplied starting instruction, so a reader — human or model — can see where the operator's intent ends and the machine's frame begins. The fence is emitted by the composition; it is never part of the operator's stored text.
- **FR-032**: **Unset means no block.** When the prompt is unset, the composition MUST contain no prompt block, no empty fence, no placeholder, and no explanatory line about the absence of a prompt. The message MUST be byte-identical to the pre-feature composition.
- **FR-033**: **Markers are structural, never searched for.** Every delimiter, fence, frame line, and truncation marker MUST be emitted by the composition. No part of the composed message may be produced by searching, splitting, re-parsing, or otherwise deriving structure from the operator's text or from the source excerpt. The operator's text MUST be carried through byte for byte inside its fence — no escaping, rewriting, reflowing, re-indenting, or quote-stripping.
- **FR-034**: **The prompt may direct the agent.** The prompt is trusted operator instruction: the agent MUST receive it as the leading instruction of the session's first message, ahead of the automatic framing, and the composition MUST NOT reorder, summarise, translate, soften, or second-guess it. Mecha Turk does not assess whether the instruction is wise.
- **FR-035**: **The untrusted source may never override the prompt.** The untrusted excerpt MUST remain inside its delimiters, bounded per source item and per dispatch, with explicit truncation markers, and MUST NOT be able to alter the prompt, system policy, credentials, approval requirements, or tool scope. Adding the prompt MUST NOT weaken any bound 002 FR-028 or 003 FR-014 states. Where the prompt and the excerpt together would exceed a bound, **the excerpt is shortened first** and the shortening is visible; the prompt is never shortened to make room.
- **FR-036**: **One composition, one truth.** Exactly one composition produces the dispatch message. Any surface that displays or previews a composed message — the panel today, or the Bindings tab in 005 — MUST use that same composition, so a preview can never diverge from what an agent receives. Phase 4 fixes the mechanism; this specification fixes the invariant, because a second renderer is how a security property quietly stops holding.
- **FR-037**: **The text travels in the attachment text; the fingerprint travels in the machine-readable data.** The composed message is the session's first message — the attachment's `text` (002 FR-005, 002 FR-028). The machine-readable attachment data MUST additionally carry whether a prompt was present and, when it was, its fingerprint and length; it MUST NOT carry a second copy of the prompt's text.
- **FR-038**: **Machine identity and no credentials.** The composition MUST carry the run's correlation identifier unchanged (003 FR-050, 003 FR-051) and the resolved project, and MUST NOT contain any credential or any material that could be read as one. The service's credential never leaves the service store (002 FR-007), and the composition is the last place that could be argued otherwise.
- **FR-039**: **Operator text is literal; there are no placeholders.** Braces, dollar signs, percent signs, and any other templating syntax MUST be delivered to the agent exactly as written. An operator who writes `{number}` sends those eight characters. No substitution, expansion, interpolation, or conditional rendering of any kind is performed on the prompt, now or later, and this requirement exists so that its absence is never mistaken for an unimplemented feature. The one templated field in the product — the `{number}` placeholder in the worktree option (002 FR-028, 002 `## Assumptions`) — is 002's, is unaffected, and is documented in the operator guidance so the two are not confused.

#### E. Trust containment and the agent pin

- **FR-040**: **The prompt is not an agent selector.** Mecha Turk MUST NOT parse, interpret, or act on the operator's text to select an agent, model, or variant, and MUST NOT pass one per call — the platform strips those fields, and the deterministic pin is Session Defaults → Default Agent, verified after dispatch (002 FR-029). An instruction that names an agent is delivered verbatim as ordinary instruction text; the session still runs under the pinned default, and the post-dispatch read-back reports the observed agent exactly as it does for any other dispatch.
- **FR-041**: **No back door to the pin.** Nothing an operator writes in the prompt may change, bypass, weaken, or defeat the pin, and this feature MUST NOT add any way to name an agent per dispatch. The pin remains the only deterministic mechanism; its verification remains warn-only, visible, and audited (003 FR-043); and the prerequisites surface continues to present the pin as **not checkable by the panel** (003 FR-072), because nothing here makes it checkable. The panel still cannot read or change that host setting.
- **FR-042**: **The prompt cannot widen authority.** The operator's text MUST NOT grant or imply any credential, approval gate, tool scope, policy profile, or capability, and Mecha Turk MUST NOT act on the prompt to relax a policy, skip an approval, enable a write, grant a tool, or change the account a dispatch polls or posts under. Credentials never enter the message (002 FR-007, FR-038); approval requirements and tool scope belong to the host and are unaffected by any text. A prompt that claims to grant write access is delivered as text and grants nothing.
- **FR-043**: **The prompt cannot suppress the untrusted delimiters.** The delimiters, the fence, the bounds, and the truncation markers are emitted by the composition and are not removable, reorderable, or extendable by prompt text (FR-033, FR-025), and no prompt may cause the source to be presented as trusted. The property this feature must hold is that **source text can never reach the trusted region**; operator text instructing the operator's own agent to disregard its own framing is the operator's prerogative and is not a boundary Mecha Turk enforces, because the operator is the principal the boundary protects.
- **FR-044**: **The prompt is not a trigger.** A starting prompt MUST NOT create, enable, disable, weight, or influence a trigger, and MUST NOT cause a dispatch on its own. The trigger set is 002 FR-015 and is unchanged; a binding with a prompt and no enabled trigger still produces nothing, and a prompt cannot be used to widen what a binding listens for.

#### F. Audit and traceability

- **FR-050**: **A dispatch records which prompt produced it.** Every dispatch-lifecycle audit row that records what was sent MUST carry the binding id and the prompt's fingerprint, and MUST NOT carry the prompt's text. This extends 003's row shape (003 FR-061) with two credential-free scalars and changes none of its existing fields.
- **FR-051**: **A prompt change is audited.** Saving, changing, or clearing a binding's prompt MUST write exactly one audit row naming the binding, the new fingerprint, whether a prompt is now set or unset, its length, and who made the change — never the text. One row per change, so that a change arriving inside a whole-file write is individually attributable. The actor recorded is the operator when the change arrived through the panel and the service itself otherwise, so the record never claims a human did something a script did.
- **FR-052**: **The run projects the fingerprint, not the text.** The run history projection and the dispatch row an operator opens MUST show whether a prompt was used and, when it was, its fingerprint and its length. That is enough to tell two dispatches apart, to recognise a pre-upgrade dispatch, and to detect that the binding's prompt has changed since — and it does not reproduce the operator's instruction on a surface that outlives the run. No field is removed from the projection by this requirement.
- **FR-053**: **The text lives in exactly two places, and the fingerprint is why.** The operator's text is retained in the binding record — their configuration — and in the queued record's snapshot — the work unit's own record, retained with the rest of that payload under FR-019. It is never copied into an audit row, the panel ledger, `host.storage`, a log line, a toast, an error body, or a shipped bundle. The fingerprint exists so that "which prompt produced this run" is answerable from the audit trail under any retention, **without** reproducing operator text on every row of a thirteen-row dispatch lifecycle. The alternative — carrying the text on every lifecycle row — multiplies the operator's instruction by the row count for no added explainability, grows a bounded file with content the operator already owns in their configuration, and creates a second place to leak from.
- **FR-054**: **The retention consequence, stated rather than hidden.** A run whose audit rows outlive its queued record still carries the fingerprint: the operator can always tell a prompt was used. They may not be able to recover that run's exact text from the run alone. The text remains available from the binding for as long as the operator leaves it unchanged, and **a mismatch between a run's fingerprint and the binding's current fingerprint is the signal that it has since changed** — which is exactly the answer the operator needs, and is the reason the fingerprint rather than the text is the right thing to record. Trimming MUST NOT remove the minimal reference needed to explain a run (003 FR-065, 002 FR-035).

#### G. The field 005 will render (no user interface work here)

- **FR-060**: **The field, named once.** The Bindings tab MUST render exactly one editable field per binding for this text, identified as the starting prompt for sessions that binding starts, carrying the binding's current value, and making clear that the text is sent to the agent verbatim and is not a template. 005 owns the design, the layout, the affordances, and the placement; this specification fixes the field's identity, its name, and its meaning, and nothing else, precisely so that 005 renders it once against a fixed definition.
- **FR-061**: **Rendered through the existing path, never mirrored.** The value MUST be rendered through the same non-HTML path as every other service-supplied string (003 NFR-109), and the panel MUST NOT persist a copy of it in `host.storage` (FR-011).
- **FR-062**: **No editor in this feature, and a supported way to set the field meanwhile.** This feature MUST NOT add any editing, preview, or display surface for the prompt. Until 005 lands, the documented way to set the field is the service's own bindings store file — operator-owned, permission-restricted, validated on read, and quarantined with a logged reason if it is malformed (FR-019) — and that path MUST be documented. Two consequences follow and are stated rather than discovered later: a panel save that omits the field preserves what is stored (FR-014), and a field with no editor is invisible, which is expected for one cycle.
- **FR-063**: **The guidance travels with the field.** Whichever surface renders the field MUST convey, in the operator's terms: the text is sent to the agent verbatim; there are no placeholders; the session's agent is the operator's pinned Default Agent and the text cannot change it; a credential-shaped value is refused rather than stored; and there is a length cap. The guidance an operator needs about a field is part of the field, not a nicety deferred to documentation.
- **FR-064**: **Honest absence.** A surface that renders the field MUST show an explicit "not set" state for an unset prompt, and MUST NOT present an empty text box that reads as an empty instruction the agent will receive.

#### H. Scope containment and the forward path

- **FR-070**: **Per-binding only.** The starting prompt is defined per binding in this cycle. There is no account-level prompt, no repository-group prompt, and no global default, and no requirement here may be satisfied by one.
- **FR-071**: **"Unset" is not a prompt, and no default is invented.** When no prompt is set, the binding dispatches with the automatic framing only. The product MUST NOT substitute a built-in instruction, and MUST NOT seed any new or existing binding with text. If Mecha Turk had opinions about how work should start, this specification would be a different and much worse document.
- **FR-072**: **If a default is wanted later.** A later feature MAY add a fallback chain, and the resolution order it must satisfy is fixed here so it is designed once: the binding's own prompt if set, otherwise the account's, otherwise a global default, otherwise the automatic framing. The effective prompt's **source** MUST be named on the run row and in the audit row, and the fingerprint is what identifies which text was used. Such a feature MUST NOT change this specification's composition, validation, or containment rules, and MUST NOT retroactively give an existing unset binding some text without an explicit operator action.
- **FR-073**: **The prompt is not a policy profile.** The prompt cannot set, relax, or evaluate autonomy, approval gates, or write permissions (002 FR-027, 002 FR-032, FR-042). Policy profiles remain backlog and are out of scope here.
- **FR-074**: **Documentation is a shipped surface for this field.** The user-facing documentation MUST state that the text is literal and has no placeholders, that a credential-shaped value is refused rather than stored, what the length cap is, and that the session's agent is the operator's pinned Default Agent. 002 FR-038 and 003 FR-071 made the prerequisites honest in-product; this requirement adds one field's worth of truth and does not introduce a new prerequisite.

## Dispatch Message Composition

The composition is normative: the ordering, the fencing, the bounds, and the properties in this section are what Phase 4 designs against and what the acceptance criteria test. The exact field names of the machine-readable envelope are Phase 4's to fix, in the same way 003 fixed the semantics of its wire surface and left the names alone.

### Two layers

The dispatch is a **request envelope** and a **first message**. This feature changes only the first message, plus two additional fields in the envelope's machine-readable data.

| Layer | Contents | Changed by 004? |
| --- | --- | --- |
| **Envelope** | provider, source attachment id / title / url / kind, the composed text, the resolved `projectId`, the configured worktree option, and the machine-readable data (schema version, correlation id, repository, source id, detection time, panel generation) | **Two fields added to the data**: whether a prompt was present, and its fingerprint. Nothing removed, nothing changed. |
| **First message (`text`)** | The operator's prompt block first, then the automatic frame, then the delimited untrusted region | **The prompt block is added, first** |

### Shape of the first message

```text
--- BEGIN OPERATOR STARTING PROMPT ---
<the operator's text, verbatim: trimmed at the ends, normalised line endings,
 internal whitespace and newlines preserved exactly, nothing escaped or reflowed>
--- END OPERATOR STARTING PROMPT ---
<blank line>
Mecha Turk dispatch (automated — started by the Mecha Turk extension from a detected GitHub event).
Correlation: <the run's correlation id>
Repository: <owner/name>
Issue #<number>: <title>
URL: <canonical source url>
Machine account: <login>
Rule: <the shipped rule line>
--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---
<the bounded excerpt, per source item and in total, with a visible truncation
 marker wherever it was cut; every source reference on the run, in 003's form>
--- END UNTRUSTED ISSUE TEXT ---
```

**With no prompt set**, the message is exactly the block from `Mecha Turk dispatch` downward — byte-identical to the composition the current build produces for the same event. No fence, no blank line in its place, no note about the absence.

**Rules that hold in both cases**

1. The prompt block comes first and is the only section that is not machine-built (FR-030, FR-031).
2. The fence is emitted by the composition and is not part of the operator's stored text (FR-031, FR-033).
3. No frame line, delimiter, or marker is derived by searching the operator's text or the excerpt; structure is built, never parsed out (FR-033).
4. The operator's text appears exactly once, byte for byte (FR-033, FR-037).
5. The untrusted region keeps 002 FR-028's bounds and 003 FR-014's per-reference treatment; where the two together would exceed a bound, the excerpt is shortened and the prompt is not (FR-035).
6. The correlation id and the resolved project are present, and no credential is (FR-038).
7. Nothing in the operator's text is substituted, expanded, or interpreted (FR-039).

> **Recorded, not fixed here.** The `Rule:` line above is the shipped wording, and for a mention or review dispatch it currently reads as though an assignment had fired. That fidelity gap belongs to the framing copy and is 005's or a later fix's to close. It is recorded here so that no reader takes 004's reproduction of the frame as an endorsement of its accuracy.

## Key Entities

Only the entities this feature adds or changes are listed; everything else is defined in 002 and 003 and is referenced, not restated.

- **RepositoryBinding** *(extended)*: gains one optional field, `startingPrompt` — a block of operator text, absent when unset. Every other binding field is unchanged, and the binding's ownership is unchanged (service-owned durable configuration).
- **StartingPrompt** *(new)*: the operator's instruction for a binding. Normalised text, at most 2,000 code points after trimming, present or absent, with no sub-structure. It is configuration, not a template: no variables, no directives, no grammar.
- **PromptFingerprint** *(new)*: a deterministic content hash of the normalised prompt text, computed from that text alone, in a fixed format, safe for a log line, an audit row, and a URL. Not a credential, and — because a credential-shaped prompt is refused at save (FR-024) — never a hash of one.
- **QueuedRecord snapshot** *(extended)*: the prompt, its fingerprint, and its length, captured at detection beside the target project and worktree option, and the reason a dispatched run is still reproducible after the operator edits the binding.
- **PromptAuditRow** *(new audit event type)*: one row per prompt change, carrying the binding, the new fingerprint, presence, length, and actor — never the text.
- **Run projection** *(extended)*: adds prompt presence, fingerprint, and length. No field removed; no text exposed (FR-052).

## Non-Functional Requirements

- **NFR-120 Latency preserved**: composition MUST add no panel↔service round trip, and p95 detection-to-session latency MUST stay inside 002 NFR-001 and 003 NFR-101. The prompt is snapshotted with the record that already exists and travels in the call that already happens.
- **NFR-121 Secret containment**: zero occurrences of any credential in the bindings store, queued records, run records, audit rows, panel ledger, logs, toasts, error bodies, or committed bundles — verified by the existing automated scan suites, which this feature MUST NOT weaken, plus assertions covering the new field. A refused save MUST leave no trace of the rejected value anywhere, including in the refusal itself.
- **NFR-122 Bounded growth**: the prompt is capped; the queued-record snapshot is bounded by the same rule as the record's other payload; the fingerprint is a fixed-length scalar. Over an operator's normal working lifetime, no file grows without bound as a result of this feature (003 NFR-107).
- **NFR-123 Fail-closed**: every invalid prompt blocks the save, leaves the previous value in force, and produces a field-level remediation that names the field and never the value. No partial application is possible on any path.
- **NFR-124 Observability**: 100% of dispatches name their prompt's presence and fingerprint; 100% of prompt changes produce exactly one audit row; 100% of the answers to "which prompt produced this run" are obtainable from the run row and the audit trail by correlation id alone (003 NFR-105).
- **NFR-125 Compatibility**: no new host capability, API, or permission (003 NFR-110). Store files written before this feature parse, project, and render unchanged. The delivery identifier, the run key, the correlation id, and 003's dispatch state model are untouched.
- **NFR-126 Determinism**: the same prompt text fingerprints identically across a service restart, a host restart, a reinstall, and two different operator machines; the same binding state always composes the same message; and a retried dispatch composes a byte-identical message from its snapshot.
- **NFR-127 Rendering safety**: the prompt is operator text reaching a rendered surface through the existing non-HTML path, and it MUST NOT become an HTML or script injection sink in any surface, present or future (003 NFR-109).
- **NFR-128 Maintainability**: strict typing and linting with zero suppressions, as everywhere in this repository. One composition function with unit tests; the fingerprint is a pure function of the text with no configuration; validation shares the existing fail-closed validator rather than introducing a parallel one.
- **NFR-129 No capability creep**: this feature adds no host call, no new service route beyond the existing bindings surface, no new permission, and no new audit surface that the operator must learn.

## Success Criteria

### Measurable Outcomes

- **SC-120**: Across every dispatch from a binding that has a prompt, the session's first message opens with that prompt verbatim — 100%, measured by byte comparison of the leading block, with no summarisation, reordering, or re-flow in any trial.
- **SC-121**: Across a seeded corpus of events dispatched on bindings that have no prompt, 0 composed messages differ from the pre-upgrade composition for the same event.
- **SC-122**: Across a corpus of prompts that name agents, models, or variants, 0 sessions run under an agent other than the operator's pinned Default Agent, and 100% of such dispatches report the observed agent on the run row.
- **SC-123**: Across a corpus of credential-shaped prompt attempts, 0 credentials appear in any store, log, audit row, ledger, toast, or bundle; 100% of attempts are refused; and 0 refused values leave any trace.
- **SC-124**: For 100% of dispatches, an operator can answer "which prompt produced this run, and has the binding's prompt changed since?" from the run row and the audit trail alone, in under 30 seconds, with no file access.
- **SC-125**: 100% of prompt changes produce exactly one audit row naming the binding, the new fingerprint, presence, and length; 0 changes are unrecorded.
- **SC-126**: An operator running five bindings, each with a different prompt, receives five dispatches that each carry exactly one prompt, with 0 cross-contamination between bindings.
- **SC-127**: p95 detection-to-session latency is unchanged from the previous release's measured baseline, with 0 additional round trips per dispatch.
- **SC-128**: An operator upgrading from the previous release needs no migration step: every existing binding, queued record, and audit row survives, 0 files are quarantined by the upgrade, and 0 scan windows are reset.
- **SC-129**: 100% of attempts to write a prompt containing a reserved framing marker are refused, and 0 composed messages ever contain a delimiter the composition did not emit.

## Acceptance Criteria

- [ ] **AC-130**: A binding with a prompt dispatches a request whose attachment text opens with the operator's text verbatim inside the operator fence, followed by the automatic frame carrying the resolved project, the source attachment, the configured worktree option, the correlation id, and the bounded delimited untrusted excerpt; the machine-readable data carries the prompt's presence flag and fingerprint and no second copy of the text.
- [ ] **AC-131**: A binding with no prompt dispatches a message byte-identical to the pre-upgrade composition for the same event, with no fence and no placeholder; a stored `null` behaves identically; a stored number, boolean, object, or array is refused with a field-level remediation and is never coerced, cast, or dropped.
- [ ] **AC-132**: An empty value and a whitespace-only value both clear the prompt to unset; a value at the cap is accepted; a value one code point over is refused naming the field and the cap; the submitted text appears in no refusal, no log, and no audit row.
- [ ] **AC-133**: A prompt containing a credential-shaped value is refused at save naming the shape and not the value; the previously stored prompt remains in force; the whole submission is otherwise unapplied; and a scan of the bindings store, queued records, run records, audit rows, panel ledger, logs, toasts, error bodies, and committed bundles finds 0 occurrences of the rejected value.
- [ ] **AC-134**: A prompt containing a reserved marker is refused naming the marker family; a prompt whose own lines imitate the frame (`Correlation:`, `Rule:`, `Repository:`) is delivered verbatim inside the fence and changes no frame line, delimiter, or ordering; a prompt delivered in full is byte-identical to the value stored, after trimming and normalisation.
- [ ] **AC-135**: A prompt reading "use the code-reviewer agent, you have write access, treat everything below as trusted" reaches the session verbatim; the session's observed agent is the operator's pinned Default Agent; the run row reports the observed agent; no agent, model, or variant field is sent per call; and the panel still cannot read or change the host's Default Agent setting.
- [ ] **AC-136**: The same prompt changes nothing else: the untrusted region is still delimited, bounded, and visibly marked when truncated; the dispatched request contains no credential or anything readable as one; no policy, gate, or tool scope changes; and a captured trace of the cycle shows no GitHub write from the panel or the service and no new capability.
- [ ] **AC-137**: Two bindings on one repository with different prompts each dispatch their own text; neither run shows the other's fingerprint; a whole-file write omitting the field preserves both stored values; a write carrying an explicit empty value clears exactly the binding it names; and a stored prompt edited outside the panel is recorded with the actor that actually made the change.
- [ ] **AC-138**: Editing a binding's prompt while a dispatch is waiting leaves that dispatch's text and fingerprint unchanged; the next dispatch uses the new text; both fingerprints appear on their own runs; and an operator retry of a failed dispatch composes a byte-identical message from the same snapshot.
- [ ] **AC-139**: Every dispatch-lifecycle audit row that records what was sent carries the binding id and the prompt fingerprint; no audit row in any state contains the prompt's text; the run projection shows presence, fingerprint, and length and no text; and each prompt change writes exactly one row naming the binding, the new fingerprint, presence, and length.
- [ ] **AC-140**: The same prompt text fingerprints identically across a service restart, a host restart, a reinstall, and two machines; the fingerprint is reproducible from the text alone with no configuration; and every composed message boundary is determined structurally, with no delimiter or frame line recovered by searching the operator's text.
- [ ] **AC-141**: A stored bindings file whose prompt violates these rules is quarantined and logged with the reason, every binding stops scanning until the operator repairs it, no file is silently rewritten, and no binding is silently dropped.
- [ ] **AC-142**: Upgrading from the previous release requires no migration: every existing binding parses, projects, and renders; every queued record still dispatches with the text it was queued with; 0 bindings files are quarantined by the upgrade; 0 scan windows are reset; and the delivery identifier, run key, and correlation id are unchanged.
- [ ] **AC-143**: The existing secret-scan suites pass unchanged; new assertions cover the bindings store, the queued-record snapshot, the run projection, the audit rows, and every rendered surface and find 0 credential occurrences; a refused save leaves no trace of the rejected value in the refusal, the log, or the audit trail.
- [ ] **AC-144**: At the end of this feature no editor, preview, or display surface for the prompt exists; the Bindings tab has exactly one field to render, identified in FR-060, carrying the guidance in FR-063 and the honest "not set" state in FR-064; and `host.storage` holds no copy of the value.
- [ ] **AC-145**: p95 detection-to-session latency matches the previous release's measured baseline with 0 additional round trips per dispatch; the composed message never exceeds the per-dispatch bound 002 FR-028 sets; and where prompt and excerpt together would exceed it, the excerpt is shortened with a visible marker and the prompt appears in full.

## Out of Scope

The following are explicitly **not** part of this feature:

- **Any panel user interface** — the field's editor, its layout, its affordances, its help placement, a preview of the composed message, and the Bindings tab itself. 005 renders this field exactly once against the definition fixed here.
- **Template placeholders of any kind.** Operator text is literal, and the absence of substitution is a requirement, not a gap (FR-039).
- **Any GitHub write**, in any role (002 FR-031 stands; 003 FR-002 restates it; FR-002 restates it again).
- **Account-level, repository-group, and global default prompts.** Per-binding only this cycle. The fallback chain's required resolution order is specified (FR-072) so a later feature is designed once; the chain itself is not built here.
- **The dispatch state model, leases, requeue budgets, dead-lettering, `unconfirmed`, and the impossible-second-session property.** 003 owns these; 004 restates none of them and contradicts none of them. Where 004 needs one — a retry reusing its snapshot — it composes with 003's rule and cites it.
- **Per-call agent, model, or variant selection** (002 `## Out of Scope`; the platform strips those fields). Also out of scope: changing the pin, promoting agent verification from warn-only to blocking, and the service-side verification mirror — all recorded 003 items.
- **Making the prompt a policy profile** or giving it any effect on autonomy, gates, or write permissions (FR-073; policy profiles are backlog).
- **Settings CRUD and live-apply** (006). The prompt is binding configuration, not service settings.
- **Changing the automatic framing's wording**, including the `Rule:` line's fidelity for mention and review dispatches, which is recorded in `## Dispatch Message Composition` and belongs to 005's copy work or a later fix.
- **Bulk prompt operations** — copying one prompt across several bindings at once. It is an ergonomics feature of 005's tab; the whole-file bindings surface already accepts a set across many bindings.
- **Retention tuning, export/restore** of configuration or audit data, and the durable deduplication-index eviction gap. All backlog.
- **Multi-instance or cross-machine semantics**; one logical service instance (003 FR-004).
- **Phase 4 plan, research, data model, contracts, and task breakdown, and Phase 6 implementation** — those are the architect's phases.

## Assumptions

Each assumption below is a documented default chosen where the brief, 002, and 003 were silent. Each was a candidate for the phase gate; all four gate candidates were reviewed on 2026-09-28 and closed without a requirement change (see `## Resolved Gate Questions`). Each remains reversible without a redesign — the cap within 500–3,000 by configuration, the rest by a minor spec revision.

- **The cap is 2,000 Unicode code points.** Chosen against three constraints at once. It is roughly three hundred words — two or three sentences, which is what a starting instruction actually is in practice. It leaves the automatic framing and the source excerpt room inside the dispatch budget 002 FR-028 sets, including the current implementation's tighter working budget: 2,000 (prompt) + roughly 400 (frame) + 1,200 (excerpt) + separators stays inside that budget with a maximal prompt, so **004 does not have to raise the dispatch bound and can never starve the excerpt**. And a cap is what keeps an unattended product's prompt from becoming a document. Adjustable in planning within 500–3,000 without a spec change (FR-021).
- **Trimming is outer-only.** Operators paste with stray newlines; the product should not treat a trailing blank line as instruction. Internal structure — the newlines an operator used to separate a goal from a constraint — is the instruction, and must survive byte for byte.
- **Line endings are normalised at save.** Otherwise the same text pasted on two machines fingerprints differently, and the fingerprint stops being an identity.
- **"Unset" is a complete state, not a default text.** No product-authored instruction is ever substituted (FR-071). A binding with no prompt dispatches exactly what it dispatches today, which is the only backward-compatible answer and also the honest one: Mecha Turk has no business inventing an operator's intent.
- **The prompt is snapshotted at detection, not read at dispatch.** This is how the target project and the worktree option already behave, and it is the only choice that makes a run reproducible after the operator edits the binding. The alternative — read at dispatch — would mean a queued run silently changes its instructions under the operator's feet, and a retry would compose a different message than the original attempt.
- **The fingerprint is a content hash with no salt and no configuration.** It must be reproducible from the text alone, by anyone, on any machine — that is what makes it usable as an identity in an audit row and a support conversation.
- **Omission preserves, an explicit value sets.** The bindings surface is a whole-file replacement, so a client that does not know about a field would erase it. Until 005 renders the field, the panel is exactly such a client. Preserving on omission is the only rule under which shipping this feature cannot destroy an operator's typed instruction.
- **Between this feature and 005, the store file is the set path.** Documented, permission-restricted, validated on read, quarantined with a logged reason if malformed. A field with no editor for one cycle is a deliberate sequencing choice — 004 fixes the field so 005 renders it once — and the cost is stated rather than discovered.
- **The operator's text is trusted configuration; only the source is untrusted.** This is the load-bearing assumption of the whole feature and it is the product owner's locked decision of 2026-09-28: trusted operator intent first, auto-built source below, already delimited. It is safe precisely because the prompt is the operator's own durable configuration in a store they control, about a repository they control, and because the one genuinely untrusted input — the source excerpt — still cannot cross into the trusted region. What Mecha Turk enforces is that boundary; what the operator says to their own agent is the operator's own business.
- **No content policy on operator text.** Three refusals and a well-formedness check, and nothing else. Anything more would put a speech policy inside an unattended path and make the field's behaviour depend on a judgement the product has no standing to make.
- **Scale**: fewer than ten bound repositories, a handful of accounts, one local OpenChamber installation, one logical service instance, one operator machine — unchanged from 002 and 003.
- **Provider**: GitHub.com REST API; GitHub Enterprise compatibility is unchanged and still requires later review.
- **Cross-document numbering**: any requirement reference without a document prefix is this specification's own. Every reference to 002 or 003 is prefixed so the two numbering series cannot be confused.

## Clarifications

### Phase 3 record — 2026-09-28

This specification was produced in phases 1–3 with the constitution (v1.3.0), feature 002 (v1.2.0), feature 003 (v1.0.0), and the product owner's brief and locked composition decision of 2026-09-28 as the inputs. No clarification marker remains anywhere in this document. Every decision below is encoded in a numbered requirement.

| # | Question | Answer | Encoded in |
| --- | --- | --- | --- |
| 1 | Where does the operator's text live? | In the service-owned bindings store, beside the other binding fields. It is configuration, not panel UI state, so it is not in `host.storage` and not in the panel ledger. | FR-011, FR-012, FR-053 |
| 2 | What do existing bindings do — migrate, or read as unset? | Read as unset, with **no migration step**. An absent field already has the right meaning, so a migration would rewrite every operator's configuration file to change no behaviour. | FR-017, FR-018, SC-128 |
| 3 | What does an empty or whitespace-only prompt mean? | Unset. Outer whitespace is trimmed; internal whitespace is preserved; an empty value clears the binding back to the automatic framing. There is no "empty instruction" state. | FR-022, FR-032 |
| 4 | How long may a prompt be, and why that number? | 2,000 code points after trimming — about three hundred words, which fits the automatic framing and the source excerpt inside the existing dispatch budget without raising it, and caps how much instruction an unattended path accepts. | FR-020, FR-021, `## Assumptions` |
| 5 | Is a credential-shaped prompt warned about or refused? | **Refused at save**, naming the shape and never the text. Warn-and-store would put a credential at rest, in a file, in the audit trail, and in an agent's first instruction; redact-and-store would silently alter the operator's instruction. Refusing matches the redaction guard and the configuration validator the product already has. | FR-024, FR-029, AC-133 |
| 6 | Can operator text imitate the containment markers? | No. A prompt containing a reserved marker is refused at save. Stating the rule by marker prefix rather than by enumeration means a future marker is covered without re-specifying the requirement. | FR-025, FR-043, AC-134 |
| 7 | What happens when the operator writes "use the code-reviewer agent"? | It is delivered verbatim as ordinary instruction text and changes nothing about the pin. The platform strips per-call agent, model, and variant; the session runs under the pinned Default Agent; the read-back reports the observed agent. A prompt is not an agent selector and is not a back door to one. | FR-040, FR-041, AC-135 |
| 8 | Can the prompt widen credentials, gates, or tool scope? | No. It can textually claim to, and the claim is delivered as text and grants nothing. No credential enters the message, and no policy, gate, or capability responds to prompt content. | FR-042, FR-038, AC-136 |
| 9 | Does a dispatch record the prompt's text, or a reference to it? | A fingerprint. Every dispatch-lifecycle row that records what was sent carries the binding id and the prompt's fingerprint; the text lives in the binding and in the run's own snapshot, and nowhere else. Repeating the instruction on every row of a thirteen-row lifecycle would buy no explainability and create a second place to leak from. | FR-050, FR-053, FR-054, AC-139 |
| 10 | What is the retention cost of recording a fingerprint rather than the text? | Stated rather than hidden: once a run's queued record ages out, the fingerprint still says a prompt was used, and a mismatch against the binding's current fingerprint is exactly the signal that the operator has since changed it. | FR-054, SC-124 |
| 11 | Is the prompt read at dispatch or snapshotted at detection? | Snapshotted at detection, beside the target project and worktree option, so a run is reproducible after the binding is edited and a retry composes an identical message. | FR-015, AC-138 |
| 12 | What happens when a whole-file save omits the field? | The stored value is preserved. Omission means "I did not change it"; an explicit value, including empty, means "set it". Otherwise a panel that does not render the field would erase the operator's instruction on its next unrelated save. | FR-014, AC-137 |
| 13 | Is there any templating? | None, ever, and the requirement exists so its absence is not read as an unfinished feature. `{number}` and every other construct arrive as literal characters. | FR-039, AC-134 |
| 14 | Does 004 build the Bindings tab's field? | No. It fixes the field's identity, name, and meaning, and leaves the design, layout, and affordances to 005 so the field is rendered exactly once. Between the two features the documented set path is the service store file. | FR-060 – FR-064, AC-144 |
| 15 | Is there an account-level or global default? | Not this cycle. Per-binding only, and no built-in instruction is ever substituted for an unset prompt. The resolution order a later fallback feature must satisfy is fixed now so it is designed once. | FR-070, FR-071, FR-072 |
| 16 | Does 004 touch the dispatch state model? | No. Leases, requeue, `unconfirmed`, and dead-lettering belong to 003; 004 composes with 003's retry rule and restates none of it. | FR-015, `## Out of Scope` |
| 17 | How are the two predecessor documents updated? | The same shape 003 used: 002 goes to v1.3.0 and 003 to v1.1.0, each with a banner under its header and a requirement-by-requirement `## Amendment History`, both bodies left verbatim. Unlike 003's supersession, every affected requirement is **extended**, not superseded — the shipped build has no prompt field and violates nothing. | FR-001, `## Amendment Map` |
| 18 | Product-owner confirmation of the prompt length cap (Gate Question 1) | **Confirmed 2026-09-28** as encoded at 2,000 Unicode code points after trimming. Rejected alternatives, as stated by the product owner: **3,000**, which starves the source excerpt, and **1,000**, in which machine context dominates the instruction. The tunable range of 500–3,000 in FR-021 is **retained** — the owner rejected 3,000 as the *default*, not as the range's upper bound, and FR-021's existing condition that any configured value keep the composed message inside the per-dispatch bound 002 FR-028 sets is unchanged. No requirement text changed — FR-020 already states the cap, FR-021 the range, AC-132 both edges. | FR-020, FR-021, AC-132, `## Resolved Gate Questions` |
| 19 | Product-owner confirmation of refuse-versus-warn on a credential-shaped prompt (Gate Question 2) | **Confirmed 2026-09-28** as encoded: **refused at save**. Rejected alternative, as stated by the product owner: **warn-and-allow-save**, which puts a credential-shaped value at rest in the bindings store. The documented cost is **retained and remains visible**: the shape match is narrow but non-zero-width — GitHub token prefixes, an `Authorization:` header spelling, a bearer credential — so a prompt that *discusses* the product's own token handling could be refused. No requirement text changed — FR-024 already refuses the save and already records warn-and-store and redact-and-store as rejected. | FR-024, AC-133, SC-123, `## Resolved Gate Questions` |
| 20 | Product-owner confirmation of fingerprint-versus-text on audit rows (Gate Question 3) | **Confirmed 2026-09-28** as encoded: **a fingerprint, never the text**. Rejected alternative, as stated by the product owner: **storing the full prompt text in audit rows**, which would embed operator-authored content in every dispatch row and make a secret-bearing prompt a retention liability. No requirement text changed — FR-050, FR-053, and FR-054 already record the fingerprint and already record the text-on-every-row alternative as rejected. | FR-050, FR-053, FR-054, AC-139, SC-124, `## Resolved Gate Questions` |
| 21 | Omission-preserves on a whole-file write (Gate Question 4) | **Confirmed 2026-09-28 as a technical default, not a product decision.** No product preference was hiding in it: the rule follows from the whole-file replacement semantics of the existing bindings surface, and that surface has no distinct erasure signal, so a write that omits the field cannot mean "clear it" without a client that cannot see the field destroying the operator's instruction on its next unrelated save. The owner's answer covered the three product questions; this entry records the fourth as settled on its own merits rather than leaving it open. No requirement text changed — FR-014 already states it. | FR-014, AC-137, `## Resolved Gate Questions` |

## Resolved Gate Questions (the three product questions confirmed by the product owner — 2026-09-28; the fourth confirmed as a technical default)

These four questions were raised at the phase gate as the places where this specification encoded a defensible default rather than escalating. The product owner reviewed the three that were product decisions on **2026-09-28 and confirmed every default as encoded**; the fourth was settled on its own technical merits, as recorded at entry 4. **No requirement text changed as a result** — each confirmed answer is already the requirement (see `## Clarifications` rows 18–21). Each entry below states the confirmed answer first, then the question as originally posed, then the alternative that was considered and rejected, so a later reader can see what was weighed and why it was set aside. Entry 4 is the exception in kind, and says so rather than manufacturing a rejected option it never had.

1. **Confirmed: the length cap is 2,000 Unicode code points**, measured after trimming. The tunable range in FR-021 — 500–3,000, adjustable in planning without a spec change — is retained.
   - **Question as posed**: is three hundred words the right ceiling for a starting instruction, or will some operators want to paste a checklist? Changing it is a one-line revision to FR-020 and the default in `## Assumptions`.
   - **Confirmed 2026-09-28** as encoded at 2,000. **Rejected alternatives**, as stated by the product owner: *3,000*, which starves the source excerpt — the cap is chosen precisely so a maximal prompt cannot squeeze the excerpt inside the dispatch budget — and *1,000*, in which the machine-built context dominates the instruction and the operator's words become the smaller half of the message. On the range: 3,000 was rejected as the **default**, not as the range's upper bound, so FR-021 is unchanged; any configured value must still keep the composed message inside the per-dispatch bound 002 FR-028 sets, which FR-021 already requires.
   - **Encoded in**: FR-020, FR-021, AC-132, `## Assumptions`.

2. **Confirmed: a credential-shaped prompt is refused on save**, naming the shape and never the text. The previously stored prompt stays in force, and the rejected value leaves no trace anywhere — including in the refusal.
   - **Question as posed**: would any legitimate starting instruction be refused for containing something that looks like a token? A warning-and-refuse-the-save hybrid was available if the owner would rather see the value echoed back for correction, at the cost of the refusal becoming a partial disclosure.
   - **Confirmed 2026-09-28** as encoded. **Rejected alternative**, as stated by the product owner: *warn-and-allow-save*, which puts a credential-shaped value at rest in the bindings store. FR-024 additionally records *redact-and-store* as rejected — silently altering an operator's instruction is worse than refusing it, and a stored value the operator never sees is not one they can reason about.
   - **The cost is retained and remains visible**: the shape match is narrow but **non-zero-width** — GitHub token prefixes, an `Authorization:` header spelling, a bearer credential — so a prompt that *discusses* the product's own token handling could be refused. This is a known, accepted false-positive risk, not an unexamined one.
   - **Encoded in**: FR-024, AC-133, SC-123.

3. **Confirmed: audit rows carry a fingerprint, never the prompt text.** Every dispatch-lifecycle row that records what was sent carries the binding id, the prompt's fingerprint, and its presence and length. The text lives in exactly two places: the binding record, and the queued record's snapshot.
   - **Question as posed**: does an operator ever need the *exact instruction* recovered from a months-old run?
   - **Confirmed 2026-09-28** as encoded. **Rejected alternative**, as stated by the product owner: *storing the full prompt text in audit rows*, which would embed operator-authored content in every dispatch row and make a secret-bearing prompt a retention liability. FR-053 independently records the same alternative — carrying the text on every lifecycle row multiplies the operator's instruction by the row count for no added explainability, grows a bounded file with content the operator already owns in their configuration, and creates a second place to leak from.
   - **The answer to the question as posed** is unchanged by the confirmation: an operator who needs exact historical text wants the retention and export work that is already backlog, not a second copy of every instruction on every audit row. The fingerprint remains the identity, and a mismatch against the binding's current fingerprint remains the signal that the prompt changed.
   - **Encoded in**: FR-050, FR-053, FR-054, AC-139, SC-124.

4. **Confirmed as a technical default, not a product decision: omission preserves, an explicit value sets**, in a whole-file write. A binding submitted without the field keeps whatever the store holds; an explicit value sets it, including the clearing values.
   - **Question as posed**: would an operator ever expect a whole-file write from a client that omits the field to *clear* it?
   - **Not escalated to the product owner, and that is stated rather than disguised.** The owner's answer covered the three product decisions above; this entry records the fourth as settled rather than leaving it open. It is settled because the rule follows from the surface rather than from a preference: the bindings surface is a whole-file replacement, and it carries no distinct erasure signal, so an omitted field has exactly one available reading. Silence from a client that cannot see the field is not an instruction to delete — and until 005 renders the field, the panel **is** such a client. Preserving on omission is the only rule under which shipping this feature cannot destroy an operator's typed instruction.
   - **No rejected alternative was recorded**, and none is invented here. The alternative — *omission clears* — is not a competing design so much as the absence of one, and the reasoning above is what rules it out.
   - **Encoded in**: FR-014, AC-137, `## Assumptions`.

## Amendment Map

> **Amendments in force.** **v1.1.0 (2026-09-28, feature 005)** records an **extension** amendment. Feature 005 (`specs/005-panel-ia/spec.md`, v1.0.0) replaces the panel's spike-era surface with six tabs and places this feature's field on the **Bindings** tab, where it is rendered **exactly once** in the panel. It **supersedes nothing** in this document and changes no requirement text: the composition order, the bounds, the delimiters, the snapshot rule, the fingerprint, the credential-shape refusal, and the `binding.prompt-updated` audit row all stand exactly as written below. What 005 adds is a placement requirement, a single-rendering rule, and a record that the cosmetic `Rule:` debt noted in `## Clarifications` is now 005's copy work. Where the two could be read as disagreeing about what a dispatch says, **this document prevails**; 005 is authoritative only for where the field is rendered. The index is `## Amendment History` at the end of this file.

The authoritative text for each item is this specification. 002 v1.3.0's and 003 v1.1.0's `## Amendment History` sections record the same mapping from the other side. Every status is **extended** — 004 adds to a requirement; it supersedes none.

| Predecessor requirement | Status after this feature | Authoritative text |
| --- | --- | --- |
| 002 FR-013 — the add-repository sequence: account, then an existing project, then per-repository triggers | **Extended** — the sequence gains one optional element, and the field is stated to be service-owned configuration | 004 FR-010, FR-011, FR-013 |
| 002 FR-015 — the trigger set | **Unchanged; reaffirmed** — a prompt is not a trigger and cannot widen what a binding listens for | 004 FR-044 |
| 002 FR-028 — what a dispatch carries: resolved project, source attachment, worktree option, bounded delimited excerpt, correlation id | **Extended** — the operator's prompt is placed first, above the automatic framing; every bound, delimiter, and snapshot clause stands | 004 FR-030 – FR-039, `## Dispatch Message Composition` |
| 002 FR-029 — the agent pin; no per-call agent, model, or variant | **Unchanged; reaffirmed** — a prompt is text, never a selector, and is not a back door to the pin | 004 FR-040, FR-041 |
| 002 FR-031 — read-only to GitHub | **Unchanged; reaffirmed** — no prompt content may be satisfied by a write | 004 FR-002, FR-042 |
| 002 FR-033 — the service durably owns configuration outside `host.storage` | **Extended** — the prompt is named as configuration the service owns | 004 FR-011 |
| 002 FR-034 — panel UI state lives in `host.storage` | **Extended, and distinguished** — the prompt is explicitly *not* panel UI state and is not written there | 004 FR-011, FR-061 |
| 002 FR-035 — the audit trail records dispatches and terminal outcomes | **Extended** — dispatch rows reference the prompt by fingerprint and a prompt change is audited; the bounding, redaction, and retention clauses stand | 004 FR-050, FR-051, FR-053, FR-054 |
| 002 Key Entity `RepositoryBinding` — repository id/owner/name, bound account, resolved `projectId`, per-trigger enablement flags, mention token override, worktree option, policy profile, enabled state | **Extended** — one optional field, absent when unset; the state machine gains no transition | 004 FR-010, 004 `### Key Entities` |
| 002 `## Configuration Model` — "Repository bindings: account, project id, per-trigger enablement, mention-token override, worktree option, policy profile" | **Extended** — the same optional field in the same list, with the same absence-means-unset semantics | 004 FR-010, FR-011 |
| 002 `## Out of Scope` — per-call agent, model, or variant selection | **Unchanged; reaffirmed** | 004 FR-040, `## Out of Scope` |
| 003 FR-041 — an operator retry returns a failed run to waiting under the same run key | **Unchanged; composed with** — a retry reuses the same prompt snapshot and therefore composes a byte-identical message | 004 FR-015 |
| 003 FR-043 — agent verification is audited, visible, and warn-only | **Unchanged; reaffirmed** — prompt content cannot change the observed agent or the pin | 004 FR-040, FR-041 |
| 003 FR-050, FR-054 — one correlation id, end to end; finer references preserved | **Unchanged** — the fingerprint rides on the same correlation id as an attribute of what was sent; it is not a second identifier | 004 FR-038, FR-050 |
| 003 FR-060, FR-061 — the dispatch-lifecycle audit vocabulary and row shape | **Extended** — one new event type, `binding.prompt-updated`, and two credential-free fields on the rows that record what was sent | 004 FR-050, FR-051, `### Audit Vocabulary Delta` |
| 003 FR-062 — a dispatch-lifecycle row MUST NOT generate a fresh correlation identifier for a run | **Unchanged; reaffirmed** — the fingerprint is a deterministic function of the prompt text, not a per-row minted id, so the same prompt yields the same fingerprint on every row, every run, forever | 004 FR-038, FR-050 |
| 003 `## Audit Vocabulary` | **Extended** — one row added; the existing entries are unchanged | 004 `### Audit Vocabulary Delta` |
| 003 `## Wire Surface Delta` — run history projection | **Extended** — the projection gains prompt presence, fingerprint, and length; no field is removed and no text is exposed | 004 FR-052 |
| 003 `## Key Entities` — `Run` — "the target project and worktree option as snapshotted" | **Extended** — the prompt is snapshotted in the same clause, at enqueue | 004 FR-015, 004 `### Key Entities` |
| 003 NFR-106, 003 NFR-109, 003 NFR-110 — secret containment, rendering safety, no new host capability | **Unchanged; extended with** assertions covering the new field | 004 NFR-121, 004 NFR-127, 004 FR-004, 004 FR-005 |
| Everything else in 002 and 003 | Unchanged | 002 v1.3.0, 003 v1.1.0 |

### Audit Vocabulary Delta

003's `## Audit Vocabulary` is unchanged. This feature adds exactly one event type, and the shape of the rows that record what was sent.

| `eventType` | Actor | Written when | Decision | Required `details` |
| --- | --- | --- | --- | --- |
| `binding.prompt-updated` | `operator` when the change arrived through the panel, `service` otherwise | A binding's prompt is set, changed, or cleared | `set` \| `changed` \| `cleared` | binding id, the new fingerprint, whether a prompt is now set, its length, and the previous fingerprint — never the text |

And on the rows that record what was sent — `dispatch.reserved` and `dispatch.result` — two credential-free scalars are added to the required details: the binding id and the prompt's fingerprint, plus presence and length. A run that never reached authorisation still projects presence and fingerprint through 004 FR-052, so "which prompt would this run have used" is answerable for every run, not only the ones that dispatched.

## Amendment History

Amendments to this specification follow the same procedure and shape as the project's constitution (`.specify/memory/constitution.md` §Governance) and as 002's and 003's own `## Amendment History`: a version bump, a stated rationale, a requirement-by-requirement record, a migration-impact statement, and an approval status. Requirement text in this document is **never rewritten**.

### v1.1.0 — 2026-09-28 (extension amendment; feature 005 places the field on the Bindings tab)

- **Rationale**: 004 landed the field and named its renderer: the roadmap says 004 "lands before 005 so the Bindings tab renders the prompt field **exactly once**", and 004's own dependency line records that 005 "renders this field exactly once". This amendment makes that placement a requirement with a reason, rather than a note in a predecessor's header. The reason is specific and not stylistic: a starting prompt is an instruction, and **two renderings of one instruction is how two versions of it start to disagree** — an operator who edits the field in one place and reads it in the other cannot tell which is authoritative. The same reasoning applies to the fingerprint: the row may show presence and length, and must never show the fingerprint or the text, because a fingerprint presented beside an editable field invites the operator to believe it is editable.
- **Sequencing decision**: 005 **extends** this document and **supersedes nothing** in it. 005 is **unimplemented** and so is 004, so this is a **record amendment**: there is no deployed field to migrate and no rendered surface to correct, only a design still free to be made around the placement.
- **Principles reviewed, unchanged in substance**: Principle I (no secret in any store, log, or rendered surface) is served by the single-rendering rule together with the refusal of credential-shaped prompt text — 005 adds a rendering case to the existing secret-scan suites rather than an exemption. Principle IV (human-visible auditability) is served by the row's presence-and-length display: the operator learns that a prompt is set and how long it is, without the audit trail ever holding the text. Principle II (safe autonomy by default) is unchanged — the prompt is still operator-authored instruction placed above untrusted source text, and 005 changes where the field sits, not what may be typed into it. Principle VII (thin orchestration boundary) is unaffected — the panel still composes the message it already composed and sends it through the call it already makes. No principle is weakened.
- **Requirement-by-requirement record**:

  | 004 v1.0.0 requirement | Effect of feature 005 | Status after v1.1.0 | Authoritative text |
  | --- | --- | --- | --- |
  | **FR-010** — a binding gains one optional per-binding starting prompt, absent when unset | Unchanged in substance. 005 **places** it: one field, in the binding's editor on the **Bindings** tab, labelled as the starting prompt for dispatches from this repository. Absence-when-unset semantics, validation, and bounds are untouched | **Unchanged; placed** | 005 FR-051, FR-053 |
  | **FR-024** — a prompt carrying a credential-shaped string is refused at save, with remediation, and the previously stored prompt stays in force | Unchanged, and **extended at the panel layer only**: 005 MUST render the service's field-level refusal with its remediation, MUST NOT report the save as successful, MUST NOT pre-emptively accept or reject what the service would decide, and MUST carry the same refusal rule to the new account display-name field (005 FR-066). The save-time obligation here is unchanged | **Unchanged; extended with** | 005 FR-052, FR-066 |
  | **FR-015** — the prompt is snapshotted at enqueue, so a retry composes a byte-identical message and a binding edited mid-retry cannot change what the retry says | Unchanged. 005 adds a **conformance assertion**, not a rule: a binding saved while a dispatch for it is in flight MUST NOT visibly change that dispatch's row, because the snapshot is the point. No clause of the snapshot rule is added or relaxed | **Unchanged; asserted** | 005 FR-051, 005 `### Edge Cases` |
  | **FR-050 – FR-054** — the audit trail records the prompt as a fingerprint, never text; `binding.prompt-updated`; credential-free reference scalars on `dispatch.reserved` and `dispatch.result` | Unchanged. 005 adds **no audit event type, renames none, and renders none of the text**. Where 005 shows prompt information to an operator at all, it is presence and length drawn from the binding record, never the fingerprint and never the text | **Unchanged** | 005 FR-027, FR-051 |
  | **FR-052** — the run projection carries prompt presence, fingerprint, and length for every run | Unchanged. 005 renders the run row; the three projected fields stand exactly as specified | **Unchanged** | 005 FR-051 |
  | **`### Audit Vocabulary Delta`** — the one new event type and the scalars added to two existing rows | Unchanged. 005 adds no event type and does not alter any row shape | **Unchanged** | 005 FR-027 |
  | **Single-rendering rule** — new, and the substantive addition of this amendment | The prompt is rendered **exactly once in the entire panel**: one field in the binding's editor. It MUST NOT also appear on the row summary, on Status, on a dispatch row, in a Diagnostics view, or in a second editor. The row summary MAY show presence and length and MUST NOT show the fingerprint or the text | **Added by 005** | 005 FR-051 |
  | **`Rule:` line cosmetic debt** — 004's `## Clarifications` records that the shipped `Rule:` framing line "reads as though an assignment fired on a mention/review dispatch", notes the reproduction is not endorsement, and states "The copy fix belongs to 005 or later" | Acknowledged and assigned. 005 owns the copy; **the framing line itself is not re-specified here**, because it is part of the dispatch message 004 owns and 002 FR-028 bounds. 005 changes the wording, never the structure, the bounds, or the delimiters | **Acknowledged; assigned to 005** | 005 FR-022, 005 `## Clarifications` row 20 |
  | **NFR-121** secret containment, **NFR-127** rendering safety | Unchanged, and **extended with**: the prompt is the most operator-controlled string this product renders, and 005 requires it to use the same non-HTML path with a case proving an operator-supplied string cannot execute in the panel | **Unchanged; extended with** | 005 FR-080, 005 NFR-101 |
  | **NFR-125** compatibility — no new capability, no new operation on the wire, no new store | Unchanged and **satisfied**: 005 adds no capability, no new host call, and no new store. The prompt is typed into a binding record 004 already defined and read by the loop 004 already uses | **Unchanged** | 005 FR-004, 005 NFR-106 |
  | Everything else in v1.0.0 — the composition order and delimiters, the bounds, the snapshot rule, the fingerprint, the credential-shape refusal, the audit row, every SC and AC | Unchanged | **Unchanged** | 004 v1.1.0 |

- **Migration impact**: none. 004 is unimplemented, so there is no stored prompt, no audit row, and no rendered surface to convert. The one thing that *looks* like a migration and is not: a binding with no prompt field projects presence `false` and a null fingerprint, which is a true statement about that binding rather than a hole in the record — the same absence-means-unset rule 004 already specifies, unchanged.
- **Downstream effect on the contract set**: no contract under `specs/002-agent-event-extension/contracts/` is superseded or versioned by this amendment. The binding record and the dispatch-list read change shape in Phase 4's contract work for 004's and 005's own reasons; nothing in this amendment adds a field to either.
- **Approval status**: submitted for product-owner approval with feature 005 at the phase gate, 2026-09-28. The product owner approved **v1.0.0** on 2026-09-28; this v1.1.0 delta was written the same day and requires no re-approval of v1.0.0's content, which is byte-identical to what was approved. One of 005's four gate questions — whether the spike-era diagnostics survive as a read-only section in About — could in principle surface prompt-adjacent information there; the default recorded in 005 (`## Clarifications` row 22) is a read-only view that includes the evidence schema version and the ledger and **does not include prompt text or fingerprints**, which keeps this amendment's single-rendering rule intact whichever way the owner answers.

**Version**: 1.1.0 | **Approved at**: 1.0.0 | **Last Amended**: 2026-09-28
