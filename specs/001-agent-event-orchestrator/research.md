# Research: Agent Event Orchestrator — consolidated platform record

**Feature**: `specs/001-agent-event-orchestrator` (spike record; production work moved to `specs/002-agent-event-extension`)
**Research checked**: 2026-09-26 (documentation and pinned SDK) and 2026-09-27 (live spike run)
**Status**: canonical and still current — sections (a) and (b) below are the platform research the 002 production spec builds on; nothing here expires with 001.

## 0. How to read this file

Three canonical sections, in the order they were learned:

- **(a) GitHub REST platform** — what GitHub's API and our transport through `host.request` will and will not let us do.
- **(b) OpenChamber platform** — what the extension SDK, host, and local-service model expose.
- **(c) Spike learnings** — what the live S1–S7 run proved, pointing at `spike-evidence.md` rather than restating it.

Supporting evidence kept beside this file, not duplicated here:

| Document | What it holds |
| --- | --- |
| `feasibility-report.md` | Full Q1–Q5 provenance report: every claim's stamped source, confidence level, and appendix. Absorbed into (a)/(b) below; retained as evidence. |
| `spike-evidence.md` | Offline gates §1–§2 and the live S1–S7 evidence and verdict §4. |
| `spike-runbook.md`, `quickstart.md` | The operator instructions that were actually executed. |
| `contracts/openchamber.md`, `contracts/daemon-deferred.md` | Spike-gate contracts as recorded; supersession pointers added, findings untouched. |

## 1. Sources and version assumptions

- [Build an extension](https://docs.openchamber.dev/sdk/) documents the three-file folder, manifest `apiVersion: 1`, semver version, optional `engines.openchamber`, local-folder installation from Settings → Extensions, sandboxed panel, declared capabilities, integrations, and bundled IIFE requirement. It recommends `@openchamber/sdk` and `bunx openchamber-guest-bundle`.
- [Host API](https://docs.openchamber.dev/sdk/host/) documents `connectHost`, `onReady`, `onConnection`, `request`, `startSession`, storage, project/worktree/session methods, lifecycle subscriptions, `dispose`, limits, and errors.
- [SDK example](https://docs.openchamber.dev/sdk/example/) is an official GitHub-token extension using `apiOrigin: https://api.github.com`, `/user`, bearer scheme, and `host.request`; it confirms that host-managed tokens are not exposed to the page.
- [GitHub Issues & PRs](https://docs.openchamber.dev/github/) documents OpenChamber's own GitHub connection, issue/PR context, and session startup.
- [OpenCode Server](https://docs.openchamber.dev/opencode-server/) documents that OpenChamber starts/manages an OpenCode server by default or connects through `OPENCODE_HOST`; it does not document a standalone external work-request API.
- [Agent Control Tool](https://docs.openchamber.dev/agent-control-tool/) documents an in-app tool available with OpenChamber's managed local server, not an external extension/daemon transport.
- Source links are the public repository edit paths embedded by the docs, e.g. [`packages/docs/content/docs/sdk.mdx`](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk.mdx) and [`packages/sdk/examples`](https://github.com/openchamber/openchamber/tree/main/packages/sdk/examples).
- **Version stamps**: `@openchamber/sdk` pinned exactly `1.24.2` (the version the docs example's `^1.24.0` line resolves to at the time of the spike), plus current `openchamber/openchamber` `main` where the pin and `main` were compared. GitHub docs carry retrieval date **2026-09-26** (those pages expose no "last updated" stamp). The operator's installed OpenChamber build version was never recorded — see `spike-evidence.md` §1 — so every host-behaviour claim is stamped to the pin or to `main`, never to the running build.
- The pin is **behind** current docs in places: `1.24.2`'s `HostClient` has no `openCommit`, no `setHeight`, and no `contributes.statusSection`. Do not assume a docs feature exists at our pin without checking `dist/*.d.ts`.
- `feasibility-report.md` §0 records the same source table plus its own confidence legend and gaps; it remains the primary provenance record for the claims below.

---

## (a) GitHub REST platform

### a.1 Discovery endpoints — repository-scoped polling

Poll issue comments, repository issue/assignment data, PR requested-reviewer/assignment data, and detail endpoints, each with its own cursor, timestamp overlap, and stable ID. Exact endpoint selection and API-version compatibility stay isolated in the adapter and are verified during planning/testing (FR-017).

- Sort list responses stably (`sort=updated` reordering defeats caching); paginate to the end or hold the prior safe checkpoint.
- Use authenticated requests; request only the fields needed; issue requests serially rather than in parallel bursts.
- Do not poll through the Search API — it has a separate, stricter bucket.

GitHub documents that webhooks are preferred, but it also documents efficient polling when webhooks cannot be used (fixed schedules, `X-Poll-Interval`, authenticated conditional requests, avoiding concurrency). The product-owner firewall constraint makes polling the MVP choice.

### a.2 Fine-grained PAT permissions

Expected minimum repository permissions (FR-015), validated against the exact endpoint matrix before activation:

| Permission | Needed for |
| --- | --- |
| `Metadata: read` | repository identity/metadata on every endpoint |
| `Issues: read` | issue, comment, and assignment discovery |
| `Pull requests: read` | PR and requested-reviewer/assignment discovery |
| `Contents: read` | only if repository metadata is passed to OpenChamber |
| `Issues: write`, `Pull requests: write` | **not** required by the thin orchestrator unless a supported OpenChamber operation explicitly needs them |

- Missing permissions must be **reported and block the stream**, never silently downgraded (FR-013, FR-015).
- Organization approval policies can still deny a fine-grained PAT; that is a configuration-time failure, not a runtime fallback case.
- Two documented fine-grained PAT constraints worth remembering: a limit of 50 fine-grained PATs per user, and capability gaps (no Checks API, no multi-organization access at once, limited write access to repos you only collaborate on). Classic PATs remain required for a handful of REST endpoints.
- The credential is entered through OpenChamber's integration card, never into source, YAML, browser storage, or the ledger; rotation/revocation is revoke-on-GitHub plus re-connect (FR-032).

Docs: [Authorizing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) — retrieved 2026-09-26.

### a.3 Rate limits — 5,000 requests/hour for both PAT types

From [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) (retrieved **2026-09-26**):

| Authentication | Primary limit |
| --- | --- |
| Unauthenticated | 60 requests/hour, keyed to the originating IP |
| **Personal access token — classic *or* fine-grained** (also OAuth app / GitHub App user tokens) | **5,000 requests/hour**, "your personal rate limit" |
| GitHub App installation token | 5,000/h + per-repo/per-user increments, capped 12,500/h (15,000/h Enterprise Cloud) |
| `GITHUB_TOKEN` in Actions | 1,000/h per repository |

- **The docs state no fine-grained-vs-classic difference.** The authenticated section covers "a personal access token" generically; there is no separate rate-limit page for fine-grained PATs (that URL 404s). 5,000/h applies to both types, and no plan-based (Free vs Pro) distinction is documented for REST `core`.
- Two tokens minted by the **same** GitHub user share one 5,000/h pool; different GitHub accounts each get their own pool. This matters for the multi-account service path: N accounts buy N pools.
- Secondary limits still apply — ≤900 points/min per endpoint (most GETs = 1 point), ≤100 concurrent requests across REST+GraphQL, ≤90s CPU per 60s, content generation ≤80/min. Exceeding either limit yields 403/429; primary carries `x-ratelimit-remaining`/`x-ratelimit-reset`, secondary may carry `retry-after`. `GET /rate_limit` is free against the primary limit.
- Budget arithmetic for the design: 10 repos × 1 endpoint × 60 polls/h ≈ 600 req/h ≈ 12% of 5,000/h per account; two endpoints per repo ≈ 24%. Comfortable at ~10 repos, tight around ~40–70 endpoints/account at a 60s interval. Knobs we own: `poll-interval-ms` (manifest allows 15,000–300,000), `per_page`, endpoint count.

### a.4 `host.request` strips headers → **no conditional ETag/304 requests on the panel path**

GitHub documents that an authenticated conditional request returning **304 does not count against the primary rate limit** — the single most valuable polling optimization available ([Best practices for using the REST API](https://docs.github.com/en/rest/guides/best-practices-for-using-the-rest-api), retrieved 2026-09-26).

**We cannot use it through the panel.** `GuestRequest = { method, path, query?, body? }` and `GuestRequestResult = { status, body }` — no request headers in, no response headers out — and the host proxy hardcodes its own `Accept`/`Authorization`/`Content-Type`. The `etag` is read into a `Response` and discarded.

- **Panel path (`host.request`)**: conditional requests are impossible. Every poll burns a full primary-rate request, and `x-ratelimit-*` cannot be read, so rate telemetry must fall back to HTTP status (403/429) and elapsed time.
- **Service path (guest local service)**: the service owns its own `fetch` and its own header set, so it **can** send `If-None-Match`/`If-Modified-Since`, read `ETag`/`Last-Modified`, and read `x-ratelimit-*` for precise pacing. This is one of the concrete reasons the approved multi-account service path also improves rate behavior.

FR-009's "use conditional requests where supported" therefore resolves to: **supported on the service transport, not supported on the panel transport** — the adapter must feature-detect, not assume.

### a.5 Response truncation → the `per_page ≤ 30` trap

The guest request/response path caps bodies at **256,000 characters** (`GUEST_REQUEST_RESPONSE_MAX`, `readCappedBody` slices without signalling truncation). GitHub list payloads are large: `/user/repos?per_page=100` and `/repos/{o}/{r}/issues?per_page=100` can each exceed 256 KB → truncated JSON → a parse failure that looks like a GitHub error.

- **Keep `per_page ≤ 30` and paginate.** The official `github-token` example deliberately uses `per_page: "30"`.
- The panel-leg limits also include `GUEST_REQUEST_TIMEOUT_MS = 20,000` and `GUEST_REQUEST_BODY_MAX = 64,000`; a `serviceRequest` path must start with `/` and carry no scheme.
- Note the contrast: `contracts/config.md` (deferred daemon path) records `page_size: 100`, which is safe only for a transport that reads GitHub directly. On any leg that crosses the guest request cap, 30 is the ceiling.

### a.6 Notifications API is rejected — classic-PAT-only

Current GitHub REST Notifications documentation states notification endpoints support **classic PAT authentication only** and do not work with fine-grained PATs or GitHub App tokens. Notifications also model user notification threads, not a complete repository event log.

- Notifications are therefore **explicitly rejected** as the discovery source (FR-016, AC-007). Repository-scoped polling is required instead.
- There must be no silent fallback to an unbounded user notification scan if an endpoint returns unsupported authentication.

Docs: [Notifications API](https://docs.github.com/en/rest/activity/notifications) — retrieved 2026-09-26.

---

## (b) OpenChamber platform

### b.1 Credential flow — host-managed token, never in the iframe

The extension declares a GitHub `integration` with a token `apiOrigin`, account path `/user`, and bearer scheme. The operator enters the token in OpenChamber Settings; OpenChamber attaches it to `host.request()` and never returns it in `onReady`, request results, or page context. The panel reads the authenticated login from the `/user` response but must never persist or display the PAT.

The OpenChamber-managed GitHub account used by built-in GitHub workflows is a **separate** integration and must not be assumed to share credentials with the extension's declared integration; the spike exercised the declared integration and confirmed host-managed attachment (`spike-evidence.md` §4.2).

### b.2 Agent/model/variant are **not** parameterizable on `startSession`

- `StartSessionRequest = AttachIssueRequest & { projectId?, worktree?, navigation? }` and `PromptRequest = { text, send? }` carry **no** `agent`, `model`, or `variant` field — identical in pinned `1.24.2` (`contract.d.ts`) and current `main` (`contract.ts`). `clampStartSessionRequest` and the zod wire schema strip unknown keys, so an extra field never reaches the host.
- Docs say so in words: **"The guest does not pick a model or agent."** (`DOCUMENTATION.md`) and "…using the model and agent the user has selected. The extension never picks them." (`docs.openchamber.dev/sdk/host/`)
- The host **captures whatever selection is in effect when the call starts**, resolving through settings → current selection.
- **The documented lever is `Settings → Sessions → Session Defaults → Default Agent`.** In the guest-send path the settings value is checked **first**, so setting Default Agent = `project-manager` pins *every* extension-started session to that agent, globally (with the side effect that new user sessions also default to it until changed). Left empty, the extension inherits the user's current agent, which the config store seeds from the per-project default — workable but fragile, because a user re-selecting an agent in the chat overrides it.
- The agent-control tool *can* accept `agent`/`model`/`variant`, but it is unreachable from a guest: it lives on loopback behind an ephemeral token minted only into the managed OpenCode server's env, and `apiOrigin` must be `https:`. Not a rescue path.
- **Verification pattern**: `SessionSnapshot` exposes `model?`/`agent?` on `ready.session` and via `onSession`, but only for the session the surface is attached to; `GuestSessionRecord` from `listSessions` has **no** `agent` field. Post-dispatch verification therefore requires `host.openSession(sessionId)` → read `onSession().agent` → warn (toast + ledger entry) if it is not the expected agent. Whether that audit step is worth the UI context switch is a product-owner decision for 002.
- Design consequence: **do not build a per-dispatch "run as agent X" selector.** The API silently ignores it with no `NOT_SUPPORTED` signal to catch.

### b.3 Exactly one `integration` per manifest — no multi-account without a service

- The manifest schema is singular: `integration?: IntegrationContribution` (not an array) in pinned `dist/manifest.d.ts` **and** current `main` (`packages/sdk/src/manifest.ts`); the parser has one `integrationSchema.optional()` branch and no `invalid-integrations` array case. An `integrations: []` key is an unknown key and is dropped.
- Auth storage is one entry per extension id with a single `accessToken` and `account`; host routes are keyed by a single `:id` with no per-account sub-resource; `GuestConnection = { connected, account }` is one boolean plus one label.
- `host.request` has **no credential selector**: no `headers`, no `accountId`, no `origin`. The host proxy resolves exactly one token and builds its own headers; the path must satisfy `url.origin === apiOrigin`, and `apiOrigin` must be `https:`.
- Consequences: "paste N tokens → N logins" cannot be built on `host.request`. **Account → repository binding** (which repos belong to which account) *is* pure panel state and fully supported — only *who performs the GitHub calls* is constrained.
- The only supported N-account design is **`contributes.service`**: the panel stores N tokens in `host.storage` and passes an account selector with each `serviceRequest`; the service makes its own GitHub calls. This is the approved Option B path; it requires the security gate formerly scoped as T012 (now moved to 002).
- Panel-side direct `fetch()` is untested, undocumented, and contrary to the stated sandbox design intent ("Your page runs in a sandbox and cannot call the internet directly"). Not supported; not used.

Full evidence: `feasibility-report.md` Q2 (high confidence across pinned SDK, current `main`, host proxy, storage schema, and docs).

### b.4 Projects — `listProjects()` only; creation is UI-only

- **No project creation API exists for extensions.** No `createProject`/`registerProject`/`addProject` anywhere in the pinned `HostClient` or current `main`; `startSession` takes a `projectId`, not a directory, and an unregistered id surfaces as `HostRequestError('NOT_FOUND')`; a missing/empty directory fails with `no-directory` — there is no "create it for me" branch.
- Project persistence happens in OpenChamber's own UI store, reached only from the **Add project** entry in the command palette, the **+** button at the top of the session sidebar, or the folder browser.
- The agent-control tool explicitly "cannot … register project paths", and the panel cannot navigate the user there (`openSurface` is a closed context-rail list with no settings or projects surface).
- Design consequence: the picker lists registered projects via `host.listProjects()` and offers a "not listed?" affordance explaining the manual step. **"Project not registered yet" is a first-class recoverable state, not an error** — dispatch stays blocked and explains, which is exactly what the spike's `resolveProject()` does.

### b.5 Sessions and worktrees — no deletion API

The extension host surface can list (`listSessions`, `listWorktrees`) and subscribe (`onSessions`, `onWorktrees`, `onSessionLifecycle`) but exposes **no delete/remove method** for sessions or worktrees; official docs likewise state the agent-control tool "cannot delete sessions or worktrees." OpenChamber owns creation *and* teardown; the extension never creates, deletes, or mutates a worktree locally (a stop condition in `tasks.md`). Cleanup UX must therefore route the operator to OpenChamber's own surfaces.

### b.6 `host.storage` semantics

| Property | Value |
| --- | --- |
| Per-value cap | 64 KiB |
| Namespace cap | 2 MiB / 2,000 keys |
| Survives reload / panel close / OpenChamber restart | yes |
| **Survives extension uninstall** | **no — wiped** |
| Namespacing | extension-scoped keys (e.g. `mecha-turk-spike:project`) |

Consequence for durability: storage is good for panel state, selections, and evidence ledgers, but **audit history and checkpoints cannot live only there** — an uninstall silently erases them. Durable production state belongs in storage the operator controls and can back up (this is now an explicit Security and Operational Standard in constitution v1.3.0).

### b.7 Panel lifecycle — polling continues only while OpenChamber runs

- `connectHost()` outside OpenChamber rejects with `HOST_UNAVAILABLE`.
- `onReady` can replay refreshed snapshots; `onProjects`/`onWorktrees`/`onSessions`/`onSessionLifecycle` replay current state and return unsubscribe functions. The host allows at most **32 subscriptions per frame** and clears subscriptions on unmount, pause, removal, or server switch; `dispose()` releases subscriptions and makes in-flight calls reject.
- `startSession()` waits up to 180 seconds and can return partial bootstrap failure with a worktree left behind — capture every result, including null session IDs and partial worktrees.
- **Live answer (2026-09-27, `spike-evidence.md` §4.5/§4.6)**: polling **continued while the panel was closed** (ledger `poll` entries timestamped inside the closed window), **stopped while the extension was disabled**, state was restored after re-enable/reload, and the uninstall wipe (L4b) was observed. L5 (server switch) was not tested — single server — and is non-blocking.
- **The boundary condition**: polling continues only *while OpenChamber itself is running*. The extension dies with OpenChamber, disable stops it, and uninstall wipes its storage. Unattended operation is therefore "unattended while the operator's OpenChamber is up," never "runs without OpenChamber."

### b.8 Integration settings are read-only to the panel → storage-precedence pattern

- `@openchamber/sdk` **1.24.2 has no settings writer**: `host.onSettings()` is a host→guest push only, and `HostClient` declares no `setSettings`/`writeSettings`. The panel can **read** `integration.settings` but cannot write them.
- Settings ids must be kebab-case (`repository`, `expected-login`, `project-id`, `worktree-option`, `poll-interval-ms`) — the SDK validates them against `PANEL_ID = ^[a-z][a-z0-9-]*$`, so camelCase ids make the manifest un-installable (`invalid-integration`).
- **Storage-precedence pattern**: an operator-editable setting is the *declared* configuration; a panel-owned `host.storage` value is the *effective* override. Resolution implemented by `resolveProjectId`/`parseSpikeConfig`: (1) stored panel selection when valid, (2) the integration setting, (3) otherwise **blocked**. Both sources get identical validation (trimmed, non-empty, ≤128 printable ASCII); a malformed stored value is treated as "no selection," never trusted. The panel shows the effective value and its source with a copy affordance (`host.writeClipboard`) so the id can still be recorded back into the setting by hand. Picker failures never touch config, polling, dispatch, or the ledger. Recorded as contract amendment 4 in `contracts/openchamber.md`.

### b.9 Guest local service model (`packages/sdk/GUEST_SERVICES.md`)

From the pinned SDK's `GUEST_SERVICES.md`:

- **Transport**: `panel --serviceRequest--> host --HTTP 127.0.0.1:<ephemeral port>--> service process`. The host spawns the service on first `serviceRequest` using the app runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE`); a system `node` is not required.
- **Inbound auth**: the host passes `OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN`; **every** request to the service, including `/health`, must send `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`. The host polls `GET /health` until 200 (15s) then marks `ready`. Listen on `127.0.0.1` only.
- **Outbound**: the service makes **its own outbound HTTPS** with no `apiOrigin` restriction — that restriction binds the panel→host leg only. "The service talks to Docker, kubectl, or anything else." It can hold N credentials, own ETag caches, read `x-ratelimit-*`, and paginate — solving §a.4 and §a.5 together.
- **Environment isolation**: "The service does not inherit the host environment: only PATH, HOME, temp, locale, and the Windows system variables are copied. API keys, the UI password, and other host secrets never reach it." No host API access either — it must be given what it needs explicitly.
- **Phase-1 API**: request/response only — **streaming panel ← service is explicitly deferred** ("it needs a streaming call on the SDK first"). `GUEST_REQUEST_TIMEOUT_MS = 20,000`, `GUEST_REQUEST_BODY_MAX = 64,000`.
- **Surfaces**: **desktop and web only** — VS Code and mobile do not spawn services.
- **Lifecycle**: install → approve `service` capability → first `serviceRequest` spawns; `serviceStatus()` reports `stopped|starting|ready|failed`; crash = `SERVICE_FAILED` (manual retry, no silent loop); disable stops it but keeps grants/tokens; uninstall SIGTERM→kill; host quit kills every service.
- **Security gate this path must clear**: `permissions.exec`/`permissions.sockets` are **advisory** — "Phase 1 does not enforce an OS sandbox around those lists: an allowed service can run any command, use git, and read or write any file the user can," and the approval dialog says so. Tokens live in panel memory / `host.storage`, transit panel→host→loopback in the request body, and reside in service memory — all covered by the existing redaction rules so they never reach the ledger or a toast.

Not executed in the spike (the spike manifest declares no service capability); this section is documentation research, to be lifecycle-tested in 002.

---

## (c) Spike learnings (S1–S7)

Recorded in **`spike-evidence.md`** (§1 version record, §2/§2.1/§2.2 offline gates, §4.1–§4.5 live steps, §4.6 verdict). Summary pointers only:

- **Verdict**: S1 ✓ S2 ✓ S3 ✓ S4 ✓ (both `none` and `generated` worktree paths) S5 ✓ S6 ✓ (L2 proves unattended monitoring) S7 not triggered — **PASS**, 2026-09-27.
- **Project picker pattern**: no Settings surface prints a project id, so the panel calls `host.listProjects()` on mount and on demand, persists the choice in `host.storage` under `mecha-turk-spike:project`, and resolves with storage-over-setting precedence (§b.8). Selected id + copy affordance; loading/error/empty states; dispatch blocked without a resolved id.
- **Worktree option mapping**: `worktree-option` accepts
  - `none` → session starts in the project directory, no worktree field in the result,
  - `generated` → OpenChamber generates a worktree,
  - `new:<branch-name>` → named new worktree/branch.
  Both `none` and `generated` were exercised live; OpenChamber owns the worktree in all three.
- **Idempotency confirmed live**: re-dispatch of an already-created issue session was refused by the dispatch guard (only entries with a successful, non-empty `sessionId` match), and blocked/failed attempts retry cleanly after the underlying cause clears (T009a).
- **Identity and secret handling confirmed live**: host-managed token attachment showed the authenticated login in the panel while the PAT never appeared in panel state, the ledger, or evidence.
- **Install path**: the absolute path of `extension/` installs; the repository root fails with `package.id should be kebab case`.
- **Not covered**: L5 server switch (single server, non-blocking) and the operator's OpenChamber build version (not recorded).

---

## Decisions and status

1. **Polling over webhooks** — firewall constraint plus GitHub's documented polling guidance (§a.1). Unchanged.
2. **Dynamic machine identity** — the PAT's authenticated `/user` identity is the machine account; an optional login is a validation constraint only, never a hardcoded account (FR-002). Unchanged.
3. **Repository-scoped discovery, no Notifications** — classic-PAT-only limitation (§a.6). Unchanged.
4. **Extension-first validation, then production** — the spike passed (§c), so the architecture is an OpenChamber extension plus, for the multi-account and rate-control requirements, an OpenChamber-hosted local service.
5. **Option B approved** — the product owner approved the **multi-account service path** over the report's Option A single-account MVP recommendation. `feasibility-report.md` keeps its recommendation as recorded; this line records that it was superseded by decision.
6. **001 closes as the spike record; 002 carries production.** `specs/002-agent-event-extension` owns the production spec and any new contracts. Carried over intact: the trigger set, idempotency rules, policy/approval semantics, and audit requirements in `spec.md`. Replaced: the runtime architecture and its deployment-shape requirements (FR-035, NFR-005, AC-012 were written for a standalone container).
7. **Still deferred**: inbound webhooks (future adapter), the standalone daemon (`contracts/daemon-deferred.md`), hosted multi-tenancy, autonomous merge/deploy.

## Open questions carried into 002

- Poll interval and overlap defaults for multi-repo service polling (spec defaults 60s / 10 minutes, deployment-configurable).
- Whether post-dispatch agent verification (`openSession` → `onSession().agent`) is worth its UI context switch, or whether Session Defaults alone suffices (§b.2).
- PAT write permissions: read-only MVP vs enabling `Issues: write`/`Pull requests: write` up front.
- Acceptable detection latency and repository count per account, given the 5,000/h pool arithmetic (§a.3).
- Retention defaults for raw/redacted poll responses and ticket/PR bodies.
- Service security gate: token-handoff design, approval copy, and process lifecycle testing before any multi-account transport ships (§b.9).
- L5 server-switch behavior, if multi-server operation ever matters.
