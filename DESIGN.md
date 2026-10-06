# Mecha Turk visual reference

Two visual systems ship: the OpenChamber rail panel and the documentation site.
They share a visual language, not a palette — the panel follows the OpenChamber
host theme, the site owns its own light and dark values, and neither reads
colour from the other. There is no shared runtime theme. This guide records the
implemented, locally tested state; where it and the code disagree, the code wins.

## Sources of truth

- **Panel**: [`panel/index.html`](panel/index.html) — every panel colour,
  spacing value, breakpoint, and decorative rule.
  [`src/style.ts`](src/style.ts) supplies structure (classes, layout hooks) and
  declares no colours.
- **Site**: [`site/src/layout.astro`](site/src/layout.astro) — one global style
  block holding both palettes, typography, decoration, and the responsive rules.
- **Requirements**: [`specs/005-panel-ia/spec.md`](specs/005-panel-ia/spec.md)
  (FR-130, AC-158–AC-160) and
  [`specs/007-homepage-docs/spec.md`](specs/007-homepage-docs/spec.md)
  (FR-079, NFR-004, AC-032–AC-036).

The site is exactly five static pages (landing, install, configure, use, debug)
with no client JavaScript, images, search, or remote assets. This guide adds
none of those and prescribes no future behaviour.

## One visual language

- **Technical field manual, not generic SaaS docs.** Display-scale page titles
  under a monospace eyebrow, generated section indices, editorial rules, and
  deliberate negative space.
- **Make the geometry carry the brand.** A faint drafting grid (42px on the
  site, 28px in the panel), diagonal signal traces, a compact MT mark, and a
  warm signal accent — all CSS-only decoration, none of it animated.
- **Vary the surface by purpose.** Most prose stays open on the page; key
  truths get one selective emphasis band rather than a card around every
  passage; dense configuration tables use a strong header, alternating rows,
  and monospace field labels, and scroll horizontally when they need to.
- **Typography does the navigation.** System sans headlines, monospace labels
  and indices, semantic `h1 → h2 → h3` order underneath the display scale.
- **One composition in two preferences.** `prefers-color-scheme` changes the
  site's colours only; typography, spacing, hierarchy, geometry, and table
  behaviour are identical in both.

## Site palette — site-owned, CSS-only

Seventeen semantic roles in `layout.astro`'s `:root`, the same seventeen
overridden under `@media (prefers-color-scheme: dark)`. Nothing aliases a host
token, there is no manual toggle, and only colour differs between the schemes.

| Role | Light | Dark |
| --- | --- | --- |
| `--page` / `--surface` / `--elevated` | `#f1eee5` / `#e4e9e6` / `#fbfaf6` | `#071722` / `#102732` / `#122d39` |
| `--text` / `--muted` | `#102b3d` / `#496270` | `#edf3ed` / `#b0c4c5` |
| `--link` / `--signal` | `#075c78` / `#8f341c` | `#89e5dc` / `#ff9b75` |
| `--rule` | `#a9bdba` | `#35535c` |
| `--hero` → `--hero-end` (ink ramp) | `#08263b` → `#105465` | `#061b2a` → `#0b4652` |
| `--hero-text` / `--hero-link` / `--hero-index` | `#f5f6ef` / `#a8f0e7` / `#ffad83` | `#f4f6ef` / `#a8f0e7` / `#ffad83` |
| `--code` / `--table-head` | `#e3edeb` / `#102f43` | `#0b222d` / `#061c2a` |
| `--glow` / `--trace` (wash) | `rgba(10,127,145,.15)` / `rgba(211,113,67,.26)` | `rgba(19,150,162,.18)` / `rgba(255,143,104,.22)` |

Light `--signal` is `#8f341c`, not the lighter brick it started as: the
rendered pass measured the 11px eyebrow at 4.13:1 where the page's own glow
wash reaches it, and this clears the wash (6.39:1 on `--surface`, 6.76:1 on
`--page`) while staying the same colour family. Type and measure: system UI,
`1.025rem`/`1.72` body, `68rem` centered canvas, `53rem` prose measure,
`clamp(4rem, 10vw, 7.6rem)` display title.

## Panel palette — host aliases, measured fallbacks

`panel/index.html` declares no palette. Every semantic role is an alias chain
of the form `var(--oc-*, var(--surface-*|…, fallback))`, so light and dark
follow the host and the file never learns either palette:

| Role | Declaration |
| --- | --- |
| surface / sunken | `var(--oc-elevated, var(--surface-elevated, transparent))` / `var(--oc-subtle, var(--surface-subtle, transparent))` |
| ink / dim | `var(--oc-fg, var(--surface-foreground, inherit))` / `var(--oc-muted, var(--surface-muted-foreground, #767676))` |
| line / accent / hover | `var(--oc-border, var(--interactive-border, currentColor))` / `var(--oc-primary, var(--primary, currentColor))` / `var(--oc-hover, var(--interactive-hover, transparent))` |
| font / mono / radius | `var(--oc-font, var(--font-sans, inherit))` / `var(--oc-mono, var(--font-mono, monospace))` / `var(--radius, 8px)` |
| hairline / faint | `color-mix(in srgb, var(--mt-line) 55%, transparent)` / `… 26%` |
| spacing | `--mt-gap` 12px, `--mt-pad` 14px, `--mt-space-*` 4/8/12/16px, `--mt-key-width` 13rem |

The one colour literal is `#767676`, `--mt-dim`'s last-resort fallback:
`gray` measured 3.95:1 on white and failed the 4.5:1 floor in the
alias-unavailable frame, while `#767676` clears 4.54:1 on white and 4.62:1 on
black. The root's own `padding` is 12px; `--mt-pad` (14px) is for blocks. No
site hex appears anywhere in the panel stylesheet.

## How each surface expresses it

**Panel** — the six-tab shell (Status, Dispatches, Bindings, Accounts,
Settings, About) keeps its structure, copy, state cues, and controls: grouped
blocks with monospace field-label headings, corner ticks in the accent, a fixed
drafting grid behind the content, hairline rules, and state chips that always
pair colour with a label. `src/style.ts` still supplies the reusable
structure; columns appear only at the 640px/900px breakpoints, with stacked
content in the rail and a 380px narrow adjustment. Nothing transitions or
animates.

**Site** — an oversized open title with a generated eyebrow and drafting motif,
one dark signal-edged lead surface on the landing page, numbered `h2` indices,
selective callouts on the lead and first paragraph of each section, a nav band
with a ruled active state and an MT mark, and a footer reference eyebrow.
Tables carry dark column heads, banded rows, monospace row tokens, and their
own horizontal scroller.

## Tested responsive behaviour

- **Site**: 1280 / 720 / 320 CSS px × five pages × both preferences — 30
  rendered cases, plus 20 keyboard runs at 720 and 320. At 320 there is no
  page-level horizontal scroll, the title stays inside the frame (it clamps
  below ~409px so the longest word fits), and wide tables scroll only inside
  themselves. Breakpoints are `46rem` and `30rem`.
- **Panel**: all six tabs captured at 720px and 560px, and keyboard-reviewed at
  560px and 320px in host light, host dark, and the alias-unavailable fixture —
  no sideways body scroll, no clipped text, no obscured control.

## Accessibility — floors and what was measured

Floors (007 NFR-004, 005 NFR-107): **4.5:1 normal text, 3:1 large text**
(24 CSS px, or 18.67px at weight 700), **3:1 meaningful non-text and focus
indicators**.

- **Every site build** (`site/scripts/assert-build.mjs`, wired into
  `npm run build`): recomputes the statically resolvable text/surface pairs in
  both palettes and refuses anything under 4.5:1, failing closed on a surface
  it cannot place. It does not classify responsive large text or `:focus-visible`
  — that is the browser pass's job.
- **Rendered site matrix** (`tools/visual/site-matrix.js` →
  `screenshots/site-matrix/report.json`, a git-ignored run artefact): 30 cases,
  564 measured subjects, **0 failures, 0 unmeasurable**. Tightest normal text
  4.80:1 light, 6.97:1 dark; tightest large text 7.78:1 / 8.35:1. Three
  injected low-contrast pairs (normal between the floors, large and focus below
  them) were refused in all 90 case-runs, each naming page, preference,
  colours, and ratio.
- **Keyboard** (`tools/visual/site-keyboard.js` → `screenshots/site-keyboard/report.json`):
  20 runs, 188 focus stops, 160 links, **0 findings** — every link reached in
  DOM order with an unobscured 3px `--signal` outline, one `<h1>` per page, a
  labelled `nav` landmark, no page-level overflow at 320.
- **Panel** (`tests/panel-theme-contrast.test.ts` + `tools/visual/panel-a11y.js`
  → `screenshots/panel-a11y/report.json`): text and focus measured in all three
  fixtures at the same floors, fallback values asserted rather than assumed,
  negative pairs failing with element and ratio; 36 tab/width reviews
  (6 tabs × 560/320 × 3 fixtures) with **0 findings**, every stop showing an
  indicator in whichever form the host draws one (outline or ring).
- **Decoration is static**: 0 animated elements on the site, no `animation`,
  `transition`, or `@keyframes` in the panel sheet.
- Committed gates: `tests/panel-theme-contrast.test.ts`,
  `tests/site-rendered-evidence.test.ts`, `tests/visual-tooling.test.ts`,
  `site/tests/assert-build.assertions.mjs`.

These are the specified checks, not a claim of blanket WCAG conformance, and
they are local and offline: nothing here verifies the published GitHub Pages
address, which is the separate post-merge work in
[`specs/007-homepage-docs/tasks.md`](specs/007-homepage-docs/tasks.md)
(T-039–T-045).

## Rules that keep this true

- Site colours live in `layout.astro`'s two blocks; panel colours stay host
  aliases. Never copy a site hex into `panel/index.html`, and never give the
  site a host token.
- Switching preference changes colours only.
- Every state and warning is named in text as well as colour.
- Focus stays visible, unobscured, and clear of the surface it sits on.
- Decorative indices and motifs stay decorative and still.
- 320 CSS px reflows without page-level horizontal scrolling; a table's own
  scroller is the only exception.

Check `panel/index.html` and `site/src/layout.astro` before quoting a number
here, and the two specs above before proposing a change; 007 governs the
published surface, 005 governs the panel.

## References

- [W3C Design Tokens Community Group Format (2025.10)](https://www.designtokens.org/TR/2025.10/format/) — reusable, described tokens and aliases; this guide does not call for adopting its format or adding token tooling.
- [USWDS Design Tokens](https://designsystem.digital.gov/design-tokens/) — why curated, limited scales support consistency and communication.
- [GOV.UK Design System: Develop a component or pattern](https://design-system.service.gov.uk/community/develop-a-component-or-pattern/) — start from existing usage, then research and test accessibility.
- [WCAG 2.2: Understanding Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) — 4.5:1 for normal text and 3:1 for large text.
- [WCAG 2.2: Understanding Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) — 3:1 for meaningful UI components and graphics, including state and focus cues.
