# Changelog

All notable changes to Mecha Turk are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`version` in `package.json` is the single version the product ships: OpenChamber
compares an installed copy against it to decide whether to offer an update, and
`SERVICE_VERSION` mirrors it for the panel's About tab. A release is the tag
`v<version>`, cut by `.github/workflows/auto-tag.yml` when a bump reaches
`main` and published by `.github/workflows/release.yml`, whose body is the
matching section below plus GitHub's generated notes.

## [Unreleased]

### Added

- **Wider event detection** (#61). A review requested again on a pull request
  the agent is already working now reaches that session as a follow-up keyed by
  the request event's own id, instead of a trigger the queue would dedupe away.
  Only a request strictly newer than the run-establishing one counts, so the
  overlap window cannot prompt twice for the same request. Inline review
  comments — a feed separate from conversation comments — now produce mentions
  and follow-ups when they name the bound account or move a tracked pull; a
  mention links to its run as a `review-comment:<id>` source reference.
  Detection adds one `since`-windowed read per mention-enabled binding, and the
  cycle keeps its conversation-feed findings when that read fails.
- **Submitted reviews and failing checks reach the session** (#61). A
  changes-requested review on the account's own open pull request opens one
  dispatch with the reviewer as its actor, and on a pull the agent is already
  working becomes a follow-up only when it is strictly newer than the request
  that started the run. Both are binding switches. Detection costs one
  bounded reviews read per own pull in the window; a truncated read records
  the truncation and produces no row. (The CI half of this cut now reads as
  the watch below, #62.)
- **CI failures on a tracked head are watched, not guessed** (#62). A tracked
  pull's check suite is armed silently at the head a cycle observes, then
  polled at most once per cycle for up to 30 minutes or 30 reads. One
  `CI failed: <names>` follow-up is raised only when every check run has
  completed and at least one failed: a pending run is waited for,
  `success`/`neutral`/`skipped`/`cancelled` is silence, and one head alerts at
  most once. A missing `Checks: read` scope audits once per binding and never
  stops assignment, review, or mention polling; an inconclusive watch expires
  with its own audit row. The failing-check id is now
  `~followup~checks~<headSha>`, and `Checks: read` joins the token
  prerequisite when the Checks switch is on.

### Fixed

- **The session-naming instruction now opens the dispatch frame** (#66). The
  naming rule moves out of the header metadata into a `SESSION TITLE` block
  that leads the frame — an imperative, the `"Issue #n: <subject>"` format
  (pull requests: `"PR #n: <subject>"`), the ~60-character budget, the
  default `mt-run-…` title named as not acceptable, and the rename mechanism
  itself (`tools.opencode.session_rename` through `execute`, `sessionID`
  omitted to rename the calling session) — so a dispatched agent meets it as
  a step rather than a skippable rule line, and reaches the right tool when
  it does. The block is literals only: the issue title stays on the defused
  `Issue #n:` data line, and follow-ups do not gain it.
- **The bound account's own comment no longer wakes its own session** (#65).
  Comment, issue-body, and inline-review-comment authorship now refuses the
  binding's own login — compared case-insensitively, per bound account — so a
  mention or follow-up is never detected from the text Mecha Turk's own account
  wrote, which could otherwise sustain its own loop.

## [0.4.1] - 2026-10-19

### Fixed

- **Dispatched sessions arrive with a readable sidebar name** (#59). The dispatch
  frame carries one idempotent rule line asking the session's agent to name it
  `Issue #n: <subject>` (`PR #n: <subject>` for pull requests), instead of the
  session listing as `mt-run-<24hex> …`; the label is composed by the agent,
  since no machine-facing consumer reads it.

## [0.4.0] - 2026-10-16

### Added

- **A seventh Logs tab** (#57, #53). The local service's own log stream, in the
  panel instead of hunted down in stdout: the last 1 000 lines the service has
  emitted — post-redaction, byte-identical to what it printed — stay in memory
  behind `GET /v1/logs`, and the tab tails them when it opens and refreshes on
  its own cadence. It says so plainly when the service restarts, and a failed
  read names its cause with a retry rather than a blank list.

## [0.3.1] - 2026-10-15

### Added

- **This changelog**, and the automatic tag that keeps it honest: a merge to
  `main` that changes the manifest version now cuts `v<version>` and asks
  `release.yml` to publish it.

### Fixed

- **The panel no longer goes blank when startup fails** (#55, #36). A static
  notice stays on screen when the bundle fails to load, bootstrap failures turn
  into manual-recovery copy instead of an empty rail, and full-text search
  failures plus the plain-HTTP fallback no longer take the panel down with them.

## [0.3.0] - 2026-10-15

Never tagged — no GitHub Release was published for this version. Carried by
0.3.1.

### Fixed

- **Never interrupt an in-progress session** (#50, #48): dispatched items wait
  for the host to go idle before delivery, so an agent mid-task is no longer
  interrupted by the next assignment.

### Changed

- **Engine floor raised to OpenChamber 2.0.0** (#49) with `@openchamber/sdk`
  re-pinned to 2.3.1.

## [0.2.1] - 2026-10-13

Never tagged — no GitHub Release was published for this version. Carried by
0.3.1.

### Fixed

- **A binding no longer dispatches against its own account** (#47, #45):
  self-triggered assignments and review requests are refused at the dispatch
  gate instead of starting the operator's own work.

## [0.2.0] - 2026-10-11

Never tagged — no GitHub Release was published for this version. Carried by
0.3.1.

### Added

- **Run lifecycle tracking** (#43, #13): every dispatched item keeps its run's
  progress on the record, and the Status tab reports where each one stands.

## [0.1.2] - 2026-10-07

### Fixed

- **The rail icon falls back** when the panel glyph is unavailable (#40, #39),
  and the Bindings project picker no longer offers the same project twice.

## [0.1.1] - 2026-10-07

### Added

- **Project dropdowns default to the current project** (#34, #21), so binding
  and dispatch forms start where the operator is.

### Fixed

- **The Accounts add form stays available after connecting** (#37, #35) instead
  of disappearing behind the connected state.

## [0.1.0] - 2026-10-06

The first published release: the extension installable from this repository.

### Added

- **GitHub → OpenChamber dispatch.** A local service polls bound repositories
  for assignment, review-request, and mention triggers and queues durable
  events; the rail panel relays each queued event into exactly one
  `host.startSession()` call.
- **Accounts and bindings**, with credentials held in the service's own
  0700/0600 store and never sent to the panel, plus a per-binding user
  allow-list enforced at the single dispatch gate.
- **A six-tab panel** over the service's state: Status, Events, Bindings,
  Accounts, Settings, and About.
- **Layered starting prompts** (global, account, binding) and per-binding
  control over whether a new binding sees its backlog.
- **A documentation site**, published to GitHub Pages.

[Unreleased]: https://github.com/shaunburdick/mecha-turk/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/shaunburdick/mecha-turk/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/shaunburdick/mecha-turk/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/shaunburdick/mecha-turk/compare/6fabb18...v0.3.1
[0.3.0]: https://github.com/shaunburdick/mecha-turk/compare/f4d6de0...6fabb18
[0.2.1]: https://github.com/shaunburdick/mecha-turk/compare/6149804...f4d6de0
[0.2.0]: https://github.com/shaunburdick/mecha-turk/compare/v0.1.2...6149804
[0.1.2]: https://github.com/shaunburdick/mecha-turk/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shaunburdick/mecha-turk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shaunburdick/mecha-turk/releases/tag/v0.1.0
