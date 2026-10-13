/**
 * The Status tab's operator-facing copy, as pure functions of the document —
 * the honesty rules testable without a DOM and unable to drift from what
 * renders: an unmeasured budget reads *not measured yet* (FR-034, AC-107), an
 * unreadable binding row stays on the page (FR-032, AC-105), an
 * out-of-vocabulary pause reason prints verbatim (FR-031), an overdue stamp
 * reads *overdue*, the agent pin is never "ok" (FR-033, AC-106), and every
 * string renders as text (FR-080). {@link cadenceLine} says *not refreshing
 * itself* when no period is known (005 FR-100, FR-101), and
 * {@link actorPolicyLines} states an open allow-list as a count with its
 * consequence — never a plausible default that would be a security control
 * that does not exist (005 FR-093, NFR-113, NFR-114, AC-149).
 */

import type { StatusAccountView, StatusBindingView, StatusTabState, StatusView } from './status-document.ts';

const INTERVAL_GROUPING = 'en-US';

const MS_PER_SECOND = 1_000;

const SECONDS_PER_HOUR = 3_600;

const SECONDS_PER_MINUTE = 60;

const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;

/**
 * Where the cadence statement starts naming minutes rather than seconds.
 *
 * English convention rather than a round number: *every 90 seconds* is what a
 * person says, *every 2 minutes* is what they say next. It also leaves 60 000
 * rendering as *60 seconds*, which is the form 005 FR-101 names.
 */
const MINUTE_WORD_AFTER_MS = 2 * MS_PER_MINUTE;

const RATE_UNMEASURED = 'not measured yet';

const ACCOUNTS_NONE = 'No accounts connected yet.';

const ACCOUNTS_UNREADABLE = 'The account list could not be read: the data directory is unavailable.';

const BINDINGS_NONE = 'No bindings yet.';

const BINDINGS_UNREADABLE = 'The binding list could not be read: the data directory is unavailable.';

function intervalText(ms: number): string {
    return ms.toLocaleString(INTERVAL_GROUPING);
}

/**
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
 */
function nextPollLine(stamp: string, nowMs: number): string {
    const at = Date.parse(stamp);
    if (Number.isNaN(at)) {
        return `Next poll: ${stamp}`;
    }

    return at <= nowMs ? `Next poll: ${stamp} (overdue)` : `Next poll: ${stamp}`;
}

export interface PollingLinesInput {
    readonly view: StatusView;
    readonly configured: number | null;
    readonly nowMs: number;
}

/**
 * The configured-interval line, which is honest about not having been read.
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
        lines.push(`Polling: paused — ${reason}`, 'Next poll: none while polling is paused');

        return lines;
    }

    lines.push(
        'Polling: running',
        polling.nextPollAt === null ? 'Next poll: not scheduled' : nextPollLine(polling.nextPollAt, nowMs),
    );

    return lines;
}

/**
 * One line per registered account.
 *
 * An empty list is never left to speak for itself: a healthy service with no
 * accounts says so, and a degraded one says it could not read them, because
 * "you have none" and "I cannot tell" are different facts.
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
 * allow-list, and what that means (005 FR-093 as re-cut). Five load-bearing
 * properties: the count is over **enabled** bindings in both halves — a
 * disabled binding is neither an exposure nor a non-exposure, and the
 * denominator is labelled `enabled` wherever a count renders; the consequence
 * clause is trigger-neutral (*whoever the trigger lets act*), since Status
 * carries no trigger set and is forbidden from acquiring one (005 FR-039,
 * clarification row 48); zero is a positive statement scoped to `enabled`,
 * because silence cannot distinguish "none open" from "did not check";
 * `0 of 0` is banned in every case (NFR-113) — bindings-present-but-none-enabled
 * gets its own sentence naming both numbers — and no login, no repository, no
 * trigger act, ever: naming them would make Status a second index of the
 * Bindings tab (005 FR-039, clarification row 42).
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

export interface StatusNoticeStates {
    readonly unsupported: boolean;
    readonly storageBlocked: boolean;
}

/**
 * Decide which of the two blocking notices the tab shows.
 *
 * With nothing read there is nothing to claim either way, so a `null` document
 * raises neither: an empty tab must not look blocked.
 */
export function noticeStates(view: StatusView | null): StatusNoticeStates {
    if (view === null) {
        return { unsupported: false, storageBlocked: false };
    }

    return { unsupported: !view.supported, storageBlocked: !view.service.writable };
}

export interface ProjectGuidanceInput {
    readonly bindings: readonly StatusBindingView[];
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
 * amended).
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
 * The follow-up queue's one line (002 FR-036, as amended at v1.16.0): a queue,
 * never delivered work — the count is of follow-ups that have *not* reached
 * their session, so a surface can never claim an empty queue while a prompt is
 * still owed, and `null` is the honest pre-count, because a zero the panel
 * never measured is the claim the amendment forbids.
 */
export function followUpQueueLine(waiting: number | null): string {
    if (waiting === null) {
        return 'Not counted yet this session — the relay counts on its first tick.';
    }

    return waiting === 0
        ? 'Waiting to be delivered: none.'
        : `Waiting to be delivered: ${waiting}.`;
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
 * A failure keeps the document it already holds and says so with the word
 * *stale*; a failure with nothing retained says plainly that there is none.
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

/**
 * Render a period as the words an operator reads, not as a machine string —
 * deliberately **not** {@link formatUptime}, whose trailing `0s` (`1m 0s`) is
 * noise inside a sentence and whose `0s` for a non-positive input would claim a
 * duration the service never reported. The range is the one `service/config.ts`
 * validates (15 000–300 000 ms) and the panel re-validates nothing (005
 * `### Edge Cases`): a whole minute at or above
 * {@link MINUTE_WORD_AFTER_MS} is minutes, a whole second below it is seconds,
 * and anything shorter or non-numeric stays in the machine form the Polling
 * block uses — rounding it into prose would be inventing a period.
 */
function periodText(ms: number): string {
    if (!Number.isFinite(ms) || ms < MS_PER_SECOND) {
        return `${intervalText(ms)} ms`;
    }

    if (ms >= MINUTE_WORD_AFTER_MS && ms % MS_PER_MINUTE === 0) {
        const minutes = ms / MS_PER_MINUTE;

        return `${minutes} minutes`;
    }

    const seconds = ms / MS_PER_SECOND;

    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export interface CadenceLineInput {
    /**
     * The period the tab's refresh tick runs on, or `null` when no tick is
     * armed.
     *
     * The armed period is passed rather than read from a timer handle so this
     * function stays a pure function of one number: the honest value for an
     * unknown cadence is *not refreshing*, and a function that could not tell
     * armed from unarmed would have no honest value to return.
     */
    readonly refreshMs: number | null;
}

/**
 * Render the tab's own refresh cadence in words (005 FR-101): one statement,
 * the same whatever caused the read, because a page whose values move with no
 * stated reason is a page an operator cannot trust to be current (NFR-111).
 * With no tick armed it says *not refreshing itself* and names
 * `Refresh status` — never a plausible period the panel holds no default for
 * (NFR-112) — rendered as text rather than colour (FR-083).
 */
export function cadenceLine(input: CadenceLineInput): string {
    if (input.refreshMs === null) {
        return 'This tab is not refreshing itself — no interval has been read, so it '
            + 'refreshes only when you ask. Use Refresh status.';
    }

    return `This tab re-reads itself every ${periodText(input.refreshMs)}.`;
}
