/**
 * Strict parser for the durable run audit-intent outbox (003 T-037, T-040b).
 *
 * An intent is a promise that a specific audit row still owes the trail. Three
 * producers write them — run creation, migration adoption, and the lease/deadline
 * sweep — and every one of them shares the same recovery rule: if the process
 * dies after the state write and before the append, the next reader of
 * `runs.json` finds the intent and writes the row (T-037, T-040b). Without that
 * the only honest description of a crashed recovery is "the run moved and the
 * trail does not say why", which is precisely the failure constitution IV
 * exists to prevent.
 *
 * The parser is fail-closed in the same voice as the rest of the read path: an
 * intent it cannot fully understand makes the **whole outbox** unparsable,
 * which quarantines the document rather than silently dropping owed rows. A
 * half-understood intent is a row nobody can prove was written.
 */

import { isRecord, readText } from '../json.ts';
import type { RunAuditIntent, RunState } from './runs-types.ts';

/** The lifecycle rows the sweep's outbox can owe (003 `## Audit Vocabulary`). */
type SweepEventType = Extract<RunAuditIntent, { readonly sequence: string }>['eventType'];

/**
 * The decision each sweep row records, so a replayed row matches byte-for-byte.
 *
 * A `Map` keyed by the vocabulary name rather than an object literal: the
 * project's naming convention reserves dotted names for *values* (an event type
 * is a string), and a keyed record would need quoted member names the linter
 * rightly refuses.
 */
const SWEEP_DECISIONS: ReadonlyMap<string, string> = new Map<SweepEventType, string>([
    ['dispatch.lease-expired', 'requeued'],
    ['run.dead_lettered', 'dead-lettered'],
    ['dispatch.unconfirmed', 'unconfirmed'],
]);

/**
 * Narrow a stored event type to one of the sweep's rows.
 *
 * Keyed off the decision table rather than a separate set, so the two cannot
 * drift, and typed rather than a widened `string` so the lookup below is total
 * and the parsed intent keeps its literal event type.
 */
function isSweepEventType(value: string): value is SweepEventType {
    return SWEEP_DECISIONS.has(value);
}

/** Simple run states the outbox may snapshot. */
const STATES: ReadonlySet<string> = new Set([
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
]);

/** Parse a list of non-empty text values used by persisted audit intents. */
function parseTextList(raw: unknown): readonly string[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    const values: string[] = [];
    for (const value of raw) {
        const text = readText(value);
        if (text === null) {
            return null;
        }
        values.push(text);
    }

    return values;
}

/** Validate the complete eight-state vocabulary used by stored runs. */
function isRunState(value: unknown): value is RunState {
    if (typeof value !== 'string') {
        return false;
    }
    if (STATES.has(value)) {
        return true;
    }

    const blockedReason = value.startsWith('blocked:') ? value.slice('blocked:'.length) : '';
    return blockedReason !== '' && blockedReason.split('-').every((part) => /^[a-z0-9]+$/.test(part));
}

/** Parse identity and delivery fields shared by both creation intent variants. */
function parseIntentBase(value: Record<string, unknown>): {
    readonly correlationId: string;
    readonly deliveryIds: readonly string[];
} | null {
    const correlationId = readText(value.correlationId);
    const deliveryIds = parseTextList(value.deliveryIds);
    if (
        correlationId === null
        || deliveryIds === null
        || deliveryIds.length === 0
        || !/^mt-run-[0-9a-f]{24}$/.test(correlationId)
    ) {
        return null;
    }

    return { correlationId, deliveryIds };
}

/** Parse the migration-only state details of an intent. */
function parseMigrationDetails(value: Record<string, unknown>): {
    readonly stateBranches: readonly string[];
    readonly state: RunState;
} | null {
    const stateBranches = parseTextList(value.stateBranches);
    if (stateBranches === null || stateBranches.length === 0 || !isRunState(value.state)) {
        return null;
    }

    return { stateBranches, state: value.state };
}

/** Parse a single durable creation or migration audit intent. */
function parseIntent(value: unknown): RunAuditIntent | null {
    if (!isRecord(value)) {
        return null;
    }
    const base = parseIntentBase(value);
    if (base === null) {
        return null;
    }

    if (value.eventType === 'run.created') {
        return { eventType: 'run.created', ...base };
    }

    if (value.eventType !== 'run.migrated') {
        return null;
    }
    const migration = parseMigrationDetails(value);
    if (migration === null) {
        return null;
    }

    return { eventType: 'run.migrated', ...base, ...migration };
}

/**
 * Parse the structured, credential-free details a sweep row records.
 *
 * Only the scalar shapes the sweep itself writes are accepted, and the token
 * fingerprint's prefix is pinned: an intent that carried a `dtk-` value would
 * turn the recovery mechanism into a credential store, which is the one thing
 * the outbox must never be (FR-061, T-040c).
 *
 * @param raw - Candidate details record.
 * @returns The details, or `null` when any member is malformed or forbidden.
 */
function parseSweepDetails(raw: unknown): Record<string, string | number | boolean | null> | null {
    if (!isRecord(raw)) {
        return null;
    }

    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
            if (value.includes('dtk-')) {
                return null;
            }
            details[key] = value;
        } else if (
            typeof value === 'boolean'
            || value === null
            || (typeof value === 'number' && Number.isFinite(value))
        ) {
            details[key] = value;
        } else {
            return null;
        }
    }

    return details;
}

/** Parse one durable sweep intent: the row the pass owed and could not write. */
function parseSweepIntent(value: Record<string, unknown>): RunAuditIntent | null {
    const { eventType: rawEventType } = value;
    if (typeof rawEventType !== 'string' || !isSweepEventType(rawEventType)) {
        return null;
    }

    const eventType = rawEventType;

    const { correlationId: rawId, reason: rawReason, sequence: rawSequence, decision: rawDecision } = value;
    const correlationId = readText(rawId);
    const reason = readText(rawReason);
    const sequence = readText(rawSequence);
    const details = parseSweepDetails(value.details);
    const decision = readText(rawDecision);
    if (
        correlationId === null
        || reason === null
        || sequence === null
        || details === null
        || decision !== SWEEP_DECISIONS.get(eventType)
        || !/^mt-run-[0-9a-f]{24}$/.test(correlationId)
    ) {
        return null;
    }

    return { eventType, correlationId, decision, reason, details, sequence };
}

/** Parse a single outbox entry, whichever producer wrote it. */
function parseEntry(value: unknown): RunAuditIntent | null {
    const creation = parseIntent(value);

    return creation ?? (isRecord(value) ? parseSweepIntent(value) : null);
}

/** Parse the run document's optional outbox as a wholly valid list. */
export function parseRunAuditIntents(raw: unknown): readonly RunAuditIntent[] | null {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        return null;
    }

    const intents: RunAuditIntent[] = [];
    for (const value of raw) {
        const intent = parseEntry(value);
        if (intent === null) {
            return null;
        }
        intents.push(intent);
    }

    return intents;
}
