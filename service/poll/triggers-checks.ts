/**
 * The check watch: one bounded, persisted poll per armed tracked head
 * (FR-126 – FR-130).
 */

import { repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { checksFollowUp } from './follow-up.ts';
import type { PollPull, PollFailure  } from './poller-github.ts';
import { failingConclusionOf } from './poller-checks.ts';
import type { HeadChecksOutcome } from './poller-checks.ts';
import type { QueuedEvent } from './events.ts';
import type { ChecksWatch } from './runs-types.ts';
import type { TrackedSubject, TrackingEnd } from './tracking.ts';
import type { ChecksAudit, TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

/** Reads one watch may spend before it expires without a conclusion. */
const MAX_WATCH_POLLS = 30;

/** How long one watch may stay armed without a conclusion. */
const MAX_WATCH_MS = 30 * 60_000;

/** A verdict whose read completed, narrowed out of its failure arm. */
type ListedChecks = Extract<HeadChecksOutcome, { readonly kind: 'ok' }>;

/** What one subject's watch asks the scan to persist, row or drop. */
interface WatchChange {
    readonly write?: ChecksWatch;
    readonly audit?: ChecksAudit;
    /** The one alert this change delivers, when the concluded aggregate is news. */
    readonly row?: QueuedEvent;
}

/** Everything one cycle accumulates while it walks the tracked pulls. */
interface ScanState {
    readonly writes: Map<string, ChecksWatch>;
    readonly audits: ChecksAudit[];
    readonly events: QueuedEvent[];
    readonly reads: Map<string, HeadChecksOutcome>;
}

/**
 * One checks audit row's reason line, credential-free by construction.
 */
export function checksAuditReason(eventType: ChecksAudit['eventType']): string {
    switch (eventType) {
        case 'checks.watched': {
            return 'a check watch was armed for this head';
        }
        case 'checks.observed': {
            return 'the check watch concluded';
        }
        case 'checks.expired': {
            return 'the check watch expired before the suite concluded';
        }
        case 'checks.unavailable': {
            return 'the check-runs read failed; the watch is kept';
        }
    }
}

/**
 * Whether one watch has spent its window: too many reads, or too long armed.
 */
function expiryReasonOf(watch: ChecksWatch, detectedAt: string): 'polls' | 'elapsed' | null {
    if (watch.polls >= MAX_WATCH_POLLS) {
        return 'polls';
    }

    return Date.parse(detectedAt) - Date.parse(watch.armedAt) >= MAX_WATCH_MS ? 'elapsed' : null;
}

/** The audit row one watch state change asks for. */
function auditOf(input: {
    readonly eventType: ChecksAudit['eventType'];
    readonly bindingId: string;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly watch: ChecksWatch;
    readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
}): ChecksAudit {
    return {
        eventType: input.eventType,
        bindingId: input.bindingId,
        correlationId: input.correlationId,
        details: {
            headSha: input.watch.headSha,
            subjectNumber: input.subjectNumber,
            polls: input.watch.polls,
            armedAt: input.watch.armedAt,
            ...input.extra,
        },
    };
}

/** A watch armed at a newly observed head; the arming cycle never reads. */
function armChange(input: {
    readonly bindingId: string;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly headSha: string;
    readonly detectedAt: string;
}): WatchChange {
    const watch: ChecksWatch = { headSha: input.headSha, armedAt: input.detectedAt, polls: 0, verdict: 'watching' };

    return {
        write: watch,
        audit: auditOf({
            eventType: 'checks.watched',
            bindingId: input.bindingId,
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch,
        }),
    };
}

/** A watch that spent its window before it could conclude. */
function expiryChange(input: {
    readonly bindingId: string;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly watch: ChecksWatch;
    readonly reason: 'polls' | 'elapsed';
}): WatchChange {
    return {
        write: { ...input.watch, verdict: 'expired' },
        audit: auditOf({
            eventType: 'checks.expired',
            bindingId: input.bindingId,
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch: input.watch,
            extra: { reason: input.reason },
        }),
    };
}

/** The inert verdict a completed read concludes with. */
function verdictOf(listed: ListedChecks): ChecksWatch['verdict'] {
    if (listed.conclusion !== null) {
        return 'failed';
    }

    return listed.count === 0 ? 'none' : 'passed';
}

/** Whether one failing run is at least as new as the watch that saw it. */
function isNewsAt(input: { readonly completedAt: string | null; readonly armedAt: string }): boolean {
    if (input.completedAt === null) {
        // An unreadable fact must not hide a failure.
        return true;
    }

    const armed = Date.parse(input.armedAt);
    if (Number.isNaN(armed)) {
        return true;
    }

    return Date.parse(input.completedAt) >= armed;
}

/**
 * Whether a concluded red suite is alertable: a moved head is news whatever
 * completed first, while a dispatch-head watch alerts only for a failure that
 * completed at or after it was armed (FR-126).
 */
function alertableOf(input: {
    readonly listed: ListedChecks;
    readonly armedAt: string;
    readonly news: boolean;
}): boolean {
    if (input.news) {
        return true;
    }

    return input.listed.runs.some((run) =>
        failingConclusionOf([run]) !== null && isNewsAt({ completedAt: run.completedAt, armedAt: input.armedAt }));
}

/** A completed read's change: conclude into inert state, or keep watching. */
function concludedChange(input: {
    readonly bindingId: string;
    readonly binding: BindingRecord;
    readonly pull: PollPull;
    readonly tracked: TrackedSubject;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly watch: ChecksWatch;
    readonly spent: ChecksWatch;
    readonly listed: ListedChecks;
    readonly news: boolean;
    readonly detectedAt: string;
}): WatchChange {
    const { listed } = input;
    if (listed.truncated || (listed.count > 0 && !listed.completed)) {
        return { write: input.spent };
    }

    const { conclusion } = listed;
    const isPreExisting = conclusion !== null
        && !alertableOf({ listed, armedAt: input.watch.armedAt, news: input.news });
    const isAlerted = conclusion !== null && !isPreExisting;
    // The row is composed before the audit so `alerted` can only ever name a row
    // that exists: an actor-gated subject concludes inert with no delivery.
    const row = isAlerted
        ? checksFollowUp({
            binding: input.binding,
            pull: input.pull,
            tracked: input.tracked,
            headSha: input.watch.headSha,
            names: listed.names,
            detectedAt: input.detectedAt,
        })
        : null;

    return {
        write: { ...input.spent, verdict: verdictOf(listed) },
        ...(row !== null && { row }),
        audit: auditOf({
            eventType: 'checks.observed',
            bindingId: input.bindingId,
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch: input.spent,
            extra: {
                conclusion,
                preExisting: isPreExisting,
                alerted: row !== null,
            },
        }),
    };
}

/** A failed read's change, with the one class that still ends the scan. */
function failureChange(input: {
    readonly bindingId: string;
    readonly failure: PollFailure;
    readonly spent: ChecksWatch;
    readonly correlationId: string;
    readonly subjectNumber: number;
}): { readonly change?: WatchChange; readonly rateLimited?: PollFailure } {
    if (input.failure.kind === 'rate-limited') {
        return { rateLimited: input.failure };
    }

    return {
        change: {
            write: input.spent,
            audit: auditOf({
                eventType: 'checks.unavailable',
                bindingId: input.bindingId,
                correlationId: input.correlationId,
                subjectNumber: input.subjectNumber,
                watch: input.spent,
                extra: { failure: input.failure.kind },
            }),
        },
    };
}

function applyChange(input: {
    readonly state: ScanState;
    readonly correlationId: string;
    readonly change: WatchChange;
}): void {
    const { state, correlationId, change } = input;
    if (change.write !== undefined) {
        state.writes.set(correlationId, change.write);
    }

    if (change.audit !== undefined) {
        state.audits.push(change.audit);
    }

    if (change.row !== undefined) {
        state.events.push(change.row);
    }
}

/** What one pre-read decision asks for: do nothing more, read, or apply a change. */
type PreRead =
    | { readonly action: 'read' }
    | { readonly action: 'inert' }
    | { readonly action: 'change'; readonly change: WatchChange };

/** The change a watch needs before any read: arm, expire, read, or stay inert. */
function preReadChange(input: {
    readonly bindingId: string;
    readonly watch: ChecksWatch | null;
    readonly headSha: string;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly detectedAt: string;
}): PreRead {
    const { watch, headSha, correlationId, subjectNumber, detectedAt } = input;
    if (watch?.headSha !== headSha) {
        return {
            action: 'change',
            change: armChange({ bindingId: input.bindingId, correlationId, subjectNumber, headSha, detectedAt }),
        };
    }

    if (watch.verdict !== 'watching') {
        return { action: 'inert' };
    }

    const expired = expiryReasonOf(watch, detectedAt);

    return expired === null
        ? { action: 'read' }
        : {
            action: 'change',
            change: expiryChange({ bindingId: input.bindingId, correlationId, subjectNumber, watch, reason: expired }),
        };
}

async function pollWatch(input: TriggerScanInput & {
    readonly pull: PollPull;
    readonly subject: TrackedSubject;
    readonly subjectNumber: number;
    readonly state: ScanState;
    readonly detectedAt: string;
}): Promise<PollFailure | null> {
    const { pull, subject, subjectNumber, state, detectedAt } = input;
    const { headSha } = pull;
    const { correlationId } = subject;
    if (headSha === null || subject.checksWatch === null) {
        return null;
    }

    let listed = state.reads.get(headSha);
    if (listed === undefined) {
        const repository = repositoryRefOf(input.binding.repository);
        listed = await input.poller.listHeadChecks({
            token: input.token,
            owner: repository.owner,
            name: repository.name,
            headSha,
            pace: input.pace,
        });
        state.reads.set(headSha, listed);
    }

    const spent: ChecksWatch = { ...subject.checksWatch, polls: subject.checksWatch.polls + 1 };
    if (listed.kind !== 'ok') {
        const failed = failureChange({
            bindingId: input.binding.bindingId,
            failure: listed,
            spent,
            correlationId,
            subjectNumber,
        });
        if (failed.change !== undefined) {
            applyChange({ state, correlationId, change: failed.change });
            input.log.warn('check-runs read failed; the watch is kept', { headSha, failure: listed.kind });
        }

        return failed.rateLimited ?? null;
    }

    if (listed.truncated) {
        input.log.warn('check-runs walk truncated; the watch is kept', { headSha });
    }

    applyChange({
        state,
        correlationId,
        change: concludedChange({
            bindingId: input.binding.bindingId,
            binding: input.binding,
            pull,
            tracked: subject,
            correlationId,
            subjectNumber,
            watch: subject.checksWatch,
            spent,
            listed,
            news: subject.lastHeadSha !== subject.checksWatch.headSha,
            detectedAt,
        }),
    });

    return null;
}

async function visitTrackedPull(input: TriggerScanInput & {
    readonly pull: PollPull;
    readonly subjectNumber: number;
    readonly subject: TrackedSubject;
    readonly state: ScanState;
    readonly detectedAt: string;
}): Promise<PollFailure | null> {
    const { pull, subject, subjectNumber, state, detectedAt } = input;
    if (pull.headSha === null) {
        return null;
    }

    const early = preReadChange({
        bindingId: input.binding.bindingId,
        watch: subject.checksWatch,
        headSha: pull.headSha,
        correlationId: subject.correlationId,
        subjectNumber,
        detectedAt,
    });
    if (early.action === 'inert') {
        return null;
    }

    if (early.action === 'change') {
        applyChange({ state, correlationId: subject.correlationId, change: early.change });

        return null;
    }

    return await pollWatch({ ...input, pull, subject, subjectNumber, state, detectedAt });
}

/**
 * The watches whose subject's tracking ended this cycle, by run correlation id.
 *
 * A watch whose pull has left the open list is never read; this is what clears
 * the member when the end is observed on the terminal read instead.
 */
export function watchDropsForEnds(input: {
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
    readonly ends: readonly TrackingEnd[];
}): readonly string[] {
    return input.ends.flatMap((end) => {
        const subject = input.tracked.get(end.subjectNumber);

        return subject !== undefined && subject.checksWatch !== null ? [end.correlationId] : [];
    });
}

/**
 * Arm, expire, or poll each tracked pull's watch over the cycle's one pulls
 * list, and report the writes and audit rows the scan must persist.
 *
 * Arming is silent: a watch is first polled the cycle after it is written. A
 * concluded watch stays on the run as inert state — never read, audited, or
 * alerted again — and a dispatch-head watch ignores failures that completed
 * before it armed (FR-126). A head change replaces the watch.
 */
export async function triggersChecks(
    input: TriggerScanInput & {
        readonly pulls: readonly PollPull[];
    },
): Promise<TriggerEvents> {
    const { tracked, detectedAt, pulls } = input;
    const byNumber = new Map(pulls.map((pull) => [pull.pullNumber, pull]));
    const state: ScanState = { writes: new Map(), audits: [], events: [], reads: new Map() };

    for (const [subjectNumber, subject] of tracked) {
        const pull = byNumber.get(subjectNumber);
        if (pull === undefined || subject.subjectType !== 'pull_request') {
            continue;
        }

        const failure = await visitTrackedPull({
            ...input,
            pull,
            subjectNumber,
            subject,
            state,
            detectedAt,
        });
        if (failure !== null) {
            return { ok: false, failure };
        }
    }

    return {
        ok: true,
        events: state.events,
        ...(state.writes.size > 0 && { checksWrites: state.writes }),
        ...(state.audits.length > 0 && { checksAudits: state.audits }),
    };
}
