/**
 * The Settings tab's state and the copy that state is painted with (006
 * FR-013, FR-019; 005 FR-019, FR-078).
 *
 * Split from [`settings-tab.ts`](./settings-tab.ts) so the view keeps the
 * mount/repaint/dispose and this module keeps *what* is being said: the read
 * state in FR-019's three shapes, the banner copy that states last-writer-wins
 * while a save is possible and says why none is while it is not (FR-011,
 * FR-045), and the per-source sentence the contract requires (§3 — the
 * quarantine wording is a promise, not a decoration).
 *
 * Nothing here is a configuration value: every bound, unit, default, and class
 * in the rows comes from the wire (FR-022, AC-106), which is why this module
 * holds only prose about *where a value came from* and *when a save is
 * possible*.
 */

import type { ConfigEnvelope, ConfigSource } from './settings-schema.ts';
import type { SettingsEdit, SettingsFailure, SettingsFailureCause } from './settings-edit.ts';
import { emptyEdit } from './settings-edit.ts';

/** Path of the one document the tab reads, named for the operator too. */
export const CONFIG_SOURCE = 'GET /v1/config';

/** Heading above the banner. */
export const SETTINGS_HEADING = 'Settings';

/** Title of the banner while a save is possible. */
export const EDITABLE_TITLE = 'Editing the whole configuration';

/** Body of the banner while a save is possible: last-writer-wins, stated. */
export const EDITABLE_BODY =
    'A save replaces the entire configuration rather than merging into it, so another panel or a ' +
    'hand edit and this one produce a last writer. Nothing is written until you activate Save, and ' +
    'each row names when its value takes effect.';

/** Title of the banner when no save is possible. */
export const READ_ONLY_TITLE = 'Read-only for now';

/** Body of the banner when no save is possible; the reason is named separately. */
export const READ_ONLY_BODY =
    'No document is current, so nothing here can be saved. Editing arrives as soon as the ' +
    'service answers a configuration read.';

/** Where the rows come from, stated so a failure has somewhere to point. */
export const SOURCE_NOTE = `Rows are read from the service configuration document (${CONFIG_SOURCE}).`;

/** What the re-read control is called; also the failure notice's retry. */
export const REFRESH_LABEL = 'Refresh configuration';

/** Title of the failure notice, whatever the failure was. */
export const FAILURE_TITLE = 'Settings could not be read';

/** What the rows area says while no document has ever been read. */
export const NO_DOCUMENT =
    `No configuration has been read yet. The rows appear once the service answers ${CONFIG_SOURCE}.`;

/** Accessible name of the row region, so the rows are findable. */
export const ROWS_LABEL = 'Service configuration';

/** Label of the one write the tab offers (FR-012: one save, not ten). */
export const SAVE_LABEL = 'Save configuration';

/** Label of the discard control. */
export const DISCARD_LABEL = 'Discard changes';

/** Label of the non-primary restore-defaults control, whose second activation writes. */
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

/** The warning a save earns when its audit row never reached the trail. */
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
 *
 * @returns The cause whose copy the tab shows.
 */
export function causeOf(input: {
    /** The envelope's `error.code`, when one came. */
    readonly code: string | null;
    /** The wrapper's problem string. */
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
 *
 * @param input - The envelope's code, the wrapper's problem, and the
 *   envelope's correlation identifier, if it sent one.
 * @returns The failure the tab will render.
 */
export function writeFailure(input: {
    /** The envelope's `error.code`, when one came. */
    readonly code: string | null;
    /** The wrapper's problem string. */
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
 *
 * @returns The lines, in render order.
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
 *
 * @param problem - The wrapper's problem string for the failed read.
 * @returns The notice body.
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
    /** The last envelope this tab could read, or `null` when there is none. */
    doc: ConfigEnvelope | null;
    /** The draft, the save state, and the markers: the editable half. */
    edit: SettingsEdit;
}

/**
 * Build the empty Settings tab state.
 *
 * @returns The state before the first read.
 */
export function initialSettingsTab(): SettingsTabState {
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null, edit: emptyEdit() };
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
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
