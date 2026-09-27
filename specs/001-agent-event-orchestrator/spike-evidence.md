# Spike Evidence: Extension-First Gate (T001–T009)

Record of what was built, what was verified offline, and exactly what remains
for a human operator with a live OpenChamber instance and a GitHub PAT.

**Run:** 2026-09-27T00:07Z (UTC)
**Branch:** `001-agent-event-orchestrator`
**Status:** implementation complete; every live step is
`PENDING LIVE VERIFICATION` — no pass/fail decision is claimed.

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
| **OpenChamber host build/version** | **PENDING LIVE VERIFICATION** | See §4.1 |
| **Install behaviour from an absolute folder path** | **PENDING LIVE VERIFICATION** | See §4.1 |

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
| Tests | `npm test` (vitest) | **145 passed / 145** across 10 files |
| Build | `npm run build` (`bunx openchamber-guest-bundle`) | `extension/panel/main.js` produced (classic IIFE, ~73 KB) |

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
  `assertRedacted` throws without echoing the secret, credential-key stripping.
- `ledger.test.ts` — phases, correlation ids, monotonic `seq`, entry cap,
  detail truncation, credential-key stripping, schema validation on read,
  serialization size/redaction assertions, gap analysis verdicts.
- `evidence.test.ts` — contract record shape (camelCase fields), input
  validation, round-trip, no secret-shaped content, read-back rejection.
- `config.test.ts` — fail-closed settings validation, interval clamping
  (15000–300000), worktree option parsing.
- `github.test.ts` — request builders, payload normalisation (PRs detected via
  `pull_request`), malformed payloads fail closed without echoing bodies,
  host-backed fetches with a fake host.
- `lifecycle.test.ts` — mount bookkeeping, gap baseline selection, the
  five-step plan covering exactly the five phases.
- `session.test.ts` — project resolution (incl. failure paths), bounded
  context (incl. character budget and no-secret assertions),
  `startSession` request shape (projectId, issue attachment, worktree options,
  clamped title), success and partial-failure result summaries, dispatch
  idempotency, host verification against a fake host (lists, four
  subscriptions, replay, teardown, problem recording).

## 3. Blockers

No live OpenChamber instance, GitHub PAT, or seeded test repository is
available in this environment. Every item in §4 is therefore
`PENDING LIVE VERIFICATION`; none of it was simulated or faked. No network call
to `api.github.com` was made.

## 4. Pending live verification

### 4.1 T001 — host build and install behaviour (S1)

**PENDING LIVE VERIFICATION**

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

### 4.2 T005 — GitHub authentication through `host.request()` (S2)

**PENDING LIVE VERIFICATION**

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

### 4.3 T005/T006 — one poll, one match, one dispatch (S3, S4)

**PENDING LIVE VERIFICATION**

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
**S4 pass condition:** the `startSession()` result — including any partial
bootstrap failure — is recorded in full.

### 4.4 T007 — host-owned project/worktree/session state (S5)

**PENDING LIVE VERIFICATION**

1. Press **Verify host state** and read the `host-verify` entry.
2. Confirm the project is found, the worktree list reflects what OpenChamber
   owns (generated/reused as configured), the new session appears in
   `listSessions`, all four probes registered and replayed, and no problem is
   recorded.
3. Confirm nothing in the repo or the project directory was created or
   modified by the spike (`git status` in the project checkout).

**S5 pass condition:** host APIs confirm the expected project, worktree
behaviour, session, and lifecycle transitions, with no local worktree or
session operation performed.

### 4.5 T008 — lifecycle experiment (S6)

**PENDING LIVE VERIFICATION**

Execute L1–L5 from `spike-runbook.md` §7 in order and paste the observed
generations, phase entries, gap verdicts, and timestamps into the table below.

| Step | Mount generation | Phase entries observed | Poll entries in gap | Verdict / evidence | Timestamps |
| --- | --- | --- | --- | --- | --- |
| L1 mounted | | | | | |
| L2 closed | | | | | |
| L3 paused | | | | | |
| L4 removed | | | | | |
| L5 server switch | | | | | |

**S6 pass condition:** a reproducible, timestamped verdict for each step that
states whether polling continued, stopped, or was unloaded, sourced from
ledger entries rather than from an open panel.

### 4.6 T009 — checklist decision

**PENDING LIVE VERIFICATION — blocked on §4.1–§4.5.**

| Check | Requirement | Offline status | Live status |
| --- | --- | --- | --- |
| S1 | Folder install with documented manifest/API version rules, only declared capabilities | manifest validated by the official SDK parser | PENDING LIVE VERIFICATION |
| S2 | GitHub auth via `host.request()` with host-managed token; PAT absent everywhere | redaction + no-token assertions pass in tests and against the built bundle | PENDING LIVE VERIFICATION |
| S3 | One poll → one matching issue → one redacted, correlation-linked evidence record | rule, evidence schema, and correlation linkage covered by tests | PENDING LIVE VERIFICATION |
| S4 | `startSession()` receives project id and issue attachment; complete result recorded | request/result shaping covered, incl. partial-failure fields | PENDING LIVE VERIFICATION |
| S5 | Host APIs confirm project/worktree/session/lifecycle; no local worktree operation | host verification logic covered against a fake host | PENDING LIVE VERIFICATION |
| S6 | Panel-close, pause/removal, and server-switch produce a reproducible verdict | gap analysis, phases, and mount bookkeeping covered by tests | PENDING LIVE VERIFICATION |
| S7 | If polling stops or cannot be proven after panel close, unattended extension operation is rejected | decision rule documented; **cannot be evaluated without S6** | PENDING LIVE VERIFICATION |

**Decision:** NOT YET TAKEN. Per the gate, no T010+ work may start until §4.6
is completed by an operator with a live instance and the pass/fail is recorded
here.

## 5. Notes for the reviewer

- Contract deviations are documented in `contracts/openchamber.md`
  ("Wave 0 amendments"): camelCase evidence fields, the `prompt` capability,
  and kebab-case settings ids. All three were forced by running the official
  SDK parser and the host's documented capability gate rather than by
  preference.
- No lint suppression of any kind exists in the tree; the one lint/config
  conflict (camelCase property names vs. the approved evidence contract) was
  resolved by amending the contract, not the rule.
- The ledger is spike evidence only — explicitly not a production durability
  substitute (plan.md "Lifecycle design").
