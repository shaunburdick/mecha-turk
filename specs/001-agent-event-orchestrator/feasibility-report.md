# Feasibility Report — Panel-Centric UX vs. What the Platform Actually Supports

**Spec:** `specs/001-agent-event-orchestrator` (production extension, post S1–S7 spike)
**Date:** 2026-09-26
**Branch:** `001-agent-event-orchestrator`
**Scope:** Research only. No `extension/` or `contracts/` changes. T010–T018 scope not started.
**Questions:** Q1 agent/model selection · Q2 multi-account · Q3 project creation · Q4 GitHub rate limits · Q5 service path.

> **Status note (2026-09-27) — added at 001 close-out.** Findings below are recorded evidence and are **unchanged**. Two things moved on around them: (1) the S1–S7 spike completed and passed on 2026-09-27 (`spike-evidence.md` §4.6), so "post S1–S7 spike" in the scope line is now literally true; (2) the product owner approved **Option B** — the `contributes.service` multi-account path — over this report's Option A recommendation, and production moved to `specs/002-agent-event-extension`. Task references inside the findings (T010–T018) are annotated as superseded/moved-to-002 in `tasks.md`. The findings themselves, including the Option A recommendation, stand as written. Consolidated summaries live in `research.md`.

---

## 0. Method, sources, and version stamps

Findings are stamped so a later reader can tell what was proven against what.

| # | Source | Stamp | How fetched |
|---|---|---|---|
| S1 | Installed `@openchamber/sdk` — `node_modules/@openchamber/sdk` (`dist/*.d.ts`, `dist/parse.js`, `API.md`, `DOCUMENTATION.md`, `GUEST_SERVICES.md`) | **`1.24.2` exactly** (`package.json`) — the version we pinned | local, read directly |
| S2 | Official docs `docs.openchamber.dev` — `/extensions/`, `/sdk/`, `/sdk/host/`, `/agent-control-tool/`, `/projects/`, `/integrations/` | live site, retrieved **2026-09-26**; pages edit-tracked to `packages/docs/content/docs/*.mdx` on `main` | `webfetch` |
| S3 | `github.com/openchamber/openchamber`, branch **`main`** (repo metadata: `default_branch: main`, `pushed_at: 2026-09-26T22:31:44Z`) — SDK sources, host bridge, session-creation code, manifest parser, guest auth store, agent-control service, settings store | **current `main`, may be ahead of both SDK `1.24.2` and the product owner's installed build** | raw file fetch + `gh search code` |
| S4 | GitHub REST docs — rate limits, best practices, PAT management | live, retrieved **2026-09-26**; the fetched rate-limit page's own examples use `X-GitHub-Api-Version: 2026-03-10` | `webfetch`/search |

**Confidence legend:** **high** = read directly in the pinned SDK or a named file, or stated verbatim in official docs. **med** = inferred from current-`main` code where our installed host build was not observed, or an ordering I traced but did not run. **low** = single indirect source, or explicitly untested.

### Source gaps (stated, not guessed)

- **The product owner's installed OpenChamber build version was never recorded** (see `spike-evidence.md` §1 — "the host version string was not recorded by the operator"). Every host-behaviour statement below therefore comes from **current `main` (S3)** or **docs (S2)**, not from the running instance. Where the two agree with the pinned SDK I say so.
- **GitHub docs expose no "last updated" date in the fetched pages**, so all GitHub citations carry a retrieval date (2026-09-26) rather than a publication date.
- `gh search code` hit the unauthenticated GitHub search-API rate limit part-way through; remaining lookups were done with unlimited `raw.githubusercontent.com` fetches. Two planned keyword sweeps (`'/api/projects'` in `.ts`, `addProject`) were **not completed** before the limit — the answer they were probing for was established from primary files instead (§Q3).
- The pinned SDK is **behind** current docs: `1.24.2`'s `HostClient` has **no** `openCommit`, **no** `setHeight`, no `contributes.statusSection`, and `GUEST_SERVICES.md` in the pin only allows `engines.openchamber` values `1.22.0` / `>=1.22.0` (docs now show `1.24.0` / `>=1.24.0`). Do not assume a docs feature exists at our pin without checking `dist/host.d.ts`.

---

## Q1 — CRITICAL: Can `host.startSession()` / `prompt()` pick the model, agent, or variant?

### FINDING

**Not supported as a request parameter. Partially controllable through OpenChamber's own defaults.**

The extension cannot name an agent, model, or variant in either call. The host captures whatever selection is in effect *when the call starts*, resolving it through OpenChamber's settings/current-selection chain. There **is** a documented lever — OpenChamber's **Session Defaults → Default Agent** — which, because it outranks the user's live selection in the guest-send path, effectively pins every extension-started session to one agent. It is a global setting, not a per-call one.

### EVIDENCE

**1. The request types carry no agent/model/variant — pinned SDK `1.24.2` (high).**

`node_modules/@openchamber/sdk/dist/contract.d.ts:281`:

```ts
export type StartSessionRequest = AttachIssueRequest & {
    projectId?: string;
    worktree?: GuestSessionWorktree;
    navigation?: 'preserve' | 'open';
};
export type PromptRequest = { text: string; send?: boolean };
```

`clampStartSessionRequest` (`contract.d.ts:346`) preserves only `projectId` / `navigation` / `worktree` on top of the attach fields — an extra field would be dropped before it reached the host.

**The wire schema is equally closed** — `dist/protocol.d.ts` (the `start-session` message, ~line 947) is a zod object of `providerId, id, title, url, text, kind, author, branches, data, worktree, projectId, navigation`, built with `z.core.$strip`: unknown keys are stripped, not forwarded.

**Identical in current `main`** — `packages/sdk/src/contract.ts:342` has the same three optional fields; no `model`, `agent`, or `variant` anywhere on `StartSessionRequest` or `PromptRequest`.

**2. The SDK docs say so in plain words (high).**

- `DOCUMENTATION.md:54` (pinned): *"`prompt` is `{ text, send? }` … `send: true` sends on that session with the same model path as `startSession`. … **The guest does not pick a model or agent.**"*
- `API.md:178` (pinned): *"**First-message model/agent/variant selection is captured when the call starts.**"*
- `docs.openchamber.dev/sdk/host/` (S2): *"With `send: true` it sends the message **using the model and agent the user has selected. The extension never picks them.**"* and *"The first-message model, agent, and variant are captured when creation starts."*

**3. What "captured when creation starts" actually resolves to — traced in current `main` (med-high).**

`packages/ui/src/lib/guests/start-session.ts`, `captureGuestSendSelection()`:

```ts
const resolveDefaultAgentName = (): string | undefined => {
  const configState = useConfigStore.getState();
  if (configState.settingsDefaultAgent) return configState.settingsDefaultAgent;   // ← settings WIN
  const visibleAgents = configState.agents.filter((agent) => !agent.hidden);
  return (configState.currentAgentName
    || visibleAgents.find((a) => a.mode === 'primary' || !a.mode)?.name
    || visibleAgents[0]?.name);
};

const captureGuestSendSelection = () => {
  const defaultModel = resolveDefaultModelSelection();          // settings.defaultModel, if it resolves
  const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
  const modelID    = defaultModel?.modelID    || configState.currentModelId    || lastUsedProvider?.modelID;
  const agentName  = resolveDefaultAgentName() || configState.currentAgentName || undefined;
  return { providerID, modelID, agentName, variant: resolveDefaultVariant(providerID, modelID) };
};
```

Ordering, as observed:

| Selection | Resolution order for extension-started sessions |
|---|---|
| **agent** | `settings.defaultAgent` → **user's current agent** → first non-hidden primary agent → first visible agent |
| **model** | `settings.defaultModel` (only if it resolves to a real model) → user's current model → last-used provider |
| **variant** | `settings.defaultVariant` → current variant (only when it matches the chosen model) → none |

The captured selection is passed to session creation (`start-session.ts:410`, `sessionActions.createSession(title, directory, …, { model: {providerID,id,variant}, agent }, navigation)`) and, for `prompt({send:true})`, to `sendGuestFirstMessage` (`start-session.ts:336`), which uses the same `captureGuestSendSelection()` default.

**4. The documented lever: OpenChamber's own defaults (high for existence, med for exact UI wording).**

- **Settings → Sessions → "Session Defaults" → "Default Agent"** — i18n: `'settings.openchamber.defaults.title': 'Session Defaults'`, `'settings.openchamber.defaults.summaryPrefix': 'New sessions will start with:'`, `'settings.openchamber.defaults.field.defaultAgent': 'Default Agent'` (`packages/ui/src/lib/i18n/messages/en.settings.ts:1790-1796`); settings-search entry `id: 'sessions.default-agent'`, `page: 'sessions'` (`packages/ui/src/lib/settings/search.ts:431`).
- **Per-project default agent** — Settings → Projects → project → "Chat defaults" → project agent (`ProjectIdentityFields.tsx`, keys `settings.projects.page.section.chatDefaults` / `field.projectAgent`). Store documentation (`packages/ui/src/stores/DOCUMENTATION.md`): *"Project defaults include `defaultAgent`, `defaultModel`, and `defaultVariant`."*
- Documented precedence, `packages/ui/src/stores/useConfigStore.ts:320-324`:

  ```
  Agent: project.defaultAgent → settings.defaultAgent → opencode default_agent → build → first primary → first
  Model: project.defaultModel → settings.defaultModel → resolved agent's pinned model+variant → opencode config.model → …
  ```

  **Important asymmetry (med):** that project-first order is `resolveDefaultAgentModelSelection` / server-side `resolveDefaultSelection` — but the *guest* path's `resolveDefaultAgentName()` checks `settings.defaultAgent` **first** and only then falls back to `currentAgentName`. So:
  - Set **Session Defaults → Default Agent = `project-manager`** → *every* `startSession`/`prompt({send:true})` from the extension uses `project-manager`, regardless of what the user has selected in the chat. Strongest pin available; global side effect (new user sessions also default to it until the user changes it).
  - Leave Session Defaults empty → the extension inherits the user's **current** agent, which the config store seeds from **project.defaultAgent** on directory change (`applyDefaultModelAgentSelection` called at `useConfigStore.ts:2503`). So a per-project default works *indirectly and fragilely* — the user re-selecting an agent in the chat overrides it.
  - Server-side fallback (`packages/web/server/lib/openchamber-sessions/routes.js:144-160`, project-then-settings) only applies when **no** agent was passed; the guest path essentially always passes one, so it rarely helps us.

**5. Agent-control tool / CLI — the host *does* have per-call agent capability, just not for extensions (high).**

`packages/web/server/lib/openchamber-control/service.js:308-325`:

```js
const payload = {
  ...(asNonEmptyString(input.model)  ? { model:  input.model.trim()  } : {}),
  ...(asNonEmptyString(input.agent)  ? { agent:  input.agent.trim()  } : {}),
  ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
  ...
};
if (action === 'session.create') result = await sessionService.create(payload);
```

So `openchamber` agent-tool action **`session.create` accepts `model`, `agent`, `variant`** (matching the docs' example *"Create a new OpenChamber session … use the `openai/gpt-5.6-sol` model"*), and its prompt dispatch falls back to **project default agent first, then settings default** (`sessions-routes.js:147-160`).

**Why this does not rescue us (high):** the tool is served at `POST http://127.0.0.1:<port>/api/openchamber/agent-tool` (`packages/web/server/lib/agent-tool/runtime.js`) guarded by the ephemeral `OPENCHAMBER_AGENT_TOOL_TOKEN`, minted only into the managed OpenCode server's env. A guest cannot reach it: `host.request` requires `path` to stay on the manifest's `apiOrigin`, and `apiOrigin` **must be `https:`** (`isHttpsOrigin` in `dist/parse.js:18`, pinned) — loopback `http://127.0.0.1` fails parse, and the guest has no way to obtain the tool token. The tool is also unavailable on external `OPENCODE_HOST` servers and in VS Code (docs `/agent-control-tool/`).

**6. Verifying what actually ran (med).** `SessionSnapshot` exposes `model?` and `agent?` (`contract.d.ts:46-52`), delivered on `ready.session` and via `onSession` — but only for the session the surface is attached to. `GuestSessionRecord` from `listSessions` (`workspace.d.ts:9-34`) has **no** `agent` field. So post-hoc verification requires opening the created session (`host.openSession(sessionId)` or `navigation: 'open'`).

### IMPLICATION for our UX

- **Do not design a per-dispatch "run as project-manager" selector.** The API will silently ignore any attempt, and there is no `NOT_SUPPORTED` signal to catch.
- Two workable patterns, both configuration-level:
  1. **Operator configures Session Defaults → Default Agent = `project-manager`** (documented, deterministic, global side effect — must be an explicit, documented setup step).
  2. **Rely on current selection + project default agent**, and treat the dispatched agent as *unverified*.
- If agent correctness is a hard requirement, add a **verification step**: after `startSession`, `openSession(sessionId)` → read `onSession().agent` → warn (toast + ledger entry) if it is not `project-manager`. This costs a UI context switch; the product owner should decide whether the audit trail is worth it.
- OpenChamber **cannot be driven to the right agent from the panel** — `openSurface` is a closed list (`diff, walkthrough, file, context, plan, chat, browser, git, pr, linear, notes, terminal` + `plugin:<id>`, `packages/ui/src/lib/surfaces/modes.ts`); no settings/projects surface, so the panel cannot even navigate the user to the defaults screen.

### CONFIDENCE

**High** that it is not parameterizable (types + wire schema + three independent doc statements, pinned SDK and current `main` agree). **Med** on the exact runtime precedence on the product owner's installed build (traced in current `main` only). **High** that the agent-control tool has the capability and **high** that a guest cannot reach it.

---

## Q2 — CRITICAL: Can one extension manifest declare MULTIPLE integrations?

### FINDING

**Not supported — a manifest declares exactly one `integration`.**

- (a) `host.request` **cannot select** a token — there is no selector on `GuestRequest`, and only one token exists per extension.
- (b) One integration **cannot hold multiple tokens** — storage is one entry per extension id with a single `accessToken`.
- (c) **No documented multi-account pattern exists.** The documented paths to multi-account are: install N extension packages (impractical), or declare a `service` and hold the accounts yourself (§Q5).

### EVIDENCE

**1. Singular in the pinned SDK schema (high).** `dist/manifest.d.ts:238`:

```ts
export type OpenChamberContributes = {
    panel: PanelContribution;
    ...
    integration?: IntegrationContribution;   // ← singular, optional, not an array
    service?: ServiceContribution;
    ...
};
```

`dist/parse.js:191` `integration: integrationSchema.optional()`; failure message at `dist/parse.js:333-334`: *"`contributes.integration` needs a name, description, and oauth, token, or host."* There is no `invalid-integrations` and no array branch. An `integrations: []` key would be an unknown key and **dropped** ("Extra keys still drop, not forward", `GUEST_SERVICES.md:95`).

**2. Singular in current `main` (high).** `packages/sdk/src/manifest.ts:401` `integration?: IntegrationContribution;` and `packages/sdk/src/parse.ts:276` `integration: integrationSchema.optional()`. **No change between `1.24.2` and `main`.**

**3. Host routes are singular (high).** `packages/web/server/lib/guests/routes.js` exposes `PUT /api/guests/:id/token` (one pasted token), `GET /api/guests/:id/oauth/status`, `PUT /api/guests/:id/oauth/client`, `POST /api/guests/:id/request` — all keyed by a single `:id`, no per-account sub-resource.

**4. Auth storage is one token per extension (high).** `packages/web/server/lib/guests/auth-store.js`:

```js
const guestAuthEntrySchema = z.object({
  accessToken: z.string().min(1).optional(),
  account: z.string().max(200).optional(),
  settings: z.record(z.string().regex(SETTING_KEY), z.string().max(2000)).optional(),
  target: z.object({ apiOrigin: ..., authorizeUrl: ..., tokenUrl: ... }).optional(),
  ...
});
const storeSchema = z.object({ guests: z.record(z.string().regex(PANEL_ID), guestAuthEntrySchema) });
```

Keyed by extension id → **one** `accessToken`, **one** `account` per extension. `guest-auth.json` is the whole store (pinned `DOCUMENTATION.md`: *"OAuth and pasted tokens live in `guest-auth.json`"*).

**5. The guest-side view is a single connection (high).** `GuestConnection = { connected: boolean; account: string }` (`contract.d.ts:55`) — one boolean, one account label. `resolveIntegrationApi()` returns one `ResolvedGuestApi`. `toPublicIntegration()` publishes one `apiOrigin`.

**6. `host.request` has no selector (high).**

```ts
export type GuestRequest = { method: GuestRequestMethod; path: string; query?: Record<string,string>; body?: string };
```

No `headers`, no `accountId`, no `origin`. The host proxy (`packages/web/server/lib/guests/request.js`) resolves exactly one token:

```js
const hostToken = await resolveHostAccessToken(guest.integration);
const stored    = hostToken ? null : await takeUsableGuestAuth(guest, persistPath);
let accessToken = hostToken ?? stored?.accessToken;
if (!accessToken) throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
```

and it builds its own headers (`Accept`, `Authorization`, `Content-Type`) — **the guest cannot inject a token per call**, and `apiOrigin` must be `https:` with no username/password (`isHttpsOrigin`, `dist/parse.js`). Path must satisfy `url.origin === apiOrigin` (`joinGuestRequestUrl`) — one origin, full stop.

**7. The official example is single-account (high).** `packages/sdk/examples/github-token/package.json` declares one `integration` (`name: "GitHub (token)"`, `apiOrigin: https://api.github.com`, `account: { path: "/user", name: "login" }`, `scheme: "bearer"`) and its panel renders one badge: `Connected as ${connection.account || 'GitHub user'}`.

**8. Docs wording (high).** `docs.openchamber.dev/extensions/`: *"An extension that talks to a service gets **a card** at Settings → Integrations under Extension accounts … Choose **Connect**; **Disconnect** forgets the stored token."* `/sdk/`: *"Declare **an `integration`** … `apiOrigin` is **the only origin `request` may call**."*

**9. Related but not ours (high).** First-party **Linear** supports multiple workspaces ("Add workspace… One workspace is current at a time") — that is first-party host state, not an extension integration. First-party **GitHub** sign-in is a device-code flow under Settings → Integrations and is **not** reachable by extensions (`IntegrationHostProvider = 'linear'` only; `HOST_LINEAR_API_ORIGIN = "https://api.linear.app"`).

**10. Not found anywhere (high for "not documented"):** no `integrations` array, no account list, no per-call credential selector, no documented multi-account extension pattern in S1, S2, or S3.

**11. Adjacent, cheap, and not sufficient (med):** `integration.settings` fields are arbitrary short strings (`SETTING_KEY`, ≤2000 chars) that arrive in `ctx.settings` — you *could* stash extra tokens there or in `host.storage` (64 KiB/value, 2 MiB namespace). **But `host.request` still sends only the one host-managed `accessToken`**, so those strings can be *read* by the panel and never *used* on the network. They become useful only together with a `service` (§Q5).

### IMPLICATION for our UX

- The product owner's "paste N tokens → N logins" card **cannot be built on `host.request`**. There is no hidden parameter to find; the schema, the wire format, the storage, and the proxy all agree.
- **Account → repo binding** (which repos belong to which account) is pure panel state and is fully supported — the constraint is only *who performs the GitHub calls*.
- Realistic choices for N accounts:
  - **A — one host-managed account (MVP)**: `contributes.integration` token card, token never enters the iframe, best security posture, N = 1.
  - **B — `contributes.service`**: panel stores N tokens (`host.storage`), passes the account selector + token with each `serviceRequest`; the service makes GitHub calls with its own credentials and no origin restriction (§Q5). Requires a new security gate and service lifecycle testing (task T012 is already written for exactly this).
  - **C — N extension variants**, each with its own `panel.id` + `integration` (uniqueness is enforced on `panel.id` only). Technically valid, operationally absurd: N rail icons, N approval dialogs, N storage namespaces, and the same folder cannot be installed twice under one package id. Mentioned for completeness, not recommended.
  - **D — panel-side direct `fetch()`**: **untested and undocumented.** The served guest CSP is only `Content-Security-Policy: sandbox allow-scripts` (`packages/web/server/lib/guests/routes.js:509`) with no `connect-src` restriction, so a sandboxed iframe *may* be technically able to reach `api.github.com` (GitHub sends `Access-Control-Allow-Origin: *`). Official docs state the opposite as design intent: *"Your page runs in a sandbox and cannot call the internet directly."* Treat as **not supported**; it bypasses the capability/approval model entirely and would need explicit product-owner approval plus a spike before anyone relies on it.

### CONFIDENCE

**High** on "one integration, one token, no selector" (pinned SDK + current `main` + host proxy + storage schema + docs, all consistent). **High** on "no documented multi-account pattern". **Low** on option D working — deliberately marked untested.

---

## Q3 — Project creation from an extension (confirm H4)

### FINDING

**H4 CONFIRMED — not supported.** There is no `host.createProject`, `registerProject`, `startSession(directory)`, or any other extension-reachable way to create or register an OpenChamber project. An extension may only *list* and *target already-registered* projects. (Not found anywhere: S1, S2, S3.)

### EVIDENCE

**1. The `HostClient` surface is read-only with respect to projects (high).**

Pinned `dist/host.d.ts:19-22`: `listProjects`, `listWorktrees`, `listSessions` — plus `onProjects`/`onWorktrees`/`onSessions` subscriptions and `openSession`. No create/add/register. The full method list (107 lines) contains nothing project-mutating.

Current `main` `packages/sdk/src/host.ts` adds `openCommit` and `setHeight` since the pin — **still no project creation**. Greps for `createProject|addProject|registerProject|project:create|create-project` across `host.ts`, `manifest.ts`, `parse.ts` return nothing.

**2. `startSession` takes a `projectId`, not a directory — and validates registration (high).**

`StartSessionRequest` has `projectId?: string` only (§Q1). Host-side (`packages/ui/src/lib/guests/workspace.ts:15`):

```ts
export const guestProject = (projectId: string) => {
  const state = useProjectsStore.getState();
  if (!state.hasServerSnapshot) throw new HostRequestError('HOST_UNAVAILABLE', 'The project registry has not loaded.');
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new HostRequestError('NOT_FOUND', 'Project is not registered.');
  return project;
};
```

and in `startGuestSession` (`start-session.ts:364-366`): `directory = args.request.projectId ? project?.path ?? null : args.directory` — with no `projectId`, it falls back to the **currently open** directory only. An unregistered id surfaces to the guest as `HostRequestError('NOT_FOUND')`.

**3. `planStartGuestSession` refuses with `no-directory` (high).** `start-session.ts:52-56`: an empty/absent directory yields `{ ok: false, reason: 'no-directory' }` → toast `contextPanel.plugin.startSession.noProject` → the host answers a generic error. There is no "create it for me" branch.

**4. No server route for guests to create projects (high).** `packages/web/server/lib/guests/routes.js` registers `/api/guests…` routes only; `packages/web/server/lib/projects/routes.js` registers `GET /api/projects/:projectId/config` and the two `PUT` variants — read/config, no create. Project *persistence* happens in the UI store (`useProjectsStore.ts:597 addProject` → `persistProjects`), reached only from OpenChamber's own Add-project UI.

**5. The agent-control tool explicitly cannot do it (high, from official docs).** `/agent-control-tool/`: *"The tool cannot delete sessions or worktrees, **register project paths**, run arbitrary shell commands, or call arbitrary URLs."*

**6. Project creation is a UI-only operation (high).** `/projects/`: *"You can add a project from a few places: the **Add project** entry in the command palette; the **+** button at the top of the session sidebar; the folder browser when you pick a directory. Point it at a folder and OpenChamber remembers it."*

**7. The panel cannot navigate the user there (high).** `openSurface` accepts only `ContextPanelMode` (closed list, §Q1.6); `docs.openchamber.dev/sdk/host/` describes it merely as "switch the app to that screen".

### IMPLICATION for our UX

- **"Create a new OpenChamber project" is out of scope for the extension.** The picker must be: *list registered projects* (`host.listProjects()` → `id`, `name`, `directory`) + an explicit **"not listed?"** affordance that explains the manual step, because we cannot deep-link to it either.
- Operator manual step: **command palette → "Add project"**, or **+ at the top of the session sidebar**, or **folder browser** — then re-open the panel and refresh the picker.
- Design consequence: treat "project missing" as a **first-class, recoverable state**, not an error. Our existing `NOT_FOUND` / `no-directory` handling and the "project unresolved then retry succeeds" path (T009a) already model this correctly — keep it.
- If a repo is cloned but not yet a project, the extension's job ends at *"tell the user to add it"*. Do not attempt filesystem or git workarounds — direct local worktree manipulation is on the stop-condition list in `tasks.md`.

### CONFIDENCE

**High.** Four independent primary sources (pinned SDK types, current-`main` host code, server routes, official docs) agree, and nothing anywhere suggests otherwise.

---

## Q4 — GitHub rate limits

### FINDING

**Supported with large headroom.** Both fine-grained and classic PATs on free personal accounts share the documented **5,000 requests/hour** authenticated primary limit; polling ~10 repos every 60 s costs **~600 requests/hour per account** (~12% of budget). Secondary limits are not a concern at that rate. **The one real constraint is ours, not GitHub's:** `host.request` cannot send `If-None-Match` or receive `ETag`, so **conditional (304) requests are impossible through the extension's network path** — every poll costs a full request.

### EVIDENCE

**(a) Primary limits — S4, retrieved 2026-09-26 (high).**

`https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`:

| Authentication | Primary limit |
|---|---|
| Unauthenticated | **60 requests/hour**, keyed to the originating IP |
| **Personal access token — classic *or* fine-grained** (and OAuth app / GitHub App user token) | **"your personal rate limit of 5,000 requests/hour"** |
| GitHub App installation token | 5,000/h, +50/h per repo beyond 20 repos and +50/h per org user beyond 20 users, capped at 12,500/h; **15,000/h** on Enterprise Cloud |
| OAuth app (client-id/secret, public data) | 5,000/h (15,000/h Enterprise Cloud) |
| `GITHUB_TOKEN` in Actions | 1,000/h per repository (15,000/h Enterprise Cloud) |
| Git LFS | 300/min unauthenticated, 3,000/min authenticated |

- **The docs state no fine-grained-vs-classic difference.** The authenticated section covers "a personal access token" generically and ties it to *the user's personal rate limit*. There is **no** separate rate-limit page for fine-grained PATs — `docs.github.com/en/rest/authentication/rate-limits-for-fine-grained-personal-access-tokens` returns **404** (checked directly). Confidence **high** that 5,000/h applies to both types; **high** that no Free-vs-Pro difference is documented for REST `core` (the page makes no plan-based distinction anywhere).
- **Two PAT limits that are documented and relevant (high):**
  - *"There is a limit of 50 fine-grained personal access tokens you can create"* (`/en/authentication/…/managing-your-personal-access-tokens`).
  - Fine-grained PAT **capability gaps** that matter if we later want writes: cannot contribute to public repos where the user isn't a member, cannot access multiple organizations at once, **cannot call the Checks API**, no Projects access, limited write access to repos you only collaborate on. Classic PATs remain needed for some endpoints (a few REST endpoints are classic-only).
- **Shared budgets (high):** *"All of these requests count towards your personal rate limit of 5,000 requests per hour."* Two tokens minted by the **same** GitHub user share one 5,000/h pool; **different** GitHub accounts each get their own pool. (Direct corroboration, third-party, checked 2026-08-13: WarpBuild's rate-limit guide — "5,000 requests/hour … pooled across every workflow, every repository, and that person's laptop".)

**(b) ETag / 304 behaviour — S4 (high).**

From `/en/rest/guides/best-practices-for-using-the-rest-api` (also reachable as `/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api`):

> *"Most endpoints return an `etag` header, and many endpoints return a `last-modified` header. You can use the values of these headers to make conditional `GET` requests. If the response has not changed, you will receive a `304 Not Modified` response. **Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header.**"*

Also documented there: avoid polling in favour of webhooks; honour `x-poll-interval`; make **authenticated** conditional requests so unchanged data is free; request only what you need and use a **stable sort order** so responses stay cacheable (`sort=updated` reorders items and defeats 304s); make requests serially rather than concurrently; pause ≥1 s between mutative requests.

**⚠️ Our path breaks this (high).** `GuestRequest = { method, path, query?, body? }` and `GuestRequestResult = { status, body }` — **no request headers in, no response headers out**, and the proxy hardcodes its own header set:

```js
const headers = { Accept: 'application/json', Authorization: guestAuthorizationHeader(accessToken, authorization) };
```

(`packages/web/server/lib/guests/request.js:47-53`). The `etag` is read into a `Response` and discarded; only `status` and a body capped at `GUEST_REQUEST_RESPONSE_MAX = 256000` chars are returned. **The extension therefore cannot implement conditional requests.** Only a `service` (§Q5), which owns its own `fetch`, could.

**Secondary limits relevant to polling ~10 repos / 60 s (high, from the same page):**

| Secondary rule | Documented value | Our ~10-repo/60 s poll |
|---|---|---|
| Points per minute, single endpoint (REST) | ≤ **900 points/min**; most GET/HEAD/OPTIONS = 1 point | ~10–30 points/min → **~1–3%** |
| Concurrent requests | ≤ **100** across REST + GraphQL | serial polling → negligible |
| CPU time | ≤ **90 s CPU per 60 s real time** (≤ 60 s of it GraphQL) | ~10 fast GETs/min → negligible |
| Content generation | ≤ **80/min, ≤ 500/h** (POST/PATCH/PUT/DELETE = 5 points) | read-only polling → not applicable; relevant only if we later comment/create issues |
| OAuth token requests | ≤ 2,000/h | not applicable (PATs, not OAuth) |
| Search endpoints | separate, stricter bucket (`resources.search`) | not used — do not use search to poll |
| GraphQL | separate primary limit, ~5,000 **points**/hour | not used |

Exceeding either limit → **403 or 429**; primary carries `x-ratelimit-remaining: 0` + `x-ratelimit-reset`; secondary may carry `retry-after`. *"Continuing to make requests while you are rate limited may result in the banning of your integration."* `GET /rate_limit` is free against the primary limit (but still counts toward secondary).

### Arithmetic for our design (high on inputs, ours to own on the policy)

- Naive: 10 repos × 1 endpoint × 60 polls/h = **600 req/h = 12%** of 5,000/h, per account.
- Two endpoints per repo (issues + pulls): **1,200 req/h = 24%**.
- With no 304s available (§ above), assume **every** poll burns a request. Headroom is still comfortable at 10 repos; it gets tight around ~40–70 endpoints/account at 60 s.
- Practical knobs we control: poll interval (our manifest already allows `poll-interval-ms` 15 000–300 000), `per_page`, endpoint count, and `x-ratelimit-remaining` pacing.
- **Response-size trap (high, ours):** bodies are **truncated at 256 000 chars** (`GUEST_REQUEST_RESPONSE_MAX`, `readCappedBody` slices without signalling). GitHub list payloads are large: `/user/repos?per_page=100` and `/repos/{o}/{r}/issues?per_page=100` can each exceed 256 KB → truncated JSON → parse failure that looks like a GitHub error. The official `github-token` example deliberately uses `per_page: "30"`. **Keep `per_page ≤ 30` and paginate.**

### IMPLICATION for our UX

- Show a **rate-budget indicator** (budget spent / remaining) driven by what we can observe: HTTP status, 403/429 bodies, and elapsed time. We cannot read `x-ratelimit-*` through `host.request`, so either treat 403/429 as the signal, or move polling behind a `service` if we want precise pacing.
- Default the poll interval to something like 60–120 s and document the arithmetic; make the upper bound (300 000 ms) the recommended setting for larger repo sets.
- Prefer `per_page=30` + pagination; keep responses well under 256 KB.
- Do not use the Search API for polling; do not issue parallel bursts.
- If the product wants *precise* rate management or 304s, that is a second reason to take the `service` path (§Q5).

### CONFIDENCE

**High** on the numbers and ETag rules (official docs, retrieved 2026-09-26, corroborated by a third-party check dated 2026-08-13). **High** that both PAT types share 5,000/h and that no Free/Pro difference is documented for REST core. **High** on the 256 KB truncation and header-stripping constraints — read directly in pinned SDK constants and current-`main` proxy code. **Med** on the assumption that the product owner's installed host build behaves identically to `main` (see §0 gap).

---

## Q5 — Service path: arbitrary outbound HTTPS + transport shape (brief)

### FINDING

**Supported — and it is the only documented route to multi-account GitHub access.** A guest `service` is a host-spawned local process with the user's full access, no sandbox, and **no origin restriction** on its own outbound calls; it can hold N credentials and make its own HTTPS requests. Transport is **panel → `serviceRequest` → host loopback proxy → service**, request/response only.

### EVIDENCE (pinned `node_modules/@openchamber/sdk/GUEST_SERVICES.md`, high)

**Transport model (line 19-31):**

```
panel (iframe) --serviceRequest--> host --HTTP 127.0.0.1:port--> service process --> socket / CLI
                   ^
                   spawn / kill / grant
```

1. Panel still ships `panel/index.html` + classic IIFE `panel/main.js`.
2. `contributes.service` names a built entry the host can spawn.
3. First `serviceRequest` spawns it with the app runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE`); a system `node` is not required.
4. Host binds `127.0.0.1` on an ephemeral port, passes `OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN`. **"The service does not inherit the host environment: only PATH, HOME, temp, locale, and the Windows system variables are copied. API keys, the UI password, and other host secrets never reach it."**
5. `serviceRequest({ method, path, query?, body? })` → host proxies **only to that guest's loopback listener**; same stay-on-origin rule as `request`, but the origin is *our own* service.
6. **"The service talks to Docker, kubectl, or anything else."** — i.e. arbitrary outbound HTTPS with its own credentials, no `apiOrigin` restriction (that restriction binds the panel→host leg, not the service→internet leg).

**Arbitrary access, explicitly (high):** *"Permissions text is advisory. Phase 1 does not enforce an OS sandbox around those lists: an allowed service can run any command, use git, and read or write any file the user can. The approval dialog says so in plain words."* (Security invariants, line 157-162.)

**Inbound auth (line 132-140):** every request to the service, including `/health`, must send `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`; host polls `GET /health` until 200 (15 s), then marks `ready`. Listen on `127.0.0.1` only.

**Limits carried on the panel leg:** `GUEST_REQUEST_TIMEOUT_MS = 20 000`, `GUEST_REQUEST_BODY_MAX = 64 000`, `GUEST_REQUEST_RESPONSE_MAX = 256 000` (pinned `contract.d.ts:302-305`), and `serviceRequest` path must start with `/` with no scheme.

**The security gate we would have to cover (high):**

- `contributes.service` in the manifest → adds `service` to `capabilities.requested` → **user approves the whole list once at install** (`PUT /api/guests/:id/capabilities`); until then every `serviceRequest` is `NO_SERVICE`.
- `permissions.exec` / `permissions.sockets` are shown in the approval dialog but are **advisory** — the dialog states the service has full user access.
- **Token handoff panel → service is the gap.** The panel must *see* the tokens (unlike `host.request`, where "Access tokens never appear in `ready` or a result" and "The extension's page never sees it"). Concretely: user pastes N tokens in the panel → panel holds them (in memory, or `host.storage`: 64 KiB/value, 2 MiB namespace) → panel sends `account-id + token` in a `serviceRequest` `body` (≤64 KB) → host proxies over loopback → service makes `api.github.com` calls. The host does not inspect the body; nothing in the current contract marks a body as secret.
- Consequences the gate must cover: tokens live in the OpenChamber data dir (plaintext JSON, `0o600`), transit panel→host→loopback in the request body, reside in service memory, and **must be covered by our existing redaction rules** (`extension/src/redaction.ts`, T009c) so they never reach the ledger or a toast.
- Lifecycle: install → approve → first `serviceRequest` spawns; `serviceStatus()` reports `stopped|starting|ready|failed`; crash = `SERVICE_FAILED` (manual retry, no silent loop); disable stops it but keeps grants/tokens; uninstall SIGTERM→kill; host quit kills every service. **Streaming panel ← service is explicitly deferred** ("it needs a streaming call on the SDK first") — request/response only.
- Web and desktop only; VS Code and mobile do not spawn services.

### IMPLICATION for our UX

- The multi-account fallback path is **technically viable today** on the pinned SDK (`GUEST_SERVICES.md` ships in `1.24.2` and `contributes.service` parses in `dist/parse.js`).
- It is a *different product surface*: a new manifest capability, a new approval dialog, a new process to spawn/crash/restart, and a token-handoff design. That is exactly what **T012** is scoped for (*"If a host local service is proposed, research its documented service manifest/lifecycle, explicit permissions, secret provisioning, and service-to-host limitations; produce a separate contract and security gate"*) — and `tasks.md` currently lists *"secret handoff to a service"* among the prohibitions pending that gate.

### CONFIDENCE

**High** — read directly from the pinned package file, corroborated by `docs.openchamber.dev/sdk/host/` (`serviceRequest` / `serviceStatus` rows) and `docs.openchamber.dev/extensions/` ("Run a local service: a separate program with your full user access"). Not executed in the spike (the spike manifest declares no service capability).

---

## Design envelope

| Desired UX feature | Platform support | Verdict |
|---|---|---|
| **Multi-account paste-token card (N logins)** | Manifest schema has exactly one `integration`; auth store has one `accessToken` per extension; `GuestRequest` has no credential selector | **Blocked** on `host.request`. **Workaround** = `contributes.service` (panel stores N tokens, service makes the calls) — needs T012 security gate. Short-term **MVP = 1 host-managed account** |
| **Account → repository binding** | Pure panel state; `host.storage` (64 KiB/value, 2 MiB namespace) or `integration.settings` for the visible knobs | **Supported now** |
| **Project picker** | `host.listProjects()` → `{ id, name, directory }`, plus `onProjects` live updates; `startSession({ projectId })` targets it without switching | **Supported now** |
| **Project creation / registration** | No `createProject` anywhere; `guestProject()` throws `NOT_FOUND` for unregistered ids; agent tool "cannot register project paths"; Add-project is UI-only | **Blocked.** Operator adds it manually (command palette / sidebar **+** / folder browser); panel must surface a recoverable "not registered yet" state |
| **PM-agent dispatch (`project-manager`)** | No `agent` field on `StartSessionRequest`/`PromptRequest`; host captures the selection at call start (`settings.defaultAgent` → current agent → primary). Agent-control tool *can* set an agent but is unreachable from a guest | **Workaround:** configure **Settings → Sessions → Session Defaults → Default Agent = `project-manager`** (deterministic, global side effect), optionally per-project default agent. **Verify** post-dispatch via `openSession` → `onSession().agent`. No per-call pin exists |
| *(derived)* **Conditional / rate-aware polling** | `host.request` strips all headers both ways; no `If-None-Match`, no `ETag`, no `x-ratelimit-*` | **Partially blocked.** Works at 10 repos × 60 s (~12% of 5 000/h), but no 304s and no precise pacing — **workaround** = service path |
| *(derived)* **Deep-link the user to Settings / Add project** | `openSurface` is a closed context-rail list; no settings or projects surface | **Blocked.** Copy + `openUrl` only |

---

## Recommended path for the Accounts UX (recommendation, not decision)

The product owner decides; here is the trade space as I read it.

### Option A — Single host-managed account for MVP *(recommended)*

Keep the shape the spike already proved: `contributes.integration` with `token.apiOrigin: https://api.github.com`, `account: { path: "/user", name: "login" }`, `scheme: "bearer"`; the account appears as one **Extension accounts** card in Settings → Integrations; the panel reads `connection.account` as the login; **the PAT never enters the iframe**.

- **Pro:** zero new attack surface, no new capability, no T012 gate, matches the official `github-token` example, best possible secret handling (token stays server-side, redaction rules only need to cover `body`/`detail.error`).
- **Con:** N = 1. Repos from a second GitHub identity are invisible.
- **Structure for later:** keep `AccountRef` / `account_id` as a first-class field in the panel's repo-binding model *now*, even with exactly one account, so switching to Option B later is a storage-and-transport change, not a data-model rewrite. Keep `integration.settings` for the human knobs (repository, poll interval), not for credentials.

### Option B — `contributes.service` for real multi-account *(the only supported N-account design)*

Panel stores N pasted tokens in `host.storage`; each poll carries `{ accountId, token }` in a `serviceRequest` body; the service fans out to `api.github.com` with per-account credentials, owns ETag caches, `x-ratelimit` pacing, and pagination (solving Q4's header problem too).

- **Pro:** genuinely solves multi-account + conditional requests + precise rate control; local, no third-party server.
- **Con:** new manifest capability and approval dialog; tokens leave the host-managed store into panel memory; new process lifecycle (spawn/crash/restart/disable/uninstall) to test; the current `tasks.md` stop-condition *"secret handoff to a service"* must be lifted through **T012** first; no streaming back-channel.

### Option C — N extension variants, one account each

Technically possible (each package has its own `panel.id` + `integration`), operationally poor: N rail icons, N approval dialogs, N storage namespaces, N updates. Mentioned so it isn't rediscovered later. **Not recommended.**

### Option D — Panel-side direct `fetch()`

Untested, undocumented, contrary to the stated security model ("Your page runs in a sandbox and cannot call the internet directly"), and it would put tokens in the iframe anyway. **Not recommended**; only worth a spike if the product owner explicitly wants to probe the platform's edges.

### Suggested sequencing

1. **MVP on Option A** — it satisfies "add a repo bound to an account, pick a project, dispatch" with the strongest security posture and no new gates.
2. **Decide N = 1 vs N > 1 as a product question.** If N > 1 is required on day one, Option B must be scoped and gated (T012) *before* Accounts UX is built — it changes the manifest, the approval copy, the storage model, and the poller's transport.
3. In parallel and independent of A/B: **document the PM-agent setup step** (Session Defaults → Default Agent) as an operator prerequisite, and decide whether post-dispatch agent verification (with its UI context switch) belongs in the product.

---

## Appendix — every claim's provenance in one place

| Claim | Pinned SDK 1.24.2 | Current `main` | Official docs | GitHub docs |
|---|---|---|---|---|
| `StartSessionRequest` has no agent/model/variant | ✅ `contract.d.ts:281`, `protocol.d.ts` wire schema | ✅ `contract.ts:342` | ✅ `/sdk/host/` | — |
| "The guest does not pick a model or agent" | ✅ `DOCUMENTATION.md:54` | ✅ `DOCUMENTATION.md` | ✅ `/sdk/host/` | — |
| Selection captured at call start | ✅ `API.md:178` | ✅ `start-session.ts` `captureGuestSendSelection` | ✅ `/sdk/host/` | — |
| Settings-default agent outranks current selection in guest path | — | ✅ `start-session.ts:136-146` | — | — |
| Agent-control tool accepts `agent`/`model`/`variant` | — | ✅ `openchamber-control/service.js:308-325` | ✅ `/agent-control-tool/` | — |
| Agent tool unreachable from a guest | ✅ `isHttpsOrigin`, `GuestRequest` shape | ✅ `agent-tool/runtime.js` (loopback + token) | ✅ `/agent-control-tool/` | — |
| One `integration` per manifest | ✅ `manifest.d.ts:238`, `parse.js:191/333` | ✅ `manifest.ts:401`, `parse.ts:276` | ✅ `/sdk/`, `/extensions/` | — |
| One token per extension | ✅ `GUESTConnection{connected,account}` | ✅ `auth-store.js` `guests: record<id,{accessToken}>` | ✅ `/extensions/` ("a card") | — |
| `host.request` has no selector, strips headers | ✅ `contract.d.ts:61-70` | ✅ `guests/request.js:46-61,108-111` | ✅ `/sdk/host/` | — |
| No project creation | ✅ `host.d.ts` method list | ✅ `host.ts`, `workspace.ts:15`, `projects/routes.js` | ✅ `/projects/`, `/agent-control-tool/` | — |
| 5 000 req/h authenticated, 60 unauthenticated | — | — | — | ✅ rate-limits page |
| 304 free only when authenticated + `Authorization` | — | — | — | ✅ best-practices page |
| Secondary limits (900/min/endpoint, 100 concurrent, 90 s CPU) | — | — | — | ✅ rate-limits page |
| Service = local process, own outbound, full user access | ✅ `GUEST_SERVICES.md` | ✅ same file + `guests/routes.js` | ✅ `/sdk/host/`, `/extensions/` | — |
