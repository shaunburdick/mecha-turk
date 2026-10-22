# Research: Agent Event Extension (Production) — new findings only

**Feature**: `specs/002-agent-event-extension`
**Researched**: 2026-09-27 · **Amended**: 2026-10-03 (§R8, §R9, for the actor allow-list — GitHub issue #9) · **2026-10-05** (§R10, for the binding history scope — GitHub issue #22)
**Scope**: Everything already settled in `specs/001-agent-event-orchestrator/research.md` (GitHub platform §a, OpenChamber platform §b) is **not** re-researched here — that file was the canonical record. **Historical-path note (2026-09-28, cleanup review):** the whole `specs/001-agent-event-orchestrator/` directory was removed in commit `110c0a2` when `README.md` and `AGENTS.md` shipped, so that citation is **stamped provenance, not a live link** — recover it with `git show 110c0a2^:specs/001-agent-event-orchestrator/research.md`. Where its §a/§b findings bind the production system they are restated as requirements in `spec.md` (FR-004, FR-010, FR-011, FR-029, FR-034, `## Setup Prerequisites`) and in `spec.md`'s `## Research and Platform Decisions` table; **every short-form `001 §…` reference later in this file reads against that same removed file and is covered by this note** — none is a live link. This document records only what 002's planning added, with sources and version stamps.

**Sources used here** (all retrieved 2026-09-27):

- Pinned package files of `@openchamber/sdk` **`1.24.2`** in `node_modules/`: `GUEST_SERVICES.md`, `API.md`, `DOCUMENTATION.md`, `README.md`, and `dist/manifest.d.ts`, `dist/manifest.js`, `dist/parse.js`, `dist/host.d.ts`, `dist/contract.d.ts`, `dist/workspace.d.ts`, `scripts/bundle-guest.ts`.
- `docs.openchamber.dev` live pages: [`/extensions/`](https://docs.openchamber.dev/extensions/), [`/environment/`](https://docs.openchamber.dev/environment/), [`/sdk/host/`](https://docs.openchamber.dev/sdk/host/) — each page exposes its repo edit path (`packages/docs/content/docs/*.mdx` in `openchamber/openchamber`).

---

## R1. Service manifest for a no-permissions (loopback network) service

**Decision it supports**: FR-002 — declare `contributes.service` with the minimum capability set.

**Findings (pinned 1.24.2 dist, high confidence):**

1. `ServiceContribution` is `{ entry: string; runtime: 'host'; permissions?: ServicePermissions }` (`dist/manifest.d.ts`). **`permissions` is optional** — a service that only speaks HTTP on `127.0.0.1` and outbound HTTPS declares **no `permissions` key at all**. The parse error text confirms the shape: *"contributes.service needs entry, runtime \"host\", and optional permissions."* (`dist/parse.js`, `invalid-service`).
2. `service.entry` must be a relative package path passing `isSafeAssetPath`; it ships **compiled JS** ("Ship `service/main.js` already built", `GUEST_SERVICES.md`).
3. **Capability derivation**: `requestedGuestCapabilities` adds `service` when `contributes.service` exists and `network` when `contributes.integration` exists (`dist/manifest.js`). The `contributes.capabilities` array is validated by `z.array(z.enum(DECLARED_GUEST_CAPABILITIES))` where `DECLARED_GUEST_CAPABILITIES = ['prompt','sessions','files','model']` (`dist/parse.js`).
   → **Consequence for FR-002 wording**: the *effective* approved set is `sessions`, `prompt` (declared) + `service`, `network` (implied). Listing the literal strings `"service"` or `"network"` in `contributes.capabilities` makes the manifest **un-installable** (`invalid-capabilities`). The manifest therefore declares `capabilities: ["sessions", "prompt"]` and the contract tests assert the implied set via the SDK's own `requestedGuestCapabilities`.
4. Lifecycle gates (GUEST_SERVICES.md): approval at install via `PUT /api/guests/:id/capabilities`; first `serviceRequest` without grant → `NO_SERVICE`; spawn = `process.execPath` + `ELECTRON_RUN_AS_NODE`; host polls `GET /health` 200 within 15 s → `ready`; disable → `DISABLED` (grant kept); crash → `SERVICE_FAILED` (manual retry, no silent loop); uninstall → SIGTERM then kill; host quit → kill every service.
5. `permissions` text is **advisory** ("Phase 1 does not enforce an OS sandbox… an allowed service can run any command… read or write any file the user can") — this sentence is the substance the FR-008 consent step must restate to the operator.

**Bundle command verified**: `openchamber-guest-bundle [--node] <entry.ts> <outfile.js>`; the `--node` flag keeps ESM because "a local service runs under Node" (`scripts/bundle-guest.ts`).

---

## R2. Service storage location and uninstall-survival expectation

**Decision it supports**: FR-033 (durable store outside `host.storage`, under the operator's OpenChamber data directory, operator-restrictable) and the spec's MUST-verify uninstall assumption.

**Findings:**

1. **Host data directory**: `OPENCHAMBER_DATA_DIR` "Overrides the OpenChamber data directory. The default is `~/.config/openchamber`. Everything OpenChamber stores lives under this directory" (docs `/environment/`).
2. **The service does not receive that variable.** GUEST_SERVICES.md is explicit: "The service does not inherit the host environment: only PATH, HOME, temp, locale, and the Windows system variables are copied." So the service cannot read `OPENCHAMBER_DATA_DIR` at spawn time.
3. **Uninstall semantics**: docs `/extensions/` — extension data "survives reloads and is deleted when you remove the extension"; Remove on a folder install "only forgets the path, your folder stays"; zip/URL installs are deleted from OpenChamber's data folder. GUEST_SERVICES.md adds: uninstall = SIGTERM + kill + clear grant and socket overrides. Neither source says the host deletes *arbitrary subdirectories* of its data directory; deletion targets are the catalog row, extension-owned storage, and copied installs.
4. **Expected survival (documented expectation, NOT yet proven)**: files the service writes itself under `~/.config/openchamber/mecha-turk/` are neither extension-owned storage nor a copied install, so they are expected to survive uninstall/reinstall. **This is the spec's MUST-verify item**: the expectation is recorded here, proven live in task T-033, and no user-facing copy may claim survival before that task passes.

**Decisions taken:**

- Service store root: **`$HOME/.config/openchamber/mecha-turk/`** (the documented default data dir + our folder), created `0700`, files `0600`, atomic temp+rename; `$HOME` is guaranteed present in the service env.
- The resolved absolute path is exposed in `GET /v1/status` and documented in quickstart so an operator using a **custom `OPENCHAMBER_DATA_DIR`** still knows exactly where the store is and can back it up. (The service cannot follow a custom dir it is never told about — stated as a documented limitation, surfaced in health, not silently pretended away.)
- Panel tier stays `host.storage` with documented uninstall-wipe semantics (001 §b.6, unchanged).

---

## R3. Agent verification: how the panel observes `onSession().agent` (spec decision #9 — MUST verify)

**Decision it supports**: FR-029, spec Assumption "Agent verification mechanics" — verify the exact mechanism against the pinned `dist/*.d.ts`; invent nothing.

**What the pinned SDK actually exposes (1.24.2, verified in `dist` + docs):**

| Surface | Carries `agent`? | Source |
| --- | --- | --- |
| `onSession(listener)` / `HostReadyContext.session` → `SessionSnapshot` | **Yes** — `{ id, title, busy, model?, agent? }` | `dist/contract.d.ts`, `dist/host.d.ts`; docs `/sdk/host/`: "`model` and `agent` (the OpenCode agent) appear when the session has them" |
| `listSessions()` → `GuestSessionRecord` | **No** — fields are `id/title/projectId/directory/parentId/timestamps/worktree/activity/outcome/items` | `dist/workspace.d.ts` |
| `onSessionLifecycle()` | **No** — `{ sessionId, phase }` only | `dist/contract.d.ts` |
| `StartSessionResult` | **No** — `sessionId/sent/directory/worktree/linked` | `dist/contract.d.ts` |
| `host.request` / integration `settings` | No — `onSettings` pushes only declared integration fields; there is no settings writer (001 §b.8) | `dist/host.d.ts` |

**The mechanism, verified:**

1. `openSession(sessionId): Promise<void>` is documented as *"explicitly opens the chat and closes the page"* (SDK `API.md`) and *"an explicit transition from a card to its chat"* (docs `/sdk/host/`). It is the only documented call that attaches the surface to a specific session — and it performs a **UI context switch**.
2. `onSession` *"replays the latest value when you subscribe late, then keeps firing as it changes"* (docs `/sdk/host/`) — so the observer subscribes **before** `openSession`, then resolves on the snapshot whose `id` equals the dispatched `sessionId`.
3. `startSession`'s `navigation` defaults to `"preserve"`; `"open"` selects the new chat (`dist/contract.d.ts`, docs). Using `navigation: 'open'` would switch UI *implicitly and earlier*; using `navigation: 'preserve'` + an explicit `openSession` makes the switch a single, deliberate, auditable verification step. **Decision: `preserve` + explicit `openSession`.**
4. **There is no silent alternative at pin 1.24.2.** No `getSession(sessionId)`, no agent field on any list/lifecycle/result surface, and the service cannot call host APIs at all. The spec's assumption that verification opens the created session is therefore **confirmed against the dist types**, not assumed.
5. Timeout behavior: if no matching snapshot arrives within 15 s, or `agent` is absent ("when the session has them" — i.e. unreadable), verification fails **closed** → `blocked:agent-mismatch` (FR-029).
6. **Expected-agent source** *(source superseded 2026-09-28 — retained as the record of what shipped)*: the panel cannot read Settings → Session Defaults (no settings writer, 001 §b.8 — historical citation, see the scope note), so the expected value came from the manifest integration setting `expected-agent` (kebab-case per `PANEL_ID`, `GUEST_SETTING_VALUE_MAX` 2000), default `project-manager` when blank, shown in the panel with its provenance and mismatch remediation copy. **The finding stands; the address changed.** The product owner's *"empty the card entirely"* ruling removed the setting (002 FR-041 re-cut), and the baseline is now the `expectedAgent` member of `config.json`, read by the panel through `GET /v1/config` (002 FR-029 as amended; field: 006 FR-100). The one durable insight — *no settings writer exists at pin 1.24.2, so nothing host-side can supply this value* — is exactly why the value had to move to a surface the panel already reads rather than to Session Defaults.

**Accepted UX cost, documented**: one app chat switch per dispatched run, immediately after creation, while the panel itself stays mounted. This is the "documented UI context switch" the spec already assumed; it is listed in quickstart as expected behavior.

---

## R4. Panel↔service leg limits and error surface (re-stamped for contract use)

From pinned `dist/contract.d.ts` (values, not prose): `GUEST_REQUEST_PATH_MAX = 2000`, `GUEST_REQUEST_BODY_MAX = 64000`, `GUEST_REQUEST_RESPONSE_MAX = 256000`, `GUEST_REQUEST_TIMEOUT_MS = 20000`, `GUEST_SETTING_VALUE_MAX = 2000`, `GUEST_ATTACH_TEXT_MAX = 16000`, `GUEST_ATTACH_DATA_MAX = 16000`, `GUEST_SESSION_AGENT_MAX = 80`.

- `serviceRequest({ method, path, query?, body? }) → { status, body }`; `path` starts with `/`, no scheme (docs `/sdk/host/`).
- Error codes available to the panel: `NO_SERVICE`, `DISABLED`, `SERVICE_FAILED`, `HOST_TIMEOUT`, `HOST_REJECTED`, `HOST_UNAVAILABLE`, `BAD_PATH`, `NOT_GRANTED` (`HOST_REQUEST_ERROR_CODES`).
- Consequences encoded in the contract: service enforces a 60,000-char body cap (below the host's 64,000), every list endpoint paginates to stay under 256,000 chars with an explicit size guard, long-poll waits cap at 10,000 ms (half the leg timeout), and the relay treats `HOST_TIMEOUT` as a soft miss (cursor advances only on acknowledged responses).

---

## R5. Runtime assumptions for the service process

- Spawn: `process.execPath` + `ELECTRON_RUN_AS_NODE` with the app runtime; "A system `node` on PATH is not required" (GUEST_SERVICES.md). The service therefore runs on the **Electron-bundled Node** — plan against Node ≥ 20 API surface (repo `engines.node >= 20.19.0`): global `fetch`, `node:http`, `node:crypto.timingSafeEqual`, `fs.promises`, `AbortSignal.timeout`.
- Env: only `OPENCHAMBER_SERVICE_PORT`, `OPENCHAMBER_SERVICE_TOKEN`, `OPENCHAMBER_SERVICE_SOCKETS` plus the copied PATH/HOME/temp/locale/Windows vars. No host secrets, no `OPENCHAMBER_*` app vars (R2).
- Auth: every request including `GET /health` must send `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`; listen on `127.0.0.1` only, never `0.0.0.0`.
- Outbound: no `apiOrigin` restriction on the service's own fetch — "The service talks to Docker, kubectl, or anything else" (001 §b.9, re-confirmed).

---

## R6. Discovery endpoint selection for the trigger set (adapter-level, GitHub)

Settled GitHub facts stay in 001 §a.1–§a.6. What planning adds is the **stream mapping** behind FR-015's three trigger families (endpoint choice remains isolated in the adapter, per FR-017/NFR-010):

| Stream | Endpoint (repo-scoped) | Feeds |
| --- | --- | --- |
| `issues` | `GET /repos/{o}/{r}/issues?state=open&sort=updated&direction=asc&per_page=30` | `issue_assignment` (assignee on issues **and** PRs), `mention` from the issue body (FR-015(c), 2026-09-28 — no extra request), source anchors |
| `issue_comments` | `GET /repos/{o}/{r}/issues/comments?sort=updated&direction=asc&per_page=30` | `mention` (comments on issues and PRs) |
| `pulls` | `GET /repos/{o}/{r}/pulls?state=open&sort=updated&direction=asc&per_page=30` | `review_request`, `review_assignment` (`requested_reviewers`), head SHA for drift detection |

Cadence/budget arithmetic and the budget controller that keeps NFR-003 are specified in plan.md; exact query/field details are validated by fixture-driven contract tests against GitHub's documented response shapes (001 §a.1: sort stability, serial requests, no Search API, no Notifications — 001 §a.6; *both section references are to the removed 001 research record — historical, recover per the scope note at the top of this file*).

---

## R7. What was checked and did NOT change

- One `integration` per manifest, single `host.request` credential (001 §b.3) — unchanged; the `integration` card in 002 is optional/non-authoritative per FR-011.
- `host.storage` caps and uninstall wipe (001 §b.6) — unchanged; re-confirmed in docs `/sdk/host/` ("Storage belongs to this extension on the connected server, survives reloads, and is removed on uninstall").
- No project creation, no session/worktree deletion APIs (001 §b.4/§b.5) — unchanged; re-confirmed in docs `/extensions/` and `/sdk/host/`.
- No per-call agent/model/variant (001 §b.2) — unchanged; docs `/sdk/host/`: "The extension never picks them."
- SDK pin `1.24.2` exact (`spike-evidence.md` §1 — **historical path**: that file was removed with the 001 directory in commit `110c0a2`; the pin is live in `package.json` and its provenance in `spec.md` NFR-008); `engines.openchamber: ">=1.24.0"`; re-pin to the host release before live execution (NFR-008).

## R8. Who acted — what the **list** feeds name, and what the **events** feed names (added 2026-10-03 for FR-044/FR-045; **entirely rewritten 2026-10-03 at v1.12.0**, because its original claim was false)

> **What changed, and why this section is rewritten rather than amended.** The original §R8
> established that *"GitHub's issues list exposes no `assigned_by`, no assign-event, and no
> timeline"*, recorded the absent actor as a **contract limitation of the provider**, and
> declared that this research *"does not propose a second API call to close the gap"* because the
> specification had already ruled a **documented proxy** to be the honest reading. **That was
> wrong.** The claim is true of the two endpoints the table examined and **false of GitHub**. A
> two-endpoint sample was generalized to a provider, and the generalization was then recorded in
> the same confident register as the rest of this file — with a "verified against the shipped
> code, not from memory" note, which is true and which is exactly what made it misleading: the
> shipped reader was verified, and the *provider* was not. The rewritten section below keeps the
> correct half of the original (the list feeds really do name no actor) and replaces the rest.

### The corrected finding

**GitHub records both actors, in named fields.** They are on the **per-item events** feed, one
endpoint away from the list feeds the poller already calls:

`GET /repos/{owner}/{repo}/issues/{issue_number}/events` → item schema **`issue-event`**. Verified
against the live API on this repository and against GitHub's own OpenAPI description
(`github/rest-api-description`, path `/repos/{owner}/{repo}/issues/{issue_number}/events`).

| Member | Type | What it is | Why it matters here |
| --- | --- | --- | --- |
| `event` | string, **no enum in the schema** | the kind word — `assigned`, `unassigned`, `review_requested`, `closed`, `merged`, `labeled`, `referenced`, `head_ref_deleted` observed | An unrecognized word must be **ignored**, never coerced into a known kind (FR-050) |
| **`assigner`** | nullable `simple-user` | *"the person who performed the assignment"* | **The actor of an assignment.** Issue-events only — **not** on the timeline endpoint |
| **`review_requester`** | nullable `simple-user` | *"the person who requested a review"* | **The actor of a review request** |
| `assignee` | nullable `simple-user` | who was assigned | The **subject** — must equal the bound account for the event to answer an assignment candidate (FR-050) |
| `requested_reviewer` | nullable `simple-user` | whose review was requested | The **subject** — must equal the bound account for a review candidate (FR-050) |
| `actor` | nullable `simple-user` | *"the person who generated the event"* | **Not the field to read** — see below |
| `created_at` | date-time | when the event happened | The **only** way to apply the window: these endpoints have **no `since` parameter** (FR-051) |
| `issue` | nullable issue | carries `number` and `pull_request` | The `pull_request` member is what distinguishes a pull request from an issue |

**Live evidence on this repository.** A `review_requested` event on issue **#14** returned
`review_requester: shaunburdick`. `assigned` events on issues **#12, #8, #3** and **#2** each
returned `assigner: shaunburdick`.

**`actor` is not the field, and the distinction is the reason the correction is worth its cost.**
In *every* row observed here `actor` equalled the explicit field — which is precisely why reading
`actor` would look correct against this repository's data and be wrong in production. `actor` is
documented as the person who **generated** the event; `assigner` and `review_requester` name the
actor **of the act**. The two differ exactly where it matters most: an app or bot that acts on a
human's instruction generates the event as the app and records the assignment or review request
against the human. Reading `actor` would record the automation as the person who assigned the
issue, and would put an app login into an allow-list comparison as though a person had. FR-049
names the explicit fields for this reason and not for tidiness.

### What the list feeds name — still true, and still why the events read is *additional*

The original table's finding about the **list** feeds was correct and is preserved, because it is
the reason the two stages exist rather than collapsing into one:

| Feed | Endpoint the scan already calls | Names the author? | Names the actor of the *act*? |
| --- | --- | --- | --- |
| issues | `GET /repos/{owner}/{repo}/issues` | **yes** — `user` (the issue/PR **author**) | **no.** `assignees` is the *current* assignee set with nobody behind it on this endpoint |
| issue comments | `GET /repos/{owner}/{repo}/issues/comments` | **yes** — `user` is the **comment's** author | **yes**, because the comment *is* the act that carried the mention |
| pulls | `GET /repos/{owner}/{repo}/pulls` | on this endpoint's own shape, no — the shipped reader takes `requested_reviewers`, `head.sha`, `base.ref`, `state`, `html_url`, `updated_at` | **no.** `requested_reviewers` is the current reviewer set with no requester behind it |

So the two stages are not redundant and the original author was right about **that**: the list
feeds are how the product **detects** a candidate, cheaply and in bulk, and they cannot say who
acted. The events feed is how it **attributes** one, per item, and it can. The defect was not in
the two-stage shape. It was in concluding from "the list feed cannot say" that "nothing can say",
and then declining to look one endpoint over.

### The window: there is no `since`, and that is a hard constraint on the requirement

| Endpoint | Query parameters | `since`? |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/events` | `per_page`, `page` | **no** |
| `GET /repos/{owner}/{repo}/issues/events` (repository-wide) | `per_page`, `page` | **no** |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline` | `per_page`, `page`, **`exclude`** | **no** |

Any requirement phrased as "read the events since the window start" specifies a capability GitHub
does not have. The window MUST be applied client-side by comparing `created_at` against
`lastScanAt − overlapMs` (FR-051). This is also the second reason the read is **per item** rather
than repository-wide: with no server-side window anywhere, a repository-wide read needs its own
pagination-truncation concept, and a busy repository can push a rarely-scanned binding's in-window
events past the page cap. Per-item reads keep the truncation surface the scan already has.

### What is **not** established here, and must therefore fail closed

Stated plainly because the honest reading of this section's history is that a confident claim in
this file was wrong once, so the untested parts are named rather than left to be discovered in
production. **This repository's data has only ever had one human actor**, which means three cases
are **unobserved** and are specified by refusing rather than by guessing:

- **Bot and app actors** on `assigner` / `review_requester`. Handled by the existing `isBotAuthor`
  predicate, which reads the `simple-user` `type` exactly as it already does on every other feed —
  `simple-user` carries both `login` and `type`, so **no new bot logic is invented**. If a future
  row shows a bot that predicate misses, the outcome is a refused event, not a granted one.
- **Bulk assignment** — several events naming the bound account inside one window. Handled by the
  maximum-`created_at` rule (FR-050), which is defined for it whether or not it has been seen.
- **A `null` `assigner` or `review_requester`** — never observed. Handled by **refusing** (FR-052),
  deliberately, and specified to fail closed *even though the same row's `actor` member would
  usually have been readable* — because that substitution is precisely the one that would make the
  correction cosmetic. The refusal is self-healing rather than lossy: the scan window **overlaps**,
  so the candidate is re-detected on the next cycle and the event is created exactly once.

### What changed about the specification's shape, and what did not

**The correction is mechanical, not structural.** Nothing about the actor's *member* changed: not
its name, not its validation, not the closed union, not the additive `schemaVersion 1.2`, and not
FR-046's rule keeping the actor out of the deterministic event identifier. The gate (003), the
panel's rendering (005), and the containment rules are all untouched in shape. **What changed is
which login lands on `actorLogin` for two of the four trigger kinds** — which is a change of
correctness, not of scope.

**`PollPull`'s `authorLogin` / `authorType` lose their stated reason to exist.** They were added at
v1.11.0 for one purpose, quoted from that requirement: *"to make FR-044's `subject-author` basis
possible at all … without them the review kind has no identity to attribute to."* The basis they
existed for is gone, and the review kind's actor now comes from `review_requester`. FR-045's
sentence requiring them is **struck**, no requirement now asks for them, and whether the
implementation keeps or removes them is Phase 6's business. The strike is recorded here as well as
in the requirement because a field that quietly stops having a consumer is the exact shape of drift
a reader of the code would find before a reader of the spec.

**`'subject-author'` survives as a readable, unproduced member** (FR-044). Rows the shipped build
already wrote to `events.json` carry it; the union cannot be narrowed without refusing real stored
rows, and a refused run row hides an entire dispatch at the panel. Collapsing the union to
`'direct'` alone is the tidy-looking alternative and is explicitly **rejected** — recorded in
`## Out of Scope` so a later reader does not "clean it up" into a data-loss bug.

### On the method, because the method is what failed

The original section ended by declining to propose the second call, and its stated reason was cost:
*"one extra request per trigger — a real cost against SC-005's 1,500 requests/hour budget and a
whole new pagination and failure surface for a value the specification has already ruled is a
documented proxy."* Both halves of that reasoning were sound and the premise was not, which is the
shape of mistake worth writing down: **a cost argument cannot make an unsound fact sound, and a
ruling that rests on an unsound fact has to be re-examined, not re-costed.** The corrected design
keeps the cost concern exactly as it was stated — per-item reads cost **zero** when nothing matched,
are small when something did, and are charged to the same per-account budget as the scan (FR-049,
SC-005 re-cut) — and it does not pay for that with a guessed actor. A wrong login in an audit trail
is a cost too; it is just the one that does not appear on a rate-limit graph.

## R9. GitHub login shape and length (added 2026-10-03, for FR-047's validation)

The validator needs a definition of "a GitHub login" that is a **fact about
GitHub** rather than a house rule, because the comparison is against a login
GitHub itself issued.

- **Alphabet**: alphanumeric, plus single hyphens between alphanumeric runs. A
  login may not begin or end with a hyphen and may not contain consecutive
  hyphens.
- **Length**: at most **39** characters. A longer value can never match any
  login GitHub issues, so refusing it at save is refusing an input that could
  not have worked — the honest direction, and consistent with 002 FR-024's
  refuse-malformed posture.
- **Case**: GitHub logins are **case-insensitive** in practice — the same
  repository reports them with the casing its owner chose. This is why 002
  FR-047 compares case-insensitively and preserves the stored spelling, and it
  is the same reason `mentionsLogin` folds case (FR-015).
- **Bots**: an App or bot account's login carries a literal `[bot]` suffix. It
  is syntactically a normal login, which is why the bot judgement checks the
  suffix rather than the alphabet (and why plan D7 records that naming one is
  accepted and inert rather than refused).
- **Not a research dependency**: none of this needs a network call, a live host,
  or a newer SDK. It is a fact about an API this project already polls, and it
  is pinned by tests against fixtures rather than by a live probe — consistent
  with the repository's offline testing rule (`AGENTS.md`).

## Open items this research leaves

1. **Uninstall survival is an expectation, not a proof** (R2) — MUST-verify task T-033; docs claim gated on it.
2. Live host build version was never recorded by the operator (001 §1 — *historical citation: the 001 record that carried it was removed in commit `110c0a2`; recover with `git show 110c0a2^:specs/001-agent-event-orchestrator/spike-evidence.md`*) — record it during T-033's live run.
3. Whether the panel's `onSession` also fires without `openSession` (e.g. `navigation:'open'`) is *undocumented*; the plan does not depend on it, and tests pin only the documented path (R3).
4. **002 v1.11.0 adds none.** R8 and R9 settle the two questions the allow-list raised (who the actor is, and what counts as a login) from the shipped readers and from GitHub's documented login rules. Three items the amendment raised are **not** research questions and are recorded as decisions or flags instead, each in the place that owns it: the `schemaVersion 1.2` question is plan D1, the omission-means-unset reading is plan D4, and the `[bot]`-entry reading is plan D7.

---

## R10. Where a scan window's lower bound comes from, and the three routes to "no window" (added 2026-10-05 for FR-053 – FR-094, GitHub issue #22)

Everything below was read in the shipped code on 2026-10-05, with file and line references so each claim can be re-checked. **No external research was needed**: the question is what the product already does, not what a provider does. §R1 – §R9 are unchanged.

### R10.1 The replay is real, and it has exactly three routes in

`service/poll/window.ts:44-64` — `windowFor()` reads the binding's slot in scan state; a `lastScanAt` that is `null`, **or no slot at all**, returns `null`, which is *no `since` filter at all*. `service/poll/window.ts:83-96` — `stampInWindow()` with a `null` windowStart returns `true` for every stamp, so the comparison admits everything. The product decision that produced it is recorded in the code itself, dated: *"pre-binding assignments must work (product decision, 2026-09-28), so an issue assigned before the binding existed is still detected"* (`window.ts:33-40`).

**Three routes reach that state today**, and each needed a separate answer: (1) a binding with no completed scan; (2) the queue-recovery reset, §R10.2; (3) `window.ts:58-61` — a recorded stamp the clock cannot parse falls back to `null`, justified in its comment as *"an unbounded window is honest, a malformed `since` is not"*. Route 3 is defensible as an argument about a query parameter and is **not** defensible as behaviour: the dateless-**observation** case is refused (`window.ts:88-90`), and an unreadable stored configuration is quarantined. It was the last remaining route to an unbounded window, and FR-072 closes it.

### R10.2 The recovery reset and the first scan are one representation with two callers

`service/poll/events.ts:167-204` — when the event queue is quarantined, `resetScanWindows()` walks **every** binding's slot and writes `null` over its checkpoint, on the stated reasoning that the lost queue's rows are gone and the only way to recover what they carried is to re-detect it. The comment names the intent: *"the next cycle replays every open issue — the same contract a fresh binding gets."* The write runs on the scan-state chain so it cannot interleave with the loop's own read-modify-write.

`service/poll/loop.ts:300-322` — `saveBindingScanState()` keeps the retained-checkpoint rule and says so in a comment that names the reset as *"the one path that clears the stamp"*.

**This is the consequential read in the exercise.** The recovery path and the creation path are one representation with two callers, so a rule distinguishing "never scanned" from "watch only new activity" cannot be implemented without either losing recovery or adding a second escape hatch only one path can reach. FR-073 and FR-074 exist because of it, and neither would have been written from the issue text.

### R10.2b FR-023's rescan surface does not exist, and never has

Verified 2026-10-05 by inspection: `service/routes/` carries **no rescan, replay, or rewind operation** —
the route table is accounts, bindings, audit, config, credential, dispatch, events, health, run, status, and
verify. FR-023 has required *"a controlled operator rescan/replay from a chosen timestamp"* since v1.0.0,
and no surface has implemented it at any point. **This is a conformance gap against a requirement this
document has carried for its whole life**, and it is invisible from the requirements alone: a reader of
FR-023 would reasonably assume the surface exists.

It is also a live hazard for the history-scope work specifically. "The mode change reuses FR-023's rescan
path" is only implementable if something is being reused; with nothing there, the instruction resolves to
*build one mechanism, and build only the caller the new requirement names*. That is what the product owner
decided on 2026-10-05, and it is why FR-023's promise was narrowed at the same time rather than left
standing beside a new requirement that quietly depended on it. The debt is recorded in `spec.md`
`## Out of Scope` by name. Building it later is additive: no migration, no data-model change, no stored
value to reconcile.

### R10.3 A window start is consumed by five paths, and all five already handle a real stamp

This is the finding that makes the feature small. `windowStart` reaches:

| Consumer | Read | With a real start today? |
| --- | --- | --- |
| Issues / comments **list** calls | sent as `since` — `service/poll/poller-github.ts:77,153,178` | yes |
| The pulls list | `service/poll/triggers.ts:363`, and `poller-github.ts:203` sends `since: null` because that endpoint takes none | yes, via the client-side comparison |
| In-window comparison (listings) | `stampInWindow(issue.updatedAt, …)` — `triggers-assignment.ts:124`, `triggers-review.ts:126`, `triggers.ts:220,263` | yes |
| Per-item events page walk | `pageEndsWalk(…, windowStart)` — `poller-events.ts:297` | yes |
| Per-item events in-window test | `stampInWindow(event.createdAt, …)` — `poller-events.ts:329` | yes |

The per-item endpoints carry **no** `since` and never will — that is FR-051's prohibition, unchanged. So the implementation is *"return a real start instead of `null` for a binding with no completed scan"*, and the page walk, the attribution rule, the `since` parameters, and the dateless-observation refusal all work untouched. It is also why FR-068 can forbid the mode from appearing in any per-observation comparison: the moment it did, one of five consumers would need a rule the other four do not have.

### R10.4 The stored record's own conventions

`service/bindings.ts` — the record is a service-owned JSON array read through one validator that collects **every** problem rather than short-circuiting (`collectBindingIssues`, and `parseBinding`'s second pass that re-runs the readers purely to collect all issues). Optional members follow one shape each: the key is **absent** when unset (never `''`, `null`, `[]`); a present non-text value is **refused** rather than coerced; the whole file is quarantined on an unreadable read. `state` is the one member whose absence means the **default** (`stateFieldOf` returns `'active'` when `undefined`); `allowedUsers` is the one whose absence is a **complete state of its own**. The difference is whether absence is a default the product would have chosen anyway or a third option — and `historyScope` belongs to the first family, which is why FR-058 gives absence exactly one reading.

`stampOrKeep()` fills an unreadable `createdAt` with `nowIso()` at read time. That is why FR-066 requires the baseline to be **derived once and retained** rather than recomputed per scan: a binding whose creation stamp is unreadable *and* whose scan keeps failing would otherwise slide its baseline forward on every attempt.

### R10.5 The status row is safe to extend in both directions

`service/routes/events.ts:198-213` builds the per-binding status row (`lastScanAt`, `lastError`, `pendingCount`). The panel's reader, `src/bindings-service.ts:207-245`, is **lenient about members it does not know** — it reads what it needs and ignores the rest — and **fail-closed about the members it does**: `readAllowedUsers` refuses the whole entry for a non-array or an empty one. So adding derived members is backward-compatible with an older panel, while the new *configuration* member must be read fail-closed by the panel exactly as the allow-list is (FR-063).

### R10.6 The audit vocabulary for "why was this observation not accepted" is reserved and unwritten

`data-model.md:190` reserves `poll.observation` and `poll.checkpoint`. **Neither is written anywhere in `service/`.** The names were reserved for exactly this shape of question, and the trail currently cannot answer it at all. FR-087 answers it from two durable facts instead and leaves both names free, because a row per non-matching observation is unbounded in volume — a cycle matching nothing writes one per open item, every cycle.

### R10.7 Two spellings of "the operator chose from a closed set", already in the product

`state: 'active' | 'disabled'` is **required** with absence meaning the default, and `allowedUsers` is **optional** with absence meaning *anyone may trigger* — emphatically not the default. `allowedUsers: []` is a **refusal**, not a state, and there is no analogous hole in the mode because its domain has no "none of these" value.

### R10.8 Versions and declaration site

`service/config.ts:155-167` — `NUMERIC_BOUNDS` declares bounds for every numeric configuration field, and it is the **exported** declaration the Settings schema projection reads. Putting the look-back length there would have made it a **configuration field**: 006 FR-020's projection would render a row, and 006 FR-010's and FR-084's documented count of **twelve** would become thirteen. It is therefore declared as its own constant with its own bound, outside `ServiceConfig` (FR-059). **The validation posture is the one `overlapMs` gets; the declaration site deliberately is not.**

`@openchamber/sdk` is pinned at **`1.24.2`** with `engines.openchamber >= 1.24.0`; the published latest is **`2.1.1`**, a major ahead. This amendment adds no host call, so the pin is not a gate for it; re-pinning is an invariant-6 decision requiring a check against the operator's host build, and nothing here requires it. **Observation, out of scope.**

### R10.9 Alternatives considered and rejected

| Alternative | Rejected because |
| --- | --- |
| A boolean `replayHistory` | two values need no boolean, and a boolean has no third state to grow into without a rename in a persisted value |
| A stored `historyWindowMs` | makes the number operator-visible, which the owner declined, and puts "unbounded" one hand-edit away from being representable |
| A per-binding `replayAt` stamp the operator sets | makes the operator a time authority on every scan rather than once at creation, and duplicates the checkpoint with two stamps that can disagree |
| A memory flag for the recovery replay | works until any path other than the recovery cycle reads the checkpoint, at which point the flag is gone and the case degrades silently into "never scanned" |
| A per-observation audit row | unbounded volume on exactly the cycles that produce nothing, which is most of them |
| An edit that only affects bindings with no completed scan | does nothing at all on any binding that has ever scanned — a control that appears to work and does not |
| A count cap on the sweep | a cap that stops part-way leaves a checkpoint recording a completed scan while in-window triggers were never offered, with nothing able to name which ones |
| An account or global tier, as the starting prompt has | this value selects a window; the prompt's value is an instruction that composes. There is no composition story for a window, and one repository per binding is a standing rule |
| A second replay surface for the operator's catch-up | two replay mechanisms with different rules is how a rescan silently changes meaning; FR-023 is the single path and only *whose choice* sets the bound differs |

## R11. The panel already receives the host's current directory (added 2026-10-06 for FR-095 – FR-099, GitHub issue #21)

The issue's premise — *the panel can be aware of the current project it is in* — was verified before specification rather than assumed, against the installed pin `@openchamber/sdk` **`1.24.2`** and the official Host API docs (`https://docs.openchamber.dev/sdk/host/`), both read **2026-10-06**.

**Pointer note (Gate-2 finding G2-6, 2026-10-06).** `plan.md` cites this section as `§R11.1`, `§R11.2` and `§R11.3` for three facts; those are this list's items **6** (`mountSelect` semantics), **7** (the reload moments) and **8** (fixture reality), in that order — the plan's pointers were written against the premises it built on, not against list position, while `challenge-ledger.md` cites `§R11.6` for item 6 by position. Both spellings resolve to the same text below; the mapping is recorded here because nothing validates these pointers, and a wrong one is silent.

1. **`HostReadyContext.directory: string | null`** — `dist/contract.d.ts:159-174`; the docs' field table describes it as *current project directory, or `null`*. It reaches the panel with the `onReady` snapshot `src/app.ts` already handles (`begin` → `mountPanel(rt, context)`), which ignores it today. No new host call is needed to obtain it.
2. **`onDirectory(listener)`** — `dist/host.d.ts:34`; the docs state that `onDirectory` (with `onSession`) *replays the latest value when you subscribe late, then keeps firing as it changes*. **Deliberately not used**: FR-095 is load-time only, so no directory subscription is registered, and a test asserts that none is (AC-045).
3. **`GuestProject.directory: string`** — `dist/workspace.d.ts:3-7`. The picker already loads this list for its options, so the match needs no second read and no second list call.
4. Consequently the current project id is *the project whose `directory` equals the host's `directory`* — and nothing else follows from it: no capability, storage key, wire member, manifest field, or host call is added (AGENTS.md invariant 3; FR-096(c)).
5. **In-repo premise, the click constraint** — `src/panel-ui.ts`'s `refreshProjectPicker` comment records that the SDK select skips `onChange` when a click matches the value already displayed, which is why it sets the control's value to the manual selection rather than the effective one. That constraint is the reason FR-099 exists: displaying a derived default makes it un-pickable in one click, and the requirement states the accepted behaviour instead of a workaround.

6. **`mountSelect` semantics, read in the installed SDK's source rather than inferred** — `node_modules/@openchamber/sdk/dist/ui/select.js` (pin `1.24.2`), read 2026-10-06. `pick(id)` calls `onChange` **only when `id !== props.value`** — the same-value skip FR-099 rests on, and the reason a displayed default cannot be re-picked into storage in one click; `paint()` renders the option whose `id === props.value` and otherwise the placeholder with `data-empty="true"`, so a value outside the option list (a stored pick while the list is `loading` or `error`, when options are empty) *displays as the placeholder* rather than as an unknown value — today's behaviour, and what keeps FR-097(a)'s "otherwise today's unpicked state" honest; `update()` merges props and repaints, so a repaint-driven value change needs no remount.
7. **The project list's only reload moments** — verified in `src/` 2026-10-06. `loadProjects` has exactly two callers: the mount (`src/app.ts:253`) and the **Reload projects** button, whose handler is named `refreshProjects` in the one handler table (`src/bindings-mount.ts:196`) — `src/app.ts`'s second table went with the duplicate Bindings picker at issue #39, so the earlier citation that named it (`src/app.ts:396`) has no target in the 367-line file. The panel's other refresh paths do not re-list: the bindings Refresh runs `loadBindings`, the Status tick runs `loadStatus`, and `refresh(rt)` is a repaint; `onProjects` feeds only `host-verify`'s bounded probe (subscribe → teardown), never the picker. Consequently FR-095's "the project list is reloaded", FR-099's "next load or refresh", the edge case's "loads again or the project list is reloaded", and Key Entities' "panel load or project-list reload" all denote the same two moments — the question the Gate-1 ledger deferred (1g), answered without a spec edit.
8. **Fixture reality: no test constructs a `HostReadyContext`** — verified 2026-10-06. `fakeHost.onReady` is a no-op that never invokes its listener (`tests/support/panel.ts:143`), `mountPanel`/`begin` are module-private and reached only through that listener, and even the full-boot harness mounts the shell and performs app.ts's startup reads by hand (`tests/containment-proof.test.ts:292-344`, its own comment: *"the harness mounts the shell by hand, so it performs that read by hand too"*). Consequences for the plan: the load-time directory record must be an **exported step** (`recordHostDirectory`, beside `restoreProjectSelection`) to be testable at all, and `PanelState.hostDirectory` starting `null` means every existing suite derives no default by construction — the Gate-1 ledger's 1f assumption, resolved.

**What this does not establish**, stated so no reader mistakes the list for a shorter one: nothing about directory stability across host versions, nothing about path canonicalisation, and nothing about two projects sharing a directory. The match therefore stays exact and fails closed on a mismatch, and an ambiguous directory yields **no** default rather than the first hit (FR-096(b)). Items 6–8 add nothing to that list: they are in-repo facts about the pinned SDK and this codebase's own load and fixture paths, not claims about the host's behaviour beyond them.

---

## R12. The GitHub objects the tracking lifecycle reads (added 2026-10-09 for FR-100 – FR-107, GitHub issue #13)

Every premise below was read from GitHub's own REST API documentation on **2026-10-09** — the endpoint pages and their response-schema tables, not a summary — because the amendment specifies detection and terminal-state rules on these objects. Response **shapes** were read, not field lists: which members exist, which object carries which, and where two similar objects disagree is the part a field list hides. **§R1 – §R11 are unchanged.**

### R12.1 The issue-comment object — `issue_url` is the member that links a comment to its issue

`GET /repos/{owner}/{repo}/issues/comments` — the repository-wide feed the service **already reads** for the mention trigger — returns the **Issue Comment** object. Verified members: `id` (int64), `node_id`, `url`, `html_url`, `body`, `user` (**nullable** Simple User: `login`, `id`, `type`, …), `created_at`, `updated_at`, **`issue_url` (required, uri)**, `author_association`, `performed_via_github_app`, `reactions`, `pin`, `minimized`.

**`issue_url` is the link member** and it is the reason a repository-wide comment read can serve per-issue follow-up detection: the row names its issue (`…/repos/{owner}/{repo}/issues/{number}`), so the subject is recovered from the row rather than from the request. Its documented description on the *commented* event shape says "the HTML URL of the issue"; the **live object carries the API URL**. Either way it is a URL whose last path segment is the issue number, and the reader must take the number from the path rather than trusting a shape — recorded so the reader is written against the path, not against the description.

Two query-parameter facts that shape the detection rule:

- **`since` filters on *updated*, not created**: the parameter is documented *"Only show results that were last updated after the given time."* A comment **edited** after it was first seen therefore **re-enters the window**. This is a premise of the edited-comment edge case, and it is why the follow-up's dedupe key is the comment **id** rather than a timestamp.
- **`direction` is ignored without `sort`**, and `sort` defaults to `created`. The service already sends `sort=updated&direction=desc`, which is a documented combination; nothing in this amendment changes what the existing read sends.

`GET /repos/{owner}/{repo}/issues/{issue_number}/comments` returns the **same object** with the same members, per issue. The amendment does **not** add a per-issue read for timeline comments: the repository-wide read is already paid for, `issue_url` makes it sufficient, and FR-102 rides it at zero added requests.

### R12.2 The pull-request object — `state`, `merged`, `merged_at`, `head.sha`; and no `state_reason`

`GET /repos/{owner}/{repo}/pulls` — the list the service **already reads** for the review-request trigger — returns the **Pull Request** object, whose relevant members are `number`, `state` (`'open' | 'closed'`), `merged` (boolean), `merged_at` (nullable timestamp), `head.sha` (the head commit SHA), `head.ref`, `base.ref`, `title`, `user`, `updated_at`. There is **no `state_reason`** on this object — the reason vocabulary (`completed` / `not_planned` / `reopened`) is issue-only, which is why FR-106 records *which* of the three terminal kinds was observed rather than quoting a reason string for a pull.

Two premises load-bearing for this amendment:

- **`head.sha` is on the list row the scan already reads**, so push detection rides the existing pulls read at zero added requests (FR-102(b)). It is the whole basis of the "no new read for detection" claim.
- **`merged` is not on the pulls list at all**, and `state` is worthless there for a terminal test: the list returns the **`Pull Request Simple`** shape — verified against the endpoint's documented response schema on 2026-10-09, whose member list ends `… closed_at, merged_at, assignees, requested_reviewers, requested_teams, head, base, _links, author_association, auto_merge, stack, draft` and carries **`merged_at` but no `merged`**. So a closed pull read from the list cannot be told apart from a merged one by `merged`, and neither can be seen at all, because **both list feeds the service reads are filtered `state=open`** (`service/poll/poller-github.ts:226,276`) — a closed or merged pull is not on the list. **That is a real limit of the two existing reads and it is stated rather than designed around**: FR-106's end-of-tracking test cannot be judged from a list row, and the one read that answers it is the single-pull object, issued lazily (§R12.5). The first draft of this amendment added a per-subject terminal read **per cycle** to close this gap; the product owner cut *that* shape, and the per-subject-per-cycle read stays cut — what replaced it is one read issued only when a follow-up has been detected, which is a different cost and a different requirement (§R12.5, FR-102's one exception).

### R12.3 The issue object — `state`, `state_reason`, `closed_at`

`GET /repos/{owner}/{repo}/issues/{number}` returns the **Issue** object: `state` (`'open' | 'closed'`), `state_reason` (`'completed' | 'not_planned' | 'reopened'` or `null`), `closed_at` (nullable timestamp), `updated_at`. Recorded because FR-106 names the issue's closed state as one of the three terminal observations and because `state_reason` is the member that distinguishes a completed issue from one closed as not planned — the distinction the end-of-tracking audit row carries.

### R12.4 Alternatives considered and rejected

| Alternative | Rejected because |
| --- | --- |
| A per-issue comments read (`…/issues/{number}/comments`) for timeline-comment detection | The repository-wide read is already paid for and `issue_url` links the row to its issue; a per-issue read would add one request per tracked subject per cycle for content the existing feed already carries |
| **A terminal-state read per tracked subject per cycle** | One single-item request for every tracked subject on every cycle whether or not anything arrived on it. **Rejected, and it was the first draft of this amendment's own design** — the product owner cut it on 2026-10-09. What replaced it is the lazy read below: one read per subject per cycle *in which a follow-up was detected for that subject* (FR-102's one exception, FR-106) |
| Keying the follow-up's identity on the comment's `updated_at` | `since` filters on *updated*, so an edited comment re-enters the window; the comment **id** is the stable key and the event id carries it |
| Review comments and whole review submissions as follow-up sources | Each is one added GitHub read per tracked pull (`…/pulls/{number}/comments`, `…/pulls/{number}/reviews`); the product owner cut both on 2026-10-09. Revisit only with a measured read cost |
| `GET /repos/{owner}/{repo}/pulls/{number}/merge`'s 204/404 answer as the pull's terminal read | It reports *merged* only, so it cannot distinguish a **closed-unmerged** pull — which FR-106 must name distinctly — and its **404** means *not merged*, which the shared transport classifies as `auth-failed` (`poller-transport.ts:210`) and which therefore cannot be told apart from a credential failure at all (see §R14.10) |

### R12.5 The two single-item terminal reads (added 2026-10-09, second draft — the one read FR-102 admits)

Read from GitHub's REST API documentation on **2026-10-09**. Two endpoints, and they are **not interchangeable**: each answers the terminal state of one shape of item, and the fields that answer are different fields on different objects. **§R1 – §R12.4 are unchanged.**

**An issue — `GET /repos/{owner}/{repo}/issues/{issue_number}`.** Returns the **Issue** object. The members that answer the terminal question, and nothing else is read: `state` (`'open' | 'closed'`), `state_reason` (`'completed' | 'not_planned' | 'reopened'` or `null` — the vocabulary that distinguishes a completed issue from one closed as not planned), and `closed_at` (nullable timestamp, the date the end-of-tracking row carries). Documented status codes for this path include `200`, `301`, `404`, `410`, `422` and `500`.

**A pull request — `GET /repos/{owner}/{repo}/pulls/{pull_number}`.** Returns the **full Pull Request** object — the documented response schema is *the same schema as create*, whose member list ends `… author_association, auto_merge, stack, draft, merged (required, boolean), mergeable, rebaseable, mergeable_state, merged_by, comments, review_comments, maintainer_can_modify, commits, additions, deletions, changed_files`. The members that answer: `state` (`'open' | 'closed'`), **`merged` (required boolean)** and `merged_at` (required, string or null). Documented status codes include `200`, `304`, `404`, `406`, `422`, `500`, `503`.

**Why the two endpoints differ, and why the difference is the reason the read exists at all.** The pulls **list** the scan reads returns `Pull Request Simple`, which carries `merged_at` but **no `merged`** (§R12.2) — so a closed pull on that list cannot be told from a merged one — and it carries no closed rows at all, because the list is filtered `state=open`. The single-pull object is therefore **the only row that can answer *merged* for a concluded pull**. The issues **list** is filtered `state=open` for the same reason, and the single-issue object is the only row that can answer `closed` / `state_reason` / `closed_at`. **Neither terminal fact is reachable from a feed the scan already reads**, which is why FR-102's one exception exists and why it is written as an exception rather than absorbed into the zero-cost claim.

**Both reads are paged to one page and nothing more.** Neither endpoint returns an array, so there is no page walk to bound and no pagination-truncation concept to add — the per-item events read's bound (§R14.10) is the precedent for "one page, and the behaviour at the bound is what the spec fixes", and here the bound is structural. `per_page` is not sent; the response is one object.

---

## R13. The host surface a follow-up is delivered through (added 2026-10-09 for FR-104 – FR-105, GitHub issue #13)

The delivery half rests on the host contract. Two sources were read on **2026-10-09**: the **live Host API documentation** (`https://docs.openchamber.dev/sdk/host/`) and this repository's own use of the pinned SDK. The session-addressing model — `host.prompt` addresses **only the currently-open session**, `host.openSession` is a navigation — was verified across the complete published SDK range by the dispatching PM before this amendment was written and is **not re-derived here**; what is added is the field-level detail the delivery rules are written against, and the in-repo precedent that the sequence is deliverable.

1. **`host.prompt({ text, send? })`** — the docs' methods table: *"write into, or send on, the current session. Returns `{ sent }`. Sending needs the `prompt` capability."* The lifecycle section is exact: *"Without `send`, `prompt` replaces the chat box text. With `send: true` it sends the message using the model and agent the user has selected. The extension never picks them. No open session is `NO_SESSION`. Sending while the session is busy is `SESSION_BUSY`; **writing into the box works while busy**."* Three consequences, each a premise of a requirement: the send is the only delivery action; a busy session is a **retryable refusal, not a queue** (FR-105); and the extension never influences which model or agent answers.
2. **Error codes are `HostRequestError` codes** — the docs' error table lists `NO_SESSION` (*"`prompt` or `sessionLink` with no open session"*) and `SESSION_BUSY` (*"`prompt({ send: true })` while the session was busy"*), beside `HOST_UNAVAILABLE` (no window, outside OpenChamber, or after `dispose()`), `HOST_TIMEOUT` (no answer in 20 s), `HOST_REJECTED`, `DISABLED` (the user paused the extension), and `NOT_GRANTED` (capability not approved). Every one of these is a **failed attempt with a recorded reason** under FR-105; none is a silent skip.
3. **The current session is already a known fact** — the ready context carries `session: { id, title, busy } | null` (*"`busy` is the live status"*), and `onSession` *"replays the latest value when you subscribe late, then keeps firing as it changes."* So the "is the target already the current session?" check reads a fact the panel already receives, with **no new host call**.
4. **`host.openSession(sessionId)` is a navigation** — the docs name it once, as *"an explicit transition from a card to its chat"*; the PM's verification established that it navigates the host and closes the panel. The text bounds on the chat-box writers are **1 to 16,000 characters after trim** (`compose`'s documented bound, the same surface `prompt` writes into), which is why FR-104's ≤12,000-character follow-up budget sits inside it with margin.
5. **In-repo precedent that the navigation is survivable** — `verifySessionAgent` (`src/agent-verify.ts:249-279`) subscribes `onSession` **first**, then calls `host.openSession`, then resolves on the first snapshot whose `id` matches, all inside one bounded budget. The shipped agent read-back therefore proves the panel's code runs long enough **after** the navigation to receive a host event — which is what makes an `openSession` → `prompt` sequence deliverable at all. The tryDispatch contract in `src/relay-attempt.ts` (`compose + measure ──▶ host.startSession() returns ──▶ WRITE attempt record ──▶ POST result ──▶ 2xx ──▶ acknowledged`) is the order FR-104 copies — with one difference stated as a requirement: for a follow-up the **navigation intent is written durably before the call**, because the call itself moves the operator's view and closes the panel.
6. **`PanelHost` is a `Pick<HostClient, …>`** at `src/session.ts:34-55` — *"adding a method here is a deliberate, reviewable act."* It already carries `openSession`, `onSession`, `onReady`, `startSession`; it does **not** carry `prompt`. Adding `'prompt'` is the one new host call site in this amendment and it uses the **already-declared** `prompt` capability — no manifest change, no install-time approval change (AGENTS.md invariant 3).

**What this does not establish**, stated plainly: **how long the panel survives after the navigation** is undocumented, and nothing guarantees `prompt`'s promise resolves before the frame unmounts. The design therefore never assumes a delivered prompt: the intent to navigate is recorded durably **before** the call (FR-104), and a delivery whose result never lands is an operator-resolved question rather than an automatic re-send — the failure direction is a missing follow-up the operator must confirm, never a duplicate one.

---

## R14. What this codebase already does that the amendment changes or rides (added 2026-10-09 for FR-100 – FR-107, GitHub issue #13)

Read in the shipped source on 2026-10-09, with the file and line each claim can be re-checked against. **No claim here is about GitHub; §R12 carries those.**

### R14.1 The disjoint-session problem is real, and it is two lines

`service/poll/runs-join.ts:449` — the enqueue pass joins a run when it is non-terminal **or** carries a recorded session, and the subject keys match:

```ts
function findJoinableRun(
    runs: readonly Run[],
    subjectKey: string,
): { readonly index: number; readonly open: Run } | undefined {
    for (const [index, run] of runs.entries()) {
        if (subjectKeyOfRun(run) === subjectKey && (!isTerminalRun(run) || run.session !== null)) {
            return { index, open: run };
        }
    }

    return undefined;
}
```

*(The predicate this amendment corrected read `!isTerminalRun(run)` alone and sat at `runs-join.ts:350` before the module grew. The second arm — `run.session !== null` — is FR-100's fix.)*

`service/poll/runs-document.ts:153-155` — `isTerminalRun(run)` is `run.state === 'dispatched' || run.state === 'dead-lettered'`:

```ts
export function isTerminalRun(run: Run): boolean {
    return run.state === 'dispatched' || run.state === 'dead-lettered';
}
```

So the moment a run dispatches — the moment the issue's lifecycle question begins — every further delivery for that subject fell through to ordinal+1 and a **second, disjoint session**. FR-100 is written against exactly these lines, and the fix is one predicate: join the subject's run when it holds a recorded session (`run.session !== null`), not only when it is non-terminal.

**The recorded-session predicate is *narrower* than the claim route's, and the divergence is recorded because its direction matters.** The join and the tracked-subject view test `run.session !== null` (`runs-join.ts:449`; `tracking.ts:168-171`, whose own comment names FR-100 and nothing else), while the claim route tests the broader `runHistoryIndicatesSession` (`service/poll/runs-document.ts:158-161`), which also accepts an attempt whose outcome was `dispatched` or whose `sessionId` is non-null:

```ts
export function runHistoryIndicatesSession(run: Run): boolean {
    return run.session !== null || run.attempts.some((attempt) =>
        attempt.outcome === 'dispatched' || attempt.sessionId !== null);
}
```

**The two halves disagree in the dangerous direction if the divergence is ever reachable.** A hand-edited store can produce a run whose `session` is `null` while an attempt records a dispatched session — the shape `runHistoryIndicatesSession` exists to catch and `run.session !== null` does not. On such a run the **claim refuses** (correct — it must not offer a second dispatch authorization) while the **join opens a new ordinal** (a second session for work that already had one). The whole amendment's correctness therefore rests on the store invariant that makes the divergence unreachable: `runHistoryIndicatesSession`'s broader arm is the one `runs-parse.ts`'s session-history gate (`:219-221`) already quarantines the document over, so a conforming stored document cannot hold that shape at all. That is why the narrower predicate is sound *here* and why the divergence is recorded rather than tidied away: it is only evidence of a hand-edited store, and the honest statement is that the two predicates are different, not that they are the same.

### R14.2 The ends the amendment builds on, already durable

- **The session is already persisted**: `Run.session: SessionRef | null` carries `sessionId`, `attachmentId`, `dispatchedAt`, `title`, `sourceUrl`, `worktree` (`service/poll/runs-types.ts`), and `DispatchAttempt.sessionId` records it per attempt. **The delivery address a follow-up needs already exists on the run the follow-up joins.**
- **The run's own state cannot express a parked follow-up.** Four shipped transitions and one parser gate, all read on 2026-10-09: `parkRun` returns `null` when `isTerminalRun(run) || run.session !== null` (`service/poll/runs-transitions.ts:149`); `wedgeUnconfirmed` requires `run.state === 'starting' && run.reservation !== null && run.session === null` (`:180`); `expireLease` refuses a run whose history records a session (`:118`); and `sessionHistoryHolds` quarantines any run whose attempts record a dispatched session while `state !== 'dispatched'`, and any run whose `session` is non-null while `state !== 'dispatched'` (`service/poll/runs-parse.ts:219-221`). **So a follow-up's parked reason cannot ride the run's `state`** — it rides beside the run's session, in the vocabulary the run already carries (`blocked:<reason>`'s reason words, FR-037's dead-letter posture). This is the code premise that killed the first draft's `FollowUpEntry` and is the reason FR-105 says "no new state name is minted".
- **The queue's dedupe already suppresses a repeated observation**: `enqueueEvents` appends "with delivery-id deduplication and one atomic run/queue chain" (`service/poll/events.ts:440`), and the id is built by `buildEventId` (`service/poll/events-write.ts:215-229`) from a base plus an optional discriminator whose family is already `~mention~<commentId>`, the fixed `~mention~body`, and `~review` (`discriminatorOf`, `:240-255`). **The base and every existing discriminator are byte-identical** — `events-write.ts`'s own doc says so — so FR-101 adds two forms and changes none.
- **The head-SHA seed's source is an existing row member**: `QueuedEvent.headSha: string | null` (`service/poll/events-parse.ts:72`), written only by the `review` trigger (`headShaOf`, `service/poll/events-write.ts:265-267` → `null` for the other two). The run's first source reference names the delivery id, so the establishing cycle reaches the seed through the existing event queue with **no new file and no new run-document member** beyond the one that holds the seed.
- **The attempt-order contract already exists**: `src/relay-attempt.ts`'s module doc (§R13.5 above) and `src/relay.ts`'s four tick rules (nothing dispatched that was not claimed; no `startSession` after any refusal; the handled list keyed `correlationId#attempt`; a partial claim answer is not "everything waiting"). FR-104 reuses that order for follow-ups rather than inventing a second one.
- **The bounded context and its budget floor already exist**: `src/context-blocks.ts` renders one bounded, delimiter-defused excerpt per source under `BEGIN_UNTRUSTED` / `END_UNTRUSTED` with a 600-character per-source bound, `src/session.ts`'s `buildBoundedContext` composes the frame against `CONTEXT_MAX_CHARS = 12_000`, and `src/relay-attempt.ts`'s `budgetFloorProblem` measures the composition **before** the host call and refuses rather than truncates. FR-104 reuses all three unchanged — the follow-up's composition is the same machinery with a different frame.
- **The bounded retry ladder is the service's existing configuration**: `retryMaxAttempts` (default 5), `retryBaseMs` (5,000), `retryMaxMs` (60,000) at `service/config.ts:188-190`, bounded at `:159-161`. FR-105 reuses them; no ladder is added.
- **The author judgement is the existing predicate, and the follow-up branch is the only one that would not have reached it.** `isBotAuthor` at `service/poll/attribution.ts:67` and `isAttributableAuthor` at `:87` — with the docstring at `:74-82` naming FR-016 as the clause they fail closed under — are the **one** pair of judgements the product already applies to mention authorship, and `poller-entries.ts:277-302` (`readCommentEntry`, capturing `authorLogin` at `:288` and `authorType` at `:299`) shows the issue-comment reader already feeds exactly that filter. The mention path calls the predicate *inside* `isMentionComment` (`service/poll/triggers.ts:108-113`), **before** the mention-body check — so a follow-up comment that does not mention the bound account never passes through it, which is the whole of the gap. FR-102 therefore states the reuse as one clause rather than deriving a bot rule: the fix is an existing predicate called by a new detection branch, not a new gate.

### R14.3 The configuration-field count is a real constraint

`service/config.ts:58-125` — `ServiceConfig` is **twelve** fields (ten numeric/enum, `expectedAgent`, `startingPrompt`), and `spec.md` records 006 FR-010's/FR-084's count of twelve as a deliberate, load-bearing number. **This amendment adds no configuration field at all** — not even a declared constant, because there is no tracked-set index to bound (FR-107).

### R14.4 Two test surfaces pin what this amendment adds — and neither moves

Both were re-examined against the rewrite rather than assumed:

- **`tests/current-project-default.test.ts:270-303`** pins `ROUTE_PATHS` (the shipped route table, in declaration order — no follow-up operation among them) and `CONTRACT_FILES` (the six files under `specs/002-agent-event-extension/contracts/`). **The rewrite adds no route and no contract file**: `follow-up-lifecycle.md` is deleted, which *restores* this pin — the first draft had left it failing, because the file's presence made the directory listing seven entries against a six-entry enumeration. The two contracts it lists and this amendment amends (`events-carry-forward.md`, `panel-service.md`) are amended in content only, so the listing still matches.
- **`tests/prose-budget.test.ts:193`** pins `REDUCED.walkthrough = 76`, the prose-line count of `specs/002-agent-event-extension/quickstart.md`. Measured against the shipped document's own measure (markup-stripped lines carrying a word, fence delimiters excluded): `HEAD` of `quickstart.md` measures **73** and the first draft's §10 took it to **98**. The rewrite's §10 is cut to the operator-facing core; **the pin moved by the number of lines §10 keeps**, and that edit is the one constant change this wave made — it cannot be avoided while the walkthrough says anything about this feature, and it is named here rather than left to be discovered.

**No contract fixture is read as data by a suite**: verified by grep — `tests/disclaimer.test.ts` and `tests/config-authority.test.ts` read `contracts/token-handoff.md` as data; every other `contracts/` citation in the suites is a comment pointer. So the amended event contract **breaks no fixture**, and `token-handoff.md` is untouched.

### R14.5 The panel's serialization is already one-host-action-at-a-time

`src/relay.ts`'s `pollRelay` guards on `rt.state.relay.inFlight`, and `dispatchClaimedRun` on `rt.state.relay.dispatching` / `rt.state.busy` with a per-attempt handled key (`src/relay.ts:144-148`); `agent-verify.ts`'s read-back runs **detached** (`rt.pendingVerifications`) so a 15-second read-back never holds the dispatch slot. FR-104 extends that same serialization to follow-up delivery: the delivery joins the existing one-host-action-at-a-time gate rather than opening a second concurrent host-call path, which is also the constitution-VII reading — the host's session scheduling stays the host's.

### R14.6 The follow-up rides **one additive member on the runs-history read** — and why that read, not the claim and not `/v1/deliveries`

The Gate 1 challenge found the rewrite's mechanism-neutral sentence ("a read the panel already performs") to be **false as written**, and it was — so the read is now decided, here, with the evidence. All four of the challenger's premises were re-verified in the tree:

- **The runs read projects no excerpt.** `service/poll/run-history-project.ts:187-188` says so on the member itself — *"Every retained reference, in join order; excerpts never projected"* — and `HistoryReference` is `SourceReference` verbatim (`:61`).
- **`SourceReference` has no content member.** `service/poll/runs-types.ts:36-71`: `deliveryId`, `kind`, `origin`, `sourceUrl`, `detectedAt`, `presentAtAuthorization`, `actorLogin?`, `actorAttribution?`. Nothing carries text.
- **The claim route refuses a session-carrying run.** `service/poll/claim.ts:234` and `service/poll/runs-transitions.ts:73`. **This is correct and load-bearing** — it is one of the two things that stops a second disjoint session — and it is why a follow-up is never a claim.
- **`GET /v1/deliveries` has zero callers.** `grep -rn "v1/deliveries\|DELIVERIES" src tests --include="*.ts"` returns nothing. It is a route the panel never adopted.

So no existing read carries both the follow-up's text and its target session, and the decision is between adding a member and adopting a dead route. **The decision is the member**, for four reasons, each verified rather than argued:

1. **The panel already performs the read, on its own clock.** `src/dispatches.ts:53` (`loadDispatches`) polls `GET /v1/events` — the path at `src/service-calls.ts:75` — and `src/relay.ts` calls it after every dispatch report (M8). It is not a read the panel *could* make; it is one it makes.
2. **The read already carries the target.** `RunHistoryRow.session` (`run-history-project.ts:196`, `sessionViewOf` at `:426-436`) projects `sessionId`, `attachmentId`, `dispatchedAt`. The follow-up's text and the session it goes to therefore ride **one row**, and the member adds no second copy of the session id.
3. **The panel's DTO already mirrors the row member-for-member.** `src/dispatches-service.ts`'s `RunRow` carries `session: RunSession | null` (`:107`) and `headSha` (`:131`) beside every other projected member. Extending the projection and its mirror is one edit on each side — no new panel reader, no new fail-closed parse, no new poll.
4. **Adopting `/v1/deliveries` costs strictly more.** A dead route adopted by the panel needs a new reader, a new DTO, a new parser and a new tick: four new surfaces where the member needs one. The claim route is not a candidate at all, for the reason above.

**The claim route being barred does not block the follow-up**, and the two facts belong together: a lease exists to authorize `host.startSession()` once, and a follow-up authorizes nothing — it is a prompt into a session that already exists. The runs-history read leases nothing and claims nothing (`events.ts`' history route is read-only), which is exactly the right instrument for an action that must not consume a dispatch authorization. **No route is added, no path is added, and no existing member changes shape** — invariant 10 is observed because an additive member on an existing `/v1` read is not a renaming (FR-104, FR-107).

**The member, as specified**: `followUps` — absentable, a bounded list in detection order — the oldest **twenty** follow-up queue rows **delivered or not**, the service holding no record of a delivery and so unable to prune one, while the panel's own durable record — the only such record, in host storage — decides what is still outstanding; and **absent only when the run has no follow-up row at all, which is the ordinary case**. Each entry: `deliveryId` (the deterministic `evt-…~followup~…` id — the relay's handled key and the at-most-once key), `kind` (`'comment' | 'head'`, which of the two), `excerpt` (the bounded, delimiter-defused text the panel composes with), `actorLogin`, `detectedAt`, `sourceUrl`, and for a `head` entry only `fromHeadSha` / `headSha` so the message names from → to.

**A follow-up is not a source reference on the run**, and this is load-bearing rather than tidy: 003's actor gate classifies from `sourceReferences` exclusively, so a follow-up that joined that list would be re-judged by the allow-list on the run's next authorization. It rides the projection member and the queue row, never the run's reference list.

**Where the walk opens is the owed record's own id, and the read's start is not a fallback for it.**
The window's opening is chosen from the panel's own record — `followUpWindowOpening`
(`src/follow-up.ts:342`) returns the **owed record's own id** the moment it meets one the relay still
owes a session (a record that is **neither delivered nor parked**: mid-ladder in its backoff, or
returned to due by an operator re-offer), and otherwise the **newest delivered id**, or `null` when the
record holds neither — in which case the read carries no parameter at all. The shaping reason is that
the projection's bound counts **rows, not positions**: `MAX_PROJECTED_FOLLOW_UPS`
(`service/poll/run-history-project.ts:149`) projects a run's **oldest twenty** follow-up rows in
detection order, **delivered or not** — its doc calls it *"a window that walks, not a wall that caps"*
— and `windowStartOf` (`run-history-project.ts:549`) turns the `followUpsFrom` value into an index
**inside the run's own list** (`0` for an absent or unmatched id, the found index otherwise). So
opening at the **start** maps to index `0`, which reaches only the first twenty rows: an owed follow-up
whose *detection* position is 21 or later sits behind them and is projected by nobody — never retried,
never parked, reported as waiting forever. Opening **at** the owed record's own id is a position in
this run's list whatever its number, so it is in range by construction; a window that opens early costs
a denser page, one that opens late strands the follow-up for good. This is the `9cafed7` correction —
resetting the opening to the start was the pre-fix behaviour, and it was a regression for the owed
shape and a silent no-op for the re-offer — and it is why the re-offer appends the re-offered record
**behind** its delivered sibling (`reofferFollowUpRecords`, `src/dispatch-record.ts`): an owed record
left *before* a delivered one would put the read's opening past it, and the relay would never see the
re-offered follow-up again.

### R14.7 What was deleted from the first draft's §R12 – §R14, and why

Recorded so the next reader does not re-derive it, and so no citation to a deleted finding survives:

| Deleted | Why it no longer applies |
| --- | --- |
| §R12.2b (the review object's three endpoint quirks) | Their two detection kinds were cut: each is one added GitHub read per tracked pull, and the product owner cut review comments and whole review submissions on 2026-10-09 |
| §R12.5's **first** content ("what the list feeds cannot answer — why the per-item terminal read exists", and its per-subject-per-cycle read) | The number **§R12.5** is **reused** by the second draft with different content — the two single-item terminal reads FR-102's exception admits, read on 2026-10-09 against the GitHub REST docs. The per-subject-per-cycle read the old §R12.5 described stays cut and is recorded as the rejected alternative in §R12.4; the limit it described (both list feeds are `state=open`) is still true and is restated in §R12.2 |
| §R13's single-use delivery-token premise and its `GET /v1/follow-ups` mint step | The three new HTTP operations were cut; there is no lease and no token for a follow-up, so the claim's existing single-use **dispatch** token is untouched and no second authorization artifact exists |
| §R14.3's "the tracking maximum is a declared constant, not a configuration field" | The per-account cap was cut with the `tracking.json` store; there is no tracked-set index to bound, so the twelve-field count is unchanged for a simpler reason |
| §R14.6's "store follow-up state as members on the `Run` row" rejection and its eviction-tail argument | Reversed by the reduction: follow-up state now **does** ride the run, and the eviction argument does not apply because the seed is one absentable member and the park reason rides beside the session, not as accumulating per-follow-up rows |
| §R14.6's "reuse the run's dispatch lease/token" rejection | There is no follow-up token to mint, so the question does not arise |

### R14.8 Alternatives considered and rejected (in-repo)

| Alternative | Rejected because |
| --- | --- |
| A separate follow-up branch in the enqueue pass, ahead of the join | Two coalescing rules that can disagree — the shape FR-023's one-rescan-mechanism clause exists to prevent. The correction is one predicate in the join (FR-100) |
| A second relay loop for follow-ups | Two timers issuing host calls is two schedulers for one host; the existing relay's serialization (R14.5) is extended instead |
| Storing the follow-up's text on the run or in the audit row | The trail carries a fingerprint, a length, and counts (FR-104); the composed message exists only inside the attempt the panel is making. The row's existing bounded excerpt is the text's one home |
| Waiting indefinitely for a busy session to become free | Constitution VII: the host owns session scheduling, and an unbounded wait is Mecha Turk reimplementing the harness's own queue. FR-105 retries within the declared bound and parks |
| A per-follow-up approval gate | The product owner settled it: judged exactly as `start_work` is judged under FR-027, one clause, FR-027's own text untouched (FR-104) |


### R14.9 The follow-up row's `kind` and `subjectType` reuse the closed unions, and the explicit `subjectType` is mandatory

Gate 1's second finding, both halves verified and decided:

- **`EventKind` is a closed three-value union and a follow-up does not widen it.** `service/poll/events-parse.ts:32` (`'assignment' | 'mention' | 'review'`); the queue row's parser validates `kind` against it, and `service/poll/runs-parts-parse.ts:47-49` (`isEventKind`) validates a **reference's** kind against the same set. A fourth value would be **refused by both shipped parsers** — quarantining `events.json` and `runs.json` rather than failing open — which is the whole reason the reuse is the honest choice rather than the lazy one. The row carries **`'mention'`** for an issue comment and **`'review'`** for a head-SHA change, each naming the feed the detection rides; the `~followup~…` discriminator carries the role, so the kind records *which surface* the row came from and never claims that anyone mentioned the account.
- **`subjectTypeOf`'s fallback is the correctness defect, and the fix is on the writer.** `service/poll/events-parse.ts:606-607`: `delivery.subjectType ?? (delivery.kind === 'review' ? 'pull_request' : 'issue')` — a review trigger is the only detection that *knows* it is about a pull, so **everything else reads as an issue**. A head-SHA follow-up on a tracked pull is exactly that case, so a row relying on the fallback is misread as an issue. `QueuedEvent.subjectType` is already an **absentable** member (`events-parse.ts:93`, and the absentable set at `:178`), so the fix costs no schema change: **follow-up detection MUST write `subjectType` explicitly from the tracked subject**, and `subjectTypeOf` itself needs **no change**, because a conforming row never reaches its fallback. A row that omitted it would be misread — which is why the write is a requirement, not a preference (FR-101).

### R14.10 The lazy terminal read: the precedent, the fields, the classification, and the end machinery already in the tree (added 2026-10-09, second draft)

Every claim below was re-read in the shipped source on **2026-10-09** with the file and line it can be checked against, **before** FR-102's exception and FR-106's source clause were written. **No claim here is about GitHub; §R12.5 carries those.**

**1. The per-item read precedent exists, and it is the actor read.** `service/poll/poller-github.ts:318-346` (`itemEventsList`) is the shipped single-item page walk: it calls `readOnePage` in a `for` loop over `ITEM_EVENT_MAX_PAGES`, sets `page` and `per_page` on the URL each iteration, returns the classified failure the moment a page fails, and returns `{ kind: 'ok', events, exhausted: true }` when the bound is reached without a page that ends it. The terminal read the amendment needs is **strictly simpler** — one object, no array, no walk, no `exhausted` state — so it inherits the precedent's discipline (one request, the shared transport, the shared failure vocabulary) without inheriting its bound. `ITEM_EVENT_MAX_PAGES` is **2** (`poller-events.ts:75`), and the module doc is explicit that the bound is a **planning constant** while what the specification fixes is *the behaviour at the bound*.

**2. Timeouts, retries, and classification are shared, not re-derived.** Every request goes through `poller-transport.ts`'s `requestPage` (`:278-324`), which sends `AbortSignal.timeout(GITHUB_TIMEOUT_MS)` — **15,000 ms**, `service/github.ts:39` — retries every non-`auth-failed` class up to `retryMaxAttempts` **including the first**, honours `retry-after` for a rate limit, and reports each wait **before** it starts. `classifyOutcome` (`poller-transport.ts:209-220`) is the whole vocabulary a per-item answer can carry: **`401` and `404` → `auth-failed`**; `403`/`429` *with* rate-limit headers → `rate-limited`; everything else → `unavailable` with `detail: 'offline' | 'timeout' | 'upstream'`. **Upstream text never escapes the module** — a failure is a class, never a body — so a GitHub message cannot reach a log, an audit row, or the panel. A `301` is followed by `fetch` itself and never surfaces as its own case; a `410` falls through to `unavailable`/`upstream`.

**3. What an unreadable answer must mean, and the shipped precedent that says so.** `resolveCandidateActor` (`poller-events.ts:453-497`) draws the line this amendment copies: a read that **works** but has nothing honest to say is a **recorded refusal** (`no-qualifying-event`, `unreadable-actor`, `bot-actor`, or `exhausted`) that produces **no event this cycle**; a read that **fails** escapes as `failed` and the caller ends the branch — `triggers-review.ts:149-151` and `triggers-assignment.ts:139-141` both `return { ok: false, failure }`, `loop.ts:372` turns it into the binding's `ScanSkip`, and `saveBindingScanState` (`loop.ts:639-681`) **retains** the checkpoint a scan that did not complete already had and writes the class into `lastError`. **Dropping only the candidate would advance the window past work nobody judged** — the docblock at `poller-events.ts:443-449` says so in as many words — and that is why FR-106's unreadable answer is a *scan* failure with a **retained** checkpoint rather than a silent per-subject skip: retention is what makes the skip a one-cycle delay and not a loss. FR-051's self-healing argument carries over unchanged, because the window overlaps.

**4. The terminal fields are already on the entries the readers produce.** `service/poll/poller-entries.ts` carries both sets, added by this amendment's implementation and already shipped: `PollIssue.closedAt?: string | null` (`:58`, documented as *read for FR-106's end-of-tracking judgement*), `PollIssue.stateReason?: string | null` (`:66`), `PollPull.merged?: boolean` (`:136`, *absentable on read, and `false` is the reading of an absent member because it is the direction that can only ever fail to end tracking and never end it on a guess*), and `PollPull.mergedAt?: string | null` (`:138`). The readers populate them: `readIssueEntry` writes `closedAt` / `stateReason` at `:267-268` and `readPullEntry` writes `merged` (`record.merged === true`, so an absent member reads `false`) and `mergedAt` at `:341-342`. **These four members are read from the list rows** and are therefore sufficient for the end machinery but insufficient for observing an end in production — §R12.2 / §R12.5. The terminal read arrives as **one object**, so it needs a one-object reader beside `readIssueEntry` / `readPullEntry`, not a page reader.

**5. The end machinery is complete and unused, for want of an observation.** `service/poll/tracking.ts` already carries all of it: `TrackedSubject` with `lastHeadSha` / `actorLogin` / `actorAttribution` (`:41-61`); the `TerminalFact` closed union `'closed' | 'merged' | 'closed-unmerged'` with its own doc recording that the pull object carries no `state_reason` and the fact is therefore *derived rather than quoted* (`:63-71`); `TrackingEnd` with `subjectKey`, `correlationId`, `subjectType`, `subjectNumber`, `fact`, `state`, `stateReason`, `at` (`:74-91`); `trackedSubjectsOf` reading FR-100's recorded-session predicate (`:160-184`, whose comment at `:168-170` names FR-100 and nothing else); `withoutEnded`, which drops ended subjects from the view **before** the detectors run (`:198-210`); `trackedIssueEnds` (`:225-263`), which skips any row whose `state !== 'closed'` (`:236`); `trackedPullEnds` (`:295-334`) and `terminalPullFact` (`:277-283`), which reads `merged === true` as `'merged'` and `state === 'closed'` as `'closed-unmerged'`; and `observedHeadSeeds` (`:343-363`). Both call sites are wired: `triggers.ts:439-447` collects the issue ends and filters the view, `triggers-review.ts:158-162` does the same for pulls, and `loop.ts:483` records them. **The reason none of it can fire is one line of each reader, and it is not a bug**: the two list feeds send `state=open` (`poller-github.ts:226,276`), so `trackedIssueEnds`' `state !== 'closed'` guard never passes and `terminalPullFact` never sees a closed row. The machinery is right; the observation is missing. The lazy read supplies it, and it must be issued **before** the subject's follow-up is enqueued so that a terminal answer drops the row rather than retracting one.

**6. The end row is already written, and it is one of only two writable service rows.** `loop.ts:253-292`'s `recordTrackingEnds` appends `tracking.ended` per subject with `entity: { kind: 'run', id: correlationId }`, `reason`, and details `{ bindingId, subjectKey, subjectType, subjectNumber, kind, state, reason?, closedAt? | mergedAt? }`, best-effort with a logged failure. `service/poll/events-enqueue-audit.ts:117` writes `follow_up.observed` with `excerptFingerprint` / `excerptLength` / `kind` / `runCorrelationId` (`followUpFingerprint` at `:34-36`, a 24-hex-character SHA-256 prefix — the fingerprint is the reason the row holds no text). **There is no third and fourth.** `appendAudit` is service-side (`service/audit.ts:457`) and `service/routes/audit.ts:169-172` is `method: 'GET'` — `/v1/audit` is read-only — and FR-104/FR-107 forbid adding a route. So the delivery outcomes the first draft listed for FR-035 cannot be written by anyone: the panel's own durable record carries them, `src/dispatch-record.ts`'s `FollowUpDeliveryRecord` (`:144-172`) with `delivered`, `reason` (`FollowUpFailure`, the closed union at `:131-141`) and `parked`, in the `mecha-turk:dispatches` document. That is the panel's existing home for a dispatch attempt's own outcome too, and it is the honest home for these.

**7. The reachability check that produced correction 2.** `service/poll/runs-parse.ts:219-221` quarantines any run whose attempts record a dispatched session while `state !== 'dispatched'`, and any run whose `session` is non-null while `state !== 'dispatched'` — and `runs-parse.ts:216-218` refuses an attempt carrying a `sessionId` whose outcome is not `dispatched`. Nothing in FR-100, FR-103 or FR-105 mints a state or a member that could un-join a session-carrying run (FR-103 permits exactly one new run-row member, the seed, and FR-105 explicitly mints none). **So "after the end a new trigger opens the subject's next ordinal" is unreachable by construction**, and the shipped suite already asserts the reachable behaviour rather than the promised one — `tests/follow-up-lifecycle.test.ts:1449-1457` asserts the mention joins the session-carrying run and `ordinary.runs.map((run) => run.ordinal)` is `[0]`. The first draft's reading is corrected in FR-106 rather than left standing beside it.

**8. The green suite does not disprove the gap, and that is the point.** The suite as it stood **before `F-10` rewrote it** asserted the end by injecting `state: 'closed'` into the **list** fixture (`fixtureIssue({ state: 'closed', stateReason: 'completed', closedAt: STAMP })`) at `tests/follow-up-lifecycle.test.ts:1070-1101`, and `:1104-1139` injected `merged: true, state: 'closed'` into the pulls fixture. Both shapes are ones the real endpoints the scan calls **never return**, because both send `state=open`. The suite was green, the capability was unreachable, and a fixture that models a shape the provider does not send is exactly how that happens — which is why the second draft's fix is a *source* change (the object endpoint) and not a fixture change, and why AC-049's request-count proof is now a **measurement** of the added read rather than an argument that none exists. **The delivered proofs read the item's own endpoint instead** (`:1261-1302` for an issue closed as completed, `:1304-1355` for a pull merged and one closed unmerged, `:1502-1524` for the `404` stop), so no shipped assertion rests on a list shape the provider does not send.


## Wider event detection research (2026-10-20)

**Status**: research only. Recorded here at v1.20.0 when the delivery directories were consolidated; no requirement lives in this section.
**Scope**: the deferred detection groups named in `spec.md` `## Out of Scope` — review submission/changes-requested on the account's own PR, the three new trigger kinds (opened, reopened, labeled), and surfaces outside the assignment/review/mention shape.
**Anchor**: this specification's §K (the tracking lifecycle) and §L (the wider detection).

---

### Summary

| Signal | Endpoint | Added requests per repo-cycle · per hour at 10 repos / 60 s | Shape | New setting? | New id? | Verdict | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **2a. Review changes-requested** (own PR) | `GET /repos/{o}/{r}/pulls/{n}/reviews` | 0 quiet; 1 per own PR whose `updated_at` is in the window (read the **last** page first) · ≤ ~50/h. Forces the pulls list only when `reviewRequest` is off · +600/h | Trigger; follow-up when the PR is tracked | `triggers.reviewSubmitted` | `~review~submitted~<reviewId>`; `~followup~review-submitted~<reviewId>` | **build-with-caveat** | M |
| **2b. Review approved** | same read | 0 extra (same rows) | Trigger or nothing | same toggle, or a second one | same | **defer** | S once 2a exists |
| **2c. Review commented** | same read | 0 extra | Follow-up on a tracked PR only | none | same follow-up tail | **defer** | S |
| **2d. Review dismissed** | `GET /repos/{o}/{r}/issues/{n}/events` | 1 per own PR with activity · ≤ ~50/h (a second read per candidate) | Notification; at most a follow-up | none | `~review~dismissed~<eventId>` | **defer** | S–M |
| **3a. Newly opened** | `GET /repos/{o}/{r}/issues` (already read) | 0 when the issues list is read; +600/h when it is the only reason to read | Trigger | `triggers.opened` + a `labels[]` filter | `~opened` | **build-with-caveat** | M |
| **3b. Reopened** | `GET /repos/{o}/{r}/issues/{n}/events` | 0 quiet **only** with a `state_reason` prefilter; otherwise 1 per updated open item · up to ~12,000/h | Trigger — but undeliverable today | `triggers.reopened` | `~reopened~<eventId>` | **defer** (run-model decision) | M |
| **3c. Labeled** | `GET /repos/{o}/{r}/issues/{n}/events` | 0 quiet with the client-side `labels[]` filter; 1 per candidate · ≤ ~50/h with a dedicated label | Trigger, follow-up when tracked | `triggers.labeled` + `labels[]` | `~labeled~<eventId>` | **build-with-caveat** | L |
| **6a. CI / checks** | `GET /repos/{o}/{r}/commits/{sha}/check-runs` (+ legacy `/status`) | 0 quiet if gated on a head movement; 1 per movement · ≤ ~50/h. Every cycle costs 60 × tracked PRs · ~1,800/h | Follow-up on a tracked PR | `triggers.checks` | `~followup~checks~<sha>~<conclusion>` | **build-with-caveat** | M |
| **6b. Commit comments** | `GET /repos/{o}/{r}/comments` | 1 repo-wide + pages every cycle · 600+/h; plus 1 per commented commit for a PR lookup | Neither (no issue/PR number) | — | — | **reject** | S to price |
| **6c. Releases** | `GET /repos/{o}/{r}/releases` | 1 repo-wide per cycle · 600/h | Notification outside the run model | — | — | **reject** | S |
| **6d. Discussions** | GraphQL `repository.discussions` | 1 query per repo per cycle · 600 queries/h = 600–5,400 points/h | Trigger/follow-up, but needs a third subject type | `triggers.discussion` | `~discussion~<number>~…` | **reject** | L |
| **6e. Wiki** | none; a separate git repo | Not an HTTP budget: a git clone/fetch | Neither | — | — | **reject** | S |

Effort: **S** ≤ 1 day, **M** 2–3 days, **L** a week or more, by files and surfaces touched.

---

### Cost model (shared by every row)

- **Cycle arithmetic.** 10 repositories at 60 s = **600 binding-cycles per hour**. One added repository-wide list read per binding per cycle is therefore **600 requests/hour** — the entire floor of NFR-003's 600–1,500 design point, before any per-candidate read. Two such reads exceed it.
- **The baseline is already multi-feed.** With all three current toggles on, a binding already makes four list reads per cycle (issues, issue comments, review comments, pulls) — 2,400 requests/hour at 10 repos. NFR-003's 600–1,500 only holds when not every binding turns every trigger on. The marginal read is what matters, not the absolute.
- **Conditional requests are not implemented.** `requestHeaders` (`service/github.ts:153`) sends authorization, accept, API version and user-agent only; `service/poll/poller-transport.ts` records no `ETag`/`Last-Modified`. FR-021 *permits* conditional requests but nothing sends `If-None-Match`, so **a quiet cycle still costs a full request** for every feed it lists.
- **Therefore the only cheap pattern is candidate-gated.** A read issued per candidate costs **zero** when the candidate set is empty. A new repository-wide feed costs 600/h whether or not anything happened. Every recommendation below prefers the former.
- **Page caps.** 002 FR-020 caps `per_page` at 30. Each list can cost `ceil(items-in-window / 30)` requests; a 10-minute overlap usually fits one page. The per-item reads (`issues/{n}/events`, `pulls/{n}/reviews`) are `per_page`-bounded walks with their own bounds; price one page plus any overflow.
- **Search has a separate bucket** (30 requests/min authenticated, `/search/*`), but does not replace the per-PR review read and adds an indexing-lag risk; see 2.3.
- **GraphQL has a separate 5,000-points/hour bucket** and a 2,000-points/min secondary limit; it would need its own accounting beside the REST budget.

---

### 2. Review submitted / changes requested on the account's own PR

#### 2.1 GitHub surface

**Read one PR's reviews — verified**

- `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, `per_page` (max 100, product cap 30), `page`. **No `since`.** Returns in **chronological order** (oldest first), so a window cannot be selected server-side and the newest rows are on the last page.
- Response (`Pull Request Review`): `id` (int64), `node_id`, `user` (`Simple User` or null — `login`, `type`), `body`, `state` (free string; the API's submitted states are `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`), `html_url`, `pull_request_url`, `submitted_at` (date-time, **absent on a PENDING review** — the docs say pending reviews "do not include the `submitted_at` property"), `commit_id` (string or null), `author_association`.
- Core REST bucket (5,000/h authenticated). OAuth/PAT classic needs `repo` on a private repository; a fine-grained token needs pull-request read. The docs do not enumerate the fine-grained permission name on this page ("unverified", below).
- **Does a `DISMISSED` review appear in this list?** The docs do not enumerate `state` values and do not say. GraphQL's `PullRequestReviewState` enum does carry `DISMISSED` ("A review that has been dismissed"), and the dismiss endpoint returns the review object, but the REST list's representation of a dismissed review is **unverified**. Do not build dismissal on this row.

**Read one item's events — verified, and it does not answer "reviewed"**

- `GET /repos/{owner}/{repo}/issues/{issue_number}/events`, `per_page`, `page` only (**no `since`**). Every pull request is an issue, so this path serves PRs too.
- `review_dismissed` **is** an issue-event type on this endpoint, with `event`, `id`, `actor` (`Simple User`/null), `created_at`, and `dismissed_review.state` (documented values `commented`, `approved`, `changes_requested`), `dismissed_review.review_id`, `dismissed_review.dismissal_message`, `dismissed_review.dismissal_commit_id`.
- **`reviewed` is timeline-only.** The issue-event-types page marks `reviewed` **not supported** in the REST API for issue events and **supported** in the timeline API. The per-item events response schema has no `Reviewed Issue Event` member at all; the timeline schema has `Timeline Reviewed Event` with `id`, `user`, `body`, `state`, `submitted_at`, `commit_id`, `html_url`, `pull_request_url`.
- The timeline endpoint (`GET …/issues/{n}/timeline`) accepts `per_page`, `page`, `exclude` only — **no `since`** (matching FR-051's statement), and carries the same `reviewed` row plus `line_commented` / `commit_commented`.
- **So the claim "issue events returns `reviewed` and `review_dismissed`, and those rows carry the state" is half true**: `review_dismissed` is there and carries the dismissed state; `reviewed` is not. The honest source for a submitted review is the reviews feed (or the timeline, which costs the same one read but returns a much larger, untrusted-text-heavy payload).

**Candidate set — verified fields**

- `GET /repos/{owner}/{repo}/pulls` returns `Pull Request Simple`, which includes `number`, `state`, `title`, `html_url`, `user` (`Simple User`/null), `created_at`, `updated_at`, `closed_at`, `merged_at`, `labels[].name`, `requested_reviewers[].login`, `head.sha`, `head.ref`, `base.ref`, `draft`.
- `PollPull` (`service/poll/poller-entries.ts:111`) deliberately omits `user`, and `readPullEntry` does not read `created_at`, `draft` or `labels`. Adding `authorLogin`/`authorType` (and `draft`) is **no added request**: the same list row carries them. The M7 comment explaining why the author was removed (research §R8) was about *attribution of a review request*, not about authorship as a fact; this use is a different question, and should say so in the module comment rather than reopen that premise.

#### 2.2 Detection shape

The natural shape is **a trigger, with a follow-up arm**, not one or the other:

- The account's own PR usually has **no run**, because runs today start for assignments and review requests, not for the account's own work. A follow-up-only design would therefore deliver almost nothing and look broken.
- But if that PR *is* tracked (it was assigned to the account, or a review was requested on it), the run model refuses a second session: `findJoinableRun` (`service/poll/runs-join.ts:377`) returns a run for the subject while `run.session !== null` even after the run is terminal, and a non-follow-up delivery then only appends a source reference (`joinReference`) — no prompt is delivered. A "trigger" on a tracked PR would be silently absorbed. The detector has `input.tracked` at hand, so it can choose the follow-up row exactly as FR-108 does for a re-requested review.
- Recommended: **trigger when the PR is untracked; follow-up when it is tracked.** That is one detector and two row shapes, not two features.
- What the operator loses with the other choice: follow-up-only loses nearly every own-PR review (no run to join); trigger-only loses feedback on an own PR that already has a session (the row joins by reference and the agent is never told).

#### 2.3 Candidate set and cost

- **Candidate set:** open PRs whose `user.login` is the bound account (case-insensitive) and whose `updated_at` is inside the window. That is the right set *if* a review submission moves the PR's `updated_at` — assumed, and listed under Unverified; the alternative is every open own PR. The pulls list is already read **only when `reviewRequest` is on**; if this new toggle is on and `reviewRequest` is off, the binding must start reading it — **600/h**, the design-point floor. If both are on, the read is shared and the marginal cost is only the reviews read.
- **Reviews read cost — and the ordering trap.** One request per candidate PR, but the endpoint returns **oldest-first** and the shared page walk is capped at **two pages** (`MAX_LIST_PAGES = 2`, `service/poll/poller-transport.ts:28`) with no truncation marker. A two-page walk from page 1 therefore sees the **oldest** 60 reviews; on a PR with more than 60 reviews a new review is invisible, and the window filter discards everything it did see. This is a **correctness** problem, not a budget one. The workable read is: take the **last** page first (needs the response's `Link: rel="last"` header, which the transport does not read today — a small addition), then walk backwards until a page is entirely older than the window. That is usually one request, bounded at two. Do **not** raise the global page cap for this endpoint: FR-020's cap is a product bound, not a per-feed choice. Residual bound to declare: a PR whose newest 30 reviews are all inside the window needs a second page, and a PR with more than 60 in-window reviews is truncated — fail closed and record it. Realistic added load: a handful of own PRs moving per hour → **≤ ~50/h** across 10 repos.
- **The timeline does not solve the ordering trap.** It returns every comment body on the PR, and its ordering is not documented; treating it as a replacement would need the same last-page investigation. Reviews are the smaller source; both need the last-page-first walk.
- **Quiet cycle:** zero reviews reads (no own PR moved). If the pulls list is newly forced on, the quiet cost is **1 per binding per cycle** (600/h at 10 repos) even when nothing moved.
- **Is search cheaper?** `GET /search/issues?q=repo:o/r+is:pr+author:<login>+updated:>=<window>` has its own 30/min bucket, and 600/h is 10/min at this scale — but it **does not return reviews**, so the reviews read remains; it only replaces the pulls list, which is free when `reviewRequest` is already on. It also has a 1,000-result cap and an undocumented freshness/indexing lag. **Not cheaper in aggregate; don't.**
- **Worst realistic total:** +600/h (new pulls read when reviewRequest is off) + ≤50/h (reviews) ≈ 650/h. With reviewRequest already on: ≤50/h.

#### 2.4 Id and dedupe

- Review ids are globally unique positive integers, stable across reads, and one submission is one row. Use the review id, not `submitted_at`, so a re-read of the window cannot mint a second row.
- Trigger note: `Review <state> by <reviewer> on pull request #<n>` — the state word is the only place the row records *which* review outcome it was, so it must be in the note rather than inferred by a later reader.
- Proposed:
  - trigger: `evt-<owner>~<repo>~<number>~<accountNumericUserId>~review~submitted~<reviewId>`
  - follow-up: `evt-…~followup~review-submitted~<reviewId>`
- Do **not** reuse `~followup~review~<reviewId>`: `review` event ids (issue events) and review ids are different numbering spaces and could collide, deduping two different movements into one delivery. The extra `submitted` segment exists for that reason.
- The trigger tail needs no parser change: `discriminatorOfId` treats any id without `followup` at segment 4 as a trigger, so `~review~submitted~<id>` is accepted and `originOf` reads `kind: 'review'` as origin `review`. The follow-up tail **does** need a new regex in `discriminatorOfId` (`service/poll/events-parse.ts:209`); without it `followUpKindOf` returns null and the row is folded as a **source reference** (or, with no joinable run, could mint a run, because `originOf` is non-null for `kind: 'review'`). Writer and parser must land together.
- Replay idempotency: same review id → same id → queue dedupe. A second review after changes is a new id → a second row, which is the desired behaviour.

#### 2.5 Gates

- **Window:** `submitted_at >= windowStart`, client-side (no `since`). A PENDING review has no `submitted_at` and is skipped — never defaulted.
- **Attribution:** the reviewer is `review.user`; `isAttributableAuthor(login, type)` applies unchanged. Bot reviews (Copilot and friends) produce nothing.
- **Self refusal (#65 / FR-052's self-actor clause):** a review by the bound account on the bound account's own PR produces nothing. This is a self-review; no one else's decision is recorded.
- **Subject ownership (new gate):** `pull.user.login` must equal the bound account, case-insensitively. This is a detection gate, not the dispatch allow-list. It is what distinguishes "feedback on my PR" from "a review somewhere in the repo".
- **Allow-list:** unchanged and still evaluated **once, at dispatch authorization** (`service/poll/dispatch-actor-gate.ts`). Do not reuse `allowedUsers` as a detection filter: FR-046 says policy is judged once at dispatch, and a second evaluation would make the same field mean two things.
- **Draft state:** a review on a draft PR is still a review; do not gate on `draft` (adding `draft` to `PollPull` is free if it later proves useful, e.g. for ready-for-review, which remains deferred).
- **State filter:** only `CHANGES_REQUESTED` for the recommended build. `APPROVED` and `COMMENTED` are separate product decisions (2b, 2c).
- **Terminal subject:** the pulls list is `state=open`, so a closed/merged PR's review is not delivered — acceptable; the work is over.

#### 2.6 Setting and UI

- `triggers.reviewSubmitted` on `BindingTriggers` (`service/bindings.ts:18`), read parse-tolerantly like `reviewRequest` (a binding stored before it reads `false`). Validation: boolean; absent means false.
- Panel: a fourth checkbox in the binding editor (`src/bindings-body.ts`, `src/bindings-ui.ts`), the draft/edit plumbing (`src/bindings-draft.ts`, `src/bindings-edit.ts`), a chip (`src/bindings-chips.ts`) and a phrase in the trigger-copy table (`src/bindings-actors.ts:42`). The copy must distinguish *"request a review from the account on a pull request"* (existing) from *"submit a review on the account's own pull request"* (new) — they are inverse directions and a shared phrase would be wrong.
- No new tab, no new field type, no new service route: the toggle rides the existing whole-file `PUT /v1/bindings`.

#### 2.7 Compatibility

- **No `EventKind` change and no `ReferenceOrigin` change** if the trigger reuses `kind: 'review'` (the feed it rode). The queue parser's `KNOWN_KINDS` already accepts it; `originOf` already returns `review`; the run key already has a pull subject. This is the single largest reason this group is M rather than L.
- **One `FollowUpKind` addition** (`review-submitted`) in service and panel. The panel's `parseFollowUp` returns `null` for an unknown kind, which refuses the **whole run row** — so a service that writes the new tail before the panel knows it hides an entire dispatch, not just the follow-up. Both bundles ship in one commit; the panel union must be extended in the same change.
- Old rows keep parsing: unions are additive; no stored member changes shape; no schema version bump.
- No manifest, capability, storage-key, `SERVICE_VERSION` or package-version change.

#### 2.8 Verdict

**Build now (2a only), with a named caveat:** reuse `kind: 'review'`, add `authorLogin`/`authorType` to `PollPull`, read `pulls/{n}/reviews` **last page first**, emit a trigger for an untracked own PR and a follow-up for a tracked one, gated on `CHANGES_REQUESTED` and a new `reviewSubmitted` toggle. **Caveat:** the endpoint is oldest-first, has no `since`, and the transport caps a walk at two pages, so a PR with more than 60 reviews in the window is truncated (fail closed and record it) and the build must add a `Link: rel="last"` read to `poller-transport.ts`. **Effort: M** — one new poller read plus that small transport addition, one new follow-up kind (service + panel), a trigger flag and its panel copy, tests, two rebuilt bundles.

**2b approved — defer.** Approving is not work; a trigger would page a session on every approval. If later wanted, a separate toggle defaulting off, and preferably a follow-up on a tracked PR ("approved — proceed"), not a trigger.

**2c commented — defer.** A `COMMENTED` review's inline comments are already §L follow-ups on a tracked PR, and a body-only summary is not actionable enough to start work. It becomes interesting only as a follow-up on a tracked PR; that can ride 2a's read later at near-zero cost.

**2d dismissal — defer.** The honest source is `issues/{n}/events` (`review_dismissed`), a **second** read per candidate PR, and the reviews feed's `DISMISSED` representation is unverified. A dismissal usually withdraws a block rather than asking for work; it is at most a follow-up ("the changes-requested review was dismissed"). Do not make it a trigger.

---

### 3. New trigger kinds

The issue's premise — *"detectable from rows the scan already lists"* — survives for **opened** and fails for **reopened** and **labeled**.

#### 3a. Newly opened

**GitHub surface — verified.**
`GET /repos/{owner}/{repo}/issues` (state `open` today) carries `number`, `state`, `state_reason`, `created_at`, `updated_at`, `closed_at`, `labels[].name`, `user.login`/`type`, `assignees[].login`, and the `pull_request` marker. Query params include `since` (only "last updated after"), `labels` (comma-separated), `sort`, `direction`, `per_page`, `page`. Core REST bucket. `created_at` is **not** in `PollIssue` today; adding it and `labels` costs **zero requests** (`service/poll/poller-entries.ts:214`).

**Detection shape.** A **trigger**. A newly opened item has no run by definition, so a follow-up is meaningless; there is no notification surface to fall back to. It is the only one of the three that is a clean trigger.

**Candidate set and cost.** The candidate set is the problem, not the detection. Every new item in the repository is the naive set — including the account's own issues and every drive-by PR — and that is exactly the noise the product must not page on.
- *Opened by the account*: `user.login === bound login`. This is a self-act; #65's self refusal should drop it, which makes the filter useless. Do not build it.
- *Mentions the account*: already the body-mention trigger (`~mention~body`). A second row would duplicate one act. Do not.
- *Assigned to the account at creation*: already the assignment trigger; the `assigned` event is the later, attributed source. Do not.
- *Label filter*: the only honest, non-duplicating filter. The issues list accepts `labels=…`, but **do not send it**: the same list feeds assignment and mention-body detection, and a server-side label filter would silently narrow those triggers. Filter **client-side** on the row's `labels` array (add it to `PollIssue`; zero requests), and `created_at` in the window then means "opened with label X". This makes the trigger useful ("new `needs-agent` issue") and quiet cycles cost **zero** *provided the issues list is already read* (assignment or mention on). If `opened` is the only trigger on, the list is read for it: **+600/h**.
- **No `allowedUsers` filtering at detection.** Reusing the allow-list here would evaluate policy twice (detection and dispatch), contradicting FR-046; a filter that is not the allow-list is needed, and the label is it.

**Id and dedupe.** `evt-…~opened`, fixed per subject. An item is opened once; a replay, a re-read of the overlapping window, or an edit produces the same id. Closed-then-reopened is not a second open (see 3b). The actor never enters the id (FR-046). Trigger note: `Issue #<n> opened by <login> with label <label>` (or `Pull request #<n> opened …`), naming the filter label that matched.

**Gates.** Window on `created_at` (not `updated_at`: a comment must not make an old issue look new). Author attribution — `user.login`/`type` — through `isAttributableAuthor`; a bot/unnamed author produces nothing. Self refusal for an author equal to the bound account. Allow-list unchanged at dispatch. The label filter is a new **detection** gate: the row's own `labels` array must contain one of the configured labels — the same comparison the client-side filter already made, checked here so a mis-filtered row cannot become an event.

**Setting and UI.** `triggers.opened` plus a new `labels: string[]` on the binding (the filter). Validation: non-empty when `opened` or `labeled` is on, absent otherwise (the `allowedUsers` three-state posture, but here empty is a refusal because the trigger would be noise). Panel: one checkbox and a comma-separated labels field; the binding form has no dedicated list input today — the closest precedent is the `allowedUsers` free-text field — so this is new UI, not a checkbox. No new route.

**Compatibility.** A new **`EventKind`** (`opened`) is unavoidable: reusing `mention` gives `originOf` null, and a delivery whose reference is null is dropped by `foldDelivery` — **the trigger would silently do nothing**. The only other kinds with a non-null origin are `assignment` and `review`, and both would mislabel the act in the queue, the run row and the panel. So the change is:
- service: `EventKind`, `KNOWN_KINDS`, a snapshot in `events-write.ts`, the `~opened` discriminator;
- `ReferenceOrigin` gains `opened` (`service/poll/runs-types.ts:20`) and its validator (`runs-parts-parse.ts:39`), or the run document refuses the reference;
- `originOf` maps it (`runs-join.ts:54`);
- panel: `EventKind` (`src/bindings-service.ts:116`) and `eventKindOf` (`:429`), or a new row renders as `assignment`;
- panel copy for the run row.
Old rows parse; the unions are additive. No manifest/capability/storage change.

**Verdict. Build, with the label filter as a precondition.** "Newly opened" without a filter is the noisiest signal in the set: an open binding with no allow-list would page for every issue and PR in the repository. With `labels`, it is the cheapest useful new trigger — zero added requests when the list is already read, no per-item read, and deterministic. **Effort: M** (new kind + origin + panel + filter field and UI + tests + bundles).

#### 3b. Reopened

**GitHub surface — verified.**
The open issue row **cannot** say it was reopened in this window. It carries `state: 'open'` and `closed_at: null`; `state_reason` may read `reopened` (the enum has `completed`, `reopened`, `not_planned`, `duplicate`, `null`), but it is a *current-state word*, not a dated event: it persists while the issue stays open, and `updated_at` moves for every comment and edit. A comment on an issue reopened months ago would look like a reopen. Using it as evidence is a guess.
The honest source is `GET /repos/{owner}/{repo}/issues/{issue_number}/events`, which documents `reopened` for both issues and pull requests, with `id`, `event`, `actor.login`/`type`, `created_at`, `commit_id`. Core REST bucket. The per-item timeline also has it. Neither has `since`; the scan window is a client-side comparison on `created_at`, exactly as FR-051 describes.
So the "zero added requests" claim **does not survive**. Detection needs **one read per candidate item** (or a persisted state, below).

**Detection shape.** A **trigger** is the only shape that makes sense (there is no run on a closed item in the ordinary case). But see the blocker.

**Candidate set and cost.** Without a prefilter, the candidate set is *every open item whose `updated_at` is in the window* — in a busy repository, 20 items × 600 binding-cycles = **12,000 item reads/hour**, an order of magnitude over budget. With a client-side prefilter on `state_reason === 'reopened'` (documented enum, **unverified semantics**), quiet cycles cost **zero** and only genuinely reopened items are read. The prefilter is mandatory; without it, reject on cost alone.
- Alternative: the repository-wide `GET /repos/{owner}/{repo}/issues/events` (`event`, `label`, `actor`, `created_at`, `issue.number`) with `event === 'reopened'` — one read per binding per cycle, **600/h always**, no fan-out, no persisted state. It has no `since` either, so it needs its own page-walk/truncation concept (which is why FR-049 forbids it for *attribution*; a new trigger is a different use). Cheaper in a busy repo, more expensive in a quiet one.

**Id and dedupe.** `evt-…~reopened~<eventId>`. The event id is unique and stable, so each reopen is one row and a replay of the window dedupes. A fixed `~reopened` would collapse two reopens on one issue into one delivery — wrong. Trigger note: `Issue #<n> reopened by <login>` (or `Pull request #<n> reopened by <login>`).

**Gates.** Window on the event's `created_at`; `actor.login` is the reopener (`actor` is the documented "person who generated the event" for this type — there is no dedicated field, unlike `assigner`); `isAttributableAuthor`; self refusal; allow-list unchanged at dispatch. No label filter is needed (a reopen is inherently a change), but bot reopeners are refused.

**Setting and UI.** `triggers.reopened` boolean, rendered exactly like the other trigger checkboxes. No new field.

**Compatibility.** The same new-kind plumbing as 3a (`EventKind`, `ReferenceOrigin`, `originOf`, panel `EventKind`/`eventKindOf`) **plus** the run-model blocker below.

**The blocker, stated plainly.** A reopened item usually has a **concluded run** from its earlier life. `findJoinableRun` treats any run with `session !== null` as joinable forever, and `foldDelivery` then appends the new trigger as a **source reference** and delivers nothing. A follow-up would join the run but its session is likely gone; the panel's delivery gate parks it (`no-session`). Separately, `trackedIssueEnds` ends tracking when the item closed, so the tracked view no longer carries it. Net: **detection can be built, delivery cannot, until the product decides one of:**
1. a **new ordinal** for a reopened subject — i.e. amend FR-030's "a run with a session is never dispatched again" to mean *per lifecycle*, with the reopen event as the new lifecycle's establishing trigger;
2. a **wake** path for a concluded session (new follow-up semantics, new states);
3. treat reopen as a **notification**, not work (new surface).

**Verdict. Defer** until that decision. Building the detector first would produce rows the operator can see and the agent never receives — the exact false claim FR-036 forbids. **Effort: M** for detection; the delivery decision is the real cost.

#### 3c. Labeled

**GitHub surface — verified.**
The issue row carries the **current** `labels[].name` set, not the change. A label present now may have been applied months ago; `updated_at` cannot date the application. The honest source is `GET …/issues/{issue_number}/events`, whose `labeled` event carries `label.name` and `label.color` (the response schema has `Labeled Issue Event`), plus `id`, `event`, `actor`, `created_at`. `unlabeled` is the inverse. Core REST bucket. No `since`.
Two ways to detect:
1. **Per-item events** for candidates that currently carry the configured label and moved in the window. The issues list is read unfiltered (as today) and the `labels[]` filter is applied **client-side**, because the same list feeds assignment and mention-body detection and a server-side `labels=` parameter would narrow those too. The candidate set is then the operator's chosen label, not the repository: quiet cost **zero**; active cost **1 per candidate**. A `labeled` event outside the window is ignored.
2. **Persist seen labels per subject** and diff the row. This costs **zero added requests** but adds a new persisted entity (a label ledger), a schema/migration, and a new source of truth for "what did we last see". Constitution III/VI apply; it also has to be pruned with the run. This is real state for a convenience; not recommended.

**Detection shape.** A **trigger** when the subject is untracked, a **follow-up** when it is tracked, for the same reason as 2a: a trigger on a tracked subject is absorbed as a reference and never delivered. The label application is a movement on work in progress when a run exists ("this is now `needs-changes`").

**Candidate set and cost.** With a dedicated label, **0 quiet / ≤ ~50/h active** across 10 repos. With a broad label (`bug`), the candidate set is every updated issue carrying it, and the cost rises toward the reopened worst case. The filter's specificity is the cost control. The list request is unchanged (client-side filtering); the per-candidate events read is the cost.

**Id and dedupe.** **Do not put the label name in the id.** Label names may contain spaces and `/`, which the `[A-Za-z0-9._~]` tail discipline refuses, and the event id already identifies the act. Use `evt-…~labeled~<eventId>`; the label name rides `triggerNote` (bounded, untrusted text). A remove-and-re-add is a new event id → a new row, which is correct; a replay of the same event dedupes. Trigger note: `Label <name> applied to #<n> by <login>`, naming the configured label that matched.

**Gates.** Window on the event's `created_at`; `label.name` must equal one of the binding's configured labels. The comparison rule must be stated in the spec — login-style case folding is a choice here, not a given, and the stored spelling is preserved. `actor.login` through `isAttributableAuthor`; self refusal; allow-list unchanged.
**The bot-actor problem is real here.** The common case is a triage bot applying the label, and FR-045 refuses every bot actor. Options: (a) accept human-applied labels only and document it (keeps the invariant); (b) add a `system` attribution basis and exempt this kind (schema change, and it weakens "no bot event"); (c) attribute to the issue author (a guess, forbidden). Recommend **(a)**; if the owner needs bot-applied labels, that is a spec amendment, not a detection change.

**Setting and UI.** `triggers.labeled` plus the same `labels: string[]` field 3a needs (shared). Validation: non-empty when on. Panel: one checkbox and the labels field; the field is the substantial UI work.

**Compatibility.** Same new-kind plumbing as 3a (`EventKind`, `ReferenceOrigin`, `originOf`, panel `EventKind`/`eventKindOf`) plus the binding field (same `PUT /v1/bindings`). No new storage key if the events route is used; the persisted-label alternative would add one.

**Verdict. Build with a caveat, after 3a.** The detector is honest and the cost is controllable with a specific label, but it needs the same new-kind plumbing as 3a, the same labels field, and it inherits the bot-actor refusal. The caveat to accept in writing: **a label applied by a bot will not trigger.** **Effort: L** (kind + origin + panel + field/UI + per-item read + tests + bundles).

---

### 6. Surfaces outside the assignment/review/mention shape

#### 6a. CI / checks failures

**GitHub surface — verified.**
- `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` — `ref` is a SHA, branch or tag; params `check_name`, `status` (`queued`/`in_progress`/`completed`), `filter` (`latest` default, `all`), `per_page`, `page`, `app_id`. Response `total_count` and `check_runs[]` with `id`, `head_sha`, `status` (`queued|in_progress|completed|waiting|requested|pending`), `conclusion` (`success|failure|neutral|cancelled|skipped|timed_out|action_required|null`), `name`, `started_at`, `completed_at`, `output`, `check_suite.id`, `app`, and `pull_requests[]` (`number`, `head`, `base`). Read access is available to OAuth/PAT classic with `repo` on a private repository (write is GitHub-App-only); fine-grained tokens need read access to checks (the exact permission name is not stated on this page — unverified). Core bucket.
- Legacy `GET /repos/{owner}/{repo}/commits/{ref}/status` — `state` (`failure` if any context is error/failure, `pending` if none/pending, `success` if all latest succeed), `statuses[]` (`id`, `state`, `context`, `description`, `target_url`, `created_at`, `updated_at`, `creator`), `sha`, `total_count`, `repository`. `per_page`/`page`. Core bucket.
- The check-run's `pull_requests[]` is populated for pushes in the same repository; the docs note that **fork pushes return an empty array**. So a commit→PR mapping from check-runs is not guaranteed.

**Detection shape.** A **follow-up on a tracked PR** — it fits the model (subject number, run, reference list), but **not as a trigger**: a failing check on a non-tracked PR has no run, and starting a session for every red CI run in a repository is the noise failure. The run already seeds `lastHeadSha`, and the pulls list already produces a head follow-up (`headFollowUps`), so the natural trigger is "the head moved; now read checks for the new SHA".

**Candidate set and cost.**
- **Head-movement-gated:** read `check-runs` only when this cycle produced a head follow-up (or observed a new head). **0 quiet / 1 per movement**, ≤ ~50/h. Misses a check that was `pending` when the head moved and fails later — the common long-CI case. If the product needs that, this gate is insufficient.
- **Every cycle for tracked PRs:** guarantees the transition but costs **60 × tracked PRs per hour**. Three tracked PRs per repository × 10 = **1,800/h**, over the design point before the existing feeds.
- **Pending-marker state:** persist "pending at SHA X" and re-read only while pending. Zero quiet once checks conclude; requires a new persisted member (run document or store), a prune rule, and a schema decision. The only option that is both complete and bounded; it is **not** a zero-state change.
- **Non-tracked PR:** no subject, no run, no panel notification surface. Reject; do not invent a notification for it.

**Id and dedupe.** `evt-…~followup~checks~<headSha>~<conclusion>` — the head SHA plus the aggregate conclusion. A replay of the same SHA+conclusion dedupes; a re-run that changes `success` → `failure` is a new id (correct); a flaky re-run of the same failure does not page again. The row should aggregate the failing check names in its note/excerpt, not emit one row per job. The id tail must be added to `discriminatorOfId`; without it the row folds as a reference, not a follow-up.

**Gates.** The subject is the tracked PR; the head should equal the run's seed/new head. There is **no human actor** in a check run — `app` is a GitHub App. Naming it would trip `isAttributableAuthor`, so the row must ride the run's recorded actor (the head follow-up's existing posture) or a new `system` basis must be introduced. Allow-list is not re-applied (it was judged at dispatch); the follow-up rides the run. No window question: the check belongs to the observed SHA.

**Setting and UI.** `triggers.checks` boolean; one checkbox. No new field. The panel's follow-up copy needs a `checks` movement line (``CI failed: <names>``) and the pull-shaped set.

**Compatibility.** New `FollowUpKind` (`checks`) in service + panel; no `EventKind`, no `ReferenceOrigin` (a follow-up carries no origin). Old rows parse. The row's `kind` should stay `'review'` — the pull feed it rode — so the existing union is unchanged and only the follow-up role is new.

**Verdict. Build with a caveat:** follow-up only, gated on a head movement, with the caveat that a check that fails after the head observation is not seen unless the pending-marker state is added. **Effort: M** (one poller read, one follow-up kind, a toggle, panel copy, tests, bundles); **L** if the pending-marker state is required.

##### 6a.1 The checks watch — what was verified before the v1.22.0 amendment (GitHub issue #62)

Read and measured 2026-10-22, before the watch was specified. §6a's body above is the 2026-10-20 record and stays as written; this subsection records what changed under it.

- **A fork PR's head resolves on the base repository.** The base repo's `GET /repos/{owner}/{repo}/commits/{forkHeadSha}/check-runs` answers for a fork PR head — checked live against fork PRs on `cli/cli` and `facebook/react` — so the watch is **not** limited to same-repo PRs. (The 2026-10-20 note that *fork pushes return an empty `pull_requests[]` array* is about that relay field on a push, not about the check-runs endpoint's reachability of a head; it does not restrict this read.)
- **Check-run conclusions and check-suite conclusions are different vocabularies.** A check run's conclusions are `action_required`, `cancelled`, `timed_out`, `failure`, `neutral`, `skipped`, and `success` (and `stale` after 14 days); **`startup_failure` is a check-suite conclusion** and a workflow that fails to start yields no failing check run at all. The watch therefore cannot promise it: alerting on `startup_failure` would need the check-suites endpoint, which is deferred. `cancelled` is deliberately not failing, because a push routinely cancels the previous run.
- **`filter=latest` can still exceed the two-page bound.** On a busy SHA — many distinct check names, or an app that keeps producing new runs — two pages of the configured page size do not cover the list. Such a head produces **no verdict** (the watch keeps and expires), and silence is never read as a pass. This is why the watch is bounded by reads and time rather than trusting one walk.
- **A token missing `Checks: read` could not be measured here.** Whether it answers `403` or an empty `200`/`404` was not established, so both classes are **absorbed** as `checks-unavailable`: the watch is kept, the class is logged and audited once per binding, and the binding's scan completes. `rate-limited` remains a scan skip.

#### 6b. Commit comments

**GitHub surface — verified, and the brief's query is wrong.**
`GET /repos/{owner}/{repo}/comments` accepts **`per_page` and `page` only — there is no `since`** (the page's parameter list has no such member). Comments are returned **ordered by ascending id**, so new comments are at the end, not the top. Response: `id`, `body`, `commit_id`, `user` (`Simple User`/null), `created_at`, `updated_at`, `html_url`, `path`, `position`, `line`, `author_association`, `reactions`. Core bucket.
A commit comment names a **commit SHA**, not an issue/PR. Mapping it to a subject needs `GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls` (returns the PRs associated with a commit; a commit can be on none or several), which is **one extra request per commented commit** and can be ambiguous. The PR's timeline also carries `commit_commented`, but only for a PR already being read.

**Detection shape.** **Neither.** With no issue/PR number on the row, a mention there cannot become a mention event without a lookup that may be ambiguous; a commit comment on a commit in no PR has no subject at all. A commit comment is not an issue comment and the run model has nowhere to put it.

**Cost.** One repository-wide read per binding per cycle (600/h) plus an unbounded page walk (the feed has no window), plus the per-commit PR lookup. **Quiet cost is never zero.**

**Id and dedupe.** There is no honest id to propose: `~mention~commit~<commentId>` would need a subject number the row does not have. If a PR lookup succeeded, the id could reuse the PR number, but the same comment could then be discovered through two paths with different ids.

**Gates.** The existing attribution/window gates would apply to the body, but the subject gate cannot be satisfied honestly.

**Setting and UI.** Would need a new toggle and a new "commit comments" concept in the panel; neither exists.

**Compatibility.** No `EventKind` fits (`mention` is issue/PR-bound in the run key). A new subject type or a subjectless event is a model change.

**Verdict. Reject.** The feed has no window, the row has no subject, and the lookup is ambiguous. **Effort to price: S; to build honestly: L**, and it is not worth it.

#### 6c. Releases

**GitHub surface — verified.**
`GET /repos/{owner}/{repo}/releases`, `per_page`/`page` only (**no `since`**). Response `id`, `tag_name`, `target_commitish`, `name`, `body`, `draft`, `prerelease`, `created_at`, `published_at`, `updated_at`, `author` (`login`/`type`), `html_url`, `assets[]`, `discussion_url`, `mentions_count`. Draft releases are only listed to a token with push access. Core bucket.

**Detection shape.** **A notification, not a trigger or a follow-up.** A release is repository-level: no issue/PR number, no subject key, no run. The product has no notification surface (no panel tab, no read/unread record, no storage for it). Building one is a new product feature, not event detection.

**Cost.** One repository-wide read per binding per cycle = **600/h**, always; the feed has no window. Quiet cost is never zero.

**Id and dedupe.** `release:<id>` would be a new id family with no subject base; the existing `evt-<owner>~<repo>~<number>~<account>` base cannot express it without a fake number.

**Gates.** Attribution is `author.login`; the allow-list is per binding and about work, not releases. None of it fits.

**Compatibility.** A new entity, a new storage key and a new panel surface; the run key cannot hold it.

**Verdict. Reject** for this spec; if wanted, it is a separate notification feature. **Effort: S** to price, **L** to build as a notification surface.

#### 6d. Discussions

**GitHub surface — verified.**
**GraphQL only.** `POST https://api.github.com/graphql`; there is no `/rest/discussions` page (404). Auth is the same token as a Bearer credential. `Repository.discussions` is a `DiscussionConnection` with `first`/`last`/`after`/`before`, `orderBy` (`DiscussionOrderField`: `CREATED_AT`, `UPDATED_AT`), `states` (`OPEN`/`CLOSED`), `categoryId`, `answered`. A `Discussion` has `number`, `id`, `title`, `body`, `createdAt`, `updatedAt`, `author`, `category`, `comments` (`DiscussionCommentConnection`), `answer`, `stateReason`. A `DiscussionComment` has `id`, `body`, `createdAt`, `updatedAt`, `author`, `replyTo`, `replies`, `isAnswer`. Pagination is cursor-based (`pageInfo.hasNextPage`/`endCursor`).
Cost: GraphQL points, **5,000 points/hour per user**, separate from REST; secondary limit 2,000 points/min. Point cost is roughly `total nodes / 100`, minimum 1. A query shaped `discussions(first: 30)` + `comments(first: 30)` is ~9 points; at 600 queries/h that is **5,400 points/h**, over the GraphQL budget. `first: 10` on both is ~1 point (600/h), but then a busy repository needs cursor walks.

**Detection shape.** The subject model could hold a discussion (it has a number, title, body, author), but `RunSubjectType` is `issue | pull_request`; adding `discussion` touches the run key, subject key, reference origins, routes, panel copy and run rows. That is a third subject type, not a new trigger.

**Cost and shape summary.** A GraphQL transport in a REST-only, stdlib-only service means: POST bodies, GraphQL error envelopes, cursor pagination, a second rate-limit budget and backoff, partial-data errors, and a different timeout/response shape. The service's `x-ratelimit-*` accounting has no GraphQL arm. The added surface is disproportionate to the signal.

**Id and dedupe.** `evt-…~discussion~<number>~<commentId>` would be a new family; the existing base is issue-number based and discussions share no numbering space with issues.

**Gates.** Author attribution is available (`author.login`); the allow-list would need a discussion-aware reading. None of it is the hard part.

**Compatibility.** Third subject type + GraphQL transport + a second budget: **L**.

**Verdict. Reject** for this wave. A discussion is not an issue, and the transport change is larger than every REST item combined. **Effort: L.**

#### 6e. Wiki

**GitHub surface — verified.**
There is **no wiki section in the REST API reference**. A wiki is a **separate git repository**: the docs say "Wikis are part of Git repositories" and give `git clone https://github.com/OWNER/REPO.wiki.git`; only changes pushed to its default branch go live. Reading it means running a git client (clone/fetch) with credentials — the service is HTTP-only, stdlib-only, and has no git dependency. Polling it would be a new transport, a new credential use for the wiki remote, and a new diff/event model (page names, not issue numbers).

**Detection shape.** **Neither.** No issue/PR subject, no run key, no number. There is nothing for the queue to carry.

**Cost.** Not an HTTP API budget: a git fetch per repository per interval, plus local diffing. It is outside NFR-003 entirely, which is worse, not better.

**Id and dedupe.** No honest id family.

**Verdict. Reject.** **Effort: S** to confirm; building it is a new integration.

---

### Verified vs unverified

**Verified against docs.github.com (URLs in Sources) and the code read for this report**

- `reviewed` is **timeline-only**; the per-item issue-events endpoint returns `review_dismissed` (with `dismissed_review.state` ∈ `commented|approved|changes_requested`) but not `reviewed`.
- `pulls/{n}/reviews`: parameters, chronological ordering, the field list, `submitted_at` absent on PENDING.
- `pulls` list (`Pull Request Simple`) carries `user`, `created_at`, `updated_at`, `draft`, `labels`; `PollPull` omits the author and the timestamps today.
- `issues` list carries `created_at`, `state_reason`, `closed_at`, `labels`, `user`; `since` means "last updated after"; `labels` is a query filter.
- Issue events: `reopened`, `labeled` (with `label.name`), `assigned`, `review_dismissed`; no `since` (only `per_page`/`page`); `reviewed` excluded.
- Check-runs: endpoint, filters, every field named in 6a, `pull_requests[]`; fork pushes return an empty `pull_requests` array.
- Combined status: fields and the three-state rule.
- Commit comments: **no `since`**, ascending id.
- Releases: **no `since`**, repo-level; drafts need push access.
- Discussions: GraphQL-only (`/rest/discussions` 404), `Repository.discussions` args, `Discussion`/`DiscussionComment` fields, 5,000 points/h, 2,000 points/min, node/point formula.
- Wiki: separate git repository; no REST endpoint in the reference.
- The service sends no conditional headers (`requestHeaders`, `poller-transport.ts`), so "quiet" reads are full requests.

**Unverified — treat as risk, not fact**

- Whether `GET pulls/{n}/reviews` returns a dismissed review with `state: "DISMISSED"` (or keeps the pre-dismissal state). The docs leave `state` a free string. This is why 2d uses the issue event instead.
- Whether `state_reason === "reopened"` persists on an open issue and means "the last transition was a reopen". The enum is documented; the semantics are not. 3b's cost depends on it.
- Search index freshness/lag; the docs describe timeouts and `incomplete_results`, not a freshness guarantee.
- Fine-grained permission names for checks/discussions; the pages state read availability but not the exact permission label.
- Whether a review submission moves the PR's `updated_at`. The 2a candidate bound depends on it; if it does not, the candidate set must be every open own PR, and the cost changes from ~50/h to 60 × open own PRs per hour.
- Whether `GET pulls/{n}/reviews` sends a `Link: rel="last"` header (GitHub documents `Link` pagination generally, not per endpoint). Without it, the last-page-first read has to discover the page count another way, and the >60-review case is simply unsupported.
- REST propagation latency for a just-submitted review or a just-applied label (no docs promise a bound). Any "instant" expectation is a risk.
- Whether a check run completing moves the PR's `updated_at` (needed if a candidate-gated read is ever used for checks instead of the head-movement gate).

---

### Sources

All docs read 2026-10-20. Pages were requested with `apiVersion=2022-11-28` where the URL shows it; the generic header note on the rendered pages names `X-GitHub-Api-Version: 2026-03-10`, so a field that differs between those versions remains a risk (none of the fields named here is version-specific in the page text).

- Issue events: <https://docs.github.com/en/rest/issues/events?apiVersion=2022-11-28>
- Issue event types (the `reviewed` timeline-only row, `review_dismissed`, `reopened`, `labeled`): <https://docs.github.com/en/rest/using-the-rest-api/issue-event-types>
- Timeline events: <https://docs.github.com/en/rest/issues/timeline?apiVersion=2022-11-28>
- Pull request reviews: <https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28>
- Pull requests list: <https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28>
- Issues list: <https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28>
- Check runs: <https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28>
- Commit statuses: <https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28>
- Commit comments: <https://docs.github.com/en/rest/commits/comments?apiVersion=2022-11-28>
- Releases: <https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28>
- Search (30 requests/min): <https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28>
- REST rate limits: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- GraphQL rate limits and points: <https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api>
- GraphQL discussions: <https://docs.github.com/en/graphql/reference/discussions>
- GraphQL `Repository.discussions`: <https://docs.github.com/en/graphql/reference/repos#discussions>
- GraphQL `PullRequestReviewState` (the `DISMISSED` enum): <https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewstate>
- Wikis are git repositories: <https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis>
- Cloning the wiki: <https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages>
- No REST discussions page: <https://docs.github.com/en/rest/discussions> (404), and no discussions or wiki section in the REST index: <https://docs.github.com/en/rest>

**Code read for this report** (no file changed): `service/poll/poller-github.ts`, `poller-entries.ts`, `poller-events.ts`, `poller-transport.ts`, `events-write.ts`, `events-parse.ts`, `run-key.ts`, `runs-join.ts`, `runs-types.ts`, `runs-parts-parse.ts`, `triggers.ts`, `triggers-assignment.ts`, `triggers-review.ts`, `follow-up.ts`, `tracking.ts`, `trigger-scan.ts`, `loop.ts`, `attribution.ts`, `dispatch-actor-gate.ts`, `service/bindings.ts`, `service/github.ts`, `service/config.ts`, `src/bindings-service.ts`, `src/bindings-actors.ts`, `src/bindings-chips.ts`, `src/dispatches-detail.ts`, `src/follow-up.ts`, `src/dispatches-rows.ts`, plus §K and §L.
