# Spike Runbook: Extension-First Gate (T001–T009)

> **Status (2026-09-27): executed and closed.** The operator ran §4.1–§4.5 of `spike-evidence.md` against a live OpenChamber instance; S1–S7 passed and the runbook's stop condition held — no T010+ work started in 001. Retained as the record of the procedure actually followed. Production continuation lives in `specs/002-agent-event-extension`.

Operator instructions for executing the spike end-to-end and gathering the
evidence that T009 turns into a pass/fail decision. Offline-verifiable steps
are already covered by the test suite; steps that need a live OpenChamber
instance, a GitHub PAT, or a test repository are executed with this runbook.

**Stop condition:** the spike ends at this gate. Do not begin T010+ regardless
of the outcome.

## 1. Test repository (T004)

- One small GitHub repository used only by this spike, e.g. `owner/mecha-turk-spike`.
- It must contain at least one open issue, because the poll reads the
  endpoint's default first page (`GET /repos/<owner>/<name>/issues` with
  `state=open`, default 30 entries). Pagination is out of scope for the gate.
- Seed the matching issue by assigning it to the machine account (see §2).
- Do not use a repository with production traffic: the spike polls it every
  configured interval and starts one session per matched issue.

## 2. The one matching rule (T004)

The spike accepts an issue when **all** of these hold, and rejects it with a
reason otherwise (`extension/src/matching.ts`):

1. it is not a pull request (GitHub lists PRs as issues; the `pull_request`
   key is the discriminator),
2. `state === "open"`,
3. the authenticated login from `GET /user` appears in `assignees`
   (compared case-insensitively).

Additionally, if `expected-login` is configured, it must equal the `/user`
login (case-insensitively) or the whole run fails closed before polling —
`expected-login` is a validation constraint, never a substitute identity.

Exactly one match per poll is required: zero matches means "polling, nothing
to do"; more than one is recorded as `ambiguous-match` and dispatches nothing.

## 3. Expected project ID and worktree option (T004)

- `project-id` — the id of an **already registered** OpenChamber project whose
  directory is a checkout of the test repository. The spike never creates a
  project: `resolveProject()` blocks the dispatch when the id is missing or
  unknown, listing the ids the host does report.
- `worktree-option` — one of:
  - `none` (start in the project's target directory),
  - `generated` (ask OpenChamber to generate a worktree),
  - `new:<branch-name>` (named new worktree/branch).
  Whatever is chosen, OpenChamber owns the worktree. The spike never creates,
  deletes, or mutates one locally.

Record both values in the evidence file before running the flow.

## 4. PAT setup without committed credentials (T004)

1. Create a **fine-grained PAT** for the machine account, scoped to the single
   test repository. Baseline permissions: `Metadata: read`, `Issues: read`
   (FR-015). Writes are not needed for this gate.
2. Enter it **only** in OpenChamber: Settings → Integrations → GitHub (token).
   The host stores it and attaches it to `host.request()` calls; the panel
   never receives it.
3. Never paste it into a file, a commit, a log, the ledger, or the evidence
   record. `.env.example` documents the shape of the configuration and keeps
   `GITHUB_PAT` commented out; `.gitignore` excludes `.env` variants.
4. Rotation/revocation: revoke the token in GitHub when the gate is done.

Verify after the run: `git grep -nE "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_"`
returns nothing outside test fixtures that construct obvious fake shapes.

## 5. Build and install (T002)

```sh
npm install
npm run build        # bunx openchamber-guest-bundle panel/main.ts panel/main.js
npm run verify       # build + lint + typecheck + tests
```

Install in OpenChamber: Settings → Extensions → Add → paste the **absolute
path of the `extension/` folder** → approve the displayed capabilities
(`sessions`, `prompt`, `network`) → open the panel. A folder install runs from
the folder itself, so rebuild and reload after each change.

## 6. Spike flow (S1–S5)

1. Open the panel. The banner shows `Lifecycle experiment plan loaded: 5 steps`
   and the summary line shows `repository`, `identity`, `match`, and ledger
   generation.
2. Confirm Settings → Integrations shows the connected GitHub account. The
   panel then calls `GET /user` once and records an `identity` entry with the
   login (never the token).
3. Watch for a `poll` entry, then an `evidence` entry. The evidence record is
   also written under the `mecha-turk-spike:evidence` storage key.
4. Press **Start session**. The panel re-resolves the project, re-fetches the
   issue, re-applies the rule, then calls `host.startSession()` once and
   records the complete result (`sessionId`, `sent`, `linked`, `directory`,
   `worktree`, or `failure`/`bootstrap-failed` with the leftover worktree).
5. Press **Verify host state**. The panel records project/worktree/session
   counts, the four subscription probes, observed lifecycle phases, and any
   problems as a `host-verify` entry.

## 7. Lifecycle experiment (T008, S6)

Run each step in order. After every step, reopen the panel and read the ledger
generation, the phase entries, and the gap verdict recorded at mount.

| Step | Action | What to record |
| --- | --- | --- |
| L1 mounted | Leave the panel open for two poll intervals | `mounted` phase, ≥2 `poll` entries, timestamps |
| L2 closed | Close the panel for two poll intervals, reopen | `closed` phase (best effort), gap verdict `polling-stopped` or `polling-continued`, `gapMs` |
| L3 paused | Pause the extension, wait two intervals, re-enable, reopen | new `panelGeneration`, operator `paused` marker, no `poll` entries in between |
| L4 removed | Remove the extension, install the folder again, reopen | `storagePresentBeforeMount: false`, empty entries |
| L5 server switch | Switch the OpenChamber server while closed, reopen | no prior ledger on the new server; record both servers' generations |

Each verdict must come from stored entries, never from an open panel looking
busy. The programmatic form of L2 is
`analyzeLastCloseGap({ prior, mountedAt })` →
`polling-continued | polling-stopped | no-gap` with `pollEntriesInGap` and
`gapMs`.

## 8. Verdict (T009)

Fill in `spike-evidence.md`, mark S1–S7 pass or fail with the recorded
evidence, state the decision, and **stop**. If S6 cannot show polling surviving
panel close, S7 applies: unattended extension operation is rejected and the
next milestone explicitly chooses a documented host local service or a
separately planned daemon boundary — no undocumented background mechanism.
