# Research: Panel IA — Six Tabs — new findings only

**Spec**: v1.20.0 · **Amended**: 2026-10-07 (startup rendering and failure recovery; historical findings below are retained)

**Historical baseline**: `specs/005-panel-ia` v1.3.0 · 2026-09-28

This file answers only the questions **005** raises. It opens with the honest headline: **005 needs no new platform research.** Every platform fact a plan for this feature might otherwise re-open is already settled with a stamped source; those are cited, not re-researched. Two items at the end are **confirmations Phase 4 returns to the product owner** — each is decided here with a stated default, so neither blocks Phase 5, and neither is written as a clarification marker (the spec has none).

## Current amendment — startup rendering (v1.20.0)

- **Reported by the product owner**: opening the panel can show no rendered screen; a screenshot was referenced in the task but no image file was available in the workspace for inspection.
- **Observed in source**: `panel/index.html:1031` contains an empty `<div id="root"></div>` before `main.js` is loaded at `:1032`. `panel/main.ts:16-24` can throw while locating the root, calling `connectHost()`, or constructing the app, with no visible catch. `src/app.ts:339-346,359-367` starts asynchronous initialization with `void begin(...)`; `begin` has `try/finally` but no `catch`.
- **Observed in tests**: `tests/app.test.ts` does not exercise `createPanelApp`; no test pins a static initial-render fallback or bootstrap-error display. Existing read-state requirements cover errors after a tab is mounted (FR-019/NFR-111), not an empty initial root.
- **Unverified**: the exact runtime trigger for the reported blank screen. The prescribed offline screenshot harness was attempted with `npm run shot` after the project toolchain was installed; Chrome exited before startup with `No usable sandbox`, so no screenshot was produced. The sandbox was not weakened.
- **Observed verification**: Node `v24.15.0` and Bun `1.4.2` were installed only under `/tmp/opencode/mecha-toolchain` after SHA-256 checks against Node's `SHASUMS256.txt` and GitHub's Bun release asset digest; the system Node remains `v22.22.1`, and no global Bun/PATH or profile change was made. `npm ci` populated the repository's ignored `node_modules/` using a temporary npm cache. The full `npm run verify` passed: build, lint, typecheck, 113 test files / 1,550 tests.
- **Observed preview**: A temporary loopback-only static server served `panel/` to the in-app browser at a 1440×900 desktop viewport. Its snapshot showed the Mecha Turk Status view, all six tabs, and the startup overlay removed after mount. This confirms a nonblank successful browser render but does not reproduce the exact reported host launch or exercise service connectivity; no screenshot artifact was retained.
- **Decision**: add static HTML fallback content and handle both synchronous bootstrap failures and asynchronous initial setup rejection. Keep the message generic, use text-only rendering, and require operator-driven reopen; do not add host/service APIs, auto-retry, or exception-detail display.

## Settled before this feature (cited, not re-researched)

| Question | Settled by |
| --- | --- |
| `host.storage` limits (64 KiB/value, 2 MiB namespace, uninstall-wiped), and which keys exist | 002 research §R2/§R5; `AGENTS.md` invariant 4; 005 FR-025 (**no key added, none renamed**) |
| `host.storage` `last-viewed` UI state exists but is **not** used for the active tab | 002 FR-034; 005 FR-015 + Clarification row 9 |
| SDK UI list components have **no per-row actions** — row actions ride the select-then-act idiom | 002 `tasks.md` debt list ("the SDK list has no per-row actions"); 003 FR-033/FR-041 select-then-act; 005 FR-045, FR-084 |
| SDK tab primitive exists and what it provides (`mountTabs`: `role="tablist"`/`role="tab"`, `aria-selected`, roving tabindex, arrow-key navigation, `update()` repaints by clearing the track, `dispose()` removes listeners) | `node_modules/@openchamber/sdk/dist/ui/tabs.{js,d.ts}` read directly for this plan (SDK `1.24.2`, pinned exactly) — the finding that it emits **no** `id`/`aria-controls`/`tabpanel` association drives plan decision D4 |
| Guest transport limits, error envelope, bearer auth, response cap | 002 `contracts/panel-service.md` §1 (unchanged by 005) |
| Loopback service, store 0700/0600, quarantine funnel, audit writer | 002 research §R2; shipped `service/store/*`, `service/audit.ts` |
| Agent-verification mechanism, warn-only, `openSession`/`onSession().agent` | 002 research §R3; 003 FR-043 (warn-only stands); 005 FR-047 |
| **`expectedAgent`'s baseline source is now `GET /v1/config`**, with the two-case fail-closed split (missing baseline → documented default `project-manager` + provenance, run proceeds; observed mismatch/unreadable → blocks) | 002 FR-029 as amended at v1.7.0; 002 AC-021, 002 AC-023; 006 FR-100 (the field) |
| The dispatch state model, retry validity, unconfirmed resolution, dead-letter return | 003 `## Dispatch State Model` + 003 FR-041, 003 FR-042, 003 FR-033, 003 FR-027 — 005 renders them, re-specifies none (005 Clarification row 1) |
| Prompt field shape, cap, refusal, omission-preserves, fingerprint-not-text | 004 FR-010–FR-024, 004 FR-050–FR-054; 005 FR-051, 005 FR-052 render them |
| `service/config.ts` bounds, defaults, and the log-level set | 002 `service/config.ts` (`NUMERIC_BOUNDS`, `DEFAULT_CONFIG`, `LOG_LEVELS`) — read directly; they are the cross-check target for plan decision D10 |
| SDK pin, engine floor, no re-pin, no new capability | `AGENTS.md` invariants 3 and 6; 005 FR-004, FR-079 |
| Wire paths retained (`/v1/events*`, `repositories` member) | 005 FR-023/FR-026, Gate Question 1 **confirmed by the product owner 2026-09-28** — a decision, not backlog |

**No external or platform research was required for this feature.** 005 changes where the panel *puts* things and what two *read* responses contain; both halves are this repository's own code, and the one SDK surface it depends on was read at the pinned version above. Nothing below needs a network call, a live host, or a newer SDK.

## Q1 — Where the Settings tab's bounds, units, and take-effect statements come from in 005 *(confirmation requested; default decided)*

- **The problem, stated plainly.** 005 FR-071 requires every row to carry the service's value, unit, and documented bounds, and says each bound must be **the service's own, not a re-typed copy that can drift from it**. But 005's own `## Wire Surface Delta` marks the `Config` row **Unchanged by 005** — `GET /v1/config` still answers `{ config }`: ten values, no bounds, no units, no defaults, no effect classes. The mechanism that gives FR-071 its teeth is **006 FR-020–FR-022** (a schema projection read from the same declaration the validator uses), and 006's own amendment table says as much: 005's "service's own" rule *gains* a mechanism in 006. So in 005's window, the wire cannot supply the bounds, and widening the wire in 005 would contradict the delta 005 itself publishes (and collide with 006's work).
- **Decision (default, implemented unless overturned)**: 005 renders value/unit/bounds/take-effect from **one panel-side row declaration** (`src/settings-rows.ts`), and a **cross-check test** (`tests/settings-rows.test.ts`) imports `service/config.ts` and asserts that every declared bound, unit, default, and enum set matches `NUMERIC_BOUNDS` / `DEFAULT_CONFIG` / `LOG_LEVELS` exactly. The copy therefore **cannot drift silently** — a service bound change fails the build instead of printing a stale number to the operator. This is FR-071's intent (no drift that a human has to notice) met by enforcement rather than by a wire change the spec forbids at this stage; 006 FR-020–FR-022 then move the declaration onto the wire and **delete** the panel copy (006 FR-022's suite assertion makes the literals illegal from 006 onward, which is exactly the end state both specifications want).
- **Rationale**: every alternative is worse. Widening `GET /v1/config` in 005 contradicts 005's `## Wire Surface Delta` and does 006's work twice. Typing the bounds with nothing pinning them guarantees the drift FR-071 forbids. Omitting bounds fails FR-071 and AC-135 outright.
- **Alternatives considered**: (a) widen `GET /v1/config` with a `schema` member in 005 — rejected, the spec's own delta says Config is unchanged by 005 and 006 owns that widening; (b) render *bounds not reported by this service build* for every row — rejected, it fails AC-135 and tells the operator nothing the service does know; (c) escalate instead of deciding — rejected as blocking Phase 5 on a question the spec's own text already constrains to one answer.
- **Confirmation requested from the product owner**: *is the test-pinned panel-side declaration an acceptable stand-in for the service's own bounds during 005's window, given that 006 replaces it with the wire projection?* If the answer is no, the fallback is (b) — honest "not reported" bounds rows — which is a copy change, not a redesign.

## Q2 — The Settings row count once 003's config fields exist *(confirmation requested; default decided)*

- **The problem, stated plainly.** 005 FR-071 enumerates **ten** fields and AC-135 says "ten rows appear". 003's plan (its D9 / cross-feature note) adds `leaseMs` and `resultDeadlineMs` to `ServiceConfig`, and 006 v1.3.0 adds `expectedAgent` — so by the time 005's Phase 6 runs, `GET /v1/config` carries **twelve** values, and 006 will render thirteen. A tab that renders exactly ten would hide two fields the service actually holds.
- **Decision (default, implemented unless overturned)**: the tab renders **one row per field the document actually carries** — FR-071's ten get value/unit/bounds/take-effect from the declaration; 003's two get their value plus *bounds and take-effect not declared by this build* (honest unknown, never a plausible default, per FR-003/NFR-112). **No field the service holds is hidden.** The row count is therefore whatever the document holds, and the count criterion of record is **006 AC-101** — 005's own v1.3.0 amendment already hands it there.
- **Rationale**: FR-003 forbids rendering a value the service supplied as if it were absent, and forbids inventing a bound for it; 006's edge-case pattern ("a field this version does not show") applies to a field the panel does not *know* — `leaseMs` is known, it is simply not declared by 005's requirement list. The PM's own coordination note for this feature says the count is **006's concern**, which is consistent with rendering the document rather than a number.
- **Alternatives considered**: (a) hard-code ten rows and drop the extras — rejected, hides real configuration; (b) hard-code ten and add a "this build reports N fields" note — rejected, it reports a fact while withholding the values that explain it; (c) declare `leaseMs`/`resultDeadlineMs` bounds in 005's panel declaration — rejected, 005 has no requirement text stating those bounds, and inventing them is precisely the re-typed copy FR-071 forbids.
- **Confirmation requested from the product owner**: *confirm that 005's Settings tab renders twelve rows when 003's fields are present, with 003's two carrying an honest "not declared by this build", and that AC-135's "ten" is read as "the ten FR-071 names" rather than as a hard row cap.*

## Q3 — How the allow-list's editor field reaches the wire *(decided 2026-10-03; one confirmation requested)*

- **Decision**: the editor's text is parsed **panel-side** into an array (split on newlines and
  commas, trim, drop empty entries) and submitted **explicitly on every row** of the whole-file
  grant: the array when the operator named someone, the **key omitted** when they named nobody. The
  panel **never manufactures `[]`** (plan D14).
- **Rationale**: it is the only reading under which all three of 002 FR-047's states are reachable
  through **one** field with **no second control** and **no sentinel**. An absent key means unset
  ([`002/contracts/binding-allow-list.md` §2](../002-agent-event-extension/contracts/binding-allow-list.md)),
  which is what makes 002 FR-047's own refusal remediation — *"remove the field to allow everyone"* —
  actionable; a configured list that could not be removed would be a worse defect than the ambiguity
  this avoids. It also keeps 004 FR-014's rationale intact by contrast: a free-text **prompt** is
  genuinely ambiguous between *"I did not touch this"* and *"I cleared it"*, so it is preserved; a
  login **list** is enumerable, so it is not.
- **Alternatives considered**: (a) submit the parsed array verbatim, so an empty field produces `[]` —
  rejected: the operator then has **no** way to remove a list, and FR-090's "no second control" would
  have to be relaxed to permit an affordance that expresses *unset*; (b) extend 004 FR-014's
  omission-preserves to this field — rejected: it leaves unset **unreachable** on the wire, which is
  worse than (a); (c) a second control (a picker, a checkbox, a sentinel token) — rejected:
  005 AC-142 forbids a second control, and FR-004/FR-089 forbid inventing an identity API.
- **Confirmation requested from the product owner**: *confirm that 005 AC-142's "submitting `[]` is
  refused by the service" is discharged as a **service** behaviour (the route answers `422` on a body
  carrying `[]`) plus the panel's refusal-rendering path — rather than by the panel's own editor
  producing `[]`.* If the owner prefers the latter, the second control in (a) has to be permitted and
  `C-2` grows one affordance.

## Q4 — Whether an absent allow-list can be detected on the Bindings tab without the service's help

- **Decision**: yes, and by the **absence of the member**, not by a policy computation. The panel
  renders the count from `GET /v1/bindings`, renders the warning when the member is absent, and reads
  `actorPolicy` from `GET /v1/status` where it needs the service's own word. It performs **no**
  membership comparison anywhere (plan D15).
- **Rationale**: FR-076 forbids a second implementation of the rule and FR-090 forbids a client-side
  copy of it. The only judgement the panel makes is "is there a list", which is a fact about a
  rendered control rather than a policy decision — and the two coincide precisely because the
  service refuses `[]`, so an empty list cannot exist to be rendered.
- **Alternatives considered**: the panel deciding "restricted vs open" from the array it holds —
  rejected: a second implementation of a security rule, in the tier that is least trusted to enforce
  it. **No external research was required**: everything above is decided from the shipped readers and
  the two contracts already written for this amendment.

## Open items this research leaves

Two confirmations from 2026-09-28, both decided above with defaults that are safe to implement as
written: Q1 (bounds source) and Q2 (row count). Neither changes a requirement, neither reopens a gate
answer, and neither needs to block Phase 5 — if either answer comes back differently, the change is a
copy/test adjustment in one module (`src/settings-rows.ts` + its cross-check test), not a redesign.

**v1.11.0 adds one**: **Q3** (the empty-list round trip), decided above with a default and one
confirmation requested — see [plan.md §C.5](./plan.md) and
[`002/pm-handoff.md` §Flagged](../002-agent-event-extension/pm-handoff.md). Like Q1 and Q2 it changes
no requirement and needs not block Phase 5: if the answer comes back the other way, the change is one
affordance inside `src/bindings-actors.ts` and one test.

Everything else this feature touches — the tab primitive's capabilities, `host.storage`'s limits, the list component's row-action model, the dispatch state machine, the prompt field, the wire paths — was already settled by 001/002/003/004's research and contracts, and is **cited in the table above, not re-researched here**.

---

## Phase-4 findings — v1.19.0 panel visual and accessibility review (added 2026-10-06)

This append-only section records implementation-planning evidence for the approved visual-only amendment.

### Existing color ownership and test seam

`panel/index.html` currently maps panel styling through `--mt-*` aliases to the OpenChamber semantic theme variables and defines fallback values. `src/style.ts` explicitly owns structure, not color; it should remain unchanged for decoration. The offline host in `tools/visual/host.js` currently supplies two complete semantic-token payloads (light and dark) and exposes the fixture bridge used by the shipped panel. It does not yet provide an alias-unavailable fixture. The test/capture work therefore needs a bounded extension to this existing bridge so that missing host tokens exercise the actual stylesheet fallback chain; the existing fallback itself must not be replaced with site values.

### Accessibility evidence method and limits

005 NFR-107 and 005 AC-158–AC-160 already define the acceptance floor, including all thresholds, text state cues, no animation, and narrow-width operation. The local accessibility skill recommends rendered-node/accessibility-tree inspection and keyboard traversal, while cautioning that automated tooling does not establish conformance. Plan for both: deterministic contrast/focus tests against rendered computed styles in each of the three host fixtures, plus browser keyboard/accessibility-tree evidence where available. No additional WCAG conformance assertion or product behavior is added.

`npm run shot` is the existing offline proof of the shipped panel at the host's rail widths: every one of the six tabs is captured at 720px and 560px, with per-capture freshness checks. It should run after the CSS adaptation. The review also exercises 320px and 560px keyboard use; screenshots are not a substitute for focus-order or accessibility-tree checks. No site hex palette values, browser downloads, live OpenChamber, or new dependencies are needed.

The adapter/panel stylesheet and deterministic test harness are the only technical surfaces. There is no current external API, library, or framework premise to verify and no re-pin decision.

### Gate 2 follow-up — prove the fallback branch, not just a missing input (2026-10-06)

The pinned SDK implementation was checked at `node_modules/@openchamber/sdk/dist/ui/theme.js` (`@openchamber/sdk` 1.24.2). `applyHostTheme` iterates `TOKEN_VARS` and calls `root.style.setProperty(name, theme.tokens[key])` for each alias on every `ready`. Consequently, omitting token members from a synthetic `ready` payload does **not** prove the aliases are absent; the SDK still performs writes for those names.

M-002 therefore defines the fallback fixture as a post-ready condition: let the real guest SDK process `ready`, remove the injected host alias properties **and the SDK's inherited `color`, `font-family`, `font-size`, and `line-height` declarations** from the guest `documentElement`, retain only the selected `color-scheme`, and do not send another `ready`. Assert all target alias names are absent from both the inline style and computed root style. Then assert representative computed panel variables and actual elements resolve to the fallback declarations in the shipped `panel/index.html` (for example the transparent block surface and fallback text/border roles), and differ from the host fixture's token values. The fixture/test manipulates only the offline host harness; the alias/fallback declarations remain unchanged. No browser dependency, live host, or network is introduced.
