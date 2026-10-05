/**
 * The words one post-dispatch read-back produces: the runs-area banner and the
 * `note` the service stores beside the report (003 FR-043; contract §5; 002
 * FR-029).
 *
 * Split out of [`agent-verify.ts`](./agent-verify.ts) the way
 * [`status-lines.ts`](./status-lines.ts) sits apart from `status-tab.ts`: that
 * module decides what happened, this one decides how it is said, and both are
 * pure functions of an outcome — no host, no runtime, no state, so every string
 * an operator can read is testable without a dispatch.
 *
 * One rule shapes every line here: **an absence is never phrased as a
 * verdict.** A read-back taken against a blank baseline (the documented *no
 * baseline configured* since 002 v1.10.0 / 006 v1.5.0) reports what was
 * observed and that nothing could be compared — the words *mismatch* and
 * *expected* are reserved for a baseline that exists and differs.
 */

import { redact } from './redaction.ts';
import type { PanelStatus } from './panel-state.ts';
import type { AgentVerification } from './agent-verify.ts';

/** Milliseconds in one second; used to phrase the timeout for the operator. */
const MS_PER_SECOND = 1_000;

/** The warning every warn-only outcome repeats, so it is worded once. */
const KEEP_RUNNING = 'Warning only — the session keeps running, nothing was blocked.';

/** What a read-back had no baseline to compare against. */
type Uncompared = Extract<AgentVerification, { readonly status: 'uncompared' }>;

/** The two outcomes whose *observation* failed rather than its comparison. */
type ObservationFailure = Extract<AgentVerification, { readonly status: 'timeout' | 'unavailable' }>;

/**
 * The banner for a read-back that had no baseline to compare against.
 *
 * `info`, not `warning`: nothing went wrong, and the operator is told where
 * the comparison they may expect actually comes from.
 *
 * @returns The banner content.
 */
function uncomparedNotice(result: Uncompared): PanelStatus {
    const absent = 'no comparison baseline is configured (Settings → expectedAgent), so nothing was compared.';

    return {
        tone: 'info',
        title: 'Session agent read back, not compared',
        body: result.agent === null
            ? `Dispatched, but the session reported no agent, and ${absent}`
            : `Dispatched; the session runs on '${result.agent}', and ${absent}`,
    };
}

/**
 * The banners for a read-back whose observation failed (timeout, refusal).
 *
 * These warnings are about the *observation*, so the expected agent is named
 * only when there is one: with no baseline there is nothing to set the failure
 * against, and a parenthetical naming an empty baseline would be noise.
 *
 * @param result - The timeout or unavailable outcome.
 * @returns The banner content, already redacted.
 */
function observationFailureNotice(result: ObservationFailure): PanelStatus {
    const basis = result.expected === '' ? '' : ` (expected '${result.expected}')`;
    if (result.status === 'timeout') {
        const seconds = Math.floor(result.timeoutMs / MS_PER_SECOND);

        return {
            tone: 'warning',
            title: 'Session agent unreadable',
            body: `Dispatched, but the session agent was not readable within ${seconds}s${basis}. ${KEEP_RUNNING}`,
        };
    }

    return {
        tone: 'warning',
        title: 'Session agent not verified',
        body: 'Dispatched, but the session could not be opened to read its agent: '
            + `${redact(result.problem)}${basis}. ${KEEP_RUNNING}`,
    };
}

/**
 * Build the runs-area banner for one verification outcome.
 *
 * Every non-match outcome is a warning, never a block: the session keeps
 * running and the relay keeps dispatching — M9 tells the operator which
 * agent answered, it does not play bouncer. The match outcome gets its own
 * banner so the evidence an operator looks for on a live dispatch is on
 * screen the moment it exists.
 *
 * The one outcome that is *not* a warning is `uncompared`: with no baseline
 * configured there is nothing wrong to report, so it states what was observed
 * and that no comparison was possible, in the plain tone (002 FR-029 as
 * amended — a mismatch warning fires only when a real baseline exists and
 * differs).
 *
 * @returns The banner content, already redacted.
 */
export function verificationNotice(result: AgentVerification): PanelStatus {
    const expected = `expected '${result.expected}'`;
    switch (result.status) {
        case 'match': {
            return {
                tone: 'success',
                title: 'Session agent verified',
                body: `The dispatched session runs on '${result.agent}' (${expected}).`,
            };
        }
        case 'mismatch': {
            return {
                tone: 'warning',
                title: 'Session agent mismatch',
                body: result.agent === null
                    ? `Dispatched, but the session reported no agent (${expected}). ${KEEP_RUNNING}`
                    : `Dispatched, but the session agent was '${result.agent}' (${expected}). ${KEEP_RUNNING}`,
            };
        }
        case 'uncompared': {
            return uncomparedNotice(result);
        }
        case 'timeout':
        case 'unavailable': {
            return observationFailureNotice(result);
        }
    }
}

/**
 * Phrase the read-back for the service's `note` member (contract §5).
 *
 * @returns The note, or `null` when there is nothing to add to the evidence.
 */
export function readBackNote(result: AgentVerification): string | null {
    switch (result.status) {
        case 'match': {
            return null;
        }
        case 'mismatch': {
            return result.agent === null
                ? 'the session reported no agent'
                : `observed ${result.agent} differs from the baseline`;
        }
        case 'uncompared': {
            // The absence is the evidence: the service stores this beside an
            // empty `expectedAgent`, so the row reads as *not compared*.
            return result.agent === null
                ? 'the session reported no agent, and no baseline is configured'
                : 'no baseline is configured, so nothing was compared';
        }
        case 'timeout': {
            const seconds = Math.floor(result.timeoutMs / MS_PER_SECOND);

            return `the agent was not readable within ${seconds}s`;
        }
        case 'unavailable': {
            return `the session could not be opened: ${redact(result.problem)}`;
        }
    }
}
