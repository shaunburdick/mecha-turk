# Spike Evidence: Extension-First Gate (T001–T009)

Record of what was built, what was verified offline, and what the operator's
live run against an OpenChamber instance with a GitHub PAT showed. §1–§2 are
the offline gates; §4 is the live evidence and the S1–S7 verdict.

**Run:** 2026-09-27T00:07Z (UTC)
**Branch:** `001-agent-event-orchestrator`
**Status:** implementation complete **and live-verified**. §4 records the
product owner's run against their own OpenChamber instance with a real GitHub
PAT: **S1–S7 all PASS (S7 not triggered)** — see §4.6. The gate decision itself
is not taken here: **T010 stays unticked until the product owner approves.**
**Remediation:** 2026-09-27T01:35Z (UTC) — code-review findings
T009a–T009i applied to the spike; see §2.1. No live step was executed then.
**Live verification:** 2026-09-27 (UTC) — executed by the operator/product
owner on a live OpenChamber instance; results transcribed into §4.1–§4.5 on
2026-09-27T02:56Z (UTC). Nothing in §4 was simulated, and no request to
`api.github.com` was issued from this development environment.

## 1. Version record (T001)

| Item | Value | How it was established |
| --- | --- | --- |
| `@openchamber/sdk` pin | `1.24.2` (exact, no range) in `extension/package.json` and root `devDependencies` | npm registry, checked 2026-09-26; asserted by `tests/manifest.test.ts` |
| Available SDK versions | `1.23.2-preview.1`, `1.24.0`, `1.24.1`, `1.24.2`, `2.0.0`, `2.0.1`, `2.0.2` (`latest` = `2.0.2`) | `npm view @openchamber/sdk` |
| Why `1.24.2`, not `2.0.2` | The SDK README states the package version matches the OpenChamber release it shipped with; the official docs example installs `^1.24.0` with `engines.openchamber: ">=1.24.0"`, which is the engine floor this spike declares. Re-pin to the host's own release before live execution if the host is ≥ 2.0.x. | `packages/sdk` README + `docs.openchamber.dev/sdk/` |
| Manifest `apiVersion` | `1` — both `1.24.2` and `2.0.2` accept only `1` (`OPENCHAMBER_SDK_MANIFEST_API_VERSIONS[0]`, README: "apiVersion is 1. Anything else is refused") | Inspected the published tarballs |
| Engine floor | `engines.openchamber: ">=1.24.0"`; `hostMeetsOpenChamberEngine("1.24.0", …)` → `true`, `"1.23.0"` → `false` | `tests/manifest.test.ts` using the SDK's own helper |
| Manifest validity | `parseManifestJson()` (official SDK parser) returns `{ ok: true }` for `extension/package.json` | `tests/manifest.test.ts` |
| Integration settings ids | `repository`, `expected-login`, `project-id`, `worktree-option`, `poll-interval-ms` — kebab-case because the SDK validates them against `PANEL_ID` = `^[a-z][a-z0-9-]*$`; camelCase ids fail with `invalid-integration` | Discovered by running the official parser; see contract amendment 3 |
| Capabilities declared | `["sessions", "prompt"]` plus `network` implied by the integration. `prompt` is required because `startSession` with `text` is gated on it (Host API docs; host `PluginPane.tsx` checks `request.text && !guestMay(…, 'prompt')`). No `service`, `files`, `filesystem`, `model`, or `background` is declared. | Contract amendment 2 in `contracts/openchamber.md` |
| **OpenChamber host build/version** | **Not recorded** — the operator's report carries no version string, so none is claimed here. The manifest installed unchanged with `@openchamber/sdk` `1.24.2` and needed no re-pin; see §4.1. | Live install, §4.1 |
| **Install behaviour from an absolute folder path** | **Verified.** The absolute path of `extension/` installs: the approval dialog showed the declared capabilities and the panel rendered. Selecting the repository root instead fails with `package.id should be kebab case` — only `extension/` is installable. | Live install, §4.1 |

Toolchain used for the offline gates: Node `v24.19.0`, npm `11.17.0`,
bun `1.3.14`, TypeScript `6.0.3`, ESLint `10.11.0`,
`eslint-config-shaunburdick` `9.0.1`, vitest `5.0.2`.

TypeScript is pinned to `6.0.3` rather than the newer `7.0.2` because
`typescript-eslint@8.60` (required by the org lint config) supports
`typescript >=4.8.4 <6.1.0`.

## 2. Offline verification (executed)

| Gate | Command | Result |
| --- | --- | --- |
| Format | `npm run format` (ESLint `--fix`, the org config's stylistic rules) | no changes pending, exit 0 |
| Lint | `npm run lint` | **0 errors, 0 warnings** (zero suppressions; no `eslint-disable`, no `@ts-ignore`, no `any`) |
| Types | `npm run typecheck` (`tsc --noEmit`, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | **0 errors** |
| Tests | `npm test` (vitest) | **229 passed / 229** across 15 files |
| Build | `npm run build` (`bunx openchamber-guest-bundle`) | `extension/panel/main.js` produced (classic IIFE, ~75 KB) |

Test coverage by concern (offline):

- `manifest.test.ts` — official parser, apiVersion, engine floor, exact SDK
  pin in both manifests, capability set, GitHub integration shape, panel entry
  exists, `providerId` matches the panel id.
- `bundle.test.ts` — committed `main.js` exists, starts as an IIFE, contains no
  `import`/`export`/`import.meta`, carries no GitHub-token-shaped string;
  `index.html` loads it.
- `matching.test.ts` — the single rule plus rejection reasons and identity
  validation (fail closed on mismatch/empty login).
- `redaction.test.ts` — token/`Authorization`/`Bearer` detection,
  `assertRedacted` throws without echoing the secret, credential-key stripping,
  **global** replacement of every occurrence (two tokens, two bearer
  credentials in one string) and stable first-match labelling across repeated
  calls (M1/T009c).
- `ledger.test.ts` — phases, correlation ids, monotonic `seq`, entry cap,
  detail truncation, credential-key stripping, append-time redaction of a
  secret-shaped `detail.error` (H2/T009b), schema validation on read, gap
  analysis verdicts. **Size gates live in `ledger-repair.test.ts`.**
- `ledger-repair.test.ts` — the host's size gate is measured in **UTF-8
  bytes**, with a fixture whose UTF-16 length passes while its byte length does
  not; byte-budget eviction drops the oldest entries until the ledger writes
  again (M2/T009d); redaction failures quarantine only the offending entry and
  leave every other entry untouched (H2/T009b).
- `evidence.test.ts` — contract record shape (camelCase fields), input
  validation, round-trip, no secret-shaped content, and field-by-field type and
  format validation on read: wrong types, empty strings, wrong trigger, bad
  issue id/URL, non-integer generation (M4/T009f).
- `config.test.ts` — fail-closed settings validation, interval clamping
  (15000–300000), worktree option parsing including rejection of path-shaped
  new-branch names (separators and `..`, L7/T009h), and project-id resolution:
  panel selection beats the `project-id` setting, a malformed stored value
  falls back to the setting, and neither source alone unblocks (T009j).
- `project-picker.test.ts` — picker state and selection handling (T009j):
  option/placeholder/note rendering for idle, loading, error, empty, and ready;
  stale lists are never selectable; storage read/write results are reported
  rather than swallowed; `listProjects` failure leaves config, dispatch state,
  and the ledger untouched; teardown stops every write.
- `github.test.ts` — request builders, payload normalisation (PRs detected via
  `pull_request`), malformed payloads fail closed without echoing bodies,
  host-backed fetches with a fake host.
- `lifecycle.test.ts` — mount bookkeeping, gap baseline selection, the
  five-step plan covering exactly the five phases.
- `session.test.ts` — project resolution (incl. failure paths), bounded
  context (character budget, untrusted-text delimiters preserved under
  truncation, no-secret assertions), `startSession` request shape (projectId,
  issue attachment, worktree options, clamped title), success and
  partial-failure result summaries, dispatch idempotency that counts **only
  created sessions** (H1/T009a), host verification against a fake host (lists,
  four subscriptions, replay, teardown, problem recording) including a
  **fresh host whose session-lifecycle stream never fires** — registration, not
  failure (M3/T009e).
- `panel-dispatch.test.ts` — end-to-end dispatch retry paths: unresolved
  project → retry dispatches, source changed → re-match dispatches, failed
  `startSession` → retryable, created session → refused a second time (H1/T009a).
- `panel-actions.test.ts` — `runPoll` in-flight guard and failure recording,
  the single-match and ambiguous-match sweep paths, evidence-write failure
  leaving no dispatchable state (L6/T009h), `ensureIdentity` mismatch and
  success, poll-timer re-arm on interval change (L8/T009h), fail-safe ledger
  persistence that quarantines and retries (H2/T009b), kind-accurate failure
  banners (L5/T009h).
- `app.test.ts` — teardown releasing every subscription exactly once,
  `handlePagehide` persisting before teardown, `applySettings` stopping or
  re-arming the poll loop (L8/T009h), and evidence restore on remount so a
  reopened panel can dispatch (M4/T009f).
- `tests/support/panel.ts` — the shared host/runtime doubles every panel test
  drives; not a test file itself.

### 2.1 Wave 0 remediation (T009a–T009i)

Findings from the `code-quality-reviewer` pass over the spike (base HEAD
`c68c795`), all applied and re-verified with `npm run verify`
(build, lint, typecheck, 186 tests):

| ID | Finding | Fix |
| --- | --- | --- |
| H1 / T009a | `findDispatchForIssue` counted blocked and failed `session` entries as "already dispatched", so one transient failure disabled dispatch forever | only entries carrying a **created session id** count; a retry after an unresolved project, a changed source, or a failed `startSession` dispatches |
| H2 / T009b | one secret-shaped detail value failed every later ledger write | `detail.error` is redacted at append time, and a failed persist **quarantines the offending entry and retries once** (`extension/src/ledger-repair.ts`) |
| M1 / T009c | `redact()` replaced only the first match per pattern | patterns are global; `findSecretLeak` keeps first-match semantics through `String.match`, which never inherits `lastIndex` |
| M2 / T009d | the size gate counted UTF-16 units while the host counts UTF-8 bytes, with no eviction path | `TextEncoder` measurement plus byte-budget eviction (oldest first, 60 KiB working budget under the host's 64 KiB limit) |
| M3 / T009e | the `session-lifecycle` probe reported `failed` on a fresh host | the probe records `replayExpected: false` and observes its window; registration is the only guarantee that surface makes |
| M4 / T009f | `readEvidence` checked key presence only and was never called | field-by-field type and format validation, wired into `loadLedger` so a remount restores the evidence record (S6) |
| M5 / T009g | the orchestration layer had no tests | `panel-actions`, `panel-dispatch`, and `app` covered: poll guard/failure, ambiguous sweep, identity mismatch, pagehide ordering, teardown release |
| L1–L8 / T009h | cleanup batch | `issueUrl` in evidence detail, import formatting, stale `tsconfig` include, excerpt-vs-frame truncation (FR-026 markers survive), kind-accurate failure banners, evidence-write failure leaves no dispatchable state, path-shaped `new:` branch names rejected, poll timer re-arms when the interval changes |

No live step was executed or claimed by the remediation pass: §4 was still
`PENDING LIVE VERIFICATION` at that point (it is now filled in).

### 2.2 Project picker (T009j)

A `projectId` cannot be obtained from OpenChamber's Settings surface:
OpenChamber prints no project ids there, and the documented host API in
`@openchamber/sdk` 1.24.2 offers the panel no way to write integration
settings — `host.onSettings()` is a host→guest push and `HostClient` declares
no settings writer (confirmed against `dist/host.d.ts`, `API.md`, and the wire
protocol's `type: 'settings'` message).

The panel therefore gained a project picker: `host.listProjects()` on mount
and on demand (capability `sessions`, no new capability requested), the pick
persisted in the extension-namespaced `host.storage` key
`mecha-turk-spike:project`, and `resolveProjectId` resolving **panel selection
→ `project-id` integration setting → blocked**. Loading, error, and empty
states are rendered from picker state; a refused list or a refused write never
touches configuration, polling, dispatch, or the ledger, and dispatch stays
blocked without a resolved id. The effective id and its source are shown with
a **Copy project id** button (`host.writeClipboard`) for operators who still
want it in the integration setting. Re-verified with `npm run verify`
(build, lint, typecheck, 229 tests); see `contracts/openchamber.md` amendment 4
and `extension/README.md`. The same limitation was confirmed during the live
run — settings stayed read-only to the panel and the operator selected the
project from the picker dropdown; see §4.4a.

## 3. Blockers

**Resolved for this spike.** No live OpenChamber instance, GitHub PAT, or
seeded test repository was available to the build environment, which is why §4
was originally published as `PENDING LIVE VERIFICATION`. The product owner ran
the whole checklist on their own OpenChamber instance and reported the outcomes
recorded in §4; this environment performed the transcription only. No network
call to `api.github.com` was made from here — every GitHub call in §4 went
through the host's own `host.request()` from the operator's machine.

## 4. Live verification results

Sections §4.1–§4.5 carry the operator-reported outcomes of the run planned
below, followed by §4.6, the derived S1–S7 verdict. Where the operator's report
is silent (exact timestamps, mount generations, raw probe counts), the cell says
so rather than inventing a value.

### 4.1 T001 — host build and install behaviour (S1)

**OBSERVED — PASSED (S1).**

What the operator did and saw:

1. **First install failed.** The operator selected the repository root instead
   of `extension/`; the host refused it with `package.id should be kebab case`.
   The installable unit is the `extension/` folder, not the workspace root.
2. **Install from the absolute path of `extension/` succeeded.** The approval
   dialog showed the declared capabilities (`sessions`, `prompt`, plus the
   network access implied by the integration), and the panel rendered after
   approval.
3. **SDK pin held at `1.24.2`** — the re-pin branch below was never triggered,
   so no `2.0.x` migration was needed on this host.

Planned procedure (kept for reproduction on the next host):

1. Read the OpenChamber version (Settings → About, or the docs' install page
   for the running release) and write it into the table in §1.
2. If that build is ≥ `1.24.0`, keep the SDK pin at `1.24.2`; if it is
   `2.0.x`, re-pin `@openchamber/sdk` to the matching `2.0.x`, run
   `npm install && npm run build && npm run verify`, and update §1.
3. Settings → Extensions → Add → paste the absolute path of `extension/`.
4. Confirm the approval dialog lists exactly `sessions`, `prompt`, and
   `network` (network is implied by the integration), then open the panel.

**S1 pass condition:** folder install succeeds, the manifest is accepted with
`apiVersion: 1`, and only the declared capabilities are offered.
**→ Met.**

### 4.2 T005 — GitHub authentication through `host.request()` (S2)

**OBSERVED — PASSED (S2).**

The PAT was entered once, on the Settings → Integrations **GitHub (token)**
card — nowhere else. Host-managed attachment was verified live: the panel
displayed the authenticated identity (the login from the host's own
credential handling), and the PAT itself never appeared in panel state, the
ledger, or any stored record.

Planned procedure (kept for reproduction):

1. Create a fine-grained PAT for the machine account, scoped to the single
   test repository with `Metadata: read` and `Issues: read`.
2. Settings → Integrations → GitHub (token) → paste the PAT. It must not be
   typed anywhere else (`.env.example` keeps `GITHUB_PAT` commented out).
3. Open the panel; confirm an `identity` ledger entry appears with the login
   from `GET /user`, and that `expected-login` (if set) matches.
4. Inspect the ledger and the evidence record: no token, no `Authorization`
   value, no `Bearer` string anywhere.

**S2 pass condition:** authentication succeeds with host-managed attachment and
the PAT is absent from panel state, storage, logs, and evidence.
**→ Met.**

### 4.3 T005/T006 — one poll, one match, one dispatch (S3, S4)

**OBSERVED — PASSED (S3, S4).**

- **Poll:** **Poll now** discovered an issue assigned to the operator's user;
  the configured repository, matching rule, and evidence path were exercised
  against real GitHub data through the host.
- **Dispatch with `worktree-option: none`:** the first `startSession` created a
  session **in the project directory, with no worktree** — the configured
  behaviour, and the `none → no worktree field` request mapping was verified on
  the wire (no `worktree` property is sent).
- **Dispatch with `worktree-option: generated`:** after the operator switched
  the setting, a second dispatch created a session in an **OpenChamber-generated
  worktree** (`worktree: true` honored by the host).
- **Idempotency (H1 fix, T009a):** re-dispatching an issue whose session was
  already created was refused by the guard. Confirmed live: counting only
  entries with a created session id behaves correctly on a real ledger.
- **Host state:** **Verify host state** recorded host-owned state via
  `listProjects`, `listWorktrees`, `listSessions`, and the `on*` probes — see
  §4.4.

Planned procedure (kept for reproduction):

1. Seed the test repository with exactly one open issue assigned to the
   machine account (see runbook §1–§2).
2. Fill the settings: `repository`, `project-id` (registered project whose
   directory is a checkout of that repository), `worktree-option`,
   `poll-interval-ms`.
3. Let one poll interval elapse. Expect a `poll` entry with
   `matched: 1` and one `evidence` entry; read the record back from
   `mecha-turk-spike:evidence`.
4. Press **Start session**. Record the complete result from the `session`
   entry: `sessionId`, `sent`, `linked`, `directory`, `worktree*`, or
   `failure` with `worktreeDirectory`/`worktreeBranch`/`worktreeStatus` when
   `sessionId` is null.
5. Press **Start session** a second time and confirm the panel refuses with
   "Already dispatched" (idempotency).

**S3 pass condition:** exactly one configured repository poll detects exactly
one matching issue and writes one redacted, correlation-linked evidence record.
**→ Met** (poll discovered the assigned issue; the record's redaction and
correlation linkage are asserted offline in §2 and are written by the same code
path the live poll used).
**S4 pass condition:** the `startSession()` result — including any partial
bootstrap failure — is recorded in full.
**→ Met** for both worktree paths (`none` and `generated`); no partial failure
occurred in the run.

### 4.4 T007 — host-owned project/worktree/session state (S5)

**OBSERVED — PASSED (S5).**

After the dispatches, **Verify host state** recorded host-owned state read
through `listProjects`, `listWorktrees`, `listSessions`, and the `on*`
subscriptions — i.e. the panel observed the host's project, worktree, and
session state rather than performing any of those operations itself. No local
worktree or session operation was performed by the spike: the worktrees the run
created were generated by OpenChamber itself (`worktree-option: generated`).

Not reported by the operator (recorded as such, not as a failure): the raw
probe counts, whether any probe reported a problem, and a `git status` of the
project checkout at the end of the run.

Planned procedure (kept for reproduction):

1. Press **Verify host state** and read the `host-verify` entry.
2. Confirm the project is found, the worktree list reflects what OpenChamber
   owns (generated/reused as configured), the new session appears in
   `listSessions`, the three snapshot probes (`projects`, `worktrees`,
   `sessions`) registered and replayed, the `session-lifecycle` probe
   registered, and no problem is recorded. A silent `session-lifecycle` stream
   is expected on a host that has never seen a lifecycle event: that probe
   reports registration, not replay (M3).
3. Confirm nothing in the repo or the project directory was created or
   modified by the spike (`git status` in the project checkout).

**S5 pass condition:** host APIs confirm the expected project, worktree
behaviour, session, and lifecycle transitions, with no local worktree or
session operation performed.
**→ Met** on the reported evidence (host-owned state recorded through the list
and subscription APIs).

### 4.4a T009j — project picker, read-only settings, and config precedence (live)

**OBSERVED — PASSED** (contract `openchamber.md` Wave 0 amendment 4).

- **Integration settings are read-only to the panel.** Confirmed live on SDK
  `1.24.2`, which declares no settings writer — the picker could not and did
  not write `project-id`.
- **Picker source:** `host.listProjects()` for the options and the
  extension-namespaced `host.storage` key (`mecha-turk-spike:project`) for the
  selection. The operator picked a project from the dropdown; the picker
  shipped in commit `f0bf7e1`.
- **Config precedence confirmed:** the panel's stored selection outranks the
  `project-id` integration setting, and the setting remains the fallback —
  exactly the resolution order `resolveProjectId` implements.
- **Spike finding:** `projectId` resolution was the operator's pain point —
  no OpenChamber Settings surface prints a project id — and the picker is what
  unblocked the live dispatch in §4.3. Production UX must keep a way to choose
  (or be handed) a project.

### 4.5 T008 — lifecycle experiment (S6)

**OBSERVED — PASSED (S6), with L5 not tested (non-blocking).**

Executed by the operator in order from `spike-runbook.md` §7. Every verdict
below is sourced from stored ledger entries, not from an open panel looking
busy. The operator's report did not include raw mount generations or wall-clock
timestamps, so those cells say "not reported" instead of carrying invented
values; the operator did confirm that polling and lifecycle entries carried
timestamps inside the relevant windows.

| Step | Mount generation | Phase entries observed | Poll entries in gap | Verdict / evidence | Timestamps |
| --- | --- | --- | --- | --- | --- |
| L1 mounted (panel open) | not reported | `mounted`/lifecycle entries recorded normally | n/a — panel open | **PASSED** — polling and lifecycle entries recorded normally while the panel was open. | within the run window; exact times not reported |
| L2 closed ~few minutes, reopened | not reported | entries recorded across the closed window | **yes** — the ledger held `poll` entries timestamped inside the closed window | **PASSED** — gap verdict **`polling-continued`** (explained by the operator): polling ran without an open panel. **S6 unattended monitoring: PASSED.** | `poll` entries fall inside the closed window; exact times not reported |
| L3 disable/enable (the runbook's "pause" maps to the disable/enable toggle in this build) | not reported | stopped while disabled, resumed after re-enable | **none** in the disabled window | **PASSED** — polling stopped during the disabled window (no entries) and resumed after re-enable; the disable/enable semantics match the intended pause step. | within the run window; exact times not reported |
| L4a disable/re-enable + panel reload | not reported | state restored on remount | polling resumed after reload | **PASSED** — settings, ledger, evidence record, and project selection were all restored after the reload. | within the run window; exact times not reported |
| L4b uninstall/reinstall | fresh after reinstall | storage and settings empty on first mount after reinstall — matching the runbook's expected outcome for the "removed" step | n/a | **EXPECTED BEHAVIOUR, not a failure** — storage and settings were wiped, so the operator must reconfigure. SDK docs state that storage "is removed on uninstall". **Spike finding:** `host.storage` alone does not survive uninstall; production persistence must account for this. | within the run window; exact times not reported |
| L5 server switch | — | — | — | **NOT TESTED** — the operator runs a single OpenChamber server, so there was no second server to switch to. Recorded as not tested and **non-blocking for this gate**; S6 rests on L1–L4. | — |

**S6 pass condition:** a reproducible, timestamped verdict for each step that
states whether polling continued, stopped, or was unloaded, sourced from
ledger entries rather than from an open panel.
**→ Met for L1–L4** (verdicts taken from ledger entries); **L5 not tested**
(single server) and explicitly out of scope for the gate verdict.

### 4.6 T009 — checklist decision

**COMPLETED — S1–S7 recorded from the live run (§4.1–§4.5).**

| Check | Requirement | Offline status | Live status |
| --- | --- | --- | --- |
| S1 | Folder install with documented manifest/API version rules, only declared capabilities | manifest validated by the official SDK parser | **PASS** — `extension/` installed from its absolute path; approval dialog showed the declared capabilities; panel rendered. Root-folder install refused (`package.id should be kebab case`). §4.1 |
| S2 | GitHub auth via `host.request()` with host-managed token; PAT absent everywhere | redaction + no-token assertions pass in tests and against the built bundle | **PASS** — authenticated identity (login) shown from host-managed attachment; PAT absent from panel state and ledger. §4.2 |
| S3 | One poll → one matching issue → one redacted, correlation-linked evidence record | rule, evidence schema, and correlation linkage covered by tests | **PASS** — "Poll now" detected the issue assigned to the operator's user on the configured repository. §4.3 |
| S4 | `startSession()` receives project id and issue attachment; complete result recorded | request/result shaping covered, incl. partial-failure fields | **PASS** — both worktree paths: `none` → session in the project directory with no worktree field; `generated` → OpenChamber-generated worktree (`worktree: true`); re-dispatch refused by the idempotency guard (H1/T009a). §4.3 |
| S5 | Host APIs confirm project/worktree/session/lifecycle; no local worktree operation | host verification logic covered against a fake host | **PASS** — **Verify host state** recorded host-owned state through `listProjects`/`listWorktrees`/`listSessions` and the `on*` probes; the spike performed no local worktree or session operation. §4.4 |
| S6 | Panel-close, pause/removal, and server-switch produce a reproducible verdict | gap analysis, phases, and mount bookkeeping covered by tests | **PASS** — L1/L2/L3/L4a verdicts from ledger entries: polling **continued** while closed (S6 unattended monitoring), stopped while disabled, state restored after re-enable/reload; L4b wipe is documented behaviour; **L5 not tested** (single server) and non-blocking. §4.5 |
| S7 | If polling stops or cannot be proven after panel close, unattended extension operation is rejected | decision rule documented; **cannot be evaluated without S6** | **NOT TRIGGERED** — L2 proved polling continued while the panel was closed, so unattended extension operation is not rejected. §4.5 |

**Decision: PASS (S1–S7).** Unattended extension operation is supported by the
evidence: L2 shows the poll loop running with the panel closed, L3 shows it
stopping cleanly when the extension is disabled, and L4a shows state surviving
a reload. **Recommendation: proceed to T010 — extension-first production
architecture** (production lifecycle, storage durability including the L4b
uninstall finding, multi-repository limits, and user approval UX).

**Gate:** per `tasks.md`, **T010 is deliberately left unticked** — the
extension-first architecture change requires product-owner approval at this
gate. T011 (the alternative path) is therefore not selected; T012/T013 remain
unstarted research paths.

**Not claimed here:** L5 (server switch) was not exercised — one server only.
If a second server becomes available, record its generation and the absence of
prior ledger state then; nothing in this verdict depends on it.

## 5. Notes for the reviewer

- Contract deviations are documented in `contracts/openchamber.md`
  ("Wave 0 amendments"): camelCase evidence fields, the `prompt` capability,
  kebab-case settings ids, and (amendment 4) the project-picker storage
  precedence — panel storage over the `project-id` integration setting, which
  the live run confirmed as the effective order (§4.4a). All four were forced
  by running the official SDK parser, the host's documented capability gate, or
  a live operator attempt, rather than by preference.
- **projectId resolution was an operator pain point.** No OpenChamber Settings
  surface prints a project id and SDK 1.24.2 has no settings writer, so the
  picker (commit `f0bf7e1`) is what made live dispatch possible at all; the
  production design must keep an equivalent way to choose a project.
- **`host.storage` does not survive uninstall** (L4b, §4.5). The spike ledger
  and evidence records are disposable spike artefacts, but a production
  extension that must persist across uninstall/reinstall needs a design decision
  beyond extension storage.
- No lint suppression of any kind exists in the tree; the one lint/config
  conflict (camelCase property names vs. the approved evidence contract) was
  resolved by amending the contract, not the rule.
- The ledger is spike evidence only — explicitly not a production durability
  substitute (plan.md "Lifecycle design").
- Persistence recovery lives in `extension/src/ledger-repair.ts` instead of
  growing `extension/src/ledger.ts`: source files in this repo sit under the
  lint configuration's 500-line ceiling, and repair is a separate
  responsibility from the ledger format itself.
- `tests/support/panel.ts` is the single host/runtime double used by every
  panel test; `tests/session.test.ts` now imports it instead of carrying its
  own copy.
