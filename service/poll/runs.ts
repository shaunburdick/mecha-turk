/**
 * The run store's façade: CRUD, coalescing effects, and the claim (003
 * data-model §2.2–§2.4, T-003).
 *
 * This module is the one import path `events.ts`, the routes, and the sweep take
 * for run plumbing, and the home of the transitions that are *store* concerns
 * rather than authorization concerns. The mechanical halves live beside it
 * because the 500-line gate will not hold types, validators, persistence,
 * coalescing, **and** a state machine in one file, and because each has one
 * responsibility:
 *
 * - [`runs-document.ts`](./runs-document.ts) — the shared queue+run chain,
 *   the atomic write with its terminal-run eviction, and the one-shot
 *   adoption pass (FR-005);
 * - [`runs-join.ts`](./runs-join.ts) — folding deliveries into runs (FR-011);
 * - [`runs-transitions.ts`](./runs-transitions.ts) — the pure state
 *   transitions themselves, shared with the batch claim and the sweep;
 * - [`runs-parse.ts`](./runs-parse.ts) / [`runs-types.ts`](./runs-types.ts) /
 *   [`runs-parts-parse.ts`](./runs-parts-parse.ts) / [`run-key.ts`](./run-key.ts)
 *   — schema, validation, and identity derivation.
 *
 * **The authorization and terminal transitions do not live here.** Reserve,
 * result, abandon, block, retry, requeue, resolve, and the park they share were
 * moved to the routed operation modules (`dispatch-authorize.ts`,
 * `dispatch-report.ts`, `dispatch-block.ts`, `run-operate.ts`, `sweep.ts`) in
 * Wave 3 (T-043g), because this file had a **second** minting site beside the
 * route's and one of its transitions — `applyResult` — performed *no token check
 * at all*. One import away from re-creating the bypass this wave closes is not a
 * safety margin; the store now offers exactly two transitions, `claimRun` and
 * `deadLetterRun`, and neither mints or spends an authorization.
 *
 * Every mutation below serializes onto the one chain both stores share, and
 * **none of them writes an audit row**: the operation that performs a
 * transition appends its row after this call returns, so a failed audit can
 * never roll back a durable state change (FR-063's posture, data-model §4.3).
 * Refusals answer {@link RunChange} with the run's current state, so a caller
 * can name the exact cause in its `dispatch.refused` row (FR-003).
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
 * @param input - Store, logger, correlation id, and stamp.
 * @param apply - The transition; returns `null` to refuse it (the run is not
 *   in a state this transition accepts) without writing anything.
 * @returns What the transition did.
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
 *
 * @param input - Lease coordinates plus the run being claimed.
 * @returns The claimed run, or why it was not claimable.
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
 * @param input - The run to park and the cause to record.
 * @returns The parked run, or why the park was refused.
 */
export async function deadLetterRun(input: RunTransitionInput & { readonly reason: string }): Promise<RunChange> {
    return await changeRun(input, (run, now) => parkRun({ run, now, reason: input.reason }));
}
