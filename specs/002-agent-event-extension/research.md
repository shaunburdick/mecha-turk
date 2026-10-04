# Research: Agent Event Extension (Production) — new findings only

**Feature**: `specs/002-agent-event-extension`
**Researched**: 2026-09-27 · **Amended**: 2026-10-03 (§R8, §R9, for the actor allow-list — GitHub issue #9)
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
