/**
 * The Settings regions outside its rows: read row, save bar, confirmation box, error region — handlers as parameters.
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

const CONFIG_HEADING = 'Configuration';

const SAVE_HEADING = 'Save';

const ROW_COLUMNS: readonly string[] = ['Field', 'Value', 'Shape and default'];

export interface RowRegion {
    readonly block: Block;
    readonly sourceNote: TextHandle;
    readonly emptyText: TextHandle;
    readonly rowsBox: HTMLElement;
}

export interface ControlRegion {
    readonly block: Block;
    readonly saveBox: HTMLElement;
    readonly save: ButtonHandle;
    readonly discard: ButtonHandle;
    readonly restore: ButtonHandle;
    readonly saveLine: TextHandle;
    /** Wrapper around the armed confirmation, hidden until one is armed. */
    readonly armBox: HTMLElement;
    readonly armText: TextHandle;
    readonly cancel: ButtonHandle;
    /** Wrapper around the named reason a save is not offered. */
    readonly blockedBox: HTMLElement;
    readonly blockedLine: TextHandle;
    /** Wrapper around the refusal/failure lines. */
    readonly issuesBox: HTMLElement;
    readonly issues: TextHandle;
}

/**
 * Mount the failure notice, hidden until a read fails.
 */
export function mountFailureNotice(pane: HTMLElement): {
    /** Wrapper whose `hidden` flag is "there is nothing to report here". */
    readonly box: HTMLElement;
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
 * Mount the source note, the empty message, and the row region.
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
 */
function mountArmBox(input: {
    readonly pane: HTMLElement;
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
 * error region.
 *
 * The confirmation is **a box, not a dialog**: it mounts hidden exactly the
 * way the "no save" reason does, so an unarmed tab never shows a control that
 * cannot act — and it carries its own Cancel, because the panel has no dialog
 * primitive to lean on and never reintroduces one.
 */
export function mountControlRegion(input: {
    readonly pane: HTMLElement;
    readonly onSave: () => void;
    readonly onDiscard: () => void;
    readonly onRestore: () => void;
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
 * Mount the re-read row: the read controls and their state line.
 */
export function mountReadControls(input: {
    readonly pane: HTMLElement;
    readonly onRefresh: () => void;
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
 * Dispose every region the body mounted.
 */
function disposeRegions(input: {
    readonly pane: HTMLElement;
    readonly heading: TextHandle;
    readonly banner: BannerHandle;
    readonly controls: { readonly refresh: ButtonHandle; readonly readLine: TextHandle };
    readonly notice: { readonly box: HTMLElement; readonly failure: BannerHandle };
    readonly region: RowRegion;
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
 * Assemble the mounted view and its single dispose path.
 *
 * Every handle the body mounts is disposed here, so "nothing survives
 * teardown" is one function rather than a promise spread across the mount
 * — including the rows, which are rebuilt whenever the field list
 * changes and disposed with everything else when the body goes.
 */
export function buildTabUi(input: {
    readonly pane: HTMLElement;
    readonly heading: TextHandle;
    readonly banner: BannerHandle;
    readonly controls: { readonly refresh: ButtonHandle; readonly readLine: TextHandle };
    readonly notice: { readonly box: HTMLElement; readonly failure: BannerHandle };
    readonly region: RowRegion;
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
