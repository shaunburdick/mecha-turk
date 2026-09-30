/**
 * The Settings tab: one read-only row per field `GET /v1/config` carries
 * (005 T-027; FR-070, FR-071, FR-072, FR-073, FR-078, FR-039).
 *
 * The tab is **read-only by design**: it renders the service's configuration
 * document and offers exactly one control — an explicit re-read, which is a
 * read and therefore allowed (FR-014). No input, no save, no confirmation:
 * editing, live-apply, and destructive-knob confirmation are feature 006's,
 * and 005 must not even imply them with a disabled-looking control
 * (FR-070). The read-only statement says so in words, naming the feature but
 * deliberately naming **no version** for it (FR-073).
 *
 * What each row *says* lives in [`settings-rows.ts`](./settings-rows.ts);
 * this module owns the read, the read state, and the painting. Two rules
 * shape the rendering:
 *
 * - **Static content survives an unreachable service** (FR-078): heading,
 *   read-only statement, source note, and read-state line all stay on screen
 *   while the rows area says plainly that nothing has been read — never an
 *   empty configuration dressed as one.
 * - **A failed read keeps the last document, marked stale** (FR-019), or
 *   states that there is none.
 *
 * The tab reads its *configured* values here and nothing else: Status keeps
 * owning the *effective* interval (FR-039), so the two can never disagree
 * about which value each of them is showing.
 */

import { mountBanner, mountButton, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, TextHandle } from '@openchamber/sdk/ui';
import { nowIso } from './ids.ts';
import { redact } from './redaction.ts';
import { CONFIG_PATH, serviceGet } from './service-calls.ts';
import { parseConfigDocument, settingsRows } from './settings-rows.ts';
import type { ConfigDocument, SettingsRow } from './settings-rows.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Heading above the read-only statement. */
const SETTINGS_HEADING = 'Settings';

/** The one document the tab reads, named for the operator as well as the call. */
const CONFIG_SOURCE = `GET ${CONFIG_PATH}`;

/** Title of the read-only statement (FR-073). */
const READ_ONLY_TITLE = 'Read-only in this release';

/** Body of the read-only statement; names the feature, never a version. */
const READ_ONLY_BODY =
    'Editing, saving, live-apply, and destructive-knob confirmation arrive with feature 006. ' +
    'Nothing on this tab can be changed today.';

/** Where the rows come from, stated so a failure has somewhere to point. */
const SOURCE_NOTE = `Rows are read from the service configuration document (${CONFIG_SOURCE}).`;

/** What the re-read control is called; also the failure notice's retry. */
const REFRESH_LABEL = 'Refresh configuration';

/** Title of the failure notice, whatever the failure was. */
const FAILURE_TITLE = 'Settings could not be read';

/** What the rows area says while no document has ever been read (FR-078). */
const NO_DOCUMENT =
    `No configuration has been read yet. The rows appear once the service answers ${CONFIG_SOURCE}.`;

/** Accessible name of the row region, so the rows are findable (FR-081). */
const ROWS_LABEL = 'Service configuration';

/**
 * Where the Settings tab's read stands, and what it last rendered (FR-019).
 *
 * Same shape as the Status tab's slice on purpose: a failed read behaves the
 * same way on every tab, so an operator learns one rule instead of six.
 */
export interface SettingsTabState {
    /** Read phase: nothing yet, in flight, landed, or refused. */
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    /** RFC 3339 stamp of the read that last landed, or `null`. */
    at: string | null;
    /** Why the last read failed; `null` while there is nothing to report. */
    problem: string | null;
    /** Whether `doc` is from an earlier read than the one that just failed. */
    stale: boolean;
    /** The last document this tab could read, or `null` when there is none. */
    doc: ConfigDocument | null;
}

/**
 * Build the empty Settings tab state.
 *
 * @returns The state before the first read.
 */
export function initialSettingsTab(): SettingsTabState {
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null };
}

/** The mounted Settings tab: the handles a repaint updates, plus disposal. */
export interface SettingsTabUi {
    /** Body root this view mounted into. */
    readonly pane: HTMLElement;
    /** Tab heading. */
    readonly heading: TextHandle;
    /** The read-only statement (FR-073). */
    readonly readOnly: BannerHandle;
    /** One line of read state: idle, loading, landed, failed with a cause. */
    readonly readLine: TextHandle;
    /** The tab's only control: an explicit re-read (FR-014, FR-078). */
    readonly refresh: ButtonHandle;
    /** Wrapper around the failure notice, hidden while nothing failed. */
    readonly failureBox: HTMLElement;
    /** Failure notice naming what could not be read and from where (FR-078). */
    readonly failure: BannerHandle;
    /** Where the rows come from. */
    readonly sourceNote: TextHandle;
    /** Message shown while no document has ever been read. */
    readonly emptyText: TextHandle;
    /** Container the per-field rows live in. */
    readonly rowsBox: HTMLElement;
    /** One handle per row, rebuilt whenever the row count changes. */
    rows: readonly TextHandle[];
    /** Remove every node and handle this view mounted (FR-017). */
    readonly dispose: () => void;
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
 * @param slice - The Settings tab's read state.
 * @returns The read-state line the tab paints.
 */
export function readStateLine(slice: SettingsTabState): string {
    if (slice.phase === 'idle') {
        return 'Settings: not read yet.';
    }

    if (slice.phase === 'loading') {
        return 'Settings: reading…';
    }

    if (slice.phase === 'loaded') {
        return `Settings: read at ${slice.at ?? 'an unknown time'}.`;
    }

    const cause = slice.problem ?? 'the service did not answer';
    if (!slice.stale) {
        return `Settings could not be read: ${cause}. Nothing has been read yet.`;
    }

    return `Settings could not be re-read: ${cause}. Showing the read from ${slice.at}, which may be stale.`;
}

/**
 * Paint the per-field rows, rebuilding them when the count changed.
 *
 * Rebuilding rather than pooling keeps exactly one handle per visible row: a
 * handle left over from a twelve-field read would keep painting a row the
 * document no longer carries.
 *
 * @param ui - The mounted view.
 * @param rows - The rows to show, in document order.
 */
function paintRows(ui: SettingsTabUi, rows: readonly SettingsRow[]): void {
    if (ui.rows.length !== rows.length) {
        for (const row of ui.rows) {
            row.dispose();
        }

        ui.rows = rows.map(() => mountText(ui.rowsBox, { text: '' }));
    }

    for (const [index, row] of rows.entries()) {
        ui.rows[index]?.update({ text: row.text });
    }
}

/**
 * Repaint the Settings tab from its read state (FR-071, FR-078).
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it (FR-013).
 *
 * @param rt - Panel runtime.
 */
export function repaintSettingsTab(rt: PanelRuntime): void {
    const ui = rt.settingsUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.settingsTab;
    const loading = slice.phase === 'loading';

    ui.readLine.update({ text: readStateLine(slice) });
    ui.refresh.update({ disabled: loading, loading });
    ui.failureBox.hidden = slice.phase !== 'failed';
    if (slice.phase === 'failed') {
        ui.failure.update({
            tone: 'warning',
            title: FAILURE_TITLE,
            body:
                `${slice.problem ?? 'the service did not answer'} — nothing on this tab is a value ` +
                `until ${CONFIG_SOURCE} answers. Refresh to try again.`,
        });
    }

    const rows = slice.doc === null ? [] : settingsRows(slice.doc);
    ui.emptyText.update({ text: rows.length === 0 ? NO_DOCUMENT : '' });
    paintRows(ui, rows);
}

/**
 * Whether the runtime has been torn down while a read was in flight.
 *
 * A function call rather than a bare `rt.disposed` read: the analyzer narrows
 * that property across the first `await` and then reports a later direct
 * check as unreachable, while the frame really can go away between two awaits
 * (the same shape the Status tab's read has).
 *
 * @param rt - Panel runtime.
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Read `GET /v1/config` once and record what it answered (FR-014, FR-078).
 *
 * The read is this tab's own: a failure leaves the last document in place,
 * marked stale, and says what could not be read rather than blanking rows
 * that were true a moment ago (FR-019).
 *
 * @param rt - Panel runtime.
 */
export async function loadSettings(rt: PanelRuntime): Promise<void> {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.phase === 'loading') {
        return;
    }

    slice.phase = 'loading';
    repaintSettingsTab(rt);

    const answer = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: CONFIG_PATH });
    if (tornDown(rt)) {
        return;
    }

    const doc = answer.ok ? parseConfigDocument(answer.body) : null;
    if (doc === null) {
        slice.phase = 'failed';
        slice.problem = redact(
            answer.ok ? 'the service answered a configuration document the panel could not read' : answer.problem,
        );
        slice.stale = slice.doc !== null;
        repaintSettingsTab(rt);

        return;
    }

    slice.doc = doc;
    slice.phase = 'loaded';
    slice.problem = null;
    slice.stale = false;
    slice.at = nowIso();
    rt.shell?.noteRead('settings', slice.at);
    repaintSettingsTab(rt);
}

/**
 * Mount the re-read row: the tab's one control and its read-state line
 * (FR-014, FR-078).
 *
 * @param input - Runtime whose read the control starts, and the pane to
 *   mount into.
 * @returns The two handles.
 */
function mountReadControls(input: {
    /** Runtime whose read state the control re-reads. */
    readonly rt: PanelRuntime;
    /** Pane the row mounts into. */
    readonly pane: HTMLElement;
}): { readonly refresh: ButtonHandle; readonly readLine: TextHandle } {
    const row = input.pane.ownerDocument.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    input.pane.append(row);

    const refresh = mountButton(row, {
        label: REFRESH_LABEL,
        variant: 'secondary',
        onClick: (): void => {
            void loadSettings(input.rt);
        },
    });

    return { refresh, readLine: mountText(row, { text: readStateLine(input.rt.state.settingsTab) }) };
}

/**
 * Mount the failure notice, hidden until a read fails (FR-078).
 *
 * @param pane - Pane the notice mounts into.
 * @returns The wrapper, which the repaint shows, and the banner inside it.
 */
function mountFailureNotice(pane: HTMLElement): {
    /** Wrapper whose `hidden` flag is "there is nothing to report here". */
    readonly box: HTMLElement;
    /** The banner that names what could not be read. */
    readonly failure: BannerHandle;
} {
    const box = pane.ownerDocument.createElement('div');
    box.hidden = true;
    pane.append(box);

    return {
        box,
        failure: mountBanner(box, {
            tone: 'warning',
            title: FAILURE_TITLE,
            body: `${CONFIG_SOURCE} did not answer.`,
        }),
    };
}

/**
 * Mount the source note, the empty message, and the row region (FR-071).
 *
 * @param pane - Pane the three mount into.
 * @returns The handles and the region element rows are painted into.
 */
function mountRowRegion(pane: HTMLElement): {
    /** Where the rows come from. */
    readonly sourceNote: TextHandle;
    /** Message shown while no document has ever been read. */
    readonly emptyText: TextHandle;
    /** Container the per-field rows live in. */
    readonly rowsBox: HTMLElement;
} {
    const sourceNote = mountText(pane, { text: SOURCE_NOTE });
    const emptyText = mountText(pane, { text: NO_DOCUMENT });
    const rowsBox = pane.ownerDocument.createElement('div');
    rowsBox.setAttribute('role', 'region');
    rowsBox.setAttribute('aria-label', ROWS_LABEL);
    pane.append(rowsBox);

    return { sourceNote, emptyText, rowsBox };
}

/**
 * Mount the Settings tab: heading, read-only statement, read state, the one
 * re-read control, the failure notice, and the row region (FR-070, FR-071).
 *
 * @param input - Runtime and the body container the shell created.
 * @returns The mounted view.
 */
export function mountSettingsTab(input: {
    /** Runtime whose read state the tab paints. */
    readonly rt: PanelRuntime;
    /** Body container the shell created for the Settings tab. */
    readonly body: HTMLElement;
}): SettingsTabUi {
    const { rt, body } = input;
    const pane = body.ownerDocument.createElement('div');
    body.append(pane);

    const heading = mountText(pane, { text: SETTINGS_HEADING });
    const readOnly = mountBanner(pane, { tone: 'info', title: READ_ONLY_TITLE, body: READ_ONLY_BODY });
    const controls = mountReadControls({ rt, pane });
    const notice = mountFailureNotice(pane);
    const region = mountRowRegion(pane);

    const ui: SettingsTabUi = {
        pane,
        heading,
        readOnly,
        ...controls,
        failureBox: notice.box,
        failure: notice.failure,
        ...region,
        rows: [],
        dispose: (): void => {
            for (const row of ui.rows) {
                row.dispose();
            }

            ui.rows = [];
            heading.dispose();
            readOnly.dispose();
            controls.refresh.dispose();
            controls.readLine.dispose();
            notice.failure.dispose();
            region.sourceNote.dispose();
            region.emptyText.dispose();
            region.rowsBox.remove();
            notice.box.remove();
            pane.remove();
        },
    };

    rt.settingsUi = ui;
    repaintSettingsTab(rt);
    // The tab has never read anything at mount (FR-013: bodies read on their
    // first activation, and this is that activation's one read).
    if (rt.state.settingsTab.phase === 'idle') {
        void loadSettings(rt);
    }

    return ui;
}

/**
 * Dispose the Settings tab's handles and clear its slot (FR-017).
 *
 * @param rt - Panel runtime being torn down.
 */
export function disposeSettingsTab(rt: PanelRuntime): void {
    const ui = rt.settingsUi;
    if (ui === null) {
        return;
    }

    ui.dispose();
    rt.settingsUi = null;
}
