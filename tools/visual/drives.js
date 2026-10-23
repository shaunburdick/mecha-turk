/**
 * The drives a scene may name, and the DOM action each one performs. `host.js` runs them; `shot.js`
 * refuses a scene whose drive is not here, so a published frame cannot be labelled with a state
 * nothing performed.
 */

/** A dispatch row in the panel's list. */
const ROW_SELECTOR = 'button.oc-sdk-row';

/** The badge span that carries a row's state word. */
const ROW_BADGE = '.oc-sdk-badge';

/** The unarmed label of the second resolution (its armed label starts `Confirm:`). */
const NO_SESSION_PREFIX = 'No session was created';

/**
 * Press the dispatch row whose badge reads `label`. Querying the live panel rather than an
 * `agent-browser` ref keeps the press on the row the frame is about: selecting a row repaints the
 * list and invalidates every older ref.
 */
function pressRowWithBadge(panel, label) {
    const rows = panel === null ? [] : [...panel.querySelectorAll(ROW_SELECTOR)];
    const row = rows.find((candidate) => candidate.querySelector(ROW_BADGE)?.textContent.trim() === label);

    if (row === undefined) {
        throw new Error(`the drive found no dispatch row whose badge reads ${JSON.stringify(label)}`);
    }

    row.click();
}

/** Press the first button whose visible label starts with `prefix`. */
function pressButton(panel, prefix) {
    const buttons = panel === null ? [] : [...panel.querySelectorAll('button')];
    const button = buttons.find((candidate) => candidate.textContent.trim().startsWith(prefix));

    if (button === undefined) {
        throw new Error(`the drive found no button whose label starts with ${JSON.stringify(prefix)}`);
    }

    button.click();
}

/** Select the `unconfirmed` row and arm its "No session was created" resolution. */
async function armResolveNoSession({ panel, settle }) {
    pressRowWithBadge(panel, 'unconfirmed');
    await settle();
    pressButton(panel, NO_SESSION_PREFIX);
    await settle();
}

/** Drives the harness can perform, by the name a scene carries. */
export const drives = new Map([['arm-resolve-no-session', armResolveNoSession]]);
