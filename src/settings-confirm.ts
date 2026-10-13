/**
 * The destructive-confirmation content: pure copy — no host, no DOM, no clock (SC-108) — built
 * from what the panel holds, armed by a lower retention knob.
 */

import type { ConfigEnvelope, FieldDescriptor } from './settings-schema.ts';

export type ConfirmAction = 'save' | 'restore';

export interface SettingsConfirmation {
    readonly action: ConfirmAction;
    /** The armed copy, one sentence per line (rendered as text, never markup). */
    readonly copy: string;
    readonly fields: readonly string[];
}

export interface RetentionLowering {
    readonly name: string;
    readonly current: string;
    readonly proposed: string;
    readonly unit: string;
}

interface RetentionRule {
    readonly governs: string;
    readonly removal: (limit: string, unit: string) => string;
    readonly protectedSet: boolean;
}

/**
 * The three retention knobs and the words each one owes.
 *
 * Keyed by the documented field name, so a knob the service ever adds reaches
 * this table as a missing key and **arms nothing** rather than being described
 * by a guess — the fail-closed rule applies to copy as much as to parsing.
 */
const RETENTION_RULES: Readonly<Record<string, RetentionRule>> = {
    auditRetentionDays: {
        governs: 'the audit history — the day window that decides how far back the trail reaches',
        removal: (limit, unit) => `entries older than ${limit} ${unit} will be deleted at the next trim pass`,
        protectedSet: false,
    },
    auditMaxEntries: {
        governs: 'the entry cap on the audit history',
        removal: (limit, unit) =>
            `the oldest unprotected entries beyond ${limit} ${unit} will be removed at the next trim pass`,
        protectedSet: true,
    },
    excerptRetentionDays: {
        governs: 'the stored payload excerpts',
        removal: (limit, unit) =>
            `stored payload excerpts older than ${limit} ${unit} will be cleared at the next trim pass`,
        protectedSet: false,
    },
};

/** When a lowered limit starts deleting (FR-055, FR-057 — the trim's own schedule). */
const WHEN =
    'When: at the next trim pass — the poll-cycle boundary after the change is in force, and once at ' +
    'service start.';

/** What survives any trim (FR-056's floor, FR-073's record of what it took). */
const SURVIVORS =
    'What survives: the rows that keep a run explainable — the row that opens its chain, the row that ' +
    'records its outcome, account and binding rows, and decision rows — are never removed, and the trim ' +
    'appends an audit.trimmed row recording exactly what it took.';

const RAISE = 'Raising a limit deletes nothing.';

/** Trimming has no undo in this feature (006 `## Out of Scope`). */
const IRREVERSIBLE = 'Trimming is irreversible: this feature adds no restore path.';

/** The entry cap's own promise (FR-056: the trail may exceed the cap). */
const CAP_PROTECTION =
    'Nothing protected is ever removed to satisfy the entry cap: the trail may exceed the cap by exactly ' +
    'the protected set that was kept.';

const SAVE_CLOSING =
    'Activating Save again writes the whole document; Cancel returns every field to the last-read values.';

const RESTORE_CLOSING =
    'Activating Restore defaults again writes the whole document; Cancel returns every field to the ' +
    'last-read values.';

/** Heading of a restore arm (FR-016: a whole-document write of the defaults). */
const RESTORE_HEADLINE = 'Restore defaults writes the documented defaults for the whole document.';

/**
 * The value one field is being compared against: the document's member, else
 * the descriptor's default for a key the document lacks.
 *
 * The same rule the draft's baseline uses (`settings-edit.ts`'s `baselineOf`),
 * restated here rather than imported so that the confirmation module and the
 * state machine stay independent of each other.
 */
function currentValueOf(envelope: ConfigEnvelope, descriptor: FieldDescriptor): string {
    const value = envelope.config[descriptor.name];

    return String(value ?? descriptor.default);
}

/**
 * Whether a candidate value is strictly lower than the one in force.
 *
 * A value that does not read as a number arms nothing: it lowers no limit —
 * the service refuses it on its merits — and a confirmation for a write that
 * deletes nothing would be the noise FR-051 exists to prevent.
 *
 * @returns `true` only for a numeric lowering.
 */
function lowers(current: string, proposed: string): boolean {
    const from = Number(current);
    const to = Number(proposed);

    return Number.isFinite(from) && Number.isFinite(to) && to < from;
}

/**
 * Every retention knob this draft lowers below the read document.
 *
 * @returns The lowerings, in the service's field order; empty when none.
 */
export function loweredRetention(input: {
    readonly envelope: ConfigEnvelope;
    readonly draft: Readonly<Record<string, string>>;
}): readonly RetentionLowering[] {
    const found: RetentionLowering[] = [];
    for (const descriptor of input.envelope.fields) {
        const rule = RETENTION_RULES[descriptor.name];
        if (rule === undefined || descriptor.kind !== 'integer') {
            continue;
        }

        const current = currentValueOf(input.envelope, descriptor);
        const proposed = input.draft[descriptor.name] ?? '';
        if (lowers(current, proposed)) {
            found.push({ name: descriptor.name, current, proposed, unit: descriptor.unit });
        }
    }

    return found;
}

/**
 * The eight content items the contract owes for one lowered knob (§2).
 */
function loweringBlock(input: {
    readonly lowering: RetentionLowering;
    readonly rule: RetentionRule;
}): readonly string[] {
    const { lowering, rule } = input;

    return [
        `Lowering ${lowering.name} deletes history.`,
        `${lowering.name} governs ${rule.governs}.`,
        `The limit moves from ${lowering.current} to ${lowering.proposed} ${lowering.unit}.`,
        `${rule.removal(lowering.proposed, lowering.unit)}.`,
        WHEN,
        SURVIVORS,
        ...(rule.protectedSet ? [CAP_PROTECTION] : []),
        RAISE,
        IRREVERSIBLE,
    ];
}

/**
 * Compose the block for every retention knob this draft lowers.
 *
 * @returns The lines, empty when the draft lowers no retention knob.
 */
function loweringLines(input: {
    readonly envelope: ConfigEnvelope;
    readonly draft: Readonly<Record<string, string>>;
}): readonly string[] {
    return loweredRetention(input).flatMap((lowering) => {
        const rule = RETENTION_RULES[lowering.name];

        return rule === undefined ? [] : loweringBlock({ lowering, rule });
    });
}

interface DraftChange {
    readonly name: string;
    readonly current: string;
    readonly staged: string;
}

/**
 * Every field this draft changes, in the service's order.
 *
 * One comparison per descriptor — the same `document member ?? descriptor
 * default` baseline the draft itself is built from — so the list a restore
 * names and the list it writes can never disagree.
 */
function changesIn(input: {
    readonly envelope: ConfigEnvelope;
    readonly draft: Readonly<Record<string, string>>;
}): readonly DraftChange[] {
    const changes: DraftChange[] = [];
    for (const descriptor of input.envelope.fields) {
        const current = currentValueOf(input.envelope, descriptor);
        const staged = input.draft[descriptor.name] ?? '';
        if (staged !== current) {
            changes.push({ name: descriptor.name, current, staged });
        }
    }

    return changes;
}

/**
 * The confirmation a save must raise before it writes, or `null`.
 *
 * `null` is the promise FR-051 makes about every non-destructive write: a
 * raise, a non-retention change, and a value that changes nothing all arm
 * nothing and complete in one activation.
 *
 * @returns The confirmation, or `null` when this save deletes nothing.
 */
export function saveConfirmation(input: {
    readonly envelope: ConfigEnvelope;
    readonly draft: Readonly<Record<string, string>>;
}): SettingsConfirmation | null {
    const lowerings = loweredRetention(input);
    if (lowerings.length === 0) {
        return null;
    }

    const lowered = lowerings.map((entry) => entry.name).join(', ');
    const copy = [
        `Saving lowers ${lowered}: lowering a retention limit deletes history.`,
        ...loweringLines(input),
        SAVE_CLOSING,
    ].join('\n');

    return { action: 'save', copy, fields: lowerings.map((entry) => entry.name) };
}

/**
 * The confirmation a restore always raises before it writes.
 */
export function restoreConfirmation(input: {
    readonly envelope: ConfigEnvelope;
    readonly draft: Readonly<Record<string, string>>;
}): SettingsConfirmation {
    const changes = changesIn(input);
    const copy = [
        RESTORE_HEADLINE,
        ...changes.map((change) => `${change.name}: ${change.current} → ${change.staged}`),
        ...(changes.length === 0
            ? ['Every field already matches the documented default, so the write would change nothing.']
            : []),
        ...loweringLines(input),
        RESTORE_CLOSING,
    ].join('\n');

    return { action: 'restore', copy, fields: changes.map((change) => change.name) };
}
