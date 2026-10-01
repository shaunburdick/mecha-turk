/**
 * The operator-facing vocabulary mapping and the shapes it renders as (005
 * FR-029).
 *
 * **One home for the retired nouns.** {@link VOCABULARY_SHORT_FORM} is the
 * only literal in `src/` that may carry *Runs* or *Repositories*, so the L1
 * scan (`tests/vocabulary.test.ts`) can exempt it — and the two shapes below
 * that are derived from it, never restated — and refuse every other string the
 * six tabs hand the SDK. The full table lives in `README.md`.
 *
 * It lives apart from [`about-tab.ts`](./about-tab.ts) because it is
 * panel-wide copy with a build gate of its own, not a piece of the About tab's
 * view — and because that module was already sitting on the file-length cap
 * when the mapping became a list.
 */

import type { ListItem } from '@openchamber/sdk/ui';

/**
 * The vocabulary mapping in short form (FR-029).
 *
 * One exported string on purpose: the L1 vocabulary scan
 * (`tests/vocabulary.test.ts`) exempts exactly this value and the lines
 * {@link VOCABULARY_LINES} and {@link VOCABULARY_ITEMS} divide it into, and
 * nothing else.
 */
export const VOCABULARY_SHORT_FORM =
    'Vocabulary (what the renames mean):\n' +
    '- Dispatches — the unit of work a binding queues (earlier builds called it Runs).\n' +
    '- Bindings — the watched-repository configuration (earlier builds called it Repositories).\n' +
    '- Kept as they are: run, attempt, and the run. / binding. audit prefixes (domain words).';

/** The mapping split at the line breaks it is written with; the constant owns every word. */
export const VOCABULARY_LINES: readonly string[] = VOCABULARY_SHORT_FORM.split('\n');

/**
 * The mapping's heading: the line above its entries, and the list's own
 * accessible name.
 *
 * Read off the constant rather than written again, so the mapping's words
 * keep exactly one home (FR-029). The fallback is the whole mapping — a value
 * no test would let render twice — and exists only because an indexed read is
 * `string | undefined` under `noUncheckedIndexedAccess`.
 */
export const VOCABULARY_HEADING: string = VOCABULARY_LINES[0] ?? VOCABULARY_SHORT_FORM;

/** The bullet marker the mapping's own lines carry, lifted into the list's lead cell. */
export const VOCABULARY_BULLET = '-';

/**
 * The mapping as the list renders it: marker in the lead cell, words in the
 * title.
 *
 * Derived rather than restated, so no retired noun can enter `src/` through a
 * second literal — which is the whole of FR-029's "the only place" rule.
 */
export const VOCABULARY_ITEMS: readonly string[] = VOCABULARY_LINES.slice(1).map(
    (line) => (line.startsWith(`${VOCABULARY_BULLET} `) ? line.slice(VOCABULARY_BULLET.length + 1) : line),
);

/**
 * The mapping as the About tab mounts it: one list row per entry, the marker
 * in the lead cell and the words in the title, keyed so the list cannot
 * collide (FR-080).
 */
export const VOCABULARY_LIST_ITEMS: readonly ListItem[] = VOCABULARY_ITEMS.map((line, index) => ({
    id: `vocabulary-${index}`,
    leading: VOCABULARY_BULLET,
    title: line,
}));
