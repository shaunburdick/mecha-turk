/**
 * The Status tab's operator-facing copy, as pure functions of the document.
 *
 * Everything the tab *says* lives here so the honesty rules are testable
 * without a DOM and cannot drift from what renders: an unmeasured budget
 * reads *not measured yet* (FR-034, AC-107), an unreadable binding row stays
 * on the page (FR-032, AC-105), an out-of-vocabulary pause reason is printed
 * verbatim (FR-031), a next-poll stamp in the past reads *overdue* rather
 * than being replaced by the configured interval, and the agent pin is
 * *not checkable* / *not available* / an outcome — never "ok" (FR-033,
 * AC-106). FR-080 applies in full: these strings are rendered as text.
 *
 * {@link actorPolicyLines} is the same rule applied to the one value where a
 * plausible-looking default would be a security control that does not exist:
 * an open allow-list is stated as a **count with its consequence**, a count of
 * zero over a non-empty enabled set is stated positively, and an unreadable
 * document reads *not available*. The count is over **enabled** bindings and the
 * consequence clause names **no act** (005 FR-093 as re-cut at v1.14.0,
 * NFR-113, NFR-114, AC-149).
 */

import type { StatusAccountView, StatusBindingView, StatusTabState, StatusView } from './status-document.ts';

/** Locale grouping the interval copy uses, so 60000 reads as 60,000. */
const INTERVAL_GROUPING = 'en-US';

/** Milliseconds in one second. */
const MS_PER_SECOND = 1_000;

/** Seconds in one hour. */
const SECONDS_PER_HOUR = 3_600;

/** Seconds in one minute. */
const SECONDS_PER_MINUTE = 60;

/** Copy for a rate budget nothing has measured yet (FR-034, AC-107). */
const RATE_UNMEASURED = 'not measured yet';

/** Empty state for a healthy service that holds no accounts. */
const ACCOUNTS_NONE = 'No accounts connected yet.';

/** Empty state for accounts the degraded store could not answer (FR-003). */
const ACCOUNTS_UNREADABLE = 'The account list could not be read: the data directory is unavailable.';

/** Empty state for a healthy service that holds no bindings. */
const BINDINGS_NONE = 'No bindings yet.';

/** Empty state for bindings the degraded store could not answer (FR-003). */
const BINDINGS_UNREADABLE = 'The binding list could not be read: the data directory is unavailable.';

/**
 * Format an interval for display.
 *
 * @param ms - Interval in milliseconds.
 * @returns The grouped digits.
 */
function intervalText(ms: number): string {
    return ms.toLocaleString(INTERVAL_GROUPING);
}

/**
 * Format a millisecond duration as a short human duration.
 *
 * @param ms - Milliseconds of uptime.
 * @returns e.g. `2h 5m 3s`, or `0s` for a non-positive input.
 */
export function formatUptime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
    const hours = Math.floor(total / SECONDS_PER_HOUR);
    const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = total % SECONDS_PER_MINUTE;
    const parts: string[] = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }

    if (minutes > 0 || hours > 0) {
        parts.push(`${minutes}m`);
    }

    parts.push(`${seconds}s`);

    return parts.join(' ');
}

/**
 * Render one account's rate block without inventing a measurement.
 *
 * `remaining`, `limit`, and `resetAt` are one budget: while any of them is
 * unmeasured the budget reads *not measured yet*, and `usedLastHour` still
 * reports its own real count beside it. A panel that printed `0 of 0` here
 * would be reporting a measurement GitHub never gave.
 *
 * @param rate - The account's rate state.
 * @returns The rate line.
 */
export function rateLine(rate: StatusAccountView['rate']): string {
    const used = `${rate.usedLastHour} used in the last hour`;
    if (rate.remaining === null || rate.limit === null || rate.resetAt === null) {
        return `${RATE_UNMEASURED} (${used})`;
    }

    const left = rate.remaining.toLocaleString(INTERVAL_GROUPING);
    const limit = rate.limit.toLocaleString(INTERVAL_GROUPING);

    return `${used} of ${limit} · ${left} left in this window · resets ${rate.resetAt}`;
}

/**
 * The projection's service block.
 *
 * @param view - The parsed status document.
 * @returns One line per service fact.
 */
export function serviceLines(view: StatusView): readonly string[] {
    const { service } = view;
    const health = service.status === 'ok'
        ? 'Health: healthy'
        : 'Health: degraded — the data directory cannot serve reads';
    const schema = service.schemaVersion === null
        ? 'Store schema version: not available'
        : `Store schema version: ${service.schemaVersion}`;
    const storage = service.writable
        ? 'Storage: writable'
        : 'Storage: not writable — see the blocking notice above';

    return [
        health,
        `Uptime: ${formatUptime(service.uptimeMs)}`,
        `Data directory: ${service.dataDir} — this is the directory to back up`,
        schema,
        storage,
    ];
}

/**
 * Render a poll cadence, marking a stamp the timer has not reached yet as
 * *overdue* rather than substituting the configured interval.
 *
 * @param stamp - RFC 3339 next-poll stamp.
 * @param nowMs - Clock to judge lateness against.
 * @returns The next-poll line.
 */
function nextPollLine(stamp: string, nowMs: number): string {
    const at = Date.parse(stamp);
    if (Number.isNaN(at)) {
        return `Next poll: ${stamp}`;
    }

    return at <= nowMs ? `Next poll: ${stamp} (overdue)` : `Next poll: ${stamp}`;
}

/** Inputs for {@link pollingLines}; three values, named so they stay ordered. */
export interface PollingLinesInput {
    /** The parsed status document. */
    readonly view: StatusView;
    /** Configured interval from `GET /v1/config`, or `null` when not read. */
    readonly configured: number | null;
    /** Clock the overdue check uses. */
    readonly nowMs: number;
}

/**
 * The configured-interval line, which is honest about not having been read.
 *
 * @param configured - Configured interval, or `null` when it was not read.
 * @returns The line.
 */
function configuredIntervalLine(configured: number | null): string {
    if (configured === null) {
        return 'Configured interval: not read';
    }

    return `Configured interval: ${intervalText(configured)} ms`;
}

/**
 * The polling block: the effective interval, the configured one, and the
 * scheduler's own answer.
 *
 * While the surface cannot run a service at all, nothing here claims a loop
 * is running.
 *
 * @param input - The document, the configured interval, and the clock.
 * @returns One line per polling fact.
 */
export function pollingLines(input: PollingLinesInput): readonly string[] {
    const { view, configured, nowMs } = input;
    const configuredLine = configuredIntervalLine(configured);
    if (!view.supported) {
        return [
            'Polling: not operating — this OpenChamber surface cannot run a local service.',
            configuredLine,
        ];
    }

    const { polling } = view;
    const effective = intervalText(polling.intervalMs);
    const lines = [`Effective interval: ${effective} ms`, configuredLine];

    if (configured !== null && configured !== polling.intervalMs) {
        lines.push(
            `The effective and configured intervals differ: the scheduler is running ${effective} ms, `
            + `while configuration asks for ${intervalText(configured)} ms.`,
        );
    }

    if (polling.paused) {
        // An out-of-vocabulary reason is rendered verbatim, never mapped to a
        // friendly guess.
        const reason = polling.pausedReason === '' ? 'no reason reported' : polling.pausedReason;
        lines.push(`Polling: paused — ${reason}`);
        lines.push('Next poll: none while polling is paused');

        return lines;
    }

    lines.push('Polling: running');
    lines.push(polling.nextPollAt === null ? 'Next poll: not scheduled' : nextPollLine(polling.nextPollAt, nowMs));

    return lines;
}

/**
 * One line per registered account.
 *
 * An empty list is never left to speak for itself: a healthy service with no
 * accounts says so, and a degraded one says it could not read them, because
 * "you have none" and "I cannot tell" are different facts.
 *
 * @param view - The parsed status document.
 * @returns One line per account, plus an empty-state line when there are none.
 */
export function accountLines(view: StatusView): readonly string[] {
    if (view.accounts.length === 0) {
        return [view.service.status === 'degraded' ? ACCOUNTS_UNREADABLE : ACCOUNTS_NONE];
    }

    return view.accounts.map(
        (account) =>
            `${account.login} (${account.numericUserId}) — ${account.connectionState} · ${rateLine(account.rate)}`,
    );
}

/**
 * One line per stored binding, under the heading **Bindings**.
 *
 * A row the scan projection could not read is rendered as *unreadable*
 * rather than dropped: an omitted binding reads as a deleted one.
 * An empty list says which of the two empties it is, for the same reason the
 * account list does.
 *
 * @param view - The parsed status document.
 * @returns One line per binding, plus an empty-state line when there are none.
 */
export function bindingLines(view: StatusView): readonly string[] {
    if (view.bindings.length === 0) {
        return [view.service.status === 'degraded' ? BINDINGS_UNREADABLE : BINDINGS_NONE];
    }

    return view.bindings.map((binding) => {
        const state = binding.active ? 'enabled' : 'disabled';
        if (!binding.readable) {
            return `${binding.repository} — ${state} · unreadable: the scan projection could not be read`;
        }

        const scan = binding.lastScanAt === null ? 'not scanned yet' : `last scan ${binding.lastScanAt}`;
        const pending = `${binding.pendingCount} pending`;
        const cause = binding.lastError === null ? '' : ` · ${binding.lastError}`;

        return `${binding.repository} — ${state} · ${scan} · ${pending}${cause}`;
    });
}

/**
 * The counted line: how many of the **enabled** bindings carry **no**
 * allow-list, and what that means (005 FR-093 as re-cut at v1.14.0).
 *
 * This is Status's whole answer to *"which of my repositories are open?"*, and
 * five properties are load-bearing, each a decision rather than a default:
 *
 * - **The count is over enabled bindings, in both halves.** A disabled binding
 *   can start no session, so it is neither an exposure nor a non-exposure: it
 *   is excluded from the numerator *and* from the denominator, and the
 *   denominator is **labelled** `enabled` wherever a count renders. A count that
 *   filtered on `actorPolicy` alone is non-conforming **whatever it renders** —
 *   `npm run shot` found exactly that, reporting a binding Status itself lists as
 *   `disabled` two lines above as a live exposure.
 * - **The consequence clause is trigger-neutral.** It says *whoever the trigger
 *   lets act*, never *open an issue* or *assign*: one clause spans N bindings
 *   whose switch sets differ, and no single act is true of all of them. A union
 *   would claim an act is possible when for the aggregate it may be something
 *   else, which is the overstatement being fixed. Per-binding derivation belongs
 *   to the Bindings row; Status carries no trigger set and is
 *   forbidden from acquiring one (005 FR-039, clarification row 48).
 * - **Zero is a positive statement, and it is scoped to `enabled`.** *"Every
 *   enabled binding restricts who may trigger"* is a fact worth reading, and
 *   silence is not: an operator cannot tell an absent line from a panel that did
 *   not check. It is scoped because the unqualified form is **false**
 *   the moment a disabled binding is open.
 * - **`0 of 0` is banned in every case**, including bindings-present-but-none-
 *   enabled. A bare `0 of 0` is the reassuring default NFR-113 exists to
 *   prevent: uninformative and reassuring at once, and indistinguishable from a
 *   panel that did not check. That case gets its own sentence naming both how
 *   many bindings exist and that none is on, so the operator never has to infer
 *   a denominator of zero.
 * - **No login, no repository, and no trigger act, ever.** The count is enough
 *   to decide whether to go and look, and naming them would make Status a second
 *   index of the Bindings tab (005 FR-039, clarification row 42).
 *
 * @param view - The parsed document, or `null` when none has been read.
 * @returns The single roll-up line.
 */
export function actorPolicyLines(view: StatusView | null): readonly string[] {
    if (view === null) {
        return ['Who may trigger: not available (service unreachable, or its status could not be read)'];
    }

    const total = view.bindings.length;
    if (total === 0) {
        return ['Who may trigger: no bindings yet, so nothing can trigger until one is bound'];
    }

    const enabled = view.bindings.filter((binding) => binding.active);
    const count = enabled.length;
    if (count === 0) {
        return [`Who may trigger: none of the ${total} bindings is enabled, so nothing can start a session right now`];
    }

    const remedy = 'open the Bindings tab to see or change a binding\'s allowedUsers';
    const open = enabled.filter((binding) => binding.actorPolicy === 'open').length;
    if (open === 0) {
        return [
            'Who may trigger: every enabled binding restricts who may trigger '
            + `(${count} of ${count} enabled); ${remedy}`,
        ];
    }

    return [
        `Who may trigger: ${open} of ${count} enabled bindings has no allow-list, `
        + `so whoever the trigger lets act can start a session; ${remedy}`,
    ];
}

/** Which blocking notices the current document raises (FR-035, FR-036). */
export interface StatusNoticeStates {
    /** Show the unsupported-surface notice. */
    readonly unsupported: boolean;
    /** Show the storage-blocked notice. */
    readonly storageBlocked: boolean;
}

/**
 * Decide which of the two blocking notices the tab shows.
 *
 * With nothing read there is nothing to claim either way, so a `null` document
 * raises neither: an empty tab must not look blocked.
 *
 * @param view - The parsed document, or `null` when no read has landed.
 * @returns Which notices are visible.
 */
export function noticeStates(view: StatusView | null): StatusNoticeStates {
    if (view === null) {
        return { unsupported: false, storageBlocked: false };
    }

    return { unsupported: !view.supported, storageBlocked: !view.service.writable };
}

/** Inputs for {@link projectGuidanceLines}. */
export interface ProjectGuidanceInput {
    /** The binding rows the document carried. */
    readonly bindings: readonly StatusBindingView[];
    /** Project ids the host lists, or `null` while that list is not loaded. */
    readonly registeredProjectIds: readonly string[] | null;
}

/**
 * Point at the Bindings picker's "not listed?" guidance when a binding aims
 * at a project OpenChamber has not registered.
 *
 * The three manual registration routes live in the picker and are not
 * restated here: a second copy of guidance is a second thing to keep true.
 * While the host's project list has not loaded, nothing is claimed — an
 * unlisted project and an unread list are different facts.
 *
 * @param input - The binding rows and the registered project ids.
 * @returns The guidance line, or none when there is nothing to point at.
 */
export function projectGuidanceLines(input: ProjectGuidanceInput): readonly string[] {
    const { bindings, registeredProjectIds } = input;
    if (registeredProjectIds === null) {
        return [];
    }

    const registered = new Set(registeredProjectIds);
    const unregistered = bindings.filter((binding) => !registered.has(binding.projectId));
    if (unregistered.length === 0) {
        return [];
    }

    const repositories = [...new Set(unregistered.map((binding) => binding.repository))].join(', ');

    return [
        `Project registration: ${repositories} point at a project OpenChamber has not registered — `
        + 'open Bindings and use "not listed?" in the project picker.',
    ];
}

/**
 * The agent pin's three shapes, none of which is "ok" by default.
 *
 * A blank baseline reads as *no comparison baseline configured* rather than as
 * an empty name, and a read-back taken against one is reported as an
 * observation that was **not compared** — never as a mismatch (002 FR-029 as
 * amended at v1.10.0).
 *
 * @param view - The parsed status document.
 * @returns One or two lines describing what is known about the pin.
 */
export function agentPinLines(view: StatusView): readonly string[] {
    const { verification, expectedAgent } = view.agentPin;
    const baseline = expectedAgent === null
        ? []
        : [expectedAgent === '' ? 'No comparison baseline configured.' : `Configured baseline: ${expectedAgent}`];

    if (verification.kind === 'none') {
        return [
            ...baseline,
            'Not checkable by the panel — no dispatch has been verified yet; the first dispatch is what checks it.',
        ];
    }

    if (verification.kind === 'unavailable') {
        return [
            ...baseline,
            `Not available — ${verification.reason}. The outcome lives on the dispatch row and in the audit trail.`,
        ];
    }

    const observed = verification.observedAgent ?? 'unreadable';
    const verdict = verification.expectedAgent === ''
        ? 'was read back without comparison (no baseline configured)'
        : `${verification.ok ? 'matched' : 'did not match'} ${verification.expectedAgent}`;

    return [
        ...baseline,
        `Last verification: ${observed} ${verdict} at ${verification.at}.`,
    ];
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
 * A failure keeps the document it already holds and says so with the word
 * *stale*; a failure with nothing retained says plainly that there is none.
 *
 * @param slice - The Status tab's read state.
 * @returns The read-state line.
 */
export function readStateLine(slice: StatusTabState): string {
    if (slice.phase === 'idle') {
        return 'Status: not read yet.';
    }

    if (slice.phase === 'loading') {
        return 'Status: reading…';
    }

    if (slice.phase === 'loaded') {
        return `Status: read at ${slice.at ?? 'an unknown time'}.`;
    }

    const cause = slice.problem ?? 'the service did not answer';
    if (!slice.stale) {
        return `Status could not be read: ${cause}. Nothing has been read yet.`;
    }

    return `Status could not be re-read: ${cause}. Showing the read from ${slice.at}, which may be stale.`;
}
