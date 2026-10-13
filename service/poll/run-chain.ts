/**
 * The shared chain task every run-scoped operation performs (003 T-011–T-014).
 */

import { nowIso } from '../../src/ids.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { appendRunRow, refusedRow } from './dispatch-audit.ts';
import type { RunRefusal } from './run-refusal.ts';
import type { ActorGateRefusal, Run, SessionRef } from './runs-types.ts';

/** Store, logger, and the run one operation addresses. */
export interface RunOperationTarget {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run this operation addresses, by correlation id. */
    readonly correlationId: string;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}

/** Everything one chain task may do to the run it holds. */
export interface RunTaskContext {
    /** The run as stored, at the moment the chain task read it. */
    readonly run: Run;
    /** Service-clock stamp for this operation. */
    readonly now: string;
    /** Persist a replacement run in the same atomic write as its intents. */
    readonly persist: (run: Run) => Promise<void>;
}

/**
 * Run one operation against one run, serialized onto the shared chain.
 *
 * Generic over the answer so an operation that carries extra members on its
 * success case keeps them typed instead of widening them away.
 */
export async function operateRun<T>(
    target: RunOperationTarget,
    task: (context: RunTaskContext) => Promise<T>,
): Promise<T | { readonly status: 'not-found' }> {
    const now = target.now ?? nowIso();

    return await inQueueChain(async () => {
        const document = await readRunsDocument({ ...target, now });
        const index = document.runs.findIndex((run) => run.correlationId === target.correlationId);
        const run = document.runs[index];
        if (run === undefined) {
            return { status: 'not-found' as const };
        }

        return await task({
            run,
            now,
            persist: async (next) => {
                const runs = [...document.runs];
                runs[index] = next;
                await writeRunsDocument({ store: target.store, log: target.log, document: { ...document, runs } });
            },
        });
    });
}

/** What one refusal row needs beyond the operation's own coordinates. */
export interface RefusalRowInput {
    /** The run the operation refused on. */
    readonly run: Run;
    /** The operation the caller attempted (`reserve`, `result`, `retry`, …). */
    readonly operation: string;
    /** The refusal itself: its wire code and secret-free cause. */
    readonly refusal: RunRefusal;
    /** Attempt the run stood on, when the caller knew one. */
    readonly attempt: number | null;
    /** Lease the caller presented, when the refusal was a staleness verdict. */
    readonly leaseId?: string | undefined;
    /** Token the caller presented as its fingerprint, when the verdict was about the token. */
    readonly dispatchTokenFingerprint?: string | undefined;
    /**
     * The gate's extra details, on the one refusal that carries them.
     *
     * Optional rather than required so the *other* six operations' refusals are
     * unchanged: a staleness verdict has no policy to describe, and a required
     * member would put `actorPolicy: null` on every row that has no meaning for
     * it.
     */
    readonly actor?: ActorGateRefusal | undefined;
}

/**
 * Write the single `dispatch.refused` row an outcome owes.
 *
 * The row's `reason` is the refusal's own message — the same string the response
 * carries — passed in rather than composed here, which is what makes the trail
 * and the wire provably agree.
 */
export async function appendRefusalRow(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run, the operation, and the refusal. */
    readonly refusal: RefusalRowInput;
}): Promise<boolean> {
    const { refusal } = input;
    const row = refusedRow({
        run: refusal.run,
        operation: refusal.operation,
        code: refusal.refusal.code,
        reason: refusal.refusal.message,
        attempt: refusal.attempt,
        ...(refusal.leaseId !== undefined && { leaseId: refusal.leaseId }),
        ...(refusal.dispatchTokenFingerprint !== undefined
            && { dispatchTokenFingerprint: refusal.dispatchTokenFingerprint }),
        ...(refusal.actor !== undefined && { actor: refusal.actor }),
    });

    return await appendRunRow({
        store: input.store,
        log: input.log,
        correlationId: refusal.run.correlationId,
        row,
    });
}

/**
 * Build the session pointer a dispatch records (002 Key Entities: SessionRef).
 *
 * The run keeps the pointer only — OpenChamber stays authoritative — and the
 * source link comes from the run's first retained reference, which is the same
 * delivery the dispatch was built from.
 */
export function sessionRefOf(input: {
    /** The run that produced the session. */
    readonly run: Run;
    /** The host-owned session id. */
    readonly sessionId: string;
    /** RFC 3339 dispatch stamp. */
    readonly now: string;
}): SessionRef {
    return {
        sessionId: input.sessionId,
        attachmentId: input.run.attachmentId,
        dispatchedAt: input.now,
        title: '',
        sourceUrl: input.run.sourceReferences[0]?.sourceUrl ?? '',
        worktree: null,
    };
}
