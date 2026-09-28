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
├── specs/003-code-reorg/                 # repo-reorganization plan/tasks
├── README.md             # user-facing (install, configure, operate)
├── .specify/             # constitution + spec-kit scripts/templates
└── .opencode/commands/   # speckit slash commands
```

`specs/` documents are dated records of the phase that produced them —
path/identity details in older plan/data-model files may predate the 003
reorg (extension at the repo root, identity `mecha-turk`). The maintained
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
| `evidence.ts` | Normalized, redacted evidence record |
| `ledger.ts` / `ledger-repair.ts` | Redacted `host.storage` ledger, phases, gap analysis, bounded-write repair |
| `session.ts` / `host-verify.ts` | `startSession()` framing + host-owned project/worktree/session read-back |
| `lifecycle.ts` | Lifecycle experiment plan and mount bookkeeping |
| `panel-state.ts` / `panel-ui.ts` | Shared runtime state; rendering with `@openchamber/sdk/ui` |
| `panel-actions.ts` / `panel-dispatch.ts` | Poll/identity/verify actions; the single dispatch path |
| `project-picker.ts` / `project-actions.ts` | Pure picker state; `listProjects()` + stored selection |
| `app.ts` | Wiring: mount, subscribe, teardown |
| `redaction.ts` / `json.ts` | Secret-shape detection; typed bridge to the host's `JsonValue` |
| `service-calls.ts` | Shared `host.serviceRequest()` GET/PUT/POST/DELETE wrappers |
| `bindings-mode.ts` | Bindings-authoritative mode: first enabled binding is dispatch context |
| `repos*.ts` / `runs*.ts` | Repositories tab (bindings, accounts, add form) + Runs history/retry |
| `relay.ts` | Event relay: claim → dispatch → report; one handoff per event id per mount |
| `agent-verify.ts` | Post-dispatch `openSession()` agent read-back (warn-only) |
| `handoff*.ts` / `accounts*.ts` / `consent*.ts` | One-shot token handoff, consent gate, credential-free account mirror |
| `storage-write.ts` | Guarded storage writes |

## Module map (service, `service/`)

| Module | Responsibility |
| --- | --- |
| `main.ts` / `server.ts` / `http.ts` | Entry, loopback HTTP server, routing, body/size caps |
| `auth.ts` / `consent.ts` | Extension grant + consent gates on every call |
| `accounts/` | Durable account model, credential files, startup reconcile |
| `bindings.ts` | Whole-file bindings store (validated, capped) |
| `poll/` | Per-binding scan loop, trigger detection over the rate budget, durable event queue (deterministic ids, claim, terminal dispatch) |
| `routes/` | `/v1/status`, `/v1/health`, `/v1/bindings`, `/v1/accounts`, `/v1/events*`, credential verify |
| `audit.ts` / `log.ts` | `audit.ndjson` rows + structured, secret-free logs |
| `store/` | 0700/0600 store, JSON/NDJSON IO, quarantine-and-repair reads |
| `config.ts` / `env.ts` / `throttle.ts` | Operator-tunable polling/retry/retention, env, rate budgets |

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
