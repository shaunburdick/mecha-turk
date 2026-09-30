# Quickstart: Mecha Turk production extension + local service

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27
Dev, build, test, install, and first-run verification for the production package (panel + service). The repository root is the installable unit.

## 0. Prerequisites (operator machine)

1. **OpenChamber desktop or web** running (unattended operation = "while OpenChamber is up"). VS Code/mobile do not spawn services → the panel shows the unsupported state there.
2. **Settings → Sessions → Session Defaults → Default Agent = `project-manager`** (the only documented agent pin; enforced post-dispatch by verification).
3. A **registered OpenChamber project** for each repository you will bind (command palette → Add project, sidebar **+**, or folder browser — the extension cannot create projects).
4. **GitHub fine-grained PATs**, one per account, with `Metadata: read`, `Issues: read`, `Pull requests: read` (+ `Contents: read` only if repository metadata is passed to OpenChamber). **No write scopes.** Organization approval granted where required. The Notifications API is not used.
5. Toolchain for development: Node ≥ 20.19, npm, `bun` (for `openchamber-guest-bundle`).

## 1. Build

```sh
npm ci
npm run build        # panel IIFE + service ESM (both committed)
```

- Panel: `bunx openchamber-guest-bundle panel/main.ts panel/main.js` (classic IIFE).
- Service: `bunx openchamber-guest-bundle --node service/main.ts service/main.js` (ESM — ship built JS; the host never compiles TS).
- The manifest ships from the repository root `package.json`: `contributes.panel`, `contributes.service` (`runtime: "host"`, **no `permissions` key** — loopback network only), `capabilities: ["sessions", "prompt"]`, and the optional non-authoritative GitHub `integration` card.

## 2. Verify (every commit)

```sh
npm run verify       # build → lint → typecheck → test
```

Expect: 0 lint errors/warnings (zero suppressions — no `eslint-disable`, no `@ts-ignore`, no `any`), 0 type errors, all vitest suites green (panel units, service units, contract tests, secret scans).

## 3. Install

1. OpenChamber → **Settings → Extensions** → paste `https://github.com/shaunburdick/mecha-turk` (git-URL install; append `#tag` to pin), or the absolute path of the repository root for a local folder install.
2. Approval dialog shows `sessions`, `prompt`, `service`, `network`. Read the local-service line (*"a separate program with your full user access"*) and choose **Allow and enable**.
3. Open the **Mecha Turk** rail panel. It opens on **Status**: the honest projection (service, polling, accounts, bindings, agent pin) with the **Setup prerequisites** section beneath it — six lines (Default Agent pin, OpenChamber running, desktop-or-web surface, GitHub token scopes, registered project per binding, service-capability approval), each rendered *met*, *not met*, or **not checkable by the panel**, each with its own remediation, and any checkable-and-unmet item also raises a notice above the tabs. The Default Agent pin reads **not checkable** on purpose (the panel cannot read that setting), so §0 step 2 remains the operator's own action; verification still reads the pin back after every dispatch and warns when a session reports another agent.

   The strip has six tabs, in order: **Status** (the overview and prerequisites above), **Dispatches** (every queued, running, and finished dispatch, with paging and filters), **Bindings** (the repositories you watch, plus the project picker and the add form), **Accounts** (the GitHub accounts, their scope, and the add form), **Settings** (read-only service configuration), and **About** (identity, the data directory, and read-only diagnostics).

## 4. First run (happy path, ~5 minutes)

1. **Consent**: Accounts tab → the FR-008 consent step appears before any handoff ("service permissions are advisory in Phase 1; an allowed service has your full user access"). Accept → consent occurrence is audited (no token material).
2. **Add account**: Accounts tab → paste PAT → `Connected as <login>` with numeric id. One optional field sits beside the paste: **expected GitHub login** — the per-account constraint from FR-009, supplied where the account is created (leave it empty for no constraint). The token exists only in transit; panel state, storage, logs, and audit contain no token bytes (asserted by the secret-scan suite).
3. **Add repository**: choose the account → choose an existing project from the picker → enable triggers (assignment / review request / mention; mention defaults to `@<login>`, case-insensitive). If the project isn't registered: `project_missing` + manual "Add project" guidance — no project is created by the extension.
4. **Watch health**: `serviceStatus()`, per-repo last poll + checkpoint age, per-account rate usage, agent-pin status (`expected-agent` = `project-manager`).
5. **Trigger work**: assign an issue to the account identity (or request a review / mention). Within ≤2×60 s a row appears under **Dispatches**, `host.startSession()` fires, and — **expected behavior** — the app switches to the new chat once so the panel can read `onSession().agent` (the only documented mechanism, research R3). The row becomes `dispatched` with a session link; a dispatch that made no session keeps a **Retry dispatch** button that requeues it.

### Dispatch states and what the operator does (003)

Every dispatch row carries a state and a reason line, and each non-terminal
state offers the control that moves it:

| State | What it means | Control |
| --- | --- | --- |
| `dispatch failed` | The dispatch ran and made no session; the cause is recorded | **Retry dispatch** (same run key, attempt counted up) |
| `blocked: <reason>` | A fail-closed guard refused before any host call (unregistered project, missing or disabled binding) | Fix the cause, then **Retry dispatch** |
| `unconfirmed` | Intent was reported and no result arrived before the deadline — fail-closed | The panel reconciles on its next mount; otherwise **Resolve dispatch**, in one of its two explicit decisions, after checking OpenChamber's own session list |
| `dead-lettered` | The automatic requeue budget is spent | **Return to waiting** (resets the attempt count) |

Closing the panel mid-dispatch is safe by construction: a lease that expires
returns the dispatch to waiting with the attempt counted up and the reason
audited, while a reservation whose result never arrives is held `unconfirmed`
and is **never** re-dispatched automatically.

**Audit history**: select a dispatch row → **Audit history** reads that
dispatch's whole trail — creation, claim, authorization, result, verification
— from `GET /v1/audit?correlationId=` under its correlation identifier, in
`seq` order, credential-free and without file access (003 FR-053, AC-117).

## 5. Manual verification checklist (post-install)

| # | Step | Expected |
| --- | --- | --- |
| V1 | Close the panel while polling runs | Polling continues (service-side); reopen shows real state |
| V2 | Disable the extension | Polling stops; `serviceStatus()` path shows stopped/disabled honestly |
| V3 | Kill the service process | `SERVICE_FAILED`, durable state intact, **manual** retry only (no auto-loop) |
| V4 | Revoke a PAT on GitHub | That account's streams block with the capability named; other accounts unaffected; no token echoed |
| V5 | Re-dispatch protection | An already-dispatched event never creates a second session: **deterministic event ids** dedupe the queue (one assignment on one issue can only produce one event), the dispatch marks the row terminal `dispatched` (retained as one of the 500 dispatched rows kept for history), the panel handles each event id once per mount, and **Retry dispatch** answers a `dispatched` row with `409 invalid-transition` |
| V6 | Set Default Agent to something else | Next dispatch → the **Dispatches** tab warns *"dispatched, but the session agent was '\<x\>' (expected project-manager)"* + a `session` ledger entry with `agentVerified: false` + a green banner when it *does* match. **Warn-only by M9's re-cut: the session keeps running, nothing is blocked** (the spec's `blocked:agent-mismatch` is deferred with the service-side mirror) |
| V7 | Uninstall the extension | Panel storage wiped (the panel is back at the §3 first view, no checklist); **service store under `~/.config/openchamber/mecha-turk/` still present** — path printed on the **Status** tab before uninstall (live proof = task T-033) |
| V8 | Unsupported surface (VS Code/mobile if available) | Explicit unsupported/disabled state; nothing claims to be polling |
| V9 | Select a dispatch row → **Audit history** | The dispatch's trail appears in `seq` order under its correlation identifier — creation, claim, authorization, result, verification — credential-free and without opening a file; poll, checkpoint, and consent rows are not in it (003 AC-117/AC-118) |

## 6. Service store & backup

- Location: `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`) — the documented default OpenChamber data dir + our folder (research R2). The absolute path is shown on the **Status** tab and in `GET /v1/status`.
- `accounts/*.json` contains **plaintext PATs**. Treat the folder like `~/.ssh`: include it in backups deliberately, never commit it (the repository's ignore rules cover environment files; no store path lies inside the repo).
- The store also holds `events.json` (the delivery queue), **`runs.json`** — since 003: one run per subject with its lease, single-use dispatch token, attempt history, per-subject ordinal counter, and the durable audit outbox — `bindings.json`, `scan-state.json`, `config.json`, `state.json`, and `audit.ndjson`. Upgrading from a pre-003 build adopts the existing queue into runs on first read without quarantining a file or resetting a scan window.
- If you run OpenChamber with a custom `OPENCHAMBER_DATA_DIR`, the service still writes to the default path above (the service env does not receive host variables) — documented limitation, surfaced in health.

### Starting prompt (004)

`bindings.json` also holds one optional per-binding **starting prompt**: a block of operator text the session opens with, above the automatic framing. Until the panel grows a field for it, the store file *is* the set path.

- **Set it** by adding `"startingPrompt": "…"` to a binding record in `bindings.json` (same file, same permissions: dir `0700`, files `0600`).
- **Clear it** by leaving the member out, or by writing `null` / `""`. A binding with no prompt dispatches byte-identically to what it dispatched before this field existed.
- **The text is literal — no placeholders.** Nothing is substituted or expanded; `{number}` arrives as those seven characters.
- **The session's agent is your pinned Default Agent, and the text cannot change it.** A prompt that names an agent is delivered as ordinary instruction text.
- **2,000 characters** (Unicode code points) after trimming; longer values are refused naming the field and the cap, never truncated.
- **A credential-shaped value is refused, not stored.** The save is blocked, the previous prompt stays in force, and the rejected value reaches no file, log, audit row, or bundle.
- **Omission preserves on a whole-file save.** `PUT /v1/bindings` replaces the whole list, so a binding submitted *without* the member keeps whatever the store already holds for it — only an explicit value changes it. The panel saves this way, so your prompt survives an unrelated save.
- **Malformed values quarantine the file** with `startingPrompt: <remediation>` logged (never the value); every binding stops scanning until you repair it.

Each change writes one `binding.prompt-updated` row to `audit.ndjson` — binding id, `mtp-…` fingerprint, presence, length, actor — never the text. The instruction lives in exactly two places: the binding record and the run's snapshot taken when the event was detected, so an edit never changes queued work and a retry composes a byte-identical message.

### Configuration (the Settings tab)

The **Settings** tab is the configuration surface for the **whole** service
configuration: it renders every field `GET /v1/config` carries — poll
interval, overlap window, page size, the retry bounds, audit and excerpt
retention, the lease and result deadlines, and the log level — with each
field's value, its unit, its bounds, and an honest statement of where a change
would take effect. The tab is **read-only in this release**: it reads
`config.json` in the store and offers no edit control; editing arrives with
feature 006.

The integration card carries **no settings**, so nothing is configured through
card fields, environment variables, or an *agent-verification baseline* the
card no longer has: that baseline (`expectedAgent`, default
`project-manager`) is service configuration, read by verification through
`GET /v1/config` and falling back to the documented default when the document
does not carry the field. Changing anything in `config.json` is therefore the
only configuration input, and the Settings tab is where you read what the
service is actually using.

## 7. Cleanup (manual only)

The extension never deletes sessions, worktrees, or projects. Route cleanup to OpenChamber's own surfaces (session list, worktrees view, project management). Disabling a repository binding stops its polling; removing the extension stops the service (SIGTERM) and clears its grant.

## 8. Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| `NO_SERVICE` on first use | `service` capability not approved | Settings → Extensions → review permissions |
| `SERVICE_FAILED` | Service crashed or never became ready within 15 s | Manual retry from the **Status** tab; there is no `service.failed` audit row — `audit.ndjson` speaks `consent`, `account.*`, `binding.disabled`, `delivery.detected`, `delivery.recovered`, and a binding row's `lastError` carries why its last scan skipped |
| Handoff refused | Consent gate or capability gate (F1/F11) | Complete consent / approve capabilities |
| A dispatch row's result reads `project "<id>" is not registered in OpenChamber` | A binding must name an existing project (the add form only offers registered ones) and this one was unregistered afterwards | Register the project in OpenChamber — the extension never creates one — then **Retry dispatch**. Since 003 a guard refusal like this one holds the dispatch in `blocked: project-missing` with the cause on the row (retryable once the project is back) instead of recording a dispatch that made no session as a success |
| Warning *"dispatched, but the session agent was '\<x\>'"* | Default Agent ≠ the baseline | Set Session Defaults → Default Agent (or correct the baseline, which is service configuration read through `GET /v1/config`, not an integration-card setting); M9 is **warn-only** — the dispatch stays `dispatched` with a warning, nothing is blocked |
| `storage-unavailable` | Data dir not writable | Fix permissions on `~/.config/openchamber/mecha-turk` (FR-039 blocks degraded starts) |
