# Challenge ledger

## Gate 1 — Specify · 2026-10-05

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | Support both light and dark appearance, automatically following `prefers-color-scheme`, with site-owned colors and no host-palette dependency or manual toggle. | Medium | DEFENDED | The product-owner decision is encoded in FR-079 and L-7. CSS-only selection preserves the static, zero-client-JavaScript contract; AC-032 makes the two modes and contrast floor observable. | None. |
| 2 | Apply the 4.5:1 text contrast floor independently in both schemes and verify built output. | High | DEFENDED | NFR-004 states the floor and requires both palettes to be audited. AC-032 explicitly measures body text and links against body/footer backgrounds in each scheme; AC-033 adds browser checks across all five pages, modes, and desktop/narrow viewports. | Implementation must satisfy these checks before the feature is accepted. |
| 3 | Preserve the visual language while allowing theme-specific color values. | Medium | DEFENDED | FR-079 now names semantic roles and the relevant layout principles, and requires theme changes to affect colors only. AC-033 makes those constraints testable through computed-style comparisons and checks for reading-column width, heading hierarchy, separators, and responsive tables. | None at specification gate; verify AC-033 during implementation. |
| 4 | Keep `DESIGN.md`'s light-only description until the dark scheme is implemented, then update it with that implementation. | Low | DEFENDED | The current statement remains accurate for the unmodified site. AC-034 explicitly distinguishes current behavior from the specified future behavior and binds the design-reference update to implementation. | Update `DESIGN.md` in the same implementation change that adds dark mode. |
| 5 | Assert that no clarification placeholders remain without printing the marker token in the requirement text. | Low | CONCEDED | The author removed the self-matching literal; a scan of `specs/007-homepage-docs/` now returns no marker occurrences. | None. |

### Review notes

- The amendment is in place in the existing feature specification, retains the five-page/static/no-image/no-remote-resource constraints, and introduces no `[NEEDS CLARIFICATION]` marker.
- FR-079, NFR-004, and AC-032–AC-034 align: appearance behavior, accessibility verification, visual-language checks, and the future `DESIGN.md` update each have a corresponding testable requirement or acceptance criterion.
- No conflict with constitution v1.3.0 was found. The amendment adds no product runtime behavior or infrastructure and does not weaken any constitutional principle.
- No requirement leak requiring a technology decision was found; CSS-only selection is the explicit product-owner constraint, not an unexamined framework choice.

**Gate verdict: PASS.** The high-risk contrast decision is defended and has a verification plan in AC-032 and AC-033. No constitution conflicts remain. The specification remains pending user approval as stated in its status; this gate does not itself approve the amendment.

**Changes conceded:** Removed the literal clarification marker that contradicted the no-placeholder scan claim.

**Assumptions to verify:** None raised by this amendment. During implementation, run AC-032 and AC-033 against every page and mode, and apply AC-034 when dark appearance is added.

**Unresolved disagreements needing a human call:** None.

**ADR candidates:** None. These are scoped documentation-site requirements, and no architectural decision beyond the product owner's already-settled appearance behavior was introduced.

## Gate 1 — Specify · 2026-10-05 · v1.5.0 amendment

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Make accessibility checks measurable on the site in both color schemes and at narrow widths, including contrast, focus, keyboard access, and reflow. | High | A static site can be tested against its built output, and separate light/dark checks prevent one palette or viewport from masking a failure in the other. |
| 2 | Preserve the bold field-manual direction while distinguishing display typography from semantic heading structure and keeping decorative motifs non-semantic. | High | The approved visual concept is a product requirement; explicitly separating visual scale from document semantics retains that concept without weakening accessible structure. |
| 3 | Keep site colors site-owned and CSS/system-preference driven, with no toggle or JavaScript; do not couple the site to OpenChamber's host theme. | Medium | The site is a static, separately rendered surface, so independently owned palettes preserve the zero-script contract and avoid falsely promising host-theme integration. Prior v1.4.0 defense carries forward; no new evidence reopens it. |
| 4 | Require `DESIGN.md` to describe the completed site and panel implementation rather than the previous proposal. | Medium | One accurate reference can prevent future maintenance from treating an approved, implemented design as pending or prescribing behavior that does not exist. |
| 5 | Treat 005 v1.18.0's site ownership of the vocabulary-mapping table as consistent with 007's canonical-site requirement. | High | A single published home for operator documentation prevents the same README/site drift that motivated this feature. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 6 | v1.5.0 retains the previously defended CSS-only, site-owned system-aware themes. | Medium | DEFENDED | Product-owner intent is stated in the handoff and encoded in FR-079, NFR-004, and AC-032; it preserves the static/no-client-script contract. The v1.4.0 decision is precedent and this amendment supplies no contrary evidence. | None. |
| 7 | v1.5.0's large title treatment does not relax semantic heading order; generated indices and visual motifs remain decorative. | High | DEFENDED | FR-079 explicitly requires correctly nested semantic levels and decorative-only indices/motifs; NFR-004 retains one ordered h1 and AC-036 checks h1–h3 order, title collision/clipping, and non-semantic indices. This implements the product-approved direction rather than substituting aesthetics for semantics. | Verify AC-035/AC-036 in the built site. |
| 8 | Apply explicit contrast, focus, keyboard, and 320 CSS-pixel reflow floors to both site schemes. | High | DEFENDED | NFR-004 states 4.5:1 normal text, 3:1 large text and meaningful non-text/focus, and keyboard/reflow requirements; AC-035 exercises positive and negative contrast cases, keyboard focus, and 320px reflow. AC-032/033 continue the prior two-scheme proof. | Implement and run the specified checks; this is not a blanket WCAG-conformance claim. |
| 9 | Update `DESIGN.md` alongside finished styling/accessibility work. | Medium | DEFENDED | AC-034 makes the implementation-time update binary in scope and requires present-tense accuracy, palette ownership, sources, accessibility rules, and tested responsive behavior. The current guide's proposal/pending language is explicitly superseded by that required update, not presented as a finished-state description. | Update and review `DESIGN.md` with implementation. |
| 10 | 005 v1.19.0 and 007 v1.5.0 can treat the published site as the one home of the mapping table. | High | UNRESOLVED — author answer pending | 005 FR-029 now assigns the table to the published site, consistent with 007 FR-051. But 005 User Story 6, acceptance scenario 5 (spec.md line 212) still says the mapping table lives in `README.md`. That is a direct contradiction in the current shared source, not merely a stale historical plan. | Author to clarify/update 005's current scenario so its stated home matches FR-029 and 007 FR-051; then rerun this cross-artifact check. |

### Review notes

- The v1.4.0 defended decisions were carried forward without reopening: no contrary evidence was supplied. The v1.5.0 revision addresses the ambiguous “restrained heading hierarchy” phrase without removing semantic heading order or the color-only theme delta.
- The amendment preserves the five-page, static, zero-client-JavaScript, no-image, no-remote-resource/request constraints; it adds no runtime behavior, infrastructure, or product data migration.
- No `[NEEDS CLARIFICATION]` marker appears in the 007 specification. Constitution v1.3.0 remains unchanged; the amendment aligns with Principle VI and does not weaken any invariant.
- The shared-source contradiction in 005 prevents a clean consistency ruling for 007's claim that the site is the mapping table's canonical home.

**Changes conceded:** None received during this leaf review.

**Assumptions to verify:** The author must resolve whether 005 User Story 6 scenario 5 is intended as current behavior or historical record; verify by making its status explicit and ensuring the current normative text names the site as the sole home.

**Unresolved disagreements needing a human call:** None yet; the author question is pending, not a two-round disagreement.

**ADR candidates:** None. These are presentation and accessibility requirements within existing site/panel architecture.

**Gate verdict: HOLD.** The high-risk 007↔005 shared-source decision cannot pass while 005's current scenario names README as the mapping-table home contrary to 005 FR-029 and 007 FR-051. Fix or explicitly historicalize that scenario, then recheck the two specs. All other high-risk decisions are defended with acceptance verification plans.

## Gate 1 — Specify · 2026-10-06 · v1.5.0 re-evaluation

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 10 | 005 v1.19.0 and 007 v1.5.0 use the published site as the sole home of the identifier-mapping table. | High | DEFENDED | The author corrected 005 User Story 6, acceptance scenario 5 at spec.md:212 to say the table lives on the published site, consistent with 005 FR-029 and 007 FR-051. 005 changelog.md:621 records the correction. The mapping-table source-of-truth conflict that caused the prior HOLD is resolved without changing either version or scope. | None. |

### Re-evaluation notes

- This re-evaluation preserves the 2026-10-05 inventory, prior defended decisions, and the original HOLD entry as history; this ruling supersedes only that HOLD.
- The 007 v1.5.0 and 005 v1.19.0 versions remain unchanged and submitted for approval. The correction is narrowly recorded within 005's existing v1.19.0 changelog entry.
- The v1.5.0 site requirements remain measurable and aligned: system-aware CSS-only site-owned themes, separate semantic hierarchy and display styling, decorative-only motifs, both-scheme contrast/focus checks, keyboard access and 320px reflow, and implementation-accurate `DESIGN.md` requirements. The five-page/static/no-script/no-image/no-remote-resource constraints remain intact.
- Both specifications remain aligned with constitution v1.3.0 and the applicable AGENTS.md invariants. No unresolved clarification marker or further shared-source contradiction blocks Gate 1.

**Changes conceded:** The author made the narrowly requested correction to 005 User Story 6 acceptance scenario 5; no version bump or broader scope change was made.

**Assumptions to verify:** None newly raised. The specified accessibility and `DESIGN.md` checks remain implementation acceptance work, not an approval claim.

**Unresolved disagreements needing a human call:** None.

**ADR candidates:** None.

**Gate verdict: PASS.** The only HOLD finding is resolved. Every high-risk decision is defended with a verification plan, no constitution conflict remains, and this gate does not itself approve either amendment.

## Gate 2 — Plan · 2026-10-06 · v1.5.0 / linked 005 v1.19.0 amendments

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Split site accessibility evidence between a bounded built-output parser and rendered browser measurements. | High | A small parser can reliably cover static emitted pairs while a real browser measures responsive typography, pseudo-state focus, and gradient pixels without pretending a custom parser is a CSS engine. |
| 2 | Prove the panel's missing-alias fallback by clearing injected SDK theme styles after `ready`. | High | The fixture tests the actual shipped fallback cascade after the SDK has run, without a live host or new dependency. |
| 3 | Give 007 ownership of the shared `DESIGN.md` update while 005 supplies verified panel evidence. | Medium | One guide editor avoids divergent copies; the guide can describe both surfaces once their implementation evidence exists. |
| 4 | Keep the amendments presentation-and-verification only, preserving five static site pages and the existing six-tab panel with no runtime/wire/data change. | Medium | The approved visual work is served by existing CSS and offline harnesses; expanding the product boundary adds no required user outcome. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | Use the static site-output parser only for pairs it can resolve, and a browser for responsive type, focus, and gradient-backed contrast. | High | DEFENDED | 007 plan §Scope/§Verification and research §11.4 explicitly bound the parser to normal text/static pairs and 4.5:1; it rejects unresolvable backgrounds. The browser path uses `getComputedStyle` after keyboard focus, WCAG's 18pt/14pt-bold large-text boundary, and screenshot pixel sampling for gradients. Independent low-contrast normal, large, and focus/non-text fixtures must fail with colors and ratios. A full CSS parser was rejected as an unfaithful browser engine. | Execute the specified offline matrix and preserve per-pair failure evidence. |
| 2 | Exercise panel fallbacks after the pinned SDK has applied its normal theme. | High | DEFENDED | 005 research §Phase-4 follow-up cites SDK 1.24.2 `applyHostTheme` writing every `TOKEN_VARS` alias on `ready`; omitting payload members would not test fallbacks. The plan/tasks now remove injected aliases and inherited theme properties after `ready`, send no second event, assert aliases absent inline and computed, and compare computed panel styles to the unchanged CSS fallback declarations. | Execute the fixture against the shipped bundle; no new dependency or live host. |
| 3 | Keep the site palette site-owned, the panel on host aliases/fallbacks, and decoration/runtime scope unchanged. | High | DEFENDED | 007 FR-079 and 005 FR-130 plus Gate 1 precedent require separate color ownership, a color-only site scheme delta, static decoration, and no panel runtime, capability, storage, or wire changes. The amendments' plans/tasks preserve those boundaries and cite `panel/index.html` versus `site/src/layout.astro`; `src/style.ts` stays structural. No contrary evidence was supplied. | Verify the declared invariants in T-051 and M-004. |
| 4 | Assign one shared `DESIGN.md` edit to 007 after both visual evidence streams. | Medium | DEFENDED | The plans agree 007 T-050 owns the guide; 005 M-004 supplies panel values and evidence, while 005 does not edit the guide. This avoids two competing owners and preserves the approved separate palettes. | Gate 3 records the missing explicit T-050 dependency on M-004; correct before execution. |
| 5 | Keep the accessibility check and visual matrix within existing offline tools, without adding a browser/parser dependency. | Medium | DEFENDED | 007 research §11.2/§11.4 and the plans identify the existing local browser wrapper, PNG decoder, and `agent-browser` visual harness. The measurement split is explicit about its limits; Lighthouse is supplementary and no hosted browser or tool installation is required. | Run the local tooling; record environmental limits without skipping acceptance checks. |

**Constitution alignment:** v1.3.0 remains unchanged. The plans preserve Principles II/IV through truthful, readable state/focus cues; V through no added product infrastructure; VI through measurable verification before acceptance; and all applicable AGENTS.md boundaries. No constitution conflict remains.

**Gate verdict: PASS.** The two formerly open measurement choices are now supported by repository/tool evidence and explicit limits, with verification plans. No high-risk decision remains open.

## Gate 3 — Tasks · 2026-10-06 · v1.5.0 / linked 005 v1.19.0 amendments

### Ranked decision inventory

| Rank | Decision | Risk | Steelman |
|---:|---|---|---|
| 1 | Establish the new contrast/fallback checks before the CSS adaptations they guard. | High | Red-first checks make accessibility failures observable before the appearance change can conceal them. |
| 2 | Require the panel evidence handoff before finalizing the shared `DESIGN.md`. | Medium | The guide is a shared output, so it should not be authored until the named panel facts and evidence are verified and delivered. |
| 3 | Keep site tasks limited to site CSS/evidence plus the single shared-guide edit, without reopening T-039–T-045. | Medium | This preserves the approved scope and leaves external/post-merge obligations with their original tasks. |

### Cross-examination and rulings

| # | Decision | Risk | Verdict | Defense or reason | Follow-up |
|---|---|---|---|---|---|
| 1 | Red-first accessibility checks precede the styling changes they verify. | High | DEFENDED | Revised tasks order T-047 before T-046 and 005 M-002 before M-001. Both test tasks own disjoint files and can run in parallel; each style task waits for its tests. Browser/rendered checks then follow the site and panel styling. This resolves the earlier task-order concern without weakening any criterion. | No ordering change remains. Run the red-first fixtures before styling. |
| 2 | T-050 waits for verified panel evidence, and final T-051 waits for shared-guide completion. | Medium | DEFENDED | T-050 now depends on 005 M-004 as well as site evidence. M-004 is the explicit panel-facts/evidence handoff. T-051 also names M-004 and depends on T-050. Both plan/task maps show the same acyclic order. | No dependency change remains; preserve the handoff and same-PR guide requirement. |
| 3 | Keep the amendment task scope separate from prior 007 follow-ups and completed task history. | Medium | DEFENDED | The task block explicitly leaves T-001–T-045 unchanged and T-039–T-045 separate; T-051 expressly does not claim those post-merge/repository-authority checks. The traceability table covers the new visual, accessibility, guide, and static-site boundaries. | No earlier task is reopened. |

**Gate verdict: PASS.** New accessibility tests precede the styling they guard, the shared guide waits on the designated panel evidence handoff, all amendment criteria trace to tasks, and no constitution or scope conflict remains.
