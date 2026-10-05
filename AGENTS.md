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
npm test          # vitest, offline (1302 tests)
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
7. **Scoped suppressions, zero `any`.** No `@ts-ignore`, `@ts-expect-error`,
   `# type: ignore` — those are how code lies to the compiler, and a cast that
   satisfies a rule is the same lie as disabling it. A *described*
   `eslint-disable` is allowed, scoped to the line it excuses:
   `// eslint-disable-next-line <rule> -- <why the rule's premise does not
   hold here>`. Never a bare `eslint-disable`. Never file-wide, unless one rule
   needs it on more than five lines of that single file — then one
   `/* eslint-disable <rule> -- <why> */` at the top. The reason must name the
   premise that fails, not a preference; "we prefer it this way" is not a
   reason. Whole-repo `'off'` in `eslint.config.mjs` is for a rule the
   codebase deliberately answers differently *everywhere* it applies; below
   roughly twenty sites the suppression belongs on the line, where a reader can
   see what it excuses and a change to the file cannot silently widen it. The
   default is still to fix the code, not the tool.
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

## Where things live

Each module's own header comment says what it is for; read that before
changing it. The shape:

- `src/` — panel modules, one responsibility each. `app.ts` wires mount,
  subscribe and teardown; `tabs.ts` and `tab-bodies.ts` own the six-tab
  shell; `relay*.ts` claim a run and hand off one `host.startSession()`;
  `*-service.ts` files are the fail-closed readers of a service answer, and
  `*-rows.ts` / `*-detail.ts` files are pure rendering.
- `service/` — the stdlib-only local service. `server.ts` / `http.ts` /
  `routes/` are the loopback HTTP surface, `poll/` is the scan loop, event
  queue and run lifecycle, `store/` is the 0700/0600 durable store, and
  `accounts/` holds the credential files.
- `specs/` — dated records of the phase that produced them.
  `specs/002-agent-event-extension/` is the production spec and the anchor
  for invariants 4 and 10; later directories amend it. Each spec's
  `changelog.md` says why a requirement changed. A spec's `pm-handoff.md` is
  **kept for provenance, not for coordination**: 003's is the recorded scope
  source for 004–006, and 002's `## Flagged` is cited by four later documents.
  No repo rule requires writing one (that lives in the global `agent-routing`
  and `orchestration` skills), so a new feature creates a file rather than
  editing these — and **nothing validates relative links in `specs/`**, so a
  deletion that breaks a citation is silent.

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
