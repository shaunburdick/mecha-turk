# Research: OpenChamber Extension-First Spike

Research checked 2026-09-26 against official OpenChamber documentation and repository links.

## Sources and version assumptions

- [Build an extension](https://docs.openchamber.dev/sdk/) documents the three-file folder, manifest `apiVersion: 1`, semver version, optional `engines.openchamber`, local-folder installation from Settings → Extensions, sandboxed panel, declared capabilities, integrations, and bundled IIFE requirement. It recommends `@openchamber/sdk` and `bunx openchamber-guest-bundle`.
- [Host API](https://docs.openchamber.dev/sdk/host/) documents `connectHost`, `onReady`, `onConnection`, `request`, `startSession`, storage, project/worktree/session methods, lifecycle subscriptions, `dispose`, limits, and errors.
- [SDK example](https://docs.openchamber.dev/sdk/example/) is an official GitHub-token extension using `apiOrigin: https://api.github.com`, `/user`, bearer scheme, and `host.request`; it confirms that host-managed tokens are not exposed to the page.
- [GitHub Issues & PRs](https://docs.openchamber.dev/github/) documents OpenChamber’s own GitHub connection, issue/PR context, and session startup.
- [OpenCode Server](https://docs.openchamber.dev/opencode-server/) documents that OpenChamber starts/manages an OpenCode server by default or connects through `OPENCODE_HOST`; it does not document a standalone external work-request API.
- [Agent Control Tool](https://docs.openchamber.dev/agent-control-tool/) documents an in-app tool available with OpenChamber’s managed local server, not an external extension/daemon transport.
- Source links are the public repository edit paths embedded by the docs, e.g. [`packages/docs/content/docs/sdk.mdx`](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk.mdx) and [`packages/sdk/examples`](https://github.com/openchamber/openchamber/tree/main/packages/sdk/examples). The docs’ current example uses `@openchamber/sdk` `^1.24.0`; the spike must pin the installed SDK and record the OpenChamber build/version under test.

## Credential flow

The extension declares a GitHub `integration` with a token `apiOrigin`, account path `/user`, and bearer scheme. The user enters/connects the token in OpenChamber Settings; OpenChamber attaches it to `host.request()` and does not return it in `onReady`, request results, or page context. The panel can read the authenticated login from the account/`/user` response but must never persist or display the PAT. This is compatible with the approved dynamic machine identity rule, but the spike should use the configured machine-account PAT and verify optional login only as an assertion.

The OpenChamber-managed GitHub account is a separate documented integration used by built-in GitHub workflows. The spike must not assume that it shares credentials with the extension’s declared GitHub integration; it must explicitly exercise the declared integration and record whether the host account is independent.

## Host lifecycle findings

`connectHost()` outside OpenChamber rejects with `HOST_UNAVAILABLE`. `onReady` can replay refreshed snapshots. `onProjects`, `onWorktrees`, `onSessions`, and `onSessionLifecycle` replay current state and return unsubscribe functions; the host allows at most 32 subscriptions per frame and clears subscriptions on unmount, pause, removal, or server switch. `dispose()` releases subscriptions and causes in-flight calls to reject. `startSession()` waits up to 180 seconds, accepts `projectId`, issue/PR attachment fields, and worktree options, and can return partial bootstrap failure with a worktree left behind. The spike must capture every result, including null session IDs and partial worktrees.

These findings make panel-close unattended polling uncertain by design. The SDK documents panel lifecycle and persistent extension storage, but does not promise a panel remains running after it closes. That is the key experimental question.

**Live answer (2026-09-27):** polling *did* continue while the panel was closed — the ledger held `poll` entries timestamped inside the closed window — and it stopped cleanly while the extension was disabled. Recorded in `spike-evidence.md` §4.5 (L2, L3) and §4.6.

## Local service limitations

The extension docs describe an optional local service for operations a page cannot reach. It requires a declared service and user-approved `service` capability, has `stopped|starting|ready|failed` status, and is called through `host.serviceRequest()`. It runs with full local access and no sandbox, but does not automatically receive host secrets or host API access. Consequently, a service cannot be selected as a silent PAT relay; it would need an explicit secret provisioning design and still requires lifecycle testing. It is a follow-on path only.

## Decision and remaining uncertainty

The documented extension path is sufficient to test GitHub authentication, one-repository polling, issue attachment, `startSession`, and host-owned worktrees/sessions without private APIs. It is not yet proven to provide unattended polling after panel close. The exact next architecture is therefore intentionally gated on AC-016/017. An external daemon bridge remains deferred because no official external work-request contract was found.

**Update after the live run (2026-09-27):** the unproven part is now proven —
the extension polled unattended with the panel closed, so AC-016/017 resolve in
favour of the extension path. `spike-evidence.md` §4.6 records S1–S7 PASS and
recommends T010 (extension-first), subject to product-owner approval at the
gate. The daemon fallback (and its deferred transport) stays unselected.
