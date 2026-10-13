/**
 * The Settings tab: one editable row per `GET /v1/config` field; one activation, one write, a second refused as busy.
 */

import { mountBanner } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, TextHandle } from '@openchamber/sdk/ui';
import {
    applyConfigRead,
    applyConfirmCancel,
    applyDiscard,
    applyFieldEdit,
    applySave,
    applyStageDefaults,
} from './settings-actions.ts';
import { mountSettingsRows, settingsRows, takeEffectWords, updateSettingsRows } from './settings-rows.ts';
import { createBlock } from './style.ts';
import {
    AUDIT_MISSING_LINE,
    EDITABLE_BODY,
    EDITABLE_TITLE,
    FAILURE_TITLE,
    NO_DOCUMENT,
    READ_ONLY_BODY,
    READ_ONLY_TITLE,
    SAVE_LINES,
    SETTINGS_HEADING,
    SOURCE_LINES,
    SOURCE_NOTE,
    readFailureBody,
    readStateLine,
    writeFailureLines,
} from './settings-state.ts';
import {
    buildTabUi,
    mountControlRegion,
    mountFailureNotice,
    mountReadControls,
    mountRowRegion,
} from './settings-mount.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { SettingsRow, SettingsRowsUi, RowsContext } from './settings-rows.ts';
import type { ConfigEnvelope } from './settings-schema.ts';
import type { SettingsConfirmation } from './settings-confirm.ts';
import type { SettingsEdit } from './settings-edit.ts';
import type { SettingsTabState } from './settings-state.ts';

export { initialSettingsTab } from './settings-state.ts';
export { readStateLine };
export type { SettingsTabState };

export interface SettingsTabUi {
    readonly pane: HTMLElement;
    readonly heading: TextHandle;
    readonly banner: BannerHandle;
    readonly readLine: TextHandle;
    readonly refresh: ButtonHandle;
    /** Wrapper around the failure notice, hidden while nothing failed. */
    readonly failureBox: HTMLElement;
    readonly failure: BannerHandle;
    readonly sourceNote: TextHandle;
    readonly emptyText: TextHandle;
    readonly rowsBox: HTMLElement;
    rowsUi: SettingsRowsUi | null;
    /** Wrapper around the save bar, hidden while no save is possible. */
    readonly saveBox: HTMLElement;
    readonly save: ButtonHandle;
    readonly discard: ButtonHandle;
    readonly restore: ButtonHandle;
    readonly saveLine: TextHandle;
    /** Wrapper around the armed confirmation, hidden while nothing is armed. */
    readonly armBox: HTMLElement;
    readonly armText: TextHandle;
    readonly cancel: ButtonHandle;
    /** Wrapper around the "no save is possible" reason, hidden while one is. */
    readonly blockedBox: HTMLElement;
    readonly blockedLine: TextHandle;
    /** Wrapper around the refusal/failure region, hidden while there is none. */
    readonly issuesBox: HTMLElement;
    readonly issues: TextHandle;
    readonly dispose: () => void;
}

/**
 * The issues the service named, as text in the service's order — and the two
 * other things this region is owed: a failed write's own cause with its
 * correlation id, and the warning that names the audit row a save did not get.
 * One line each, never rewritten: the remediation is the service's own
 * sentence about a value the operator submitted, the one string on this tab
 * that is not a fixed label. Empty when nothing is being reported.
 */
function issueLines(slice: SettingsTabState): readonly string[] {
    if (slice.edit.saveState === 'refused') {
        return slice.edit.issues.map((issue) => `${issue.field}: ${issue.remediation}`);
    }

    if (slice.edit.saveState === 'failed' && slice.edit.failure !== null) {
        return writeFailureLines(slice.edit.failure);
    }

    if (slice.edit.saveState === 'saved' && slice.edit.auditWritten === false) {
        return [AUDIT_MISSING_LINE];
    }

    return [];
}

/**
 * The notes each row's helper carries: the pending marker, in the words of the
 * class that governs it.
 */
function pendingNotes(edit: SettingsEdit): Readonly<Record<string, string>> {
    const notes: Record<string, string> = {};
    for (const entry of edit.pending) {
        notes[entry.field] = `saved, not yet in effect — ${takeEffectWords(entry.boundary)}`;
    }

    return notes;
}

/**
 * The field each issue belongs to, so the service's remediation can appear on
 * the control it is about. An issue naming no documented field (a foreign key,
 * or the withheld marker) reaches the list only — it is information about the
 * submission, never an editable surface.
 */
function issueByField(slice: SettingsTabState): Readonly<Record<string, string>> {
    const byField: Record<string, string> = {};
    if (slice.edit.saveState !== 'refused' || slice.doc === null) {
        return byField;
    }

    const documented = new Set(slice.doc.fields.map((descriptor) => descriptor.name));
    for (const issue of slice.edit.issues) {
        if (documented.has(issue.field)) {
            byField[issue.field] = issue.remediation;
        }
    }

    return byField;
}

/**
 * What the rows region holds, and everything its controls read.
 *
 * @returns The rows context, or `null` when nothing has been read.
 */
function rowsContext(
    slice: SettingsTabState,
    onChange: (field: string, value: string) => void,
): RowsContext | null {
    if (slice.doc === null) {
        return null;
    }

    const baseline: ConfigEnvelope = slice.doc;
    const rows: readonly SettingsRow[] = settingsRows(baseline);

    return {
        rows,
        descriptors: baseline.fields,
        values: slice.edit.draft,
        issues: issueByField(slice),
        notes: pendingNotes(slice.edit),
        disabled: slice.edit.blocked !== null
            || slice.edit.saveState === 'saving'
            || slice.edit.confirm !== null,
        onChange,
    };
}

/**
 * Repaint the banner: what a save will do, or why none is possible.
 */
function repaintBanner(ui: SettingsTabUi, slice: SettingsTabState): void {
    const isSavable = slice.doc !== null && slice.edit.blocked === null;
    ui.banner.update(
        isSavable
            ? { tone: 'info', title: EDITABLE_TITLE, body: EDITABLE_BODY }
            : { tone: 'info', title: READ_ONLY_TITLE, body: READ_ONLY_BODY },
    );
}

/**
 * Repaint the read state, the failure notice, and the source lines.
 */
function repaintReadState(ui: SettingsTabUi, slice: SettingsTabState): void {
    const isLoading = slice.phase === 'loading';
    ui.readLine.update({ text: readStateLine(slice) });
    ui.refresh.update({ disabled: isLoading, loading: isLoading });
    ui.failureBox.hidden = slice.phase !== 'failed';
    if (slice.phase === 'failed') {
        // A failed *re*-read keeps the last document on screen, so the
        // notice says when those values were read as well as why the current
        // read failed — a stale value that is not marked stale is a lie.
        const stale = slice.stale
            ? ` The values on screen were read at ${slice.at ?? 'an unknown time'} and may be stale.`
            : '';
        ui.failure.update({
            tone: 'warning',
            title: FAILURE_TITLE,
            body: `${readFailureBody(slice.problem ?? 'the service did not answer')}${stale}`,
        });
    }

    ui.emptyText.update({ text: slice.doc === null ? NO_DOCUMENT : '' });
    ui.sourceNote.update({
        text: slice.doc === null ? SOURCE_NOTE : `${SOURCE_NOTE} ${SOURCE_LINES[slice.doc.source]}`,
    });
}

/**
 * Mount the rows when the field list changed, patch them when it did not
 * — patching rather than rebuilding is what keeps an input's
 * focus while the operator types.
 */
function repaintRows(input: {
    readonly ui: SettingsTabUi;
    readonly slice: SettingsTabState;
    readonly onChange: (field: string, value: string) => void;
}): void {
    const { ui, slice, onChange } = input;
    const context = rowsContext(slice, onChange);
    if (context === null) {
        ui.rowsUi?.dispose();
        ui.rowsUi = null;

        return;
    }

    const fields = context.rows.map((row) => row.field).join('|');
    const mounted = ui.rowsUi;
    if (mounted !== null && mounted.fields.join('|') === fields) {
        updateSettingsRows(mounted, context);

        return;
    }

    mounted?.dispose();
    ui.rowsUi = mountSettingsRows({ box: ui.rowsBox, context });
}

/**
 * How the save bar's three controls should be enabled right now.
 *
 * Computed as one value rather than inlined at each call site, because the
 * arming rule — *only the control that raised a confirmation may act* — is a
 * single decision that four separate flags have to agree on.
 */
function saveControlsFor(slice: SettingsTabState): {
    readonly saving: boolean;
    readonly armed: SettingsConfirmation | null;
    readonly saveDisabled: boolean;
    readonly discardDisabled: boolean;
    readonly restoreDisabled: boolean;
} {
    const isSaving = slice.edit.saveState === 'saving';
    const armed = slice.edit.confirm;
    const isIdle = slice.edit.dirty.length === 0;

    return {
        saving: isSaving,
        armed,
        saveDisabled: isSaving || isIdle || (armed !== null && armed.action !== 'save'),
        discardDisabled: isIdle || armed !== null,
        restoreDisabled: slice.doc === null || (armed !== null && armed.action !== 'restore'),
    };
}

/**
 * Repaint the save bar, the armed confirmation, the named reason, the save
 * state, and the issues.
 */
function repaintControls(ui: SettingsTabUi, slice: SettingsTabState): void {
    const isSavable = slice.edit.blocked === null;
    ui.saveBox.hidden = !isSavable;
    ui.blockedBox.hidden = isSavable;
    if (!isSavable) {
        ui.blockedLine.update({ text: slice.edit.blocked ?? '' });
    }

    const controls = saveControlsFor(slice);
    ui.armBox.hidden = controls.armed === null;
    if (controls.armed !== null) {
        ui.armText.update({ text: controls.armed.copy });
    }

    ui.save.update({ disabled: controls.saveDisabled, loading: controls.saving });
    ui.discard.update({ disabled: controls.discardDisabled });
    ui.restore.update({ disabled: controls.restoreDisabled });
    const pending = slice.edit.pending.map((entry) => `${entry.field}: ${takeEffectWords(entry.boundary)}`);
    ui.saveLine.update({
        text: pending.length === 0
            ? SAVE_LINES[slice.edit.saveState]
            : `${SAVE_LINES[slice.edit.saveState]} Pending — ${pending.join('; ')}`,
    });

    const lines = issueLines(slice);
    ui.issuesBox.hidden = lines.length === 0;
    if (lines.length > 0) {
        ui.issues.update({ text: lines.join('\n') });
    }
}

/**
 * Repaint the Settings tab from its state.
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it.
 */
export function repaintSettingsTab(rt: PanelRuntime): void {
    const ui = rt.settingsUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.settingsTab;
    repaintBanner(ui, slice);
    repaintReadState(ui, slice);
    repaintRows({
        ui,
        slice,
        onChange: (field, value) => applyFieldEdit({ rt, repaint: repaintSettingsTab, field, value }),
    });
    repaintControls(ui, slice);
}

/**
 * Read `GET /v1/config` once and record what it answered.
 *
 * The read is this tab's own: a failure leaves the last document in place,
 * marked stale, names what could not be read, and blocks any save — because a
 * save with no current baseline sends a document the panel cannot stand behind.
 */
export async function loadSettings(rt: PanelRuntime): Promise<void> {
    await applyConfigRead(rt, repaintSettingsTab);
}

/**
 * Save the draft: one activation, one whole-document write.
 */
export async function saveSettings(rt: PanelRuntime): Promise<void> {
    await applySave(rt, repaintSettingsTab);
}

/**
 * Discard the unsaved edits, naming what reverted.
 */
export function discardSettings(rt: PanelRuntime): void {
    applyDiscard(rt, repaintSettingsTab);
}

/**
 * Restore the declared defaults: stage them under a confirmation, and write
 * only on the armed control's second activation.
 */
export async function stageDefaults(rt: PanelRuntime): Promise<void> {
    await applyStageDefaults(rt, repaintSettingsTab);
}

/**
 * Disarm the confirmation: nothing is written, and every field returns to the
 * last-read value.
 */
export function cancelConfirm(rt: PanelRuntime): void {
    applyConfirmCancel(rt, repaintSettingsTab);
}

/**
 * Mount the Settings tab: heading, banner, read state, the re-read control,
 * the failure notice, the rows, the save bar, the confirmation, and the two
 * notices.
 */
export function mountSettingsTab(input: {
    readonly rt: PanelRuntime;
    readonly body: HTMLElement;
}): SettingsTabUi {
    const { rt, body } = input;
    const pane = body.ownerDocument.createElement('div');
    body.append(pane);

    // One rule across the six tabs: the tab title is the
    // first block's heading, and the tab's controls live inside that block —
    // the banner, the re-read row, and the failure notice all mount into it
    // instead of floating unboxed above the configuration grid.
    const titleBlock = createBlock(pane, { heading: SETTINGS_HEADING, title: true });
    const { heading } = titleBlock;
    const banner = mountBanner(titleBlock.body, { tone: 'info', title: READ_ONLY_TITLE, body: READ_ONLY_BODY });
    const controls = mountReadControls({
        pane: titleBlock.body,
        onRefresh: (): void => {
            void loadSettings(rt);
        },
        readLineText: readStateLine(rt.state.settingsTab),
    });
    const notice = mountFailureNotice(titleBlock.body);
    const region = mountRowRegion(pane);
    const controlsRegion = mountControlRegion({
        pane,
        onSave: (): void => {
            void saveSettings(rt);
        },
        onDiscard: (): void => discardSettings(rt),
        onRestore: (): void => {
            void stageDefaults(rt);
        },
        onCancel: (): void => cancelConfirm(rt),
    });

    const ui = buildTabUi({ pane, heading, banner, controls, notice, region, controlsRegion });

    rt.settingsUi = ui;
    repaintSettingsTab(rt);
    // The tab has never read anything at mount: bodies read on
    // their first activation, and this is that activation's one read.
    if (rt.state.settingsTab.phase === 'idle') {
        void loadSettings(rt);
    }

    return ui;
}

/**
 * Dispose the Settings tab's handles and clear its slot.
 */
export function disposeSettingsTab(rt: PanelRuntime): void {
    const ui = rt.settingsUi;
    if (ui === null) {
        return;
    }

    ui.dispose();
    rt.settingsUi = null;
}
