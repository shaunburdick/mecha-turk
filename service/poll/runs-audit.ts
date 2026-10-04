/**
 * Durable outbox for run-lifecycle audit rows whose append can span a crash
 * (003 T-037, T-040b).
 *
 * Three producers owe rows the audit trail must eventually carry: run creation,
 * migration adoption, and the lease/deadline sweep. Each writes its intent into
 * the same `runs.json` write that changed the state it describes, so the only
 * way a row goes missing is a process that dies between the two — and the next
 * reader of the document finds the intent and writes the row anyway.
 *
 * That is the whole point of the outbox. FR-063 says a failed lifecycle append
 * must not roll back a durable state change and must not be swallowed; before
 * this module the sweep had no way to satisfy either half, because it has no
 * caller to answer: the only place an operator could learn that a lease expired
 * and the run was requeued was the trail, so a lost row was a lost recovery.
 *
 * The sweep's intents are distinguished by a `sequence` discriminator rather
 * than by their event type alone, because one run can be lease-expired three
 * times (FR-033's budget) and a matcher that only compared the event type would
 * retire the second recovery against the first row and never write it.
 */

import { appendAudit, readAuditEntries } from '../audit.ts';
import type { AuditEntry, AuditInput } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { Run, RunAuditIntent, RunsDocument } from './runs-types.ts';

/** The run entity every lifecycle row carries (FR-061's entity requirement). */
const RUN_ENTITY_KIND = 'run';

/** Actor source for every row this outbox writes; all three are service rows. */
const SERVICE_ACTOR = 'service';

/** The rejection a row builder raises when handed the wrong intent variant. */
const WRONG_VARIANT = 'intent variant does not match the row builder';

/** Vocabulary names for the two run-creation intents, named once. */
const RUN_CREATED = 'run.created';
const RUN_MIGRATED = 'run.migrated';

/** Shape used while rebuilding one contract-defined audit row. */
interface IntentRowInput {
    /** Durable intent to be written. */
    readonly intent: RunAuditIntent;
    /** Run referenced by the intent. */
    readonly run: Run;
}

/** Build the creation row from its durable intent and the run it names. */
function createdRow(input: IntentRowInput): AuditInput {
    const { intent, run } = input;
    if (intent.eventType !== RUN_CREATED) {
        throw new Error(WRONG_VARIANT);
    }

    return {
        eventType: intent.eventType,
        actorSource: SERVICE_ACTOR,
        entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
        correlationId: intent.correlationId,
        reason: 'run created from a detected delivery',
        details: {
            subject: {
                provider: 'github',
                accountNumericUserId: run.accountNumericUserId,
                repository: run.repository,
                subjectType: run.subjectType,
                subjectNumber: run.subjectNumber,
            },
            ordinal: run.ordinal,
            deliveryIds: intent.deliveryIds,
        },
    };
}

/** Build the migration row from its durable intent. */
function migratedRow(input: IntentRowInput): AuditInput {
    const { intent } = input;
    if (intent.eventType !== RUN_MIGRATED) {
        throw new Error(WRONG_VARIANT);
    }

    return {
        eventType: intent.eventType,
        actorSource: SERVICE_ACTOR,
        entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
        correlationId: intent.correlationId,
        decision: 'adopted',
        reason: `legacy deliveries adopted: ${intent.stateBranches.join(', ')}`,
        details: {
            deliveryIds: intent.deliveryIds,
            stateBranches: intent.stateBranches,
            state: intent.state,
        },
    };
}

/**
 * Build a sweep row from its durable intent.
 *
 * The sweep's rows need no run lookup: the intent already carries the decision,
 * reason, and details exactly as the pass recorded them, so a replay writes the
 * same bytes even if the run has moved on since.
 *
 * **Exported because the sweep's own live append must use this exact builder**,
 * not a parallel copy. The outbox retires an intent by finding a row that
 * matches it, so a live row written from different members than its own intent
 * would never match — the recovery would append the same recovery twice.
 */
export function sweepAuditRow(intent: Extract<RunAuditIntent, { readonly sequence: string }>): AuditInput {
    return {
        eventType: intent.eventType,
        actorSource: SERVICE_ACTOR,
        entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
        correlationId: intent.correlationId,
        decision: intent.decision,
        reason: intent.reason,
        details: { ...intent.details, sequence: intent.sequence },
    };
}

/** Build the existing audit-contract row from its durable intent. */
function auditRowForIntent(input: IntentRowInput): AuditInput {
    const { intent } = input;

    if (intent.eventType === RUN_CREATED) {
        return createdRow(input);
    }

    return intent.eventType === RUN_MIGRATED
        ? migratedRow(input)
        : sweepAuditRow(intent);
}

/** Whether an intent is one of the sweep's self-contained rows. */
function isSweepIntent(intent: RunAuditIntent): intent is Extract<RunAuditIntent, { readonly sequence: string }> {
    return intent.eventType !== RUN_CREATED && intent.eventType !== RUN_MIGRATED;
}

/** Find a durable row that proves an intent's append completed before a crash. */
function intentIsWritten(intent: RunAuditIntent, entries: readonly AuditEntry[]): boolean {
    return entries.some((entry) => {
        if (entry.eventType !== intent.eventType || entry.correlationId !== intent.correlationId) {
            return false;
        }
        if (entry.entity.kind !== RUN_ENTITY_KIND || entry.entity.id !== intent.correlationId) {
            return false;
        }

        // A sweep row is only the same row when its discriminator matches too —
        // a run can be lease-expired three times, and matching on the event type
        // alone would retire recovery #2 against row #1.
        return !isSweepIntent(intent) || entry.details.sequence === intent.sequence;
    });
}

/** Append one intent if needed, leaving it pending on any storage failure. */
async function persistIntent(input: {
    readonly intent: RunAuditIntent;
    readonly document: RunsDocument;
    readonly entries: AuditEntry[];
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<boolean> {
    const { intent, document, entries, store, log } = input;
    if (intentIsWritten(intent, entries)) {
        return true;
    }

    const run = document.runs.find((candidate) => candidate.correlationId === intent.correlationId);
    if (run === undefined) {
        log.warn('run audit intent has no retained run; keeping intent for recovery', {
            eventType: intent.eventType,
        });
        return false;
    }

    try {
        entries.push(await appendAudit(store, auditRowForIntent({ intent, run })));
        return true;
    } catch (cause) {
        log.warn('run lifecycle audit row could not be appended', {
            eventType: intent.eventType,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
        return false;
    }
}

/** Append pending run audits and then retire only intents known durable. */
export async function flushRunAuditIntents(input: {
    /** Open service store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Persisted run document currently carrying the outbox. */
    readonly document: RunsDocument;
    /** Store-relative run document path. */
    readonly runsFile: string;
}): Promise<RunsDocument> {
    const intents = input.document.auditIntents ?? [];
    if (intents.length === 0) {
        return input.document;
    }

    let entries: AuditEntry[];
    try {
        entries = [...await readAuditEntries(input.store)];
    } catch (cause) {
        input.log.warn('run lifecycle audit trail could not be read for recovery', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
        return input.document;
    }

    const remaining: RunAuditIntent[] = [];
    for (const intent of intents) {
        const isPersisted = await persistIntent({ ...input, intent, entries });
        if (!isPersisted) {
            remaining.push(intent);
        }
    }
    if (remaining.length === intents.length) {
        return input.document;
    }

    const recovered = { ...input.document, auditIntents: remaining };
    try {
        await input.store.writeJson(input.runsFile, recovered);
        return recovered;
    } catch (cause) {
        input.log.warn('completed run lifecycle audit intents could not be retired', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
        return input.document;
    }
}
