# Tasks: MVP — Agent Event Extension (re-cut 2026-09-27)

**Bar: "works reliably for me, self-hosted." Validate the loop live BEFORE hardening.**
Rules for this cut: build the missing product loop; tests only where they keep us honest about the loop working; no review waves; no remediation loops (debt list instead); existing hardened service code stays as-is — we do not remove or refactor it.

## What's already built (no tasks — do NOT re-touch)
- Service: spawn/HTTP/auth, durable store 0600/0700, account verify/persist/rotate, consent, throttles, status (T-003–T-009 + remediations, 429 tests green)
- Spike panel: polling, matching (assigned issues), evidence, dispatch to host.startSession + worktree options, project picker, lifecycle (proven live S1–S7)

## Slice 1 — Minimal working loop (validate TODAY)
- [x] **M1** Service minimal poll loop: poll bound repos' issues on interval (reuse existing github client), detect issue assignment to a bound account → enqueue event. Simple in-memory/file state; no checkpoint architecture. **(the main engine piece)** *(commit ad052da)*
- [x] **M2** Relay: panel long-poll (single endpoint ok) or simple interval fetch of pending events from service; lease optional (dedupe by event id is enough for one panel). *(commit ad052da)*
- [x] **M3** Repos tab: add repo (owner/name) → account picker → project picker → triggers checkboxes (assignment, mention) → enabled toggle. Panel storage. **(the missing UI piece)** *(commit ad052da)*
- [x] **M4** Wiring: panel receives event → dispatch (reuse spike dispatch + picker + worktree option + PM prompt) → mark event dispatched in service. *(commit ad052da)*
- [x] **M5** Live validation on operator's OpenChamber: create account, bind 1 repo w/ project, assign an issue, see PM session start in a worktree. Record what breaks. *(VALIDATED 2026-09-28: two issues → two worktree sessions; full loop live. Fixes during M5: repos pane mount, accounts assign, adopt-on-duplicate, scan status surface, events parser round-trip, first-scan replay (product decision).)*

## Slice 2 — Complete MVP (after slice 1 proves)
- [x] **M6** Mentions trigger (comment scan for `@<login>`, bot-author ignored) *(commit e966894)* — **extended 2026-09-28 (operator): an `@<login>` in an *issue body* triggers too (spec FR-015(c) → v1.1.0; id `…~mention~body`, rides the issue feed, no extra API call)**
- [x] **M7** Review-request trigger (PRs requested as reviewer for the account) *(commit e966894)*
- [x] **M8** Runs list UI (recent events, state, link to session) + manual "dispatch failed → retry" *(service side ready in e966894: `GET /v1/events` — all states, newest-detected-first, cap 100, credential-free — and `POST /v1/events/:id/retry`; UI still owed)* **Panel side shipped in `6af4c00`: a Runs section under the bindings list in the Repos pane. `runs-service.ts` reads the projection (fail-closed, sharing the claim parser's event readers), `runs-rows.ts` composes the rows (kind label · `#n title` · state badge · relative `detectedAt` · redacted `dispatchResult`), `runs.ts` does the IO — read on mount, on manual refresh, and after every dispatch report; select a row → **Open issue** (`host.openUrl`) or **Retry run** (`POST /v1/events/:id/retry` for `state !== 'dispatched'`, then re-read). Idle/loading/ready/empty/error each have their own copy; a 409 `invalid-transition` is explained in the service's own words (`servicePost` now surfaces the envelope code, the `serviceDelete` shape). MVP-DEBT: no interval cadence (mount/manual/post-dispatch only); a run the panel reported a problem for is `dispatched` and therefore terminal service-side — retry only requeues pending/in-flight claims.**
- [x] **M9** Agent verification after dispatch (openSession read-back → warn if not project-manager) — keep simple, no blocked-state machinery **Panel side shipped in `6af4c00`: `agent-verify.ts` subscribes `onSession` *before* `openSession` (the replay race), resolves the snapshot whose `id` matches within one 15 s budget that also bounds the openSession leg (an unanswered context switch cannot hold the relay's dispatch slot), and judges `snapshot.agent` against the `expected-agent` manifest setting — new integration setting, default `project-manager`, read in `config.parseExpectedAgent`, stored on `PanelState.expectedAgent` so legacy and bindings mode agree. Match → `agentVerified: true` on a `session` ledger entry + success banner; mismatch / absent / timeout / unopenable session → `agentVerified: false` + warning banner "dispatched, but the session agent was '<x>' (expected project-manager)". Warn-only: nothing is blocked or killed; a dispatch that created no session skips verification gracefully. MVP-DEBT: panel-side only — the service knows nothing about verification (mirror next slice).**

## Debt list (post-MVP hardening — do NOT do now)
From Wave-2 reviews (input-clear fix, mirror scopeCheck, copy drift, O(1) audit seq, projection reads, invariant-1 test gaps, hostile-DOM test, throttled rotation test, 502/reasonClass ratifications); checkpoint durability; rate budget controller; policy profiles; retention; export/restore; multi-account E2E polish; T-036 shared/redaction move; durable dedupe index (eviction boundary >500 dispatched); legacy/mvp dispatch unification; stale binding-row status on manual refresh; second-account "add account" affordance; **M8/M9 slice-2 additions:** service-side mirror of `agentVerified` (run row + health), verification running alongside the dispatch slot instead of inside it (bounded 15 s today), requeue path for a `dispatched` run whose dispatchResult is a problem (terminal service-side today), runs-list interval cadence (mount/manual/post-dispatch only), per-row retry affordance instead of select-then-retry (the SDK list has no per-row actions).

From the final pre-PR review (2026-09-28, recorded — do NOT fix now): **two triggers on one issue → two sessions** (no run-key collapse: the queue mints one event id per trigger kind, so assignment + mention on one issue enqueues two events and starts two sessions — this contradicts the spec's edge case *"Same issue reached by two triggers (assignment + mention): two deliveries with distinct delivery keys normalize to one deterministic run key → one run, both source references preserved"*, which expects a single run/session); **in-flight stranding when the panel closes mid-dispatch** (no auto-requeue of a claimed event); **retry-after-lost-dispatch-report can double-session** (a dispatch whose `POST /v1/events/:id/dispatched` never lands leaves the row `in-flight`; a manual **Retry run** returns it to `pending`, and the next claim after a remount — where the per-mount handled list starts empty — can start a second session for an event that already made one; the fix shape to evaluate is when the panel's handled-id entry may be cleared after a failed report); **service audit rows missing for dispatch / dispatch-result / retry / agent-verification** (FR-035) plus the correlation-id mismatch (`audit.ndjson` rows carry their own uuid while the panel ledger and event ids carry `eventId`); **first-run in-panel prerequisites copy** (the unconnected banner now points at Repositories → Poll as account, but the panel still ships no prerequisites section — FR-038 lives in the quickstart only); **"not listed?" project-picker guidance** (FR-014 — a project missing from the picker has no in-panel remediation line); **`/v1/status` polling fields always `paused`/`null`** (the status projection's polling block is unrendered and unconditionally idle).

## Stopped/cancelled
- Wave 2 remediation wave (T-009k–q) — partially done (k,l,m,n,o committed pre-interrupt), remainder folded into debt list above.
- Reviewer-per-wave cadence. Contract-amendment-on-every-deviation cadence.

---
---

# Issue #9 block — the per-repository actor allow-list (added 2026-10-03)

**This is the consolidated Phase-5 task list for GitHub issue #9**, spanning three amended
specifications. Everything above this line is the delivered MVP cut of 2026-09-27 and is
retained as written.

| Spec | Amendment | What it contributes | Tasks |
| --- | --- | --- | --- |
| `002-agent-event-extension` | **v1.11.0** | the **model** and the field's **validation** — `actorLogin` + `actorAttribution` on the normalized event, attribution mandatory for all four trigger kinds, `BindingRecord.allowedUsers` with its three states, `buildEventId` untouched | `A-1 … A-7` |
| `003-dispatch-integrity` | **v1.8.0** | the **gate** — the one membership comparison inside `service/poll/dispatch-authorize.ts`, the `409 actor-not-allowed` refusal, the fifth declared `blocked:` cause, the value-free `actorPolicy` audit detail, the retry re-check | `B-1 … B-7` |
| `005-panel-ia` | **v1.11.0** | the **rendering** — the editor field, the row count, the worded absent-policy warning, the Status count, the dispatch row's actor and basis | `C-1 … C-6` |
| `006-settings-crud` | **not amended, deliberately** | nothing — `allowedUsers` is per-binding and `GET /v1/config` describes one global document | — |

**Input**: [`plan.md`](./plan.md) §"Amendment record — 002 v1.11.0" ·
[`research.md`](./research.md) §R8–§R9 · [`data-model.md`](./data-model.md) (v1.11.0 rows) ·
[`contracts/events-carry-forward.md`](./contracts/events-carry-forward.md) §1.2 ·
[`contracts/binding-allow-list.md`](./contracts/binding-allow-list.md) ·
[`003/plan.md`](../003-dispatch-integrity/plan.md) (its 2026-10-03 block) ·
[`005/plan.md`](../005-panel-ia/plan.md) (its 2026-10-03 block).
`spec.md` is the source of truth in all three documents; **no requirement text was rewritten in
this phase and none may be rewritten during implementation.**

**Bar**: "an operator can restrict who may trigger a repository, with one field, in one save, and
can afterwards say in the panel's own words **who** a dispatch was attributed to and **on what
basis** — and the trail answers the same three questions without leaking which logins are
permitted." Tests are offline and deterministic per `AGENTS.md`: fake host
(`tests/support/panel.ts`), real loopback service on temp dirs (`tests/support/service.ts`), fixture
GitHub (`tests/support/github.ts`) — **no live OpenChamber, no real PAT, no network**. `[P]` =
parallel-safe (different files, no dependency). **`npm run verify` runs at every wave boundary, and
any wave that touches `src/`, `panel/*.ts`, or `service/*.ts` ends with `npm run build` and the
rebuilt `panel/main.js` + `service/main.js` committed in the same commit (invariant 1).**

### Why the consolidated list lives here (and it is a near-tie, said plainly)

The counts are **002 → 7, 003 → 7, 005 → 6**. The tiebreak, not the volume, put the list in 002:
002 is the **production spec** `AGENTS.md` names as the product's source of truth; its Wave 1
**strictly gates** Waves 2 and 3, so a reader (or an orchestrator) starts here; it owns the field and
the validator, which are the security boundary that has to exist before either of the other two
features' work means anything; and `pm-handoff.md` — the coordination artefact — already lives in
this directory. The per-spec `tasks.md` files for 003 and 005 each carry a **pointer block** naming
their own task ids with a one-line summary, so nobody has to hunt; **002's is the single source of
truth for the task text**.

### Settled decisions that bind execution (do NOT re-open)

1. **Coalesced runs**: 003 FR-011 lets one run carry deliveries from several people, and
   `blocked:*` runs are non-terminal so new deliveries **join** them. The authorization therefore
   succeeds when **at least one** source reference names an allowed actor. Both alternatives
   (`refuse if any is disallowed`; `judge only the opening reference`) permanently wedge runs, and
   the owner ratified the chosen rule at the gate on **2026-10-03**. `B-2` encodes it as one
   asserted predicate, not as prose.
2. **The Status surface stays** (005 FR-093): a per-binding `actorPolicy` member plus **one counted
   line**. Owner confirmed.
3. **No migration.** No shim, no fallback reader, no legacy default, no upgrade acceptance
   criterion. A stored binding without the key **is** the absent state; a stored run whose
   references carry no readable actor is **refused** (003 FR-080).
4. **One repository per binding, permanently.** The issue's three scenarios are **N bindings**.

### What's already built — do NOT re-touch

- **Detection**: `service/poll/{poller-github,poller-entries,triggers,loop,scan,window,timer}.ts`,
  `service/pipeline.ts` — the three feeds, the four trigger kinds, `buildEventId`, the bot filter's
  existing `isBotAuthor`, the mention token. This block **adds attribution** to them; it does not
  restructure the scan.
- **The queue and run layers**: `service/poll/{events,events-parse,events-write,runs*,run-*}.ts`,
  `dispatch-*.ts`, `run-chain.ts` — 003's model, leases, tokens, the sixteen-plus-one lifecycle
  vocabulary, `GET /v1/audit`, the run-history projection, the sweep.
- **Bindings**: `service/bindings.ts`, `service/bindings-read.ts`, `service/routes/bindings.ts` — the
  whole-file grant, the validator's `{binding} | {issues}` posture, 004's prompt-key merge.
- **Panel relay**: `src/relay.ts`, `src/relay-gates.ts`, `src/relay-attempt.ts`, `src/dispatch-record.ts`,
  `src/reconcile.ts`, `src/run-state.ts`, `src/claim-service.ts` — claim → guards → reserve → host
  call → record → report → verify.
- **Panel tabs**: `src/bindings*.ts`, `src/dispatches*.ts`, `src/status-*.ts`, `src/settings-*.ts` —
  the six-tab shell, the whole-file write, the state→affordance table, the Status projection's
  fail-closed parser.
- **Invariants**: delivery id format, evidence schema `extension-spike-1`, manifest ids/capabilities,
  SDK pin `1.24.2`, `SERVICE_VERSION` ↔ `package.json` (`0.0.1` — **no bump**), `SERVICE_SCHEMA_VERSION = 1`,
  every `mecha-turk:` storage key, the existing suite (stays green throughout).

### Out-of-scope guard (check before any task feels like "just one more")

No GitHub write of any kind (002 FR-031, 003 FR-002, 005 FR-002). **No enforcement of the list
outside `service/poll/dispatch-authorize.ts`** — a membership comparison anywhere else is a second
answer to the same question (003 FR-076, plan D9). No detection-time filtering of the allow-list:
detection records the actor and decides nothing. No audit **event type** (003 v1.8.0 reuses
`dispatch.refused` and adds one detail key — invariant 10 is a compatibility tax paid twice
already). No `FieldDescriptor` and no thirteenth config field (**006 is deliberately not
amended**). No per-binding `PATCH /v1/bindings/:bindingId` (MVP-DEBT, not reopened). No migration,
shim, fallback, or legacy default. No change to `buildEventId`, `SERVICE_SCHEMA_VERSION`,
`SERVICE_VERSION`, any storage key, any capability, any permission, or the SDK pin. No bot
admission, no plural or wildcard `repository`, no shared/reusable list object, no team- or
role-based rule, no per-actor rate or quota. No new host capability and no invented GitHub identity
picker (005 FR-004, FR-090).

---

## Wave 1 — 002's model and the field's validation (blocks every later wave)

**Goal**: every event carries an attributed actor and every binding carries a validated list.
Independent test (002 AC-024, AC-025, AC-026, AC-027): drive all four trigger kinds through the
fixture GitHub and read the enqueued rows; drive the bindings document through both paths and read
the refusals.

- [x] **A-1** [P] [002 FR-047, FR-024] **`service/bindings.ts`** — add `BindingRecord.allowedUsers?: readonly string[]`; add the fifth field reader `bindingAllowedUsersOf(raw)` returning `{ users } | { issue }`; wire it into `assembleBinding` (absent → key omitted) **and** into `parseBinding`'s collect-every-refusal second pass so a bad list and a bad repository arrive in one `422`; add and export **`isActorAllowed(login, allowedUsers)`** — the single membership comparison, case-insensitive, spelling-preserving (plan D5, D9). Refusals: not an array; `[]` (with a remediation naming **both** honest alternatives and that disabling the binding is how every trigger stops); an element that is not a GitHub login (research §R9: ≤39 chars, alphanumeric with single interior hyphens, no leading/trailing hyphen). **No list-length cap** (D6). **A `[bot]` login is accepted and inert** (D7). *Tests* (`tests/service-bindings.test.ts`): the three states; `['Alice','bob']` round-trips byte-identically and matches `alice`/`ALICE`/`Bob`; `[]` refused with a remediation naming both alternatives and **zero characters** of the submitted value; non-array and each bad element refused naming `allowedUsers`; every issue collected together; a hand-edited stored `[]` refused on read the same way; a pre-field document reads with **zero bytes rewritten**.

- [x] **A-2** [P] [002 FR-045] **`service/poll/poller-entries.ts`** — `PollPull` gains `authorLogin` and `authorType`, read from the pulls-list entry's `user` exactly as `readIssueEntry` and `readCommentEntry` read theirs (including the `''`-when-absent convention). **No new endpoint, no new request, no rate cost** — the field rides a response the scan already fetched. *Tests*: a pull entry with `user` yields both members; one without yields `''`/`''` (which is FR-045(b)'s "no event" case, not an empty actor); `type: 'Bot'` and a `[bot]` login are both readable so the existing predicate can judge them.

- [x] **A-3** [P] [002 FR-043, FR-046] **`service/poll/events-write.ts` + `service/poll/events-parse.ts`** — `BaseEventSnapshot` gains `actorLogin` + `actorAttribution` (the closed `'direct' | 'subject-author'` union, 002 FR-044); `createEvent` copies them onto the row beside `promptPresent`-style members; `QueuedEvent` gains `actorLogin?: string` and `actorAttribution?: ActorAttribution`, **both absentable on read** and **validated when present** — an unrecognized basis refuses the row rather than defaulting (plan D2, 002 FR-024). **`buildEventId` and `discriminatorOf` are untouched** (FR-046): `evt-<owner>~<repo>~<issueNumber>~<accountNumericUserId>` plus its existing discriminator. **No `schemaVersion` member is added** (plan D1) and `SERVICE_SCHEMA_VERSION` stays `1`. *Tests*: writer→reader round-trip on real bytes; both members accepted when present; an unknown `actorAttribution` refuses the row; a pre-1.2 row still parses with both absent and reads as *no attribution recorded*; **delivery ids byte-identical to the shipped format** for every fixture.

- [x] **A-4** [P] [002 FR-047, NFR-113] **The field's contract-proof suite** — create `tests/allow-list.test.ts` driving `service/bindings.ts` and `service/routes/bindings.ts` directly (temp-dir store, loopback service): every row of
  [`contracts/binding-allow-list.md`](./contracts/binding-allow-list.md) §5 as an assertion, including that **no permitted login appears** in any response, log line, or stored projection other than `bindings.json` itself, and that the route table gained **no** operation (`src/` contains no `PATCH /v1/bindings/` call). Needs A-1; assert-fail-first is the gate.

- [x] **A-5** [002 FR-043 – FR-045] **Attribution at detection** — `service/poll/triggers.ts`: rename the module-private `isMentionableAuthor` to **`isAttributableAuthor`** and **export** it (plan D3 — one predicate, four kinds, one exported surface); apply it on the **review** path too (`PollPull`); give every event builder its actor and basis — comment mention `direct`/comment author, issue-body mention `direct`/issue author, review `subject-author`/pull author. `service/poll/loop.ts`: the `assignment` builder sets `subject-author`/issue author and **drops** an unreadable or bot-authored subject, exactly as the mention paths already do. *Needs A-2 + A-3.* *Tests* (`tests/service-triggers.test.ts`, `tests/service-entry.test.ts`): each kind's actor and basis; a bot-authored comment/issue body/assignment/review and an authorless assignment/review each create **no** event, no run, and no work; `buildEventId`'s output is unchanged for every fixture.

- [x] **A-6** [P] [002 AC-024, AC-025] **Attribution acceptance proof** — extend `tests/service-triggers.test.ts` and `tests/service-entry.test.ts` into the four-kind table: the two mention kinds read `direct`, the two proxy kinds read `subject-author`; the assignment's actor is the **issue** author and the review's is the **pull-request** author; a binding naming a `[bot]` login cannot cause a bot event to be created because none is; and **no** row, note, or trigger string states that an actor assigned or requested anything (NFR-011). *Needs A-5.*

- [x] **A-7** [P] [002 AC-027, FR-046, FR-048] **Identity and one-repository proof** — extend `tests/service-events.test.ts`: the same issue / comment / pull observed twice — once as a populated list and once as an absent one — produces **one** event whose `evt-…` identifier is **byte-identical** across both observations; a binding carrying one `repository` is the only shape that validates, with **no** plural and **no** wildcard accepted; and `buildEventId`'s docblock's promise is asserted against the shipped format. *Needs A-3 + A-5.*

**Wave 1 boundary**: `npm run verify` green; rebuilt `service/main.js` committed with the wave.

**Wave 1 delivered (2026-10-03)** — 628 tests green from 603; `npm run verify` (build → lint →
typecheck → test) green. Two modules were added rather than only edited, because the file-length
gate (`llm-core/max-file-length`, 500 non-blank lines) could not absorb the new rules:
`service/bindings-allow-list.ts` (the `allowedUsers` field's validation **and** plan D9's one
membership comparison `isActorAllowed`, which contract §5.6 words as "its own module") and
`service/poll/attribution.ts` (`isBotAuthor` / `isAttributableAuthor` / the one
`AUTHOR_LOGIN_MAX_CHARS` bound, plus the stored row's `ActorAttribution` vocabulary and its two
readers — attribution's two sides in one place). Deviations and findings are recorded in
`orchestration-allow-list.md`'s Wave 1 entry; `buildEventId`, `discriminatorOf`, and
`SERVICE_SCHEMA_VERSION` are untouched, and no `schemaVersion` member exists.

---

## Wave 2 — 003's gate (the enforcement point)

**Goal**: one membership comparison, in one place, that leaves a refusal behind.
Independent test (003 AC-130 – AC-133): reserve a run under `['alice']` whose only reference is
`bob`; assert `409 actor-not-allowed`, no reservation, no token, a byte-identical run document, and
exactly one `dispatch.refused` row naming every denied login and its basis.

- [ ] **B-1** [003 FR-079, 003 FR-077] **The run model gains the two members** — `service/poll/runs-types.ts`: `SourceReference` gains `actorLogin` and `actorAttribution` (**absentable on read**, validated when present — a run written before this feature has none, which is what makes 003 FR-080 reachable) and `Run` gains `actorPolicy: 'open' | 'restricted' | null` (`null` = no authorization recorded yet). `service/poll/runs-parse.ts`: both members validated fail-closed. `service/poll/runs-join.ts`: a joining reference copies the actor from its delivery row. `service/poll/run-history-project.ts`: the projection carries `actorPolicy` and each reference's `actorLogin` + `actorAttribution`, and **never** a login the policy permits. *Needs A-3 + A-5.* *Tests* (`tests/service-runs-parse.test.ts`, `tests/service-run-history.test.ts`): round-trip; a stored reference with an unknown basis refuses; `actorPolicy` null before any authorization and set by the reserve; the projection is credential-free and permitted-login-free.

- [ ] **B-2** [003 FR-076 – FR-078] **The gate itself** — `service/poll/dispatch-authorize.ts`: read the binding's stored `allowedUsers` **at authorization**, inside the one `operateRun` chain task, **after** `judgeReserve` has returned `null` and **before** any token is derived, any reservation is built, or any state changes. Add the predicate `judgeActorPolicy` and call `isActorAllowed` from `service/bindings.ts` — **no second implementation** (plan D9). The admitted case writes `run.actorPolicy` from the same read that made the decision (FR-079). *Needs A-1 + B-1.* **Two rules this task encodes as assertions, not prose**: (a) **at least one** reference naming an allowed actor admits the run — a coalesced run with `bob`, `carol`, `alice` under `['alice']` is authorized and records all three actors with their bases visible (FR-077, AC-133); (b) a reference whose `actorLogin` is absent, empty, or **bot-shaped** is **refused**, never admitted on the strength of the list (FR-080), and the policy being `open` is not a reason to wave it through. Also: the gate **denies when the policy cannot be read** — an absent binding or an unusable bindings document is fail-closed, with the refusal message naming the cause (constitution II, 002 FR-024; **flagged** in `pm-handoff.md`, because 003 NFR-114's letter assumes a bindings read that the authorization path does not make today).

- [ ] **B-3** [003 FR-077, FR-079] **What the gate writes to the trail** — `service/poll/run-refusal.ts`: add `actor-not-allowed` to `RunRefusalCode`; `REFUSAL_STATUS` maps it to **409**. `service/poll/dispatch-audit.ts`: the `dispatch.refused` builder for this code carries the attempted operation, the refusal code, the prior state, the attempt, the binding id, `actorPolicy`, **every denied login**, and **each denied login's attribution basis** — so the row says *proxy* where it was one and never states that a denied actor caused anything (002 NFR-011). The same file's `reservedRow` and `resultRow` each gain one required, **value-free** `actorPolicy` detail (`'open' | 'restricted'`) beside 004's prompt members (FR-079). *No new `eventType`.* *Needs B-2.* *Tests* (`tests/service-run-authorize.test.ts`, `tests/audit-vocabulary.test.ts`): the refusal writes exactly one row with the full detail set and **no permitted login**; the two admitted rows carry `actorPolicy`; a null `actorPolicy` on a reserved run refuses rather than writing `null`.

- [ ] **B-4** [P] [003 FR-078] **The fifth declared `blocked:` cause** — `service/poll/dispatch-block.ts`: `BLOCKED_REASONS` widens from four to five with `actor-not-allowed`, so the runs document stays readable to its own parser (data-model §2.2). `service/poll/run-operate.ts`: the service-corroborated set widens from `binding-missing` alone to **`binding-missing` and `actor-not-allowed`** — a retry re-checks the **live** policy with the same predicate the gate uses, so a run cannot be retried into a dispatch this gate would refuse again (FR-078). A refused retry answers its own distinct reason and consumes **no** attempt and **no** requeue budget. *Needs B-2.* *Tests*: the block report accepts the fifth cause and refuses a sixth; a `blocked:actor-not-allowed` retry with the policy unchanged answers `cause-not-cleared` naming the binding; with the denied login added to the binding the same retry succeeds, `causeCleared` is audited as **corroborated**, and the attempt/budget counters move exactly as for any other retry.

- [ ] **B-5** [003 FR-078, 005 FR-044/FR-046] **The panel reports the block through the operation it already has** — `src/relay-gates.ts`: `BlockedReason` gains `actor-not-allowed`; when the reserve answers `409 actor-not-allowed` the relay **posts the existing block report** (`blockedReason`, `detail` from the service's own message naming the denied login, `guidance` naming the field that restricts it) and **never** calls `host.startSession()`. The panel **does not pre-check the list** (FR-076): one comparison, in the service. `src/dispatches-service.ts`: the claim/history DTO widens to the new members. `src/dispatches-rows.ts`: `blocked:actor-not-allowed` joins the state→affordance table with a label and a reason line, and its retry validity follows 003 FR-041 exactly as every other cleared cause's does. *Needs B-3 + B-4.* *Tests* (`tests/relay-integrity.test.ts`, `tests/dispatches.test.ts`): the call log shows reserve → 409 → blocked → **zero** `startSession`; the row renders the denied login and the service's reason; the table still fails for a cause with no row.

- [ ] **B-6** [P] [003 FR-076, 002 NFR-113, plan D9] **Gate proof: 003 AC-130 – AC-133 and the containment scan** — `tests/service-run-authorize.test.ts`: the full refusal matrix with the new code — `409 actor-not-allowed`, **no** `dispatch.reserved` row, **no** token, the run document **byte-identical** before and after, exactly one `dispatch.refused` row with AC-130's detail set, and the already-dispatched and stale-lease verdicts still reachable on their own paths (the verdict sits **after** `judgeReserve`, so neither is pre-empted). `tests/service-run-operations.test.ts`: AC-131 blocking-not-burning, plus AC-133's coalesced cases both ways. `tests/audit-vocabulary.test.ts`: the two rows carry `actorPolicy`; the gate adds **no** event type. **`tests/bundle.test.ts`**: the NFR-113 scan — with a populated list, **no permitted login** appears in any audit row the build can write, the run record, the run-history projection, `GET /v1/audit`, or either committed bundle; only the shape appears. **One-comparison scan**: the membership helper's identifier appears in exactly two files, its own and `dispatch-authorize.ts`. *Needs B-1 … B-5.*

- [ ] **B-7** [003 FR-079, NFR-114, SC-112] **Cost and latency assertions** — extend `tests/relay-integrity.test.ts`: the authorized path's round-trip count is **unchanged** from before this block (no extra panel↔service call and no extra network call), the one refused path costs exactly the one block report every guard already owes, and a **tightened** list takes effect on the **next** authorization with no re-scan and no restart. Recorded as counts and injected stamps, never wall-clock (NFR-112). *Needs B-2.*

**Wave 2 boundary**: `npm run verify` green; both rebuilt bundles committed with the wave.

---

## Wave 3 — 005's rendering

**Goal**: the operator can answer "who may trigger this, and who asked" without leaving the panel,
and no surface ever implies a control that does not exist.
Independent test (005 AC-142 – AC-146): three bindings (two restricted, one not), twelve logins on
one of them, a coalesced run and a refused run — render all six tabs and count what appears where.

- [ ] **C-1** [P] [005 FR-090, 002 FR-047] **`src/bindings-service.ts`** — `PanelBinding` gains `allowedUsers?: readonly string[]`; the entry reader **refuses** a non-array or a non-text element (invariant 8, fail closed) and preserves the submitted spelling. The panel's client-of-record rule, asserted here: the member is sent **explicitly on every row** — the array when set, the **key omitted** when unset — and `[]` is never manufactured by the client (contract §2; plan D4). *Needs A-1.*

- [ ] **C-2** [005 FR-090 – FR-092, FR-095] **`src/bindings-actors.ts`** (new module, one responsibility — the allow-list's rendering, mirroring `src/bindings-prompt.ts`) — one field in the binding editor beside the mention-token override, labelled as the set of GitHub logins allowed to trigger dispatches from this repository, whose guidance states **all three** of 002 FR-047's states in the panel's own words including that an empty list is **refused, not "nobody"**, and that disabling the binding is how every trigger stops; free text the operator supplies (**no identity picker** — the host exposes no such API and the panel may not invent one); the row summary shows the **count only**, never a login; a binding with **no** list carries a **visible worded warning** naming who can trigger it and which field restricts it, carrying **text and not colour alone**, phrased as information and **not** as an error; a binding **with** a list shows its count and **no** warning; a service refusal renders the service's own field-level remediation, leaves every other binding byte-identical, is **never** reported as saved, and **never echoes** the submitted value. *Needs C-1.*

- [ ] **C-3** [P] [005 FR-090, FR-052, 004 FR-014] **`src/bindings-grant.ts`** — the whole-file write carries the member on **every** row (strip-and-restore, exactly as `PromptPatch` does for the prompt, with the opposite default: omission means unset here); the existing "nothing changed" refusal note stays and gains the allow-list's own field-level slot. *Needs C-1.* *Tests*: the body carries `allowedUsers` on every row; the one edited binding carries the operator's array; a cleared field omits the key; a refusal changes nothing and is not reported as saved.

- [ ] **C-4** [P] [005 FR-093, NFR-113] **Status states the count and the consequence** — `service/routes/status.ts` + `service/routes/events.ts` (`readStatusRows`): each `repositories[]` row gains `actorPolicy` (`'open' | 'restricted'`, **never the logins**), derived from the binding the row is already built from. `src/status-document.ts`: the fail-closed parser gains the member and **refuses** an unrecognized value. `src/status-lines.ts` + `src/status-tab.ts`: one line stating how many of the listed bindings carry **no** list plus the consequence; a count of **zero** renders as a **positive statement**, never as an absent row; where the service could not be read the line reads **not available** with the service named; Status **names no login and no repository** and points at the Bindings tab. *Needs B-1 (the policy shape it reports is the same closed union).*

- [ ] **C-5** [P] [005 FR-094, 002 FR-044/NFR-011] **The dispatch row names the actor and, where it is a proxy, its basis** — `src/dispatches-rows.ts`: each source reference in the reveal carries its **own** actor and basis; a `subject-author` basis renders in the panel's own words — that GitHub records the issue or pull-request author and **does not record who assigned or requested the review** — so a proxy is never presented as a fact; a coalesced run's unallowed rider is therefore **visible rather than silent**; a `blocked:actor-not-allowed` row names the **denied** login and 003's reason; the row never predicts the service's verdict (FR-046) and every string goes through the non-HTML path (FR-080). *Needs B-5 (the row's members) and B-6's DTO.*

- [ ] **C-6** [P] [005 AC-142 – AC-146, SC-113] **Rendering acceptance proof** — `tests/bindings-actors.test.ts` (new): the field's three states, the guidance text, the count-only row summary, the absent-policy warning's wording and non-error phrasing, the refusal split with no echo, and **the exactly-once count** — with twelve permitted logins on one binding, the twelve strings appear **exactly once** panel-wide, in the editor field, and the row reads *12 users*. `tests/status-tab.test.ts`: `1 of 3 bindings…`, the all-restricted zero case as a positive statement, and the unreachable case as *not available*. `tests/dispatches.test.ts`: AC-145's actor/basis/refused-run fixtures. **A string scan** across every user-facing string for *protected*, *restricted*, and *secure*, asserting each appears only about a binding the service reported as `restricted` (NFR-113, AC-146). *Needs C-2 … C-5.*

**Wave 3 boundary**: `npm run verify` green; both rebuilt bundles committed with the wave. **This is the release-candidate gate for issue #9.**

---

## Wave graph, dependencies, and parallel structure

```
Wave 1  A-1 ∥ A-2 ∥ A-3 ∥ A-4        002's model + the field's validator
          │
          ▼  (A-2, A-3)
        A-5        attribution at detection
          │
          ▼
        A-6 ∥ A-7                     002's proof  ─────────────┐
                                                               │
Wave 2  B-1  run model members  ◄───────────────────────────────┘
          │
          ▼
        B-2  the gate
          │
          ├──────────────▶ B-4 [P]  fifth blocked cause + retry re-check
          ▼
        B-3  the gate's audit rows
          │
          ▼
        B-5  panel block reporting
          │
          ├──▶ B-6 [P]  003's proof (needs B-1…B-5)
          └──▶ B-7 [P]  cost and latency assertions
                                                               │
Wave 3  C-1 (005's parser)  ◄── A-1                          │
          │                                                    │
          ├──▶ C-2 ──┐                                       │
          ├──▶ C-3 [P]│                                       │
          ├──▶ C-4 [P] ◄── B-1 ──────────────────────────────┘
          └──▶ C-5 [P] ◄── B-5
                   └──▶ C-6 [P]   005's proof (needs C-2…C-5)
```

- **Strictly serial, and why**: `A-1 → A-5 → A-6/A-7` is one chain because attribution is only
  testable once the row carries it, and the row shape must exist before the detection code compiles
  against it. `B-1 → B-2 → B-3 → B-5` is one chain because the gate reads the run's references, the
  refusal names what the gate decided, and the panel maps the refusal. `B-6`/`B-7` and `C-6` are
  proofs and therefore last.
- **Genuinely parallel**: **`A-1 ∥ A-2 ∥ A-3 ∥ A-4`** — four disjoint surfaces
  (`service/bindings.ts`, `service/poll/poller-entries.ts`, `service/poll/{events-write,events-parse}.ts`,
  a new test file). **`A-6 ∥ A-7`** — different suites. **`B-4 ∥ B-2`** —
  `dispatch-block.ts` + `run-operate.ts` against `dispatch-authorize.ts`; disjoint files. **`B-6 ∥ B-7`**
  — different suites. **`C-1 ∥ C-4 ∥ C-5`** — 005's bindings parser, the status projection plus the four
  `status-*` modules, and the dispatch row's copy, all depending only on already-finished waves;
  **`C-2 ∥ C-3 ∥ C-4 ∥ C-5`** once `C-1` has landed. **`B-6 ∥ C-4`** across waves is *not* claimed: wave
  boundaries are `npm run verify` gates, and a wave boundary is where the bundles are rebuilt and
  committed.
- **Hard dependencies**: `A-4 ← A-1`; `A-5 ← A-2, A-3`; `A-6 ← A-5`; `A-7 ← A-3, A-5`;
  `B-1 ← A-3, A-5`; `B-2 ← A-1, B-1`; `B-3 ← B-2`; `B-4 ← B-2`; `B-5 ← B-3, B-4`;
  `B-6, B-7 ← B-1…B-5`; `C-1 ← A-1`; `C-2, C-3 ← C-1`; `C-4 ← B-1`; `C-5 ← B-5`; `C-6 ← C-2…C-5`.
- **MVP slice if delivery is cut**: `A-1` + `A-2` + `A-3` + `A-5` + `B-1` + `B-2` + `B-3` — the
  model plus the gate and its trail — is the security-bearing half. **But no wave boundary ships
  without `npm run verify` green and both bundles rebuilt and committed**, and the feature is not
  honestly shippable without `C-2` and `C-4`: a control the operator cannot see or change is the
  defect the owner conditioned the whole amendment on.

## Routing recommendation for Phase 6

**20 tasks, 13 of them `[P]` — multi-wave orchestration.** The bands are ≤5 tasks (architect solo),
6–15 (architect with review gates), >15 (multi-wave delivery). This block is over the top band and
its shape is exactly what that band is for: **three features' worth of work in three waves, a
foundation wave that gates everything, and a hard serial spine inside each wave.** Two further
reasons it should not be run solo: (a) `B-2` is a **security gate** in the constitution-II sense
and deserves its own independent security review rather than the implementer's own sign-off, the
same way 002's `token-handoff.md` was G1-gated; (b) `C-6`'s copy-and-honesty assertions are the part
most likely to need a second pair of eyes and the least likely to be caught by a red test. The
**PM handoff** for the dispatch is [`pm-handoff.md`](./pm-handoff.md).

## Requirement → task coverage

| Requirement | Tasks |
| --- | --- |
| **002** FR-043 (actor members, event contract 1.2) | A-3, A-5, B-1 |
| **002** FR-044 (`direct` / `subject-author`, closed union) | A-3, A-5, A-6, B-1, C-5 |
| **002** FR-045 (mandatory, fail-closed, all four kinds, `PollPull` author) | A-2, A-5, A-6, B-2 |
| **002** FR-046 (actor out of the event id) | A-3, A-7 |
| **002** FR-047 (`allowedUsers`, three states, validated every read and write) | A-1, A-4, C-1, C-2, C-3 |
| **002** FR-048 (one repository per binding) | A-7 |
| **002** NFR-011 (attribution honesty) | A-6, B-3, C-5 |
| **002** SC-008 (who, on what basis, and how to change it — in the product) | C-2, C-4, C-5, C-6 |
| **003** FR-076 (the gate is the authorization decision; no second comparison) | B-2, B-6 |
| **003** FR-077 (one verdict, one refusal, one row; at least one allowed reference) | B-2, B-3, B-5, B-6 |
| **003** FR-078 (a policy refusal blocks, never burns; retry re-checks the live policy) | B-4, B-5, B-6 |
| **003** FR-079 (`actorPolicy` on both admitted rows, never the logins) | B-1, B-3, B-6 |
| **003** FR-080 (bots can never be authorized; no second bot test) | B-2, B-6 |
| **003** NFR-113 (no policy in the trail) | A-4, B-1, B-3, B-6 |
| **003** NFR-114 (the gate costs nothing on the happy path) | B-7 |
| **003** SC-112 (the trail answers who / on what basis / was it restricted) | B-3, B-6 |
| **005** FR-090 (one field, three states, free text, service is the only validator) | C-1, C-2, C-3 |
| **005** FR-091 (one rendering per list value — count only) | C-2, C-6 |
| **005** FR-092 (absent policy is a worded warning everywhere, never neutral) | C-2, C-6 |
| **005** FR-093 (Status states the count and the consequence, names no login) | C-4, C-6 |
| **005** FR-094 (the dispatch row names the actor and its basis) | C-5, C-6 |
| **005** FR-095 (a refusal splits back to the field; no silent partial save) | C-2, C-3 |
| **005** NFR-113 (no implied policy anywhere) | C-2, C-4, C-6 |
| **005** SC-113 (answer both questions from the Bindings tab and Status) | C-2, C-4, C-6 |

## Acceptance criterion → task coverage

| Criterion | Tasks |
| --- | --- |
| **002** AC-024 (all four kinds attributed; bases correct; nothing states causation) | A-5, A-6 |
| **002** AC-025 (bot/unreadable subjects create no event; a `[bot]` entry admits nothing) | A-5, A-6, B-2 |
| **002** AC-026 (the three states, byte-identity, case-insensitivity, `[]` refused both ways, no new endpoint) | A-1, A-4 |
| **002** AC-027 (one event, byte-identical id, across the amendment and across lists; one repository only) | A-3, A-7 |
| **003** AC-130 (gate placement and refusal: `409`, no token, byte-identical run, one row with the full detail set) | B-2, B-3, B-6 |
| **003** AC-131 (blocking not burning; retry refused, then succeeds once the login is allowed) | B-4, B-5, B-6 |
| **003** AC-132 (`open` vs `restricted` on both rows; no permitted login anywhere; a hand-edited run refused) | B-2, B-3, B-6 |
| **003** AC-133 (the coalesced rule both ways; p95 unchanged) | B-2, B-4, B-6, B-7 |
| **005** AC-142 (the field, its three states, the `[]` refusal, no second control, no picker) | C-1, C-2, C-3, C-6 |
| **005** AC-143 (exactly-once: twelve logins, one rendering, count on the row) | C-2, C-6 |
| **005** AC-144 (the absent-policy warning on the row and on Status; zero as a positive statement; unreachable as *not available*) | C-2, C-4, C-6 |
| **005** AC-145 (the actor and its basis on the row; a coalesced rider visible; the refused run names the denied login) | B-5, C-5, C-6 |
| **005** AC-146 (no implied policy in any user-facing string) | C-2, C-4, C-6 |

## Items flagged at the Phase-5 gate (do not resolve them in code)

Four places where the approved specifications leave a real fork. Each is recorded where it belongs,
each is decided *for planning purposes only*, and each should be ratified or amended by the product
owner before `B-2` and `C-2` are implemented. See [`pm-handoff.md`](./pm-handoff.md) §Flagged.

1. **003 NFR-114's letter vs. the shipped code** — the authorization path reads `config.json`, not
   `bindings.json`, so reading the binding's policy **is** one additional store read.
2. **The empty-list round trip** — whether the panel submits `[]` (and cannot therefore clear a
   list) or omits the key (and never produces `[]`) decides whether 005 AC-142's `[]` case is
   reachable through the editor.
3. **FR-045(c)'s wording** — "no binding field may be written to allow-list a bot" read as a
   *validator* rule (refuse `[bot]` entries) rather than the *capability* statement the same clause's
   reason and AC-025 describe.
4. **The retry verdict for an unreadable bindings document** — whether it is `cause-not-cleared`
   (chosen) or a new code (rejected: a second wire code the specifications do not ask for).
