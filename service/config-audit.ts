/**
 * The configuration audit row (006 FR-070 – FR-072; 003 FR-052, FR-061).
 *
 * `config.changed` is the name 002's data model reserved for exactly this and
 * that no shipped code had written until now — it is **filled, never invented**
 * (006 FR-070), and there is no second spelling: not `config.updated`, not
 * `config.update`. Both rows this module writes share one identity
 * ({@link CONFIGURATION_ENTITY_ID}) and **their own correlation id with no run
 * reference** (FR-074): a configuration change belongs to no work unit, and
 * forcing it onto a run's identifier would be the defect 003 FR-062 corrected
 * for dispatch rows. Their actor differs by path: `operator` for a
 * `PUT /v1/config` — the only writer of `config.json` is a bearer-token holder
 * acting for the operator, the convention `routes/accounts.ts` already uses —
 * and `service` for a change observed in the stored document without a write
 * (004 FR-088).
 *
 * Two shapes, one hard rule between them. The applied shape is written on two
 * paths — the panel's `PUT` and the poll cycle's observation of the stored
 * document — and both share this module's composer, so neither can drift:
 *
 * - **`applied`** records one `{ field, from, to }` triple per changed field,
 *   ordered by field name, plus the take-effect class each changed field
 *   declares, so a reader can answer *what changed, from what, and when it took
 *   effect* from the row alone (FR-071). For `startingPrompt` — the global tier
 *   of the layered prompt (004 FR-081) — both sides are that field's **`mtp-`
 *   fingerprint or `null`**, never the text (004 FR-088; 006 FR-071 as amended
 *   at v1.6.0), because 004 FR-053 keeps every tier's text out of every audit
 *   row. Raw-string equality is still what decides *changed* (006 FR-048): the
 *   fingerprint is what the row **records**, never what the diff **compares**.
 * - **`refused`** records the issue count and the **documented** field names
 *   the refusal named — with every name that is not a documented field reduced
 *   to `<withheld>` — and **no submitted value of any kind**: not the value,
 *   not an accepted value, not a length, not a hash, and no foreign key name
 *   (FR-072). The value-free half is value-free *by construction*: this module
 *   never receives the submission, only the issue list the validator produced
 *   from the declaration.
 *
 * Both writers swallow their own failure into `false` plus a structured warn:
 * the configuration write is the durable record, so a row that could not reach
 * disk is surfaced as `auditWritten: false` (accepted) or a warn line (refused)
 * rather than rolled back or swallowed (FR-070's edge case).
 *
 * The **observed** half of FR-088 — a change to this field noticed in the
 * stored document without a write — lives in
 * [`config-prompt-observe.ts`](./config-prompt-observe.ts), which builds its
 * row through {@link appendConfigApplied} so the two paths cannot drift apart.
 */

import { appendAudit, CONFIGURATION_ENTITY_ID } from './audit.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { TAKE_EFFECT } from './config-schema.ts';
import { promptTierOf } from './prompt.ts';
import type { ConfigIssue, ServiceConfig } from './config.ts';
import type { ServiceConfigField, TakeEffect } from './config-schema.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/**
 * The vocabulary name 002 reserved for a configuration change.
 *
 * Exported so the observer lane seeds from the same spelling the writers use —
 * there is no second name for this event, in either direction.
 */
export const CONFIG_CHANGED_EVENT = 'config.changed';

/** What an unrecognized key is recorded as in a refusal row. */
const WITHHELD = '<withheld>';

/** Reason text the applied row carries; secret-free by construction. */
const APPLIED_REASON = 'configuration replaced';

/** Reason text the refused row carries; secret-free by construction. */
const REFUSED_REASON = 'configuration refused';

/** Who caused a `config.changed` row: the write's operator, or the service (006 FR-070). */
export type ConfigChangeActor = 'operator' | 'service';

/** What a `{ field, from, to }` triple may carry as either side of a change. */
export type ConfigChangeValue = number | string | null;

/** One field a whole-document write changed, with both sides of the change. */
export interface ConfigChange {
    /** Documented field that moved. */
    readonly field: ServiceConfigField;
    /** Value in force before the write; `null` for an unset global tier. */
    readonly from: ConfigChangeValue;
    /** Value the write put in force; `null` for an unset global tier. */
    readonly to: ConfigChangeValue;
}

/**
 * Fingerprint the global tier's text for a row (004 FR-088, 006 FR-071).
 *
 * @param text - The field's stored text; `null`/`undefined`/`''` all read as
 *   the documented *unset* tier (004 FR-081: empty means unset).
 * @returns `mtp-<sha256 hex[0:32]>` over the normalised text, or `null` —
 *   never the text itself, and never a fingerprint of a value the validator
 *   would refuse: an unusable value reads as *unset*, which is the only safe
 *   answer a durable trail may give.
 */
export function configPromptFingerprint(text: string | null | undefined): string | null {
    // `null` and an absent member are the same *unset* to the one validator
    // every tier shares, so the normalisation loses nothing.
    const tier = promptTierOf({ startingPrompt: text ?? null });

    return tier === null ? null : tier.fingerprint;
}

/** The one shape a recorded global-tier value may have. */
const PROMPT_FINGERPRINT_PATTERN = /^mtp-[0-9a-f]{32}$/;

/**
 * Reduce a `startingPrompt` value read **out of the trail** back to a
 * fingerprint (004 FR-088's baseline seed).
 *
 * Only a value that already carries the `mtp-` shape is trusted. That matters
 * for more than hygiene: this value becomes the lane's baseline, and a
 * baseline is written back into a later row as `from`, so anything that is not
 * a fingerprint — text a row should never have carried, a number, an object —
 * would otherwise be echoed forward into a new row. Reading it as `null` keeps
 * 006 FR-071's never-the-text rule in force on the **read** side too.
 *
 * @param value - A recorded `from`/`to` of a `config.changed` row.
 * @returns The fingerprint, or `null` when the value cannot be one.
 */
export function recordedConfigPromptFingerprint(value: unknown): string | null {
    return typeof value === 'string' && PROMPT_FINGERPRINT_PATTERN.test(value) ? value : null;
}

/**
 * The value this field's row entry records; every other field records itself
 * (FR-071 as amended for `startingPrompt`).
 *
 * @param value - The field's value as the document carried it.
 * @returns The fingerprint pair side for the global tier, the value otherwise.
 */
function recordedValue(field: ServiceConfigField, value: number | string): ConfigChangeValue {
    if (field !== 'startingPrompt') {
        return value;
    }

    // `ServiceConfig` types this member `string`; the guard exists so that a
    // value that ever arrived any other way is recorded as *unset* rather than
    // as something a trail may not carry.
    return configPromptFingerprint(typeof value === 'string' ? value : null);
}

/**
 * Compare the validated candidate with the stored document, field by field.
 *
 * This is also the **no-op detector**: an empty result means the two
 * documents are equal over every documented field, so the write changed
 * nothing, reports *already saved*, and owes no row at all. The comparison is
 * deliberately **raw** — a fingerprint decides nothing here, it only labels the
 * row afterwards.
 *
 * @returns The changes, ordered by field name as FR-071 requires.
 */
export function configChanges(previous: ServiceConfig, next: ServiceConfig): readonly ConfigChange[] {
    const fields = (Object.keys(DEFAULT_CONFIG) as readonly ServiceConfigField[])
        .filter((field) => previous[field] !== next[field])
        .toSorted((left, right) => left.localeCompare(right));

    return fields.map((field) => ({
        field,
        from: recordedValue(field, previous[field]),
        to: recordedValue(field, next[field]),
    }));
}

/**
 * The take-effect class each changed field declares.
 *
 * @param changes - The changes the row is about to record.
 * @returns A field → class map, empty for a no-op.
 */
function takeEffectOf(changes: readonly ConfigChange[]): Record<string, TakeEffect> {
    const takesEffect: Record<string, TakeEffect> = {};
    for (const change of changes) {
        takesEffect[change.field] = TAKE_EFFECT[change.field];
    }

    return takesEffect;
}

/**
 * Reduce a refusal's issue fields to the documented names a row may carry.
 *
 * A documented field keeps its name; anything else — a foreign key, the `body`
 * sentinel a non-object document answers with, or the validator's own
 * `<withheld>` — collapses to the withheld marker, because a durable trail is
 * strictly narrower than the refusal body the panel renders.
 * Duplicates collapse too: `issueCount` carries the count, `fields` the set of
 * names.
 *
 * @returns The field names the row records.
 */
function refusedFields(issues: readonly ConfigIssue[]): readonly string[] {
    const documented = new Set<string>(Object.keys(DEFAULT_CONFIG));
    const fields: string[] = [];
    for (const issue of issues) {
        const name = documented.has(issue.field) ? issue.field : WITHHELD;
        if (!fields.includes(name)) {
            fields.push(name);
        }
    }

    return fields;
}

/**
 * Append the row for an accepted change to the document.
 *
 * The **write** path calls it with the fields a `PUT` moved and actor
 * `operator`; the observation lane calls it with the single `startingPrompt`
 * move it noticed and actor `service`. One composer, one shape.
 *
 * @returns `true` when the row reached disk, `false` when the append failed —
 *   in which case the change still stands and a structured warn names the
 *   loss. It never throws, which is what lets the lane advance its baseline
 *   past a row that could not be written.
 */
export async function appendConfigApplied(input: {
    /** Open store the trail lives on. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The fields that changed, ordered by field name. */
    readonly changes: readonly ConfigChange[];
    /** Who caused the change. */
    readonly actor?: ConfigChangeActor;
}): Promise<boolean> {
    try {
        await appendAudit(input.store, {
            eventType: CONFIG_CHANGED_EVENT,
            actorSource: input.actor ?? 'operator',
            entity: { kind: 'service', id: CONFIGURATION_ENTITY_ID },
            decision: 'applied',
            reason: APPLIED_REASON,
            // No correlation id is supplied: the writer mints one, so the row
            // is retrievable under its own identifier and excluded from every
            // run-filtered read.
            details: {
                changes: input.changes.map((change) => ({
                    field: change.field,
                    from: change.from,
                    to: change.to,
                })),
                takesEffect: takeEffectOf(input.changes),
            },
        });

        return true;
    } catch (cause) {
        input.log.warn('configuration change could not be recorded', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
            changes: input.changes.length,
        });

        return false;
    }
}

/**
 * Append the row for a refused write.
 *
 * @returns `true` when the row reached disk, `false` otherwise; a failure is
 *   logged rather than echoed, because the `422` envelope is unchanged.
 */
export async function appendConfigRefused(input: {
    /** Open store, or `null` when the data directory is unusable. */
    readonly store: ServiceStore | null;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Every issue the refusal reported. */
    readonly issues: readonly ConfigIssue[];
}): Promise<boolean> {
    if (input.store === null) {
        input.log.warn('configuration refusal could not be recorded', {
            errorKind: 'storage-unavailable',
            issueCount: input.issues.length,
        });

        return false;
    }

    try {
        await appendAudit(input.store, {
            eventType: CONFIG_CHANGED_EVENT,
            actorSource: 'operator',
            entity: { kind: 'service', id: CONFIGURATION_ENTITY_ID },
            decision: 'refused',
            reason: REFUSED_REASON,
            details: {
                issueCount: input.issues.length,
                fields: refusedFields(input.issues),
            },
        });

        return true;
    } catch (cause) {
        input.log.warn('configuration refusal could not be recorded', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
            issueCount: input.issues.length,
        });

        return false;
    }
}
