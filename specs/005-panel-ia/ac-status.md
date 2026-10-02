# Acceptance criteria status — 005 panel-IA (T-034)

**Feature**: `specs/005-panel-ia` · **Spec**: v1.4.0 · **Recorded**: 2026-09-30 ·
**Gate**: `npm run verify` green — build → lint → typecheck → **1455 tests / 84 files**.

One row per criterion, quoted by number, with the evidence that closes it. *Met*
means an assertion exists in the offline suite; nothing here is claimed from
code inspection alone. Two rows carry a reading note where a later amendment
superseded the literal text — both notes cite the amendment.

| AC | Status | Evidence |
| --- | --- | --- |
| AC-101 | Met | `tests/tabs.test.ts` — six tabs in FR-010 order with Status active; bodies mount on first activation |
| AC-102 | Met | `tests/service-status.test.ts` — running loop ⇒ `paused: false`, future `nextPollAt`, empty `pausedReason` |
| AC-103 | Met | `tests/service-status.test.ts` — stopped loop, no active binding ⇒ `paused: true`, `null`, `no-active-bindings` |
| AC-104 | Met | `tests/service-status.test.ts` — zero/one/five bindings rowed, each with stamp, reason, and pending count |
| AC-105 | Met | `tests/service-status.test.ts` + `tests/status-tab.test.ts` — unreadable binding renders `readable: false`, never omitted |
| AC-106 | Met | `tests/status-tab.test.ts` — agent pin reads *not checkable by the panel* until a dispatch has verified it |
| AC-107 | Met | `tests/status-tab.test.ts` — unmeasured budget reads *not measured yet*, never `0 of 0` |
| AC-108 | Met | `tests/status-tab.test.ts` + `tests/handoff-dom.test.ts` — storage-blocked notice names the handoff consequence; token input stays disabled |
| AC-109 | Met | `tests/status-tab.test.ts` — unsupported surface raises the top-level notice and no tab claims operation |
| AC-110 | Met | `tests/prerequisites.test.ts` — unmet checkable prerequisite raises a notice *and* carries its own remediation line |
| AC-111 | Met | `tests/prerequisites.test.ts` — every prerequisite met and checkable ⇒ no notice |
| AC-112 | Met | `tests/bindings-ui.test.ts` — *not listed?* names the three manual routes and leaves the binding recoverable |
| AC-113 | Met | `tests/dispatches.test.ts` + `tests/dispatches-actions.test.ts` — every state gets a label, a reason, and the state table's affordance |
| AC-114 | Met | `tests/dispatches-actions.test.ts` — `pending` offers no retry and renders *waiting for a panel* |
| AC-115 | Met | `tests/dispatches-actions.test.ts` + `tests/dispatches-paging.test.ts` — `unconfirmed` offers no retry, offers Resolve, and names what to check |
| AC-116 | Met | `tests/dispatches-actions.test.ts` — `blocked:project-missing` retry disabled, project named, no budget spent |
| AC-117 | Met | `tests/dispatches-actions.test.ts` — *Return to waiting* states the attempt reset before it happens |
| AC-118 | Met | `tests/dispatches-actions.test.ts` — a refused retry renders the service's distinct reason and changes no row |
| AC-119 | Met | `tests/dispatches.test.ts` + `tests/agent-verify.test.ts` — mismatch renders a warning naming the observed agent; never blocks |
| AC-120 | Met | `tests/dispatches-paging.test.ts` — row detail lists every reference with kind, origin, link, time, late ones marked |
| AC-121 | Met | `tests/dispatches-paging.test.ts` — 250 dispatches page through with none dropped at a boundary |
| AC-122 | Met | `tests/dispatches-paging.test.ts` — an empty filter match says so and offers *Clear filters* |
| AC-123 | Met | `tests/bindings-prompt.test.ts` (cross-tab authority) + `tests/containment-proof.test.ts` — exactly one element carries the prompt; the row shows presence and length only |
| AC-124 | Met | `tests/bindings-prompt.test.ts` — a credential-shaped prompt is refused with a field-level remediation and the previous one stays in force |
| AC-125 | Met | `tests/bindings-removal.test.ts` — a refused submission leaves every other binding byte-identical |
| AC-126 | Met | `tests/bindings-removal.test.ts` + `tests/render-a11y.test.ts` — the first click arms, names the cascade, and sends nothing |
| AC-127 | Met | `tests/bindings-removal.test.ts` — a removed account's bindings render present, disabled, each stating the reason |
| AC-128 | Met | `tests/accounts-ui.test.ts` + `tests/service-accounts.test.ts` — an upstream login rename updates the login and leaves `displayName` alone |
| AC-129 | Met | `tests/accounts-ui.test.ts` + `tests/containment-proof.test.ts` — no credential member, and a planted token stays out of every rendered string and storage value |
| AC-130 | Met | `tests/accounts-ui.test.ts` + `tests/service-accounts.test.ts` — credential-shaped display name refused by field and remediation; previous value stays |
| AC-131 | Met | `tests/tabs.test.ts` + `tests/panel-state.test.ts` — the runtime opens on Status and the active tab is never persisted |
| AC-132 | Met | `tests/settings-rows.test.ts` + `tests/about-tab.test.ts` — with the service unreachable both tabs keep static content and name what could not be read |
| AC-133 | Met (reading note) | `tests/about-tab.test.ts` — About renders the service's `SERVICE_VERSION`, which equals `package.json`; the *one* version literal in the product is the service's own, and the panel source carries **zero** (FR-074 forbids the panel any literal of its own; the AC's "one" is the product-wide count) |
| AC-134 | Met | `tests/about-tab.test.ts` — unreachable ⇒ exactly `unknown (service unreachable)`, no digit on the version line |
| AC-135 | Met (reading note) | `tests/settings-rows.test.ts` — every field the document carries renders with value, unit, bounds, and **zero input controls**; the row count follows the document (13 today), per 005 v1.3.0 handing the count criterion to 006 AC-101 |
| AC-136 | Met | `tests/lifecycle-proof.test.ts` — one armed loop survives a mid-flight switch; one `host.startSession`, no second claim |
| AC-137 | Met | `tests/lifecycle-proof.test.ts` — after visiting every tab, teardown returns nodes, timers, and registries to their pre-mount values |
| AC-138 | Met | `tests/containment-proof.test.ts` and the whole suite — fake host, loopback service on temp dirs, fixture credentials; no live host, token, or network |
| AC-139 | Met | `tests/bundle.test.ts` + every wave commit of this feature — both bundles rebuilt and committed with their sources, verify green |
| AC-140 | Met | `tests/vocabulary.test.ts` (six tabs + README, mapping exempt) + `tests/docs-sync.test.ts` (both documents, mapping exempt) |
| AC-141 | Met | `tests/handoff-dom.test.ts` + `tests/manifest.test.ts` + `tests/service-verify.test.ts` — empty input ⇒ `expectedLogin: null`, mismatch refused fail-closed, manifest declares no setting |

**Summary**: 41 of 41 met, none deferred. Two rows (AC-133, AC-135) are met
under the reading their own amendments prescribe rather than under the
literal v1.0.0 wording; both notes name the amendment that superseded the
literal text.

## Notes

**The six retained *the run* sentences are correct (005 T-036(c)) — a
pre-PR review must not re-open them.** Two grounds, both normative:

1. **`run` is an L4 domain term.** FR-022 retains `run`, `run key`,
   `run ordinal`, and `attempt` verbatim, and FR-027 keeps the audit entity
   `run` and the fourteen lifecycle row names unchanged. Domain prose that
   says *the run* is the domain vocabulary FR-028's mapping rule protects,
   not a retired L1 noun.
2. **Service copy renders verbatim.** The panel renders the service's
   refusal verdict and its stored reason lines as the service wrote them
   (FR-046: *the panel renders the service's verdict; it does not predict
   it*), so a sentence the service produced may carry the domain word
   whatever the L1 rename did to the tab names.

Nothing about that reading loosens the vocabulary guard:
`tests/vocabulary.test.ts` still scans the six tabs' rendered output and
`README.md` outside the mapping table for the retired nouns — *Runs*,
*Repositories*, noun-shaped *Run*, and article + *run* — and still finds
none; the exemption list is exactly one string, About's short mapping form.

---
Generated-By: opencode (model: mimo-v2.6-flash)


## Amendment note — 2026-10-01 (acceptance evidence consolidated; spec v1.8.0)

The mappings above are the record of *what proved what* when this feature was
accepted. The suite behind them was consolidated on 2026-10-01 by product-owner
order for change efficiency: **1441 tests → 532**, across the same 101 files.

Nothing above stops being true — every criterion still has a proof — but a
criterion may now be discharged by a **representative or table-driven case**
rather than by a dedicated `it()`, and exact-wording pins were dropped where
the wording is not itself a requirement. Where a row cites a per-string
assertion, read it as citing the *behaviour* the string carried.

**Functional requirements, security rules, and AGENTS.md's invariants are
untouched.** The three security-floor proof files (`crash-permutations`,
`dispatch-end-to-end`, `redaction`) were excluded from the consolidation.
