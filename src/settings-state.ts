/**
 * The Settings state and its copy: three read shapes, last-writer-wins banners, the quarantine sentence (FR-013/019).
 */

import type { ConfigEnvelope, ConfigSource } from './settings-schema.ts';
import type { SettingsEdit, SettingsFailure, SettingsFailureCause } from './settings-edit.ts';
import { emptyEdit } from './settings-edit.ts';

export const CONFIG_SOURCE = 'GET /v1/config';

export const SETTINGS_HEADING = 'Settings';

export const EDITABLE_TITLE = 'Editing the whole configuration';

export const EDITABLE_BODY =
    'A save replaces the entire configuration rather than merging into it, so another panel or a ' +
    'hand edit and this one produce a last writer. Nothing is written until you activate Save, and ' +
    'each row names when its value takes effect.';

export const READ_ONLY_TITLE = 'Read-only for now';

export const READ_ONLY_BODY =
    'No document is current, so nothing here can be saved. Editing arrives as soon as the ' +
    'service answers a configuration read.';

export const SOURCE_NOTE = `Rows are read from the service configuration document (${CONFIG_SOURCE}).`;

export const REFRESH_LABEL = 'Refresh configuration';

export const FAILURE_TITLE = 'Settings could not be read';

export const NO_DOCUMENT =
    `No configuration has been read yet. The rows appear once the service answers ${CONFIG_SOURCE}.`;

export const ROWS_LABEL = 'Service configuration';

/** Label of the one write the tab offers (FR-012: one save, not ten). */
export const SAVE_LABEL = 'Save configuration';

export const DISCARD_LABEL = 'Discard changes';

export const RESTORE_LABEL = 'Restore defaults';

/**
 * Label of the control that disarms an armed confirmation.
 *
 * The panel has no dialog primitive and never grows one: the confirmation is
 * dismissed by this control the same way every other two-step action in the
 * product is completed or cancelled — with a button a keyboard can reach.
 */
export const CONFIRM_CANCEL_LABEL = 'Cancel';

/** What each documented `source` means, in the contract's own words (§3). */
export const SOURCE_LINES: Readonly<Record<ConfigSource, string>> = {
    stored: 'Values below are the configuration the service holds.',
    default: 'No stored configuration yet — the values below are the documented defaults.',
    quarantined: 'The stored configuration was unusable and set aside — the values below are the documented defaults.',
};

/** What one save state says, in the tab's own words (FR-013). */
export const SAVE_LINES: Readonly<Record<SettingsEdit['saveState'], string>> = {
    idle: 'No unsaved changes.',
    editing: 'Unsaved changes.',
    saving: 'Saving…',
    saved: 'Saved.',
    refused: 'The service refused these values.',
    failed: 'The write could not be completed.',
};

/** What each write-failure cause says, in the tab's own words (FR-061 – FR-064). */
export const FAILURE_LINES: Readonly<Record<SettingsFailureCause, string>> = {
    store:
        'The service could not reach its configuration store. This is a setup prerequisite, not a refusal ' +
        'of these values: nothing was written, the edit is not reported as saved, and nothing is retried ' +
        'automatically.',
    unauthorised:
        'Not authorised: the panel holds no grant to write the configuration. Authorization belongs to the ' +
        'host, and the panel does not retry it in a loop.',
    transport:
        'The write could not be sent: the service could not be reached. This is a transport failure, not a ' +
        'refusal of these values, and no value the panel has not read is shown.',
    unexpected:
        'The write failed for a reason the service did not document. It was not a refusal of these values, ' +
        'and the panel does not retry it automatically.',
};

export const AUDIT_MISSING_LINE =
    'Saved — but the audit row for this change did not reach the trail: the configuration is in force, ' +
    'this save has no config.changed record, and the change is therefore not traceable from the audit ' +
    'history. The service logged the failure and rolled nothing back.';

/**
 * Classify one service answer into the four causes the tab renders.
 *
 * The panel reads no new vocabulary here: `storage-unavailable` and
 * `unauthorized` are the service's own error codes, the status sentences are
 * the wrapper's, and the transport prefix is the wrapper's description of a
 * call that never reached the service. Anything else is *undocumented* rather
 * than guessed at.
 */
export function causeOf(input: {
    readonly code: string | null;
    readonly problem: string;
}): SettingsFailureCause {
    const { code, problem } = input;
    if (code === 'storage-unavailable' || problem === 'service answered 503') {
        return 'store';
    }

    if (code === 'unauthorized' || problem === 'service answered 401') {
        return 'unauthorised';
    }

    if (problem.startsWith('service unreachable')) {
        return 'transport';
    }

    return 'unexpected';
}

/**
 * Build the failure a failed write records.
 */
export function writeFailure(input: {
    readonly code: string | null;
    readonly problem: string;
    /** The envelope's correlation identifier, when one came (FR-064). */
    readonly correlationId: string | null;
}): SettingsFailure {
    return { cause: causeOf(input), problem: input.problem, correlationId: input.correlationId };
}

/**
 * What the issues region shows for a failed write: the cause's copy, the
 * service's own problem beside it, and — when the envelope carried one — the
 * correlation identifier as its own line of copyable text.
 */
export function writeFailureLines(failure: SettingsFailure): readonly string[] {
    const lines = [`${FAILURE_LINES[failure.cause]} (${failure.problem})`];
    if (failure.correlationId !== null) {
        lines.push(`Correlation id: ${failure.correlationId}`);
    }

    return lines;
}

/**
 * What the failure notice says for a **read** that failed.
 *
 * The same four causes, in the read's words: the transport case is the state
 * AC-129 names exactly, the store case is 002 FR-039's setup prerequisite,
 * and the unauthorised case is the grant the panel will not work around
 * (constitution II).
 */
export function readFailureBody(problem: string): string {
    const cause = causeOf({ code: null, problem });
    if (cause === 'transport') {
        return (
            `service not running — settings read-only. ${problem}: the configuration could not be read, ` +
            'so nothing on this tab is a value until the service answers. Refresh once it is running.'
        );
    }

    if (cause === 'store') {
        return (
            `${problem}: the service could not open its configuration store. This is a setup prerequisite ` +
            'rather than a refusal — nothing was read, no value is shown, and nothing is retried automatically.'
        );
    }

    if (cause === 'unauthorised') {
        return `${problem}: not authorised. The panel holds no grant to read the configuration and does not retry.`;
    }

    return (
        `${problem}: the configuration read failed for a reason the service did not document. ` +
        'No value is shown that was not read.'
    );
}

/**
 * Where the Settings tab stands, and what it last rendered.
 *
 * Same shape as the Status tab's slice on purpose: a failed read behaves the
 * same way on every tab, so an operator learns one rule instead of seven.
 */
export interface SettingsTabState {
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    at: string | null;
    problem: string | null;
    stale: boolean;
    doc: ConfigEnvelope | null;
    edit: SettingsEdit;
}

/**
 * Build the empty Settings tab state.
 */
export function initialSettingsTab(): SettingsTabState {
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null, edit: emptyEdit() };
}

/**
 * The tab's own read state, in FR-019's three shapes.
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
