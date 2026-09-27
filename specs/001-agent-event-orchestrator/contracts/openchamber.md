# OpenChamber Integration Contract: Extension-First Gate

The approved first integration is the documented extension SDK, not an external daemon bridge. A standalone external OpenChamber API/CLI bridge is deferred until the extension lifecycle gate fails and a separate documented contract exists.

## Manifest requirements

The spike package declares `openchamber.apiVersion: 1`, a semver package version, an optional tested engine floor, a panel entry, and an integration:

```json
{"openchamber":{"apiVersion":1,"engines":{"openchamber":">=1.24.0"},"contributes":{"panel":{"id":"mecha-turk-spike","name":"Mecha Turk Spike","icon":"github","entry":"panel/index.html"},"capabilities":["sessions"],"integration":{"name":"GitHub (token)","description":"Read one repository for the spike","token":{"apiOrigin":"https://api.github.com","account":{"path":"/user","name":"login"},"scheme":"bearer"}}}}
```

The exact requested capability set must be minimal. `network` is implied by the integration; `sessions` is required for project/worktree/session operations. No `service`, `files`, or `filesystem` capability is allowed in the first spike.

## Event and evidence contract

The panel normalizes one matching issue into a redacted evidence record:

```json
{"schemaVersion":"extension-spike-1","repository":"owner/name","issueId":"123","issueUrl":"https://github.com/owner/name/issues/1","trigger":"configured-match","authenticatedLogin":"discovered-login","correlationId":"uuid","detectedAt":"RFC3339","panelGeneration":1}
```

The record may be stored in `host.storage` for spike evidence. It must not contain the token, Authorization header, or unrestricted raw issue payload.

### Wave 0 amendments (2026-09-26)

Applied while implementing T001–T009; field semantics are unchanged.

1. **Evidence field names are camelCase.** The first revision used `schema_version`, `issue_id`, `issue_url`, `authenticated_login`, `correlation_id`, `detected_at`, and `panel_generation`. The repository lints with `eslint-config-shaunburdick`, whose `@typescript-eslint/naming-convention` rule requires camelCase property names, and the approved resolution for that conflict was to align this contract rather than weaken the lint rule. The JSON above is now authoritative.
2. **`prompt` is part of the spike capability set.** The manifest example in the "Manifest requirements" section declares `capabilities: ["sessions"]` while this contract's session signature passes `text`. The documented host gate rejects `startSession` with `text` unless `prompt` is granted (Host API capability table; `PluginPane.tsx` checks `request.text && !guestMay(..., 'prompt')`). The installed manifest therefore declares `["sessions", "prompt"]` — the minimal set that can actually exercise this contract. No `service`, `files`, or `filesystem` capability is declared.
3. **Integration settings ids are kebab-case**: `repository`, `expected-login`, `project-id`, `worktree-option`, `poll-interval-ms`. The first revision used camelCase ids. Running the official `parseManifestJson` from `@openchamber/sdk` showed the SDK validates setting ids against its `PANEL_ID` pattern (`^[a-z][a-z0-9-]*$`), so camelCase ids make the manifest un-installable (`invalid-integration`). The ids are data strings, not object property names, so this does not conflict with the repository's camelCase lint rule: the panel reads them through `readSetting(settings, '<kebab-id>')`.

## Session verification contract

Call only documented host APIs:

```text
host.startSession({ projectId, id, title, url, kind: "issue", text, data, worktree })
host.listProjects()
host.listWorktrees(projectId)
host.listSessions(projectId)
host.onSessionLifecycle(listener)
host.onProjects(listener)
host.onWorktrees(projectId, listener)
host.onSessions(projectId, listener)
```

Record `sessionId`, `directory`, `sent`, `linked`, optional worktree, partial bootstrap failures, lifecycle phases, and final host snapshots. OpenChamber remains the sole owner of project/worktree/session creation and lifecycle.

## Lifecycle test contract

The test must observe while mounted, after panel close, after pause/removal, and after server switch. Each interval must distinguish “poll executed,” “extension unloaded,” “subscription cleared,” and “session state changed.” A stop after panel close is a valid result and triggers the next-path decision; it is not silently retried through an undocumented mechanism.
