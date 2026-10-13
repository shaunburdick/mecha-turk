/**
 * The configuration audit row (006 FR-070 – FR-072; 003 FR-052, FR-061).
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
 * fingerprint (004 FR-088's baseline seed). Only a value that already carries
 * the `mtp-` shape is trusted, because this value becomes the lane's
 * baseline and is written back into a later row as `from` — anything else
 * would be echoed forward as though the service had recorded it. Reading it
 * as `null` keeps 006 FR-071's never-the-text rule in force on the **read**
 * side too.
 */
export function recordedConfigPromptFingerprint(value: unknown): string | null {
    return typeof value === 'string' && PROMPT_FINGERPRINT_PATTERN.test(value) ? value : null;
}

/**
 * The value this field's row entry records; every other field records itself
 * (FR-071 as amended for `startingPrompt`).
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
 * Compare the validated candidate with the stored document, field by field —
 * also the **no-op detector**: an empty result means the two agree over
 * every documented field, so the write changed nothing, reports *already
 * saved*, and owes no row at all. The comparison is deliberately **raw**: a
 * fingerprint decides nothing here, it only labels the row afterwards.
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
 * A documented field keeps its name; anything else — a foreign key, the
 * `body` sentinel, the validator's `<withheld>` — collapses to the
 * withheld marker, because a durable trail is strictly narrower than the
 * refusal body the panel renders. Duplicates collapse too: `issueCount`
 * carries the count, `fields` the set of names.
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
 * Append the row for an accepted change to the document: the **write** path
 * calls it with the fields a `PUT` moved and actor `operator`, the
 * observation lane with the one `startingPrompt` move it noticed and actor
 * `service` — one composer, one shape. It never throws, which is what lets
 * the lane advance its baseline past a row that could not be written.
 */
export async function appendConfigApplied(input: {
    /** Open store the trail lives on. */
    readonly store: ServiceStore;
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
