/**
 * The check watch: one bounded, persisted poll per armed tracked head
 * (FR-126 – FR-130).
 */

import { repositoryRefOf } from '../../src/config.ts';
import type { ServiceStore } from '../store/index.ts';
import { checksFollowUp } from './follow-up.ts';
import type { PollPull, PollFailure  } from './poller-github.ts';
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
    readonly drop?: boolean;
    readonly audit?: ChecksAudit;
    readonly alert?: boolean;
}

/** Everything one cycle accumulates while it walks the tracked pulls. */
interface ScanState {
    readonly writes: Map<string, ChecksWatch>;
    readonly drops: string[];
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
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly watch: ChecksWatch;
    readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
}): ChecksAudit {
    return {
        eventType: input.eventType,
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
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly headSha: string;
    readonly detectedAt: string;
}): WatchChange {
    const watch: ChecksWatch = { headSha: input.headSha, armedAt: input.detectedAt, polls: 0 };

    return {
        write: watch,
        audit: auditOf({
            eventType: 'checks.watched',
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch,
        }),
    };
}

/** A watch that spent its window before it could conclude. */
function expiryChange(input: {
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly watch: ChecksWatch;
    readonly reason: 'polls' | 'elapsed';
}): WatchChange {
    return {
        drop: true,
        audit: auditOf({
            eventType: 'checks.expired',
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch: input.watch,
            extra: { reason: input.reason },
        }),
    };
}

/** A completed read's change: keep while inconclusive, drop on a verdict. */
function concludedChange(input: {
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly spent: ChecksWatch;
    readonly listed: ListedChecks;
}): WatchChange {
    const { listed } = input;
    if (listed.truncated || (listed.count > 0 && !listed.completed)) {
        return { write: input.spent };
    }

    if (listed.count === 0) {
        return { drop: true };
    }

    return {
        drop: true,
        alert: listed.conclusion !== null,
        audit: auditOf({
            eventType: 'checks.observed',
            correlationId: input.correlationId,
            subjectNumber: input.subjectNumber,
            watch: input.spent,
            extra: {
                conclusion: listed.conclusion,
                completed: true,
                failing: listed.conclusion !== null,
            },
        }),
    };
}

/** A failed read's change, with the one class that still ends the scan. */
function failureChange(input: {
    readonly failure: PollFailure;
    readonly spent: ChecksWatch;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly claimed: boolean;
}): { readonly change?: WatchChange; readonly rateLimited?: PollFailure } {
    if (input.failure.kind === 'rate-limited') {
        return { rateLimited: input.failure };
    }

    return {
        change: {
            write: input.spent,
            ...(!input.claimed && {
                audit: auditOf({
                    eventType: 'checks.unavailable',
                    correlationId: input.correlationId,
                    subjectNumber: input.subjectNumber,
                    watch: input.spent,
                    extra: { failure: input.failure.kind },
                }),
            }),
        },
    };
}

/** Per-store binding ids that have already written a `checks.unavailable` row. */
const unavailableClaims = new WeakMap<ServiceStore, Set<string>>();

/**
 * Read the process-long claim set for one store handle.
 *
 * Keyed by the handle, not the binding id alone: a restarted service writes the
 * row again only after a fresh read of the same store, which is the same
 * per-process posture the queue's quarantine recovery takes.
 */
export function checksUnavailableClaimFor(store: ServiceStore): Set<string> {
    const existing = unavailableClaims.get(store);
    if (existing !== undefined) {
        return existing;
    }

    const claimed = new Set<string>();
    unavailableClaims.set(store, claimed);

    return claimed;
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

    if (change.drop === true) {
        state.drops.push(correlationId);
    }

    if (change.audit !== undefined) {
        state.audits.push(change.audit);
    }
}

/** The change a watch needs before any read: arm, expire, or nothing. */
function preReadChange(input: {
    readonly watch: ChecksWatch | null;
    readonly headSha: string;
    readonly correlationId: string;
    readonly subjectNumber: number;
    readonly detectedAt: string;
}): WatchChange | null {
    const { watch, headSha, correlationId, subjectNumber, detectedAt } = input;
    if (watch?.headSha !== headSha) {
        return armChange({ correlationId, subjectNumber, headSha, detectedAt });
    }

    const expired = expiryReasonOf(watch, detectedAt);

    return expired === null ? null : expiryChange({ correlationId, subjectNumber, watch, reason: expired });
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
            failure: listed,
            spent,
            correlationId,
            subjectNumber,
            claimed: input.checksUnavailableClaim.has(input.binding.bindingId),
        });
        if (failed.change !== undefined) {
            applyChange({ state, correlationId, change: failed.change });
            input.checksUnavailableClaim.add(input.binding.bindingId);
            input.log.warn('check-runs read failed; the watch is kept', { headSha, failure: listed.kind });
        }

        return failed.rateLimited ?? null;
    }

    if (listed.truncated) {
        input.log.warn('check-runs walk truncated; the watch is kept', { headSha });
    }

    const change = concludedChange({ correlationId, subjectNumber, spent, listed });
    applyChange({ state, correlationId, change });
    if (change.alert === true) {
        const row = checksFollowUp({
            binding: input.binding,
            pull,
            tracked: subject,
            headSha,
            names: listed.names,
            detectedAt,
        });
        if (row !== null) {
            state.events.push(row);
        }
    }

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
        watch: subject.checksWatch,
        headSha: pull.headSha,
        correlationId: subject.correlationId,
        subjectNumber,
        detectedAt,
    });
    if (early !== null) {
        applyChange({ state, correlationId: subject.correlationId, change: early });

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
 * list, and report the rows and run-document operations the scan must persist.
 *
 * Arming is silent: a watch is first polled the cycle after it is written, so a
 * failure already visible at arm never alerts from that cycle (FR-126). A head
 * change replaces the watch, so a superseded SHA is never read.
 */
export async function triggersChecks(
    input: TriggerScanInput & {
        readonly pulls: readonly PollPull[];
        /** Pull subjects whose tracking ended this cycle, whose watches drop. */
        readonly ends: readonly TrackingEnd[];
    },
): Promise<TriggerEvents> {
    const { tracked, detectedAt, ends, pulls } = input;
    const byNumber = new Map(pulls.map((pull) => [pull.pullNumber, pull]));
    const state: ScanState = { writes: new Map(), drops: [], audits: [], events: [], reads: new Map() };

    for (const end of ends) {
        state.drops.push(end.correlationId);
    }

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
        ...(state.drops.length > 0 && { checksDrops: state.drops }),
        ...(state.audits.length > 0 && { checksAudits: state.audits }),
    };
}
