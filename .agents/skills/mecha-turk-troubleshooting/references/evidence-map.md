# Mecha Turk evidence map

Contents

- [The service store](#the-service-store)
- [Quarantine siblings and temp debris](#quarantine-siblings-and-temp-debris)
- [The panel's guest storage](#the-panels-guest-storage)
- [Identities](#identities)
- [Run states and their exits](#run-states-and-their-exits)
- [Audit vocabulary](#audit-vocabulary)
- [Logs versus the audit](#logs-versus-the-audit)
- [Read-only routes](#read-only-routes)

## The service store

`$HOME/.config/openchamber/mecha-turk/` — resolved from `HOME`
(`service/store/dir.ts`), so it does **not** honour `XDG_CONFIG_HOME`. The
directory is `0700` (chmod'd after creation) and every file the store writes is
created `0600`; both are explicit, so a permissive umask cannot widen them.

| File | Written by | What it is |
| --- | --- | --- |
| `runs.json` | `service/poll/runs-document.ts` | The run document: `{ schemaVersion, subjects, runs, auditIntents }`. **`runs[]` is the authority on run state** for anything the panel shows. |
| `audit.ndjson` | `service/audit.ts` | Append-only trail; one JSON row per line; `seq` monotonic per trail. Survives restarts. |
| `config.json` | `service/config.ts` | The operator's settings: `intervalMs`, `leaseMs`, `resultDeadlineMs`, retention, `logLevel`, `expectedAgent`, `startingPrompt`, and the retry bounds. |
| `bindings.json` | `service/accounts/store.ts`, `service/bindings.ts` | The binding table — an array, one row per `bindingId`, each naming one `owner/name` repository, its project, worktree option, triggers, `allowedUsers` and starting prompt. |
| `accounts/<numericUserId>.json` | `service/accounts/store.ts` | One credential file per connected account. **Never open, print, copy or paste one — count the files instead.** |
| `events.json` | `service/poll/events.ts` | The delivery queue: one row per observed delivery, carrying `runCorrelationId` once it has a run. |
| `scan-state.json` | `service/poll/scan.ts` | Per-binding scan checkpoint: `lastScanAt`, `lastError`, `baselineAt`, `forceReplay`, `rescanFrom`. |
| `state.json` | `service/store/index.ts` | `schemaVersion` plus `initializedAt`; a marker, not operator data. A torn or unreadable one is replaced with a fresh marker (it may leave a `.corrupt-…` sibling); the history files beside it are untouched. |

Every run in `runs[]` carries, among others: `correlationId`, `attachmentId`
(equal to it), `runKey`, `ordinal`, `subjectType`, `subjectNumber`, `repository`,
`accountNumericUserId`, `bindingId`, `projectId`, `worktreeOption`, `state`,
`stateReason`, `attempt`, `requeuesUsed`, `sourceReferences`,
`referenceCount`, `referencesNotRetained`, `lease`, `reservation`, `session`,
`attempts` and `verification`.

## Quarantine siblings and temp debris

- A document the parser refuses is renamed aside, beside its target, to
  `<file>.corrupt-<epoch-ms>-<uuid>` (`service/store/json.ts`). The original name
  is then absent, which is why an absent `config.json` can mean "set aside"
  rather than "never written" — `readStoredConfig` checks for the evidence and
  still reports `quarantined`.
- A quarantine is **fail-closed evidence**: the document was not half-applied.
  For `runs.json` it is stronger still — the service refuses to serve run state
  at all (`503 storage-unavailable`) rather than answer "nothing is waiting"
  from an empty history.
- The reason is in the service log: a `warn` line naming `quarantinePath`
  (`stored run document was unusable and has been set aside`, `stored bindings
  were unusable…`, `stored record was unusable…`, `stored configuration was
  unusable…`). For an account, the line also carries the refused field and its
  remediation, never the value. A quarantined `state.json` is the exception: it
  is a marker, so it is replaced with a fresh one without a warning.
- Temporary write files are named `<target>.tmp<uuid>`; the startup sweep
  (`openStore` → `sweepTempDebris`) removes them. One left afterwards means a
  write was interrupted while the process lived; it is noise, never the cause of
  a state.

## The panel's guest storage

These live in OpenChamber's guest storage. They are **not files**, and an agent
outside the host reaches them only through the panel's rendering.

| Key | Schema | What it holds |
| --- | --- | --- |
| `mecha-turk:dispatches` | `dispatch-attempts-2` (reads `dispatch-attempts-1`) | The durable dispatch-attempt record. At most one record per `(correlationId, attempt)`; `leaseId` names the reservation cycle that wrote it, so two cycles that reuse an attempt number stay distinguishable. `unknown` is written before the host call and replaced in place; `settledAt` marks an attempt the service's audit proved past. |
| `mecha-turk:ledger` | `spike-ledger-1` | Mount generations and entries. `panelGeneration` starts at 1 and increments on every mount. |
| `mecha-turk:evidence` | `extension-spike-1` | The most recent normalized evidence record. |
| `accounts` | array of mirrors | The unprefixed account mirror (numeric id, login, `active`, scope matrix). |

Surfaces that show them: the **Dispatches** tab (rows, the selected run's
detail, *Copy correlation id*, *Audit history*), the **Status** tab
(projection and the five setup prerequisites), the **Logs** tab, **Bindings**
and **Accounts**.

`mecha-turk:dispatches` is read fail-closed: a document this build cannot parse
makes reconciliation warn and nothing is dispatched from it. Do not "fix" that by
deleting the key — it may be the only local evidence that a session exists.

## Identities

| Identity | Shape | Where it comes from |
| --- | --- | --- |
| Run correlation id | `mt-run-` + 24 lowercase hex | SHA-256 of the run key (`service/poll/run-key.ts`). The service mints it; no caller may substitute one. |
| Attachment id | the correlation id, verbatim | `buildAttachmentId` — this is why searching the host's session list for `mt-run-…` works. |
| Run key | `github\|<accountNumericUserId>\|<owner/name>\|<issue\|pull_request>\|<number>\|<0-based ordinal>` | Deterministic tuple, `service/poll/run-key.ts`. |
| Dispatch token | `dtk-` + 32 lowercase hex | SHA-256 of run key + `\|` + attempt. Deterministic, **single-use**, valid only for the current lease/attempt. The audit records only its fingerprint, `tokfp-…`. Never replay one by hand. |
| Lease id | `lse-` + 24 lowercase hex; adoption mints `migration-` + the correlation id | One per claim; a fencing/consistency token, not a capability. |
| Panel generation | integer from 1 | Panel ledger; +1 per mount. `panelGeneration` in the ledger header and every entry. |

## Run states and their exits

From `service/poll/runs-types.ts` and `specs/003-dispatch-integrity/spec.md`.

| State | Means | What moves it out |
| --- | --- | --- |
| `pending` | Waiting for a panel; no lease. | The next claim issues a lease and moves it to `claimed`; the current attempt is the one being spent. |
| `claimed` | A panel holds the lease; it has not reserved. | Reservation → `starting`; lease expiry with **no reservation** → `pending` on the next sweep, attempt + 1, one unit of the requeue budget; a guard refusal → `blocked:<reason>`. |
| `starting` | The reservation exists; the panel may be inside `host.startSession()`. | A result report → `dispatched` (session id) or `failed` (problem); an abandonment → `failed`; the result deadline → `unconfirmed`. |
| `dispatched` | A session was created and recorded. | Terminal. Operator retry is refused. |
| `failed` | An attempt was made and produced no session. | Operator retry, under the **same run key**, attempt + 1. |
| `blocked:<reason>` | A fail-closed guard refused before any host call. The five declared causes are `project-missing`, `binding-missing`, `credential`, `policy`, `actor-not-allowed`. | Operator retry once the cause clears. Consumes no attempt and no requeue budget. |
| `unconfirmed` | A reservation exists and no result arrived before the deadline. | **Only** the two operator resolutions. Never automatic, never expires. |
| `dead-lettered` | The automatic requeue budget is spent (the sweep is the only writer in this build). | *Return to waiting*, which resets `attempt` to 1 and `requeuesUsed` to 0. |

Two rules decide most cases:

- **A claim with no reservation requeues on lease expiry**, consuming an attempt —
  a closed panel is therefore safe, and work resumes on the next mount.
- **A reservation with no result is never requeued.** It wedges to `unconfirmed`
  and waits for exactly one operator decision. The resolution *no session was
  created* is the only path that re-dispatches.

The automatic requeue budget is `MAX_AUTO_REQUEUES = 3`
(`service/poll/runs-transitions.ts`), deliberately not a setting. The sweep runs
at service start (before the first claim is served) and then every
`min(leaseMs, resultDeadlineMs) / 2` — 60 s on the defaults (120 s each).

## Audit vocabulary

Every run-scoped row carries the run's `correlationId`, `entity: { kind: 'run',
id }`, `actorSource` (`service`, `panel`, `operator`), `decision`, `reason`, and
credential-free `details`. Read a run's rows in `seq` order.

| `eventType` | Written by | Proves | `details` worth reading |
| --- | --- | --- | --- |
| `run.created` | service | A run was minted for a subject. | `subject`, `ordinal`, `deliveryIds` |
| `run.coalesced` | service | A delivery joined an open run. | `deliveryId`, `kind`, `origin`, `presentAtAuthorization`, `retained` |
| `run.migrated` | service | A pre-run queue row was adopted. | `deliveryIds`, `stateBranches`, `state` |
| `dispatch.claimed` | panel | A lease was issued. | `leaseId`, `attempt`, `leaseExpiry`, `sourceReferenceCount`, `holder` |
| `dispatch.reserved` | panel | The panel declared intent and a token was minted. | `leaseId`, `attempt`, `dispatchTokenFingerprint`, `attachmentId`, `actorPolicy`, prompt fields |
| `dispatch.result` | panel | The host call's outcome was reported. | `attempt`, `dispatchTokenFingerprint`, `sessionId` **or** `failureReason` |
| `dispatch.duplicate-report` | service | A repeated result changed nothing. | `attempt`, `state` |
| `dispatch.abandoned` | panel | A reserved attempt created no session. | `attempt`, `reason` |
| `dispatch.lease-expired` | service | A lease expired **with no reservation**. | `priorState`, `leaseId`, `leaseExpiry`, `attemptBefore/After`, `requeuesBefore/After`, `migrationRecovery` |
| `dispatch.unconfirmed` | service | The result deadline passed with no result. | `priorState`, `attempt`, `dispatchTokenFingerprint`, `deadline` |
| `dispatch.retry` | operator | A retry, or a dead-letter return to waiting. | `priorState`, `attemptBefore/After`, `causeReportedCleared`, `causeClearedSource`, `attemptReset`, `causeReport` |
| `dispatch.resolved` | operator | An `unconfirmed` run was settled. `decision` is `dispatched` or `no-session`. | `priorState`, `note`, `guidance` |
| `dispatch.refused` | service | Any run-scoped operation answered 4xx. | `operation`, `code`, `priorState`, `attempt`; the actor gate adds `bindingId`, `actorPolicy`, `deniedLogins`, `deniedAttributions`, `retainedReferences`, `referencesNotRetained`, `referencesTruncated` |
| `run.blocked` | panel | A guard refused the dispatch before any host call. | `blockedReason`, `priorState`, `guidance` |
| `run.dead_lettered` | service | The requeue budget was spent. | `priorState`, `leaseId`, `attemptBefore/After`, `requeuesUsed`, `budget` |
| `agent.verified` / `agent.mismatch` / `agent.uncompared` | panel | The post-dispatch read-back. Warn-only; no run state changes. | `sessionId`, `observedAgent`, `expectedAgent`, `note`, and for `uncompared` the `baselineProvenance` |

Notes that save a wrong conclusion:

- The **implemented** dead-letter row is spelled `run.dead_lettered`
  (underscore). The 003 vocabulary table spells it `run.dead-lettered`. Grep for
  both.
- `dispatch.refused` is not in the 003 table; it is the refusal row the
  authorization contract defines, and the actor allow-list gate reuses it with
  `code: "actor-not-allowed"`.
- A **reservation** row records the token's fingerprint (`tokfp-…`), never the
  token. A `dtk-` value appearing in the trail would be a defect.
- The three `agent.*` rows do not choose by whether an agent was seen but by
  whether a comparison was possible: a blank `expectedAgent` (the default) always
  yields `agent.uncompared`, even when the read-back itself failed.
- `blocked:credential` and `blocked:policy` are declared members of the closed
  cause set, but no guard in this build reports either: the panel names
  `binding-missing`, `project-missing` and `actor-not-allowed`
  (`src/relay-gates.ts`), and the service's block operation accepts all five. A
  run sitting in one of the other two was written by something other than this
  build's guards, so treat the document as suspect rather than hunting for a
  guard that cannot fire.
- Some rows sit outside the lifecycle vocabulary but still speak about a run:
  `tracking.ended` carries the run as entity and its correlation id, and
  `delivery.detected` is the hybrid — a delivery entity, with the run's id in the
  correlation field once the delivery has one. Rows that are genuinely not about
  a work unit keep their own identity: `account.*`, `binding.*`,
  `delivery.recovered` (a fresh id), `audit.trimmed`, and the legacy `consent`
  rows.

## Logs versus the audit

The **Logs** tab reads the service's in-memory ring through `GET /v1/logs`: at
most 1,000 lines, redacted when the line was written, holding
`{ entries, startedAt, intervalMs }`. The ring lives in the process
(`service/log-ring.ts`), so a service restart empties it and the tab says the
service restarted rather than pretending the history is continuous. Standard
output is wherever the host captured it, and may be gone.

Use each for its own question:

- **Logs** answer *what is it doing now* — scan skips, sweep passes, a quarantine
  warning, a failed append.
- **`audit.ndjson`** answers *why was this decided*, survives restarts, and is
  the record you cite.

Never present a log line as the record. If the log and the trail disagree, the
trail is the durable statement and the log is the process diary.

## Read-only routes

The panel reaches these through `host.serviceRequest()`; they are listed so you
can read what a panel request means, not so an outside agent can call them.

| Method and path | Answers |
| --- | --- |
| `GET /health` | `{ status, version, schemaVersion }` — the readiness probe; no `/v1` prefix. |
| `GET /v1/events?…` | The runs history projection, newest first, paged. |
| `GET /v1/events/pending` | The claim: leases `pending` runs (a write, despite `GET`). |
| `GET /v1/audit?correlationId=&limit=&cursor=` | Audit rows, ascending `seq`, filtered byte-identically by correlation id; `limit` maxes at 200. |
| `GET /v1/logs?limit=&cursor=` | The retained in-memory log lines; no cursor means the newest page. |
| `GET /v1/status` | The panel's Status projection (service, storage, accounts, bindings, polling). |

Every run-scoped mutation lives under `/v1/events/:correlationId/…`
(`reserve`, `dispatched`, `abandon`, `blocked`, `retry`, `requeue`, `resolve`,
`verification`) and addresses the **run**, never a delivery.
