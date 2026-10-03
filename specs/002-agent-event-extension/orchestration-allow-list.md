# Orchestration State: issue #9 — user allow-list on bindings

**Durable state file — a fresh coordinator must be able to resume from this file alone.**
Namespaced beside `orchestration.md` (which records the delivered 002 MVP and is NOT superseded).

## Current Wave

**Wave 3 complete** (`C-1 … C-6`, delivered 2026-10-03) and the **pre-PR review-fix pass**
complete (2026-10-03). The branch is ready for its PR.

## Branch

`issue-9-user-allow-list` (base `bb7947f`, not protected). Six commits landed: three feature
commits (`99e2a5c`, `713c58c`, `9014522`), two review-fix commits (`a214b42`, `5ff2276`),
and the phase 4–5 planning artifacts (`1799ec3`, committed by the PM). Working tree clean.

## Scope

This delivery **amends three existing specs** — no new spec directory:

| Spec | Version | Block | Owns |
| --- | --- | --- | --- |
| `002-agent-event-extension` | v1.10.0 → v1.11.0 | H (FR-043–048) | `allowedUsers` field, actor on the event row |
| `003-dispatch-integrity` | v1.7.0 → v1.8.0 | I (FR-076–080) | the gate in `dispatch-authorize.ts`, refusal rows |
| `005-panel-ia` | v1.10.0 → v1.11.0 | J (FR-090–095) | the Bindings-tab rendering |
| `006-settings-crud` | **untouched, deliberately** | — | per-binding field; `GET /v1/config` describes one global document |

Consolidated `tasks.md`: `specs/002-agent-event-extension/tasks.md` (tasks `A-*`, `B-*`, `C-*`).
New contract: `specs/002-agent-event-extension/contracts/binding-allow-list.md`.
20 tasks, 13 `[P]`.

## Tasks

| Wave | Tasks | Owner | Status |
| --- | --- | --- | --- |
| 1 | A-1 … A-7 | `modern-architect-engineer` | **done** — 628 tests green from 603; `npm run verify` green |
| 2 | B-1 … B-7 | `modern-architect-engineer` | **done** — 644 tests green from 628; `npm run verify` green |
| 3 | C-1 … C-6 | `modern-architect-engineer` | **done** — 653 tests green from 644; `npm run verify` green |
| 4 | pre-PR review fixes (not a spec wave) | `modern-architect-engineer` | **done** — 657 tests green from 653; `npm run verify` green |

Dependency spine (from `tasks.md` hard-dependency list):

```
A-1 ∥ A-2 ∥ A-3 → A-5 → A-6 ∥ A-7      (A-4 ← A-1)
B-1 → B-2 → {B-3, B-4} → B-5 → {B-6, B-7}
C-1 → {C-2, C-3}; C-4 ← B-1; C-5 ← B-5 → C-6
```

### Plan defect found at orchestration start (not yet corrected in `tasks.md`)

The wave **graph** (line 208) places `A-4` parallel with `A-1`, but the **hard-dependency**
list (line 254) says `A-4 ← A-1`. `A-4` creates `tests/allow-list.test.ts`, which *drives*
`service/bindings.ts` — the file `A-1` rewrites. The dependency list is correct and the graph
is wrong. **Resolution taken: `A-4` runs after `A-1`.** Recorded here rather than silently
patched, since `tasks.md` is the planner's approved artifact.

### Deliberate deviation from per-task parallel dispatch

`tasks.md` marks 13 tasks `[P]`, but **all agents share one working directory and one git
index**. Concurrent agents rewriting sibling files would each see a half-finished tree and
compete for the index. Therefore each **wave is dispatched as a single architect subagent**
covering its tasks in dependency order, with one wave-close `npm run verify` and one commit
per wave. Cost: some wall-clock parallelism forgone. Benefit: no cross-agent interference,
no lost commits, far lower orchestration overhead.

## Decisions

- **2026-10-03 — issue amended in place, no `specs/007-*`.** Precedent: issue #10 amended
  004 v1.3.0 with scoped amendments to 005/006. Same shape here.
- **2026-10-03 — 006 not amended.** `allowedUsers` is per-binding; a thirteenth
  `FieldDescriptor` would be a global dial applying to no particular repo, and 006 has no
  take-effect class for it. Recorded in all three amendment entries.
- **2026-10-03 — constitution NOT amended.** Principle II forbids *ambiguous* authorization,
  not *open* authorization. The absent allow-list must be visibly open; that is what satisfies
  II. Amending a principle to accommodate one feature decision is the weakening §Governance
  warns against.
- **2026-10-03 — owner rulings at the phase-3 gate.** (a) Coalesced runs: **authorize when at
  least one** source reference names an allowed actor (003 FR-077 / clarification row 23). Both
  alternatives permanently wedge runs, because `blocked:*` runs are non-terminal and new
  deliveries *join* them. (b) The **Status surface stays** (005 FR-093).
- **2026-10-03 — owner rulings at the phase-5 gate.** (a) **Blank field = back to open**: the
  panel omits the key when the field is blank; `[]` remains a service-level guard reachable only
  by hand-edit or direct API PUT. (b) **Multi-wave orchestration** chosen over a single pass.
- **2026-10-03 — NO MIGRATION.** Unreleased (pre-1.0.0, `version` 0.0.1), no external users;
  owner can delete their local install. No back-compat shim, no old-document fallback, no
  upgrade path. This is why plan D1/D2 make `schemaVersion` a contract version rather than a
  stored member, and actor members absentable on read — a stored version would quarantine
  every pre-existing `events.json`.
- **2026-10-03 — `buildEventId` frozen** (002 FR-046, invariant 10). The actor rides the event
  row but never the identifier. Pinned by a byte-identity test in A-3 and A-7.

## Blockers

None open.

## Verification

Phase 0: specs carry **zero unresolved `[NEEDS CLARIFICATION]` markers** (grep-verified — all
33 token hits are house-style attestations of absence). 1,718 planning insertions across 26
files.

Wave 1 close: **`npm run verify` green** (build -> lint -> typecheck -> test) — 103 files,
**628 tests passed** (from 603). `service/main.js` rebuilt and committed with the wave
(invariant 1). `buildEventId`, `discriminatorOf`, and `SERVICE_SCHEMA_VERSION` are untouched; no
`schemaVersion` member was added, and a pre-1.2 `events.json` row still parses.

Wave 2 close: **`npm run verify` green** — 103 files, **644 tests passed** (from 628). Both bundles
rebuilt and committed with the wave (invariant 1). `SERVICE_SCHEMA_VERSION` stays `1`, no
`schemaVersion` member exists, `buildEventId` and `discriminatorOf` are untouched, no audit
`eventType` was added, and `isActorAllowed` appears in exactly **two** source files.

Wave 3 close: **`npm run verify` green** — 104 files, **653 tests passed** (from 644). Three
modules moved for the file-length gate (`accounts-service`, `bindings-draft`,
`bindings-state`); every moved name stays importable from where it was.

### Pre-PR review-fix pass, 2026-10-03 — what a fresh coordinator must know

Two reviews ran at the pre-PR gate (a code-quality peer review: **APPROVE WITH FIXES**, no
blockers; a security audit: **SECURE WITH NOTES**, no gate bypass and no fail-open path). The
fix pass closed every finding. Four of them changed code, and each is a **behaviour** the
specs already required:

- **Truncation is now stated, not admitted around** (003 FR-077/FR-078). The gate judges the
  run's **retained** references and the run layer stops retaining at 200, so a run that reached
  the cap can be carrying an allowed actor among the *dropped* ones — invisible under **every**
  policy, which is the wedge the gate's own set quantifier exists to prevent arriving by the
  other door. Admitting would violate constitution II, so the gate **refuses** and the refusal
  message, its `dispatch.refused` detail, and the retry's `cause-not-cleared` reason all say
  the decision was made on an incomplete list and that widening `allowedUsers` cannot clear it.
  `ActorGateRefusal` gained `retainedReferences`, `referencesNotRetained`, and
  `referencesTruncated`; `deniedLogins`/`deniedAttributions` became **optional**, because on a
  policy-read failure nothing was compared and `[]` read as "every actor was refused".
- **The two unreadable-policy causes are now distinguishable.** `bindings.json` unreadable and
  "the document read cleanly and does not carry this binding" are different operator actions,
  so `readLivePolicy` returns a discriminated union and the messages say which.
- **The bindings write now runs on `inQueueChain`**, the same chain the gate's read → mint →
  persist runs in. That closes a TOCTOU in which an operator tightening the list at T could have
  a reserve that read the old list at T−ε persist a live token at T+ε. The prompt-observation
  chain nests **inside** it; there is no lock order to invert.
- **Two small hardening fixes**: `deniedLogins` entries go through the module's 500-character
  bound (a `SourceReference.actorLogin` is validated as non-empty text and nothing more, so a
  hand-edited store could otherwise grow a durable row without limit), and the panel's
  duplicated `actor-not-allowed` literal gained a **drift test** rather than a shared constant
  it cannot have — the panel cannot import across the extension/service boundary.

Two new service modules came out of the `llm-core/max-file-length` gate:
`service/poll/row-text.ts` (the row-text bound and its marker) and
`service/poll/run-corroborate.ts` (which blocked causes the service can re-check itself, and
how). Neither adds a decision; both are splits this feature wants.

**Two documentation corrections** were made to spec texts the code proves false or incomplete —
003 NFR-114 (it claimed no extra store read; there is one), 003 AC-130 (its "no permitted
login" reading was mutually exclusive with AC-133), 005 AC-146 (three files legitimately use
those words about something other than a binding), and 005's C-1 and C-4 task texts (the
empty-array refusal, and what an absent `actorPolicy` does). **No code behaviour changed for
any of them** — the code was right and the requirement text was wrong.

**Two items are recorded, NOT built** — see `## Recorded at the pre-PR review gate` below.

### Wave 2 structural decisions a fresh coordinator must know

Three **new modules**, all forced by the `llm-core/max-file-length` gate and all the shape this
feature wants:

- `service/poll/dispatch-actor-gate.ts` — the gate's **pure** predicate (`judgeActorPolicy`), the
  live read (`readLivePolicy`), the unreadable-policy verdict, and the exported
  `ACTOR_BLOCKED_REASON`. `dispatch-authorize.ts` keeps the decide -> apply -> record chain and the
  token. The split is what lets `run-operate.ts`'s retry re-check re-run **the same predicate**.
  **The one-comparison scan's second file is this one, not `dispatch-authorize.ts`** — plan D9
  named the reserve, the gate module is beside it, and both `tests/allow-list.test.ts` (§5.6) and
  `tests/bundle.test.ts` assert the pair.
- `service/bindings-read.ts` gains a third reader, `readBindingsForAuthorization` — the only one
  that keeps *no bindings* apart from *an unreadable document*, because the gate must deny on the
  second and cannot deny on the first without inventing a reason. It deliberately runs **no**
  prompt observer: the gate is not an editor.
- The panel gained `src/run-actor.ts` (the two closed actor vocabularies and their absentable
  readers) and `src/dispatches-detail.ts` (the run row's structured members). **Both are
  `dispatches-*`/`run-*`, never `runs-*`**: 005 T-003 retired the `src/runs*.ts` prefix and
  `tests/vocabulary.test.ts` fails on any of it, so the second new module was renamed from
  `runs-row-detail.ts` before commit.

### Wave 2 findings for the gate

- **Every dispatch fixture had to gain a binding.** The gate denies when the policy cannot be read,
  so a store with no `bindings.json` cannot dispatch anything. `tests/support/binding-fixture.ts`
  (`writeOpenBinding`, `writeLoopBinding`) now seeds the **open** policy — no `allowedUsers` key —
  in the loop harness, the dispatch corpus, and nine suites' own setup. Without it, 48 pre-existing
  tests failed with `actor-not-allowed`, which is the gate working, not the gate being wrong.
- **B-3's third named test is not implementable as written.** "A null `actorPolicy` on a reserved
  run refuses rather than writing `null`" would mean refusing a *result report* on a hand-seeded
  `starting` run — a shape no production path produces, and a wire refusal no requirement names.
  The row builders carry the run's snapshot, so a null would be recorded as null rather than
  guessed. Recorded, not silently skipped.
- **`reserveRun`'s signature changed** from `ReserveAnswer | null` to a `ReserveOutcome` union, so
  the relay can tell "a policy this panel must report" from "a stale lease, which it merely
  notes". The only caller is `src/relay.ts`; `tests/service-audit-read.test.ts` follows it.

### Wave 1 structural decisions a fresh coordinator must know

Two **new modules**, forced by the `llm-core/max-file-length` gate (500 non-blank lines) rather
than chosen:

- `service/bindings-allow-list.ts` — the `allowedUsers` field's three refusals **and** plan D9's
  single membership comparison `isActorAllowed`. `bindings.ts` imports the reader and keeps
  `BindingRecord`. **Plan D9 says the helper is "exported from the validator's module"; the
  contract's own §5.6 words the invariant as "its own module", and the latter is what shipped.** Wave 2's `dispatch-actor-gate.ts` imports it from here — see
  Wave 2's structural block above.
- `service/poll/attribution.ts` — `isBotAuthor`, `isAttributableAuthor` (plan D3's renamed,
  now-exported predicate, moved out of `triggers.ts`), the single exported
  `AUTHOR_LOGIN_MAX_CHARS` bound (plan D8, used by `triggers.ts` **and** `loop.ts`), and the
  stored row's `ActorAttribution` union with its two absentable readers.

`BaseEventSnapshot.actorLogin` / `actorAttribution` are **required**, so the compiler refuses a
trigger builder that forgets an attribution; 14 test fixture factories across 21 suites were
given the two members mechanically (per-kind basis: `direct` for both mention kinds,
`subject-author` for assignment and review).

### Findings for the gate

- **"No plural accepted" (A-7 / FR-048) cannot be a refusal.** `parseBinding` deliberately treats
  an unknown member as absent (contract §1: `BindingRecord` is not a closed object on the wire),
  so a submitted `repositories: [...]` is *ignored*, not refused — the stored row keeps exactly
  one `repository`. Every wildcard/plural **value** for `repository` *is* refused. Asserted both
  ways in `tests/allow-list.test.ts`.
- **A `[bot]` login and research §R9's alphabet disagree.** `dependabot[bot]` contains `[`/`]`,
  which §R9's alphabet excludes, so plan D7 ("accepted and inert") and the per-element shape rule
  cannot both hold literally. The validator strips a trailing `[bot]` and judges the remainder
  against §R9's rules, which satisfies D7 and keeps the length bound covering the whole value.
- `tests/service-entry.test.ts` is the **spawned-bundle entry** suite, not the poller's feed-entry
  readers the A-2/A-5 task text names. A-2's reader tests therefore live in a new
  `tests/service-poll-entries.test.ts`; A-5/A-6/A-7 landed in the suites that actually drive the
  real loop and store (`tests/service-triggers.test.ts`, `tests/service-events.test.ts`).

## Budget

- Per-wave limit: 250,000 input tokens / 20 min investigation; warn at 80%.
- Consumed this session (phases 1–5): substantial — reconnaissance plus two completed subagent
  dispatches. **Phases 6 waves 2 and 3 should each start a fresh session**, reading this file
  alone, rather than continuing in this one.

## Next Action

Open the **PR** for `issue-9-user-allow-list`. The PR description must carry the two items
recorded above that an operator or reviewer needs to hear before merging: **R-2** (the
proxy's reach — naming an author also admits anyone who can assign an issue or request a
review on that author's work) and **R-1** (pre-existing queue rows are un-dispatchable by
ruling). All 26 spec files and the new contract are committed in `1799ec3`; the branch is
clean.

## Items flagged at the phase-5 gate — do NOT resolve in code

1. **003 NFR-114's letter is false of the shipped code.** The authorization path reads
   `config.json`, not `bindings.json`, so reading the live policy *is* an additional store
   read. **RESOLVED as a documentation correction, 2026-10-03** — 003 `spec.md`'s
   `## Amendment History` → `### v1.8.0 — 2026-10-03` states what is actually claimed (no
   extra **network** round trip, plus one local store read inside the chain task) and says
   why the original premise was false. No code change; the read stays.
2. **The empty-list round trip** — resolved by the owner at the phase-5 gate (blank field =
   back to open). Recorded here; the phase-3 spec text (`[]` refused) stands.
3. **002 FR-045(c) wording** — capability statement chosen over validator rule. **The code
   comment in `service/bindings-allow-list.ts` that described the `[bot]` acceptance as
   avoiding "a refusal the specs do not name" was corrected 2026-10-03**: FR-045(c) *does*
   name that refusal, so the comment now states the real reason — the bot is refused at
   **authorization** (003 FR-080), so accepting the spelling in the list cannot grant a bot
   anything, which makes accepting it strictly more honest than refusing a login shape
   GitHub issued.
4. **Retry verdict for an unreadable bindings document** — `cause-not-cleared` chosen.

## Recorded at the pre-PR review gate, 2026-10-03 — decisions for the product owner, NOT code

Both are **recorded, not built.** Neither is a defect to fix; each is a consequence of a
decision that was already made, recorded so the PR description and the operator guidance
say so out loud.

### R-1. A queue row written before this feature can never be dispatched, under any policy

- **What the auditor found.** A run whose source reference was stored **before** attribution
  existed carries no `actorLogin`. 003 FR-080 refuses such a run — correctly: an unreadable
  actor is refused *regardless* of the policy, because the fail-closed reading of an
  unreadable actor is *no actor*, never *the list says yes* (constitution II). And the retry
  re-judges from the same references, so every retry answers `cause-not-cleared` forever.
- **The tension.** 003 FR-005 says *"existing stored queue rows MUST remain … dispatchable."*
  Those two cannot both hold for a row with no recorded actor.
- **Why the suite does not catch it.** The fixture was **updated to add `actorLogin`** rather
  than to cover the real shape, so the pre-existing-row path is not exercised. That was the
  right call for a fixture whose purpose is *dispatch* behaviour, and it means the coverage
  gap is invisible to `npm test` — which is itself worth knowing.
- **The owner has ruled**: the project is unreleased, there are no migrations, and they can
  delete their local install and start over. **No migration is to be built, and none was.**
- **Residual risk, stated plainly.** An operator who carried a local install across this
  change will have rows the gate refuses under every policy, with a retry that always answers
  `cause-not-cleared`. Neither message tells them to widen `allowedUsers` — because that
  cannot help — and both name the actor as unreadable. The remedy is: delete the local
  install and re-enable the binding, or dispatch the work by hand. **Mitigating factor:**
  admitting those rows would mean admitting an authorization nobody granted, so FR-080's
  refusal is the correct direction even though it costs those rows.
- **What would close it, if the owner ever revisits it**: a *migration* (out of scope by
  ruling), or a one-time operator action that re-attributes or discards the affected rows.
  Both are code, and both are declined.

### R-2. The proxy's inherent reach: any third party can start a session on a permitted user's issue

- **What it is.** Assignment and review-request triggers have **no true actor** — GitHub
  records who opened the issue or pull request and does **not** record who assigned it or who
  requested the review. The list is therefore judged against the **subject author**
  (002 FR-044), a documented proxy.
- **The consequence.** **Any third party who can assign an issue or request a review on a
  pull request authored by a permitted user starts a session.** They never appear on the run;
  the author does, as a proxy.
- **Owner-ratified and inherent.** 002 FR-044 and 002 NFR-011 ratify the proxy and require
  the surface to *say* it is a proxy — which the panel does, in its own words, on the dispatch
  row and on every reference in the reveal. This is not a defect to fix; it is the chosen
  design's reach, and the alternative (no list for assignment and review triggers) would be a
  control the operator believes in and the product does not have.
- **Not changed.** No behaviour moves. Flagged for the **PR description** and for the
  **operator guidance** (`README.md`), because an operator reading `allowedUsers` needs to
  know that naming an author also admits anyone who can touch that author's issues.