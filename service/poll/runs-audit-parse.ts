/** Strict parser for the durable run audit-intent outbox. */

import { isRecord, readText } from '../json.ts';
import type { RunAuditIntent, RunState } from './runs-types.ts';

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

/** Parse identity and delivery fields shared by both intent variants. */
function parseIntentBase(value: Record<string, unknown>): {
    readonly correlationId: string;
    readonly deliveryIds: readonly string[];
} | null {
    const correlationId = readText(value.correlationId);
    const deliveryIds = parseTextList(value.deliveryIds);
    if (
        correlationId === null
        || !/^mt-run-[0-9a-f]{24}$/.test(correlationId)
        || deliveryIds === null
        || deliveryIds.length === 0
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
        const intent = parseIntent(value);
        if (intent === null) {
            return null;
        }
        intents.push(intent);
    }

    return intents;
}
