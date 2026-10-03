# AGENTS.md — working on Mecha Turk

Guide for AI agents and humans changing this repository. Users install and
operate the extension from [README.md](README.md); everything below is about
building it safely.

## What this is

Mecha Turk: an OpenChamber extension (rail panel) plus an OpenChamber-hosted
local service. The service polls bound GitHub repositories for assignment,
review-request, and mention triggers and queues durable events; the panel
relays each event into exactly one `host.startSession()` call. The project
constitution lives at `.specify/memory/constitution.md` (v1.3.0) — every plan
and review must state alignment with it.

## Layout

```text
├── package.json          # BOTH the npm dev package and the OpenChamber manifest
├── panel/                # index.html, main.ts, main.js (committed IIFE bundle)
├── service/              # main.ts, main.js (committed ESM bundle) + server, routes,
│                          # accounts/, poll/, store/ — stdlib-only, no framework
├── src/                  # panel logic, one responsibility per module
├── tests/                # vitest suites + support/ fakes (fake host, DOM helpers)
├── specs/002-agent-event-extension/      # production spec (the product's source of truth)
├── README.md             # user-facing (install, configure, operate)
├── .specify/             # constitution + spec-kit scripts/templates
└── .opencode/commands/   # speckit slash commands
```

`specs/` documents are dated records of the phase that produced them —
path/identity details in older plan/data-model files may predate the
2026-09 repository reorganization (extension moved to the repo root,
identity `mecha-turk`). The maintained
walkthrough is `specs/002-agent-event-extension/quickstart.md`.

## Commands

```sh
npm ci            # toolchain install (Node >= 20.19; bun for the bundler)
npm run verify    # build -> lint -> typecheck -> test — THE gate, run before every commit
npm run build     # bundles panel/main.js (IIFE) + service/main.js (ESM)
npm test          # vitest, offline (563 tests)
npm run format    # eslint --fix
npm run shot      # screenshot all six panel tabs at 720px and 560px into screenshots/
```

### Visual verification

`npm run shot` (or `node tools/visual/shot.js <tab> …`) renders the shipped
`panel/index.html` inside the offline harness in `tools/visual/` — a mock host
bridge, fixture answers, and a no-cache loopback server — then writes **two
PNGs per tab** at the widths the host actually gives a rail panel (height
following the tab's content): `panel-<tab>.png` at **720px**, the default
capture width, and `panel-<tab>-narrow.png` at **560px**, the tight end of
the same band — plus `panel-full.png` at the default width and full scroll
height — into the repo-root `screenshots/` folder (git-ignored; `--out DIR`
overrides it, `--width N` overrides the default width for a frame at one
particular size). The widths come from the host's own arithmetic, not a
guess: extension panels are `plugin:<id>` context surfaces, whose
`defaultWidthFraction` is `0.45` of the available content region, clamped
between `320px` and `region − 400px` — ≈500px at 1440 and ≈715px at 1920.
It runs offline, needs
`agent-browser` on PATH, takes about a minute, and never touches `panel/`,
`src/`, or `service/`. Every image is decoded and proven current before it is
published:
a sentinel colour painted and read back before each capture, the selected
tab's strip fill measured in the pixels, and a diff against the frame before
it. A run that does not verify exits non-zero instead of leaving a stale
picture behind.

## Non-negotiable invariants

1. **Committed bundles ship.** OpenChamber never compiles TypeScript and
   never installs npm dependencies — it loads `panel/main.js` and
   `service/main.js` as committed. Any change under `src/`, `panel/*.ts`, or
   `service/*.ts` ends with `npm run build` and the rebuilt bundles committed
   in the same commit.
2. **One document, two roles.** `package.json` is the npm package *and* the
   installable manifest. `version` gates git-URL update notifications:
   bump + rebuild + push to release. Do not reintroduce npm `workspaces`.
   **Release policy: stay pre-1.0.0 until the public 1.0.0 release** —
   current version `0.0.1`, increment per release; jumping to `1.0.0` is a
   product-owner call, never incidental.
3. **Capabilities: `sessions` and `prompt` only.** `service` is implied by
   `contributes.service` — listing an implied capability in `capabilities[]`
   fails install with `invalid-capabilities`. The integration card that also
   implied `network` was removed by product-owner order (2026-09-30); the
   panel makes no GitHub request of its own (`host.request()` has no caller),
   so `network` is no longer requested at all. `contributes.service` must not
   gain a `permissions` key.
4. **Kebab-case identity.** Manifest ids must match `^[a-z][a-z0-9-]*$`;
   the panel id is `mecha-turk`, and `host.storage` keys are prefixed
   `mecha-turk:` (`:project`, `:evidence`, `:ledger`). Renaming either is a
   user-visible storage-namespace reset — treat as a breaking change.
5. **`SERVICE_VERSION` mirrors `package.json`.**
   `service/routes/health.ts` hardcodes the version and
   `tests/service-server.test.ts` pins them together.
6. **SDK pinned exactly** (`@openchamber/sdk`, no `~`/`^`, no preview). Re-pin
   only together with a check of the host build in the operator's OpenChamber
   (engine floor: `>=1.24.0`).
7. **Zero suppressions, zero `any`.** No `eslint-disable`, `@ts-ignore`,
   `@ts-expect-error`, `# type: ignore`. Fix the code, not the tool.
8. **Fail closed.** Settings, bindings, event rows, and service DTOs parse
   through validators that refuse malformed input instead of partially
   applying it. Missing/ambiguous authorization is a stop condition
   (constitution II) — never create a project implicitly.
9. **Secrets never leave the service store.** PATs live only in
   `~/.config/openchamber/mecha-turk/` files (0700/0600). They must never
   appear in logs, ledger, panel storage, audit rows, or shipped bundles —
   the secret-scan suites (`tests/bundle.test.ts`, redaction tests) enforce
   this; a redaction refusal blocks the write rather than logging through it.
10. **`extension-spike-1` is a wire contract.** The evidence schema version
    and the NDJSON event contract are compatibility surfaces — change them
    deliberately (and version them), never as a rename.

## Testing philosophy

Everything deterministic runs offline: manifest validation against the
official SDK parser, panel logic against a fake host (`tests/support/`),
service routes/store/poll logic against temp dirs, bundle shape/secret
assertions. No test may require a live OpenChamber instance, a real PAT, or
network — those checks are operator-gated and recorded in the spec (see
`specs/002-agent-event-extension/tasks.md`). Contract fixtures live in
`specs/002-agent-event-extension/contracts/` and are read by tests
(`tests/disclaimer.test.ts`) — don't delete them.

## Module map (panel, `src/`)

| Module | Responsibility |
| --- | --- |
| `config.ts` | Parse and validate operator settings (fail closed) |
| `github.ts` | The normalised `GitHubIssue` shape the message composer and the relay read (the REST fetchers and the `/user` diagnostic went with the install-time card) |
| `prompt.ts` / `prompt-wire.ts` | The operator fence, the reserved marker prefixes, trim/normalise/code-point rules, the closed tier vocabulary (`PromptSource`, `PROMPT_SOURCE_ORDER`, the two `promptSources` predicates), and `composeFirstMessage`; the wire readers for the prompt's reference members (fail closed: `promptText` non-null iff `promptPresent`, `promptSources` a non-empty duplicate-free subsequence of the tier order) |
| `context-blocks.ts` | The bounded excerpt renderer: untrusted delimiters, defusing, the per-source budget, and the roll-up line |
| `evidence.ts` | Normalized, redacted evidence record |
| `ids.ts` | Correlation identifier and RFC 3339 clock helpers (fail closed when the secure-context UUID source is missing) |
| `ledger.ts` / `ledger-repair.ts` | Redacted `host.storage` ledger, phases, gap analysis, bounded-write repair |
| `session.ts` / `host-verify.ts` | `startSession()` framing (attachment id = the run's correlation id, multi-reference bounded excerpt) + host-owned project/worktree/session read-back |
| `lifecycle.ts` | Lifecycle experiment plan and mount bookkeeping |
| `panel-state.ts` / `panel-ui.ts` | Shared runtime state; rendering with `@openchamber/sdk/ui` |
| `style.ts` | The shared visual vocabulary: block surfaces, definition rows, cells, cards, and the lossless label/value split — structure only, never copy (2026-09-30 redesign) |
| `panel-actions.ts` | The durable ledger write: append, guarded persist, repair-on-refusal (the poll loop, card diagnostic, and spike dispatch path were deleted 2026-09-30) |
| `project-picker.ts` / `project-actions.ts` | Pure picker state; `listProjects()` + stored selection |
| `app.ts` | Wiring: mount, subscribe, teardown |
| `tabs.ts` | The six-tab shell: strip, body registry, first-activation mount, tab↔body association, one dispose path |
| `tab-bodies.ts` | The six tab bodies in FR-010's order: what each container mounts on first activation |
| `dispatch-page.ts` | The Dispatches list's paging state: cursor stack, page size, filters, and the reset rule |
| `redaction.ts` / `json.ts` | Secret-shape detection; typed bridge to the host's `JsonValue` |
| `service-calls.ts` | Shared `host.serviceRequest()` GET/PUT/POST/DELETE wrappers (including `servicePutConfig`, the configuration write) + the run-scoped paths (reserve, result, abandon, blocked, retry, requeue, resolve, verification, audit read) |
| `service-envelope.ts` | The one place an answer is classified: status → problem/code/message/issues, with the resource each refusal names (006 FR-043) |
| `bindings-mode.ts` | Bindings-authoritative mode: first enabled binding is dispatch context |
| `bindings-body.ts` | Mounts and disposes the Bindings tab body: the list block with its toolbar, and the editor block that opens on a row click or **New binding** and states the loaded binding's state (2026-10-01 review) |
| `bindings*.ts` / `dispatches*.ts` | The Bindings tab (binding rows, the editor, the add form) plus the Dispatches list's rows, paging, and controls |
| `bindings-grant.ts` | The whole-file `PUT /v1/bindings` write: prompt-key stripping (004 FR-014), the "nothing changed" refusal note, and the relay arming that follows a confirmed list |
| `bindings-prompt.ts` | The binding editor's starting-prompt field — the binding tier's one rendering (005 FR-051 as amended: one rendering per tier value), carrying FR-063's five-fact guidance beside it and FR-064's honest `not set` in the value slot (004 FR-089); its row summary shows presence and length only, never the text |
| `bindings-editor.ts` | The editor's derived field views: the mention token in force and its override mark (005 FR-057, no store in this build), the bound-account scope for edit vs add, and the worktree option declaration |
| `dispatches-controls.ts` | Paging, filter, and row-detail controls: range line, active-filter line, Previous/Next, page size, the source-reference reveal, and the correlation-id copy |
| `dispatches-service.ts` / `dispatches-rows.ts` | Run DTO parsed fail-closed across the eight dispatch states; each state's label, tone, and retry validity |
| `run-state.ts` | The eight-state dispatch vocabulary, its `blocked:<reason>` family, and the narrowers that refuse an unknown word |
| `relay.ts` | Relay tick: claim → handled key → guards → attempt; one handoff per `correlationId#attempt` per mount |
| `relay-gates.ts` / `relay-attempt.ts` | Binding/project guards, the `blocked` report, and the reserve step; then compose → the budget floor (a first message over `CONTEXT_MAX_CHARS` refused before `host.startSession()` is called — no session started, 004 FR-085) → host call → record → report → acknowledge → read-back |
| `dispatch-record.ts` | `mecha-turk:dispatches`: the durable attempt record, written between the host call and its report and acknowledged on its own 2xx |
| `claim-service.ts` | Claim and run-history body parsers (strict: an unknown state refuses the body) |
| `reconcile.ts` | Mount-time re-report of every unacknowledged attempt, before the first claim (bounded, warns visibly) |
| `prerequisites.ts` / `prerequisite-records.ts` | The five first-run prerequisites: the mounted section (block, cards, state chips, FR-073 notice) and the pure derivation that answers each one `met` / `not-met` / `not-checkable` with its detail and remediation line |
| `status-document.ts` / `status-lines.ts` / `status-tab.ts` | The `GET /v1/status` document parsed fail closed and the read state that holds it; the Status tab's operator-facing copy as pure functions; and the tab's mount, repaint, and single read |
| `settings-rows.ts` | The Settings tab's row builder: one row per projected descriptor plus one per undocumented member — name, unit-or-*none*, bounds-or-format, value, and class words, every one of them from the wire (005's bounds stand-in retired by 006 T-018); the global prompt tier rides that same list as the twelfth field, `startingPrompt` — its `format` guidance rendered as text and FR-064's *not set* in the value slot (004 T-030; FR-064, FR-089) |
| `settings-schema.ts` | Fail-closed reader for `GET /v1/config`'s envelope: the closed descriptor union, plus the `unreadable` and `undisplayed` flags (006 T-017; FR-021, FR-027, FR-028) |
| `settings-confirm.ts` | The destructive-confirmation copy builder, pure: the retention arm's what/when/survivors block, the restore arm's current → default list, and the raise-deletes-nothing and irreversibility lines (006 T-022; FR-016, FR-051–FR-054) |
| `settings-edit.ts` | The Settings draft/save state machine, pure: baseline ∪ projection defaults ∪ edits, the no-baseline and busy gates, and the pending markers only a read retires (006 T-019; FR-038, FR-041, FR-046) |
| `settings-state.ts` | The Settings read state in FR-019's three shapes, plus the tab's copy — the banner that states last-writer-wins, the per-source sentence, the save-state words, and the four write-failure causes with their classifier and read-side notices (006 T-020, T-023) |
| `settings-actions.ts` | The Settings effects: the read, the whole-document write (arm first when it deletes), discard, cancel, and staged defaults — each taking the repaint it triggers so the two modules never import each other (006 T-019, T-020, T-022) |
| `settings-mount.ts` | The Settings regions outside the rows: the read row, the failure notice, the source/rows region, the save bar with its armed-confirmation box and its two hidden-until-needed boxes, and the view's single dispose path (006 T-020, T-022; 005 FR-017) |
| `settings-tab.ts` | The Settings body: the one `GET /v1/config` read, the save flow, the failure and audit-warning rendering, and the projection-driven rows (005 FR-078, FR-039; 006 FR-010–FR-015, T-018, T-020, T-023, T-024) |
| `about-tab.ts` | The About body: name, the one-line description, the single version read from the service health answer (no panel-side literal), the repository link through `host.openUrl`, and the Diagnostics disclosure (005 FR-074–FR-077; 2026-10-01 scrub) |
| `about-diagnostics.ts` | The read-only Diagnostics record that disclosure reveals: schema versions, the phase line, and the ledger tail as `#seq · kind · time` text (005 FR-075, FR-076) |
| `audit-view.ts` | One run's audit history under its correlation id, rendered as text (never markup) |
| `agent-verify.ts` | Post-dispatch `openSession()` agent read-back, reported to the service (warn-only) |
| `agent-verify-copy.ts` | The read-back's words: the runs-area banner and the service's `note`, pure functions of one outcome |
| `handoff*.ts` / `account*.ts` | One-shot token handoff (paste → connect; no consent step since 002 v1.9.0), the always-visible Accounts disclaimer (`accounts-disclaimer.ts`), silent adoption, and the credential-free account mirror |
| `accounts-rows.ts` / `accounts-tab.ts` | The Accounts tab: every FR-062 row word (lifecycle, connection, scope matrix, remediation, binding count) as pure functions, plus the body's mounts, repaint, and single read |
| `accounts-actions.ts` | The tab's writes: two-step removal with the `force=1` cascade the arm stated, the rotation arm the handoff routes on, and the one account profile write (`PUT /v1/accounts/:numericUserId`, one member per save, absent = unchanged) behind both member fields — display name and account-tier starting prompt — that never applies a value the service did not confirm |
| `storage-write.ts` | Guarded storage writes |

## Module map (service, `service/`)

| Module | Responsibility |
| --- | --- |
| `main.ts` / `server.ts` / `http.ts` | Entry, loopback HTTP server, routing, body/size caps |
| `auth.ts` | Extension grant + the bearer gate on every call |
| `accounts/` | Durable account model, credential files, startup reconcile |
| `account-prompt-audit.ts` | The account tier's observer lane: one `account.prompt-updated` row per change — profile write or hand edit — on a per-store chain with a trail-seeded baseline; never the prompt's text, and a `displayName`-only change is not a tier change (004 FR-088) |
| `bindings.ts` / `bindings-read.ts` | Whole-file bindings store (validated, capped) + the read path: quarantine-reason capture and the prompt-change observation funnel |
| `prompt.ts` / `prompt-audit.ts` | The starting-prompt domain (four refusals, `mtp-` fingerprint, run snapshot) — including the three-tier resolver and stack vocabulary (`TierPrompt`, `promptTierOf`, `composePromptBody`, `resolvePromptSnapshot`, the stack bound, the stored-snapshot reader) — and the per-store chain that writes exactly one `binding.prompt-updated` row per change |
| `poll/` | Per-binding scan loop, trigger detection over the rate budget, durable event queue (deterministic ids, claim, terminal dispatch) |
| `poll/run-key.ts` | Run key, correlation id, dispatch token, and token-fingerprint derivation |
| `poll/runs*.ts` | `runs.json` document: fail-closed parser, join/create, one-shot adoption of pre-003 rows, lifecycle audit rows and the durable audit outbox |
| `poll/claim*.ts` | Lease-issuing claim: eligibility, projection, and the answer's run/byte bounds |
| `poll/sweep.ts` / `poll/sweep-loop.ts` | Lease-expiry and result-deadline sweep: boot pass before the listener binds, unref'd timer, requeue budget |
| `poll/dispatch*.ts` | Reserve / result / abandon / block family: single-use tokens, the staleness matrix, refusal rows |
| `poll/run-chain.ts` / `poll/run-operate.ts` / `poll/run-verify.ts` / `poll/run-refusal.ts` | The shared run write chain, retry/requeue/resolve, the verification report, the refusal vocabulary |
| `poll/run-history-project.ts` | The capped, credential-free run-history projection |
| `poll/backoff.ts` | The poll-*request* ladder — pure delay arithmetic plus the injected-sleep driver; requests/attempts, never 003's requeue (006 FR-058) |
| `poll/window.ts` | The scan window: `lastScanAt − overlapMs`, the replay case, and the closure of 002 FR-019's conformance gap (006 FR-059(a)) |
| `poll/cycle-config.ts` | The cycle's one configuration read, with the global-tier prompt observation in the same chain task — the snapshot the diff judges is the snapshot the cycle runs on; a document that cannot be read degrades to the documented defaults with one warn (006 FR-055; 004 FR-088) |
| `poll/excerpt-trim.ts` | The excerpt retention pass: text-only clearing on terminal rows past `excerptRetentionDays`, the `excerptTrimmedAt` marker, and one `audit.trimmed` row after the rewrite (006 FR-057) |
| `routes/` | `/v1/status`, `/health`, `/v1/bindings`, `/v1/accounts`, `/v1/events*`, credential verify |
| `routes/account-profile.ts` | The account profile write `PUT /v1/accounts/:numericUserId`: the closed two-member body (`displayName`, `startingPrompt` — absent = unchanged, neither = no-op `422`, any other key refused by name with no echo), all-or-nothing, with an account-tier prompt change appended through the observer chain (004 FR-082, FR-088; 005 FR-066) |
| `routes/dispatch.ts` / `routes/run-ops.ts` | Reserve, result, abandon, blocked; retry, requeue, resolve, verification |
| `routes/audit.ts` | `GET /v1/audit`, filtered by correlation identifier |
| `routes/run-scope.ts` / `routes/run-fields.ts` / `routes/run-answer.ts` | Shared run-scoped path/body readers and the `200` / refusal envelopes |
| `audit.ts` / `log.ts` | `audit.ndjson` rows + structured, secret-free logs |
| `audit-trim.ts` | The audit retention pass: FR-056's protected set computed by rule, oldest-first removal under the day window and the entry cap, survivors plus their `audit.trimmed` row in one atomic rewrite |
| `config-audit.ts` | The `config.changed` row: `configChanges` (which doubles as the no-op detector), the `applied` shape with `from`/`to`/`takesEffect`, and the value-free `refused` shape (006 FR-070–FR-072) |
| `config-prompt-observe.ts` | The global tier's observer: one `config.changed` row (actor `service`) for a `startingPrompt` change the cycle sees in the stored document, on a trail-seeded baseline and serialised with the `PUT` path's own row so a change is never recorded twice — and never the text (004 FR-088; 006 FR-070, FR-071) |
| `retention.ts` | Both retention passes wired at their two boundaries — store open and the cycle boundary — each guarded so one failure still runs the other (006 FR-055, FR-057, FR-047) |
| `store/` | 0700/0600 store, JSON/NDJSON IO, quarantine-and-repair reads |
| `config.ts` / `env.ts` / `throttle.ts` | Operator-tunable polling/retry/retention, env, rate budgets |
| `config-schema.ts` | That declaration projected onto the wire: the exhaustive `TAKE_EFFECT` table, the closed `FieldDescriptor` union, `configSchema()` (006 FR-020–FR-022) |
| `config-prompt.ts` | The global tier's rule at the configuration save boundary — a call into the one `validateStartingPrompt` (one validator, three call sites), with `PUT /v1/config`'s own voice: an absent or non-string member is a refusal, not *unset*, and no issue quotes the submission (004 FR-081, FR-083; 006 FR-041) |

## Spec workflow

Spec-driven development with six gated phases
(constitution → specify → clarify → plan → tasks → implement). A feature gets
`specs/NNN-name/` with `spec.md`, `plan.md`, `tasks.md` (plus `research.md`,
`data-model.md`, `contracts/`, `quickstart.md` as the plan requires). Use the
speckit commands in `.opencode/commands/` (`/speckit.plan`, `/speckit.tasks`,
…); helper scripts live in `.specify/scripts/`. Never start implementation
without an approved spec/plan pair, and run `npm run verify` at every wave
boundary.

## Git conventions

- Protected: `main`, `master`, `develop` — branch (`001-feature-name`,
  `fix/*`, …), never commit to or switch onto them.
- Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `ci`).
- AI-authored commits carry `Generated-By: <agent> (model: <model>)` — use
  `git-agent-commit` (or `AI_AGENT=opencode … git commit`); the
  `prepare-commit-msg` hook appends it.
- Run the git-safety preflight checks before any commit/push/PR; no
  force-pushes, no `--no-verify`, no history rewrites.
- Verify (`npm run verify`) before every commit — a green suite is the floor,
  not the goal.
