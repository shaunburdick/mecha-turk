# Feature Specification: Dispatch Integrity & Recovery

**Feature ID**: `003-dispatch-integrity`

**Feature Branch**: `full-project-plan` (the planning branch for the post-MVP cycle; the spec directory and the git branch are independent. Implementation moves to its own `003-dispatch-integrity` branch per `AGENTS.md` git conventions.)

**Created**: 2026-09-28

**Last Updated**: 2026-10-03 — see [changelog.md](changelog.md) for what changed and why

**Version**: 1.11.0

**Status**: Implemented, current at v1.11.0; the requirement history is in [changelog.md](changelog.md)

**Dependencies**: Feature 002 `002-agent-event-extension` (v1.2.0 → v1.3.0 → **v1.4.0**) — **amended by this specification, by 004, and by 005**. The trigger set, credential custody, binding model, normalized delivery record, dispatch mechanism (`host.startSession()`), agent pin and post-dispatch read-back, audit durability split, and the read-only-to-GitHub posture all carry forward unchanged. This specification **supersedes** 002's text on the dispatch lifecycle and the correlation id only; every other 002 requirement stands. **Extended by** `004-starting-prompt` v1.0.0 (see changelog.md), which supersedes nothing here. 004 depends on this specification, not the reverse; 005's Dispatches tab depends on both. **Extended by** `005-panel-ia` v1.0.0 (see changelog.md), which supersedes only the `Status` row of `## Wire Surface Delta` and renders — never re-specifies — every state and transition defined here. 005 depends on this specification, not the reverse.

**Input**: Product-owner brief (2026-09-28) — "Mecha Turk will listen for events that would trigger a new worktree/session from the outside world," with triggers, PAT accounts, and bindings as the defined surface. 003 covers the **correctness half** of that brief: the seven defects recorded in 002's close-out. It does not cover the UX reorganization (005) or the per-binding starting prompt (004). Scope source: `specs/003-dispatch-integrity/pm-handoff.md`.

**Constitution**: `.specify/memory/constitution.md` v1.3.0 — Approved 2026-09-27 by product owner. Governing principles for this feature: **III (durable and idempotent work)** and **IV (human-visible auditability)**, with **II (safe autonomy by default)** supplying the fail-closed posture and **VI (specification and verification before implementation)** the testable-requirement discipline.

> 📝 **Amended 2026-10-03 (v1.8.0) — the actor allow-list gate joins the authorization decision.**
> An operator can now restrict who may start a session from a given repository, and the enforcement point is **this document's** because `service/poll/dispatch-authorize.ts` is the single place a dispatch token is minted (FR-076). Filtering during the poll would be cheaper and would leave **no audit row**, so "why was this not dispatched?" would have no answer — constitution IV forbids that. Detection now only **records** the actor (002 FR-043); nothing decides on it until the authorization does. One refusal code (`actor-not-allowed`), one `dispatch.refused` row, a fifth declared `blocked:` cause the run waits in rather than burning an attempt or a requeue budget in, and a **value-free** `actorPolicy` detail so an audit reader can tell an open binding from a restricted one. No existing row is renamed and no event type is added. See changelog.md → `### v1.8.0`.
>
> 📝 **Amended 2026-10-02 (v1.7.0) — `agent.uncompared` joins `## Audit Vocabulary`.**
> The Default Agent pin now defaults to **blank** (002 v1.10.0, 006 v1.5.0, product-owner order), so "no baseline configured" is the *usual* verification — and a read-back with nothing to compare against is no longer logged as `agent.mismatch`. One row, one decision (`observed`), carrying the observed agent, the empty baseline, and the provenance that says why nothing was compared. FR-043 and FR-060 now name all three outcomes. See changelog.md.
>
> 📝 **Amended 2026-10-01 (v1.6.0) — acceptance evidence consolidated for change efficiency.**
> The test/acceptance-evidence layer was relaxed by product-owner order; the normative body below (FRs, NFRs, security rules) is unchanged. See changelog.md.
>

## Problem Statement

Feature 002 shipped and was live-validated on 2026-09-28: two issues produced two worktree sessions, and the full loop — account, binding, triggers, dispatch, agent read-back, runs list, retry — worked for the operator. The close-out review also recorded seven defects. Five of them are **conformance failures against requirements 002 already states**, which means the product today contradicts its own specification in the place operators would check first: how many sessions a single piece of GitHub activity produces, and why.

The three that matter most are all routes to the same outcome — **two agent sessions for one piece of work**:

1. **Two triggers on one subject mint two event ids.** An issue that is both assigned to the bound account and mentions it produces two queue rows and two sessions. 002's own edge case requires one run, one session, and both source references preserved. Nothing in the shipped queue collapses them: the deduplication key *is* the event id, and the event id carries the trigger discriminator.
2. **A panel that closes mid-dispatch strands its claim.** The claim is a state flip with no lease, so an event claimed by a panel that never finished stays `in-flight` forever. Nothing requeues it. 002 FR-037 requires a non-looping crash response and 002 NFR-006 requires durability across restart; today the operator can see the stranded row but has no path out of it.
3. **A dispatch whose result report never lands can double-session.** `host.startSession()` succeeds, the session exists, and the report to the service is lost — the row stays `in-flight`. The operator retries, the event becomes claimable again, and because the panel's per-mount handled list starts empty after a remount, a second session is created for work already underway. The panel knows the truth; the service does not; and nothing makes the truth travel.

The remaining four defects are auditability gaps of the same family: dispatch, dispatch-result, retry, and agent-verification produce no service audit rows (002 FR-035); audit rows carry a fresh uuid while the panel's ledger carries the event id, so no single correlation id spans the chain (002 NFR-007); the project picker has no "not listed?" guidance (002 FR-014); and the panel ships no first-run prerequisites section (002 FR-038).

An unattended product that can start a second agent on the same issue is not operable. Constitution III forbids duplicate work from repeated observations, restarts, or clock skew; constitution IV requires that an operator be able to explain why an event was accepted, retried, or executed. This specification closes all seven defects, and it does so by making a second session for the same work **impossible by construction** rather than merely unlikely — and by making every state transition carry a reason the operator can read.

## Governing Principles and Relationship to Feature 002

### How the amendment is sequenced

Five of the seven defects fail requirements 002 already states, so this feature cannot be a clean extension: the two documents would otherwise contradict each other. The sequencing decision is:

> **003 supersedes those 002 requirements, and 002 v1.2.0 records the supersession.**
> The authoritative text for the dispatch lifecycle, the run/delivery distinction, the correlation id, the audit vocabulary, and the two operator-surface gaps is **this document**. 002's text for those points is a historical record of what v1.1.0 specified and what shipped; it is not rewritten, because rewriting it would misrepresent the MVP's implemented behaviour and erase the evidence trail that makes this cycle's defects legible.

Concretely:

- 002 v1.2.0 gains a changelog.md section naming, requirement by requirement, which 002 requirement is superseded by which 003 requirement, with the reason. It also carries a banner under its header so a reader meets the supersession before reading any requirement.
- This document never duplicates an unaffected 002 requirement; it **references** 002 by number (`002 FR-033` stands) instead of restating it.
- Where 002's superseded text is quoted in this document, it is quoted inside a blockquote marked *superseded* so no reader mistakes it for current text.
- No requirement is silently dropped. Every 002 requirement named as superseded appears in the changelog.md table of 002 v1.2.0 **and** in the `## Supersession Map` of this document, pointing the same direction.

If the two documents are ever read as disagreeing, **this document wins** for the dispatch lifecycle, and 002's changelog is the index that proves it.

### Invariants this feature must not weaken

- **Read-only to GitHub stands (002 FR-031).** Nothing here adds a GitHub write. In particular, the natural-looking remedy for idempotency — a marker comment, an acknowledgement reaction, a label — is **forbidden**. Idempotency is achieved entirely inside Mecha Turk's own durable state and the host's own session store.
- **Fail closed (002 FR-024, constitution II).** Ambiguity about whether a session already exists is a stop condition, not permission to dispatch again.
- **Secret containment (002 FR-007, 002 NFR-004).** The expanded audit vocabulary and the expanded run record introduce no new place a credential can land.
- **Thin orchestration boundary (constitution VII).** OpenChamber continues to own projects, worktrees, sessions, and agents. This feature adds no host capability requirement (NFR-110).
- **Manual cleanup only (002 FR-040).** This feature deletes no session, worktree, or project, and adds no automatic cleanup.

## Architecture Impact

The panel↔service split is unchanged. What changes is what the service queues.

| Component | Change in 003 | Never changes |
| --- | --- | --- |
| **Panel** | Claims a **run** rather than a queued event; reports dispatch intent before calling `host.startSession()`; persists each dispatch outcome durably before reporting it; reconciles unresolved local dispatches before its first claim; renders the new run states, the source-reference affordance, the "not listed?" guidance, and the first-run prerequisites section | Never creates projects/sessions/worktrees/agents outside `host.startSession()`/`openSession()`/`listProjects()`; never writes to GitHub; never retains a credential |
| **Service** | Owns runs, their source-reference lists, leases, dispatch tokens, and the dispatch-lifecycle audit vocabulary; coalesces deliveries into one open run; requeues expired leases; refuses stale, superseded, and already-satisfied dispatch authorizations; serves the operator's audit read | Never spawns a session; never calls a host API; never writes to GitHub; never grows a single logical instance into a multi-instance lease protocol |
| **OpenChamber host** | Unchanged. Dispatch still goes through `host.startSession()` with the same attachment, project, and worktree option. | — |

The delivered unit of work is unchanged in shape — one OpenChamber session attached to one issue or pull request, in the operator's own installation, on the operator's machine. Only the bookkeeping around it becomes correct.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — One piece of work produces exactly one session (Priority: P1)

As a repository maintainer, I assign an issue to my configured account identity *and* mention that identity in the issue body or a comment — or do both in the same minute, as people actually do — so that Mecha Turk starts one agent session for that issue with a project-manager agent, not two, and I can see both reasons it fired.

**Why this priority**: This is the product's core promise. A product that answers one issue with two competing agent sessions is not trustworthy enough to leave running overnight, and every other story in this feature is in service of making that promise keep. It is also the defect an operator hits first, in the first hour of real use.

**Independent Test**: With one active binding, create one issue that is assigned to the bound account *and* whose body mentions it, let the service scan past both, and observe exactly one run, exactly one `host.startSession()` call, and one run row listing both the assignment and the mention as the reasons it fired. Then repeat with the mention arriving in a follow-up comment after the first run is already done, and observe exactly one further session — a new, separately explained run, not a silent duplicate.

**Acceptance Scenarios**:

1. **Given** an active binding on repository `owner/name`, **When** one scan observes both an issue assignment to the bound identity and a mention of that identity in the same issue's body, **Then** exactly one run exists, it was dispatched exactly once, and the run's source references list both the assignment and the body mention with their own detection times and links.
2. **Given** the same issue with an assignment and a mention detected in **different** scans, **When** both detections have been enqueued, **Then** they resolve to one run and one session, because the second detection joined a run that was still open.
3. **Given** a run that has already reached a terminal state for issue `#4`, **When** a new comment mentioning the bound account is detected on issue `#4`, **Then** a **new, separately numbered** run is created for it, the panel shows both runs as distinct entries, and neither is a duplicate of the other.
4. **Given** a run that is still open because its dispatch was refused, **When** another mention for the same issue is detected, **Then** the new reference is joined to the open run rather than starting a second session, and the run row states that the additional reason arrived before any session was created.
5. **Given** one pull request that is both assigned to and review-requested from the bound account, **When** both triggers fire, **Then** one run and one session result, and both triggers appear in the run's source references.

---

### User Story 2 — Closing the panel never strands work (Priority: P1)

As an operator, I close the panel — to restart OpenChamber, to take a break, to update a binding — sometimes while it is mid-dispatch, and when I come back the work either happened or is clearly waiting, so that I never have to guess whether an agent is running.

**Why this priority**: Unattended means *unattended while my OpenChamber is up*, and the panel being closed is a normal thing an operator does. A stranded event that nothing ever retries is a silent loss of work, which is a durability failure (constitution III) and an honesty failure (constitution IV).

**Independent Test**: With one pending event and the panel open, close the panel during the claim, wait past the lease, reopen, and observe the event dispatched exactly once with an audit row naming the lease expiry and the requeue. Repeat with the panel closed before the claim and confirm the event waits untouched and is dispatched on reopen without any attempt being consumed.

**Acceptance Scenarios**:

1. **Given** a panel that has claimed an event but not yet reported that it is about to start a session, **When** the panel closes or the service restarts, **Then** the claim expires on its own without operator action, the event returns to the waiting state, and an audit row records the expiry, the attempt count before and after, and the reason.
2. **Given** a panel that reported it was about to start a session and then died, **When** the result deadline passes, **Then** the run does **not** return to the waiting state and no second session is started; it moves to a state that says plainly "a session may exist; nobody reported what happened," and the operator is given the two explicit ways to resolve it.
3. **Given** the panel is closed while events are merely waiting, **When** it reopens, **Then** those events are dispatched normally and no attempt counter moved, because no claim was ever outstanding.
4. **Given** a panel that was slow rather than dead, **When** its late claim report arrives after the lease expired and a later mount already claimed the same run, **Then** the service refuses it, the panel does not start a session, and the refusal is recorded — a slow panel can never join a run that a newer attempt already owns.
5. **Given** a run whose panel crashed repeatedly, **When** the automatic requeue budget is exhausted, **Then** the run is parked in a dead-lettered state naming the cause, and the operator is offered the single control that returns it to waiting.

---

### User Story 3 — A lost report cannot become a second session (Priority: P1)

As an operator, I dispatch an issue and the panel is killed in the seconds after the agent session was created but before the result was recorded, so that when I retry I am told the truth — "a session may already exist, here is how to check" — instead of finding a second agent working the same issue.

**Why this priority**: This is the only defect in the list that can silently double an operator's compute and their agent's side effects on a repository, and it is the one an operator is least likely to notice until much later. The remedy must make duplication impossible, not merely unlikely.

**Independent Test**: Kill the panel between the session creation and the result report, then remount. Confirm the panel reconciles the outstanding dispatch from its own durable record before it claims anything, that no second `host.startSession()` is issued, that the run is reconciled to the session that exists, and that the whole sequence is reconstructable from the audit trail. Then repeat with the panel's own local storage wiped, and confirm the run refuses to re-dispatch and instead presents the two explicit resolutions.

**Acceptance Scenarios**:

1. **Given** a dispatch whose session was created but whose result report never reached the service, **When** the panel is remounted, **Then** it reports the outstanding outcome before it claims anything else, the run reconciles to the session that already exists, and exactly one session has ever existed for that run.
2. **Given** the same situation and a panel whose local record of the dispatch has been lost, **When** the panel remounts, **Then** it does not start a second session; the run shows that the outcome is unknown, displays the project, worktree option, and attachment id used, and offers the two explicit ways an operator can resolve it after checking OpenChamber's own session list.
3. **Given** a run that already has a recorded session, **When** any request asks to dispatch it again, **Then** the service refuses with an explicit reason naming the existing session, and an audit row records the refusal.
4. **Given** a dispatch that was authorized and then genuinely failed before creating any session, **When** the panel reports that honestly, **Then** the run is recorded as failed with the reason, becomes retryable, and a later successful retry produces the only session.
5. **Given** a run already holding a valid unused authorization, **When** a second authorization is requested for it, **Then** the service refuses; one authorization is single-use and one run can only ever hold one.

---

### User Story 4 — Every state change has a reason the operator can read (Priority: P2)

As an operator, I open a run and read — in the panel, in plain language — why it was created, who dispatched it, whether the session exists, what the agent was, and every step it went through, all tied together by one identifier I can copy, so that I can explain to a colleague or to myself last month why a session exists.

**Why this priority**: Constitution IV makes unattended operation without visibility unacceptable, and 003 changes the state machine — new states, new refusals, new recovery paths. New states with no explanation are worse than no new states. This story is what makes the recovery machinery operable.

**Independent Test**: Take any run that has been through a requeue, a retry, or a lost report, copy its correlation identifier from the panel, and reconstruct its entire history — creation, claim, authorization, result, verification, terminal state — from the panel and the audit trail alone, with no file access and no log spelunking.

**Acceptance Scenarios**:

1. **Given** any run, **When** the operator copies its correlation identifier, **Then** every audit row for that run can be retrieved under that identifier alone, and each row names the state it moved from, the state it moved to, and why.
2. **Given** a run that coalesced two triggers, **When** the operator opens it, **Then** the row states that two reasons fired, lists each with its own kind, origin, and detection time, and marks any reason that arrived after the session was created so the operator knows the agent may not have seen it.
3. **Given** a run whose dispatch produced no session, **When** the operator opens it, **Then** the row says "dispatch failed" and shows the recorded cause — it never displays a success state for a dispatch that made no session.
4. **Given** a run whose session agent was verified, **When** the operator opens it, **Then** the row shows the observed agent and whether it matched the expected one, and a mismatch is shown as a warning rather than silently passing as verified.
5. **Given** any audit row, **When** it is inspected, **Then** it contains no credential material, and every field an operator relies on is present without opening a file.

---

### User Story 5 — The two missing pieces of operator guidance (Priority: P2)

As a first-time operator, I add a binding for a project that is not in the project list, or I set up the extension for the first time, so that the panel tells me what to do next **inside the panel**, instead of leaving me to guess or go read documentation.

**Why this priority**: Both are small, both are requirements 002 already states, and both are the first thing a new operator hits. They belong in this cycle because they are gaps, not enhancements, and closing them costs little while the recovery machinery is already being touched.

**Independent Test**: Open a fresh install with no accounts and no bindings and read the prerequisites section; then open the add-binding form and look for a project that is not listed.

**Acceptance Scenarios**:

1. **Given** the panel's add-binding form and a project the operator wants that is not in the list, **When** the operator looks for help, **Then** an explicit "not listed?" affordance states the three ways to add a project in OpenChamber, and the binding stays in its recoverable state until a registered project is chosen; the extension still cannot create a project.
2. **Given** a fresh install with no accounts, **When** the panel opens, **Then** a first-run prerequisites section is visible and lists every prerequisite the operator must satisfy, each with its own state and its own remediation line.
3. **Given** a prerequisite the panel cannot check for itself, **When** the section renders it, **Then** it says so plainly rather than showing a reassuring state the panel cannot actually verify.
4. **Given** a prerequisite that is not met, **When** the panel is used, **Then** the unmet prerequisite is surfaced as a visible notice, not only as a line inside a section the operator may never open.

---

### Edge Cases

- **Assignment and body mention on one issue, same scan** — one run, one session, two source references, one audit row per reference.
- **Assignment and comment mention on one issue, different scans** — the second detection joins the still-open run; the reference list records that it arrived after detection but before dispatch.
- **Three triggers on one issue** — one run, three references, one session.
- **Review request and assignment on the same pull request** — one run, two references, one session.
- **A body mention re-detected on a later scan** — the delivery identifier is unchanged, so it deduplicates at the delivery layer and never reaches run creation; the existing run is untouched.
- **A body mention re-detected after its row has been evicted from the bounded history** — the residual gap that durable deduplication closes, which is explicitly backlog and is named in `## Out of Scope`. It is recorded here so the risk is documented, not hidden: an old assignment or body mention can, after enough history, be detected again and open a further run. The operator sees it as a new, separately numbered run with a recent detection time, never as a silent duplicate of an old one.
- **A comment mention arriving after the first run already dispatched** — a new, separately numbered run and a second session, which is the intended behaviour (a new request deserves an answer) and is stated as an assumption and confirmed by the product owner in `## Resolved Gate Questions`.
- **A comment mention arriving while the first run is still open** — joined to that run, flagged as arrived before any session existed.
- **Panel closed after claiming, before authorizing** — the lease expires on its own, the run returns to waiting, an attempt is consumed, and the reason is audited.
- **Panel closed after authorizing, before reporting** — the run becomes *unconfirmed*: no re-dispatch, no automatic expiry, resolution by panel reconciliation or by an explicit operator decision.
- **Panel killed while the service is also restarting** — the expiry sweep runs at service start, so stranded claims are recovered without operator action; the audit row notes the recovery happened after a restart.
- **A slow panel reporting against an expired lease that a newer mount has since claimed** — the service refuses as stale; the panel starts no session; the refusal is audited. Two panels can never dispatch the same run.
- **The result report arriving twice** — idempotent: the second report changes nothing and adds one audit row recording the duplicate report.
- **The result report arriving after the run was requeued but before a new claim** — accepted and reconciled; the run returns to its recorded outcome rather than staying open.
- **The panel's local record wiped while a run is unconfirmed** — no re-dispatch; the operator resolves the run explicitly after checking OpenChamber's own session list using the run's displayed project, worktree option, and attachment id.
- **The binding that produced a run deleted while the run is waiting** — the run is held in a blocked state naming the missing binding, is retryable if the binding returns, and is never recorded as dispatched.
- **The project the run targets no longer registered** — the run is held in the recoverable project-missing state with in-panel guidance; the agent is not started and no project is created.
- **The audit trail unwritable mid-dispatch** — the durable state change is not rolled back, and the failure is surfaced to the operator as a visible warning naming the run, rather than being swallowed; the panel never claims a traceability the trail does not have.
- **Clock skew between the panel and the service** — every lease comparison and expiry decision uses the service's own clock only; the panel's clock never participates in a lease decision.
- **A correlation identifier reaching a rendering surface** — every new field is rendered through the same non-HTML path as every existing service-supplied string; a hostile title cannot execute.
- **A run whose subject was deleted or made inaccessible before dispatch** — non-actionable, recorded with the reason, never dispatched.
- **A run at its third terminal state for one subject** — a further request opens a fourth, separately numbered run; numbering is continuous and never reused.
- **An operator who retries the same run twice in a row** — the second request is refused as an invalid transition, not a second attempt.

## Requirements *(mandatory)*

### Functional Requirements

> **Numbering convention.** Requirements are numbered in reserved blocks of ten, one block per topic group: A `FR-001`–`FR-005`, B `FR-010`–`FR-017`, C `FR-020`–`FR-029`, D `FR-030`–`FR-037`, E `FR-040`–`FR-044`, F `FR-050`–`FR-054`, G `FR-060`–`FR-065`, H `FR-070`–`FR-075`, **I `FR-076`–`FR-080`** (allocated at v1.8.0 for the actor allow-list gate — exactly the case the reservation exists for: a new topic group takes the next block rather than being squeezed into an unrelated one or renumbering anything, and no existing requirement moved). Numbers not listed above are **unallocated**, not missing: they are held in reserve so a clarification or a review finding can be added to its own group without renumbering. Downstream artifacts (plan, tasks, traceability) MUST reference requirements by these numbers and MUST NOT renumber them.

#### A. Relationship to Feature 002 and the governing invariants

- **FR-001**: This specification is the **authoritative** text for the dispatch lifecycle, the run-versus-delivery distinction, the correlation id, the dispatch-lifecycle audit vocabulary, and the two operator-surface gaps defined below. `specs/002-agent-event-extension/spec.md` v1.2.0 records the supersession requirement by requirement; where the two documents could be read as disagreeing on those points, this document prevails. Every other 002 requirement — credentials, custody, bindings, triggers, polling, checkpoints, rate budget, agent pinning, read-only-to-GitHub, manual cleanup, setup prerequisites content — stands unchanged and is referenced, not restated.
- **FR-002**: The extension and the service MUST remain **read-only with respect to GitHub** (002 FR-031, unchanged). No requirement in this specification may be satisfied by a GitHub write. An acknowledgement reaction, a marker comment, a label, a review, or any other GitHub state change MUST NOT be introduced as a deduplication, recovery, or reconciliation mechanism. Idempotency MUST be achieved entirely within Mecha Turk's own durable state and the host's own session store.
- **FR-003**: The system MUST fail closed. Ambiguity about whether a session already exists for a run is a stop condition, never permission to dispatch again (constitution II). Every refusal in this specification MUST name the exact cause, MUST leave the run in an operator-visible state, and MUST write an audit row.
- **FR-004**: The run model MUST NOT introduce multi-instance lease semantics. The supported deployment remains a single local OpenChamber installation running one logical service instance with fewer than ten bound repositories (002 FR-013, NFR assumptions). Concurrency correctness is required across **panels**, not across service instances.
- **FR-005**: The upgrade to this specification MUST NOT quarantine, discard, or reset any binding's scan window. Existing stored queue rows MUST remain readable and dispatchable; the adoption of a pre-existing row into a run MUST happen without loss and MUST be recorded once (NFR-103).

#### B. Runs: one work unit per subject, per attempt

- **FR-010**: A **run** is the unit of dispatch. Its **run key** MUST be the deterministic tuple `provider | accountNumericUserId | repository | subjectType | subjectNumber | runOrdinal`, where `subjectType` is the issue or pull request the work is about, and `runOrdinal` is the number of already-terminal runs for that same subject under that same account.
- **FR-011**: **Coalescing rule.** A newly detected delivery MUST join the subject's **open** run when one exists, and MUST otherwise create a new run with the next ordinal. A run is *open* from creation until it reaches a terminal state. Terminal states are `dispatched`, `failed-resolved`→`dispatched`, and `dead-lettered`; `unconfirmed` and every `blocked:*` state are **not** terminal, so a further delivery joins them rather than opening a second unit of work.
- **FR-012**: **Delivery identity is unchanged.** The deterministic delivery identifier already in use — derived from provider, repository, subject number, and account, plus a trigger discriminator — MUST remain the deduplication key at the delivery layer and MUST remain a single URL path segment. This specification MUST NOT change its format, because it is simultaneously the delivery's dedupe key, its relay path segment, and the reference recorded in existing panel ledgers and audit rows. A new field on the delivery records the run it belongs to.
- **FR-013**: **Source references.** Each run MUST carry a list of source references, one per delivery that joined it. Each reference MUST record its delivery identifier, trigger kind, origin (assignment, issue body, comment with its comment id, or review), canonical source link, detection time, and whether it was present before the dispatch authorization was issued.
- **FR-014**: **Bounded context is preserved and widened.** The dispatch's untrusted-content excerpt MUST include every source reference on the run, each individually bounded and the total still within 002 FR-028's limits (≤4,000 characters per source item, ≤12,000 characters per dispatch, with explicit truncation markers and delimiters that prevent source text from altering policy, credentials, approval requirements, or tool scope). Adding a second trigger MUST NOT silently truncate the first one without a visible truncation marker.
- **FR-015**: **What the operator sees.** A run with more than one source reference MUST render a primary label drawn from the earliest reference plus an explicit affordance naming how many further reasons fired; selecting it MUST reveal every reference with its own kind, origin, link, and detection time. A run with exactly one reference MUST NOT show the affordance. Any reference that arrived after the dispatch authorization MUST be visibly marked as not necessarily seen by the agent.
- **FR-016**: **Coalescing is audited.** Every delivery that joins an existing run MUST produce an audit row naming the run it joined, the delivery it was, the trigger kind and origin, and whether it was present at authorization time.
- **FR-017**: **Run creation is audited.** Creating a run MUST produce an audit row naming the subject tuple, the run ordinal, and the delivery identifiers folded into it.

#### C. Dispatch: single-use authorization makes a second session impossible

- **FR-020**: **A dispatch attempt has a stable identity** composed of the run key and the attempt number, and MUST be represented by a **single-use dispatch token** derived deterministically from that pair. The token MUST be a single path-safe segment, MUST be recorded durably before the panel is authorized to act, and MUST be single-use: once consumed, it can never authorize anything again.
- **FR-021**: **Authorization before action.** The panel MUST report its intent to start a session and obtain the dispatch token **before** calling `host.startSession()`. The service MUST durably record that reservation, MUST write an audit row, and MUST only then hand back the token. A session MUST NOT be created without a valid, unconsumed token in hand.
- **FR-022**: **One run holds at most one live authorization.** A request for an authorization on a run that already has one MUST be refused with an explicit reason. A request on a run that has already produced a session MUST be refused and the refusal MUST name the existing session. A request carrying an expired, superseded, or already-consumed lease or token MUST be refused as stale, and the panel MUST NOT call `host.startSession()` after such a refusal.
- **FR-023**: **Unconfirmed is fail-closed.** When a reservation exists and no result arrives before the result deadline, the run MUST move to `unconfirmed` and MUST NOT be re-dispatched, re-leased, or retried automatically, ever. `unconfirmed` MUST NOT auto-expire into any other state. It is resolvable only by panel reconciliation (FR-025) or by an explicit operator decision (FR-027).
- **FR-024**: **The panel persists the outcome before reporting it.** The panel MUST durably record, for every dispatch attempt, the correlation identifier, run key, attempt number, the token, the outcome, and the created session identifier or the failure reason — and MUST do so **before** issuing the result report, so that a lost report leaves the truth recoverable on the panel side.
- **FR-025**: **Reconciliation before the first claim.** On every mount, and before it issues its first claim, the panel MUST report every dispatch attempt it recorded but has not seen acknowledged. Reconciliation MUST be idempotent: a repeated report of an already-reconciled attempt MUST change no state and MUST add exactly one audit row recording the repeat. Reconciliation MUST be bounded in time so a silent service cannot stall the panel indefinitely, and a bounded failure MUST surface as a visible warning rather than as a silent skip.
- **FR-026**: **Honest abandonment.** A panel that reserved a token and genuinely created no session MUST report that outcome explicitly. The service MUST record the run as `failed` with the reason, MUST make it retryable, and MUST NOT leave it unconfirmed.
- **FR-027**: **Operator resolution of an unconfirmed run.** The operator MUST be given exactly two explicit resolutions — *this dispatch did create a session* (naming it) and *this dispatch created no session* (safe to dispatch again) — each of which MUST state in the confirmation what the operator is being asked to have verified, MUST be reachable only through an explicit operator action, and MUST write an audit row naming the decision, the prior state, and the new state. Choosing *created no session* MUST be the only path that re-dispatches an unconfirmed run, and the panel MUST warn that a session may still exist and name the project, worktree option, and attachment id to check.
- **FR-028**: **The impossibility requirement.** A session MUST be creatable for a run only when all of the following hold at the moment of creation: the run is in the claimed state, it holds a valid unconsumed token, the token's lease has not expired, the token's attempt is the run's current attempt, and the run has no recorded session. Every other path MUST be refused before `host.startSession()` is called, by the panel, by the service, or by both. Consequently a second session for one run is impossible by construction under any sequence of claims, lease expiries, retries, reports, remounts, and restarts — not merely unlikely.
- **FR-029**: **Checkable attachment identity.** The attachment identifier used for the dispatch MUST be derived deterministically from the run's correlation identifier, and the run row MUST display it, alongside the target project and worktree option, so that an operator resolving an unconfirmed run can find the session in OpenChamber's own session list without reading any log.

#### D. Leases, claims, and recovery

- **FR-030**: A claim MUST be a **lease** carrying a lease identifier, the attempt number, the issue time, and the expiry time. A claim MUST NOT be a bare state flip: the run MUST record who holds it and until when.
- **FR-031**: **Lease bounds.** The lease duration MUST be configurable within a documented range with a stated default (see `## Assumptions`). The panel MUST report its dispatch result before the lease expires, and a result arriving after expiry MUST be refused as stale rather than applied.
- **FR-032**: **The requeue trigger is lease expiry, and only lease expiry.** The service MUST requeue a run whose lease expired **while no reservation had been made**, incrementing the attempt count, and MUST write an audit row naming the prior state, the new state, the attempt before and after, and the reason. The sweep MUST run at service start, before the first claim is served, so a service restart recovers stranded claims; and MUST run at least once per lease duration while the service is up.
- **FR-033**: **Bounded automatic requeue.** The number of automatic requeues for one run MUST be bounded. On exhaustion the run MUST be parked in a dead-lettered state whose reason names the cause, MUST be excluded from further automatic handling, and MUST remain resolvable by an explicit operator action that returns it to waiting with the attempt count reset — that operator action being reachable through the panel's existing select-then-act idiom, with the per-row affordance landing in 005.
- **FR-034**: **When a handled identifier may be cleared.** The panel's per-mount handled-identifier list is a duplicate-suppression convenience, never a durability mechanism, and MUST NOT be treated as evidence that a session exists. An entry MUST be cleared only when the run reaches a terminal state, or when the service hands the same run back under a new lease and a new attempt, meaning the service — not the panel — has determined the previous attempt produced no reservation. A failed result report MUST NOT by itself clear an entry, and MUST NOT by itself authorize a re-dispatch.
- **FR-035**: **The panel dispatches only what it was given.** The panel MUST refuse to dispatch any run the service did not offer in the claimed state under the current lease, and MUST refuse outright any run reported as already dispatched, unconfirmed, or dead-lettered. A panel MUST NOT infer dispatch eligibility from its own local state.
- **FR-036**: **A closed panel burns nothing.** A run that is merely waiting — no lease outstanding — MUST NOT consume an attempt, MUST NOT be requeued, and MUST NOT be dead-lettered while no panel holds it. Only an actual claim that then expired consumes an attempt.
- **FR-037**: **Claim eligibility is the service's alone.** A run in any state other than waiting MUST NOT be offered by the claim operation. A run that has already produced a session MUST never appear in a claim answer under any condition, including a replay, a reset, or a corrupted local panel state.

#### E. Honest outcomes

- **FR-040**: **A dispatch that produced no session MUST NOT be recorded as dispatched.** A run whose dispatch was attempted and yielded no session MUST be recorded in a distinct failed state carrying the cause. The panel's own history surface MUST distinguish "dispatched" from "dispatch failed" in both its label and its tone, so a failure can never be mistaken for a success at a glance.
- **FR-041**: **A failed run is retryable.** An operator retry MUST return a failed run to waiting under the **same run key**, MUST increment the attempt number, MUST clear the reservation and lease, MUST write an audit row, and MUST preserve the run's source-reference list and every prior attempt's record. It MUST NOT create a new run. The retry MUST also be refused for a run that is already waiting, already dispatched, or unconfirmed, each with a distinct reason.
- **FR-042**: **Blocked states are preserved.** A dispatch refused by a fail-closed guard before any session call — an unresolved project, a missing binding, a missing or insufficient credential, a missing policy — MUST hold the run in the corresponding blocked state naming the exact cause, in-panel guidance where guidance exists, and MUST be retryable only after the cause clears. A run whose binding was deleted MUST be blocked by that reason, never recorded as dispatched, and MUST be retryable if the binding returns.
- **FR-043**: **Verification stays warn-only, but becomes visible and audited.** The post-dispatch agent read-back MUST record its outcome as an audit row on the run and MUST be visible on the run row, showing the observed agent and whether it matched, **or that it was not compared at all** when no baseline was in force — an outcome taken against no configured baseline MUST be recorded as its own vocabulary row (`agent.uncompared`), never as a mismatch, and MUST carry the baseline's provenance rather than an expectation the operator never chose (002 FR-029 case (ii)). A mismatch or an unreadable agent MUST be shown as a warning and MUST NOT kill the session, block the run, or receive further automated handling. This specification records that 002's v1.1.0 deviation (warn-only rather than blocked) stands; promoting it to blocking is explicitly out of scope (see `## Out of Scope`).
- **FR-044**: **Every state transition is recorded with a reason.** Every transition of a run MUST be accompanied by an audit row naming the prior state, the new state, the actor, and the reason, including transitions the service performs on its own during recovery.

#### F. One correlation identifier end to end

- **FR-050**: **The run's correlation identifier is the authoritative id for the whole chain.** It MUST be derived deterministically from the run key, MUST be a single path-safe segment, and MUST appear on: every delivery that joined the run; the run itself; every audit row in the dispatch lifecycle; every panel ledger entry for the run; the dispatch request's correlation field; the attachment payload; and the agent-verification report.
- **FR-051**: **Across the panel/service boundary the id is minted once and echoed.** The service mints it; the panel MUST NOT mint, substitute, re-derive, or overwrite it. Every panel→service call concerning a run MUST carry it, and the service MUST persist exactly the value it was given. When a run's identifier is unknown to a caller, that is a refusal with a reason, never a newly generated identifier.
- **FR-052**: **Rows with no run keep their own identity.** Audit rows for polls, checkpoints, scans, consent, and credential verification describe activity that is not a work unit and MUST NOT be forced onto a run's correlation identifier; each keeps its own generated identifier and additionally records the delivery identifiers it concerns, so that a single source observation is still traceable both forwards into the run that absorbed it and backwards from the observation that produced it.
- **FR-053**: **Operator retrieval.** The operator MUST be able to copy a run's correlation identifier from the run row and retrieve the run's complete audit history under that identifier alone, through an operator-reachable surface, without file access. The read MUST be credential-free and MUST support filtering by correlation identifier.
- **FR-054**: **Correlation across the run's parts.** Where an audit row concerns a specific delivery, a specific attempt, or a specific session, it MUST record that reference alongside the run's correlation identifier, so a chain read never loses the finer-grained link.

#### G. The audit trail for the dispatch lifecycle

- **FR-060**: The service's append-only audit trail MUST record the dispatch lifecycle with the vocabulary in `## Audit Vocabulary`, covering run creation, coalescing, claim, reservation, result, abandonment, lease expiry and requeue, unconfirmed transition, dead-lettering, operator retry, operator resolution, and agent verification **in all three of its outcomes — `agent.verified`, `agent.mismatch`, and `agent.uncompared`**.
- **FR-061**: **Row shape.** Every dispatch-lifecycle row MUST carry: a monotonic sequence number; an RFC 3339 timestamp; the run's correlation identifier in the correlation field; the run as the entity, with the run's correlation identifier as the entity identifier; the actor source (service, panel, or operator); the decision or refusal recorded; a secret-free reason naming the exact cause; structured details; and redaction metadata. A row MUST NOT carry a credential under any circumstances, and a redaction refusal MUST block the write rather than logging through it.
- **FR-062**: **The correlation identifier is the run's, not a fresh one.** A dispatch-lifecycle row MUST NOT generate a fresh correlation identifier for a run that has one. This is the specific defect that made the panel's ledger and the audit trail unjoinable.
- **FR-063**: **Audit-write failure is visible.** A failure to append a required lifecycle row MUST NOT roll back a durable state change that already succeeded, and MUST NOT be swallowed: it MUST be surfaced to the operator as a visible warning naming the run, and it MUST be recorded in the service's own structured log. The panel MUST NOT imply complete traceability it does not have.
- **FR-064**: **The operator can read a run's history.** The service MUST expose the audit read described in 002's contract with correlation-identifier filtering, and MUST implement it if it is not yet present, so that FR-053 is satisfiable through the product rather than by reading files.
- **FR-065**: **Retention.** Dispatch-lifecycle rows are subject to the retention already in force (002 FR-035, `## Assumptions`). Trimming MUST NOT remove the minimal references needed to explain a run's outcome: its correlation identifier, its subject, its final state, its session if it has one, and the reason for its final state. A run that falls out of the bounded history surface MUST still have an audit trail until retention reaches it.

#### H. The two missing operator surfaces

- **FR-070**: **"Not listed?" guidance in the project picker (002 FR-014).** The picker MUST include an explicit affordance for a project the operator wants that the host does not list, stating the manual ways to register a project in OpenChamber (command palette → Add project, sidebar **+**, folder browser). The binding MUST remain in its recoverable state until a registered project is selected. The extension MUST still never create a project, and the guidance MUST be reachable from the picker without leaving the panel.
- **FR-071**: **A first-run prerequisites section (002 FR-038).** The panel MUST present a section listing every setup prerequisite the operator must satisfy, each with its own state and its own remediation line, covering: the Default Agent pin, OpenChamber needing to be running, the desktop-or-web surface requirement, the required GitHub token scopes with no write scopes, a registered project per binding, and service-capability approval with the in-panel consent step.
- **FR-072**: **Honest states.** Each prerequisite MUST be rendered in one of three states — met, not met, or **not checkable by the panel** — and a not-checkable prerequisite MUST say so rather than display a reassuring state. The Default Agent pin in particular is verifiable only after a dispatch, and the panel MUST present it that way rather than claiming to have checked a setting it cannot read.
- **FR-073**: **An unmet prerequisite is surfaced, not buried.** A prerequisite the panel can determine is unmet MUST appear as a visible notice in the panel, not only as a line inside a section the operator may never open. A met-and-checkable prerequisite MUST NOT nag.
- **FR-074**: **New run states are readable in the existing surface.** Every run state in `## Dispatch State Model` MUST render in the panel's current run list with an operator-readable label and a reason line, including the states that mean "an operator must decide." The restructuring of that surface into a dedicated tab, along with the per-row retry affordance and the list's interval cadence, lands in 005 and is not required here.
- **FR-075**: **Vocabulary.** This specification is written in the current product vocabulary ("Runs", "Repositories"). The product owner has decided that **Dispatches** and **Bindings** replace them across copy, service route names, tests, and spec language; that rename lands in 005. Every requirement here is written against the *role* of a surface, not its label, so the rename is a copy-and-naming change and MUST NOT require behavioural re-specification.

#### I. The actor allow-list gate (added at v1.8.0; GitHub issue #9)

The actor identity and the per-binding `allowedUsers` field are **002 v1.11.0's**; the panel rendering is **005 v1.11.0's**. This block is the **decision**: the one place that answers "may this run start a session at all?", which is what `service/poll/dispatch-authorize.ts` already exists for. It adds a gate, one refusal code, one declared blocked cause, and one value-free audit detail — and changes no state, no lease, no token, and no row type.

- **FR-076**: **The gate is the authorization decision; detection-time filtering is forbidden as the enforcement point.** The allow-list MUST be evaluated inside the single operation that mints a dispatch token — `service/poll/dispatch-authorize.ts` — inside the one run chain task's decide → apply → record shape, **after** `judgeReserve` has answered `null` and **before** any token is derived, any reservation is built, or any state changes. The service MUST read the binding's stored `allowedUsers` **at that moment**, exactly as the other guards read the live binding table, so an operator's edit takes effect on the next authorization without a restart and without a re-scan. Filtering during the poll was considered and rejected: it is cheaper, and it leaves **no audit row**, so *"why was this not dispatched?"* would have no answer — the defect 003 exists to end, repeated in a new place. Detection therefore **records** the actor (002 FR-043) and **decides nothing**. There MUST be no second membership comparison anywhere: the panel does not pre-check the list, because a second implementation of the rule is a second answer to the same question, and a panel that can be talked into skipping its own check is not an enforcement point (the alternative — a panel-side guard mirroring the existing `relay-gates.ts` family — is recorded as rejected in changelog.md).
- **FR-077**: **One verdict, one refusal, one row.** An actor the binding's policy does not allow MUST be refused with the distinct code **`actor-not-allowed`**, and the refusal MUST leave the run exactly as every other refused authorization leaves it: **no reservation, no token, no `dispatch.reserved` row, and nothing written to the run** (FR-021, contract §1's "nothing is minted before the verdict"). Exactly **one** `dispatch.refused` row is written, carrying the attempted operation, the refusal code, the prior state, the attempt, the binding id, the `actorPolicy` in force, **every** denied login, and each denied login's attribution basis — the `deniedAttributions` detail keeps the **closed** basis union and is **validated when present**, so a row written before 002 v1.12.0 still carries a readable `subject-author` while **no row written now does** *(this clause's rationale was re-cut at 003 v1.11.0; the superseded wording, which described the row as saying *proxy* "where it was one" on the premise that GitHub records no actor, is recorded in changelog.md → `### v1.11.0`)*. The row's duty is unchanged and is now the corrected one: it names the actor the **event** recorded — `assigner` or `review_requester` for an assignment or review request, the text author for a mention (002 FR-044, FR-049, FR-050) — and it never states a causation the evidence does not carry (002 NFR-011). **Where the verdict sits is load-bearing**: it runs *after* `judgeReserve`, so every existing verdict stays reachable on its own path and the session-naming and staleness refusals FR-022 and AC-112 depend on are never pre-empted by a policy answer.
- **FR-078**: **A policy refusal blocks; it never burns.** A run refused for `actor-not-allowed` is parked in the new declared blocked state **`blocked:actor-not-allowed`**, through the **existing block-report operation** — no new operation, no new method, no new route. The declared cause set widens from **four** values (`project-missing`, `binding-missing`, `credential`, `policy`) to **five**, and that widening is deliberate and recorded here, in `data-model.md` §2.2, and in `contracts/dispatch-authorization.md` §4: a blocked state whose reason is not in the declared set would make the runs document unreadable to its own parser. A blocked run therefore **consumes no attempt and no requeue budget**, is **never touched by the sweep**, and becomes retryable by the operator once the cause clears (FR-041, FR-042, confirmed gate answer 3) — which is the same treatment every other guard already gets. The **retry** path MUST re-check the live policy before it will dispatch a previously blocked run, exactly as it re-checks the live binding table for `blocked:binding-missing`, so a run cannot be retried into a dispatch this gate would refuse again. The panel reports the block through the operation it already reports every other guard through; **the service's refusal is the authority** and the block report is the panel's account of it (FR-042, 005 FR-044). **That account MUST NOT contradict the refusal it accounts for** *(amended v1.9.0, 2026-10-03 — see changelog.md → `### v1.9.0`)*. The block report's parts are governed by 005 FR-095; this clause governs **which account** the panel may give of an `actor-not-allowed` refusal. The gate judges the run's **retained** source references and the run layer stops retaining at the cap (T-038), so on a run whose list was cut, the reference that would have authorized it may be among the dropped ones — invisible under **every** policy, and therefore clearable by **no** allow-list edit and by **no** retry, since the retry re-judges the same list (the re-judgement FR-078 requires above). A block report whose guidance says *"add the GitHub logins … then retry"* in that case instructs an operator to do something that cannot work (constitution IV), so: the refusal MUST carry the fact as a **value-free structured member** — `referenceWindow`, one of the closed pair `'complete' | 'truncated'`, set on **every** `actor-not-allowed` refusal and absent on every other code, so absence reads as *unreported* and is never defaulted to `complete` — and the panel's guidance MUST branch on **that member**. The panel MUST NOT derive the window from the message's prose (a second parse of a sentence it is only obliged to copy verbatim), from a count it computes itself, or from a run document read at a different moment than the decision; and it MUST **refuse** a word outside the pair rather than guess at one. Where the word is `truncated`, the guidance MUST state that the allow-list cannot clear the run and MUST NOT instruct an allow-list edit followed by a retry; in every other case it MUST remain the allow-list guidance v1.8.0 shipped. No guidance may name a control the state→affordance table does not offer for a `blocked:<reason>` run (FR-041, FR-074), and no **permitted** login may appear in it (002 NFR-113).
- **FR-079**: **Absence means allow — and absence is recorded.** A binding with **no** `allowedUsers` allows any human actor, and the run is authorized normally. But the policy state in force MUST be recorded on **every** authorization the gate admits, so an audit reader can tell an unrestricted binding from a restricted one **without opening the binding file**: `dispatch.reserved` (§1) and `dispatch.result` (§2) gain one required, **value-free** `actorPolicy` detail — `'open' | 'restricted'` — written from the same read that made the decision, beside 004's `promptPresent` / `promptSources`. **The detail records the shape of the policy and never the logins**: an audit trail listing who may trigger a repository is a second copy of the access policy in a file retained for months, read by anyone who can read the file, and this feature refuses to create it. An **empty** list is not a state that can reach here (002 FR-047 refuses it at save and on read), so `'restricted'` always means at least one login.
- **FR-080**: **Bots can never be authorized, and the gate adds no second bot test.** The gate's input is the actor 002 FR-045 already filtered at detection: a login GitHub marked as a bot (a `[bot]` suffix or `type: 'Bot'`) is never attributed onto a queued event, so there is nothing for the gate to admit and no binding field that could make one allowed (002 FR-045(c)). The gate MUST reuse that judgement and MUST NOT introduce a divergent bot predicate — two spellings of "is a bot" in one service is the drift this specification's whole correlation work exists to prevent. A stored run that nevertheless carries a bot-shaped actor — a hand-edited document, an adopted pre-`actorLogin` row — MUST be **refused**, not admitted on the strength of the list, because the fail-closed reading of an unreadable actor is *no actor*, never *the list says yes*.

### Key Entities

- **Delivery**: one immutable observed fact — unchanged from 002, **plus the attributed actor 002 v1.11.0's FR-043 adds (`actorLogin`, `actorAttribution`), which is a member of the record and not part of the delivery identifier** (002 FR-046). Deterministic delivery identifier (also its dedupe key and path segment), trigger kind, origin, subject, bounded content excerpt, detection time, credential-free, plus the run key it belongs to. Multiple deliveries may belong to one run.
- **Run**: the unit of dispatch and of operator attention. Run key (the FR-010 tuple), correlation identifier (its deterministic hash), ordinal, state, attempt count, the list of source references, the attachment identifier, the target project and worktree option as snapshotted, **the actor policy in force at authorization (`open` | `restricted`, FR-079) and the logins the gate admitted, snapshotted so a later read of the run does not have to re-derive them**, the current lease, the current dispatch token, the created session identifier if any, the recorded verification outcome, and the reason for its current state. Created when a subject has no open run; never created implicitly for an ambiguous or incomplete observation. **A run may carry more than one attributed actor** — coalescing (FR-011) joins deliveries from different people onto one run — and **FR-077's rule is what decides it: the authorization succeeds when at least one of the run's source references names an actor the policy allows.**
- **SourceReference**: one delivery's membership in a run — delivery identifier, trigger kind, origin (including the comment id for a comment mention), **its attributed actor and that attribution's basis (002 FR-043, FR-044)**, canonical source link, detection time, and whether it was present before the dispatch authorization.
- **DispatchLease**: the claim's time-bounded authorization to act — lease identifier, attempt, issue time, expiry time, holder. At most one live lease per run.
- **DispatchToken**: the single-use authorization for one attempt, derived deterministically from the run key and the attempt number. Recorded at reservation; consumed by a result; single-use; never valid after lease expiry or supersession.
- **DispatchAttempt**: one recorded try — attempt number, token, start, outcome (a session identifier or a failure reason), result-reported flag, and whether the reservation was made. Every attempt is retained for the life of the run; a run's history is the ordered list of its attempts.
- **SessionRef**: the pointer to the host-owned session — session identifier, attachment identifier, dispatch time, observed agent, expected agent, verification status, source link. OpenChamber remains authoritative; the extension stores only the reference. At most one per run, ever.
- **AuditEntry**: unchanged shape from 002, extended by the dispatch-lifecycle vocabulary. Entity kind `run` is already legal. The run's correlation identifier occupies the correlation field and the entity identifier for every lifecycle row.
- **Prerequisite**: one setup requirement with a state (met / not met / not checkable by the panel), a short description, and a remediation line. Not persisted remotely; derived on read.

### Dispatch State Model

States are the panel's and the service's shared vocabulary for one run. `attempt` is the count of consumed attempts; `token` is the live dispatch token, if any.

```
   new delivery, subject has no open run
                    |
                    v
              +-----------+
       +----->|  pending  |<--------------------+
       |      +-----+-----+                     |
       |            | claim: lease issued       | lease expired,
       |            v  (+attempt)               | no reservation
       |      +-----------+                     | (+attempt)
       |      |  claimed  |---------------------+
       |      +---+-----+--+
       |          |     | reservation: single-use token issued
       |          |     v
       |          |  +----------+   result deadline passed
       |          |  | starting |----------------------+
       |          |  +----+-----+                      |
       |          |       | result reported             v
       |          |       |                     +--------------+
       |          |       +---- session id ---->|  dispatched  |  TERMINAL
       |          |                             +--------------+
       |          |
       |          +---- problem ------------->+----------+
       |          |                           |  failed  |-----+
       |          |                           +----+-----+     | operator
       |          |                                |           | retry
       |          | guard refused                  +-----------+
       |          v
       |    +----------+  cause cleared
       +----| blocked:*|---------------------------+
            +----------+

            claimed ---> +--------------+  lease expired with the automatic
                          | dead-lettered |  requeue budget exhausted, or the
                          +--------------+  operator parked the run

    starting ---> +------------+   panel reconciliation or
                  | unconfirmed|--> explicit operator decision
                  | (fail-     |       --> dispatched | failed
                  |  closed)   |
                  +------------+

    pending | claimed | starting | failed | blocked:* | unconfirmed
      `-- non-terminal: a new delivery JOINS this run --'

    dispatched | dead-lettered
      `-- terminal: a new delivery OPENS the next ordinal --'
```

| State | Meaning | Terminal? | Accepts a new delivery? | Resolution |
| --- | --- | --- | --- | --- |
| `pending` | Waiting for a panel. No lease held. | No | Yes — joins this run | Claimed by the next panel |
| `claimed` | A panel holds the lease; it has not yet said it is about to start. | No | Yes — joins this run | Reservation, lease expiry → `pending`, or a guard refusal |
| `starting` | The panel holds a single-use token and is about to call the host. | No | Yes — joins, flagged as arriving after authorization | Result report, or result deadline → `unconfirmed` |
| `dispatched` | A session was created and reported. | **Yes** | No — opens a new run at the next ordinal | Operator retry is refused |
| `failed` | A dispatch was attempted and produced no session; the cause is recorded. | No | Yes — joins this run | Operator retry under the same run key |
| `blocked:<reason>` | A fail-closed guard refused the dispatch before any host call. | No | Yes — joins this run | Operator retry once the cause clears |
| `unconfirmed` | A reservation exists and no result arrived. Fail-closed: no automatic action, ever. | No | Yes — joins this run | Panel reconciliation, or an explicit operator decision |
| `dead-lettered` | The automatic requeue budget was exhausted, or the operator parked it. | **Yes** | No — opens a new run at the next ordinal | Explicit operator return to `pending` |

**Relationship to the shipped three-state queue vocabulary.** The MVP implementation stores one state per queued event. 003 requires the richer model above, and the upgrade MUST map the stored vocabulary onto it without loss:

| Shipped queue state | 003 run state | Rule |
| --- | --- | --- |
| `pending` | `pending` | Carried through unchanged; the row is adopted into a run. |
| `in-flight` with no reservation recorded | `claimed` with an already-expired lease | The lease cannot be validated, so the expiry sweep requeues it **once** and audits it as a migration recovery, not as a normal expiry. |
| `in-flight` with a reservation recorded | `starting`, subject to the result deadline | The reservation is honored; if the deadline passes the run becomes `unconfirmed`. |
| `dispatched` with a session identifier in the result | `dispatched` | Terminal. Carried through unchanged. |
| `dispatched` with a problem string in the result | `failed` | The shipped build recorded these as successes; 003 records them as failures and makes them retryable (FR-040, FR-041). |

Adoption MUST NOT reset any binding's scan window, MUST NOT quarantine any file, and MUST be recorded once per adopted run (FR-005).

**The declared `blocked:` causes are a closed set of five** (v1.8.0 widened it from four): `project-missing`, `binding-missing`, `credential`, `policy`, and **`actor-not-allowed`** (FR-078, the allow-list gate). The family itself is not an enum — the prefix plus a non-empty kebab reason is what parses — but a block report may only **name** one of these five, so the runs document stays readable to its own parser. A sixth cause is a new requirement in this document, not an extra string at a call site.

### Correlation Model

One identifier, derived from the run key, present at every hop. The table is the contract of FR-050 and FR-051.

| Hop | Carries the run correlation identifier? | Also carries |
| --- | --- | --- |
| Poll / scan | No — no run exists yet | Its own generated id; the delivery identifiers the scan produced |
| Checkpoint advance | No | Its own generated id; the delivery identifiers the window covered |
| Delivery (detected) | Yes — assigned at enqueue | Its own deterministic delivery identifier |
| Run creation | Yes | Run key, ordinal, folded delivery identifiers |
| Coalescing | Yes | The joining delivery identifier, kind, origin, present-at-authorization flag |
| Claim / lease issue | Yes | Lease identifier, attempt, expiry |
| Reservation / token issue | Yes | Token, attempt, attachment identifier, **`actorPolicy` (`open` \| `restricted`) and the attribution basis of every source reference admitted (v1.8.0, FR-079)** |
| Dispatch (the host call) | Yes — in the request's correlation field and attachment payload | Attachment identifier, project, worktree option, bounded excerpt |
| Result report | Yes | Token, attempt, session identifier or failure reason |
| Abandonment report | Yes | Token, attempt, reason |
| Lease expiry / requeue | Yes | Prior state, new state, attempt before and after, reason |
| Unconfirmed transition | Yes | Prior state, deadline, token, attempt |
| Operator retry | Yes | Prior state, attempt before and after, cause cleared |
| Operator resolution | Yes | Decision, prior state, new state, what the operator was told to check |
| Agent verification | Yes | Session identifier, observed agent, expected agent (empty when none is configured), the baseline's provenance, and the outcome |
| Run terminal | Yes | Terminal state, reason, session identifier if any |

**Rules.** The service mints the identifier; no caller generates one for a run. A caller that does not know it receives a refusal, never a fresh identifier. The panel's ledger entries and the service's audit rows for one run carry **byte-identical** values. A row that is not about a work unit keeps its own identifier and records the delivery identifiers it concerns (FR-052).

### Audit Vocabulary

Every row carries the run's correlation identifier, the run as entity, the actor source, a decision, and a secret-free reason. `details` is structured and credential-free.

| `eventType` | Actor | Written when | Decision | Required `details` |
| --- | --- | --- | --- | --- |
| `run.created` | service | A run is minted for a subject | *(none)* | subject tuple, run ordinal, folded delivery identifiers |
| `run.coalesced` | service | A delivery joins an open run | `coalesced` | delivery identifier, trigger kind, origin, present-at-authorization |
| `run.migrated` | service | A pre-existing stored row is adopted into a run | `adopted` | legacy delivery identifier, state it was adopted in |
| `dispatch.claimed` | panel | A lease is issued to a mount | *(none)* | lease identifier, attempt, lease expiry, source-reference count |
| `dispatch.reserved` | panel | The panel reports it is about to start a session | *(none)* | lease identifier, attempt, dispatch token, attachment identifier, **`actorPolicy` — `'open' \| 'restricted'`, never the logins (v1.8.0, FR-079)** |
| `dispatch.result` | panel | The outcome is reported | `dispatched` \| `failed` | attempt, token, session identifier **or** failure reason, **`actorPolicy` — `'open' \| 'restricted'`, never the logins (v1.8.0, FR-079)** |
| `dispatch.duplicate-report` | service | A result report repeats one already recorded | `no-change` | attempt, token, the state it repeated |
| `dispatch.abandoned` | panel | The panel reports the attempt created no session | `no-session` | attempt, token, reason |
| `dispatch.lease-expired` | service | A lease expires with no reservation | `requeued` | prior state, attempt before and after, lease identifier, expiry |
| `dispatch.unconfirmed` | service | A reservation's result deadline passes | `unconfirmed` | prior state, attempt, token, deadline |
| `dispatch.retry` | operator | The operator retries | `retry` | prior state, attempt before and after, cause reported cleared |
| `dispatch.resolved` | operator | The operator resolves an unconfirmed run | `dispatched` \| `no-session` | prior state, note, the guidance the operator was shown |
| `run.blocked` | panel | A guard refused the dispatch | `blocked` | blocked reason, prior state, in-panel guidance offered |
| `run.dead-lettered` | service | The requeue budget is exhausted, or the operator parked it | `dead-lettered` | attempts consumed, reason |
| `agent.verified` | panel | The post-dispatch read-back matches a **configured** baseline | `verified` | session identifier, observed agent, expected agent |
| `agent.mismatch` | panel | A **configured** baseline is compared and differs, or the read-back is unreadable or times out **against one** | `warn` | session identifier, observed agent or null, expected agent, note |
| `agent.uncompared` | panel | The read-back ran against **no configured baseline** (002 FR-029 case (ii)): the agent was observed — or could not be read — and **never compared** | `observed` | session identifier, observed agent or null, expected agent (**empty**), baseline provenance (`defaulted` \| `unset`), note |

Prefixed identically (`dispatch.` / `run.` / `agent.`) so an operator reading a log can tell dispatch-lifecycle rows from scan, credential, and consent rows at a glance. Rows outside this vocabulary (`consent`, `account.*`, `delivery.recovered`, poll, checkpoint, observation) are unchanged and keep their own identifiers (FR-052).

**No row in this table gained a new *type* at v1.8.0.** The allow-list gate reuses the `dispatch.refused` row the refusal contract already defines (see `contracts/dispatch-authorization.md` §9) and adds **no** `eventType`; what it adds is one **value-free detail** on two existing rows (`actorPolicy`), and one declared `blocked:` cause for the state the run is then parked in. A vocabulary *row* is a compatibility surface (`AGENTS.md` invariant 10) and two of this feature's predecessors have already paid that tax once (`binding.prompt-updated` at 003 v1.1.0, `agent.uncompared` at 003 v1.7.0); neither an additive detail key nor a reuse of an existing refusal row is that tax.

**The gate's refusals do not name the policy, and the `dispatch.refused` row it writes names the *decision*.** `actorPolicy` answers "was this repository restricted at the moment of the dispatch?" in two words; the row additionally names **every denied login and its attribution basis**, because a refusal a reader cannot attribute is not an explainable refusal (FR-077). The permitted logins themselves are named **nowhere** in the trail — see FR-079 for why a retained access policy is a liability rather than an audit aid.

**Which of the three `agent.*` rows is written depends on whether a comparison was possible, never on whether an agent was seen**: a blank baseline answers `agent.uncompared` even when the read-back itself failed (timeout or an unopenable session), because with nothing to compare against there is still no mismatch — `observedAgent: null` and the `note` carry that half of the truth. `agent.mismatch` is reachable only where a `configured` baseline exists to differ from.

## Wire Surface Delta

The following panel↔service operations change or are added. Exact field names, status codes, and error-code additions are finalized in Phase 4's contract work; the **semantics below are fixed by this specification** and are what Phase 4 designs against.

| Operation | Current surface | Change |
| --- | --- | --- |
| Claim | `GET /v1/events/pending` — claims queued event rows | Claims **runs**, with their source-reference lists, lease, attempt, and attachment identifier. Only runs in `pending` are ever offered (FR-037). |
| Reserve | *(new)* | The panel declares intent to start a session; the service durably records the reservation and returns the single-use dispatch token and its expiry. Refuses stale, already-reserved, and already-dispatched with distinct reasons (FR-021, FR-022), **and refuses with `409 actor-not-allowed` when no source reference on the run names an actor the binding's allow-list allows (v1.8.0, FR-076 – FR-078)**. The refusal writes the run's **single** `dispatch.refused` row and nothing else — no reservation, no token, no state change — after which the panel reports the run as `blocked:actor-not-allowed` through the existing Block-report operation. **v1.9.0** adds one **value-free** envelope member to that one refusal — `referenceWindow`, a closed pair (`complete` \| `truncated`), absent on every other code and never defaulted — so the panel can tell a complete judgement from a partial one without parsing the message (FR-078). |
| Result | `POST /v1/events/:id/dispatched` — `{ sessionId \| problem }` | Addressed by the run, not the delivery; the body carries the token and attempt. Idempotent for a repeated identical report (audited as a duplicate), refused as stale for a superseded lease or token (FR-022, FR-031). |
| Abandon | *(new)* | The panel reports that a reserved attempt created no session; the run becomes `failed` and retryable (FR-026). |
| Retry | `POST /v1/events/:id/retry` | Also valid from `failed` and from `blocked:*` once the cause clears; refused with distinct reasons from `pending`, `dispatched`, and `unconfirmed` (FR-041). |
| Resolve | *(new)* | The operator resolves an `unconfirmed` run in one of two explicit ways; operator-confirmed only, audited, never automatic (FR-027). |
| Run history | `GET /v1/events` — every event, any state | Projects runs: state, correlation identifier, run key, ordinal, attempt, source-reference list, attachment identifier, target project and worktree option, lease expiry, session reference, verification outcome, and the reason for the current state. Credential-free. Rows written before this feature continue to project (FR-005). |
| Audit read | *(new; 002's contract already specifies it)* | Serves audit rows with correlation-identifier filtering so a run's history is retrievable in-product (FR-053, FR-064). |
| Status | `GET /v1/status` | **Unchanged.** 003 does not touch the status projection; the hardcoded polling block remains 005's work. Run-level truth is carried by the run history and the audit read. |

The `GET /v1/dispatches` long-poll with leases described in 002's contract §2.4 was not built in the MVP cut and is **not** built here. The lease semantics 003 requires are implemented over the existing claim-and-report shape. 002's contract §2.4 is superseded by this table in Phase 4.

## Non-Functional Requirements

- **NFR-101 Detection latency preserved**: the reservation step MUST NOT add more than one additional panel↔service round trip per dispatch, and p95 detection-to-session latency MUST stay within 002 NFR-001's bound (≤ 2 × the poll interval). Adding the run layer and the authorization step MUST NOT move that number.
- **NFR-102 Idempotency, strengthened**: replaying any repository window 100 times MUST produce zero duplicate runs, zero duplicate sessions, and zero duplicate external side effects; and the enumerated crash permutations — close before claim, close after claim, close after authorization, report lost, report duplicated, report stale, panel slow, service restarted, panel storage wiped, operator retry — MUST collectively produce **zero** second sessions. The permutation set MUST be an automated test, not a manual check.
- **NFR-103 Durability across upgrade**: an operator upgrading from the shipped build MUST retain every queued row, every waiting and stranded event, and every audit row, with no file quarantined and no binding's scan window reset. Adoption into runs is recorded exactly once per row.
- **NFR-104 Fail-closed**: every ambiguous or unresolved condition — unknown lease, superseded token, lost result, unwritable audit trail, ambiguous subject — MUST block or park rather than proceed, naming the exact cause (constitution II).
- **NFR-105 Observability**: one correlation identifier MUST trace source observation, delivery, run, claim, authorization, dispatch, verification, and terminal state, identically in the panel and in the audit trail; 100% of state transitions MUST carry an audit row naming prior state, new state, and reason.
- **NFR-106 Secret containment**: zero occurrences of any credential in the expanded run record, the expanded source-reference list, the new audit rows, the run history projection, the audit read, or any rendered surface — verified by the existing automated scan suites, which this feature MUST NOT weaken.
- **NFR-107 Bounded growth**: the run record, its source-reference list, its attempt history, and its lease state MUST be bounded. The supported scale (fewer than ten repositories, one service instance) MUST NOT produce unbounded file growth over an operator's normal working lifetime, and the bounded history surfaces MUST keep the same shape as today.
- **NFR-108 No silent wedge**: no run may remain in a state the operator cannot see or cannot act on. Every non-terminal state MUST be visible on the run row with a reason, and every non-terminal state MUST have at least one operator-reachable action that changes it.
- **NFR-109 Rendering safety**: every new service-supplied field — source references, correlation identifier, run key, attachment identifier, state reason, prerequisite text — MUST be rendered through the same non-HTML path as every existing service-supplied string. A hostile issue title, comment body, or repository name MUST NOT be able to execute in the panel (002 contract §4, invariant 11).
- **NFR-110 Compatibility**: the OpenChamber SDK pin is unchanged and the host's minimum engine floor is unchanged. This feature MUST NOT require any host capability, API, or permission that 002 does not already require, and MUST NOT reach for an undocumented or private API.
- **NFR-111 Maintainability**: strict typing and linting with zero suppressions, as everywhere in this repository (`AGENTS.md`). The run/delivery/lease/token boundary is a contract boundary with contract tests; a future webhook adapter or a future provider adds a trigger without changing run, lease, or dispatch semantics.
- **NFR-112 Clock discipline**: every lease comparison, expiry, and deadline decision uses the service's own clock. The panel's clock MUST NOT participate in any lease decision, so clock skew between the two can never cause or prevent a re-dispatch.
- **NFR-113 No policy in the trail** (added at v1.8.0): the audit trail, the run record, the run history projection, and the panel's persisted dispatch record MUST record the **shape** of the actor policy in force — `open` or `restricted` — and MUST NOT record **which logins** the policy allows, on any row, at any level of detail, in any projection, or in either committed bundle. The one exception is a **refusal**, which names every *denied* login (FR-077): a denial is an event, the permitted set is configuration, and the permitted set's home is `bindings.json`. Verified by a scan over every audit-writing path in the build, in the same shape as the standing `dtk-` scan this document already requires.
- **NFR-114 The gate costs nothing on the happy path** (added at v1.8.0; **amended 2026-10-03**, see changelog.md → `### v1.8.0 — 2026-10-03`): evaluating the allow-list MUST NOT add a panel↔service round trip or a network call of any kind. It **does** add one **local** store read — `bindings.json`, inside the same chain task, immediately before the token is derived — because the authorization path reads `config.json` and no bindings document, so reading the live policy *is* an additional read and this requirement no longer claims otherwise. What the additional read costs is bounded by dispatch rate rather than by request rate, it is off the hot path relative to the multi-minute `host.startSession()` that follows, and it buys a policy that is live at the moment of authorization with no cache and no re-scan (plan D13). The single extra round trip a **refused** dispatch costs is the block report the panel owes for every guard, and it is not on any authorized path. p95 detection-to-session latency is therefore unchanged from NFR-101's and NFR-110's measured baseline, and a refused dispatch still leaves the run in a named, operator-actionable state well inside the lease duration.

## Success Criteria

### Measurable Outcomes

- **SC-101**: Across 100 trials of an issue carrying two or more simultaneous triggers under one account, the system produces exactly one session every time, and every resulting run names every trigger that fired.
- **SC-102**: Across the full enumerated crash-permutation set, the system produces exactly zero second sessions for a run that already has one, measured by the number of sessions created for each run identifier.
- **SC-103**: 100% of dispatches produce a terminal run state within the configured lease duration plus one poll interval, or a visible state that names what is waiting on whom. No dispatch is ever left with no explanation.
- **SC-104**: 100% of run state transitions are reconstructable from the audit trail using only the run's correlation identifier, with prior state, new state, and reason present on every row.
- **SC-105**: An operator can reconstruct any run's complete history — why it was created, who dispatched it, whether a session exists, what the agent was, and why it ended where it did — in under 2 minutes, without file access.
- **SC-106**: Automated scans of every new persisted record, log, audit row, and rendered surface find zero credential occurrences.
- **SC-107**: An operator whose target project is missing from the picker finds the remediation guidance in the panel, in the picker, without leaving the panel or reading documentation.
- **SC-108**: An operator setting up for the first time can satisfy all setup prerequisites using only the panel's prerequisites section, with no unmet prerequisite displayed as satisfied.
- **SC-109**: Closing and reopening the panel during outstanding work results in every affected run reaching a terminal state or a named unresolved state; zero runs are silently dropped.
- **SC-110**: p95 detection-to-session latency is unchanged from 002's measured baseline; the authorization step adds at most one additional round trip.
- **SC-111**: An operator upgrading from the previous build loses no queued work, no stranded event, and no audit history; zero scan windows are reset and zero files are quarantined by the upgrade.
- **SC-112** (added at v1.8.0): For any dispatch an operator inspects, the audit trail alone answers three questions without opening a file and without the policy leaking: **who was attributed**, **on what basis**, and **whether the repository was restricted when it was authorized** — while never recording which logins were permitted. For any dispatch that was refused by the gate, the trail additionally names every denied login and its basis, and the run is in a state the operator can act on.

## Acceptance Criteria

> **`AC-` numbering hygiene (repository-wide).** Acceptance-criterion numbers are **not** unique across specifications: 004 owns an unrelated `AC-130` – `AC-151` and 006 owns an unrelated `AC-101` – `AC-155`. The requirements added at v1.8.0 therefore carry an explicit **`003 ` prefix** — `003 AC-130` and so on — so a citation can never be read against the wrong document. Earlier 003 criteria (`AC-101` – `AC-129`) keep their existing unprefixed spelling for continuity; the prefix is added on new work and is not retrofitted, because retro-fitting would silently change citations other documents already quote.

- [ ] **AC-101**: One issue carrying an assignment and an issue-body mention, under one account, yields exactly one run, exactly one `host.startSession()` call, and one run row listing both triggers with their own kinds, origins, links, and detection times; a trigger detected in a later scan joins the same run and is recorded as such.
- [ ] **AC-102**: A follow-up comment mentioning the account after the first run reached a terminal state produces a second, separately numbered run and a second session; neither run is presented as a duplicate of the other, and a reference that arrived after authorization is visibly marked.
- [ ] **AC-103**: A pull request that is both assigned to and review-requested from the bound account yields one run, one session, and two source references.
- [ ] **AC-104**: Delivery identifiers are byte-identical to the previous release's format for the same observations, and a body mention re-detected on a later scan creates neither a new run nor a new delivery.
- [ ] **AC-105**: The bounded untrusted excerpt passed to `host.startSession()` on a coalesced run contains every source reference, stays within the per-item and per-dispatch bounds, shows explicit truncation markers, and a hostile reference body cannot alter policy, credentials, approval requirements, or tool scope.
- [ ] **AC-106**: Closing the panel after a claim and before authorization results, with no operator action, in the run returning to waiting after the lease expires, an incremented attempt count, and an audit row naming the prior state, the new state, the attempt before and after, and the reason.
- [ ] **AC-107**: Closing the panel after authorization and before the result results, with no operator action, in the run becoming `unconfirmed`, never returning to waiting, never being dispatched again, and never expiring out of that state on its own.
- [ ] **AC-108**: Closing the panel while events are merely waiting consumes no attempt, triggers no requeue, and no dead-lettering; reopening dispatches them normally.
- [ ] **AC-109** *(stale authorization)*: A late authorization or result carrying an expired, superseded, or consumed lease is refused with a distinct reason, the panel starts no session after the refusal, an audit row records the refusal, and a second panel holding a live lease is unaffected.
- [ ] **AC-110**: Under every permutation of the crash set — close before claim, close after claim, close after authorization, lost result, duplicated result, stale result, slow panel, service restart, panel storage wipe, operator retry — the total number of sessions created for a given run identifier is never greater than one, except where the operator explicitly chose *created no session*.
- [ ] **AC-111**: On remount, the panel reports its outstanding dispatch attempts before issuing its first claim; a repeated reconciliation changes no state and adds exactly one audit row recording the repeat; a bounded reconciliation failure surfaces as a visible warning rather than a silent skip.
- [ ] **AC-112**: A request to dispatch a run that already has a recorded session is refused, the refusal names the existing session, and an audit row records it; a run already holding a live authorization cannot obtain a second one.
- [ ] **AC-113**: A dispatch that produced no session is recorded as failed with its cause, is never labelled or toned as a success anywhere in the panel, and an operator retry returns it to waiting under the same run key with an incremented attempt and an audit row, preserving the source references and prior attempts.
- [ ] **AC-114**: A run whose binding was deleted is held in a blocked state naming the missing binding, is never recorded as dispatched, and becomes retryable if the binding is restored; a run whose project is unregistered is held in the recoverable project-missing state with in-panel guidance and no project is ever created.
- [ ] **AC-115**: Every state transition in `## Dispatch State Model` writes an audit row naming prior state, new state, actor, and reason; a sample of every vocabulary entry in `## Audit Vocabulary` is present in a captured trail with its required `details`.
- [ ] **AC-116**: Every dispatch-lifecycle audit row carries the run's correlation identifier, which is byte-identical to the correlation identifier on the panel's ledger entries, the delivery, the reservation, and the verification report for the same run; no dispatch-lifecycle row carries a freshly generated identifier.
- **AC-117**: A run's full audit history is retrievable through the product by correlation identifier alone, credential-free, and reconstructs the run's timeline without file access.
- **AC-118**: Rows describing polls, checkpoints, consent, and credential verification carry their own identifiers and additionally reference the delivery identifiers they concern; a single source observation is traceable forwards into the run that absorbed it.
- **AC-119**: A simulated audit-write failure during the dispatch lifecycle does not roll back the durable state change, does surface a visible warning naming the run, and appears in the service's structured log.
- **AC-120**: Automated scans of the new run records, source references, audit rows, run history projection, audit read, and rendered surfaces find zero credential occurrences; no new HTML rendering sink exists on any new field.
- **AC-121**: The project picker offers an explicit "not listed?" affordance naming the command palette, sidebar **+**, and folder browser routes; the binding stays recoverable; no project-creation call exists anywhere in the codebase.
- **AC-122**: A fresh install shows a prerequisites section covering all six prerequisites, each with a state and a remediation line; a prerequisite the panel cannot check — the Default Agent pin — is presented as not checkable rather than as met; an unmet checkable prerequisite also appears as a visible notice in the panel.
- **AC-123**: Every state in `## Dispatch State Model`, including `unconfirmed` and `dead-lettered`, renders in the panel's run list with an operator-readable label and a reason, and every non-terminal state has at least one operator-reachable action that changes it.
- **AC-124**: A `host.startSession()` call carries the resolved project, the configured worktree option, the attachment identifier, the run's correlation identifier, and a bounded delimited excerpt; the attachment identifier is derived from the correlation identifier and is displayed on the run row.
- **AC-125**: Agent verification is audited, visible on the run row with the observed and expected agents, and warn-only: a mismatch shows a warning, does not block the run, and receives no further automated handling. A read-back taken against **no configured baseline** is audited as `agent.uncompared` — carrying the observed agent (or `null`), the empty baseline, and the baseline's provenance — and **never** as `agent.mismatch`, while a configured baseline that differs still writes `agent.mismatch` exactly as before.
- **AC-126**: Upgrading a store written by the previous release retains every row and every audit entry, quarantines no file, resets no binding's scan window, records one adoption row per adopted run, and renders every pre-existing row in the run history; a pre-existing `dispatched` row whose result was a problem renders as failed and is retryable.
- **AC-127**: p95 detection-to-session latency is unchanged from the previous release's measured baseline, with at most one additional round trip per dispatch.
- **AC-128**: A captured trace across the whole feature shows no GitHub write of any kind from the panel or the service; no marker, reaction, comment, or label is introduced as a deduplication or recovery mechanism.
- **AC-129**: A run, a lease, and a token each stay within their documented bounds over an operator's normal working lifetime; the bounded history surfaces keep their existing shape and cap.
- **003 AC-130** *(gate placement and refusal)*: Given a binding whose `allowedUsers` is `['alice']`, when a panel reserves a run whose only source reference is attributed to `bob`, then the reserve answers `409` with code `actor-not-allowed`, **no** `dispatch.reserved` row exists, **no** token was minted, the run document is byte-identical to what it was before the call, and exactly one `dispatch.refused` row exists carrying the operation, code, prior state, attempt, binding id, `actorPolicy: 'restricted'`, `bob`, and `bob`'s attribution basis; and the panel calls no `host.startSession()` afterwards. The same call on a run already carrying a session still answers `already-dispatched` and names the session, and one carrying a stale lease still answers `stale-lease`. **What the containment scan proves here is stated as NFR-113 does — the *configured set as configuration* never leaks**, not "no permitted login appears in the run record": AC-133's coalesced case below requires a run to carry **both** a permitted and a denied actor on its row, so the two criteria are disjoint rather than exclusive. The scan's fixture is built on that disjointness — its permitted login is chosen **absent** from the run's recorded actors, and it asserts the permitted value *is* present in `bindings.json`, so a passing scan cannot be the empty-set vacuous case — and it scans every audit-writing path, the projection, the audit read, and both bundles for the configured value. The run record's own actor members are the ones NFR-113's exception covers: they are a *denial or an attribution of work that happened*, not a copy of who may trigger.
- **003 AC-131** *(blocking, not burning)*: After an `actor-not-allowed` refusal the run is reported as `blocked:actor-not-allowed` through the existing block report, consumes **no** attempt and **no** requeue budget, is never touched by the lease-expiry sweep, and its row names the denied login. With the policy unchanged, an operator retry is refused with its own distinct reason and does not dispatch. With the denied login added to the binding, the same retry succeeds, produces exactly one session, and the `dispatch.retry` row names the cause reported cleared.
- **003 AC-132** *(open vs restricted, and no policy in the trail)*: Given a binding with **no** `allowedUsers`, a reserve for any human-attributed run succeeds and both `dispatch.reserved` and `dispatch.result` carry `actorPolicy: 'open'`; given a populated list, both carry `actorPolicy: 'restricted'`. Scanning every audit row the build can write, the run record, the run-history projection, the audit read, and both committed bundles finds **no** permitted login anywhere — only the shape — while the gate's own refusal row still names every **denied** login. A hand-edited run carrying an empty or bot-shaped actor is refused, never admitted.
- **003 AC-133** *(coalesced run, and the cost)*: Given one open run carrying three source references attributed to `bob`, `carol`, and `alice` and a list of `['alice']`, the reserve **succeeds** — the authorization needs one allowed reference, not all of them — and the run records `actorPolicy: 'restricted'` with all three actors and their bases visible on the row; given the same run with all three outside the list, the reserve is refused and the row names all three. With the list left absent, p95 detection-to-session latency is unchanged from the measured baseline, and the authorized path adds no round trip beyond the reserve that was already there.

## Out of Scope

The following are explicitly **not** part of this feature:

- **Any GitHub write**, in any role, including as an idempotency or recovery mechanism (002 FR-031 stands; FR-002 restates it).
- **Status projection honesty** — the hardcoded `paused: true` / `nextPollAt: null` in the status projection — which belongs to 005's Status tab. 003 does not modify the status projection at all.
- **Runs-list interval cadence and the per-row retry affordance**, which belong to 005's Dispatches tab. 003 makes the underlying states and transitions correct and reachable through the existing select-then-act idiom; 005 makes them discoverable and pleasant.
- **The information-architecture rename** — Runs → Dispatches, Repositories → Bindings — across copy, service route names, and tests, which lands in 005.
- **The per-binding starting prompt** (feature 004).
- **Settings CRUD and live-apply** (feature 006).
- **Policy profiles**, per-action autonomy toggles with real gates, approval workflows, and the `waiting_approval` state — 002 FR-027's gates remain documentation-only; this feature neither adds nor exercises them.
- **Promoting agent verification from warn-only to blocking** — 002's recorded v1.1.0 deviation stands; the service-side mirror of the verification outcome is backlog.
- **Retention and export/restore** of configuration or audit data.
- **Durable deduplication-index eviction** — the bounded history's eviction boundary remains a known gap (named in `### Edge Cases`), and closing it is backlog.
- **Multi-instance or cross-machine lease semantics**; a second service instance is not supported (FR-004).
- **Work completion tracking** — no signal tells the service an agent finished its work, so a `dispatched` run stays `dispatched`. 002's `completed` state is not reachable in this feature.
- **Automatic cleanup** of sessions, worktrees, or projects (manual only, 002 FR-040).
- **Any new host capability, API, or permission** (NFR-110).
- **Webhook ingress**, other providers, Docker packaging, hosted or multi-tenant operation.
- **Phase 4 plan, data model, contracts, and task breakdown, and Phase 6 implementation** — those are the architect's phases.
- **The actor identity and the `allowedUsers` field themselves** (v1.8.0) — 002 v1.11.0 owns both. This document consumes them and re-specifies neither.
- **Recording the permitted logins anywhere in the trail, a projection, or a bundle** (v1.8.0) — NFR-113. The permitted set's home is `bindings.json`; a copy in a retained, world-readable file is a liability, not an audit aid.
- **Any gate outside the authorization operation** (v1.8.0) — no second membership comparison in the panel, none in the poll loop, none in the claim. FR-076 states why, and the panel-side guard alternative is recorded as rejected in changelog.md.
- **A new audit event type for the gate** (v1.8.0) — the refusal reuses `dispatch.refused`; the *shape* of the policy rides as a detail on two existing rows. Adding a row for this would pay the `AGENTS.md` invariant 10 compatibility tax again for no new information.
- **Allowing a bot, in this gate or anywhere else** (v1.8.0) — FR-080.
- **A team-, organisation-, or role-based actor rule** (anything but a flat list of logins on one binding), and **per-actor priority, rate, or quota** — a login list is what GitHub's data supports without a second API and a second identity model.
- **Any migration or legacy-projection default for a run stored before `actorLogin` existed** (v1.8.0) — nothing has been released (002 v1.11.0, `## Clarifications`; zero tags, `version` 0.0.1), and the product owner ruled it directly: *"there are no migrations needed as we haven't released yet."* A record without an actor is **refused** by FR-080, never defaulted.

## Assumptions

Each assumption below is a documented default chosen where the feature description and 002's text were silent. Each is a candidate for the phase gate, and each is reversible without a redesign.

- **Lease duration**: 120 seconds by default, configurable within 30–600 seconds. Chosen to exceed the worst-case dispatch comfortably while bounding how long a crashed panel strands work. A dispatch result MUST be reported before the lease expires (FR-031).
- **Result deadline**: 120 seconds by default, configurable within 30–600 seconds, and independent of the lease duration. This is the window between authorization and result; passing it moves the run to `unconfirmed` (FR-023).
- **Maximum automatic requeues**: 3. Chosen because a requeue is only consumed by an actual claim that then expired, so a panel that is merely closed never burns the budget. Confirmed by the product owner 2026-09-28 (`## Resolved Gate Questions`).
- **A closed panel is not a fault**: a panel that is closed while events are waiting is normal operator behaviour and must not consume attempts, requeue, or dead-letter (FR-036). Assumption: the operator understands that unattended dispatch requires the panel mounted.
- **A follow-up trigger after a terminal run opens a new run**: a new comment mentioning the account after the first run finished deserves its own session, numbered as a new ordinal. The alternative — never more than one session per subject, ever — was considered and rejected by the product owner on 2026-09-28 (`## Resolved Gate Questions`).
- **A trigger arriving while a run is open is joined to it, not dispatched separately**: the agent working that issue reads the issue, so the new comment is naturally in front of it; starting a competing session on the same issue would be the very defect this feature removes. Such references are marked as not necessarily seen when they arrive after authorization (FR-015).
- **Delivery identifiers are unchanged**: the deterministic delivery identifier remains the delivery-layer dedupe key and path segment (FR-012). Changing its format would break correlation with existing panel ledgers and audit rows and would gain nothing.
- **The run's correlation identifier is a deterministic hash of its run key**: this makes it re-derivable by the service, which is what makes reconciliation and attach-identity checks possible, and it matches the attachment-identifier convention 001's contract already established. The run key itself remains human-readable and is displayed alongside it.
- **The panel's local dispatch record is the reconciliation source**: the panel persists each attempt durably (FR-024) and reconciles from that record on mount. If the operator's host storage is wiped or the extension is reinstalled, the truth is unrecoverable by the panel and the run is resolved by the operator (FR-027). This is the honest consequence of the host providing no session-listing surface the extension may rely on (NFR-110).
- **The host offers no dependable session enumeration**: reconciliation therefore never attempts to discover a session by listing; it uses the panel's own record, and operator resolution uses the run's displayed project, worktree option, and attachment identifier.
- **M9 remains warn-only**: a verification mismatch shows a warning and is audited; it does not block the run and receives no further automated handling (FR-043).
- **Scale**: fewer than ten bound repositories, a handful of accounts, one local OpenChamber installation, one logical service instance, one operator machine. Concurrency correctness is required across panels mounting the same extension, not across service instances.
- **Provider**: GitHub.com REST API; GitHub Enterprise compatibility is unchanged from 002 and still requires later review.
- **The prerequisites surface is read-only**: it reports state and remediation; it does not configure anything, and it never offers to change the host's Default Agent setting, which the extension cannot read or write.

## Clarifications

### Phase 3 record — 2026-09-28

This specification was produced in phases 1–3 with the constitution (v1.3.0), feature 002 (v1.1.0/v1.2.0), and `pm-handoff.md` as the inputs. No clarification marker remains anywhere in this document. Every decision below is encoded in a numbered requirement. Rows 17–19 were added after the phase gate: they record the product owner's confirmation of the three defaults in `## Resolved Gate Questions`. A confirmation is not a new decision — each one is already the encoded requirement, and none of the three changed a requirement's text.

| # | Question | Answer | Encoded in |
| --- | --- | --- | --- |
| 1 | Dual trigger on one subject — collapse to one run, or keep two runs and warn? | Collapse to one run under a deterministic run key; both source references are preserved on the run and shown to the operator; one session. | FR-010, FR-011, FR-013, FR-015 |
| 2 | What identifies a run when a subject can legitimately be worked more than once? | The run key carries a **run ordinal** — the count of already-terminal runs for that subject. A delivery joins the open run; a delivery arriving after a terminal state opens the next ordinal. | FR-010, FR-011, `### Edge Cases` |
| 3 | Does the delivery identifier change? | No. It stays the delivery-layer dedupe key and path segment, byte-identical to the shipped format; the run key is a separate, additional identifier. | FR-012 |
| 4 | What reclaims work stranded by a panel that closed mid-dispatch? | A bounded lease. Expiry — and only expiry — requeues a run that had made no authorization, incrementing the attempt count and auditing the reason. | FR-030, FR-031, FR-032, FR-033 |
| 5 | When may the panel clear a per-mount handled identifier? | Only when the run is terminal, or when the service hands the same run back under a **new** lease and attempt. A failed report alone never clears it and never authorizes a re-dispatch. The list is a duplicate-suppression convenience, never durability. | FR-034 |
| 6 | How does the panel distinguish "dispatched but unreported" from "never dispatched"? | It does not have to: the panel records the outcome durably *before* reporting it, and reconciles every outstanding attempt on mount before it claims anything. The service, which cannot know, moves a reserved run with no result to `unconfirmed` and refuses to dispatch it again. | FR-023, FR-024, FR-025, FR-026 |
| 7 | What makes a second session impossible rather than unlikely? | A session may be created only for a run that is claimed, holds a valid unconsumed token, whose lease has not expired, whose attempt is current, and which has no recorded session. Everything else is refused before the host is called. | FR-028, FR-022, FR-037 |
| 8 | What if the panel's own record is lost while a run is unconfirmed? | No re-dispatch, ever. The operator resolves the run in one of two explicit ways, after checking OpenChamber's own session list using the run's displayed project, worktree option, and attachment identifier. | FR-027, FR-029 |
| 9 | Which identifier is the correlation id, and what happens to it across the boundary? | The run's deterministic hash of its run key. The service mints it once; the panel echoes it and never substitutes one. Every hop carries it; every dispatch-lifecycle audit row carries it instead of a fresh uuid. | FR-050, FR-051, FR-052, FR-062 |
| 10 | Which dispatch-lifecycle transitions must be audited? | The full set in `## Audit Vocabulary`: run creation, coalescing, migration, claim, reservation, result, duplicate report, abandonment, lease expiry, unconfirmed, operator retry, operator resolution, blocking, dead-lettering, and all three verification outcomes (`agent.verified`, `agent.mismatch`, `agent.uncompared`). | FR-060, FR-061, FR-062 |
| 11 | How does the operator read a run's history? | Through the product, by correlation identifier, via the audit read 002's contract already specifies and 003 implements. | FR-053, FR-064 |
| 12 | Is a dispatch that made no session recorded as dispatched? | No. It is a distinct failed state with its cause, never toned as a success, and it is retryable under the same run key. | FR-040, FR-041 |
| 13 | Does agent verification become blocking in this cycle? | No. It becomes audited and visible, and stays warn-only. 002's recorded v1.1.0 deviation stands. | FR-043, `## Out of Scope` |
| 14 | Do the two small gaps (picker guidance, prerequisites section) belong here? | Yes, as self-contained requirements closing 002's FR-014 and FR-038, including the honesty rule that a prerequisite the panel cannot check is presented as not checkable. | FR-070 – FR-073 |
| 15 | How is the 002 contradiction sequenced? | 003 supersedes the affected 002 requirements; 002 v1.2.0 records the supersession requirement by requirement and carries a banner under its header. 002's body is not rewritten, so the record of what shipped stays intact. | FR-001, 002 v1.2.0 changelog.md |
| 16 | Does anything here touch GitHub, the status projection, or the run list's presentation? | No. GitHub stays read-only; the status projection is untouched; the run list gains correct state labels and reasons but no restructuring, cadence, or per-row affordance. | FR-002, `## Out of Scope`, `## Wire Surface Delta` |
| 17 | Product-owner confirmation of the run-ordinal rule (Gate Question 1) | **Confirmed 2026-09-28** as encoded: a follow-up trigger after a terminal run opens a new, separately numbered run and a second session, instead of being suppressed as a duplicate. The alternative considered and rejected was *one session per subject, ever*, which would leave a follow-up comment permanently unanswered. No requirement text changed — this confirms FR-010 and FR-011 as written. | FR-010, FR-011, AC-102, `## Resolved Gate Questions` |
| 18 | Product-owner confirmation of how `unconfirmed` resolves (Gate Question 2) | **Confirmed 2026-09-28** as encoded: `unconfirmed` never auto-expires and is resolved only by panel reconciliation or an explicit operator decision. The alternative considered and rejected was time-bounded auto-resolution, which trades a fail-closed wedge for an unattended path that could start a second session. No requirement text changed — this confirms FR-023 and FR-027 as written. | FR-023, FR-027, AC-107, `## Resolved Gate Questions` |
| 19 | Product-owner confirmation of the automatic requeue budget (Gate Question 3) | **Confirmed 2026-09-28** as encoded at 3, with the explicit note that only an expired claim consumes the budget and a guard refusal never does, and that the value remains operator configuration. No requirement text changed — FR-032 and FR-036 already compose to exactly that rule, and FR-033 makes the bound explicit. | FR-032, FR-033, FR-036, AC-106, `## Resolved Gate Questions` |

### Phase 3 record — 2026-10-03 (the actor allow-list gate; GitHub issue #9)

This amendment was specified in phases 1–3 against the constitution (v1.3.0), the shipped build, 002 v1.11.0, and the product owner's intake for **GitHub issue #9**, whose scope decisions were fixed before specification: **the issue/PR author as a documented proxy** for assignment and review triggers; **fail-open but warn** with a discoverable absence; **exactly one repository per binding**; and **no migration**. This document contributes the **decision** only. No `[NEEDS CLARIFICATION]` marker remains anywhere in this document.

| # | Question | Answer | Encoded in |
| --- | --- | --- | --- |
| 20 | **Where is the gate** — in the poll loop's trigger scan, or at authorization? | **At authorization, in `service/poll/dispatch-authorize.ts`**, inside the one chain task's decide → apply → record shape, after `judgeReserve` answers `null` and before any token is derived. A detection-time filter is cheaper and was the obvious choice; it is refused because it writes **no audit row**, so *"why was this not dispatched?"* has no answer — the exact defect 003 exists to end, repeated in a new place (constitution IV). Detection now only **records** the actor | FR-076, 002 FR-043 |
| 21 | **Should the panel pre-check the list, mirroring the existing `relay-gates.ts` guards?** | **No.** One membership comparison, in one place, owned by the service. A panel-side copy is a second implementation of the same rule, and a panel that can be talked into skipping its own check is not an enforcement point. The cost is one loopback round trip on a **refused** dispatch only — the block report the panel already owes for every guard — and **zero** on any authorized path (NFR-114) | FR-076, NFR-114, changelog.md |
| 22 | **What does the refusal leave behind, and where is the gate's verdict placed in `judgeReserve`'s order?** | **Nothing on the run** — no reservation, no token, no `dispatch.reserved` row — plus exactly one `dispatch.refused` row. The verdict runs **after** `judgeReserve` so every existing verdict stays reachable: a run already carrying a session still answers `already-dispatched` and names it (FR-022, AC-112), and a stale lease still answers `stale-lease`. A policy check placed first would make both unreachable on their natural path, which is the same mistake the §1 order note already records | FR-077, `003 AC-130` |
| 23 | **Which actor decides, on a run that coalesced several deliveries** (FR-011 joins an assignment, a comment, and a review onto one open run — three different people)? | **The authorization succeeds when *at least one* of the run's source references names an allowed actor.** Two rejected alternatives, both stated because they are the ones a reader will propose: *refuse if any* reference is disallowed — which is unrecoverable, because a blocked run **joins** new deliveries rather than opening a new ordinal (FR-011), so a disallowed user's comment would wedge every dispatch on that issue permanently and the operator's only remedy would be to allow the person the policy exists to exclude; and *judge only the opening reference* — which wedges for the same reason in the mirror case (a disallowed user's mention opens the run; an allowed user's later mention joins it and the run can never be authorized). The chosen rule never wedges, never authorizes a dispatch no allowed actor asked for, and stays explainable: every reference's actor and basis is on the row, so an unallowed person's later comment rides in **visibly** rather than silently | FR-077, `### Key Entities`, `003 AC-133` |
| 24 | **A refusal must not burn the operator's requeue budget** | The run is parked in a **fifth declared `blocked:` cause**, `blocked:actor-not-allowed`, through the **existing block-report operation** — no new route, no new method. A blocked run consumes no attempt and no budget, the sweep never touches it, and it is retryable once the cause clears (confirmed gate answer 3). Widening the declared cause set from four to five is deliberate and recorded in `## Dispatch State Model`, `data-model.md` §2.2, and contract §4, because a block report may only name a declared cause — a sixth would make the runs document unreadable to its own parser | FR-078, `003 AC-131` |
| 25 | **What does the audit trail record about the policy?** | The **shape only**: one required, **value-free** `actorPolicy` detail — `'open' \| 'restricted'` — on `dispatch.reserved` and `dispatch.result`, written from the same read that made the decision. **The permitted logins are recorded nowhere**: not in the trail, not in the run record, not in a projection, not in a bundle. A refusal **does** name every **denied** login with its attribution basis, because a denial is an event and a denial nobody can attribute is not explainable | FR-077, FR-079, NFR-113, `003 AC-132` |
| 26 | **Does this add an audit event type?** | **No.** A vocabulary row is a compatibility surface (`AGENTS.md` invariant 10), and this feature has already paid that tax twice (`binding.prompt-updated` at v1.1.0, `agent.uncompared` at v1.7.0). The gate **reuses** the `dispatch.refused` row the refusal contract already defines and adds one **detail key** to two existing rows. No row is renamed, removed, or re-worded | `## Audit Vocabulary`, FR-079, `## Out of Scope` |

## Resolved Gate Questions (all three confirmed by the product owner — 2026-09-28)

These three questions were raised at the phase gate as the places where this specification encoded a defensible default rather than escalating. The product owner reviewed all three on **2026-09-28 and confirmed every default as encoded**. **No requirement text changed as a result** — each confirmed answer is already the requirement (see `## Clarifications` rows 17–19). Each entry below states the confirmed answer first, then the question as originally posed, then the alternative that was considered and rejected, so a later reader can see what was weighed and why it was set aside.

1. **Confirmed: a follow-up trigger after a terminal run opens a new run and a second session.** The run key carries a `runOrdinal`, so a delivery that arrives after the subject's previous run reached a terminal state opens the next ordinal, and `@bot, one more thing` gets its own answer.
   - **Question as posed**: a new comment mentioning the bound account after issue `#4`'s first run finished — open a new run, or suppress it as a duplicate of work already done?
   - **Confirmed 2026-09-28** as encoded. **Rejected alternative**: *one session per subject, ever*, which would make a follow-up comment permanently unanswered.
   - **Encoded in**: FR-010, FR-011, AC-102, `### Edge Cases`.

2. **Confirmed: `unconfirmed` never auto-expires.** It is never re-dispatched, re-leased, or retried automatically, and resolves only through panel reconciliation or an explicit operator decision.
   - **Question as posed**: when a reservation exists and no result ever arrives, what — if anything — ends the `unconfirmed` state on its own?
   - **Confirmed 2026-09-28** as encoded. **Rejected alternative**: time-bounded auto-resolution, which would trade a fail-closed wedge — safe, visible, operator-resolvable — for an unattended path that could start a second session.
   - **Encoded in**: FR-023, FR-027, AC-107.

3. **Confirmed: the automatic requeue budget is 3.** Three automatic requeues per run, then dead-letter. Only an expired claim consumes one; a guard that refuses a dispatch does not.
   - **Question as posed**: how many automatic requeues may one run consume before it is dead-lettered?
   - **Confirmed 2026-09-28** as encoded at 3, with the explicit note that only an expired claim consumes the budget and a guard refusal never does. No alternative was recorded at the gate; the value is operator configuration, so it remains adjustable without a behavioural change.
   - **Encoded in**: FR-032, FR-033, FR-036, AC-106.

## Supersession Map

The authoritative text for each item is this specification. 002 v1.2.0's changelog.md records the same mapping from the other side.

| 002 v1.1.0 requirement | Status after 002 v1.2.0 | Authoritative text |
| --- | --- | --- |
| FR-014 (project-picker "not listed?" guidance) | **Restated in place; conformance gap closed by** | 003 FR-070 |
| FR-030 (deterministic run key; dispatch idempotency) | **Superseded** — the shipped queue has no run key and dedupes on the delivery id alone | 003 FR-010 – FR-013, FR-020 – FR-028 |
| FR-035 (audit trail completeness) | **Superseded in part** — the shipped trail omits the whole dispatch lifecycle and mints a fresh correlation id per row | 003 FR-060 – FR-065 |
| FR-037 (non-looping crash response, manual replay) | **Superseded in part** — the shipped claim is a bare state flip with no lease and no requeue | 003 FR-030 – FR-037 |
| FR-038 (documented setup prerequisites) | **Restated in place; conformance gap closed by** — the content exists only in the quickstart, never in the panel | 003 FR-071 – FR-073 |
| NFR-002 (idempotency) | **Superseded in part** — re-play idempotency holds; crash and lost-report permutations do not | 003 NFR-102, SC-102, AC-110 |
| NFR-006 (durability) | **Superseded in part** — a claimed event stranded by a closed panel is never recovered | 003 NFR-103, FR-032, FR-036 |
| NFR-007 (one correlation id end to end) | **Superseded in part** — audit rows carry a fresh uuid while the ledger carries the event id | 003 FR-050 – FR-054, NFR-105 |
| Edge case "Same issue reached by two triggers" | **Superseded** — the shipped queue mints one event id per trigger and produces two sessions | 003 FR-011, FR-013, AC-101 |
| Everything else in 002 | Unchanged | 002 v1.2.0 |
