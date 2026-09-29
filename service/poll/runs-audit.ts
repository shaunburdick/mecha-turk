/** Durable outbox for required run-creation and migration audit rows. */

import { appendAudit, readAuditEntries } from '../audit.ts';
import type { AuditEntry, AuditInput } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { Run, RunAuditIntent, RunsDocument } from './runs-types.ts';

/** Shape used while rebuilding one contract-defined audit row. */
interface IntentRowInput {
    /** Durable intent to be written. */
    readonly intent: RunAuditIntent;
    /** Run referenced by the intent. */
    readonly run: Run;
}

/** Build the existing audit-contract row from its durable intent. */
function auditRowForIntent(input: IntentRowInput): AuditInput {
    const { intent, run } = input;
    if (intent.eventType === 'run.created') {
        return {
            eventType: intent.eventType,
            actorSource: 'service',
            entity: { kind: 'run', id: intent.correlationId },
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

    return {
        eventType: intent.eventType,
        actorSource: 'service',
        entity: { kind: 'run', id: intent.correlationId },
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

/** Find a durable row that proves an intent's append completed before a crash. */
function intentIsWritten(intent: RunAuditIntent, entries: readonly AuditEntry[]): boolean {
    return entries.some((entry) => entry.eventType === intent.eventType
        && entry.correlationId === intent.correlationId
        && entry.entity.kind === 'run'
        && entry.entity.id === intent.correlationId);
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
        const persisted = await persistIntent({ ...input, intent, entries });
        if (!persisted) {
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
