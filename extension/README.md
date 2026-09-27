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
- `project-id` — registered OpenChamber project
- `worktree-option` — `none`, `generated`, or `new:<branch>`
- `poll-interval-ms` — clamped to 15000–300000

Setting ids must match the SDK's `^[a-z][a-z0-9-]*$` pattern; the manifest
enforces it.

## Tests

```sh
npm test
```

Offline coverage: manifest validation against the official SDK parser, the
matching rule, redaction, the ledger format and gap analysis, evidence
normalization, GitHub payload parsing, configuration validation, host
verification against a fake host, and the shipped bundle's IIFE/secret
assertions. Anything that needs a live OpenChamber instance or a real PAT is
recorded as pending in `specs/001-agent-event-orchestrator/spike-evidence.md`.
