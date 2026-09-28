# Mecha Turk extension

The shipped Mecha Turk MVP for OpenChamber: one panel plus one
OpenChamber-hosted local service. The service polls the repositories bound to
a service account for the configured triggers (assignment, review request,
mention), queues every finding as a durable event, and the panel relays each
queued event into one documented `host.startSession()` call — with a redacted
ledger in `host.storage` and a runs history under the Repositories tab.

Honest boundary: polling runs service-side and continues while the panel is
closed; dispatch runs panel-side, because the frame is the only thing that can
call `host.startSession()`. The extension never creates a project, and every
worktree and session comes from OpenChamber's own harness through the
documented host surface — nothing here writes to disk, and the only GitHub
traffic is the service's outbound polling (plus the panel's legacy single-repo
spike poll, which rides the optional integration card). Unattended operation
therefore means "while OpenChamber and this extension's service are running".

## Layout

```text
extension/
├── package.json        # OpenChamber manifest (apiVersion 1) + pinned SDK
├── panel/
│   ├── index.html      # The page OpenChamber shows on the rail
│   ├── main.ts         # Entry point (connectHost + createSpikeApp)
│   └── main.js         # Bundled classic IIFE — committed, this is what ships
├── service/
│   ├── main.ts         # Service entry (bundled to service/main.js, ESM)
│   ├── server.ts       # Loopback HTTP server + route table
│   ├── accounts/       # Durable accounts: model, store, startup reconcile
│   ├── poll/           # Poll loop: scans, triggers, durable event queue
│   ├── routes/         # /v1 routes: status, health, bindings, accounts, events
│   └── store/          # 0700/0600 files, JSON/NDJSON, audit.ndjson
└── src/                # Panel logic, one responsibility per module
```

Module map (panel):

| Module | Responsibility |
| --- | --- |
| `config.ts` | Parse and validate the operator settings (fail closed) |
| `github.ts` | GitHub REST access through `host.request()` only (legacy spike poll) |
| `matching.ts` | The single configured-match rule |
| `evidence.ts` | Normalized, redacted evidence record (contract) |
| `ledger.ts` | Redacted `host.storage` ledger, phases, gap analysis |
| `session.ts` | Documented `startSession()` request/result handling |
| `host-verify.ts` | Host-owned project/worktree/session verification |
| `lifecycle.ts` | The S6 lifecycle experiment plan and mount bookkeeping |
| `panel-state.ts` | Shared runtime state |
| `panel-ui.ts` | Rendering with `@openchamber/sdk/ui` |
| `panel-actions.ts` | Poll, identity, verify, phase-marker actions |
| `panel-dispatch.ts` | The single dispatch path |
| `project-picker.ts` | Pure project-picker state, options, and selection text |
| `project-actions.ts` | `listProjects()` and the stored project selection |
| `app.ts` | Wiring: mount, subscribe, teardown |
| `redaction.ts` | Secret-shape detection and assertions |
| `json.ts` | Typed bridge from `JSON.stringify` to the host's `JsonValue` |
| `service-calls.ts` | Shared `host.serviceRequest()` GET/PUT/POST/DELETE wrappers |
| `bindings-mode.ts` | Bindings-authoritative mode: the first enabled binding is the dispatch context |
| `repos.ts` | Repos tab actions: read/grant bindings, bind/toggle/remove, account removal — arms the relay whenever a list with an enabled binding lands |
| `repos-service.ts` | Fail-closed parsers for the bindings, accounts, pending, and runs DTOs |
| `repos-mount.ts` / `repos-ui.ts` / `repos-rows.ts` | Repositories tab mount, bindings list + add form, row copy |
| `relay.ts` | The event relay: claim → dispatch → report, one handoff per event id per mount |
| `runs.ts` / `runs-service.ts` / `runs-rows.ts` | Runs history read, manual retry, row copy |
| `agent-verify.ts` | Post-dispatch `openSession()` read-back of the session agent (warn-only) |
| `handoff.ts` / `accounts-ui.ts` / `account-mirror.ts` / `account-adoption.ts` | FR-007/FR-008 one-shot token handoff, consent gate, credential-free account mirror |
| `consent.ts` / `storage-write.ts` / `ledger-repair.ts` | Consent mirror, guarded storage writes, ledger repair |

Module map (service):

| Module | Responsibility |
| --- | --- |
| `server.ts` / `http.ts` | Loopback HTTP server, routing, documented body/size caps |
| `auth.ts` / `consent.ts` | Extension grant and consent gates on every call |
| `accounts/` | Durable account model, credential files, startup reconciliation |
| `bindings.ts` | Whole-file bindings store (validated, capped) |
| `poll/loop.ts` / `poll/timer.ts` | Per-binding scan loop on its interval (never overlaps) |
| `poll/triggers.ts` / `poll/poller-github.ts` | Assignment, mention, and review-request detection over the rate budget |
| `poll/events.ts` / `poll/events-write.ts` / `poll/events-parse.ts` | Durable queue: deterministic event ids, claim, terminal dispatch, 500-row dispatched tail |
| `routes/` | `/v1/status`, `/v1/health`, `/v1/bindings`, `/v1/accounts`, `/v1/events*`, credential verify |
| `audit.ts` / `log.ts` | `audit.ndjson` rows (`consent`, `account.*`, `binding.disabled`, `delivery.*`) and structured, secret-free logs |
| `store/` | 0700/0600 store, JSON/NDJSON IO, quarantine-and-repair reads |
| `config.ts` / `env.ts` / `throttle.ts` | Operator-tunable polling/retry/retention, env, rate budgets |

## Build

```sh
npm install          # workspace install (root + extension)
npm run build        # bunx openchamber-guest-bundle — panel IIFE + service ESM
npm run verify       # build + lint + typecheck + tests
```

OpenChamber never compiles TypeScript and never installs dependencies, so
`panel/main.js` and `service/main.js` are built here and committed. Rebuild
after every source change, then reload the extension in OpenChamber.

## Install

1. Run OpenChamber on web or desktop (VS Code and mobile do not load extensions).
2. Settings → Extensions → Add.
3. Paste the absolute path of this `extension/` folder.
4. Approve the capabilities the dialog lists: `sessions`, `prompt`, `service`,
   `network` (`service` comes from `contributes.service`; `network` comes
   from the declared integration). The description there is the manifest's —
   read it before allowing.
5. Click the rail icon to open the panel.

A folder install runs from this folder directly, so edit, rebuild, reload.

## Configure

**Primary credential path — service accounts.** Register each GitHub account
once through the panel's one-shot token handoff (FR-007/FR-008 — the consent
step comes first, the token exists only in transit), then on the
**Repositories** tab add a repository: pick the account under **Poll as
account**, pick an existing project from the picker, choose the triggers, and
save. That binding is what the service polls under; accounts and bindings live
in the service's store, not in the panel.

**Optional integration card (FR-011).** Settings → Integrations → GitHub
(token) is *optional and non-authoritative*: it shows a connected-login
identity badge and backs the legacy single-repo spike poll's identity read. It
is never used for polling, discovery, or dispatch, and the product is fully
functional with it unconnected.

**Settings fields.** These configure the legacy single-repo spike path — the
one exception is `expected-agent`, which the relay's post-dispatch
verification also reads (see the repository root `.env.example` for the values
and their meaning):

- `repository` — `owner/name`
- `expected-login` — optional validation constraint
- `expected-agent` — agent a dispatched session should report; defaults to
  `project-manager` when unset (M9 reads it back after every dispatch and
  warns — never blocks — when the session reports something else)
- `project-id` — registered OpenChamber project
- `worktree-option` — `none`, `generated`, or `new:<branch>`
- `poll-interval-ms` — clamped to 15000–300000

Setting ids must match the SDK's `^[a-z][a-z0-9-]*$` pattern; the manifest
enforces it.

### Project id precedence

OpenChamber has no Settings surface that prints project ids, and the panel
cannot write integration settings — SDK 1.24.2 exposes `host.onSettings()` as
a host→guest push with no setter — so the panel ships a project picker that
lists `host.listProjects()` and stores the pick in extension storage. The
effective `projectId` is resolved in this order:

1. **Panel picker selection** — stored under the extension-namespaced
   `host.storage` key `mecha-turk-spike:project`. Picking a project writes it
   and re-resolves the configuration immediately.
2. **`project-id` integration setting** — used when no stored selection
   exists, which is the fresh-install and headless-configuration path.

Both sources are validated by the same rule (printable ASCII, at most 128
characters, no surrounding whitespace), neither can create a project, and a
source that holds nothing leaves dispatch blocked. The panel shows the
effective id and its source, with a **Copy project id** button for operators
who would rather also record it in the integration setting. The selection
changes only by picking another project from the list; a failed
`listProjects()` or a refused storage write never clears a selection that
already works, and never disturbs polling, dispatch, or the ledger.

## Tests

```sh
npm test
```

Offline coverage: manifest validation against the official SDK parser; the
panel's configuration, matching, redaction, ledger, evidence, project-picker,
handoff, bindings/relay-arming, and runs logic against a fake host; the
service's routes, store, audit trail, account lifecycle, scan triggers, and
event dedupe; and the shipped bundles' IIFE/secret assertions. Anything that
needs a live OpenChamber instance or a real PAT was executed by the operator
on their own instance and is recorded in
`specs/001-agent-event-orchestrator/spike-evidence.md` §4 (S1–S7 PASS) plus
the live loop validation in `specs/002-agent-event-extension/tasks.md` (M5).
