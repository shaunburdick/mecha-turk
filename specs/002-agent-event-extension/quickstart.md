# Quickstart: Mecha Turk production extension + local service

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27
Dev, build, test, install, and first-run verification for the production package (panel + service). The repository root is the installable unit.

## 0. Prerequisites (operator machine)

1. **OpenChamber desktop or web** running (unattended operation = "while OpenChamber is up"). VS Code/mobile do not spawn services → the panel shows the unsupported state there.
2. **Settings → Sessions → Session Defaults → Default Agent** — set it to **the agent your dispatches should run on** (`project-manager` is the usual choice; the extension cannot set it), and set the matching **`expectedAgent`** baseline on **Settings** so post-dispatch verification has something to compare against. With the baseline blank (the shipped default), a read-back records the observed agent and compares nothing — 002 FR-029 as amended at v1.10.0.
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
- The manifest ships from the repository root `package.json`: `contributes.panel`, `contributes.service` (`runtime: "host"`, **no `permissions` key** — loopback network only), and `capabilities: ["sessions", "prompt"]`. There is **no `contributes.integration` card**: the install-time GitHub token card and its two products (a connected-login badge, a `/user` diagnostic) were removed by product-owner order on 2026-09-30, so the panel makes no GitHub request of its own and `network` is no longer requested.

## 2. Verify (every commit)

```sh
npm run verify       # build → lint → typecheck → test
```

Expect: 0 lint errors/warnings (zero suppressions — no `eslint-disable`, no `@ts-ignore`, no `any`), 0 type errors, all vitest suites green (panel units, service units, contract tests, secret scans).

## 3. Install

1. OpenChamber → **Settings → Extensions** → paste `https://github.com/shaunburdick/mecha-turk` (git-URL install; append `#tag` to pin), or the absolute path of the repository root for a local folder install.
2. Approval dialog shows `sessions`, `prompt`, `service`. Read the local-service line (*"a separate program with your full user access"*) and choose **Allow and enable**.
3. Open the **Mecha Turk** rail panel. It opens on **Status**: the honest projection (service, polling, accounts, bindings, agent pin) with the **Setup prerequisites** section beneath it — five lines (Default Agent pin, OpenChamber running, desktop-or-web surface, GitHub token scopes, registered project per binding), each rendered *met*, *not met*, or **not checkable by the panel**, each with its own remediation, and any checkable-and-unmet item also raises a notice above the tabs. The Default Agent pin reads **not checkable** on purpose (the panel cannot read that setting), so §0 step 2 remains the operator's own action; verification still reads the pin back after every dispatch and warns when a session reports another agent.

   The strip has six tabs, in order: **Status** (the overview and prerequisites above), **Dispatches** (every queued, running, and finished dispatch, with paging and filters), **Bindings** (the repositories you watch, plus the project picker and the add form), **Accounts** (the GitHub accounts, their scope, and the add form), **Settings** (the single configuration input for the whole service configuration), and **About** (name, version, description, the repository link, and read-only diagnostics behind a disclosure).

## 4. First run (happy path, ~5 minutes)

1. **Read the disclaimer**: Accounts tab → under the account list sits the static disclaimer — your token goes to the local service (sandbox-advisory: *"an allowed service has your full user access"*), is stored outside OpenChamber extension storage at file permissions and unencrypted (plaintext) on disk, and the connection is recorded in the service audit as an occurrence only, never the token. It is always visible; there is nothing to accept or decline.
2. **Add account**: Accounts tab → paste PAT → `Connected as <login>` with numeric id. One optional field sits beside the paste: **expected GitHub login** — the per-account constraint from FR-009, supplied where the account is created (leave it empty for no constraint). The token exists only in transit; panel state, storage, logs, and audit contain no token bytes (asserted by the secret-scan suite).
3. **Add repository**: choose the account → choose an existing project from the picker → enable triggers (assignment / review request / mention; mention defaults to `@<login>`, case-insensitive). If the project isn't registered: `project_missing` + manual "Add project" guidance — no project is created by the extension.
4. **Watch health**: `serviceStatus()`, per-repo last poll + checkpoint age, per-account rate usage, agent-pin status (the configured `expectedAgent` baseline, or *none configured*, plus the last verification).
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
| V6 | Set Default Agent to something else (with an `expectedAgent` baseline configured) | Next dispatch → the **Dispatches** tab warns *"dispatched, but the session agent was '\<x\>' (expected \<baseline\>)"* + a `session` ledger entry with `agentVerified: false` + a green banner when it *does* match. With **no baseline configured** the read-back records the observed agent and compares nothing — the row says *agent read back … no baseline is configured* (002 v1.10.0). **Warn-only by M9's re-cut: the session keeps running, nothing is blocked** (the spec's `blocked:agent-mismatch` is deferred with the service-side mirror) |
| V7 | Uninstall the extension | Panel storage wiped (the panel is back at the §3 first view, no checklist); **service store under `~/.config/openchamber/mecha-turk/` still present** — path printed on the **Status** tab before uninstall (live proof = task T-033) |
| V8 | Unsupported surface (VS Code/mobile if available) | Explicit unsupported/disabled state; nothing claims to be polling |
| V9 | Select a dispatch row → **Audit history** | The dispatch's trail appears in `seq` order under its correlation identifier — creation, claim, authorization, result, verification — credential-free and without opening a file; poll, checkpoint, and legacy consent rows are not in it (003 AC-117/AC-118) |

## 6. Service store & backup

- Location: `$HOME/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`) — the documented default OpenChamber data dir + our folder (research R2). The absolute path is shown on the **Status** tab and in `GET /v1/status`.
- `accounts/*.json` contains **plaintext PATs**. Treat the folder like `~/.ssh`: include it in backups deliberately, never commit it (the repository's ignore rules cover environment files; no store path lies inside the repo).
- The store also holds `events.json` (the delivery queue), **`runs.json`** — since 003: one run per subject with its lease, single-use dispatch token, attempt history, per-subject ordinal counter, and the durable audit outbox — `bindings.json`, `scan-state.json`, `config.json`, `state.json`, and `audit.ndjson`. Upgrading from a pre-003 build adopts the existing queue into runs on first read without quarantining a file or resetting a scan window.
- If you run OpenChamber with a custom `OPENCHAMBER_DATA_DIR`, the service still writes to the default path above (the service env does not receive host variables) — documented limitation, surfaced in health.

### Starting prompt (004)

The starting prompt is a block of operator text the session opens with,
above the automatic framing — and it exists at exactly **three tiers**:

| Tier | Covers | Set it on |
| --- | --- | --- |
| **Global** | every dispatch the service detects | **Settings** → the `startingPrompt` row (004 FR-081) |
| **Account** | every dispatch polled by that GitHub account | **Accounts** → the account's *Starting prompt* field, saved by `PUT /v1/accounts/:numericUserId` (absent member = unchanged) |
| **Binding** | every dispatch from that binding | **Bindings** → the binding editor's starting-prompt field (005 T-021) |

- **The tiers stack, most general first** — global → account → binding, one
  blank line between consecutive set tiers, all of them inside the single
  `--- BEGIN OPERATOR STARTING PROMPT ---` fence with the automatic frame
  beneath. **An unset tier contributes nothing**: no empty line, no
  placeholder, no note — and with all three unset the message is byte-identical
  to the pre-004 composition. No tier labels appear in the message; the tiers
  that contributed are named as `promptSources` on the dispatch row and in the
  audit trail instead.
- **Set it** on the surface in the table — one field per tier, each value
  rendered exactly once in the panel, each showing an explicit *not set* state
  while empty. One validator guards all three save paths; a refusal at one
  tier never touches the other two.
- **Clear it** by emptying that tier (or, in a store record, leaving the member
  out / writing `null` / `""`). A tier with no prompt contributes nothing, and
  a binding with no prompt at all dispatches byte-identically to what it
  dispatched before this field existed.
- **The text is literal — no placeholders.** Nothing is substituted or expanded;
  `{number}` arrives as those seven characters.
- **The session's agent is your pinned Default Agent, and the text cannot change it.** A prompt that names an agent is delivered as ordinary instruction text.
- **2,000 characters** (Unicode code points) after trimming, **per tier**; longer values are refused naming the field and the cap, never truncated.
- **A credential-shaped value is refused, not stored.** The save is blocked, the previous prompt stays in force, and the rejected value reaches no file, log, audit row, or bundle.
- **Omission preserves on a whole-file save.** `PUT /v1/bindings` replaces the whole list, so a binding submitted *without* the member keeps whatever the store already holds for it — only an explicit value changes it. The panel saves this way, so your prompt survives an unrelated save.
- **Malformed values quarantine the file** with `startingPrompt: <remediation>` logged (never the value); every binding stops scanning until you repair it.

#### The store files are the low-level path

The stores hold the same values — `bindings.json` (binding tier), the account
records under `accounts/` (account tier), and `config.json` (global tier), all
under `~/.config/openchamber/mecha-turk/` (dir `0700`, files `0600`). The
fields above are the primary set path; the files are the validated low-level
one: add `"startingPrompt": "…"` to the record you want, or leave the member
out / write `null` / `""` to clear it.

Each change writes exactly one audit row for its tier —
`binding.prompt-updated`, `account.prompt-updated`, or a `config.changed`
row whose `from`/`to` for this field are fingerprints (`mtp-…`) or `null` —
naming the entity, the `mtp-…` fingerprint, presence, length, actor — never
the text. The instruction lives in exactly two places: that tier's own record
and the snapshot taken when the event was detected, so an edit never changes
queued work and a retry composes a byte-identical message.

### When a binding starts watching (002 v1.13.0)

A binding scans **from now on** by default: its window's lower bound is its own
creation boundary, widened by the configured overlap. It never re-reads anything
older, so a binding you add today will not open dispatches for last month's
assignments.

- **The one other option** is a **seven-day look-back**, on the binding editor's
  *When this binding starts watching* field. It is offered in words, not as a
  stored name: *From now on (default)*, or *From now on, and look back over the
  last seven days once*.
- **The look-back happens once.** After that first sweep the binding's window
  moves on to the ordinary incremental one, and the look-back is not repeated on
  its own. Choosing it again re-arms one more bounded catch-up — the same thing
  the panel's save does when you switch an existing binding into that mode.
- **The window is always bounded, and there is no "all history" option.** The
  look-back is a fixed service-side length that no setting changes; nothing in the
  panel or the store can ask for an unlimited window.
- **On a new binding** the look-back reaches back from before the binding
  existed, so it may offer a batch of older work at once. On an **existing**
  binding it does the same thing and may offer **many sessions** — that is the
  trade the option makes, and it is why the field says so.
- **A recovery replay after data loss re-offers work regardless of this setting.**
  If the delivery queue is lost and has to be quarantined, the service clears the
  scan checkpoints and re-offers each binding's in-window work in **both** modes.
  A burst of older events appearing together is that, not a look-back you did not
  ask for.
- **Omission preserves on a whole-file save**, like the starting prompt: a binding
  submitted without the member keeps whatever the store holds. Clear it by
  choosing the default.

**Upgrade consequence, stated plainly.** A binding that existed **before** this
field did and has **not yet completed its first scan** keeps the same
behaviour it always had — it starts at its creation boundary and skips its
backlog. Choosing the look-back on it afterwards is the supported way to ask for
that window. The upgrade itself writes nothing: a pre-existing `bindings.json` and
`scan-state.json` are byte-identical after it.

**Audit.** Each change writes exactly one `binding.history-scope-updated` row
naming the previous mode, the new one, and who made it (`operator` for a panel
save, `service` for an edit you made to `bindings.json` yourself). Resubmitting
the mode already in force writes nothing, and there is no row per observation.

#### The low-level path

The value is the optional `historyScope` member of a binding record in
`bindings.json`: `"new-only"` or `"recent-history"`. Leaving the member out, or
writing `null`, means *from now on*. Any other value — a number, a boolean, an
object, an array, `""`, or an unrecognized name — is **refused**, and a
hand-edited file carrying one is quarantined with the field and the two accepted
names logged (never the value), so every binding stops scanning until you repair
it. **There is no member to set the look-back length**: the seven days is a
service constant, not something the document stores.

### Configuration (the Settings tab)

The **Settings** tab is the **single configuration input** for the whole
service configuration: every documented field — poll interval, overlap
window, page size, the retry bounds, the audit limits, excerpt retention, the
lease and result deadlines, the log level, the agent-verification baseline
(`expectedAgent`), and the global starting prompt (`startingPrompt`) — each
rendered from the service's own declaration with its value, its unit, its
bounds or format, and the line that says **when a change takes effect**
(*takes effect immediately*, *in effect from the next poll*, *in effect from
the next dispatch*).

Editing is live: one save writes the whole document and the service is the
only validator, so a value outside a field's bounds is sent and refused there
with a field name and a remediation rather than blocked by the panel.
Lowering a retention limit — and restoring the defaults — first arms a
two-step confirmation that states **what will be deleted, when the trim pass
runs, and what survives it**; raising a limit deletes nothing, and the panel
says so.

The configuration lives in `config.json` in the service store (`0600`, under
the data directory **Status** names), so it is operator-backable: you can back
it up or hand-edit it, and a document that fails validation is set aside and
the documented defaults take over, with the tab saying exactly that. Nothing
is configured through an environment file, an environment variable, or an
integration-card setting.

There is no integration card any more (product-owner order, 2026-09-30), so
nothing is configured through card fields, and the *agent-verification
baseline* was never one: that baseline (`expectedAgent`, **blank by default** —
no baseline means no comparison) is service configuration, read by verification
through `GET /v1/config`; when the document carries no usable value the
read-back records the observed agent without judging it (002 v1.10.0). The
Settings tab is therefore where you both read and change what the service is
actually using.

## 7. Cleanup (manual only)

The extension never deletes sessions, worktrees, or projects. Route cleanup to OpenChamber's own surfaces (session list, worktrees view, project management). Disabling a repository binding stops its polling; removing the extension stops the service (SIGTERM) and clears its grant.

## 8. Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| `NO_SERVICE` on first use | `service` capability not approved | Settings → Extensions → review permissions |
| `SERVICE_FAILED` | Service crashed or never became ready within 15 s | Manual retry from the **Status** tab; there is no `service.failed` audit row — `audit.ndjson` speaks `account.*`, `binding.disabled`, `delivery.detected`, `delivery.recovered` (plus legacy `consent` rows on installs upgraded from earlier builds, which stay readable and are written by nothing), and a binding row's `lastError` carries why its last scan skipped |
| Handoff refused | Storage pre-flight failed, capability not approved, or the token itself refused (F1/F10) | Fix store permissions, approve capabilities (`NO_SERVICE`), or follow the on-screen reason for the token |
| A dispatch row's result reads `project "<id>" is not registered in OpenChamber` | A binding must name an existing project (the add form only offers registered ones) and this one was unregistered afterwards | Register the project in OpenChamber — the extension never creates one — then **Retry dispatch**. Since 003 a guard refusal like this one holds the dispatch in `blocked: project-missing` with the cause on the row (retryable once the project is back) instead of recording a dispatch that made no session as a success |
| Warning *"dispatched, but the session agent was '\<x\>'"* | Default Agent ≠ the baseline | Set Session Defaults → Default Agent (or correct the baseline, which is service configuration read through `GET /v1/config`, not an integration-card setting); M9 is **warn-only** — the dispatch stays `dispatched` with a warning, nothing is blocked |
| `storage-unavailable` | Data dir not writable | Fix permissions on `~/.config/openchamber/mecha-turk` (FR-039 blocks degraded starts) |
