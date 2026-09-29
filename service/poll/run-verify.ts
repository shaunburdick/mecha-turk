/**
 * The post-dispatch verification report (003 FR-043, AC-125;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md) §5).
 *
 * Split out of [`run-operate.ts`](./run-operate.ts) so that file stays within
 * the size bound, and it is the operation that most deserves its own name: the
 * verification report is the **only** run-scoped operation that changes nothing
 * about the run's state. It reads the session back, records what it saw, and
 * stops — warn-only by requirement, so a mismatch is a visible warning and
 * never a block, a kill, or a trigger for further automated handling.
 *
 * Two properties this module owes:
 *
 * - **Warn-only is enforced by omission.** `state`, `attempt`, `lease`, and
 *   `reservation` are spread through unchanged; the read-back lands as data on
 *   the run, not as a transition of it. A mismatch receiving *any* further
 *   handling would be a requirement failure, not a feature.
 * - **The attempt is validated before anything else** (contract's common body
 *   fields). A read-back filed against an attempt the run has already left
 *   would record a fact about a dispatch the caller can no longer see — a
 *   partial apply of exactly the kind §5's "never a partial apply" rule refuses.
 */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, verificationRow } from './dispatch-audit.ts';
import { operateRun } from './run-chain.ts';
import { refused } from './run-operate.ts';
import type { OperationResult } from './run-operate.ts';
import { STALE_LEASE_CODE, refuse, staleAttemptMessage } from './run-refusal.ts';
import type { RunRefusal } from './run-refusal.ts';
import type { Run, RunVerification } from './runs-types.ts';

/** The wire code every verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/**
 * Judge a verification report (contract §5).
 *
 * @param input - The run, the attempt the panel names, and the session the
 *   read-back came from.
 * @returns The refusal, or `null` when this run may record the read-back.
 */
function judgeVerification(input: {
    /** The run being read back. */
    readonly run: Run;
    /** Attempt the panel's request names. */
    readonly attempt: number;
    /** The session the read-back came from. */
    readonly sessionId: string;
}): RunRefusal | null {
    const { run, attempt, sessionId } = input;
    if (attempt !== run.attempt) {
        return refuse(STALE_LEASE_CODE, staleAttemptMessage(attempt, run.attempt));
    }

    if (run.session === null) {
        return refuse(
            INVALID_TRANSITION,
            `this run is ${run.state} and records no session, so there is nothing to read back`,
        );
    }

    return run.session.sessionId === sessionId
        ? null
        : refuse(INVALID_TRANSITION, 'the reported session is not the session this run recorded');
}

/**
 * Record a post-dispatch agent read-back — and change nothing else (FR-043).
 *
 * The stored outcome is what makes a mismatch *visible* on the run row, and the
 * row is what makes it auditable; neither may promote a warning into a block, so
 * this writes `run.verification` and leaves `state`, `attempt`, lease, and
 * reservation exactly as they stood. A mismatch receives no further automated
 * handling, ever.
 *
 * @param input - Store, logger, the run, the attempt the panel names, the
 *   session read back, the observed and expected agents, the verdict, a note,
 *   and an injectable service clock.
 * @returns The run with its recorded read-back, or the refusal.
 * @throws {StorageUnavailableError} When the run document cannot be read or written.
 */
export async function recordVerification(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The run being read back, by correlation id. */
    readonly correlationId: string;
    /** Attempt the panel's request names (contract §5's common body field). */
    readonly attempt: number;
    /** The session the panel read back. */
    readonly sessionId: string;
    /** The agent the read-back observed, or `null` when unreadable. */
    readonly observedAgent: string | null;
    /** The agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched. */
    readonly ok: boolean;
    /** Note explaining a mismatch or an unreadable read-back. */
    readonly note: string | null;
    /** Service-clock stamp; injectable so tests never sleep (NFR-112). */
    readonly now?: string | undefined;
}): Promise<OperationResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<OperationResult> => {
        const refusal = judgeVerification({ run, attempt: input.attempt, sessionId: input.sessionId });
        if (refusal !== null) {
            return await refused({ ...input, run, operation: 'verification', refusal });
        }

        const verification: RunVerification = {
            observedAgent: input.observedAgent,
            expectedAgent: input.expectedAgent,
            ok: input.ok,
            note: input.note,
            at: now,
        };
        // Every other member is spread through unchanged: warn-only means the
        // read-back is data on the run, not a transition of it.
        const read: Run = { ...run, verification, updatedAt: now };
        await persist(read);

        return {
            status: 'applied',
            run: read,
            auditWritten: await appendRunRow({
                store: input.store,
                log: input.log,
                correlationId: read.correlationId,
                row: verificationRow({ run: read, verification }),
            }),
        };
    });
}
