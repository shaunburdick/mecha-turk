# Orchestration State: issue #9 — user allow-list on bindings

**Durable state file — a fresh coordinator must be able to resume from this file alone.**
Namespaced beside `orchestration.md` (which records the delivered 002 MVP and is NOT superseded).

## Current Wave

**Wave 2 complete** (`B-1 … B-7`, delivered 2026-10-03). Wave 3 is next.

## Branch

`issue-9-user-allow-list` (base `bb7947f`, not protected). Working tree carries all
phase 4–5 planning edits, **uncommitted**. Base state at session start: clean tree at `bb7947f`.

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
| 3 | C-1 … C-6 | `modern-architect-engineer` | not started |

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

Dispatch **Wave 1** (`A-1 … A-7`) to `modern-architect-engineer` as a single dispatch, in
dependency order, with the `A-4 ← A-1` correction stated explicitly. Then run
`npm run verify` at wave close, commit, checkpoint with the user.

## Items flagged at the phase-5 gate — do NOT resolve in code

1. **003 NFR-114's letter is false of the shipped code.** The authorization path reads
   `config.json`, not `bindings.json`, so reading the live policy *is* an additional store
   read. Owner wording recommended; recorded in `pm-handoff.md`. No code change.
2. **The empty-list round trip** — resolved by the owner at the phase-5 gate (blank field =
   back to open). Recorded here; the phase-3 spec text (`[]` refused) stands.
3. **002 FR-045(c) wording** — capability statement chosen over validator rule; one-line
   inversion if the owner reads it the other way.
4. **Retry verdict for an unreadable bindings document** — `cause-not-cleared` chosen.