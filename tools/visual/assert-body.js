/**
 * The capture's fifth freshness check: which tab body the layout shows.
 *
 * The strip's pill is the element `verify.js` measures, and the pill sits
 * outside the scroller — so a run could validate the right pill over the
 * wrong body whenever all six bodies shared the layout, which is exactly how
 * a Settings-labelled frame shipped over the Dispatches board. This reads
 * `getComputedStyle` for every body in the live document, insists the ones the
 * shell hid are really out of the layout, and proves the one body with a box
 * is the one the selected tab labels. The same question is then asked of every
 * *other* `[hidden]` element: a stray control the panel hid but the cascade
 * still paints fails the run too. `shot.js` calls it after the probe and
 * before the capture, so a mismatch aborts the run instead of publishing.
 */

/** One body as the report names it: id, cascade display, and box height. */
function describeBody(body) {
    return `${body.id} display=${body.display} height=${body.height}px`;
}

/** Several bodies, named the same way, or the word `none` for an empty list. */
function listBodies(bodies) {
    if (bodies.length === 0) {
        return 'none';
    }

    return bodies.map(describeBody).join('; ');
}

/** `body` or `bodies`, so a count reads as English. */
function pluralBodies(count) {
    return count === 1 ? 'body' : 'bodies';
}

/**
 * Refuse a panel that does not hold the bodies the strip offers.
 *
 * @param view - The answer `__MT__.bodyView()` gave.
 * @param expected - How many bodies the strip has tabs for.
 */
function assertBodyCount(view, expected) {
    if (view.bodies.length === expected) {
        return;
    }

    const ids = view.bodies.map((body) => body.id).join(', ');

    throw new Error(`the panel holds ${view.bodies.length} bodies (${ids}), not ${expected}`);
}

/** Refuse a body the shell hid that the cascade still gives a box. */
function assertNothingLingering(view) {
    const lingering = view.bodies.filter((body) => body.hidden && body.display !== 'none');

    if (lingering.length === 0) {
        return;
    }

    const count = `${lingering.length} ${pluralBodies(lingering.length)}`;

    throw new Error(`the shell hid ${count} the cascade still paints: ${listBodies(lingering)}`);
}

/** Refuse a tab that is not the only body with a box, or whose box is unlabelled. */
function assertOneBox(tab, view) {
    const visible = view.bodies.filter((body) => body.display !== 'none');

    if (visible.length !== 1) {
        const boxes = `${visible.length} have one (${listBodies(visible)})`;
        const wanted = `"${tab.id}" must be the only body with a box`;

        throw new Error(`${wanted}, but ${boxes} — the strip shows "${view.active}"`);
    }

    const [shown] = visible;
    if (shown.id === tab.id && shown.labelledBy === view.selectedId) {
        return;
    }

    const label = shown.labelledBy ?? 'nothing';
    const selected = view.selectedId ?? 'nothing';

    throw new Error(
        `the visible body is ${describeBody(shown)}, labelled by ${label} while the strip's ` +
            `"${view.active}" selects ${selected} — not "${tab.id}"`,
    );
}

/** One painted hidden element as the refusal names it: what it is, and how. */
function describePainted(entry) {
    const name = entry.className === '' ? entry.tag : `${entry.tag}.${entry.className}`;

    return `${name} display=${entry.display}`;
}

/** Several painted hidden elements, named the same way. */
function listPainted(painted) {
    return painted.map(describePainted).join('; ');
}

/** Refuse an element the panel hid that the cascade still gives a box. */
function assertNothingPainted(view) {
    if (view.painted.length === 0) {
        return;
    }

    const count = `${view.painted.length} hidden element${view.painted.length === 1 ? '' : 's'}`;

    throw new Error(`the panel hid ${count} the cascade still paints: ${listPainted(view.painted)}`);
}

/**
 * Refuse a frame whose visible body is not the tab that was asked for.
 *
 * @param input - `{ tab, view, expected }`: the tab requested, the answer
 *   `__MT__.bodyView()` gave, and how many bodies the panel must hold.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export function assertVisibleBody(input) {
    const { tab, view, expected } = input;

    if (view === null) {
        throw new Error(`the panel exposed no tab bodies, so "${tab.id}" cannot be shown`);
    }

    assertBodyCount(view, expected);
    assertNothingLingering(view);
    assertNothingPainted(view);
    assertOneBox(tab, view);
}
