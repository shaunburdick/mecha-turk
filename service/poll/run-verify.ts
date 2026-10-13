/**
 * The post-dispatch verification report (003 FR-043, AC-125;
 * dispatch-authorization contract §5).
 */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, verificationRow } from './dispatch-audit.ts';
import { operateRun } from './run-chain.ts';
import { refused } from './run-operate.ts';
import type { OperationResult } from './run-operate.ts';
import { STALE_LEASE_CODE, refuse, staleAttemptMessage } from './run-refusal.ts';
import type { RunRefusal } from './run-refusal.ts';
import type { BaselineProvenance, Run, RunVerification } from './runs-types.ts';

/** The wire code every verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/**
 * Judge a verification report (contract §5).
 *
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
 * Record a post-dispatch agent read-back — and change nothing else. The
 * stored outcome makes a mismatch visible on the run row and therefore
 * auditable, but neither may promote a warning into a block, so `state`,
 * `attempt`, lease and reservation stand exactly as they were and a
 * mismatch receives no further automated handling, ever. A report whose
 * `expectedAgent` is `""` is a read-back against **no configured baseline**
 * (002 FR-029 case (ii)), stored as `agent.uncompared` beside the empty
 * baseline so the absence — not a fabricated match — is what the row says.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export async function recordVerification(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run being read back, by correlation id. */
    readonly correlationId: string;
    /** Attempt the panel's request names (contract §5's common body field). */
    readonly attempt: number;
    /** The session the panel read back. */
    readonly sessionId: string;
    /** The agent the read-back observed, or `null` when unreadable. */
    readonly observedAgent: string | null;
    /** Baseline judged against; `""` means none configured and nothing compared. */
    readonly expectedAgent: string;
    /** Where that baseline came from; recorded on the uncompared row. */
    readonly baselineProvenance: BaselineProvenance;
    readonly ok: boolean;
    /** Note explaining a mismatch or an unreadable read-back. */
    readonly note: string | null;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}): Promise<OperationResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<OperationResult> => {
        const refusal = judgeVerification({ run, attempt: input.attempt, sessionId: input.sessionId });
        if (refusal !== null) {
            return await refused({ ...input, run, operation: 'verification', refusal });
        }

        const { observedAgent, expectedAgent, ok, note } = input;
        const verification: RunVerification = { observedAgent, expectedAgent, ok, note, at: now };
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
                row: verificationRow({ run: read, verification, baselineProvenance: input.baselineProvenance }),
            }),
        };
    });
}
