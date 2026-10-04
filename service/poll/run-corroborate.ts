/**
 * Which blocked causes the service can re-check itself, and how (003 FR-078,
 * plan D17;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md) §6).
 *
 * Split out of [`run-operate.ts`](./run-operate.ts) for the file-length gate,
 * and because "can the service *prove* the cause cleared, or only the panel
 * report it?" is a single question this product has to answer in one place. The
 * answer is a **two-member set**, and getting it wrong is the failure constitution
 * IV exists to prevent: a cause the service could have checked but reported
 * instead would leave the operator with a `dispatch.retry` row claiming
 * corroboration the service never performed.
 *
 * So the split is by capability, not by verbosity:
 *
 * - **`binding-missing`** — the binding exists again. One table lookup.
 * - **`actor-not-allowed`** — the binding's live `allowedUsers` now admits at
 *   least one of the run's attributed actors. Re-judged with **the same
 *   predicate** the authorization gate uses, which is what makes "a run cannot
 *   be retried into a dispatch this gate would refuse again" a property rather
 *   than a hope — and it needs **no new state**, since the denied actor is
 *   re-derived from the run's own references.
 *
 * `project-missing`, `credential`, and `policy` are absent on purpose: each
 * depends on something the service cannot see (a host project list, a credential
 * check, an operator decision), so the panel's same-mount check is the only
 * evidence and is audited as *reported*, never as proof.
 */

import type { BindingRecord } from '../bindings.ts';
import { judgeActorPolicy } from './dispatch-actor-gate.ts';
import { refuse } from './run-refusal.ts';
import type { RunRefusal } from './run-refusal.ts';
import type { Run } from './runs-types.ts';

/** How a retry learned that the blocking cause had cleared. */
export type CauseSource = 'corroborated' | 'reported' | null;

/** The reason every un-cleared cause answers with. */
export const CAUSE_NOT_CLEARED = 'cause-not-cleared';

/** The blocked cause whose clearing the service verifies by table lookup alone. */
export const CORROBORATED_BINDING_REASON = 'binding-missing';

/** The declared `blocked:` cause the actor-policy gate parks a run in. */
const ACTOR_BLOCKED_REASON = 'actor-not-allowed';

/** The two blocked causes the service can re-check itself, and so corroborate. */
export const CORROBORATED_BLOCKED_REASONS: ReadonlySet<string> = new Set([
    CORROBORATED_BINDING_REASON,
    ACTOR_BLOCKED_REASON,
]);

/**
 * Re-judge a `blocked:actor-not-allowed` run against the live policy.
 *
 * A **truncated** reference list gets its own sentence, and the distinction is
 * load-bearing: the gate reads the run's *retained* references, so on a
 * run that reached the cap this re-judge reaches the gate's verdict — and would
 * reach it after any amount of widening `allowedUsers`. Saying "still admits
 * none of this run's attributed actors" then sends the operator to make an edit
 * that cannot help (constitution IV).
 *
 * @param input - The blocked run, and the live binding table.
 * @returns The refusal naming the binding, or `'corroborated'` when the gate
 *   would now admit it.
 */
export function judgeActorCause(input: {
    /** The blocked run the operator acted on. */
    readonly run: Run;
    /** The live binding table. */
    readonly bindings: readonly BindingRecord[];
}): RunRefusal | CauseSource {
    const { run, bindings } = input;
    const binding = bindings.find((candidate) => candidate.bindingId === run.bindingId);
    // An absent or unreadable policy is **not** corroboration. The gate would
    // refuse this dispatch again right now, so the retry refuses with the same
    // cause and the same remedy rather than dispatching into a known denial.
    const gate = binding === undefined
        ? { admitted: false as const }
        : judgeActorPolicy({ run, allowedUsers: binding.allowedUsers });
    if (gate.admitted) {
        return 'corroborated';
    }

    return refuse(
        CAUSE_NOT_CLEARED,
        run.referencesTruncated
            ? 'the cause has not cleared: this run\'s source reference list was cut at '
                + `${run.sourceReferences.length} of ${run.referenceCount} triggers, so binding `
                + `${run.bindingId}'s allow-list is judged against an incomplete list, and adding a login cannot `
                + 'clear it'
            : `the cause has not cleared: the allow-list for binding ${run.bindingId} still admits none of this `
                + "run's attributed actors",
    );
}
