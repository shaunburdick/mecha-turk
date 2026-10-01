/**
 * The Settings tab's regions: the things it mounts outside its rows
 * (006 T-020; FR-012, FR-013, FR-014, FR-042, FR-078).
 *
 * Split from [`settings-tab.ts`](./settings-tab.ts) so the view keeps the
 * state it paints and this module keeps the plumbing. Every handler arrives as
 * a parameter rather than being imported, which is what keeps the two modules
 * from importing each other — and what makes each region testable on its own.
 *
 * Four regions, one rule each:
 *
 * - **The read row** carries the re-read control and the read-state line
 *   (FR-014, FR-078); it never writes.
 * - **The save bar** carries the one write, the discard, and the non-primary
 *   restore — mounted *hidden* when no save is possible, so the tab never
 *   shows a control that cannot act (FR-011, FR-042).
 * - **The confirmation box** carries what an armed write will do and its
 *   Cancel, mounted hidden until something is armed (FR-016, FR-051, FR-054).
 * - **The error region** carries the service's issues in the service's order,
 *   as text (FR-024, FR-029).
 */

import { mountBanner, mountButton, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, TextHandle } from '@openchamber/sdk/ui';
import type { SettingsTabUi } from './settings-tab.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';
import type { Block } from './style.ts';
import {
    CONFIG_SOURCE,
    CONFIRM_CANCEL_LABEL,
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

/** Heading above the read-only configuration grid. */
const CONFIG_HEADING = 'Configuration';

/** Heading above the save bar, its confirmation, and its error region. */
const SAVE_HEADING = 'Save';

/** The grid's column labels, in the order the row lays its cells out. */
const ROW_COLUMNS: readonly string[] = ['Field', 'Value', 'Shape and default'];

/** What one row-region mount produced. */
export interface RowRegion {
    /** The block the region's heading lives in. */
    readonly block: Block;
    /** Where the rows come from. */
    readonly sourceNote: TextHandle;
    /** Message shown while no document has ever been read. */
    readonly emptyText: TextHandle;
    /** Container the per-field rows live in. */
    readonly rowsBox: HTMLElement;
}

/** What the save bar, the armed confirmation, and the two notices produced. */
export interface ControlRegion {
    /** The block the save bar and its confirmation live in. */
    readonly block: Block;
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
    /** Wrapper around the armed confirmation, hidden until one is armed. */
    readonly armBox: HTMLElement;
    /** What the armed write will do — the contract's content items, as text. */
    readonly armText: TextHandle;
    /** The control that disarms the confirmation and returns the fields (FR-054). */
    readonly cancel: ButtonHandle;
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
    const block = createBlock(pane, { heading: CONFIG_HEADING });
    const sourceNote = mountStyledText(block.body, { className: 'mt-lede', text: SOURCE_NOTE });
    const emptyText = mountStyledText(block.body, { className: 'mt-lede', text: NO_DOCUMENT });
    const rowsBox = pane.ownerDocument.createElement('div');
    rowsBox.className = 'mt-grid';
    rowsBox.setAttribute('role', 'region');
    rowsBox.setAttribute('aria-label', ROWS_LABEL);
    mountColumnHead(rowsBox, { modifier: 'mt-head--settings', cells: ROW_COLUMNS });
    block.body.append(rowsBox);

    return { block, sourceNote, emptyText, rowsBox };
}

/**
 * Mount the armed-confirmation box, hidden until something arms (FR-016,
 * FR-051, FR-054).
 *
 * A box rather than a dialog: it mounts the same way the "no save" reason
 * does, so an unarmed tab never shows a control that cannot act.
 *
 * @param input - The pane, and what Cancel does.
 * @returns The wrapper, the copy inside it, and the control that disarms it.
 */
function mountArmBox(input: {
    /** Pane the box mounts into. */
    readonly pane: HTMLElement;
    /** What Cancel does: disarm and return the fields (FR-054). */
    readonly onCancel: () => void;
}): Pick<ControlRegion, 'armBox' | 'armText' | 'cancel'> {
    const armBox = input.pane.ownerDocument.createElement('div');
    armBox.hidden = true;
    input.pane.append(armBox);
    const armText = mountText(armBox, { text: '' });
    const cancel = mountButton(armBox, {
        label: CONFIRM_CANCEL_LABEL,
        variant: 'secondary',
        onClick: input.onCancel,
    });

    return { armBox, armText, cancel };
}

/**
 * Mount the save bar, the armed confirmation, the "no save" reason, and the
 * error region (FR-012, FR-013, FR-016, FR-042, FR-051).
 *
 * The confirmation is **a box, not a dialog**: it mounts hidden exactly the
 * way the "no save" reason does, so an unarmed tab never shows a control that
 * cannot act — and it carries its own Cancel, because the panel has no dialog
 * primitive to lean on and never reintroduces one (FR-054).
 *
 * @param input - The pane, and the four handlers the controls invoke.
 * @returns The handles and wrappers.
 */
export function mountControlRegion(input: {
    /** Pane the four regions mount into. */
    readonly pane: HTMLElement;
    /** What Save does: arm, or one whole-document write (FR-040, FR-051). */
    readonly onSave: () => void;
    /** What Discard does: restore the last-read draft (FR-015). */
    readonly onDiscard: () => void;
    /** What Restore defaults does: stage the defaults under a confirmation (FR-016). */
    readonly onRestore: () => void;
    /** What Cancel does: disarm and return the fields to the last-read values (FR-054). */
    readonly onCancel: () => void;
}): ControlRegion {
    // The save bar, the confirmation, the "no save" reason, and the issues
    // are one surface: what a write will do, and what stopped the last one.
    const block = createBlock(input.pane, { heading: SAVE_HEADING });
    const pane = block.body;
    const saveBox = pane.ownerDocument.createElement('div');
    saveBox.style.display = 'flex';
    saveBox.style.alignItems = 'center';
    saveBox.style.gap = '8px';
    pane.append(saveBox);
    const save = mountButton(saveBox, { label: SAVE_LABEL, variant: 'default', onClick: input.onSave });
    const discard = mountButton(saveBox, { label: DISCARD_LABEL, variant: 'secondary', onClick: input.onDiscard });
    const restore = mountButton(saveBox, { label: RESTORE_LABEL, variant: 'secondary', onClick: input.onRestore });
    const saveLine = mountText(saveBox, { text: SAVE_LINES.idle });

    const { armBox, armText, cancel } = mountArmBox({ pane, onCancel: input.onCancel });

    const blockedBox = pane.ownerDocument.createElement('div');
    blockedBox.hidden = true;
    pane.append(blockedBox);
    const blockedLine = mountText(blockedBox, { text: '' });

    const issuesBox = pane.ownerDocument.createElement('div');
    issuesBox.hidden = true;
    pane.append(issuesBox);
    const issues = mountText(issuesBox, { text: '' });

    return {
        block,
        saveBox,
        save,
        discard,
        restore,
        saveLine,
        armBox,
        armText,
        cancel,
        blockedBox,
        blockedLine,
        issuesBox,
        issues,
    };
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
    /** The save bar, the armed confirmation, and the two notices. */
    readonly controlsRegion: ControlRegion;
}): void {
    const { pane, heading, banner, controls, notice, region, controlsRegion } = input;
    heading.dispose();
    banner.dispose();
    controls.refresh.dispose();
    controls.readLine.dispose();
    notice.failure.dispose();
    region.block.dispose();
    region.sourceNote.dispose();
    region.emptyText.dispose();
    region.rowsBox.remove();
    controlsRegion.block.dispose();
    controlsRegion.save.dispose();
    controlsRegion.discard.dispose();
    controlsRegion.restore.dispose();
    controlsRegion.saveLine.dispose();
    controlsRegion.armText.dispose();
    controlsRegion.cancel.dispose();
    controlsRegion.blockedLine.dispose();
    controlsRegion.issues.dispose();
    controlsRegion.saveBox.remove();
    controlsRegion.armBox.remove();
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
    /** The save bar, the armed confirmation, and the two notices. */
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
