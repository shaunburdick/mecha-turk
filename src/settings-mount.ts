/**
 * The Settings tab's regions: the four things it mounts outside its rows
 * (006 T-020; FR-012, FR-013, FR-014, FR-042, FR-078).
 *
 * Split from [`settings-tab.ts`](./settings-tab.ts) so the view keeps the
 * state it paints and this module keeps the plumbing. Every handler arrives as
 * a parameter rather than being imported, which is what keeps the two modules
 * from importing each other — and what makes each region testable on its own.
 *
 * Three regions, one rule each:
 *
 * - **The read row** carries the re-read control and the read-state line
 *   (FR-014, FR-078); it never writes.
 * - **The save bar** carries the one write, the discard, and the non-primary
 *   restore — mounted *hidden* when no save is possible, so the tab never
 *   shows a control that cannot act (FR-011, FR-042).
 * - **The error region** carries the service's issues in the service's order,
 *   as text (FR-024, FR-029).
 */

import { mountBanner, mountButton, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, TextHandle } from '@openchamber/sdk/ui';
import type { SettingsTabUi } from './settings-tab.ts';
import {
    CONFIG_SOURCE,
    DISCARD_LABEL,
    FAILURE_TITLE,
    NO_DOCUMENT,
    REFRESH_LABEL,
    RESTORE_LABEL,
    ROWS_LABEL,
    SAVE_LABEL,
    SAVE_LINES,
    SOURCE_NOTE,
} from './settings-state.ts';

/** What one row-region mount produced. */
export interface RowRegion {
    /** Where the rows come from. */
    readonly sourceNote: TextHandle;
    /** Message shown while no document has ever been read. */
    readonly emptyText: TextHandle;
    /** Container the per-field rows live in. */
    readonly rowsBox: HTMLElement;
}

/** What the save bar and its two regions produced. */
export interface ControlRegion {
    /** Wrapper around the save bar. */
    readonly saveBox: HTMLElement;
    /** The one write. */
    readonly save: ButtonHandle;
    /** The discard control. */
    readonly discard: ButtonHandle;
    /** The non-primary restore-defaults control. */
    readonly restore: ButtonHandle;
    /** Save state plus pending markers. */
    readonly saveLine: TextHandle;
    /** Wrapper around the named reason a save is not offered. */
    readonly blockedBox: HTMLElement;
    /** The reason itself. */
    readonly blockedLine: TextHandle;
    /** Wrapper around the refusal/failure lines. */
    readonly issuesBox: HTMLElement;
    /** The refusal/failure lines. */
    readonly issues: TextHandle;
}

/**
 * Mount the failure notice, hidden until a read fails (FR-078).
 *
 * @param pane - Pane the notice mounts into.
 * @returns The wrapper, which the repaint shows, and the banner inside it.
 */
export function mountFailureNotice(pane: HTMLElement): {
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
 * Mount the source note, the empty message, and the row region (FR-014).
 *
 * @param pane - Pane the three mount into.
 * @returns The handles and the region element rows are painted into.
 */
export function mountRowRegion(pane: HTMLElement): RowRegion {
    const sourceNote = mountText(pane, { text: SOURCE_NOTE });
    const emptyText = mountText(pane, { text: NO_DOCUMENT });
    const rowsBox = pane.ownerDocument.createElement('div');
    rowsBox.setAttribute('role', 'region');
    rowsBox.setAttribute('aria-label', ROWS_LABEL);
    pane.append(rowsBox);

    return { sourceNote, emptyText, rowsBox };
}

/**
 * Mount the save bar, the "no save" reason, and the error region (FR-012,
 * FR-013, FR-042).
 *
 * @param input - The pane, and the three handlers the controls invoke.
 * @returns The handles and wrappers.
 */
export function mountControlRegion(input: {
    /** Pane the three regions mount into. */
    readonly pane: HTMLElement;
    /** What Save does: one whole-document write (FR-040). */
    readonly onSave: () => void;
    /** What Discard does: restore the last-read draft (FR-015). */
    readonly onDiscard: () => void;
    /** What Restore defaults does: stage the declared defaults (FR-016). */
    readonly onRestore: () => void;
}): ControlRegion {
    const { pane } = input;
    const saveBox = pane.ownerDocument.createElement('div');
    saveBox.style.display = 'flex';
    saveBox.style.alignItems = 'center';
    saveBox.style.gap = '8px';
    pane.append(saveBox);
    const save = mountButton(saveBox, { label: SAVE_LABEL, variant: 'default', onClick: input.onSave });
    const discard = mountButton(saveBox, { label: DISCARD_LABEL, variant: 'secondary', onClick: input.onDiscard });
    const restore = mountButton(saveBox, { label: RESTORE_LABEL, variant: 'secondary', onClick: input.onRestore });
    const saveLine = mountText(saveBox, { text: SAVE_LINES.idle });

    const blockedBox = pane.ownerDocument.createElement('div');
    blockedBox.hidden = true;
    pane.append(blockedBox);
    const blockedLine = mountText(blockedBox, { text: '' });

    const issuesBox = pane.ownerDocument.createElement('div');
    issuesBox.hidden = true;
    pane.append(issuesBox);
    const issues = mountText(issuesBox, { text: '' });

    return { saveBox, save, discard, restore, saveLine, blockedBox, blockedLine, issuesBox, issues };
}

/**
 * Mount the re-read row: the read controls and their state line (FR-014).
 *
 * @param input - The pane, what a click does, and the line to show first.
 * @returns The handles.
 */
export function mountReadControls(input: {
    /** Pane the row mounts into. */
    readonly pane: HTMLElement;
    /** What the re-read control does. */
    readonly onRefresh: () => void;
    /** The read-state line to show before the first repaint. */
    readonly readLineText: string;
}): { readonly refresh: ButtonHandle; readonly readLine: TextHandle } {
    const row = input.pane.ownerDocument.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    input.pane.append(row);

    const refresh = mountButton(row, {
        label: REFRESH_LABEL,
        variant: 'secondary',
        onClick: input.onRefresh,
    });

    return { refresh, readLine: mountText(row, { text: input.readLineText }) };
}

/**
 * Dispose every region the body mounted (005 FR-017, NFR-108).
 *
 * @param input - Everything {@link buildTabUi} was handed, minus the pane it
 *   can read off the regions themselves.
 */
function disposeRegions(input: {
    /** Container everything mounted into. */
    readonly pane: HTMLElement;
    /** Tab heading. */
    readonly heading: TextHandle;
    /** The banner. */
    readonly banner: BannerHandle;
    /** The read row's handles. */
    readonly controls: { readonly refresh: ButtonHandle; readonly readLine: TextHandle };
    /** The failure notice. */
    readonly notice: { readonly box: HTMLElement; readonly failure: BannerHandle };
    /** The rows region. */
    readonly region: RowRegion;
    /** The save bar and its two regions. */
    readonly controlsRegion: ControlRegion;
}): void {
    const { pane, heading, banner, controls, notice, region, controlsRegion } = input;
    heading.dispose();
    banner.dispose();
    controls.refresh.dispose();
    controls.readLine.dispose();
    notice.failure.dispose();
    region.sourceNote.dispose();
    region.emptyText.dispose();
    region.rowsBox.remove();
    controlsRegion.save.dispose();
    controlsRegion.discard.dispose();
    controlsRegion.restore.dispose();
    controlsRegion.saveLine.dispose();
    controlsRegion.blockedLine.dispose();
    controlsRegion.issues.dispose();
    controlsRegion.saveBox.remove();
    controlsRegion.blockedBox.remove();
    controlsRegion.issuesBox.remove();
    notice.box.remove();
    pane.remove();
}

/**
 * Assemble the mounted view and its single dispose path (005 FR-017).
 *
 * Every handle the body mounts is disposed here, so "nothing survives
 * teardown" is one function rather than a promise spread across the mount
 * (NFR-108) — including the rows, which are rebuilt whenever the field list
 * changes and disposed with everything else when the body goes.
 *
 * @param input - Every region the tab mounted.
 * @returns The view, ready to hand to the runtime.
 */
export function buildTabUi(input: {
    /** Container everything mounted into. */
    readonly pane: HTMLElement;
    /** Tab heading. */
    readonly heading: TextHandle;
    /** The banner. */
    readonly banner: BannerHandle;
    /** The read row's handles. */
    readonly controls: { readonly refresh: ButtonHandle; readonly readLine: TextHandle };
    /** The failure notice. */
    readonly notice: { readonly box: HTMLElement; readonly failure: BannerHandle };
    /** The rows region. */
    readonly region: RowRegion;
    /** The save bar and its two regions. */
    readonly controlsRegion: ControlRegion;
}): SettingsTabUi {
    const { pane, heading, banner, controls, notice, region, controlsRegion } = input;
    const ui: SettingsTabUi = {
        pane,
        heading,
        banner,
        ...controls,
        failureBox: notice.box,
        failure: notice.failure,
        ...region,
        rowsUi: null,
        ...controlsRegion,
        dispose: (): void => {
            ui.rowsUi?.dispose();
            ui.rowsUi = null;
            disposeRegions(input);
        },
    };

    return ui;
}
