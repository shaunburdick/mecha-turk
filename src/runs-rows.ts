/**
 * The Runs section's row copy (M8) — pure functions of panel state.
 *
 * One run is what the operator needs to judge a dispatch at a glance: which
 * trigger fired, which issue it was, why it sits where it sits now, how long
 * ago it was detected, what the panel reported when it dispatched, and which
 * agent the read-back observed. Every string composed here reaches the DOM
 * through the SDK list primitives' `textContent` writes, and the whole
 * composed subtitle additionally passes through {@link redact} as defence in
 * depth — `stateReason`, the dispatch result, and the verification note are
 * all fields a failure or an upstream title can put free text into.
 *
 * 003 (T-024, FR-040/FR-041/FR-043/FR-074) widens this module in three ways:
 *
 * - **A label and a reason line for every state**, including `unconfirmed`,
 *   `dead-lettered`, and the open `blocked:<reason>` family, with a tone map
 *   in which a failure is never success-toned and an agent-verification
 *   mismatch reads as a warning rather than as a pass (AC-113, AC-125).
 * - **The source references on the row itself** — the primary label from the
 *   earliest reference, a count of how many fired, each reference's kind and
 *   detection time, and a mark on any reference that arrived after the
 *   dispatch authorization (FR-015; the reveal control that shows origin and
 *   link in full is 005's).
 * - **One state→affordance table** ({@link runAffordance}) instead of a
 *   boolean: *Retry* only where the service accepts it, *Resolve* for the
 *   fail-closed wedge, *Return to waiting* for a parked run, and — where no
 *   control applies — **no control at all, with the reason it is absent**,
 *   rather than a disabled one (FR-041, FR-074, AC-123).
 *
 * Nothing here performs IO, so the copy is testable without a live DOM.
 */

import type { ListItem, Tone } from '@openchamber/sdk/ui';
import { redact } from './redaction.ts';
import { elapsedSince } from './repos-rows.ts';
import { BLOCKED_PREFIX } from './runs-service.ts';
import type { RunsState } from './panel-state.ts';
import type { PlainRunState, RunReference, RunRow, RunState, RunVerification } from './runs-service.ts';

/** Heading above the runs list. */
export const RUNS_HEADING = 'Runs';

/** In-list placeholder while the service reports no events at all. */
export const RUNS_EMPTY_TEXT = 'No runs yet.';

/** Status line while the list is ready but empty. */
export const RUNS_EMPTY_STATUS =
    'No runs yet — a bound repository trigger appears here after the next scan.';

/** Instruction appended to the ready status line when there is something to act on. */
export const RUNS_SELECT_HINT = 'select a row to open or retry';

/** Short leading labels per trigger kind (the list's fixed-width slot). */
const KIND_LABELS: Record<RunRow['kind'], string> = {
    assignment: 'assign',
    mention: 'mention',
    review: 'review',
};

/** The terminal parked state, named once so the tables and tests share it. */
const DEAD_LETTERED = 'dead-lettered' as const;

/**
 * Operator-readable badge label per plain state (FR-074, AC-123).
 *
 * `failed` reads as **dispatch failed** rather than as `failed` alone because
 * FR-040 requires the label itself to distinguish "a session exists" from "the
 * dispatch made no session" — a failure must never be mistakable for a success
 * at a glance, before anyone reads the tone.
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
 * The reason line for every plain state (FR-074's per-state explanation).
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
    dispatched: 'a session exists for this run — a dispatched run cannot be retried',
    failed: 'the dispatch made no session — a retry returns it to waiting under the same run key',
    unconfirmed: 'no result arrived before the deadline — choose what to verify, then resolve it',
    [DEAD_LETTERED]: 'the automatic requeue budget is spent — return it to waiting to reset the attempt count',
};

/** Reason a run carries a state this build does not recognise (FR-074). */
const UNKNOWN_STATE_REASON = 'this run reports a state the panel does not recognise — no action is offered';

/**
 * Badge tone per plain run state.
 *
 * The badge reports the *queue's* verdict — `dispatched` means a session was
 * reported, not that the panel is done with the run — so success-green is
 * reserved for that one answered state. Every state that means "an operator
 * must decide" reads as a warning, and the one state that means "the budget is
 * spent and nothing further happens without a human" reads as an error. The
 * tone map is deliberately never success-toned for a failure (FR-040, AC-113).
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
 * Whether a state is one of the open `blocked:<reason>` family.
 *
 * The family is open (`blocked:project-missing`, `blocked:binding-missing`,
 * and the declared-but-not-yet-produced `blocked:credential`/`blocked:policy`),
 * so it is matched by prefix rather than by an enum that would go stale.
 *
 * @param state - State of the run.
 * @returns `true` for the family, which a plain state can never be.
 */
function isBlockedState(state: string): state is `blocked:${string}` {
    return state.startsWith(BLOCKED_PREFIX);
}

/**
 * Operator-readable label for one state; an unrecognised state renders raw.
 *
 * The fallback is deliberate (FR-074): a state this build does not know about
 * must still be *shown* rather than hidden behind a label the panel invented,
 * and inventing one would be exactly the guess the fail-closed parser refuses
 * on the way in.
 *
 * @param state - One of the eight dispatch states, or a value from a future build.
 * @returns The badge label.
 */
export function stateLabel(state: string): string {
    if (isBlockedState(state)) {
        return `${BLOCKED_PREFIX} ${state.slice(BLOCKED_PREFIX.length)}`;
    }

    return PLAIN_STATE_LABELS[state] ?? state;
}

/**
 * Badge tone for any run state, including the `blocked:<reason>` family.
 *
 * @param state - State of the run.
 * @returns The badge tone for that state.
 */
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
 * warning (FR-043, AC-125) — the queue may be answered while the agent the
 * session actually runs is not the one the binding expected — but it never
 * softens the error tone of a parked run, and it can never produce a success.
 *
 * @param row - Run to judge.
 * @returns The tone the badge renders with.
 */
function badgeTone(row: RunRow): Tone {
    const base = stateTone(row.state);
    if (row.verification === null || row.verification.ok) {
        return base;
    }

    return base === 'error' ? 'error' : 'warning';
}

/**
 * The action the panel offers for one run state — or no action, with a reason.
 *
 * This replaces the old `state !== 'dispatched'` boolean with the table 003
 * specifies (FR-041, FR-033, FR-027, AC-123). The distinction that matters is
 * between a control the service will actually accept and one it would refuse:
 * an affordance the operator can click and be refused is honest, but offering
 * *Retry* on a waiting run is not — the service has no transition to accept.
 * Where no control applies the control is **absent, not disabled**, and
 * `reason` says why, so the operator reads a fact instead of a greyed-out
 * promise.
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

/** Button label for the retry control (M8's copy, unchanged by 003). */
export const RETRY_LABEL = 'Retry run';

/** Button label for FR-027's resolution of an `unconfirmed` run. */
export const RESOLVE_LABEL = 'Resolve run';

/** Button label for FR-033's return of a parked run to waiting. */
export const RETURN_LABEL = 'Return to waiting';

/** The same control once armed for its confirm step (the panel's two-step idiom). */
export const CONFIRM_RETURN_LABEL = 'Confirm: return to waiting';

/** Label of FR-027's first resolution, before the operator arms it. */
export const SESSION_CREATED_LABEL = 'Session was created';

/** Label of FR-027's first resolution, armed. */
export const CONFIRM_SESSION_CREATED_LABEL = 'Confirm: session was created';

/** Label of FR-027's second resolution, before the operator arms it. */
export const NO_SESSION_LABEL = 'No session was created';

/** Label of FR-027's second resolution, armed. */
export const CONFIRM_NO_SESSION_LABEL = 'Confirm: no session was created';

/**
 * Whether a state is one of the seven plain words the tables name.
 *
 * Written as a **total** check over a `string` rather than over `RunState` on
 * purpose: the parser refuses a state this build does not know, but the tables
 * still answer for one if it arrives — render the value raw, offer nothing.
 *
 * @param state - State of the run.
 * @returns `true` when the value is one of the seven plain states.
 */
function isPlainState(state: string): state is PlainRunState {
    return !isBlockedState(state) && Object.hasOwn(PLAIN_STATE_LABELS, state);
}

/**
 * Decide the one control a run's state offers (003's state→affordance table).
 *
 * @param row - Run to judge.
 * @returns The control, its label, and the reason line; `action: 'none'` with
 *   `label: null` wherever the service would refuse the transition.
 */
export function runAffordance(row: { readonly state: string }): RunAffordance {
    const { state } = row;
    if (state === 'failed') {
        return { action: 'retry', label: RETRY_LABEL, reason: STATE_REASONS.failed };
    }

    if (isBlockedState(state)) {
        const cause = state.slice(BLOCKED_PREFIX.length);

        return {
            action: 'retry',
            label: RETRY_LABEL,
            reason: `a guard refused the dispatch (${cause}) — retry once the cause clears`,
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
 * Whether the retry control applies to one run.
 *
 * @param row - Run to judge.
 * @returns `true` only where the service accepts a retry: `failed` and
 *   `blocked:*` (FR-041). A parked run is *return to waiting*, not a retry.
 */
export function canRetry(row: RunRow): boolean {
    return runAffordance(row).action === 'retry';
}

/**
 * Describe one run's dispatch result (or the honest absence of one).
 *
 * Returned unredacted: {@link runRow} redacts the whole composed subtitle
 * once, so every free-text field is scanned exactly once and one secret can
 * never be split across two redaction passes.
 *
 * @param row - Run to describe.
 * @returns Result text, or a phrase naming why there is none.
 */
function resultPhrase(row: RunRow): string {
    if (row.dispatchResult !== null) {
        return row.dispatchResult;
    }

    return row.state === 'dispatched' ? 'no dispatch result recorded' : 'not dispatched yet';
}

/**
 * Zero-pad one `Date` getter to two characters.
 *
 * @param part - UTC field from a `Date`.
 * @returns The field as two digits.
 */
function padTwoDigits(part: number): string {
    return String(part).padStart(2, '0');
}

/**
 * Render one stamp as a compact UTC minute (`2026-09-28 09:00`).
 *
 * Absolute rather than relative: two references detected minutes apart must
 * not collapse into the same "2m ago" when the operator is reconstructing
 * which reason fired first (FR-015, US4 scenario 2), and an audit row's
 * timestamp is the same kind of fact.
 *
 * @param iso - RFC 3339 stamp from a source reference or an audit row.
 * @returns The compact stamp, or the stored text when it is not a time.
 */
export function utcStamp(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
        return iso;
    }

    const value = new Date(at);

    return `${value.getUTCFullYear()}-${padTwoDigits(value.getUTCMonth() + 1)}-${padTwoDigits(value.getUTCDate())}`
        + ` ${padTwoDigits(value.getUTCHours())}:${padTwoDigits(value.getUTCMinutes())}`;
}

/**
 * One reference's line: kind, detection time, origin when it adds something,
 * and the mark on a reason the agent may never have seen (FR-015).
 *
 * @param reference - One retained source reference.
 * @returns The reference's label.
 */
function referenceLabel(reference: RunReference): string {
    const origin = reference.origin === reference.kind ? '' : ` via ${reference.origin}`;
    const seen = reference.presentAtAuthorization ? '' : ' (after authorization, may not have been seen)';

    return `${reference.kind} ${utcStamp(reference.detectedAt)}${origin}${seen}`;
}

/**
 * Compose the source-reference line: primary + count + every reference.
 *
 * The primary label is the **earliest** reference — the reason the run exists
 * — followed by how many reasons fired in total, each listed with its kind and
 * detection time, and the count of triggers the reference cap kept off the
 * list (T-038), so overflow is stated rather than silently lossy. A run with
 * one reference shows just that reference: FR-015 forbids the "+N more"
 * affordance when there is nothing more.
 *
 * @param row - Run to describe.
 * @returns The line, or `null` when the run carries no reference at all.
 */
function referencePhrase(row: RunRow): string | null {
    if (row.referenceCount === 0) {
        return null;
    }

    const listed = row.sourceReferences.map(referenceLabel).join(', ');
    const overflow = row.referencesNotRetained > 0
        ? ` +${row.referencesNotRetained} more reason${row.referencesNotRetained === 1 ? '' : 's'} not listed`
        : '';
    const head = row.referenceCount > 1 ? `${row.referenceCount} reasons · ` : '';

    return `${head}${listed}${overflow}`;
}

/**
 * Compose the agent read-back line: which agent, and whether it matched.
 *
 * @param verification - The recorded read-back.
 * @returns The line, naming the observed agent, the expected one, the verdict,
 *   and the service's own note when there is one (FR-043, AC-125).
 */
function verificationPhrase(verification: RunVerification): string {
    const observed = verification.observedAgent ?? 'unreadable';
    const expected = verification.expectedAgent;
    if (verification.ok) {
        return `agent verified: ${observed} (expected ${expected})`;
    }

    const note = verification.note === null ? '' : ` — ${verification.note}`;

    return `agent mismatch: observed ${observed}, expected ${expected}${note}`;
}

/**
 * Compose one runs-list row.
 *
 * @param row - Run as the service projected it.
 * @returns The list row.
 */
export function runRow(row: RunRow): ListItem {
    const reason = row.stateReason;
    const result = resultPhrase(row);
    const verification = row.verification === null ? null : verificationPhrase(row.verification);
    const parts = [
        row.repository,
        referencePhrase(row),
        reason,
        result === reason ? null : result,
        verification,
    ].filter((part): part is string => part !== null && part !== '');

    return {
        id: row.id,
        leading: KIND_LABELS[row.kind],
        title: `#${row.issueNumber} ${row.issueTitle}`,
        // One redaction pass over every free-text field the row can carry:
        // title and state reason are upstream-adjacent text (NFR-109 renders
        // them as text either way; redaction keeps a secret-shaped string from
        // ever reaching the DOM).
        subtitle: redact(parts.join(' · ')),
        meta: elapsedSince(row.detectedAt),
        badge: { label: stateLabel(row.state), tone: badgeTone(row) },
    };
}

/**
 * Build the runs list rows in the order the service sent them.
 *
 * @param runs - The Runs section's state.
 * @returns The rows, newest detected first (the service caps them at 100).
 */
export function runRows(runs: RunsState): ListItem[] {
    return runs.rows.map((row) => runRow(row));
}

/**
 * Compose the runs section's status line.
 *
 * Each lifecycle state answers in its own voice — an idle list says how to
 * load it, a failed one points at the note below — so the operator never has
 * to infer *why* the area is blank.
 *
 * @param runs - The Runs section's state.
 * @returns The status text.
 */
export function runsStatusText(runs: RunsState): string {
    if (runs.status === 'idle') {
        return 'Runs have not been read yet — press Refresh runs.';
    }

    if (runs.status === 'loading') {
        return 'Loading runs…';
    }

    if (runs.status === 'error') {
        return 'Runs list not loaded — see the note below.';
    }

    if (runs.rows.length === 0) {
        return RUNS_EMPTY_STATUS;
    }

    const noun = runs.rows.length === 1 ? 'run' : 'runs';

    return `${runs.rows.length} ${noun} · newest first · ${RUNS_SELECT_HINT}`;
}

/**
 * Find the run a run row selection points at.
 *
 * @param runs - The Runs section's state.
 * @returns The selected run, or `null` when nothing valid is selected.
 */
export function selectedRun(runs: RunsState): RunRow | null {
    return runs.rows.find((row) => row.id === runs.selectedRun) ?? null;
}
