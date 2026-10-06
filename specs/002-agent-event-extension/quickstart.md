# Quickstart: Mecha Turk production extension + local service

**Feature**: `specs/002-agent-event-extension` · **Date**: 2026-09-27
Dev, build, test, and verification for the production package (panel + service). The repository root is the installable unit; operator documentation is published at <https://shaunburdick.github.io/mecha-turk/>, and the sections below point at the page that owns each subject.

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

Published documentation, and the canonical source for this section:
<https://shaunburdick.github.io/mecha-turk/install/> — adding the extension from
a git URL or a local path, what the approval dialog asks for and what each
capability means, pinning a version, the update behaviour, and the surfaces that
do not run extension services.

## 4. First run

Published documentation, and the canonical source for this section:
<https://shaunburdick.github.io/mecha-turk/configure/> — registering projects,
the accounts disclaimer, adding an account with its optional expected GitHub
login, binding a repository, and reading the panel's health.
<https://shaunburdick.github.io/mecha-turk/use/> — the first dispatch, the
state table, and reading a dispatch's audit history.

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

Published documentation, and the canonical source for this section:
<https://shaunburdick.github.io/mecha-turk/debug/> — the data directory, what
each file in it holds, its directory and file permissions, which of it survives
an uninstall, and what a hand-edited file that fails validation does.
<https://shaunburdick.github.io/mecha-turk/configure/> — the Settings tab as
the single configuration input for the whole service configuration, and the
layered starting prompt.

## 7. Cleanup (manual only)

The extension never deletes sessions, worktrees, or projects. Route cleanup to OpenChamber's own surfaces (session list, worktrees view, project management). Disabling a repository binding stops its polling; removing the extension stops the service (SIGTERM) and clears its grant.

## 8. Troubleshooting

Published documentation, and the canonical source for this section:
<https://shaunburdick.github.io/mecha-turk/debug/> — every symptom token the
panel and the service render, what each one means, and what to do about it.
