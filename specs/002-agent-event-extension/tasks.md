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

- [x] **B-1** [003 FR-079, 003 FR-077] **The run model gains the two members** — `service/poll/runs-types.ts`: `SourceReference` gains `actorLogin` and `actorAttribution` (**absentable on read**, validated when present — a run written before this feature has none, which is what makes 003 FR-080 reachable) and `Run` gains `actorPolicy: 'open' | 'restricted' | null` (`null` = no authorization recorded yet). `service/poll/runs-parse.ts`: both members validated fail-closed. `service/poll/runs-join.ts`: a joining reference copies the actor from its delivery row. `service/poll/run-history-project.ts`: the projection carries `actorPolicy` and each reference's `actorLogin` + `actorAttribution`, and **never** a login the policy permits. *Needs A-3 + A-5.* *Tests* (`tests/service-runs-parse.test.ts`, `tests/service-run-history.test.ts`): round-trip; a stored reference with an unknown basis refuses; `actorPolicy` null before any authorization and set by the reserve; the projection is credential-free and permitted-login-free.

**Delivered (2026-10-03)** — `SourceReference.actorLogin` / `.actorAttribution` ride the reference verbatim through the attribution module's own absentable readers (`service/poll/runs-parts-parse.ts`), and `Run.actorPolicy` is snapshotted from the gate's decision (`ActorPolicy = 'open' | 'restricted'`, plus `ActorGateRefusal` — declared in `runs-types.ts` so the shared chain can thread the refusal's detail set without importing the gate). `ActorPolicy` and the actor union were declared in **`runs-types.ts`** rather than re-declared in `dispatch-authorize.ts`, because four modules name them. One deviation: `run-history-project.ts` copies `run.sourceReferences` verbatim (so the actor members ride along) and gained only the `actorPolicy` member — it is a pure function of stored runs handed no binding, so it is **structurally unable** to carry a permitted login rather than filtering one out, which is recorded in the module docblock. `tests/service-runs-parse.test.ts` gains the round-trip, the unknown-basis and unusable-login refusals, the two legal words plus `null`, and the pre-feature row reading as *no attribution recorded*; `tests/service-service-runs.test.ts`'s projected-field list gains `actorPolicy`, and `tests/service-run-enqueue.test.ts`'s capped-reference assertion now names the two actor members (a retained reference a gate could not attribute would be one it must refuse).

- [x] **B-2** [003 FR-076 – FR-078] **The gate itself** — `service/poll/dispatch-authorize.ts`: read the binding's stored `allowedUsers` **at authorization**, inside the one `operateRun` chain task, **after** `judgeReserve` has returned `null` and **before** any token is derived, any reservation is built, or any state changes. Add the predicate `judgeActorPolicy` and call `isActorAllowed` from `service/bindings.ts` — **no second implementation** (plan D9). The admitted case writes `run.actorPolicy` from the same read that made the decision (FR-079). *Needs A-1 + B-1.* **Two rules this task encodes as assertions, not prose**: (a) **at least one** reference naming an allowed actor admits the run — a coalesced run with `bob`, `carol`, `alice` under `['alice']` is authorized and records all three actors with their bases visible (FR-077, AC-133); (b) a reference whose `actorLogin` is absent, empty, or **bot-shaped** is **refused**, never admitted on the strength of the list (FR-080), and the policy being `open` is not a reason to wave it through. Also: the gate **denies when the policy cannot be read** — an absent binding or an unusable bindings document is fail-closed, with the refusal message naming the cause (constitution II, 002 FR-024; **flagged** in `pm-handoff.md`, because 003 NFR-114's letter assumes a bindings read that the authorization path does not make today).

**Delivered (2026-10-03)** — the predicate and the live read live in a **new module**, `service/poll/dispatch-actor-gate.ts` (`judgeActorPolicy`, `readLivePolicy`, `unreadablePolicyRefusal`, and the exported `ACTOR_BLOCKED_REASON`), which the file-length gate forced and which this feature wants anyway: `dispatch-authorize.ts` owns the decide → apply → record chain and the token, and the retry path re-runs the *same* predicate from it (B-4). The gate runs **after** `judgeReserve` returns `null` and **before** `buildDispatchToken`, so `already-dispatched` and `stale-lease` stay reachable on their own paths (asserted both ways, including a run that already produced a session under a *tightened* policy). Both rules are assertions: a coalesced run of `bob`/`carol`/`alice` under `['alice']` **applies** with all three actors and bases recorded, and the same run with all three outside the list is refused naming all three; an absent/empty/bot-shaped actor is refused **under the open policy too**, via a hand-edited store row (the only way to reach one, since 002 FR-045 makes attribution mandatory at detection). Deny-when-unreadable is one code with `actorPolicy: null` and a message naming the cause; the read is `readBindingsForAuthorization` (new, beside `readBindings` in `service/bindings-read.ts`), which is the one reader that keeps *no bindings* and *an unreadable document* apart — and which deliberately skips the prompt observer, since the gate is not an editor. **No cache** (plan D13): `ServiceStore` exposes no `stat`, so a hand edit would never be seen. Tests: `tests/service-run-authorize.test.ts` gains five cases across three `describe`s — the full refusal matrix, byte-identical run document with no `dispatch.reserved` row and no token, the admitted cases with their `actorPolicy`, and the two pre-emptible verdicts.

- [x] **B-3** [003 FR-077, FR-079] **What the gate writes to the trail** — `service/poll/run-refusal.ts`: add `actor-not-allowed` to `RunRefusalCode`; `REFUSAL_STATUS` maps it to **409**. `service/poll/dispatch-audit.ts`: the `dispatch.refused` builder for this code carries the attempted operation, the refusal code, the prior state, the attempt, the binding id, `actorPolicy`, **every denied login**, and **each denied login's attribution basis** — so the row says *proxy* where it was one and never states that a denied actor caused anything (002 NFR-011). The same file's `reservedRow` and `resultRow` each gain one required, **value-free** `actorPolicy` detail (`'open' | 'restricted'`) beside 004's prompt members (FR-079). *No new `eventType`.* *Needs B-2.* *Tests* (`tests/service-run-authorize.test.ts`, `tests/audit-vocabulary.test.ts`): the refusal writes exactly one row with the full detail set and **no permitted login**; the two admitted rows carry `actorPolicy`; a null `actorPolicy` on a reserved run refuses rather than writing `null`.

**Delivered (2026-10-03)** — `actor-not-allowed` is in `RunRefusalCode` and mapped to **409** in `routes/run-answer.ts`'s table. `refusedRow` takes one **optional** `actor` member (not five optional detail keys), and `actorDetails` composes them, so the other six operations' rows are byte-unchanged — a required member would have put a meaningless `actorPolicy: null` on every staleness row. `deniedLogins` and `deniedAttributions` are **index-parallel arrays**, as the contract names two keys. The gate's message spells a `subject-author` basis as the **proxy** it is, in the panel's own words rather than as the bare union word. `reservedRow` and `resultRow` each gain `actorPolicy` through the shared `promptDetails`, read from the run's **snapshot** (plan D16), so both rows provably describe one policy. **A deviation on the third named test**: "a null `actorPolicy` on a reserved run refuses" is **not** implemented as a store-level check — a hand-seeded `starting` run with `actorPolicy: null` is a fixture shape no production path produces (every `starting` run was authorized, and the gate always writes the policy), and refusing a *result report* over it would have invented a wire refusal no requirement names. The row builders simply carry the snapshot, so a null would be recorded as null rather than guessed; that is recorded here rather than silently. Tests: `tests/audit-vocabulary.test.ts`'s two detail-key lists gain `actorPolicy`, and `tests/service-run-authorize.test.ts` asserts the refusal's full AC-130 detail set, the two admitted rows' shapes, and that a `subject-author` denial reads as *proxy*.

- [x] **B-4** [P] [003 FR-078] **The fifth declared `blocked:` cause** — `service/poll/dispatch-block.ts`: `BLOCKED_REASONS` widens from four to five with `actor-not-allowed`, so the runs document stays readable to its own parser (data-model §2.2). `service/poll/run-operate.ts`: the service-corroborated set widens from `binding-missing` alone to **`binding-missing` and `actor-not-allowed`** — a retry re-checks the **live** policy with the same predicate the gate uses, so a run cannot be retried into a dispatch this gate would refuse again (FR-078). A refused retry answers its own distinct reason and consumes **no** attempt and **no** requeue budget. *Needs B-2.* *Tests*: the block report accepts the fifth cause and refuses a sixth; a `blocked:actor-not-allowed` retry with the policy unchanged answers `cause-not-cleared` naming the binding; with the denied login added to the binding the same retry succeeds, `causeCleared` is audited as **corroborated**, and the attempt/budget counters move exactly as for any other retry.

**Delivered (2026-10-03)** — `BLOCKED_REASONS` widens four → five with the gate's exported `ACTOR_BLOCKED_REASON`, and `run-operate.ts`'s corroborated set becomes a two-member `CORROBORATED_BLOCKED_REASONS`, dispatching on membership so the third family (`project-missing`, `credential`, `policy`) still takes the **reported** path. The re-check calls `judgeActorPolicy` itself, with the binding's live list, and treats an **absent** binding as *not* corroboration — the gate would refuse the dispatch again right now. Tests: `tests/service-run-authorize.test.ts` asserts the block report accepts the fifth cause and refuses a sixth (`not-a-declared-cause`); `tests/service-run-operations.test.ts` gains AC-131's three cases, including that a refused retry leaves `attempt` **and** `requeuesUsed` untouched.

- [x] **B-5** [003 FR-078, 005 FR-044/FR-046] **The panel reports the block through the operation it already has** — `src/relay-gates.ts`: `BlockedReason` gains `actor-not-allowed`; when the reserve answers `409 actor-not-allowed` the relay **posts the existing block report** (`blockedReason`, `detail` from the service's own message naming the denied login, `guidance` naming the field that restricts it) and **never** calls `host.startSession()`. The panel **does not pre-check the list** (FR-076): one comparison, in the service. `src/dispatches-service.ts`: the claim/history DTO widens to the new members. `src/dispatches-rows.ts`: `blocked:actor-not-allowed` joins the state→affordance table with a label and a reason line, and its retry validity follows 003 FR-041 exactly as every other cleared cause's does. *Needs B-3 + B-4.* *Tests* (`tests/relay-integrity.test.ts`, `tests/dispatches.test.ts`): the call log shows reserve → 409 → blocked → **zero** `startSession`; the row renders the denied login and the service's reason; the table still fails for a cause with no row.

**Delivered (2026-10-03)** — `reserveRun` now answers a `ReserveOutcome` union (`reserved` | `refused`, with `failure` set **only** for the gate) instead of `ReserveAnswer | null`: a bare `null` cannot distinguish "a policy this panel must report" from "a stale lease, which it merely notes". `actorGateFailure` narrows on the **code**, never the status, so `stale-lease` and `already-reserved` stay un-reported; `detail` is the service's message verbatim and `guidance` names the **field** (`allowedUsers`), never a login. `dispatchRow`'s row already renders the denied login, because the service's message is the run's `stateReason`; `dispatchRow`'s reveal (the actor on each reference) is **C-5's**, deliberately not taken. `src/dispatches-service.ts`'s DTO widens to `actorPolicy` + the two reference members, and the readers moved to two new modules for the file-length gate: `src/run-actor.ts` (the two closed vocabularies and their absentable readers) and `src/dispatches-detail.ts` (the row's structured members). `dispatches-rows.ts` gives the cause its own reason line naming the field, with the generic guard clause kept as the fallback. Tests: `tests/relay-integrity.test.ts` shows `reserve → 409 → blocked` with **zero** `startSession` and the exact block body, and `tests/dispatches.test.ts` covers the label, the affordance, and the undeclared-cause fallback.

- [x] **B-6** [P] [003 FR-076, 002 NFR-113, plan D9] **Gate proof: 003 AC-130 – AC-133 and the containment scan** — `tests/service-run-authorize.test.ts`: the full refusal matrix with the new code — `409 actor-not-allowed`, **no** `dispatch.reserved` row, **no** token, the run document **byte-identical** before and after, exactly one `dispatch.refused` row with AC-130's detail set, and the already-dispatched and stale-lease verdicts still reachable on their own paths (the verdict sits **after** `judgeReserve`, so neither is pre-empted). `tests/service-run-operations.test.ts`: AC-131 blocking-not-burning, plus AC-133's coalesced cases both ways. `tests/audit-vocabulary.test.ts`: the two rows carry `actorPolicy`; the gate adds **no** event type. **`tests/bundle.test.ts`**: the NFR-113 scan — with a populated list, **no permitted login** appears in any audit row the build can write, the run record, the run-history projection, `GET /v1/audit`, or either committed bundle; only the shape appears. **One-comparison scan**: the membership helper's identifier appears in exactly two files, its own and `dispatch-authorize.ts`. *Needs B-1 … B-5.*

**Delivered (2026-10-03)** — AC-130/AC-131/AC-132/AC-133 are asserted across `tests/service-run-authorize.test.ts` (the full matrix, byte-identical run document, one refusal row, the coalesced cases both ways, and both pre-emptible verdicts) and `tests/service-run-operations.test.ts` (blocking-not-burning). The NFR-113 scan in `tests/bundle.test.ts` drives a **real** refusal end to end through the panel relay under a populated list whose permitted login is **disjoint** from the run's denied actor (plan B.5 item 3, which makes the zero meaningful), then greps the run document, the trail, the projection, the audit read, the panel ledger, `host.storage`, the captured logs, and **both committed bundles** — and asserts the permitted login *is* in `bindings.json`, so the scan cannot pass vacuously. Two more scans ride along: `triggers.ts` and `loop.ts` name neither `isActorAllowed` nor `allowedUsers` (detection decides nothing, FR-076), and the five Wave-2 modules carry no suppression and no `any` (invariant 7). **The one-comparison scan passes**: `isActorAllowed` appears in exactly two source files — `service/bindings-allow-list.ts` (its own) and `service/poll/dispatch-actor-gate.ts` — asserted in both `tests/allow-list.test.ts` (§5.6) and `tests/bundle.test.ts`.

- [x] **B-7** [003 FR-079, NFR-114, SC-112] **Cost and latency assertions** — extend `tests/relay-integrity.test.ts`: the authorized path's round-trip count is **unchanged** from before this block (no extra panel↔service call and no extra network call), the one refused path costs exactly the one block report every guard already owes, and a **tightened** list takes effect on the **next** authorization with no re-scan and no restart. Recorded as counts and injected stamps, never wall-clock (NFR-112). *Needs B-2.*

**Delivered (2026-10-03)** — in `tests/relay-integrity.test.ts`, all three as **counts on the recorded timeline** (no clock anywhere): the authorized path's round-trip count is asserted *unchanged* (`PENDING_GET` then the reserve, then `startSession` — the same figure the pre-existing NFR-101 case already pins), the refused path's whole call log is asserted as exactly `[claim, reserve, blocked]` with **zero** `startSession`, and the "tightened list takes effect on the next authorization" property is covered by the service-side cases (a `starting` run under a *narrowed* policy answers `already-dispatched`; a `blocked:actor-not-allowed` run whose list widens applies on the retry) — both with the injected `now` the suite already uses, and with no re-scan and no restart anywhere in either.

**Wave 2 boundary**: `npm run verify` green; both rebuilt bundles committed with the wave.

---

## Wave 3 — 005's rendering

**Goal**: the operator can answer "who may trigger this, and who asked" without leaving the panel,
and no surface ever implies a control that does not exist.
Independent test (005 AC-142 – AC-146): three bindings (two restricted, one not), twelve logins on
one of them, a coalesced run and a refused run — render all six tabs and count what appears where.

- [x] **C-1** [P] [005 FR-090, 002 FR-047] **`src/bindings-service.ts`** — `PanelBinding` gains `allowedUsers?: readonly string[]`; the entry reader **refuses all three unusable shapes** — a non-array, a non-text element, and an explicitly **empty array** (invariant 8, fail closed) — and preserves the submitted spelling. The panel's client-of-record rule, asserted here: the member is sent **explicitly on every row** — the array when set, the **key omitted** when unset — and `[]` is never manufactured by the client (contract §2; plan D4). *Needs A-1.*

  > **Task text corrected 2026-10-03.** The original named only two refusals and omitted the **explicitly empty array**, which is the field's third wire state and the one the panel most needs to refuse: 002 FR-047 makes `[]` a refusal on write *and* on read, so no compliant service can send one, and holding a value that means neither *open* nor *those logins* would be exactly the third reading this product refuses to pick silently. 005 v1.11.0 renders that case as *unreadable* rather than as open. The code already refuses it; this records what the code does.

**Delivered (2026-10-03)** — `src/bindings-service.ts` gives `PanelBinding` its `allowedUsers?: readonly string[]`, read by one new fail-closed member reader beside the prompt's: absent stays absent (the complete "no policy configured" state), a list of text round-trips with the **submitted spelling** verbatim, and a non-array, a non-text element, or an explicitly **empty** array each refuse the whole body. The empty-array refusal goes one step beyond the task text's two refusals, deliberately: the service refuses `[]` on write *and* on read (002 FR-047), so a compliant service can never send one, and holding a value that means neither *open* nor *those logins* would be the third reading this product refuses to pick silently — 005 v1.11.0 renders that case as *unreadable*. `| undefined` is explicit because `exactOptionalPropertyTypes` is on and the whole-file write spells the member out on every row. The client-of-record rule is asserted in `tests/bindings-actors.test.ts`: every row carries the array, a cleared field **omits** the key, an edit of another field keeps the list, and no save ever sends `[]`.

- [x] **C-2** [005 FR-090 – FR-092, FR-095] **`src/bindings-actors.ts`** (new module, one responsibility — the allow-list's rendering, mirroring `src/bindings-prompt.ts`) — one field in the binding editor beside the mention-token override, labelled as the set of GitHub logins allowed to trigger dispatches from this repository, whose guidance states **all three** of 002 FR-047's states in the panel's own words including that an empty list is **refused, not "nobody"**, and that disabling the binding is how every trigger stops; free text the operator supplies (**no identity picker** — the host exposes no such API and the panel may not invent one); the row summary shows the **count only**, never a login; a binding with **no** list carries a **visible worded warning** naming who can trigger it and which field restricts it, carrying **text and not colour alone**, phrased as information and **not** as an error; a binding **with** a list shows its count and **no** warning; a service refusal renders the service's own field-level remediation, leaves every other binding byte-identical, is **never** reported as saved, and **never echoes** the submitted value. *Needs C-1.*

**Delivered (2026-10-03)** — `src/bindings-actors.ts` is new and mirrors `bindings-prompt.ts` exactly (plan D13): one field, mounted inside `mountAddForm` directly **beside** the mention-token override (005 clarification row 38), labelled as the GitHub logins allowed to trigger dispatches from *this repository*, with guidance stating all three of 002 FR-047's states — no list means anyone who can open an issue or comment may start a session, a list means only those logins, an empty list is **refused, not "nobody"**, and disabling the binding is how every trigger stops. It is free text with **no identity picker** (005 FR-004), it judges nothing (no folding, no de-duplication, no login-shape rule, no silent dropping of an empty entry), and the only place a save turns the field into a wire value is `allowedUsersPatch`. The **count-only** row clause and the worded **absent-policy warning** live here too: `bindings-rows.ts` takes one clause and decides only where it goes, so a login cannot reach a row even by accident; the warning carries text and **no badge** (FR-083), names who can trigger the binding and the field that restricts it, and is phrased as information. The service's own remediation takes the field's helper slot through `actorsRefusal`, split from the same envelope by the same rule the prompt uses, so one answer can never split two ways (FR-052, FR-095).

- [x] **C-3** [P] [005 FR-090, FR-052, 004 FR-014] **`src/bindings-grant.ts`** — the whole-file write carries the member on **every** row (strip-and-restore, exactly as `PromptPatch` does for the prompt, with the opposite default: omission means unset here); the existing "nothing changed" refusal note stays and gains the allow-list's own field-level slot. *Needs C-1.* *Tests*: the body carries `allowedUsers` on every row; the one edited binding carries the operator's array; a cleared field omits the key; a refusal changes nothing and is not reported as saved.

**Delivered (2026-10-03)** — `src/bindings-grant.ts` rebuilds every row through `rowForGrant`: an untouched prompt is still stripped and omitted, while the allow-list rides **every** row — the array when it has one, the **key omitted** when the operator cleared it — which is `PromptPatch`'s strip-and-restore with the opposite default (002 FR-047, contract §2). Two things the task text did not name had to move with it, both consequences rather than choices: `PreparedBinding` gained `allowedUsers` (in the new `bindings-draft.ts`, so an edit of any *other* field cannot silently take a restricted binding back to open — the bug this rule prevents), and both save paths now fill the allow-list's field-level refusal slot beside the prompt's. All four named cases are asserted on the raw request body in `tests/bindings-actors.test.ts`.

- [x] **C-4** [P] [005 FR-093, NFR-113] **Status states the count and the consequence** — `service/routes/status.ts` + `service/routes/events.ts` (`readStatusRows`): each `repositories[]` row gains `actorPolicy` (`'open' | 'restricted'`, **never the logins**), derived from the binding the row is already built from. `src/status-document.ts`: the fail-closed parser gains the member and **refuses the whole document** on an unrecognized value *or* an absent one. `src/status-lines.ts` + `src/status-tab.ts`: one line stating how many of the listed bindings carry **no** list plus the consequence; a count of **zero** renders as a **positive statement**, never as an absent row; where the service could not be read the line reads **not available** with the service named; Status **names no login and no repository** and points at the Bindings tab. *Needs B-1 (the policy shape it reports is the same closed union).*

  > **Task text corrected 2026-10-03.** The original said only *"refuses an unrecognized value"* and did not say what an **absent** `actorPolicy` does. The implementation refuses the document for **both**, and that is a deliberate choice rather than a default: a status row has no *"no authorization recorded yet"* state the way a run row does (003 FR-079), because the service re-derives the shape from the binding on every projection — so an absent member means the document is from a build that does not report it, and the two defaults it would invite are exactly the ones NFR-113 forbids: `'open'` would imply *any human actor may trigger* for a binding nobody has said anything about, and `null` would render as a third policy word the wire does not have. Refusing the document is the fail-closed direction (invariant 8): the operator sees *not available* with the service named, which is true, instead of a count of open bindings that was never reported. The code already behaves this way; this records the decision and its reason.

**Delivered (2026-10-03)** — `actorPolicy` is derived in the one `readStatusRows` projection (`service/routes/events.ts`) from the binding each row is already built from — absent member means `'open'`, present means `'restricted'`, never a login (005 plan D17, contract §8) — and rides the claim answer's `status` array with it. `service/routes/status.ts` adds the member to `StatusRepositoryRow` and sets it on the unreadable row too, because it comes from the binding rather than from the scan projection. `src/status-document.ts` requires it and **refuses** both an out-of-vocabulary value and an absent one: a document that cannot say which bindings are open cannot honestly answer FR-093, and NFR-113 forbids exactly the two defaults that would let it through. `src/status-lines.ts`'s `actorPolicyLines` prints one line — `1 of 3 bindings lets anyone who can open an issue or comment start a session`, a **positive** *every binding restricts who may trigger* for the zero case, an honest *no bindings yet*, and *not available* with the service named when nothing was read — and `src/status-tab.ts` paints it even on the failed-read frame, because an operator who cannot see the line cannot tell a missing warning from a panel that did not check. No login and no repository is named anywhere on it; it points at the Bindings tab.

- [x] **C-5** [P] [005 FR-094, 002 FR-044/NFR-011] **The dispatch row names the actor and, where it is a proxy, its basis** — `src/dispatches-rows.ts`: each source reference in the reveal carries its **own** actor and basis; a `subject-author` basis renders in the panel's own words — ~~that GitHub records the issue or pull-request author and **does not record who assigned or requested the review**~~ **WITHDRAWN at 002 v1.12.0 / 005 v1.13.0: GitHub DOES record both, in `assigner` and `review_requester`** — so a proxy is never presented as a fact *(that duty survives; the claim does not — see 005 FR-094 as re-cut at v1.13.0)*; a coalesced run's unallowed rider is therefore **visible rather than silent**; a `blocked:actor-not-allowed` row names the **denied** login and 003's reason; the row never predicts the service's verdict (FR-046) and every string goes through the non-HTML path (FR-080). *Needs B-5 (the row's members) and B-6's DTO.*

**Delivered (2026-10-03)** — The actor clause lives with the vocabularies it names: `run-actor.ts` now owns `SUBJECT_AUTHOR_BASIS` and `actorPhrase` — the **one** rendering of an actor and its basis, so the row and the reveal cannot word the same reference two ways. `direct` gives the login alone; ~~`subject-author` gives the login plus the panel's own words that GitHub records the issue or pull-request author and **does not** record who assigned or requested the review~~ **SUPERSEDED at 005 v1.13.0 — that copy asserted a falsehood and is withdrawn; GitHub records both actors, in `assigner` and `review_requester`.** Phase 6 re-cuts it per 005 FR-094 as re-cut: a `direct` row renders no basis clause at all, and a legacy `subject-author` row renders a *historical* clause saying the attribution was made under the rule in force when the row was written. The 'one rendering' design and the *actor not recorded* absent case survive unchanged (002 FR-044, NFR-011 as re-cut at 002 v1.12.0); an absent member reads *actor not recorded* rather than being filled in. `dispatches-rows.ts` adds the clause to every reference in its own reason list, and each reference in the reveal carries its **own** actor and basis — which is what makes a coalesced run's unallowed rider visible rather than silent (003 FR-011, FR-077). The refused run needed no new copy: B-5's row already renders the service's own reason, and `tests/dispatches.test.ts` now pins that it names the denied login and its basis, that Retry stays offered, and that a second render of an unchanged row is byte-identical — the panel renders the verdict it was given and never predicts one (FR-046).

- [x] **C-6** [P] [005 AC-142 – AC-146, SC-113] **Rendering acceptance proof** — `tests/bindings-actors.test.ts` (new): the field's three states, the guidance text, the count-only row summary, the absent-policy warning's wording and non-error phrasing, the refusal split with no echo, and **the exactly-once count** — with twelve permitted logins on one binding, the twelve strings appear **exactly once** panel-wide, in the editor field, and the row reads *12 users*. `tests/status-tab.test.ts`: `1 of 3 bindings…`, the all-restricted zero case as a positive statement, and the unreachable case as *not available*. `tests/dispatches.test.ts`: AC-145's actor/basis/refused-run fixtures. **A string scan** across every user-facing string for *protected*, *restricted*, and *secure*, asserting each appears only about a binding the service reported as `restricted` (NFR-113, AC-146). *Needs C-2 … C-5.*

**Delivered (2026-10-03)** — `tests/bindings-actors.test.ts` is new and holds the seven promises: the field's three states and its guidance words; the count-only row summary; the absent-policy warning's wording, its non-error phrasing, and the absence of any badge; the refusal split with no echo and nothing else changed; C-3's four wire cases; and **the exactly-once count** — with twelve permitted logins on one binding and all six tab bodies mounted, each of the twelve strings is carried by exactly **one** element, the editor field's `mountTextField`, and both rows read *12 users may trigger* / *1 user may trigger* while carrying no login. The counter is proved non-vacuous in both directions (it answers 0 for a login no element carries, and more than 1 for a text several unset fields share). `tests/status-tab.test.ts` gains the `1 of 3 bindings…` line, the all-restricted zero case as a positive statement, the unreachable case as *not available* with the service named, the no-bindings case, the parser's refusal of seven out-of-vocabulary and absent `actorPolicy` values, and the unreadable row still counting from what the service said. `tests/dispatches.test.ts` gains AC-145's fixtures: direct and `subject-author`, a coalesced run whose late rider keeps its own basis, the unattributed reference, and the refused run. The **copy-honesty guard** (AC-146) is two scans: a composition sweep over every string the Bindings rows, every Status line family, and the dispatch row with its reveal produce while **every binding is reported `open`** — and the same surfaces with every binding `restricted`, proving the sweep can find the word — plus a source sweep over every string **literal** in `src/`, with an explicit three-entry exemption list (extension-storage permissions, the wire union's own literals, the audit-retention protected set) each re-asserted to still carry its word. Comments are excluded on purpose: AC-146 is about user-facing strings, and a module may say `restricted` freely while documenting the rule. `tests/service-status.test.ts` gains the service-side derivation, and `tests/{style,visual-structure}.test.ts` their `actorPolicy` member.

**Wave 3 boundary**: `npm run verify` green; both rebuilt bundles committed with the wave. **This is the release-candidate gate for issue #9.**

---

## Wave 4 — 002 v1.13.0: the binding history scope (GitHub issue #22) — **DELIVERED**

**Goal**: one optional binding member that says where a scan window's lower bound comes from, and one
requirement that keeps data-loss recovery working while it does.

**Independent test** (002 AC-032 – AC-043): drive the fixture GitHub against one binding per mode and
read the enqueued events; clear the queue through the recovery path and read them again; drive the
bindings document through both write paths and read the refusals.

> **Delivered 2026-10-05.** Waves 1–3 delivered the v1.11.0/v1.12.0 allow-list and
> attribution work; this wave delivered the v1.13.0 history scope. Every task below is
> implemented, `npm run verify` is green, and the proof suites are
> [`tests/history-scope.test.ts`](../../tests/history-scope.test.ts) (contract §5, twenty-two
> rows) and the mode table inside `tests/service-events.test.ts` (the acceptance matrix).
>
> **Reconciled at Phase 4/5 on 2026-10-05.** The block was drafted in Phase 3 against the
> pre-fold draft spec and renumbered when the feature folded into 002, so **every `FR-…` bracket
> below was audited against the final numbering** (`FR-053 – FR-094`; `D-10`'s old
> `[FR-032 – FR-043]` named pre-existing requirements and is corrected). Three things changed
> substantively, all consequences of the Phase-4 representation decisions in
> [`plan.md`](./plan.md) §B.4:
>
> 1. **The retained baseline is `baselineAt`, a member of the per-binding scan-state slot**
>    (plan **H2**, gate item 1), together with `forceReplay` (**H4**) and `rescanFrom` (**H5**,
>    gate item 3) — so `D-4` now owns all three durable facts and `D-5` derives rather than
>    stores. Contract §5.12 is unchanged by that choice.
> 2. **FR-084's caller is armed in the write path** (`D-2`, beside the merge that already
>    knows what changed) and **consumed in the scan path** (`D-6`). That is what broke two
>    `[P]` markers: `D-2` and `D-3` both touch `service/routes/bindings.ts`, so they are
>    sequential, and the observer (`D-3`) no longer edits the route at all.
> 3. **`windowFor` stops returning `string | null`** (**H11**), so the five downstream
>    consumers are untouched and the branch that admitted every observation is **deleted**
>    rather than merely unused.

- [x] **D-1** [P] [002 FR-053 – FR-062] **The field and its rule set** — `service/bindings-history-scope.ts` (**new**, mirroring `service/bindings-allow-list.ts`) holds the closed union `'new-only' | 'recent-history'`, `DEFAULT_HISTORY_SCOPE`, the two-name reader `historyScopeOf(raw)` returning `{ scope } | { issue }` in the same shape as `bindingAllowedUsersOf`, and the **look-back constant with its own bound** — **604,800,000 ms, bound 3,600,000 – 2,592,000,000 — declared outside `ServiceConfig` and outside `NUMERIC_BOUNDS`** (FR-059, plan H10). `service/bindings.ts` adds `BindingRecord.historyScope?`, wires the reader into `assembleBinding` (absent → key **omitted**, so absence stays the default rather than a stored spelling) **and** into `parseBinding`'s collect-every-refusal second pass so a bad mode and a bad repository arrive in one `422`. Accept exactly the two names; treat a stored/submitted `null` as **cleared to the default** (FR-062) and **refuse** a number, boolean, object, array, `''`, and an unrecognized string with a remediation naming both accepted names and **zero** characters of the submitted value (FR-061). `service/config.ts` is **not touched** — add a test asserting the length appears in **no** configuration document, schema projection, Settings row, or route, and that `NUMERIC_BOUNDS` still carries exactly its twelve documented fields. *Tests* (`tests/service-bindings.test.ts`): both names round-trip byte-identically; absent and `null` both read as the default; each of the six bad shapes refused on **write**, and the same six refused on a hand-edited **read** with the file quarantined and a reason logged; every issue collected together; a pre-field document reads with **zero bytes rewritten** and **zero checkpoints touched**.

- [x] **D-2** [002 FR-055, FR-057, FR-084, FR-085, FR-086] **`service/routes/bindings.ts` — the write path** (three concerns, one file, one task because they share one observation of the submission): (a) the **omission-preserves merge**, modelled on the existing prompt merge — read which submitted rows left `historyScope` out **from the raw submission** (by the time validation has normalised a row, "omitted" and "explicitly cleared" have collapsed to the same absent key) and attach the stored value to those rows only, so a client that does not know the member cannot erase a deliberate choice; an explicit `null` must still clear; (b) the **read path's default** — `GET /v1/bindings` returns the documented default for a binding that stores no member, so the operator's surface renders from one source of truth and does not invent one (FR-055, FR-058, plan H13); (c) **FR-084's arming** — when this submission moved a binding to `recent-history` and that binding **has completed a scan**, write `rescanFrom = now − 604,800,000 ms` through `D-4`'s scan-state helpers on `serializeScan`; **editing to `new-only` writes nothing at all** — no checkpoint cleared, no window opened, no queued or dispatched run touched (FR-085), and a binding with no completed scan is left on its own mode-derived baseline rather than armed (plan H6). Order is **document first, then the arming**, both inside the route's existing chain nesting, and a failed arming is a logged `warn` naming the binding — **never** a rollback of a choice the operator can see (plan H14). The observer's two call sites (`D-3`) go here too, beside the prompt observer's. *Needs D-1 (the member and the reader), D-3 (the observer), D-4 (the scan-state helpers). Not `[P]`: this file is shared with `D-3`'s former scope and must follow it.* *Tests*: a submission omitting the member preserves it; one sending `null` clears it; a submission mixing both across rows does neither to the other; a stored binding with no member answers the read with `'new-only'`; an edit into `recent-history` on a scanned binding arms one lower bound and touches no other binding, while the same edit on a never-scanned binding arms nothing; an edit to `new-only` clears no checkpoint and alters no queued or dispatched run; the route table gained **no** operation.
- [x] **D-3** [P] [002 FR-086, FR-088, data-model `eventType`] **The change observer** — `service/history-scope-audit.ts` (**new**), modelled on `service/prompt-audit.ts` and **riding its per-store chain** rather than adding a second one: **one** `binding.history-scope-updated` row per change (the `binding.*` prefix `data-model.md` already reserves, so no new type leaves it), own generated correlation id, `decision: set | changed | cleared`, `details: { from, to, actor }` and **nothing else** — the two fixed names carry no free text, no length and no fingerprint, so no redaction rule and no secret-scan exemption (FR-054). **Reuse the existing observation chain and its trail-seeded baseline discipline**, seeding `from` from the highest-`seq` row per binding and accepting only a value of one of the two names or `null` (the same "trust only a shape a row should have carried" rule the prompt observer applies to a fingerprint); the baseline advances even when the append fails, and a failed append is a logged `warn` naming the binding and the two names, never a rollback. Exposes two calls for the route to make: the observation of a **stored** document with actor `service` and of a **submitted** document with actor `operator`, so a hand edit and a panel save are each recorded exactly once and a submission resending the mode in force writes **nothing**. Assert **no** dispatch-lifecycle type changed and that `poll.observation` is still unwritten. *Needs D-1 (the two names and the member it observes).*
- [x] **D-4** [P] [002 FR-018, FR-023, FR-074, FR-076, FR-077] **The three durable facts** — `service/poll/scan.ts`: the per-binding slot in `scan-state.json` gains **`baselineAt`** (the retained first-scan baseline, `string | null`; `null` = not yet derived, plan H2), **`forceReplay`** (the recovery-replay boolean, `data-model.md`'s Phase-3 row; written by the recovery path alone, **H4**), and **`rescanFrom`** (FR-023's one rescan mechanism — a durable **chosen lower bound for one binding's next scan**, plan H5), each validated **independently** by `parseStoredScanState`, so a pre-amendment file parses, an absent `lastScanAt` is **never** read as a flag, and one unusable member does not take the other two with it. `service/poll/events.ts`: `resetScanWindows` writes **`forceReplay`** rather than producing a state no reader can distinguish from "never scanned". Writers: the poll loop (baseline, and clearing `rescanFrom` on a completing scan), the recovery reset (`forceReplay`), the bindings route (`rescanFrom` — `D-2`). One atomic write per fact change (FR-018); an incomplete scan leaves `forceReplay` set **and** leaves an armed `rescanFrom` armed (FR-076, plan H7). **A binding's slot is keyed by `bindingId` and nothing prunes it**: the panel allocates a new id per binding, so a removed-and-recreated binding gets a fresh slot and a fresh baseline (FR-077), and a slot for a binding the document no longer carries is inert because nothing reads it. `data-model.md` §Checkpoint gains rows for `baselineAt` and `rescanFrom` beside the `forceReplay` row Phase 3 added. *Independent of the field* — this task can start before `D-1` and is `[P]` with it. *Tests* (`tests/service-scan-state.test.ts`): the three facts are each distinguishable in the stored bytes; only the reset writes `forceReplay`; only the mode change writes `rescanFrom`; a pre-amendment file still parses; a scan that fails mid-replay leaves `forceReplay` set and an armed `rescanFrom` armed; a completing scan clears `rescanFrom` in the same write that advances `lastScanAt`.
- [x] **D-5** [P] [002 FR-065 – FR-072, FR-051] **`service/poll/window.ts` — the core rule.** `windowFor()` returns a **verdict**, not `string | null` (plan H11): a tagged `{ window: <stamp> }` or `{ refused: <reason> }`, so there is no value left that means "no lower bound". Resolution order — an armed `rescanFrom` wins (FR-023, FR-084); otherwise a recorded `lastScanAt` minus `overlapMs` (006 FR-059(a)); otherwise the retained `baselineAt` (FR-066, FR-067); otherwise **`refused`** (FR-072), which is the only state in which a binding opens no window — never a widening. The refusal becomes the binding's existing skip reason on the scan slot, so the reason is recorded against that binding (FR-024) and no event, run, or work is created. Retiring the `null` source also retires the unreadable-stamp fallback at `window.ts:58-61` ("an unbounded window is honest"), which FR-065 names as the last route to one. **The baseline is derived from the stored creation stamp and retained**: an **absent** stored stamp falls back to the assembled `binding.createdAt` (a panel-created row legitimately has none), while a **present but unreadable** one refuses (plan H3) — which needs one reader of the stored rows (`service/bindings-read.ts`, read **only** in a cycle where some binding has no baseline yet, so nothing in steady state) and one exported honest-stamp reader beside `stampOrKeep`; derive it **once**, so three failed scans and then a success still open at `createdAt − overlapMs` (FR-066, AC-036). **Everything downstream is unchanged and must be proved so**: `stampInWindow` **loses** its `windowStart === null` arm (that arm is the defect), the `since` the issues/comments list calls carry, the per-item page walk, and the dateless-observation refusal (FR-069). The mode is **not** an input to any of them (FR-068). *Needs D-4 (the slot) and D-1 (the two names). `loop.ts`'s call site, which consumes the verdict, is `D-6`'s — this task touches `window.ts` only.* *Tests*: the five cases of the contract's §3 table; the same fixture in the two modes differing **only** in which observations are in-window; three failed scans then a success still opening at `createdAt − overlapMs`; a creation stamp present but unreadable producing nothing with a recorded reason; and **no input at all refusing rather than returning `null`** — the last assertion is the inversion of the draft's, and it is the wave's structural proof that no stored state opens an unbounded window.
- [x] **D-6** [002 FR-023, FR-068, FR-070, FR-071, FR-075, FR-079 – FR-085] **`service/poll/loop.ts` + the trigger path — consumption** — the `windowFor` call site consumes the verdict: `refused` becomes the binding's skip reason and no scan runs for it; `window` is passed to the list calls and the detectors **unchanged**. Read the mode off the binding **once per binding per scan** and pass the **window**, never the mode, downward (FR-068) — the mode is not a parameter of `stampInWindow`, `pageEndsWalk`, or any detector, and that structural fact is the assertion. Honour and consume `rescanFrom`: it opens the window, and it is cleared by the first scan that **completes** — a scan that fails leaves it armed (plan H7, FR-076). Once a binding has completed a scan its mode is not consulted at all (FR-068), and the mode changes nothing else: no trigger set, no `state`, no dispatch target, no resumption (FR-070). Confirm the sweep is **enqueue-only** — every swept event enters through the ordinary enqueue and nothing starts a session outside the claim-and-lease cycle, one at a time (FR-081, FR-083) — that it is bounded by its window's contents with **no** cap, truncation or sampling (FR-079), **one-shot** by construction (FR-080), and that a repeated sweep changes nothing (FR-082, FR-075). **Build only FR-084's caller**: the mechanism exists (`rescanFrom`, written by `D-2`), and an operator-chosen-timestamp surface, an input for one, and a route for one are **out of scope** and must not be added (`spec.md` `## Out of Scope`; settled 2026-10-05) — the recovery replay, the mode's baseline, and the armed catch-up are **three** distinct facts with one writer each, and a fourth path that opens a window is the one thing this wave must not grow. *Needs D-5 and D-2 (and D-4 through both).*
- [x] **D-7** [P] [002 FR-036, FR-063, FR-078, FR-092] **The health/status projection** — `service/routes/events.ts`'s `readStatusRows`: the per-binding row gains the **window start in force**, the **mode in force**, and the **forced-replay flag**, so both ends of the window can be read together and a burst of older events arriving together is explained from the operator's own surface while the replay is in force (FR-078). All three are **derived state the service computed**, never something the operator set. `src/bindings-service.ts`: the panel reads them leniently (unknown members ignored) and **fail-closed** about the members it knows — an unusable `historyScope` **refuses** rather than defaulting (FR-063), while an **absent** member reads as the documented default, because an older service's answer is not a fault. Assert both directions: an older panel reading a newer row loses nothing it needs, and the panel refuses an out-of-vocabulary mode. *Needs D-1 (the effective mode) and D-4 (the flag and the baseline).*
- [x] **D-8** [P] [002 FR-078, FR-087, FR-088] **The auditability assertions** — assert **no** per-observation row is written for a non-matching item on a cycle that matches nothing, that `poll.observation` / `poll.checkpoint` are still unwritten, that a recovery replay writes **no** row of its own beyond the one the reset path already writes, and that no row exists which could be mistaken for an operator having chosen a sweep. A row per non-matching observation is unbounded in volume — a cycle matching nothing would write one per open item, every cycle — which is why the question is answered from two durable facts instead. *Needs D-3 (the observer) and D-4 (the reset).*
- [x] **D-9** [002 FR-063, FR-089 – FR-094; 005 FR-051, FR-052, FR-053, FR-091] **The panel control** (`src/bindings-draft.ts`, `bindings-editor.ts`, `bindings-rows.ts`) — one control in the binding editor, **both** the create and edit paths, offering exactly the two names and carrying the documented default when the operator chooses nothing. It rides the existing single contextual save, and the panel **never pre-empts** the service: it must not accept input the service will refuse, nor reject input it would accept (FR-063). Its guidance states, in the operator's own words and without opening anything else: what each option does, that the default watches from now on, that the look-back covers a fixed **seven-day** period **once** at creation and does not repeat, that the window is bounded with **no "all history" option**, and that choosing it on an existing binding may offer many sessions at once (FR-090). **The mode is rendered exactly once panel-wide** — as this control (005 FR-051 applied to this value); the row summary **may** show the short label and **may not** show anything else derived from the mode (FR-091), and it is not the only place the operator can see or change it. The window in force, the mode, and the replay flag are **derived state** labelled as the scan window the service computed, not as something the operator set (FR-092). A binding storing no mode renders the **default**; one storing an **unusable** mode renders **unreadable** and says so, never an empty control implying a third choice (FR-093). Keyboard-operable with a visible focus and an accessible name carrying what it decides (FR-094). *Needs D-7.*
- [x] **D-10** [002 FR-053 – FR-094] **The contract-proof suite** — create `tests/history-scope.test.ts` driving the service and panel logic directly (temp-dir store, fixture provider, loopback service): **every** row of [`contracts/binding-history-scope.md`](./contracts/binding-history-scope.md) §5 as an assertion (22 rows), plus that **no permitted mode value** appears in any log line, stored projection, or response other than `bindings.json` and the health row, and that the route table gained **no** operation (`src/` contains no new bindings-route call). §5.12 (the baseline is stable) is the gate item 1 assertion and is **unchanged** by the representation chosen; §5.18 is the gate item 2 assertion — exactly one rescan mechanism in the service and no timestamp-picking surface anywhere. Needs D-1…D-9; assert-fail-first is the gate.
- [x] **D-11** [P] [002 FR-042] **Documentation** — `quickstart.md` and `README.md` state what the history scope is and is not: that a binding watches from its creation boundary unless the operator asked otherwise, that the look-back covers a fixed seven-day period **once**, and that a recovery replay after data loss re-offers work **regardless of the setting**. State the accepted upgrade consequence plainly — a pre-existing binding whose first scan has not completed skips its backlog (FR-058) — so an operator meets it as documentation rather than as a defect. Neither may gain a Settings row for the look-back length.
- [x] **D-12** [P] [002 FR-060, FR-082, SC-009 – SC-013, AC-032 – AC-043] **The acceptance proof** — extend the existing trigger and scan suites (`tests/service-events.test.ts`, `tests/service-triggers.test.ts`, `tests/service-run-enqueue.test.ts`) into the mode table and the duplicate matrix: creation-boundary default coverage; the sweep's exact offered set with **zero** duplicates across *five* sequences (sweep, repeated sweep, recovery replay, repeated recovery replay, restart); **100%** recovery coverage in **both** modes; the refused-baseline case producing no event, no run and no work with its reason recorded; and the **reachability sweep** — every stored-record state enumerated, asserting none yields a scan with no lower bound (FR-060, FR-065, SC-013). *Needs D-1…D-9. Owns only existing suites; `tests/history-scope.test.ts` is `D-10`'s alone.*

**Wave 4 boundary**: `npm run verify` green; rebuilt `service/main.js` **and** `panel/main.js` committed with the wave (invariant 1 — D-1, D-2, D-3, D-4, D-5, D-6, D-7 and D-9 all change bundled source).

**MVP slice if delivery is cut**: `D-1 + D-4 + D-5 + D-6` is the behaviour-bearing half — the field, the durable facts, the window rule, and the sweep's consumption. But it **must not ship without `D-4`**: a window rule that lets the mode govern recovery is worse than the defect this wave exists to remove, and `D-4` is what prevents it. It is also not honestly shippable without `D-9`: a control the operator cannot see or change is the defect the owner conditioned this amendment on, exactly as it was for issue #9. `D-2` is in the slice by dependency (`D-6` consumes what it arms) and `D-7` because `D-9` reads the row it extends.

**Dependencies** (corrected 2026-10-05; the draft's `D-1 ∥ D-3` claim was unsound — `D-3` observes the member `D-1` adds):

| Task | Needs | Why |
| --- | --- | --- |
| **D-1** | — | the field's vocabulary; everything else that reads the mode needs it |
| **D-4** | — | the durable facts; independent of the field, so it can start first |
| **D-11** | — | the approved text is the only input |
| **D-3** | D-1 | the observer reads the stored member and the two names |
| **D-5** | D-1, D-4 | the window rule consults the slot and the mode |
| **D-2** | D-1, D-3, D-4 | the write path: the merge, the read projection, the observer's call sites, and the arming |
| **D-7** | D-1, D-4 | the row reports the effective mode, the window in force, and the flag |
| **D-8** | D-3, D-4 | the assertions are about what the observer and the reset write |
| **D-6** | D-2, D-4, D-5 | consumption: the verdict, the armed catch-up, the sweep's enqueue-only proof |
| **D-9** | D-7 | the control renders from the row |
| **D-10** | D-1 … D-9 | the contract proof asserts the finished behaviour |
| **D-12** | D-1 … D-9 | the acceptance proof likewise |

**Genuinely parallel**, and only in these four bands — inside a band the tasks own disjoint files, which is the whole claim:

| Band | Parallel tasks | Files they own |
| --- | --- | --- |
| 1 | **D-1** `[P]`, **D-4** `[P]`, **D-11** `[P]` | `bindings-history-scope.ts` (new), `bindings.ts` · `poll/scan.ts`, `poll/events.ts`, `data-model.md` · `quickstart.md`, `README.md` |
| 2 | **D-3** `[P]`, **D-5** `[P]` | `history-scope-audit.ts` (new) · `bindings.ts` (one exported reader), `bindings-read.ts`, `poll/window.ts` |
| 3 | **D-2**, **D-7** `[P]`, **D-8** `[P]` | `routes/bindings.ts` · `routes/events.ts`, `src/bindings-service.ts` · existing audit suites only |
| 4 | **D-6**, **D-9** | `poll/loop.ts` + the trigger path · `src/bindings-draft/editor/rows.ts` |
| 5 | **D-10**, **D-12** `[P]` | `tests/history-scope.test.ts` (new) · existing trigger and scan suites |

Three file-ownership rules make the bands hold, and each one exists because a draft task would otherwise collide: **`D-5` touches `poll/window.ts` only** — the `loop.ts` call site that consumes the new verdict is `D-6`'s, because the two touch adjacent files and are two bands apart anyway. **`D-3` adds a module and no route edit**, which is what keeps it `[P]` against `D-5` and sequential against `D-2`. **`D-10` owns `tests/history-scope.test.ts` alone** and `D-12` extends only existing suites, so the two proofs never open the same file.

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

Wave 4 (corrected 2026-10-05 — five internal bands; see the dependency table above)

  band 1   D-1 [P] the field and its rule set   ∥  D-4 [P]  the three durable facts  ∥  D-11 [P] the docs
              │
              ├──────────────▶ D-3 [P]  the change observer (a module, no route edit)
              ├──────────────▶ D-5 [P]  the window rule ◄── D-4
              │                  │
  band 2   D-7 [P] the health row ◄── D-1, D-4   ∥  D-8 [P] the auditability assertions ◄── D-3, D-4
              │
              ├──────────────▶ D-2  the write path ◄── D-1, D-3, D-4
              │                  │
  band 3   D-9  the editor control ◄── D-7         D-6  consumption, through FR-023's one rescan path
              │                                                    (◄── D-2, D-5)
  band 4   D-10  the contract proof  ∥  D-12 [P]  the acceptance proof   (both need D-1…D-9)
```

- **Wave 4 is a separate delivery from Waves 1–3** and may run without them: it shares no task and no file with the allow-list work except `service/bindings.ts`, which `D-1` extends and `D-5` adds one exported reader to, rather than re-cutting. Its spine is `D-1 → D-5 → D-6`, and `D-4 → D-5` is a hard edge with a reason — the durable distinction must exist before the window rule can consult it, or the rule has nothing to keep recovery working. **`D-4` is not optional within the wave**: shipping `D-5` without it is the one outcome this wave exists to prevent.
- **Wave 4's own shape, corrected**: the draft claimed `D-1 ∥ D-3 ∥ D-4 ∥ D-7 ∥ D-11` in one parallel set. That was wrong in two directions — `D-3` observes the member `D-1` adds, and `D-7` reports the mode `D-1` defines and the flag `D-4` writes, so none of the three can precede `D-1` — and it omitted that `D-2` and `D-3` shared `service/routes/bindings.ts` until the Phase-4 decision moved the observer into its own module. The five bands above are the corrected claim, and **only the bands** are parallel.
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
  Wave 4's own edges are the table above rather than a duplicate list here.
- **MVP slice if delivery is cut**: `A-1` + `A-2` + `A-3` + `A-5` + `B-1` + `B-2` + `B-3` — the
  model plus the gate and its trail — is the security-bearing half. **But no wave boundary ships
  without `npm run verify` green and both bundles rebuilt and committed**, and the feature is not
  honestly shippable without `C-2` and `C-4`: a control the operator cannot see or change is the
  defect the owner conditioned the whole amendment on.

---

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

### Corrected routing recommendation for **Wave 4** (2026-10-05)

**The recommendation above was correct for what it described and does not describe Wave 4.** It counted
the whole issue-#9 consolidation — **20 tasks, 13 `[P]`, three features, three waves** — and cited `B-2`
and `C-6`, which are delivered. It is left exactly as written as the record of that decision.

**Wave 4 alone: 12 tasks, 4 of them `[P]`, five internal bands — architect delivery with two review
gates. Not multi-wave orchestration, and not a single flat dispatch either.** The honest reading of the
bands (≤5 architect solo · 6–15 architect with review gates · >15 multi-wave delivery) puts 12 tasks in
the **middle** band, so:

- **One dispatch, one implementer, sequenced by the five bands.** One feature, one spec amendment, one
  branch, one file set, one `npm run verify` gate. Splitting it across waves would buy parallelism the
  bands do not offer — the longest genuinely parallel set is **three** tasks (`D-1 ∥ D-4 ∥ D-11`, then
  `D-3 ∥ D-5`) — and would cost a bundle rebuild and commit at every seam for no gain.
- **Gate 1, after band 2** (the model, the durable facts, the window rule, the write path, and the two
  assertion tasks are all in place; the consumption and the control are not). This gate exists because
  the constitution-II/III risk in this wave is **not** in any single task: it is in the two
  window-opening paths that **widen** a window, where a dedupe gap becomes duplicate *work* rather than
  a duplicate log line. What the reviewer should read, in this order: `window.ts`'s new verdict and the
  four states that can produce it; `resetScanWindows` writing the flag instead of implying one; the
  write path's arming order and its no-rollback rule; and `stampInWindow` **losing** its
  `windowStart === null` arm rather than merely not being called with one. The reviewer's question is
  one sentence — *for each of the three paths that opens a window, what exactly deduplicates a trigger
  observed twice?* — and the answer must be the delivery key in `enqueueEvents`, unchanged.
- **Gate 2, at the wave boundary**, before the rebuilt `service/main.js` and `panel/main.js` are
  committed: `npm run verify` green, `D-10`'s 22 contract rows green, `D-12`'s five-sequence
  duplicate matrix green, and a re-read of [`plan.md`](./plan.md) §B.8's out-of-scope guard — whose
  highest-value assertion is that the service contains **exactly one** rescan mechanism and **no**
  timestamp-picking surface (contract §5.18).
- **What does *not* need its own review**, said so the gate list is not padded: there is no security
  boundary in this wave. `D-2`'s refusals are an enum with no credential-shaped value, and the
  secrets story is the *absence* of a story (two fixed names — no free text, no fingerprint, no
  redaction rule, invariant 9). The constitution-II analogue of `B-2`'s security gate is Gate 1 above,
  and it is a **dedupe** review, not a permissions review.

**Routing for the two flags that remain open**: items 1 and 3 are **resolved** by this phase (plan
§B.9), so nothing in Wave 4's dispatch waits on the owner. The three residuals in
§"Items flagged at the Phase-5 gate" below are **decisions already made for planning** with their
rejected alternatives recorded; a reviewer who disagrees needs a **spec amendment**, not a code change,
and none of the three gates a dispatch.

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

## Requirement → task coverage (v1.13.0 block)

Audited 2026-10-05 against the **final** numbering. Grouped by the spec's own sub-blocks; every one
of the 42 new requirements has a task, and no task cites a requirement outside `FR-053 – FR-094`
except the four pre-existing ones each genuinely touches.

| 002 v1.13.0 requirements | Owning task | Also asserted by |
| --- | --- | --- |
| **I.1** FR-053 (the two names, the default), FR-054 (service-owned), FR-056 (the write path rides the whole-file grant), FR-058 (absence has one reading, the upgrade writes nothing), FR-059 (the constant, not a field), FR-062 (`null` is cleared) | **D-1** | D-2 (056), D-10 (054, 058, 059) |
| **I.1** FR-055 (the read returns the documented default), FR-057 (omission preserves) | **D-2** | D-10 |
| **I.2** FR-061 (one rule set, refused whole) | **D-1** | D-10 |
| **I.2** FR-063 (the panel reads fail-closed and never pre-empts) | **D-7** | D-9, D-10 |
| **I.3** FR-064 (no new surface), FR-060 (no stored state asks for an unbounded window) | **D-10**, **D-12** | — |
| **I.3** FR-065 – FR-072 (every window has a lower bound; both baselines; the mode reaches no comparison; the mode gates and widens nothing; an unresolvable baseline refuses) | **D-5** | D-6 (068, 070, 071), D-12 (069, 072) |
| **I.4** FR-073 (recovery replays in both modes), FR-074 (two facts, two writers), FR-075 (replay is duplicate-free and audited), FR-076 (a replay survives an incomplete scan), FR-077 (a recreated binding starts over) | **D-4** | D-5 (073), D-6 (075), D-10 |
| **I.5** FR-078 (a replay is visible while in force) | **D-7** | D-8 |
| **I.5** FR-079 – FR-083 (bounded, one-shot, enqueue-only, idempotent, page-bounded) | **D-6** | D-4 (080's durable half), D-12 (082), D-10 |
| **I.5** FR-084 (the mode edit's bounded catch-up, through FR-023's one mechanism), FR-085 (the reverse edit replays nothing) | **D-2** | D-6, D-10 |
| **I.6** FR-086 (one row per change), FR-088 (nothing else in the trail changes) | **D-3** | D-2 (086's call sites), D-8 (088) |
| **I.6** FR-087 (no per-observation row; the answer is two durable facts) | **D-8** | D-7, D-10 |
| **I.7** FR-089 – FR-094 (one control, its guidance, one rendering, derived state, honest absence, keyboard) | **D-9** | D-7, D-10 |
| **Pre-existing, touched** FR-018 (the atomic write), FR-019 (dedupe), FR-023 (the one rescan mechanism), FR-024 (fail closed), FR-051 (the `since`-less comparison), FR-035 (the trail records a change), FR-036 (health carries the window), FR-042 (the two documents), 006 FR-059(a) (`overlapMs` subtraction) | spread across D-2, D-4, D-5, D-6, D-7, D-11 | D-10 asserts the *unchanged* ones |

## Acceptance criterion → task coverage (v1.13.0 block)

| 002 v1.13.0 criterion | Tasks |
| --- | --- |
| **AC-032** (no stored state yields no lower bound; the look-back is not a configuration field) | D-1, D-5, D-10 |
| **AC-033** (absent reads as the default; omission preserves; `null` clears; no migration) | D-1, D-2, D-10 |
| **AC-034** (write refusals whole, no echo, quarantine on read, panel reads unreadable) | D-1, D-7, D-9, D-10 |
| **AC-035** (the creation boundary is the window; no `since` anywhere it does not exist) | D-5, D-6, D-10 |
| **AC-036** (the baseline is stable across failed scans) | D-5, D-12 |
| **AC-037** (the look-back sweep: exact set, one-shot, zero duplicates) | D-4, D-5, D-6, D-12 |
| **AC-038** (an unreadable baseline yields nothing) | D-5, D-10, D-12 |
| **AC-039** (recovery replays in both modes; the two facts differ; the replay survives a failure) | D-4, D-5, D-6, D-10 |
| **AC-040** (the sweep is enqueue-only and page-bounded) | D-6, D-10 |
| **AC-041** (both edits; one rescan path; the control, its guidance, and its rendering) | D-2, D-6, D-9, D-10 |
| **AC-042** (one row per change; no per-observation row; the health row's three facts) | D-3, D-7, D-8, D-10 |
| **AC-043** (no new route, capability, or manifest change; the mode gates nothing; the docs) | D-9, D-10, D-11 |

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

## Items flagged at the Phase-4 gate for Wave 4

**All three are closed. Item 2 was settled by the product owner on 2026-10-05; items 1 and 3 were
resolved by this phase's planning, as representation choices.** The resolutions and their rejected
alternatives are in [`plan.md`](./plan.md) §B.4 (`H2` and `H5`) and summarised in §B.9; nothing in
Wave 4's dispatch waits on the owner. The original questions are kept below as the record of what was
asked.

1. ~~**Where the retained baseline lives.**~~ **RESOLVED — `baselineAt`, a member of the per-binding
   slot in `scan-state.json`, beside `lastScanAt`** (plan **H2**, §B.9). Scan state is where the
   product keeps per-binding scan facts, it has one writer per fact, and no operator surface reaches
   it; the binding record is the operator's own document, `writeBindings` persists records verbatim,
   and a machine-written stamp there would need a fourth omission-preserves merge, its own refusal
   rule, and a hand-edit hazard nobody asked for. The argument for the binding record — that it is
   "what the operator's surface can read directly" — does not survive the requirement: FR-092 asks the
   surface for the **window start in force**, which is derived from the baseline and is what actually
   gets reported, so the baseline itself never needs a direct read. `data-model.md` had already put
   Phase 3's `forceReplay` row on the scan side. **D-10's §5.12 assertion is unchanged by the choice**,
   as flagged.
2. ~~**The shape of "operator edited into `recent-history`"**~~ — **SETTLED 2026-10-05 by the product
   owner: build only what FR-084 requires.** No longer a question for planning. The finding was that
   FR-023's chosen-timestamp surface does not exist in `service/routes/` and never has (verified;
   `research.md` §R10.2b), so "reuse FR-023" resolves to *build one rescan mechanism, and build only the
   caller the new requirement names*. **What that means concretely**: `D-4` declares the mechanism
   (`rescanFrom`, plan **H5**), `D-2` wires FR-084's mode-change caller to it as the **only** writer,
   and `D-6` consumes it; **no** operator-chosen-timestamp surface, input, or route is added anywhere.
   FR-023 was narrowed at the same time so it no longer promises that surface, and the gap is recorded
   by name in `spec.md` `## Out of Scope`. `D-10`'s §5.18 assertion is the check: exactly one rescan
   mechanism in the service, and no timestamp-picking surface.
3. ~~**Where the catch-up's per-binding window is recorded.**~~ **RESOLVED — in the same per-binding
   scan-state slot, as its own member `rescanFrom`** (plan **H5**, §B.9) — which is also the answer to
   (1) for that caller, and deliberately **not** the retained baseline: the baseline is what a later
   recovery replay must still cover, and overwriting it with a catch-up bound would silently change
   that. One file, one chain (`serializeScan`), one writer per fact, and one place the window in force
   is computed from — which is also what FR-092's health row reports.

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

### Wave 4 additions (2026-10-05) — three points where a disagreement needs a **spec amendment**

None of the three gates a dispatch: each is **decided for planning**, with the rejected alternative
named, so an implementer following this file cannot get it wrong. They are recorded here because a
reviewer who disagrees cannot resolve them in code.

1. **Where the baseline's source stamp comes from** (plan **H3**). `assembleBinding` runs
   `stampOrKeep(raw.createdAt, nowIso())`, so the assembled `createdAt` is `now` both when the panel
   submitted no stamp (legitimate on create) and when a hand edit left a corrupt one. Deriving the
   baseline from the assembled value makes FR-072 and AC-038 unreachable — a corrupt stamp would
   silently become a window of `now − overlapMs`. The plan therefore reads the **stored** row through
   one purpose-built reader (003's `readBindingsForAuthorization` is the precedent), used only in a
   cycle where some binding has no baseline yet. **If the owner prefers the cheap reading**, then
   FR-072's "creation stamp the clock cannot read" clause and AC-038 must be narrowed to the
   **recorded-stamp** half, and the edge case in `spec.md` re-worded with them. Rejected alternative:
   refusing an unusable `createdAt` outright — a new refusal on a field this amendment does not
   otherwise touch, which quarantines the whole document where FR-072 asks one binding to stop.
2. **An armed catch-up that meets a failing scan** (plan **H7**). FR-076 says the **forced replay**
   survives an incomplete scan; it says nothing about the **catch-up**. The plan extends the same
   durability to it, because a single transient credential failure on the cycle after the edit would
   otherwise discard an explicit operator request with nothing left to show that it existed.
   **If the owner disagrees**, FR-076's sentence has to widen to name both one-shots, because
   "consume on the first attempt" is not an implementation detail — it is a different behaviour.
3. **A hand-edited same-`bindingId` re-creation** (plan **B.4 `H2`**, `D-4`). FR-077 says a recreated
   binding is a new record with a new baseline, and a **panel** re-creation always allocates a new
   `bindingId`, so the requirement holds for every supported flow. A *hand-edited* document that
   removes a binding and later re-adds it under the **same** id would inherit the old baseline and any
   armed catch-up, because nothing prunes a slot. The plan accepts that and prunes nothing, because the
   only flow that produces it is unsupported and a pruning write on every document read would be worse.
   **If the owner disagrees**, pruning belongs in `D-2` (the route's grant write, where document
   membership is authoritative) — not in a read path.
