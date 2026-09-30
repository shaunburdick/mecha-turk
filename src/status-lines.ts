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
 * Render one account's rate block without inventing a measurement (FR-034).
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
 * The projection's service block (FR-030).
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
 * *overdue* rather than substituting the configured interval (FR-031).
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
 * scheduler's own answer (FR-031, FR-039).
 *
 * While the surface cannot run a service at all, nothing here claims a loop
 * is running (FR-036).
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
        // friendly guess (FR-031, FR-003).
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
 * One line per registered account (FR-030, FR-034).
 *
 * An empty list is never left to speak for itself: a healthy service with no
 * accounts says so, and a degraded one says it could not read them, because
 * "you have none" and "I cannot tell" are different facts (FR-003, NFR-112).
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
 * One line per stored binding, under the heading **Bindings** (FR-032).
 *
 * A row the scan projection could not read is rendered as *unreadable*
 * rather than dropped: an omitted binding reads as a deleted one (AC-105).
 * An empty list says which of the two empties it is, for the same reason the
 * account list does (FR-003, AC-105, NFR-112).
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
 * raises neither: an empty tab must not look blocked (FR-003, NFR-112).
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
 * at a project OpenChamber has not registered (FR-038).
 *
 * The three manual registration routes live in the picker and are not
 * restated here: a second copy of guidance is a second thing to keep true.
 * While the host's project list has not loaded, nothing is claimed — an
 * unlisted project and an unread list are different facts (FR-003).
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
 * The agent pin's three shapes, none of which is "ok" by default (FR-033).
 *
 * @param view - The parsed status document.
 * @returns One or two lines describing what is known about the pin.
 */
export function agentPinLines(view: StatusView): readonly string[] {
    const { verification, expectedAgent } = view.agentPin;
    const baseline = expectedAgent === null ? [] : [`Configured baseline: ${expectedAgent}`];

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
    const verdict = verification.ok ? 'matched' : 'did not match';

    return [
        ...baseline,
        `Last verification: ${observed} ${verdict} ${verification.expectedAgent} at ${verification.at}.`,
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
