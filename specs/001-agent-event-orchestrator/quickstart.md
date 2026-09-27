# Quickstart: OpenChamber Extension Spike

This is the first implementation gate. Do not build or run a standalone Mecha Turk daemon until the spike is accepted or its failure path is approved.

## Prerequisites

- OpenChamber web or desktop, with its managed OpenCode server available. The extension docs state VS Code and mobile do not currently load extensions.
- Bun, Node package tooling, and a local extension folder.
- A GitHub PAT for one test repository. The token is entered through OpenChamber’s extension integration card; do not place it in source, YAML, browser storage, or the spike ledger.
- One registered OpenChamber project pointing at a test checkout. The spike must use host project APIs rather than creating a local worktree.

## Build and install the local extension harness

Follow the official [Build an extension](https://docs.openchamber.dev/sdk/) and [Example](https://docs.openchamber.dev/sdk/example/) instructions:

1. Create a folder containing `package.json`, `panel/index.html`, and `panel/main.ts`.
2. Declare `openchamber.apiVersion: 1`, a panel, the GitHub token integration, and only the `sessions` capability. Do not declare a local service for this gate.
3. Install the pinned `@openchamber/sdk` version used by the tested OpenChamber release. Record both versions in the spike report.
4. Bundle the panel as the required classic IIFE:

   ```sh
   bunx openchamber-guest-bundle panel/main.ts panel/main.js
   ```

5. In OpenChamber, open **Settings → Extensions**, paste the absolute folder path, approve the displayed capabilities, and open the panel. OpenChamber runs a folder install directly, so rebuild then reload for changes.

## Spike flow

1. Wait for `connectHost()`/`onReady`; verify the connection state without exposing the token.
2. Call `host.request()` for `/user`, the configured repository’s issue list, and one issue detail using host-attached credentials. Detect exactly one configured matching issue.
3. Persist only the redacted evidence record from `contracts/openchamber.md` in `host.storage`.
4. Resolve the configured project through `host.listProjects()` and call `host.startSession()` with `projectId`, issue attachment, and the selected worktree option.
5. Record the result, then verify `host.listWorktrees(projectId)`, `host.listSessions(projectId)`, `host.onSessionLifecycle()`, and project/worktree/session subscriptions. Inspect partial bootstrap failure fields before any retry.
6. Close the panel and continue observing through the host session, extension storage, or a reopened panel. Repeat after pausing/removing the extension and after switching the OpenChamber server. Do not infer background polling from a stale UI.

## Exact spike acceptance criteria

- **S1:** Local folder installation succeeds using documented manifest/API version rules and only the declared capabilities are approved.
- **S2:** GitHub authentication succeeds through `host.request()` with host-managed token attachment; the PAT is absent from panel state, storage, logs, and evidence.
- **S3:** One configured repository poll detects one matching issue and writes one redacted, correlation-linked evidence record.
- **S4:** `host.startSession()` receives the project ID and issue attachment, and its complete result is recorded, including sent/linked/session/directory/worktree or partial-failure fields.
- **S5:** Host APIs confirm the expected project, worktree behavior, session, and lifecycle transitions; no local worktree/session operation is performed.
- **S6:** Panel-close, pause/removal, and server-switch tests produce a reproducible verdict on whether polling continues, stops, or is unloaded, with timestamps and evidence.
- **S7:** If polling stops or cannot be proven after panel close, the spike is a valid technical failure but unattended extension operation is rejected. The next milestone must explicitly choose a documented host local service or a newly planned standalone daemon boundary.

## Explicit non-goals

No production checkpoint schema, multi-repository polling, webhook, Docker daemon, local service, private OpenChamber route, direct worktree management, or external bridge is implemented by this spike.
