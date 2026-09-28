# Mecha Turk extension spike

The smallest possible OpenChamber extension that can prove (or disprove) the
extension-first architecture: one declared GitHub integration, one repository
poll, one matching rule, one `host.startSession()` call, and a redacted ledger
in `host.storage`.

It is a validation harness, not a production orchestrator. Nothing here creates
a worktree, writes to disk through the host, or runs without the panel.

## Layout

```text
extension/
├── package.json        # OpenChamber manifest (apiVersion 1) + pinned SDK
├── panel/
│   ├── index.html      # The page OpenChamber shows on the rail
│   ├── main.ts         # Entry point (connectHost + createSpikeApp)
│   └── main.js         # Bundled classic IIFE — committed, this is what ships
└── src/                # Panel logic, one responsibility per module
```

Module map:

| Module | Responsibility |
| --- | --- |
| `config.ts` | Parse and validate the operator settings (fail closed) |
| `github.ts` | GitHub REST access through `host.request()` only |
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

## Build

```sh
npm install          # workspace install (root + extension)
npm run build        # bunx openchamber-guest-bundle panel/main.ts panel/main.js
npm run verify       # build + lint + typecheck + tests
```

OpenChamber never compiles TypeScript and never installs dependencies, so
`panel/main.js` is built here and committed. Rebuild after every source change,
then reload the extension in OpenChamber.

## Install

1. Run OpenChamber on web or desktop (VS Code and mobile do not load extensions).
2. Settings → Extensions → Add.
3. Paste the absolute path of this `extension/` folder.
4. Approve the capabilities the dialog lists: `sessions`, `prompt`, `network`
   (network comes from the declared integration).
5. Click the rail icon to open the panel.

A folder install runs from this folder directly, so edit, rebuild, reload.

## Configure

Settings → Integrations → GitHub (token): paste the PAT. Then fill the
extension's settings fields (see the repository root `.env.example` for the
values and their meaning):

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

Offline coverage: manifest validation against the official SDK parser, the
matching rule, redaction, the ledger format and gap analysis, evidence
normalization, GitHub payload parsing, configuration validation (including
project-id precedence), the project picker's state and storage handling,
host verification against a fake host, and the shipped bundle's IIFE/secret
assertions. Anything that needs a live OpenChamber instance or a real PAT was
executed by the operator on their own instance and is recorded in
`specs/001-agent-event-orchestrator/spike-evidence.md` §4 (S1–S7 PASS).
