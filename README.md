# Mecha Turk

**GitHub work in, OpenChamber sessions out.** Mecha Turk watches the GitHub
repositories you bind to it for work meant for your accounts — issues assigned
to you, review requests, and mentions — and turns each discovery into an
OpenChamber agent session, with a durable record of every detection and every
dispatch.

Mecha Turk is an [OpenChamber](https://docs.openchamber.dev) extension: a rail
panel plus a local service that your own OpenChamber installation runs for
you. There is no hosted control plane — polling, storage, and dispatch all
happen on your machine.

## How it works

```text
GitHub (read-only) ──poll──> local service ──durable event queue──> panel ──> host.startSession()
                                │                                      │
                                └─ accounts, bindings, audit, runs     └─ redacted ledger in extension storage
```

- **The service polls** your bound repositories on an interval (default 60 s,
  clamped 15–300 s) for the triggers you enable. Polling is service-side, so
  it continues while the panel is closed.
- **The panel dispatches.** Triggers that hit the same issue coalesce into one
  **dispatch**, and a dispatch produces at most one `host.startSession()`
  call — OpenChamber's own harness creates the session, the worktree, and the
  chat. A single-use dispatch token makes a second session for one dispatch
  impossible rather than merely unlikely, and the **Dispatches** list shows
  every result with a manual **Retry dispatch** where a retry is allowed.
- **Everything is recorded.** Discoveries, dispatches, refusals, and account
  changes land in a durable audit trail and a redacted ledger, so you can
  always explain why an event was accepted, ignored, or retried.

### Honest boundaries

- The extension **never creates projects or worktrees itself** — it only asks
  OpenChamber for sessions inside projects you have registered.
- **Nothing runs while OpenChamber is off.** Polling and dispatch stop when
  OpenChamber stops, when the extension is disabled, or when its service is
  down — and the panel says so rather than pretending to be running.
- The only GitHub traffic is the service's outbound polling (plus one
  optional, read-only identity check). No inbound connections, no webhooks.
- Mecha Turk has **no GitHub write access**. It can read issues and pull
  requests; it cannot comment, label, assign, or merge.

## The panel: six tabs

The rail panel has one strip with six tabs, in order:

| Tab | What it is for |
| --- | --- |
| **Status** | The honest projection — service, polling, accounts, bindings, agent pin — plus the **Setup prerequisites** section: six lines, each *met*, *not met*, or **not checkable by the panel**, each with its own remediation, with any checkable-and-unmet item raised as a notice above the tabs |
| **Dispatches** | Every queued, running, and finished dispatch, newest first, with cursor paging and server-side filters by binding and by state; each row carries its state, its reason line, its correlation id, its source references, and the controls that move it (open, retry, resolve, return to waiting, audit history) |
| **Bindings** | The repositories you watch, the project picker with its *not listed?* guidance, and the add form |
| **Accounts** | Every GitHub account with its lifecycle, connection, and scope matrix, plus the add form: consent → PAT → optional expected GitHub login |
| **Settings** | The whole service configuration — read-only in this release; editing arrives with feature 006 |
| **About** | Product identity, the panel id, the version read from the service, the data directory to back up, the vocabulary list, and read-only diagnostics |

### Configuration

**Settings** is the configuration surface for the **whole** service
configuration: it renders every field `GET /v1/config` carries — poll
interval, overlap window, page size, retry bounds, audit and excerpt
retention, lease and result deadlines, log level — with each field's value,
unit, bounds, and an honest statement of where a change takes effect. The tab
reads `config.json` in the store and offers no edit control in this release.

The integration card carries **no settings**. The agent-verification baseline
(`expectedAgent`, default `project-manager`) is service configuration, not a
card field: verification reads it through `GET /v1/config` and falls back to
the documented default when the document does not carry it.

## Vocabulary mapping

The product says **Dispatches** for the unit of work and **Bindings** for the
watched-repository configuration, everywhere a human reads it. The wire paths
and the run domain keep their own names. This is the full mapping (005
`## Vocabulary Mapping`, normative):

| Today | 005 name | Layer | Disposition |
| --- | --- | --- | --- |
| Runs (panel section) | **Dispatches** | L1 | Renamed — one tab, one list |
| Repositories (panel tab) | **Bindings** | L1 | Renamed — one tab |
| "Run" on screen | **Dispatch** | L1 | Renamed — the row is a dispatch, the domain object is a run |
| `src/runs*.ts` | `src/dispatches*.ts` | L2 | Renamed |
| `src/repos*.ts` | `src/bindings*.ts` | L2 | Renamed |
| `PanelState.repos` | `PanelState.bindings` | L2 | Renamed |
| `ReposSection` | `BindingsSection` | L2 | Renamed |
| `RepositoriesStatus` | `BindingsStatus` | L2 | Renamed |
| `Repositories.activeTab` | *(deleted)* | L2 | Removed — the shell's single activation field replaces it |
| "Spike" tab | *(deleted)* | L1, L2 | Retired — not hidden, not reachable |
| `pendingPhase` | *Diagnostics* record | L2 | Renamed and moved — read-only in About |
| `run` (entity, key, ordinal) | `run` | L4 | Retained — the domain object is still a run |
| `attempt` | `attempt` | L4 | Retained |
| `run.` audit prefix | `run.` | L4 | Retained |
| `binding.` audit prefix | `binding.` | L4 | Retained |
| `GET /v1/events` and its operations | *retained* | L3 | Retained — the panel maps Dispatches onto them |
| `repositories` (status member) | `repositories` | L3 | Retained — rendered as **Bindings** |
| `GET` / `PUT /v1/bindings` | *retained* | L3 | Retained — already correctly named |
| panel id `mecha-turk` | *retained* | L3 | Retained |
| `extension-spike-1` evidence schema | *retained* | L4 | Retained |

## Requirements

- **OpenChamber desktop or web.** (VS Code and mobile builds do not run
  extension services; the panel shows an unsupported state there.)
- **A registered OpenChamber project** for each repository you will bind —
  the extension cannot create projects.
- **A GitHub fine-grained PAT per account**, read-only:
  `Metadata: read`, `Issues: read`, `Pull requests: read`
  (plus `Contents: read` only if you pass repository metadata to OpenChamber).
  **No write scopes.** Organization approval where your org requires it.
- Recommended: **Settings → Sessions → Session Defaults → Default Agent =
  `project-manager`** — after every dispatch Mecha Turk reads back which agent
  actually ran and warns (never blocks) if it was something else.

## Install

1. Run OpenChamber on web or desktop.
2. **Settings → Extensions → Add.**
3. Paste:

   ```text
   https://github.com/shaunburdick/mecha-turk
   ```

   Add `#v1.2.0`-style tag (or a branch name) to pin a specific version
   instead of the default branch.
4. Review the approval dialog and choose **Allow and enable**. Mecha Turk
   asks for exactly these four things:

   | Permission | What it means |
   | --- | --- |
   | `sessions` | Start agent sessions on your behalf when work is detected |
   | `prompt` | Use the host prompt surface when launching those sessions |
   | `service` | Launch a separate local program with your user access — the poller that watches GitHub |
   | `network` | Outbound HTTPS to `api.github.com` (polling, plus the optional identity card) |

5. Click the **Mecha Turk** icon on the rail.

**Updates:** OpenChamber checks git installs for a newer `version` at most
once an hour (or immediately via **Check for updates**). When a new version
is available you get an **Update** button; your permissions, accounts, and
settings carry over, and you re-approve only if the new version asks for more.

## Set up

1. **Register your projects** in OpenChamber (command palette → *Add
   project*) — one per repository you intend to bind.
2. **Add a GitHub account** — panel → **Accounts** tab:
   - A consent step appears first (an allowed service has your full user
     access; the step exists so you accept it knowingly).
   - Paste a fine-grained, read-only PAT. The token exists only in transit:
     it is never written to panel state, storage, logs, or the audit trail.
   - Optionally type an **expected GitHub login** — the per-account constraint
     from FR-009, supplied where the account is created. Empty means no
     constraint; a value that disagrees with GitHub's `/user` answer is
     refused fail-closed.
   - You should see `Connected as <your login>`.
3. **Bind a repository** — panel → **Bindings** tab → *Add binding*:
   - **Poll as account**: the account to poll as
   - **Project**: an existing OpenChamber project from the picker
   - **Triggers**: assignment, review request, and/or mention
     (mentions default to `@<your login>`, case-insensitive)
   - Save. Polling starts within one interval.
4. **Optional identity card** — Settings → Integrations → **GitHub (token)**
   is a *non-authoritative* convenience: it shows a connected-login badge and
   backs one read-only identity diagnostic. It is never used for polling,
   discovery, or dispatch, and Mecha Turk works fully without it.
5. **Read the panel's setup prerequisites** — the **Status** tab shows a
   **Setup prerequisites** section covering the six things a first dispatch
   needs:
   the Default Agent pin, OpenChamber running, the desktop-or-web surface,
   the GitHub token scopes, a registered project per binding, and
   service-capability approval with the in-panel consent step. Each line has
   its own state — *met*, *not met*, or **not checkable by the panel** — and
   its own remediation. The Default Agent pin is reported as not checkable
   because the panel genuinely cannot read that setting, and any checkable
   prerequisite that is unmet also raises a notice above the tabs.

## Starting prompt

A binding can open its sessions with **your** sentence. The starting prompt is
one block of operator text per binding, delivered to the agent verbatim as the
first thing it reads, above the automatic framing Mecha Turk builds from the
event. It is configuration, not a template, and it is per binding only —
there is no account-level or global prompt, and no default is ever invented
for a binding that has none.

What the field guarantees:

- **The text is literal — no placeholders.** `{number}`, `$var`, and `%s`
  arrive as those exact characters. Nothing is substituted, expanded, or
  interpolated, now or later.
- **The session's agent is your pinned Default Agent, and the text cannot
  change it.** The prompt is instruction, never a selector: no wording in it
  selects an agent, model, or variant, and the post-dispatch read-back still
  reports the agent the session actually ran under.
- **2,000 characters** (Unicode code points) after trimming. A longer value is
  refused naming the field and the cap — it is never truncated silently.
- **A credential-shaped value is refused, not stored.** If the text looks like
  a token, an `Authorization:` header, or a bearer credential, the save is
  refused, the previously stored prompt stays in force, and the rejected value
  appears nowhere: not in the file, not in a log, not in an audit row, not in
  a bundle.
- **Reserved markers are refused.** A line starting with `--- BEGIN ` or
  `--- END ` would imitate the composition's own containment structure, so it
  is refused rather than delivered. Those two prefixes are the whole rule, so
  a marker added later is covered without a new rule.
- **No content policy.** Those four refusals — length, credential shape,
  reserved marker, well-formedness — are the complete set. What you say to
  your own agent is your own business.

### Setting it until the panel grows the field

There is no editor for this field yet. The supported way to set it is the
service's own bindings store:

`~/.config/openchamber/mecha-turk/bindings.json` — directory `0700`, files
`0600`, the same file the panel already saves through.

Add the `startingPrompt` member to the binding you want:

```jsonc
[
  {
    "bindingId": "bnd-…",
    "repository": "owner/name",
    "startingPrompt": "Reproduce first, then patch. Say so in the summary."
  }
]
```

Leave the member out — or set it to `null`, or to an empty string — to clear
it: a binding with no prompt dispatches with the automatic framing only,
byte-identically to what it dispatched before this field existed.

The file is validated on read. A value that breaks the rules above quarantines
the whole file with the reason logged (`startingPrompt: <remediation>` — never
the value), and every binding stops scanning until you repair it. No file is
silently rewritten and no binding is silently dropped.

### Whole-file saves preserve it

`PUT /v1/bindings` replaces the whole list, so a submitted binding **without**
the member keeps whatever the store already holds for it — only an explicit
value changes it. The panel saves this way today, which is exactly why your
prompt survives an unrelated save elsewhere in the list.

Every change writes one `binding.prompt-updated` row to `audit.ndjson`: the
binding, the new fingerprint (`mtp-…`), presence, length, and who made the
change — never the text. The instruction itself lives in exactly two places,
the binding record and the dispatch's own snapshot at detection, so a retry
composes a byte-identical message and an edit never changes queued work.

## First dispatch

1. Assign an issue to the bound account's identity (or request a review /
   mention the account).
2. Within about two poll intervals, a row appears under **Dispatches** and
   `host.startSession()` fires — the app may switch to the new chat once so
   the panel can verify which agent took the session.
3. The dispatch is marked **dispatched** with a link to the session. A
   dispatch that made no session keeps a **Retry dispatch** button (an
   already-dispatched dispatch never re-dispatches).
4. Select the dispatch row and press **Audit history** to read that
   dispatch's whole trail — creation, claim, authorization, result,
   verification — under its correlation identifier, in order, from the panel
   alone.

## When a dispatch doesn't go through

Every dispatch carries a state and a reason line, and each non-terminal state
has a control that moves it:

| State | What it means | What you do |
| --- | --- | --- |
| `dispatch failed` | The dispatch ran and made no session; the cause is recorded | **Retry dispatch** — same dispatch, attempt counted up |
| `blocked: <reason>` | A fail-closed guard refused before any session was started (unregistered project, missing or disabled binding) | Fix the cause, then **Retry dispatch** |
| `unconfirmed` | A session may exist: intent was reported and no result arrived before the deadline | The panel reconciles this on its next mount; otherwise **Resolve dispatch**, only after checking OpenChamber's own session list |
| `dead-lettered` | The automatic requeue budget is spent | **Return to waiting** (resets the attempt count) |

Closing the panel never strands work: a claim whose lease expires returns to
waiting on its own with the attempt counted up and the reason audited, while a
dispatch whose result never arrived is held `unconfirmed` and is **never**
re-dispatched automatically — only an explicit operator decision can do that.

## Where your data lives

| Location | Contents | Survives uninstall? |
| --- | --- | --- |
| `~/.config/openchamber/mecha-turk/` | Accounts (**plaintext PATs**), repository bindings, event queue, runs (`events.json`, `runs.json`), scans, `audit.ndjson` | ✅ yes |
| OpenChamber extension storage | Panel UI state + redacted dispatch ledger | ❌ wiped on uninstall |

Treat the service folder like `~/.ssh`: include it in backups deliberately,
never commit it, and revoke a PAT on GitHub the moment you no longer need it.
The absolute store path is printed in the panel's **Status** view and in
`GET /v1/status`.

## Security at a glance

- **Read-only credentials only** — Mecha Turk cannot write to GitHub.
- **Tokens never appear** in logs, the ledger, panel storage, or audit rows
  (a secret-scan test suite enforces this on every commit).
- **Fail closed**: a missing, stale, or ambiguous configuration blocks
  dispatch instead of guessing — no project is ever created implicitly.
- **One session per event**, enforced by deterministic event ids — repeated
  observations or restarts cannot create duplicate agent work.

## Uninstall

**Settings → Extensions → Remove.** This stops the service, clears its grant,
and wipes panel storage. The service store under
`~/.config/openchamber/mecha-turk/` remains until you delete it yourself.
Mecha Turk never deletes sessions, worktrees, or projects — remove those
through OpenChamber's own surfaces.

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| `NO_SERVICE` | The `service` capability wasn't approved | Settings → Extensions → review permissions |
| `SERVICE_FAILED` | The service crashed or wasn't ready within 15 s | Retry from **Status**; check the store path's permissions |
| Handoff refused | Consent or capability gate | Complete the consent step / approve capabilities |
| A dispatch shows `project "<id>" is not registered` | The project was removed from OpenChamber after binding | Register the project again, then trigger the work for a fresh event |
| Warning: dispatched, but the session agent was `\<x\>` | Default Agent ≠ expected agent | Set Session Defaults → Default Agent (warn-only — the session still runs) |
| `storage-unavailable` | Data dir not writable | Fix permissions on `~/.config/openchamber/mecha-turk` |
| Polling seems stale | OpenChamber or the service isn't running | Both must be up; **Status** shows the honest state |

## Development

```sh
npm ci           # toolchain
npm run verify   # build → lint → typecheck → test
```

The panel and service bundles (`panel/main.js`, `service/main.js`) are
committed — OpenChamber never compiles TypeScript on install. Rebuild and
commit them with any source change. See [AGENTS.md](AGENTS.md) for the
layout, invariants, and contributor workflow.

## License

MIT
