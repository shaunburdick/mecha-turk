/**
 * The run store's façade: CRUD, coalescing effects, and the claim (003
 * data-model §2.2–§2.4, T-003).
 */

import { nowIso } from '../../src/ids.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { leaseRun, parkRun } from './runs-transitions.ts';
import type { RunChange, RunTransitionInput } from './runs-document.ts';
import type { LeaseCoordinates } from './runs-transitions.ts';
import type { Run } from './runs-types.ts';

/** Re-exported: the run store stays the one import path for run plumbing. */
export {
    MAX_TERMINAL_RUNS,
    RUNS_FILE,
    attemptHistory,
    currentAttempt,
    emptyRunsDocument,
    ensureRunsAdopted,
    inQueueChain,
    isTerminalRun,
    openedHistory,
    readRunsDocument,
    runHistoryIndicatesSession,
    writeRunsDocument,
} from './runs-document.ts';
export { applyEnqueue } from './runs-join.ts';
export { MAX_AUTO_REQUEUES, expireLease, leaseRun, parkRun, wedgeUnconfirmed } from './runs-transitions.ts';
export type { LeaseCoordinates } from './runs-transitions.ts';
export type { EnqueueJoin, EnqueueOutcome } from './runs-join.ts';
export { MAX_ATTEMPT_RECORDS, MAX_SOURCE_REFERENCES } from './runs-parse.ts';
export type { AdoptionOutcome, RunChange, RunTransitionInput, RunsStoreInput } from './runs-document.ts';

/** Extra input one transition needs beyond {@link RunTransitionInput}. */
interface ClaimInput extends RunTransitionInput {
    /** Opaque mount id taking the lease. */
    readonly holder: string;
    /** Lease identifier to record. */
    readonly leaseId: string;
    /** Lease issue stamp. */
    readonly issuedAt: string;
    /** Lease expiry the sweep compares to the service clock. */
    readonly expiresAt: string;
}

/** Project one claim input's lease fields onto the shared lease shape. */
function leaseCoordinatesOf(input: ClaimInput): LeaseCoordinates {
    return {
        holder: input.holder,
        leaseId: input.leaseId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        provenance: 'panel',
    };
}

/**
 * Apply one state change to one run, serialized onto the shared chain.
 *
 * @param apply - The transition; returns `null` to refuse it (the run is not
 *   in a state this transition accepts) without writing anything.
 */
async function changeRun(
    input: RunTransitionInput,
    apply: (run: Run, now: string) => Run | null,
): Promise<RunChange> {
    const now = input.now ?? nowIso();

    return await inQueueChain(async (): Promise<RunChange> => {
        const document = await readRunsDocument({ ...input, now });
        const index = document.runs.findIndex((run) => run.correlationId === input.correlationId);
        const current = document.runs[index];
        if (current === undefined) {
            return { status: 'not-found' };
        }

        const next = apply(current, now);
        if (next === null) {
            return { status: 'refused', state: current.state };
        }

        const runs = [...document.runs];
        runs[index] = next;
        await writeRunsDocument({ store: input.store, log: input.log, document: { ...document, runs } });

        return { status: 'applied', run: next };
    });
}

/**
 * Claim one waiting run for one panel: lease issued, attempt opened.
 */
export async function claimRun(input: ClaimInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => leaseRun({
        run,
        lease: leaseCoordinatesOf(input),
        now,
    }));
}

/**
 * Park a run in `dead-lettered`: the requeue budget is exhausted, or the
 * operator parked it. Terminal runs and runs that already produced a session
 * are never parked.
 *
 * @returns The parked run, or why the park was refused.
 */
export async function deadLetterRun(input: RunTransitionInput & { readonly reason: string }): Promise<RunChange> {
    return await changeRun(input, (run, now) => parkRun({ run, now, reason: input.reason }));
}
