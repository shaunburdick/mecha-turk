/**
 * Which blocked causes the service can re-check itself, and how (003
 * FR-078, plan D17; dispatch-authorization contract §6).
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
 * Re-judge a `blocked:actor-not-allowed` run against the live policy. A
 * **truncated** reference list gets its own sentence, because the gate reads
 * the run's *retained* references: on a run that reached the cap this
 * re-judge reaches the gate's verdict after any amount of widening
 * `allowedUsers`, and saying *still admits none of this run's attributed
 * actors* would send the operator to make an edit that cannot help
 * (constitution IV).
 */
export function judgeActorCause(input: {
    /** The blocked run the operator acted on. */
    readonly run: Run;
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
