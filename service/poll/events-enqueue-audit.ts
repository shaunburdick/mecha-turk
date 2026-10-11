/** Run and delivery audit rows written after an enqueue becomes durable. */

import { createHash } from 'node:crypto';
import { appendAudit } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { EnqueueOutcome } from './runs-join.ts';

/** Context shared by all audit writers for one enqueue. */
interface EnqueueAuditInput {
    /** Open service store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Run changes derived from the fresh deliveries. */
    readonly outcome: EnqueueOutcome;
    /** Persisted event rows linked to their run ids. */
    readonly appended: readonly QueuedEvent[];
}

/** How many hex characters of the digest one fingerprint carries. */
const FINGERPRINT_CHARS = 24;

/**
 * The credential-free fingerprint of one follow-up's excerpt (002 FR-035).
 *
 * A fingerprint and a length, never the text: the trail has to be able to say
 * *which* comment was observed without becoming its second home.
 *
 * @param excerpt - The row's bounded untrusted excerpt.
 * @returns `fp-` plus the first 24 hex characters of its SHA-256.
 */
export function followUpFingerprint(excerpt: string): string {
    return `fp-${createHash('sha256').update(excerpt).digest('hex').slice(0, FINGERPRINT_CHARS)}`;
}

/** Append one audit row; durable run and queue writes are not rolled back. */
async function appendEnqueueAudit(
    input: Pick<EnqueueAuditInput, 'store' | 'log'>,
    row: Parameters<typeof appendAudit>[1],
): Promise<void> {
    try {
        await appendAudit(input.store, row);
    } catch (cause) {
        input.log.warn('enqueue audit row could not be appended', {
            eventType: row.eventType,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 * Record one coalescence for each additional source delivery.
 *
 * The row carries whether the reference was retained and how many triggers the
 * cap has kept off the run's list: a delivery that joined a full run is
 * still fully accounted for here, so the audit trail never shows a trigger that
 * vanished without explanation.
 */
async function recordJoinedDeliveries(input: EnqueueAuditInput): Promise<void> {
    for (const joined of input.outcome.joins) {
        await appendEnqueueAudit(input, {
            eventType: 'run.coalesced',
            actorSource: 'service',
            entity: { kind: 'run', id: joined.run.correlationId },
            correlationId: joined.run.correlationId,
            decision: 'coalesced',
            reason: joined.retained
                ? 'delivery joined an open run'
                : 'delivery joined an open run whose reference list was full; counted, not retained',
            details: {
                deliveryId: joined.reference.deliveryId,
                kind: joined.reference.kind,
                origin: joined.reference.origin,
                presentAtAuthorization: joined.reference.presentAtAuthorization,
                retained: joined.retained,
                referencesNotRetained: joined.run.referencesNotRetained,
            },
        });
    }
}

/** Record detection rows with the service-assigned run correlation id. */
async function recordDetectedDeliveries(input: EnqueueAuditInput): Promise<void> {
    for (const event of input.appended) {
        await appendEnqueueAudit(input, {
            eventType: 'delivery.detected',
            actorSource: 'service',
            entity: { kind: 'delivery', id: event.id },
            ...(event.runCorrelationId !== undefined && { correlationId: event.runCorrelationId }),
            reason: `${event.kind} trigger matched a binding`,
            details: {
                bindingId: event.bindingId,
                repository: event.repository,
                kind: event.kind,
                ...(event.runCorrelationId !== undefined && { runCorrelationId: event.runCorrelationId }),
            },
        });
    }
}

/**
 * Record one observed follow-up for every follow-up the pass folded.
 *
 * The row is the trail's half of NFR-007's chain: the run's correlation id
 * traces the observation through the delivery into the session, and the row
 * carries the fingerprint, the length, and the counts rather than the text
 * (002 FR-035).
 */
async function recordFollowUps(input: EnqueueAuditInput): Promise<void> {
    const rows = new Map(input.appended.map((event) => [event.id, event]));
    for (const joined of input.outcome.followUps) {
        const row = rows.get(joined.deliveryId);
        const excerpt = row?.issueBodyExcerpt ?? '';
        await appendEnqueueAudit(input, {
            eventType: 'follow_up.observed',
            actorSource: 'service',
            entity: { kind: 'delivery', id: joined.deliveryId },
            correlationId: joined.run.correlationId,
            decision: null,
            reason: joined.kind === 'head'
                ? 'a tracked pull request head moved'
                : 'a tracked issue or pull request gained a comment',
            details: {
                deliveryId: joined.deliveryId,
                excerptFingerprint: followUpFingerprint(excerpt),
                excerptLength: excerpt.length,
                kind: joined.kind,
                runCorrelationId: joined.run.correlationId,
            },
        });
    }
}

/** Append coalescing and detection audit records after durable enqueue writes. */
export async function recordEnqueueAudits(input: EnqueueAuditInput): Promise<void> {
    await recordFollowUps(input);
    await recordJoinedDeliveries(input);
    await recordDetectedDeliveries(input);
}
