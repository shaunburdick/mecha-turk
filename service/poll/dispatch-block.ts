/**
 * Hold a claimed run in `blocked:<reason>` after a fail-closed guard refused
 * before any host call (003 FR-042, AC-114;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md) §4).
 *
 * A block report is the fourth authorization operation and the only one that
 * produces no token: a guard runs **after** the claim and **before** the reserve,
 * so it holds a live lease and has authorized nothing. That is why it shares the
 * reserve's lease rules (they occupy the same window) while its state verdict is
 * its own — a run that already produced a session answers `invalid-transition`
 * *naming that session*, because contract §4 declares no `already-dispatched` code
 * for a guard report while FR-022 still requires the refusal to name it.
 *
 * Two properties the transition owes:
 *
 * - **A guard refusal consumes nothing.** The attempt number and the automatic
 *   requeue budget are both untouched (gate Q3), so a blocked run waits for the
 *   operator rather than for the sweep — and the sweep never touches a `blocked:*`
 *   run, which is what makes that wait safe rather than a second stranding.
 * - **The cause is a closed set.** `blockedReason` is validated against the four
 *   declared causes so the resulting `blocked:<reason>` state stays parseable
 *   (data-model §2.2); a fifth value would make the document unreadable.
 *
 * The chain task and the refusal-row writer live in
 * [`run-chain.ts`](./run-chain.ts), and the audit rows in
 * [`dispatch-audit.ts`](./dispatch-audit.ts).
 */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, blockedRow } from './dispatch-audit.ts';
import { ACTOR_BLOCKED_REASON } from './dispatch-actor-gate.ts';
import { judgeLease, sessionIdOf } from './dispatch-authorize.ts';
import { appendRefusalRow, operateRun } from './run-chain.ts';
import { attemptHistory, currentAttempt, runHistoryIndicatesSession } from './runs-document.ts';
import { refuse } from './run-refusal.ts';
import type { RunApplied, RunDuplicate, RunNotFound, RunRefused, RunRefusal } from './run-refusal.ts';
import type { Run } from './runs-types.ts';

/**
 * The **five** declared guard causes a blocked report may name (FR-042, FR-078;
 * contract §4; data-model §2.2).
 *
 * A **closed set**, and the fifth value is a requirement change rather than a
 * call-site detail: `blocked:<reason>` is validated as prefix + non-empty kebab
 * reason, so a *sixth* declared cause would be a sixth string with no
 * requirement behind it, and an **undeclared** one would still parse but would
 * make the runs document unreadable to any future build that pinned this list.
 * The gate's refusal parks its runs here through this same operation — no new
 * route, no new method.
 */
export const BLOCKED_REASONS: ReadonlySet<string> = new Set([
    'project-missing',
    'binding-missing',
    'credential',
    'policy',
    ACTOR_BLOCKED_REASON,
]);

/** What a block report answered. */
export type BlockResult = RunApplied | RunDuplicate | RunRefused | RunNotFound;

/** The wire code every state verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/** What one block report carries. */
export interface BlockInput {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The run being blocked, by correlation id. */
    readonly correlationId: string;
    /** The live lease the guard refused under. */
    readonly leaseId: string;
    /** Attempt the panel believes is current. */
    readonly attempt: number;
    /** Which of the four documented causes fired. */
    readonly blockedReason: string;
    /** The cause in the operator's words; stored as the run's reason line. */
    readonly detail: string;
    /** In-panel guidance offered alongside the block. */
    readonly guidance: string | null;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}

/**
 * Judge a block report (contract §4).
 *
 * A run that already produced a session answers `invalid-transition` *naming
 * that session* rather than the reserve's `already-dispatched` code, because
 * §4's table declares no such code for a guard report while FR-022 still requires
 * the refusal to name the session.
 *
 * @returns The refusal, or `null` when the run may be blocked now.
 */
function judgeBlock(input: {
    /** The run the report addresses. */
    readonly run: Run;
    /** Lease id the caller presented. */
    readonly leaseId: string;
    /** Attempt the caller claims to be acting under. */
    readonly attempt: number;
    /** Service-clock stamp. */
    readonly now: string;
}): RunRefusal | null {
    const { run } = input;
    const lease = judgeLease(input);
    if (lease !== null) {
        return lease;
    }

    if (runHistoryIndicatesSession(run)) {
        const sessionId = sessionIdOf(run);

        return refuse(
            INVALID_TRANSITION,
            sessionId === null
                ? 'this run already produced a session and cannot be blocked'
                : `this run already produced session ${sessionId} and cannot be blocked`,
        );
    }

    return run.state === 'claimed'
        ? null
        : refuse(INVALID_TRANSITION, `this run is ${run.state}; only a claimed run can be blocked`);
}

/**
 * Build the run a block report produces.
 *
 * The attempt number is untouched and the lease is dropped with the claim: a
 * guard refusal consumes neither an attempt nor any of the automatic requeue
 * budget (gate Q3), so a blocked run waits for the operator, not for the sweep.
 *
 * @param input - The claimed run, the cause, the detail, and the stamp.
 * @returns The `blocked:<reason>` run.
 */
function blockedRun(input: {
    /** The claimed run. */
    readonly run: Run;
    /** Which of the four documented causes fired. */
    readonly blockedReason: string;
    /** The cause in the operator's words. */
    readonly detail: string;
    /** Service-clock stamp. */
    readonly now: string;
}): Run {
    const { run, blockedReason, detail, now } = input;

    return {
        ...run,
        state: `blocked:${blockedReason}`,
        stateReason: detail,
        lease: null,
        attempts: attemptHistory(run, {
            ...currentAttempt(run),
            outcome: 'blocked',
            reason: detail,
            resultReportedAt: now,
        }),
        updatedAt: now,
    };
}

/**
 * Write the `run.blocked` row a guard refusal owes.
 *
 * @param input - The block report, the blocked run, and the state it left.
 * @returns `true` when the row reached the trail.
 */
async function appendBlockRow(input: {
    /** The block report's own input, for the store and logger. */
    readonly input: BlockInput;
    /** The blocked run as it now stands. */
    readonly run: Run;
    /** The state the run was held in before the report. */
    readonly priorState: Run['state'];
}): Promise<boolean> {
    const { input: block, run, priorState } = input;

    return await appendRunRow({
        store: block.store,
        log: block.log,
        correlationId: run.correlationId,
        row: blockedRow({
            run,
            blockedReason: block.blockedReason,
            priorState,
            guidance: block.guidance,
        }),
    });
}

/**
 * Hold a claimed run in `blocked:<reason>` after a fail-closed guard refused
 * before any host call.
 *
 * @returns The blocked run, or the refusal.
 * @throws {StorageUnavailableError} When the run document cannot be read or written.
 */
export async function blockDispatch(input: BlockInput): Promise<BlockResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<BlockResult> => {
        const refusal = judgeBlock({ run, leaseId: input.leaseId, attempt: input.attempt, now });
        if (refusal !== null) {
            return {
                status: 'refused',
                refusal,
                run,
                auditWritten: await appendRefusalRow({
                    store: input.store,
                    log: input.log,
                    refusal: {
                        run,
                        operation: 'blocked',
                        refusal,
                        attempt: input.attempt,
                        leaseId: input.leaseId,
                    },
                }),
            };
        }

        const priorState = run.state;
        const blocked = blockedRun({ run, blockedReason: input.blockedReason, detail: input.detail, now });
        await persist(blocked);

        return {
            status: 'applied',
            run: blocked,
            auditWritten: await appendBlockRow({ input, run: blocked, priorState }),
        };
    });
}
