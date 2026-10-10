/**
 * The Dispatches section's row copy — pure functions of panel state.
 *
 * One run is what the operator needs to judge a dispatch at a glance: which
 * trigger fired, which issue it was, why it sits where it sits now, how long
 * ago it was detected, what the panel reported when it dispatched, which agent
 * the read-back observed, and which prompt tiers the run composed its operator
 * block from — presence, sources, fingerprint, and length, never the text.
 * A dispatched run also carries its **follow-up queue**: how many follow-ups
 * reached the session, how many are still waiting, and every parked one with
 * the cause it parked with (002 FR-105).
 *
 * Four decisions are not visible from the code:
 *
 * - **One redaction pass over the whole composed subtitle.** Every string here
 *   reaches the DOM through the SDK list primitives' `textContent` writes, so
 *   the composed line passes through {@link redact} as defence in depth —
 *   `stateReason`, the dispatch result, and the verification note are all fields
 *   a failure or an upstream title can put free text into. The individual
 *   phrases are returned *unredacted*, so one secret can never be split across
 *   two passes.
 * - **Where no control applies, the control is absent, not disabled**, and
 *   {@link runAffordance} says why. An affordance the operator can click and be
 *   refused is honest; offering *Retry* on a waiting run is not.
 * - **One reason per state** ({@link STATE_REASONS}) serves both halves of that
 *   table — the reason a control *is* offered and the reason one is *absent* —
 *   because they are the same fact about the state.
 * - **An unrecognised state renders raw and offers nothing.** Inventing a label
 *   would be the guess the fail-closed parser refuses on the way in.
 *
 * Actor wording is `run-actor.ts`'s {@link actorPhrase}, shared with the reveal
 * in `dispatches-controls.ts`, which renders the same references and must not
 * word them a second way.
 *
 * Nothing here performs IO, so the copy is testable without a live DOM.
 */

import type { ListItem, Tone } from '@openchamber/sdk/ui';
import { redact } from './redaction.ts';
import { elapsedSince } from './bindings-rows.ts';
import { utcStamp } from './ids.ts';
import { actorPhrase } from './run-actor.ts';
import { followUpRowView } from './dispatches-detail.ts';
import { BLOCKED_PREFIX } from './dispatches-service.ts';
import type { FollowUpDeliveryRecord } from './dispatch-record.ts';
import type { DispatchesState } from './panel-state.ts';
import type { PlainRunState, RunReference, RunRow, RunState, RunVerification } from './dispatches-service.ts';
import type { RunKind } from './dispatches-detail.ts';

// The absolute-stamp reader lives with the clock helpers (`ids.ts`) so the
// binding rows can take it without importing this module, which imports them.
export { utcStamp };

/** Heading above the dispatch list. */
export const DISPATCHES_HEADING = 'Dispatches';

/** In-list placeholder while the service reports no events at all. */
export const DISPATCHES_EMPTY_TEXT = 'No dispatches yet.';

/** Status line while the list is ready but empty. */
export const DISPATCHES_EMPTY_STATUS =
    'No dispatches yet — a bound repository trigger appears here after the next scan.';

/** Instruction appended to the ready status line when there is something to act on. */
export const DISPATCHES_SELECT_HINT = 'select a row to open or retry';

/** Short leading labels per trigger kind (the list's fixed-width slot). */
const KIND_LABELS: Record<RunKind, string> = {
    assignment: 'assign',
    mention: 'mention',
    review: 'review',
};

/** The terminal parked state, named once so the tables and tests share it. */
const DEAD_LETTERED = 'dead-lettered' as const;

/** The declared blocked cause the service's actor-policy gate parks a run in. */
const ACTOR_BLOCKED = 'actor-not-allowed';

/**
 * Operator-readable badge label per plain state.
 *
 * `failed` reads as **dispatch failed** rather than as `failed` alone because
 * the label itself has to distinguish "a session exists" from "the dispatch made
 * no session" — a failure must never be mistakable for a success at a glance,
 * before anyone reads the tone.
 *
 * Annotated as a wide record so the lookup can be **total** (a state from a
 * future build renders as itself) while `satisfies` keeps the seven plain
 * states exhaustively labelled at compile time; `noUncheckedIndexedAccess`
 * then makes the "no label" branch a real one the `?? state` fallback answers.
 */
const PLAIN_STATE_LABELS: Readonly<Record<string, string>> = {
    pending: 'waiting',
    claimed: 'claimed',
    starting: 'starting',
    dispatched: 'dispatched',
    failed: 'dispatch failed',
    unconfirmed: 'unconfirmed',
    [DEAD_LETTERED]: DEAD_LETTERED,
} satisfies Record<PlainRunState, string>;

/**
 * The reason line for every plain state.
 *
 * One table serves both halves of {@link runAffordance}: the reason a control
 * *is* offered (why a retry is the right verb for `failed`) and the reason one
 * is **absent** (why a waiting run has nothing to retry). They are the same
 * fact about the state, so they live in one place and cannot drift.
 */
const STATE_REASONS: Record<PlainRunState, string> = {
    pending: 'waiting for a panel — there is nothing to retry until it fails or a guard refuses it',
    claimed: 'a panel holds the lease — its result, or the lease expiring, decides what happens next',
    starting: 'a dispatch is authorized and in progress — the result or the deadline decides what happens next',
    dispatched: 'a session exists for this dispatch — a dispatched dispatch cannot be retried',
    failed: 'the dispatch made no session — a retry returns it to waiting under the same run key',
    unconfirmed: 'no result arrived before the deadline — choose what to verify, then resolve it',
    [DEAD_LETTERED]: 'the automatic requeue budget is spent — return it to waiting to reset the attempt count',
};

/** Reason a dispatch carries a state this build does not recognise. */
const UNKNOWN_STATE_REASON = 'this dispatch reports a state the panel does not recognise — no action is offered';

/**
 * Badge tone per plain run state.
 *
 * The badge reports the *queue's* verdict — `dispatched` means a session was
 * reported, not that the panel is done with the run — so success-green is
 * reserved for that one answered state. Every state that means "an operator
 * must decide" reads as a warning, and the one state that means "the budget is
 * spent and nothing further happens without a human" reads as an error. The
 * tone map is deliberately never success-toned for a failure.
 */
const PLAIN_STATE_TONES: Record<Exclude<PlainRunState, typeof DEAD_LETTERED>, Tone> = {
    pending: 'neutral',
    claimed: 'info',
    starting: 'info',
    dispatched: 'success',
    failed: 'warning',
    unconfirmed: 'warning',
};

/**
 * The declared `blocked:` causes whose remedy is a named field.
 *
 * Annotated as a wide record so a cause this build does not produce still
 * renders through {@link blockedReasonText}'s generic clause rather than
 * appearing as a missing label.
 */
const BLOCKED_CAUSE_REASONS: Readonly<Record<string, string>> = {
    [ACTOR_BLOCKED]: 'nobody who triggered this run is on this binding\'s allow-list — add those logins to the '
        + 'binding\'s allowedUsers, then retry',
};

/**
 * Why one declared `blocked:<reason>` cause parks a run, in the panel's words.
 *
 * The **generic** clause serves every cause with no entry in
 * {@link BLOCKED_CAUSE_REASONS} — it says the true thing about all of them —
 * while a cause whose remedy is *specific* gets its own line.
 * `blocked:actor-not-allowed` is the only entry so far, because it is the only
 * cause whose fix is a **field the operator can find**: the binding's
 * allow-list. An operator reading "a guard refused the dispatch" learns nothing;
 * reading "nobody who triggered this run is on this binding's allow-list" knows
 * exactly which row to open.
 */
function blockedReasonText(cause: string): string {
    return BLOCKED_CAUSE_REASONS[cause]
        ?? `a guard refused the dispatch (${cause}) — retry once the cause clears`;
}

/**
 * Whether a state is one of the open `blocked:<reason>` family.
 *
 * The family is open (`blocked:project-missing`, `blocked:binding-missing`,
 * `blocked:actor-not-allowed`, and the declared-but-not-produced
 * `blocked:credential`/`blocked:policy`), so it is matched by prefix rather than
 * by an enum that would go stale.
 *
 * @returns `true` for the family, which a plain state can never be.
 */
function isBlockedState(state: string): state is `blocked:${string}` {
    return state.startsWith(BLOCKED_PREFIX);
}

/**
 * Operator-readable label for one state; an unrecognised state renders raw.
 *
 * The fallback is deliberate: a state this build does not know about must still
 * be *shown* rather than hidden behind a label the panel invented, and inventing
 * one would be exactly the guess the fail-closed parser refuses on the way in.
 */
export function stateLabel(state: string): string {
    if (isBlockedState(state)) {
        return `${BLOCKED_PREFIX} ${state.slice(BLOCKED_PREFIX.length)}`;
    }

    const label = PLAIN_STATE_LABELS[state];

    // A value outside the model is named as what it is, with the raw value
    // kept in the label so the operator can report it.
    return label ?? `unknown state: ${state}`;
}

/** Badge tone for any run state, including the `blocked:<reason>` family. */
function stateTone(state: RunState): Tone {
    if (isBlockedState(state)) {
        return 'warning';
    }

    return state === DEAD_LETTERED ? 'error' : PLAIN_STATE_TONES[state];
}

/**
 * Badge tone for one run: its state's verdict, adjusted for verification.
 *
 * A read-back that mismatched turns a success or in-progress tone into a
 * warning — the queue may be answered while the agent the
 * session actually runs is not the one the binding expected — but it never
 * softens the error tone of a parked run, and it can never produce a success.
 *
 * A read-back against **no configured baseline** (`expectedAgent === ''`)
 * changes nothing: there was no expectation to miss, so the run keeps the tone
 * its own state earns.
 */
function badgeTone(row: RunRow): Tone {
    const base = stateTone(row.state);
    if (row.verification === null || row.verification.ok || row.verification.expectedAgent === '') {
        return base;
    }

    return base === 'error' ? 'error' : 'warning';
}

/**
 * The action the panel offers for one run state — or no action, with a reason.
 *
 * The distinction that matters is between a control the service will actually
 * accept and one it would refuse.
 *
 * `cause-cleared` stays the service's judgement for `blocked:*`: the panel
 * cannot see whether the binding or project came back, so it offers Retry and
 * renders the service's own refusal verbatim when the cause still holds.
 *
 * The row is read as `{ state: string }` on purpose: the table answers for
 * **any** value, including a state this build has never heard of, which is
 * what makes "render it raw, offer nothing" testable without lying to the type
 * checker about a `RunRow`.
 */
export interface RunAffordance {
    /** The transition the control requests, or `none` when no control shows. */
    readonly action: 'retry' | 'resolve' | 'requeue' | 'none';
    /** Button label when an action is offered; `null` when the control is absent. */
    readonly label: string | null;
    /** Operator copy naming why this state does (or does not) offer it. */
    readonly reason: string;
}

/** Button label for the retry control. */
export const RETRY_LABEL = 'Retry dispatch';

/** Button label for the resolution of an `unconfirmed` dispatch. */
export const RESOLVE_LABEL = 'Resolve dispatch';

/** Button label for the return of a parked run to waiting. */
export const RETURN_LABEL = 'Return to waiting';

/** The same control once armed for its confirm step (the panel's two-step idiom). */
export const CONFIRM_RETURN_LABEL = 'Confirm: return to waiting';

/** Label of the first resolution, before the operator arms it. */
export const SESSION_CREATED_LABEL = 'Session was created';

/** Label of the first resolution, armed. */
export const CONFIRM_SESSION_CREATED_LABEL = 'Confirm: session was created';

/** Label of the second resolution, before the operator arms it. */
export const NO_SESSION_LABEL = 'No session was created';

/** Label of the second resolution, armed. */
export const CONFIRM_NO_SESSION_LABEL = 'Confirm: no session was created';

/**
 * Whether a state is one of the seven plain words the tables name.
 *
 * Written as a **total** check over a `string` rather than over `RunState` on
 * purpose: the parser refuses a state this build does not know, but the tables
 * still answer for one if it arrives — render the value raw, offer nothing.
 *
 * @returns `true` when the value is one of the seven plain states.
 */
function isPlainState(state: string): state is PlainRunState {
    return !isBlockedState(state) && Object.hasOwn(PLAIN_STATE_LABELS, state);
}

/**
 * Decide the one control a run's state offers.
 *
 * @returns The control, its label, and the reason line; `action: 'none'` with
 *   `label: null` wherever the service would refuse the transition.
 */
export function runAffordance(row: { readonly state: string }): RunAffordance {
    const { state } = row;
    if (state === 'failed') {
        return { action: 'retry', label: RETRY_LABEL, reason: STATE_REASONS.failed };
    }

    if (isBlockedState(state)) {
        // Retry validity follows the cleared-cause rule exactly as every other
        // cleared cause's does — the service re-checks the live state and refuses with
        // its own distinct reason if it has not cleared — so the affordance is
        // the same control with a more specific reason line.
        return {
            action: 'retry',
            label: RETRY_LABEL,
            reason: blockedReasonText(state.slice(BLOCKED_PREFIX.length)),
        };
    }

    if (state === 'unconfirmed') {
        return { action: 'resolve', label: RESOLVE_LABEL, reason: STATE_REASONS.unconfirmed };
    }

    if (state === DEAD_LETTERED) {
        return { action: 'requeue', label: RETURN_LABEL, reason: STATE_REASONS[DEAD_LETTERED] };
    }

    if (isPlainState(state)) {
        return { action: 'none', label: null, reason: STATE_REASONS[state] };
    }

    // A state from a future build: no control, and the reason says so rather
    // than guessing which transition the service would accept.
    return { action: 'none', label: null, reason: UNKNOWN_STATE_REASON };
}

/**
 * Describe one run's dispatch result (or the honest absence of one).
 *
 * Returned unredacted: {@link dispatchRow} redacts the whole composed subtitle
 * once, so every free-text field is scanned exactly once.
 *
 * @returns Result text, or a phrase naming why there is none.
 */
function resultPhrase(row: RunRow): string {
    if (row.dispatchResult !== null) {
        return row.dispatchResult;
    }

    return row.state === 'dispatched' ? 'no dispatch result recorded' : 'not dispatched yet';
}

/**
 * One reference's line: kind, detection time, origin when it adds something,
 * its actor and basis, and the mark on a reason the agent may never have seen.
 */
function referenceLabel(reference: RunReference): string {
    const origin = reference.origin === reference.kind ? '' : ` via ${reference.origin}`;
    const seen = reference.presentAtAuthorization ? '' : ' (after authorization, may not have been seen)';

    return `${reference.kind} ${utcStamp(reference.detectedAt)}${origin}${seen} · ${actorPhrase(reference)}`;
}

/**
 * Compose the source-reference line: primary + count + every reference.
 *
 * The primary label is the **earliest** reference — the reason the run exists
 * — followed by how many reasons fired in total, each listed with its kind and
 * detection time, and the count of triggers the reference cap kept off the
 * list, so overflow is stated rather than silently lossy. A run with one
 * reference shows just that reference: the "+N more" affordance is for when
 * there is something more.
 *
 * @returns The line, or `null` when the run carries no reference at all.
 */
function referencePhrase(row: RunRow): string | null {
    if (row.referenceCount === 0) {
        return null;
    }

    const listed = row.sourceReferences.map((reference) => referenceLabel(reference)).join(', ');
    const overflow = row.referencesNotRetained > 0
        ? ` +${row.referencesNotRetained} more reason${row.referencesNotRetained === 1 ? '' : 's'} not listed`
        : '';
    const head = row.referenceCount > 1 ? `${row.referenceCount} reasons · ` : '';

    return `${head}${listed}${overflow}`;
}

/**
 * Compose the agent read-back line: which agent, and whether it matched.
 *
 * An empty `expectedAgent` is the documented *no baseline configured*, so the
 * line reports the observation and the absence together and never the word
 * *mismatch* — nothing was compared.
 *
 * @returns The line, naming the observed agent, the expected one, the verdict,
 *   and the service's own note when there is one.
 */
function verificationPhrase(verification: RunVerification): string {
    const observed = verification.observedAgent ?? 'unreadable';
    const expected = verification.expectedAgent;
    if (expected === '') {
        const reason = verification.note ?? 'no baseline configured, so nothing was compared';

        return `agent read back: ${observed} — ${reason}`;
    }

    if (verification.ok) {
        return `agent verified: ${observed} (expected ${expected})`;
    }

    const note = verification.note === null ? '' : ` — ${verification.note}`;

    return `agent mismatch: observed ${observed}, expected ${expected}${note}`;
}

/**
 * Compose the prompt line: presence, the contributing tiers, the fingerprint,
 * and the length — never the text.
 *
 * Three facts, one read: the ordered tier list answers *which tiers produced
 * this run* (`global`, then `account`, then `binding`, joined with `+`), the
 * fingerprint identifies *which concatenated text was used* and is what lets an
 * operator tell two dispatches apart and recognise a pre-upgrade one, and the
 * length says how much of it there was. The text is the instruction, and it
 * lives in the tiers and the run's snapshot, not on a row that outlives them —
 * so a source name reaches this line only through the closed reader in
 * `prompt-wire.ts`, which has already refused any tier word this build does not
 * know.
 *
 * No tier set reads as `prompt not set`, and the same phrase answers a
 * reference whose members disagree — the state the fail-closed reader refuses
 * before a row can reach this function, so the line never has to guess between
 * "unset" and "unreadable".
 *
 * @returns `prompt set · global+account+binding · mtp-… · N chars`, or
 *   `prompt not set`.
 */
function promptPhrase(row: RunRow): string {
    const { promptFingerprint, promptLength, promptSources } = row;
    if (promptFingerprint === null || promptLength === null
        || promptSources === null || promptSources.length === 0 || !row.promptPresent) {
        return 'prompt not set';
    }

    return `prompt set · ${promptSources.join('+')} · ${promptFingerprint} · ${promptLength} chars`;
}

/**
 * Compose the follow-up line the panel's own record earns a row (002 FR-105).
 *
 * The service projects a follow-up's existence and text; the panel's durable
 * record is the only home for what happened to each one. The row therefore
 * names three things — how many reached the session, how many are still
 * waiting, and every parked one with its cause — and says nothing at all when
 * the run has no follow-up state, which is the ordinary case.
 *
 * @returns The line, or `null` when this row has no follow-up state to report.
 */
function followUpPhrase(row: RunRow, records: readonly FollowUpDeliveryRecord[]): string | null {
    const view = followUpRowView(row, records);
    if (view === null) {
        return null;
    }

    const parts: string[] = [];
    if (view.delivered > 0) {
        parts.push(`${view.delivered} delivered`);
    }

    if (view.waiting > 0) {
        parts.push(`${view.waiting} waiting`);
    }

    for (const parked of view.parked) {
        parts.push(`parked: ${parked.cause}`);
    }

    return parts.length === 0 ? null : `follow-ups: ${parts.join(' · ')}`;
}

/** Compose one runs-list row. */
export function dispatchRow(
    row: RunRow,
    records: readonly FollowUpDeliveryRecord[] = [],
): ListItem {
    const reason = row.stateReason;
    const result = resultPhrase(row);
    const verification = row.verification === null ? null : verificationPhrase(row.verification);
    const parts = [
        row.repository,
        referencePhrase(row),
        reason,
        followUpPhrase(row, records),
        result === reason ? null : result,
        verification,
        promptPhrase(row),
    ].filter((part): part is string => part !== null && part !== '');

    return {
        id: row.id,
        leading: KIND_LABELS[row.kind],
        title: `#${row.issueNumber} ${row.issueTitle}`,
        // One redaction pass over every free-text field the row can carry:
        // title and state reason are upstream-adjacent text (rendered as text
        // either way; redaction keeps a secret-shaped string from
        // ever reaching the DOM).
        subtitle: redact(parts.join(' · ')),
        meta: elapsedSince(row.detectedAt),
        badge: { label: stateLabel(row.state), tone: badgeTone(row) },
    };
}

/**
 * Build the runs list rows in the order the service sent them.
 *
 * @returns The rows, newest detected first (the service caps them at 100).
 */
export function dispatchRows(runs: DispatchesState): ListItem[] {
    return runs.rows.map((row) => dispatchRow(row, runs.followUpRecords));
}

/**
 * Compose the runs section's status line.
 *
 * Each lifecycle state answers in its own voice — an idle list says how to
 * load it, a failed one points at the note below — so the operator never has
 * to infer *why* the area is blank.
 */
export function dispatchesStatusText(runs: DispatchesState): string {
    if (runs.status === 'idle') {
        return 'Dispatches have not been read yet — press Refresh dispatches.';
    }

    if (runs.status === 'loading') {
        return 'Loading dispatches…';
    }

    if (runs.status === 'error') {
        return 'Dispatch list not loaded — see the note below.';
    }

    if (runs.rows.length === 0) {
        return DISPATCHES_EMPTY_STATUS;
    }

    // No count here: the range line immediately below carries it, and *that*
    // line is required to state the set's total ("N dispatches in this set", or
    // "total unavailable"). Printing the same figure twice was the duplication
    // the 2026-10-01 review found, so the lede keeps the order and the
    // selection hint and nothing the next line already says.
    return `newest first · ${DISPATCHES_SELECT_HINT}`;
}

/**
 * Find the run a run row selection points at.
 *
 * @returns The selected run, or `null` when nothing valid is selected.
 */
export function selectedRun(runs: DispatchesState): RunRow | null {
    return runs.rows.find((row) => row.id === runs.selectedRun) ?? null;
}
