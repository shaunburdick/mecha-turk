---
name: mecha-turk-troubleshooting
description: Use when a Mecha Turk dispatch looks wrong or unexplained — a run stuck in `starting`, `unconfirmed`, `failed`, `blocked:<reason>` or `dead-lettered`; a dispatch that never happened; no session where one was expected, or two where one was; "why didn't it dispatch"; reading `audit.ndjson`, the Logs tab or `runs.json`; or reproducing a dispatch bug offline. Reach for this before answering any question about a run's state, attempt count or correlation id.
---

# Troubleshooting Mecha Turk

This is the repository's own troubleshooting skill: the files, keys and audit
rows to read, and the safe moves when a run is in doubt. The operator-facing
account is the published debug page (`site/src/pages/debug.astro`); this one
goes to the code-level evidence an agent needs to name a cause.

## The three parties

- **The panel** is the OpenChamber extension iframe (`panel/index.html`). It has
  guest storage and host APIs only: no filesystem, no network. It reaches the
  local service solely through `host.serviceRequest()`, and the host solely
  through `host.startSession()`, `host.listProjects()` and friends.
- **The service** is the stdlib-only Node process OpenChamber spawns
  (`package.json` → `contributes.service` → `service/main.js`). It polls bound
  repositories, owns the run document and the audit trail, and binds loopback
  only: `127.0.0.1:$OPENCHAMBER_SERVICE_PORT`, with
  `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` required on every request,
  `/health` included. A token shorter than 32 characters stops it before it
  binds (`service/env.ts`).
- **OpenChamber** owns projects, worktrees, sessions and agents. It performs the
  `host.startSession()` the panel asks for and is the only authority on whether
  a session exists.

**What you can reach from outside the host.** You do not have
`host.serviceRequest`, so you cannot read the service over HTTP the way the
panel does. Do not go looking for the token: the panel never receives it, and
while same-uid code can in principle read the service's environment, the real
boundary is file permissions and uid separation — not the bearer string
(`specs/002-agent-event-extension/contracts/token-handoff.md`, SEC-07). Using it
would also mean acting as a panel, outside the host's own bookkeeping. Work
read-only from the store, from what the panel renders, and from the host's own
session list.

## Where the evidence is

**The service store** — `$HOME/.config/openchamber/mecha-turk/` on every OS.
It is resolved from `HOME` and does **not** follow `XDG_CONFIG_HOME`
(`service/store/dir.ts`). The directory is `0700`, every file `0600`.

| File | What it holds |
| --- | --- |
| `runs.json` | **The authority on run state**: state, attempt, `requeuesUsed`, lease, reservation, session reference, source references. |
| `audit.ndjson` | Append-only trail, one JSON row per line, monotonic `seq`. Outlives the process and every restart. |
| `config.json` | Service settings (intervals, lease and deadline, retention, agent baseline, prompt). |
| `bindings.json` | The binding table: one row per binding (`bindingId`), each naming an `owner/name` repository. |
| `accounts/<numericUserId>.json` | Credential files. **Count them; never open, print, copy or paste one.** |
| `events.json` | The delivery queue (observed deliveries, linked to their run). |
| `scan-state.json` | Per-binding scan checkpoint (`lastScanAt`, `baselineAt`, `rescanFrom`). |
| `state.json` | `schemaVersion` and `initializedAt` only. |

A file the parser refuses is renamed aside to `<file>.corrupt-<epoch-ms>-<uuid>`
beside it (`service/store/json.ts`). A quarantine is a **finding**: the state was
refused whole rather than half-applied, so resolution stays fail-closed. The
service logs a `warn` line naming the `quarantinePath` (and, for an account, the
refused field and its remediation). Leftover `<name>.tmp<uuid>` files are swept
at start (`openStore`); one you find later is noise, not a cause.

**The panel's guest storage** — these are not files, and you can only reach them
through what the panel renders. The conventions that matter:

- `mecha-turk:dispatches` — schema `dispatch-attempts-2`; at most one record per
  `(correlationId, attempt)` — the latest reservation cycle's — with an `unknown`
  outcome written **before** `host.startSession()`, replaced in place by the
  resolved outcome, plus `settledAt` for an attempt the service's audit proved
  past.
- `mecha-turk:ledger` — mount generations and entries (`panelGeneration`
  increments on every mount, starting at 1).
- `mecha-turk:evidence` — the last evidence record.
- `accounts` — the account mirror, unprefixed.

**The host** — the session list. Since the attachment id **equals** the run's
correlation id, searching the host's sessions for `mt-run-…` answers "does a
session exist?" without guessing a worktree path (host-generated, never derive
one).

## The triage loop

1. **Name the symptom and get the correlation id.** The panel's selected run
   offers *Copy correlation id*. That string is the only join key across the
   panel record, `audit.ndjson`, `runs.json` and the host session list.
2. **Read the run row, then re-read it.** Dispatches has no cadence —
   activation and *Refresh dispatches* only (`specs/005-panel-ia/spec.md`
   SC-114(c)) — so a row is a snapshot. Press *Refresh dispatches*; re-pressing
   the tab does not re-read.
3. **Get the live state from `runs.json`.** `state`, `attempt`, `requeuesUsed`,
   `lease`, `reservation` and `session` settle what the row is only showing.
4. **Filter the audit by that id.** In the store directory,
   `grep -F '<mt-run-id>' audit.ndjson`, then read in `seq` order. This is the
   record that survives restarts: it answers *why* the run moved, not merely
   *where* it is. (`GET /v1/audit?correlationId=` is the same read through the
   panel; `/v1/audit` is the route.)
5. **Check the host's session list for the same string** when the run is
   `starting`, `unconfirmed`, or the panel warned about an unknown attempt. This
   is the decisive question for those states.
6. **Name one conclusion**, in the run's own vocabulary: dispatched (a session
   exists), did not dispatch (refused or blocked, with the cause), or a session
   may exist and only the operator can decide. Then go to
   `references/playbooks.md`.

A good conclusion reads like: "`mt-run-…` was reserved at T (`dispatch.reserved`,
attempt 1), no `dispatch.result` or `dispatch.abandoned` follows, the deadline
passed (`dispatch.unconfirmed` at T2), and no session carries the attachment id
— so no session exists." A screenshot is never that conclusion; the trail is.

## The companion triage script

One read-only pass over the store, so you do not hand-join `runs.json` and
`audit.ndjson`:

```sh
node .agents/skills/mecha-turk-troubleshooting/scripts/triage.mjs
```

It reads the same files named above and prints a summary keyed by run — state,
attempt, requeues used, whether a lease or reservation stands, and the audit rows
that explain each run needing attention. It writes nothing and settles nothing;
`--help` lists its options. Treat it as a reading aid: the store files remain the
authority.

## Reproducing a dispatch bug offline

`npm ci`, then `npm run verify` (build → lint → typecheck → test) for the whole
gate, and `npm test -- <file>` or `npm test -- <file> -t '<name>'` for one case.
Every suite is
offline by construction: `tests/support/panel.ts` is the fake host and storage
double, service suites run against a temp directory, and the panel's service
calls can be answered by a `METHOD path` → answer table keyed exactly as the code
sends it — include the query string when the code sends one
(`tests/dispatches.test.ts`). When the bug is a lost or duplicated dispatch, add
the case to `tests/crash-permutations.test.ts`: it enumerates close-before-claim,
close-after-claim, close-after-authorization, lost report, duplicate report,
stale report, slow panel, restart, panel-storage wipe, and operator retry, and
asserts at most one session per run. Prove the new test fails on the unfixed code
first — that is the repository's practice, not an optional nicety.

Panel states can be captured with `npm run shot` (see `AGENTS.md` §Visual
verification), including `--scene NAME` for a state the default fixture cannot
reach. Never test against live GitHub or a live OpenChamber.

## Red lines

- **Never edit the store by hand.** Parsers are fail-closed, writes are atomic,
  and a reservation is not a cache: a hand edit is more likely to produce the
  next quarantine than the fix.
- **Never print, copy or commit credential material**, and never weaken
  redaction. `accounts/*.json` is the one place a PAT lives; count the files.
- **Never add a GitHub write** — comment, label, reaction, review — as a
  diagnostic or recovery step. The product is read-only to GitHub, and
  idempotency lives entirely in Mecha Turk's own state.
- **Never re-dispatch an `unconfirmed` run by hand.** Exactly two resolutions
  exist: *session was created* and *no session was created*. The second is the
  only path that re-dispatches.
- **Never present a screenshot as evidence of state** when the audit trail is
  available.

## References

- [`references/evidence-map.md`](references/evidence-map.md) — every store file,
  panel key, identity, state and audit row, plus logs-versus-audit.
- [`references/playbooks.md`](references/playbooks.md) — the seven recurring
  signatures, each with symptom, check, remedy and how to confirm the fix.
