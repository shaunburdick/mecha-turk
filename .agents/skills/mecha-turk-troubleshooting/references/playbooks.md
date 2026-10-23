# Mecha Turk playbooks

Contents

- [How to read these](#how-to-read-these)
- [1. The row says `starting` long after the fact](#1-the-row-says-starting-long-after-the-fact)
- [2. `unconfirmed` — a session may exist](#2-unconfirmed--a-session-may-exist)
- [3. A dispatch that left no trace at all](#3-a-dispatch-that-left-no-trace-at-all)
- [4. `blocked:<reason>` — refused before the host](#4-blockedreason--refused-before-the-host)
- [5. `dead-lettered` — the requeue budget is spent](#5-dead-lettered--the-requeue-budget-is-spent)
- [6. Nothing dispatches at all](#6-nothing-dispatches-at-all)
- [7. The panel record will not parse](#7-the-panel-record-will-not-parse)

## How to read these

The store is `$HOME/.config/openchamber/mecha-turk` (`STORE` below). `grep` and
`node` are the only tools assumed; `jq` is optional wherever it is mentioned.
Examples are POSIX shell — use your shell's own variable syntax if it differs.

```sh
STORE="$HOME/.config/openchamber/mecha-turk"

# Every audit row for one run, in file order.
grep -F '<mt-run-id>' "$STORE/audit.ndjson"

# Every run's live state, attempt and requeue count.
STORE="$STORE" node --input-type=module -e '
import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.env.STORE + "/runs.json", "utf8"));
for (const r of d.runs) console.log(r.correlationId, r.state, "attempt", r.attempt, "requeues", r.requeuesUsed);
'

# One run in full.
STORE="$STORE" node --input-type=module -e '
import fs from "node:fs";
const [id] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(process.env.STORE + "/runs.json", "utf8"));
console.log(JSON.stringify(d.runs.find((r) => r.correlationId === id) ?? null, null, 2));
' mt-run-…
```

Replace `<mt-run-id>` with the run's correlation id. An `mt-run-…` is 24 hex
characters; the attachment id is the same string, which is why the host session
list answers the session question.

## 1. The row says `starting` long after the fact

**Symptom.** Dispatches shows `starting` hours after the fact, or the row looked
live when the operator last opened the tab.

**Why it happens.** Dispatches has no cadence: activation and *Refresh
dispatches* only (`specs/005-panel-ia/spec.md` SC-114(c)). The row is a snapshot;
re-pressing the tab does not re-read it.

**Check.** Read the live state in `runs.json` and the tail of the audit for the
run:

- `dispatch.reserved` with no `dispatch.result` and no `dispatch.abandoned` and a
  `deadline` in the past,
- then `dispatch.unconfirmed` — written by the service's next sweep, at most
  `min(leaseMs, resultDeadlineMs) / 2` after the deadline (60 s on defaults).

**Remedy.** Press *Refresh dispatches*. If the live state is `unconfirmed`, the
row now offers *Resolve dispatch*: go to playbook 2. If the deadline has not
passed, the host call is still outstanding; wait for the sweep rather than
re-dispatching.

**Confirm it is fixed.** The row's state matches `runs.json`, and the last audit
row for the run is the transition the row claims.

## 2. `unconfirmed` — a session may exist

**Symptom.** A run sits in `unconfirmed`, sometimes with a reconciliation banner
naming it. Nothing will move it.

**Why it happens.** A reservation was made but no result arrived before the
deadline. Fail-closed: it is **never** requeued and never expires on its own. It
is not stuck; it is waiting for one operator decision.

**Check.** Verify before acting, in this order:

1. No session in the host's session list carries the attachment id (the
   correlation id). Search the list for the string — do not guess a worktree
   path, which is host-generated.
2. No worktree was created for it. The record's `projectId` and
   `worktreeOption` are shown in the warning and on the row.
3. The audit has no `dispatch.result` or `dispatch.abandoned` for this attempt
   (only `dispatch.reserved` and `dispatch.unconfirmed`).

**Remedy.** Use the panel's two explicit resolutions. Select the row, then press
either *Session was created* (type the session id you found) or *No session was
created*. Both are **arm-then-confirm**: the first click only relabels the button
(`Confirm: …`) and rewrites the note with what you are being asked to have
verified; the second click posts. The API decisions behind them are
`session-created` (requires the `sessionId` you found) and `no-session` (rejects
a `sessionId`, because the same body cannot report both an existing session and
none), with an optional `note` saying what you checked
(`POST /v1/events/:correlationId/resolve`).

*No session was created* is the **only** path that re-dispatches an
`unconfirmed` run.

**Confirm it is fixed.** `dispatch.resolved` appears in the audit for the run.
On `no-session` the run returns to `pending` at attempt + 1, and the relay claims
it on its next tick (every 10 s while the panel is mounted). On
`session-created` the run reads `dispatched` with the session you named.

## 3. A dispatch that left no trace at all

**Symptom.** The operator believes a dispatch happened, but there is no session
and no local record of the attempt — sometimes not even the reconciliation
warning.

**Why it happens.** Before v1.13.0 the panel wrote the attempt record only after
`host.startSession()` returned, so a teardown inside the call destroyed the only
witness. Current builds write an `unknown`-outcome intent to
`mecha-turk:dispatches` **after** the reservation and **before** the host call,
and surface it on remount as a reconciliation warning naming the run, its
verdict, the project and worktree option, and the attachment id. The warning
settles only on the service's own evidence (`dispatch.reserved` for that attempt
and lease, followed by a result, abandonment or resolution) and the settlement is
written down.

**Check.** If the warning is absent, one of these is true:

- the teardown happened before the intent write (so the audit holds at most a
  claim or a reservation, or nothing),
- the record was wiped (panel storage cleared, extension removed, new server),
- or the attempt record is unreadable — the panel says *could not be read*
  rather than staying silent.

Search the audit for the run's correlation id. A reservation with no result is
the strongest evidence available; the `dispatch.reserved` row carries that
attempt's `leaseId` and the token's fingerprint (`tokfp-…`), which is how two
reservation cycles at the same attempt are told apart.

Note that `dispatch.unconfirmed` alone is **not** evidence of what the host
returned: the warning stays and says the run still needs your decision. It
settles only on a result, an abandonment, or a resolution that follows the
matching `dispatch.reserved` row.

**Remedy.** Do not re-dispatch and do not delete the record. If a session exists
with the attachment id, record it through the *Session was created* resolution
once the run reads `unconfirmed`; if none exists, use *No session was created*.

**Confirm it is fixed.** The next mount either shows no warning (the attempt was
settled) or names the run with a verdict — never silence about an attempt the
audit proves was authorized.

## 4. `blocked:<reason>` — refused before the host

**Symptom.** The run reads `blocked:project-missing`, `blocked:binding-missing`,
`blocked:credential`, `blocked:policy`, or `blocked:actor-not-allowed`.

**Why it happens.** A fail-closed guard refused before any `host.startSession()`
call. No session exists, no attempt was consumed, and no requeue budget was
spent.

**Check.** The row's reason line and the audit:

- `run.blocked` carries `blockedReason`, `priorState` and the `guidance` the
  operator saw — the panel's account of the refusal, while the service's
  `dispatch.refused` row is the authority.
- For `actor-not-allowed`, also read `dispatch.refused` with
  `code: "actor-not-allowed"`: it names every denied login and its attribution
  basis, plus `actorPolicy` (`open` or `restricted`) and whether the judged
  reference list was `truncated`.
- Then check the cause itself: the project is registered in OpenChamber, the
  binding's `state` is `active` and it watches at least one trigger, the account
  file exists (count it; never open it), and the Accounts tab's scope matrix is
  readable; the binding's `allowedUsers` (if present) contains the trigger's
  actor.

**Remedy.** Clear the cause, then press *Retry dispatch* (it posts at once;
unlike the resolutions and *Return to waiting*, there is no second click).
For `actor-not-allowed` with a **truncated** reference list, adding a login cannot
clear it and a retry is refused for the same reason: the run stays parked and
costs no attempt. For `project-missing`, register the project by hand; the
extension never creates one.

**Confirm it is fixed.** `dispatch.retry` records `priorState: "blocked:…"` and
`attemptBefore/After`; the run returns to `pending` and the next claim produces a
`dispatch.claimed`.

## 5. `dead-lettered` — the requeue budget is spent

**Symptom.** The run reads `dead-lettered` and offers *Return to waiting*.

**Why it happens.** The automatic requeue budget (`MAX_AUTO_REQUEUES = 3`) was
exhausted by repeated lease expiries. Each automatic requeue is a claim that
expired with no reservation, which also consumed an attempt.

**Check.** `run.dead_lettered` carries `priorState`, `attemptBefore/After`,
`requeuesUsed` and `budget`. Read the earlier `dispatch.lease-expired` rows: they
are the loop that spent the budget — most often a panel being closed mid-tick
repeatedly.

**Remedy.** Press *Return to waiting* (arm-then-confirm). This is the one control
for a dead-lettered run and it **resets `attempt` to 1 and `requeuesUsed` to 0**,
which also starts a fresh token-consumption chain. If the cause was a repeated
teardown, fix that first or the run will spend the budget again.

**Confirm it is fixed.** `dispatch.retry` with `attemptReset: true`; the run is
`pending`, and a later claim/result pair ends it.

## 6. Nothing dispatches at all

**Symptom.** Work is detected (or the operator expects it to be), the panel is
open, and no session ever appears. There may be no run at all.

**Check.** Walk outward and stop at the first broken link; each one is visible on
a different surface.

1. **OpenChamber is running and the panel is open.** Dispatch happens in the
   panel, not the service: with the panel closed, nothing claims.
2. **The service is healthy.** The Status tab's projection reports whether it
   is; the service answers its `/health` probe, and its startup log names the
   variable (never the value) if it refused to start.
3. **The binding is enabled and watches something.** `bindings.json` →
   `state: "active"`, with at least one trigger on. A disabled binding is
   skipped by the scan, and a run whose binding was deleted parks as
   `blocked:binding-missing`.
4. **The project is registered.** The binding's `projectId` must resolve through
   `host.listProjects()`; otherwise the run parks as `blocked:project-missing`.
5. **The credential is present with read scopes.** An account file exists for
   the binding's `accountNumericUserId`; the account mirror's four capabilities
   (`metadata`, `issues`, `pull-requests`, `contents`) are the scope check.
6. **The agent pin is what you think it is.** `config.json` → `expectedAgent`
   (blank is the default and is not a failure; it yields `agent.uncompared`).
7. **The claim happened.** The relay polls `GET /v1/events/pending` every 10 s
   while the panel is mounted. No `dispatch.claimed` for the run means the
   service never offered it; `dispatch.claimed` with no `dispatch.reserved`
   means a guard refused or the panel died in between.

Read the audit for `dispatch.refused` and `run.blocked`; if neither exists and no
run exists, look at `scan-state.json` (`lastError`) and the Logs tab for skipped
scans. The Status tab's five setup prerequisites are the quickest check of steps
2–5.

**Remedy.** Fix the first broken link. Do not create a project implicitly, do not
widen a token's scopes as a guess, and do not hand-edit `bindings.json`.

**Confirm it is fixed.** The audit shows `dispatch.claimed`, then
`dispatch.reserved`, then `dispatch.result` with a `sessionId` for one run, and
the host session list shows that session.

## 7. The panel record will not parse

**Symptom.** On mount, reconciliation warns that it could not read the attempt
record, and no session is created.

**Why it happens.** An unreadable (or unknown-schema) `mecha-turk:dispatches` is
fail-closed: the panel refuses to half-apply it, warns, and will not start a
session from a document it cannot parse — a dispatch it tries anyway abandons
its reservation instead of calling the host. This is deliberate: the record may
be the only local evidence that a session exists.

**Check.** The warning's own words distinguish the cases:

- *could not be read* — the key held a document this build refuses, or storage
  threw;
- a named run with a verdict — the document was readable and that attempt is
  unresolved (playbooks 2 and 3).

Then read `runs.json` and the audit: the service's own state is unaffected by an
unreadable panel record, so a session may still exist and a reservation may still
stand.

**Remedy.** Do not delete the key. Leave the record in place; determine from the
audit and the host session list whether a session exists, and resolve the run
through its row once it reads `unconfirmed`.

**Confirm it is fixed.** The warning stops only when a build that can read the
record settles it, or when the operator resolves the run and the run's state no
longer needs the record. Nothing is dispatched from an unparseable document in
the meantime.
