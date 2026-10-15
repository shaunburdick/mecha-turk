# Challenge ledger

## Gate 1 — Specify · 2026-10-05 · v1.19.0 amendment

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Add a visual-only field-manual treatment to the existing six-tab rail, preserving labels, controls, states, associations, and narrow-width behavior. | High | Styling can improve scan hierarchy without introducing a new interaction or changing the panel's established information architecture. |
| 2 | Keep the panel on host semantic theme aliases/fallbacks rather than copying site colors. | High | The extension is hosted in OpenChamber and must follow the host's dynamic theme; reusing site hex values would create a third, disconnected palette. |
| 3 | Preserve keyboard/focus and narrow rail behavior, with explicit contrast tests under light, dark, and alias-unavailable fixtures. | High | A new style can make existing focus/state cues illegible, so testing the actual host fixtures and fallback is a direct guard against the principal regression. |
| 4 | Require decorative indices/motifs to be static and non-semantic, with no runtime, control, capability, storage, or wire changes. | High | Decorative CSS can deliver the approved concept without expanding the extension's runtime or compatibility surface. |
| 5 | Synchronize the panel guide with 007 v1.5.0 and keep the site and panel as separately owned palettes. | Medium | A shared design guide should describe implementation truth without implying shared colors or a shared runtime theme. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | Style-only adaptation of the editorial direction within the six-tab rail. | High | DEFENDED | Product-owner intent in the handoff explicitly approves the field-manual concept and requires preserving the six tabs, controls, state/text semantics, and narrow rail. FR-130 and 005 AC-158/160 make those boundaries reviewable; no new user-facing behavior is required. | Verify all six tabs in the visual harness at 720px/560px. |
| 2 | Keep panel colors mapped to host aliases/fallbacks and prohibit site palette literals. | High | DEFENDED | FR-130 directly binds colors to existing OpenChamber semantic aliases/fallbacks and forbids copied site hex values. The code confirms `panel/index.html` defines `--mt-*` aliases over host semantic tokens, while the site's `layout.astro` owns distinct palettes. | Verify the host light/dark and alias-unavailable fixtures; scan panel styling for site palette literals. |
| 3 | Preserve keyboard/focus, state text, tab-body association, and narrow-width usability; add explicit contrast thresholds. | High | DEFENDED | Existing FR-082 already requires keyboard operation, visible focus, association, and narrow-rail access; FR-130 retains these. NFR-107 makes 4.5:1 normal text, 3:1 large text and meaningful focus/control boundaries explicit in three host fixtures; AC-159 specifies measurements and negative cases at 320px/560px. This adds verification, not a relaxation. | Run AC-159 against the deterministic fixtures and preserve existing keyboard/association assertions. |
| 4 | Keep decoration static and non-semantic; forbid runtime/control/capability/storage/wire changes. | High | DEFENDED | FR-130 and AC-160 expressly preserve semantic headings and state labels and bar animation and integration changes. `src/style.ts` is structural and `panel/index.html` is the specified CSS boundary, consistent with the actual source split and AGENTS.md invariants 1, 3, 4, 8, 9, and 10. | Confirm no structural/source or product integration changes are introduced solely for decoration. |
| 5 | Treat 007 v1.5.0 as the matching site/design-guide amendment without making the site and panel a shared palette source. | Medium | DEFENDED | 007 FR-079 retains site-owned colors and 005 FR-130 retains host aliases; 007 AC-034 requires `DESIGN.md` to record separate ownership. The versions are distinct concurrent amendments (005 v1.19.0 and 007 v1.5.0), neither overwrites the other's scope. | Ensure the final guide documents both implementations and their separate color sources. |
| 6 | Preserve the documentation site's sole mapping-table home while 005's v1.19 amendment leaves other copy unchanged. | High | UNRESOLVED — author answer pending | 005 FR-029 says the table's sole home is the published site, but User Story 6 acceptance scenario 5 (spec.md line 212) still says the mapping table lives in `README.md`. This contradicts the current normative requirement and 007 FR-051. The current amendment does not identify that scenario as a historical record. | Author to clarify/update 005 User Story 6 scenario 5 so its current source agrees with FR-029 and 007 FR-051. |

### Review notes

- The existing six-tab structure and behavior are retained; 005's update is visual-only. It does not weaken the existing focus, keyboard, state-as-text, tab/body association, or narrow-width requirements.
- `panel/index.html` currently resolves panel colors through host aliases and fallback values; `src/style.ts` describes itself as structural and not a color source. The specification keeps that separation.
- No new runtime, control, capability, storage key, service route, DTO, or wire member is required. No conflict with constitution v1.3.0 or the AGENTS.md product invariants was found.
- No `[NEEDS CLARIFICATION]` marker appears in the current 005 specification. No site/panel source-of-truth conflict exists for palette ownership; the shared mapping-table home contradiction remains open as recorded above.

**Changes conceded:** None received during this leaf review.

**Assumptions to verify:** No unverified technical assumption blocks the style-only approach. Verify contrast and focus in each host-theme/fallback fixture and verify the cross-spec mapping-table location after the author resolves the stale scenario.

**Unresolved disagreements needing a human call:** None yet; the author question is pending, not a two-round disagreement.

**ADR candidates:** None. The visual treatment stays within the existing extension shell and CSS boundary and creates no architectural decision.

**Gate verdict: HOLD.** The 005 amendment cannot pass while its current User Story 6 scenario contradicts FR-029 about the sole home of the mapping table. Correct or explicitly historicalize the scenario and rerun the shared-source check. The amendment's other high-risk decisions are defended with verification plans, and no constitution conflict remains.

## Gate 1 — Specify · 2026-10-06 · v1.19.0 re-evaluation

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 6 | Keep the identifier-mapping table on the published documentation site as 005 FR-029 and 007 FR-051 specify. | High | DEFENDED | User Story 6, acceptance scenario 5 now says the mapping table lives on the published site (spec.md:212). The v1.19.0 changelog records this requirement-by-requirement correction (changelog.md:621). The prior contradiction is resolved; both feature versions and scope remain unchanged. | None. |

### Re-evaluation notes

- This re-evaluation preserves the original inventory and HOLD as history; this ruling supersedes that HOLD only.
- The rest of the v1.19.0 challenge remains defended: FR-130's panel styling is visual-only, retains the six-tab structure and existing semantics, uses host aliases/fallbacks rather than site palette values, and adds no runtime, control, capability, storage, or wire change. NFR-107 and 005 AC-158–AC-160 provide measurable visual, contrast, focus, keyboard, and narrow-width checks.
- The corrected acceptance scenario now agrees across the current 005 requirement/story and 007 FR-051. No unresolved clarification marker or further shared-source conflict blocks the gate.
- The amendment remains aligned with constitution v1.3.0 and AGENTS.md invariants. Product-owner approval and implementation/accessibility verification remain pending as the artifacts state.

**Changes conceded:** The author corrected User Story 6 acceptance scenario 5 narrowly and recorded it under the existing v1.19.0 entry; no version bump or broader scope change was made.

**Assumptions to verify:** Run the specified panel visual and accessibility checks during implementation; no additional unverified assumption blocks this specification gate.

**Unresolved disagreements needing a human call:** None.

**ADR candidates:** None.

**Gate verdict: PASS.** The only HOLD finding is resolved. All high-risk decisions are defended with verification plans, no constitution conflict remains, and this gate does not itself approve the amendment.

## Gate 2 — Plan · 2026-10-06 · v1.19.0 / linked 007 v1.5.0 amendments

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Use the actual shipped panel bundle and post-ready removal of SDK-injected theme aliases to prove CSS fallbacks. | High | The SDK writes aliases even for omitted token members, so testing after its real `ready` handling is the only fixture that establishes fallback execution without a live host. |
| 2 | Measure host-theme contrast/focus in rendered browser state across light, dark, and fallback fixtures. | High | Computed styles and keyboard focus test what operators see, while deterministic fixtures and negative cases make the thresholds reproducible. |
| 3 | Keep styling in `panel/index.html`, preserve `src/style.ts` as structural, and avoid runtime/wire/data changes. | High | The existing separation and FR-130 let the approved concept fit the rail without changing product behavior or compatibility surfaces. |
| 4 | Have 005 provide panel evidence while 007 alone edits shared `DESIGN.md`. | Medium | One owner can describe both visual systems accurately without duplicating or conflating their palettes. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | The alias-unavailable fixture removes injected aliases after SDK readiness rather than omitting tokens from `ready`. | High | DEFENDED | Research §Phase-4 follow-up records the pinned SDK evidence: `applyHostTheme` writes all `TOKEN_VARS` on every `ready`, so payload omission is not sufficient. The amended task removes aliases and inherited theme styles after `ready`, sends no subsequent `ready`, asserts absence inline and computed, and checks that representative computed values match the existing `panel/index.html` fallbacks rather than fixture values. | Execute the fixture against the shipped panel; retain the fallback-value assertions. |
| 2 | Use deterministic browser measurements and negative fixtures for panel contrast/focus without a new dependency or live host. | High | DEFENDED | 005 plan §Verification and M-002 specify three fixtures, actual rendered text/boundary/focus measurements at 4.5:1/3:1/3:1, and independently failing text/focus cases. Research §Phase-4 evidence establishes existing offline host and capture tooling; the accessibility review remains evidence, not a blanket conformance claim. | Run M-002/M-003 and keep browser/tree evidence distinct from screenshot-only evidence. |
| 3 | Keep panel styles host-alias/fallback based and visual-only; do not copy the site palette or change panel structure/runtime. | High | DEFENDED | 005 FR-130, Gate 1 precedent, and the plan preserve the six tabs, labels, controls, state text, associations, and narrow-width behavior. `panel/index.html` is the styling owner; `src/style.ts` remains structural. The plan forbids runtime, capability, storage, manifest, service, DTO, API, and wire changes, consistent with AGENTS.md invariants and constitution v1.3.0. | Verify the diff and all three theme fixtures in M-004. |
| 4 | Assign 005 panel facts to 005 and the sole shared `DESIGN.md` edit to 007. | Medium | DEFENDED | The plan/tasks give 005 M-004 responsibility to send verified values and evidence; 007 T-050 owns the edit. This preserves single-file ownership and documents separate palette sources. | Gate 3 records that T-050 must explicitly wait for M-004. |

**Constitution alignment:** v1.3.0 remains unchanged. The plan preserves Principle II's truthful state/fallback handling, IV's readable focus/state cues, V's minimal deployment, VI's verification discipline, and VII's unchanged host boundary. AGENTS.md invariants remain intact.

**Gate verdict: PASS.** The fallback and measurement choices are grounded in the pinned SDK and existing test harness, and their limits and proofs are explicit.

## Gate 3 — Tasks · 2026-10-06 · v1.19.0 / linked 007 v1.5.0 amendments

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Establish host fallback and contrast/focus checks before adapting the panel CSS. | High | The current theme surfaces can be measured red-first, so the visual change is judged against the actual accessibility floor rather than retrospectively. |
| 2 | Make the shared-guide handoff a real task dependency. | Medium | A named evidence handoff gives 007 one verified source for panel facts and avoids an informal or premature guide update. |
| 3 | Keep panel tasks CSS/harness-only and preserve the existing bundle, runtime, and wire boundaries. | Medium | The panel's published CSS is in `panel/index.html`; harness-only accessibility work does not require behavior or bundle-source changes. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | M-002's host fallback and accessibility checks are established before M-001 changes the panel CSS. | High | DEFENDED | Revised M-002 is a red-first test/harness task with no styling dependency; M-001 explicitly depends on it. M-002 is parallel-safe with 007 T-047 because the file sets do not overlap. M-003 then performs rendered acceptance on the styled panel. The earlier test-order concern is resolved. | Run the negative fixtures before M-001; retain all three host fixtures. |
| 2 | Complete M-004's evidence handoff before 007 finalizes `DESIGN.md`. | Medium | DEFENDED | Revised 007 T-050 explicitly depends on 005 M-004, and the 005/007 dependency maps both show M-004 → T-050. M-004 owns verified panel facts/source paths and responsive/accessibility evidence; 005 does not edit the guide. | Preserve the explicit handoff; no further task change. |
| 3 | Keep the panel amendment CSS-only and avoid rebuilding or changing shipped JS bundles. | Medium | DEFENDED | M-001 confines styling to `panel/index.html`; M-002 edits offline visual tooling/tests; M-004 checks that no bundle source changed and runs root verification. The tasks prohibit runtime, service, manifest, capability, storage, data, or wire changes, consistent with FR-130 and AGENTS.md invariants. | No bundle change is expected; verify the diff at M-004. |

**Gate verdict: PASS.** Test-first ordering and the shared-guide dependency are explicit, task scopes remain within the approved panel-only amendment, and no constitution conflict or reopened history remains.

## Gate 3 — Diff · 2026-10-15 · v1.21.0 startup resilience (branch `startup-resiliancy`, docs 809c118 + implementation c01f0dc)

### Rulings on the material decisions in the diff

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
| --- | --- | --- | --- | --- | --- |
| 1 | Five-stage runner with one catch per stage, routed by shell-completion, console entry before the surface, gate fields cleared whenever a runtime exists. | High | DEFENDED | `src/bootstrap.ts` + `src/startup.ts:184-202` implement plan N.5.1/N.5.8; `tests/startup-bootstrap.test.ts:187-220` proves a half-built shell (root already recorded) still renders to the static notice and tears down; `settleReconciliation` still has exactly one caller (`src/app.ts:272`), so no failure path can open the gate. | none |
| 2 | FR-144 same-CSPRNG fallback (`getRandomValues` UUIDv4, arithmetic bit-setting under `no-bitwise`), refusal only when both APIs are absent. | High | DEFENDED | `src/ids.ts:40-106`; byte-level equivalence of `% 16 + 64` / `% 64 + 128` to the mask-or forms is exact (no bit overlap); `tests/ids.test.ts` pins UUIDv4 over 8 distinct ids, shape parity, the refusal as a test-file literal, and a comment-filtered `Math.random` scan. Service bundle bytes move with the shared module — allowed by the Not-doing list; no service `.ts` change. | none |
| 3 | Full, verbatim failure text (no sanitization) rendered through `textContent`/SDK `setText`. | High | DEFENDED | Owner decision 1 (clarification row 62) and the Not-doing ruling; `buildFailure` (`src/startup.ts:150-155`) extracts `cause.message` without `describeError`; SDK `mountBanner` paints with `setText` (`node_modules/@openchamber/sdk/dist/ui/banner.js:19-20`) and sets `role="alert"` on `tone: error`. | none |
| 4 | SC-117 / tasks N-06 and N-10 promise an assertion of **no `host.storage` write**, but two of three suites assert something narrower. | Medium | CONCEDED (unfixed) | `tests/startup-async.test.ts:313-315` asserts an *exact* `set:` list (strong — any extra write fails), `tests/startup-bootstrap.test.ts:122` asserts zero writes, but `tests/startup-milestones.test.ts:268-271` asserts only key *membership*, and N-06/N-10's scope cells still say "zero / no `host.storage` write". A startup record written under an existing documented key on the success path would pass. | Either snapshot the operation count before `begin` and assert no growth, or amend N-06/N-10's scope/Done cells to state the deviation the delivered assertion actually makes. |
| 5 | `changelog.md` → `### v1.21.0` rationale still says the fallback announces itself "in the structured console log **and the Diagnostics startup log**". | Medium | CONCEDED (unfixed) | The same entry records decision 3's cut of the in-panel log, `src/` writes startup milestones to the console only, and `about-diagnostics.ts` is untouched — the sentence is residue of the pre-cut draft and contradicts the entry beside it. `pm-handoff.md:10,11` carries the same stale "Diagnostics panel" / "console/Diagnostics-side" wording. | Drop "and the Diagnostics startup log" (changelog) and the two pm-handoff phrases through the amendment path; the file is Phase-1–3 frozen. |
| 6 | N-11's red-first line "`tests/ids.test.ts` 4/5 red against the pre-change `src/ids.ts`". | Low | DEFERRED | The other evidence lines reconcile exactly (123 test files; 5 suites / 16 tests; N-07 5 tests; N-09 5 tests with zero timers/sessions/writes; N-10 3 tests; bundles contain the new code). This one cannot be reconciled from the tree: reverting `src/ids.ts` removes the `correlationIdMode` export the suite imports, so the file fails at collection rather than 4-of-5. Not re-runnable here — node/npm are denied in this sandbox. | Re-run the red once and restate the figure, or say which partial revert produced 4/5. |

### Cut list (Gate 3)

1. **`tests/support/dom.ts:34-43` and `:224-230` — the `@param`/`@returns`/`@throws` tag lines** that restate `querySelector`/`prepend`'s signature. Year cost: ~6 comment lines in a test double that must be re-read whenever either method changes; `AGENTS.md` issue #41 says test-dir comments are where bloat returns and that signature-restating JSDoc is deletion-worthy. CONCEDED — the plan asked for the two methods, not their tag blocks.
2. **`tests/startup-bootstrap.test.ts:112-115` / `tests/startup-async.test.ts:200-203` — a second copy of `textOf` with an identical doc comment**, both new in this block. Year cost: two copies to keep in step with the double, two copies of one sentence. CONCEDED — one copy in `tests/support/dom.ts` serves both; nobody asked for two.
3. **`panel/index.html` — `#panel-startup-notice p:first-child { font-weight: 600; }`.** Year cost: one more notice-scoped declaration for the field-manual hierarchy rules to stay consistent with. Nobody asked for it — FR-140 requires name/statement/instruction visible and accessible, and plan N.9 explicitly claims no contrast or hierarchy floor for this element.

**Gate verdict: PASS WITH CHANGES.** Every acceptance criterion is proven by a named test and asserting code, every hunk traces to plan §N or a declared deviation, and no Not-doing item came back; two record-level corrections (rulings 4 and 5) must land before merge, and ruling 6 needs one re-run or one restated figure.

**Resolution (2026-10-15, follow-up commit on this branch):** ruling 4 — N-06/N-10's scope cells amended to the delivered assertions (exact one-element `set:` list; key-set membership) with the reason; ruling 5 — "and the Diagnostics startup log" dropped from the changelog and both stale pm-handoff phrases deleted; ruling 6 — re-run 2026-10-15: reverting `src/ids.ts` gives **4 failed / 1 passed**, so the recorded 4/5 figure holds (vitest resolves the missing `correlationIdMode` export to `undefined` rather than failing at collection). The whole cut list landed: both JSDoc tag blocks trimmed, `textOf` consolidated into `tests/support/dom.ts`, the `font-weight` rule deleted. Also from the peer review: the failure renderer (`recordStartupFailure`) and the teardown call (`runStartup`) are now guarded so a throwing surface or disposer cannot escape `begin`/`runStartup` — each guarded by a test that fails without the guard. Every over-cap comment block in the branch's own diff was trimmed to ≤4 lines / ≤400 chars. The AC-166 "same harness" wording (peer-review item 5f) was corrected in the changelog's AC-166 cell: the two mints share `tests/ids.test.ts`'s stubbing technique, not one drive; the full-criteria halves run in separate suites.
