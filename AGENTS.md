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
```

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
3. **Capabilities: `sessions` and `prompt` only.** `service` and `network`
   are implied by `contributes.service` and the integration card — listing
   them in `capabilities[]` fails install with `invalid-capabilities`.
   `contributes.service` must not gain a `permissions` key.
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
(`tests/consent.test.ts`) — don't delete them.

## Module map (panel, `src/`)

| Module | Responsibility |
| --- | --- |
| `config.ts` | Parse and validate operator settings (fail closed) |
| `github.ts` | GitHub REST access through `host.request()` only (legacy single-repo path) |
| `matching.ts` | The single configured-match rule |
| `prompt.ts` / `prompt-wire.ts` | The operator fence, the reserved marker prefixes, trim/normalise/code-point rules, and `composeFirstMessage`; the wire readers for the prompt's reference members (fail closed: `promptText` non-null iff `promptPresent`) |
| `context-blocks.ts` | The bounded excerpt renderer: untrusted delimiters, defusing, the per-source budget, and the roll-up line |
| `evidence.ts` | Normalized, redacted evidence record |
| `ids.ts` | Correlation identifier and RFC 3339 clock helpers (fail closed when the secure-context UUID source is missing) |
| `ledger.ts` / `ledger-repair.ts` | Redacted `host.storage` ledger, phases, gap analysis, bounded-write repair |
| `session.ts` / `host-verify.ts` | `startSession()` framing (attachment id = the run's correlation id, multi-reference bounded excerpt) + host-owned project/worktree/session read-back |
| `lifecycle.ts` | Lifecycle experiment plan and mount bookkeeping |
| `panel-state.ts` / `panel-ui.ts` | Shared runtime state; rendering with `@openchamber/sdk/ui` |
| `panel-actions.ts` / `panel-dispatch.ts` | Poll/identity/verify actions; the spike dispatch path |
| `project-picker.ts` / `project-actions.ts` | Pure picker state; `listProjects()` + stored selection |
| `app.ts` | Wiring: mount, subscribe, teardown |
| `tabs.ts` | The six-tab shell: strip, body registry, first-activation mount, tab↔body association, one dispose path |
| `tab-bodies.ts` | The six tab bodies in FR-010's order: what each container mounts on first activation |
| `dispatch-page.ts` | The Dispatches list's paging state: cursor stack, page size, filters, and the reset rule |
| `redaction.ts` / `json.ts` | Secret-shape detection; typed bridge to the host's `JsonValue` |
| `service-calls.ts` | Shared `host.serviceRequest()` GET/PUT/POST/DELETE wrappers (including `servicePutConfig`, the configuration write) + the run-scoped paths (reserve, result, abandon, blocked, retry, requeue, resolve, verification, audit read) |
| `service-envelope.ts` | The one place an answer is classified: status → problem/code/message/issues, with the resource each refusal names (006 FR-043) |
| `bindings-mode.ts` | Bindings-authoritative mode: first enabled binding is dispatch context |
| `bindings*.ts` / `dispatches*.ts` | The Bindings tab (binding rows, the editor, the add form) plus the Dispatches list's rows, paging, and controls |
| `bindings-grant.ts` | The whole-file `PUT /v1/bindings` write: prompt-key stripping (004 FR-014), the "nothing changed" refusal note, and the relay arming that follows a confirmed list |
| `bindings-prompt.ts` | The binding editor's starting-prompt field — the one element in the panel that ever holds its text (005 FR-051) |
| `bindings-editor.ts` | The editor's derived field views: the mention token in force and its override mark (005 FR-057, no store in this build), the bound-account scope for edit vs add, and the worktree option declaration |
| `dispatches-controls.ts` | Paging, filter, and row-detail controls: range line, active-filter line, Previous/Next, page size, the source-reference reveal, and the correlation-id copy |
| `dispatches-service.ts` / `dispatches-rows.ts` | Run DTO parsed fail-closed across the eight dispatch states; each state's label, tone, and retry validity |
| `run-state.ts` | The eight-state dispatch vocabulary, its `blocked:<reason>` family, and the narrowers that refuse an unknown word |
| `relay.ts` | Relay tick: claim → handled key → guards → attempt; one handoff per `correlationId#attempt` per mount |
| `relay-gates.ts` / `relay-attempt.ts` | Binding/project guards, the `blocked` report, and the reserve step; then host call → record → report → acknowledge → read-back |
| `dispatch-record.ts` | `mecha-turk:dispatches`: the durable attempt record, written between the host call and its report and acknowledged on its own 2xx |
| `claim-service.ts` | Claim and run-history body parsers (strict: an unknown state refuses the body) |
| `reconcile.ts` | Mount-time re-report of every unacknowledged attempt, before the first claim (bounded, warns visibly) |
| `prerequisites.ts` | The six first-run prerequisites, each `met` / `not-met` / `not-checkable`, with its remediation line |
| `status-document.ts` / `status-lines.ts` / `status-tab.ts` | The `GET /v1/status` document parsed fail closed and the read state that holds it; the Status tab's operator-facing copy as pure functions; and the tab's mount, repaint, and single read |
| `settings-rows.ts` | The Settings tab's row builder: one row per projected descriptor plus one per undocumented member — name, unit-or-*none*, bounds-or-format, value, and class words, every one of them from the wire (005's bounds stand-in retired by 006 T-018) |
| `settings-schema.ts` | Fail-closed reader for `GET /v1/config`'s envelope: the closed descriptor union, plus the `unreadable` and `undisplayed` flags (006 T-017; FR-021, FR-027, FR-028) |
| `settings-tab.ts` | The Settings body: the one `GET /v1/config` read, its fail-closed read state, and the projection-driven rows (005 FR-070–FR-073, FR-078; 006 T-018) |
| `about-tab.ts` | The About body: the single version read from the service health answer (no panel-side literal), the static identity and posture copy, and the read-only Diagnostics section (005 FR-074–FR-077) |
| `audit-view.ts` | One run's audit history under its correlation id, rendered as text (never markup) |
| `agent-verify.ts` | Post-dispatch `openSession()` agent read-back, reported to the service (warn-only) |
| `handoff*.ts` / `account*.ts` / `consent*.ts` | One-shot token handoff, consent gate, credential-free account mirror |
| `accounts-rows.ts` / `accounts-tab.ts` | The Accounts tab: every FR-062 row word (lifecycle, connection, scope matrix, remediation, binding count) as pure functions, plus the body's mounts, repaint, and single read |
| `accounts-actions.ts` | The tab's writes: two-step removal with the `force=1` cascade the arm stated, the rotation arm the handoff routes on, and the display-name PUT that never applies a value the service did not confirm |
| `storage-write.ts` | Guarded storage writes |

## Module map (service, `service/`)

| Module | Responsibility |
| --- | --- |
| `main.ts` / `server.ts` / `http.ts` | Entry, loopback HTTP server, routing, body/size caps |
| `auth.ts` / `consent.ts` | Extension grant + consent gates on every call |
| `accounts/` | Durable account model, credential files, startup reconcile |
| `bindings.ts` / `bindings-read.ts` | Whole-file bindings store (validated, capped) + the read path: quarantine-reason capture and the prompt-change observation funnel |
| `prompt.ts` / `prompt-audit.ts` | The starting-prompt domain (four refusals, `mtp-` fingerprint, run snapshot) and the per-store chain that writes exactly one `binding.prompt-updated` row per change |
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
| `poll/excerpt-trim.ts` | The excerpt retention pass: text-only clearing on terminal rows past `excerptRetentionDays`, the `excerptTrimmedAt` marker, and one `audit.trimmed` row after the rewrite (006 FR-057) |
| `routes/` | `/v1/status`, `/health`, `/v1/bindings`, `/v1/accounts`, `/v1/events*`, credential verify |
| `routes/dispatch.ts` / `routes/run-ops.ts` | Reserve, result, abandon, blocked; retry, requeue, resolve, verification |
| `routes/audit.ts` | `GET /v1/audit`, filtered by correlation identifier |
| `routes/run-scope.ts` / `routes/run-fields.ts` / `routes/run-answer.ts` | Shared run-scoped path/body readers and the `200` / refusal envelopes |
| `audit.ts` / `log.ts` | `audit.ndjson` rows + structured, secret-free logs |
| `audit-trim.ts` | The audit retention pass: FR-056's protected set computed by rule, oldest-first removal under the day window and the entry cap, survivors plus their `audit.trimmed` row in one atomic rewrite |
| `config-audit.ts` | The `config.changed` row: `configChanges` (which doubles as the no-op detector), the `applied` shape with `from`/`to`/`takesEffect`, and the value-free `refused` shape (006 FR-070–FR-072) |
| `retention.ts` | Both retention passes wired at their two boundaries — store open and the cycle boundary — each guarded so one failure still runs the other (006 FR-055, FR-057, FR-047) |
| `store/` | 0700/0600 store, JSON/NDJSON IO, quarantine-and-repair reads |
| `config.ts` / `env.ts` / `throttle.ts` | Operator-tunable polling/retry/retention, env, rate budgets |
| `config-schema.ts` | That declaration projected onto the wire: the exhaustive `TAKE_EFFECT` table, the closed `FieldDescriptor` union, `configSchema()` (006 FR-020–FR-022) |

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
