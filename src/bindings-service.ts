/**
 * The Bindings tab's service surface: bindings, accounts, and the per-binding
 * status rows, each call through the documented `host.serviceRequest()` bridge
 * with no credential material. Parsing fails closed — a body this module
 * cannot fully understand reads as unreadable, never half-trusted.
 */

import { asRecord, fieldsHoldText, integerOrZero, parseJsonObject, textOrEmpty, textOrNull } from './json.ts';

// The accounts record moved to its own module for the file-length gate; these
// names stay importable from here so no call site had to change with it.
export { parseAccountsBody } from './accounts-service.ts';
export type { AccountScopeMatrix, AccountScopeVerdict, PanelAccount } from './accounts-service.ts';

export interface PanelTriggers {
    /** Issue-assignment polling; implemented service-side for M1. */
    readonly assignment: boolean;
    /** Mention polling (comments and issue bodies); service-side for M6. */
    readonly mention: boolean;
    /** Review-request polling (open PRs naming the account); M7. */
    readonly reviewRequest: boolean;
    /** Review-submitted polling: changes requested on the account's own pull. */
    readonly reviewSubmitted: boolean;
    /** Failing checks on a tracked pull's current head; a follow-up switch. */
    readonly checks: boolean;
}

export interface PanelBinding {
    /** Panel-generated id; opaque. */
    readonly bindingId: string;
    /** The bound account's GitHub id. */
    readonly accountNumericUserId: string;
    /** The account's login at bind time. */
    readonly accountLogin: string;
    /** The repository as `owner/name`. */
    readonly repository: string;
    readonly projectId: string;
    /** `none`, `generated`, or `new:<branch-name>`. */
    readonly worktreeOption: string;
    readonly triggers: PanelTriggers;
    readonly state: 'active' | 'disabled';
    /** RFC 3339 creation stamp. */
    readonly createdAt: string;
    /** RFC 3339 stamp of the last change. */
    readonly updatedAt: string;
    /**
     * The stored starting prompt, or absent when this binding has none. Read
     * only: the row summary renders presence and length, never this text, and a
     * whole-file write carries it for exactly the one binding whose prompt the
     * operator edited — `| undefined` expresses that omission as data, since
     * `JSON.stringify` drops the member and the route reads an absent key as
     * *leave this one alone*.
     */
    readonly startingPrompt?: string | undefined;
    /**
     * Where this binding's scan window's lower bound comes from, as the service
     * reports it (002 FR-055, FR-092). **Always present, never `undefined`** —
     * absence means the documented default and the service projects it (FR-058;
     * plan H13) — while the panel still **refuses** an unusable member rather
     * than defaulting it (FR-063): an absent member is a fact the service
     * states, an unusable one is something this build cannot judge. The
     * whole-file write carries it on **every** row; omission means *leave this
     * one alone* (002 FR-057).
     */
    readonly historyScope?: HistoryScope | undefined;
    /**
     * The GitHub logins allowed to trigger dispatches, or **absent** when it
     * carries no list. Three wire states, two here: absent means any human
     * actor may trigger; a non-empty list means exactly those logins; an
     * explicitly empty array is a **refusal** rather than a value (002
     * FR-047), so {@link parseBindingEntry} refuses it (invariant 8,
     * `contracts/binding-allow-list.md` §1). Read only — rendered exactly once
     * panel-wide, in the editor field — and `| undefined` is load-bearing: the
     * whole-file write carries the member on **every** row and **omission
     * means unset** (contract §2), so clearing the field takes the binding back
     * to open.
     */
    readonly allowedUsers?: readonly string[] | undefined;
}


export interface BindingStatusRow {
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    readonly projectId: string;
    readonly accountLogin: string;
    /** `true` when the binding is enabled. */
    readonly active: boolean;
    /** RFC 3339 last-scan stamp, or `null` before the first scan. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
    /** Pending or in-flight events for the binding. */
    readonly pendingCount: number;
    /**
     * The lower bound the binding's next scan will open at (002 FR-092):
     * **derived state, not configuration.** `null` means no window yet — no
     * completed scan and no derivable baseline — with the refusal that caused
     * it on `lastError`, readable together with `lastScanAt`.
     */
    readonly windowStart: string | null;
    /**
     * The history scope in force, as the service reports it (002 FR-092).
     * Read **leniently**: an **absent** member is the documented default — an
     * older service's answer that does not carry it is not a fault — while an
     * *unusable* member is a different case and is refused (FR-063).
     */
    readonly historyScope: HistoryScope;
    /**
     * Whether a recovery replay is in force (002 FR-074, FR-078): distinct
     * from `lastScanAt === null` — this is what tells a burst of older events
     * arriving because the queue was lost from one arriving because the
     * operator chose to look back.
     */
    readonly forceReplay: boolean;
}

/** Trigger kinds the panel can render; a stored row from a future build reads as `assignment`. */
export type EventKind = 'assignment' | 'mention' | 'review';

/**
 * The binding history scope, as the panel reads it (002 FR-053). Re-declared
 * here rather than imported because the panel bundle must not reach into
 * `service/` — a shared module would make a panel build depend on service
 * internals — and `tests/history-scope.test.ts` pins the two together over the
 * same fixtures.
 */
export type HistoryScope = 'new-only' | 'recent-history';

/**
 * What a binding with no `historyScope` member scans with (002 FR-053,
 * FR-058): absence has exactly one reading everywhere — `new-only` — and the
 * service projects it, so a binding from an older service still reads as the
 * default rather than as an unknown (plan H13).
 */
export const DEFAULT_HISTORY_SCOPE: HistoryScope = 'new-only';

/**
 * The one mode that is not the default: watch from now on **and** look back
 * over a bounded window once (002 FR-053, FR-084). Named because it changes
 * behaviour in three places — the window the scan opens, whether a grant arms a
 * catch-up, and what the row may label — and a literal spelled three times is
 * three chances to spell it three ways.
 */
export const RECENT_HISTORY_SCOPE: HistoryScope = 'recent-history';

/**
 * **Fails closed rather than defaulting** (002 FR-063, FR-093): a value
 * outside the vocabulary is something this build cannot judge, and rendering
 * it as the default would tell the operator their binding scans from now on
 * when the service may hold something else. `undefined` is *not* that case —
 * an absent member is the documented default and is accepted as it.
 */
export function readHistoryScope(value: unknown): HistoryScope | null {
    if (value === undefined || value === null) {
        return DEFAULT_HISTORY_SCOPE;
    }

    return value === 'new-only' || value === 'recent-history' ? value : null;
}

/** What one bindings/GET answered with. */
export interface BindingsSnapshot {
    readonly bindings: readonly PanelBinding[];
    readonly status: readonly BindingStatusRow[];
}

/** Fields a stored binding row must carry as plain strings. */
const BINDING_STRING_FIELDS = [
    'bindingId',
    'accountNumericUserId',
    'accountLogin',
    'repository',
    'projectId',
    'worktreeOption',
] as const;

/** Fields a stored binding row must carry as plain strings (stamps). */
const BINDING_STAMP_FIELDS = ['createdAt', 'updatedAt'] as const;

/**
 * One trigger flag, typed or defaulted. The `typeof` is load-bearing and `??`
 * would lose it: `??` answers only `null` and `undefined`, while a flag stored
 * as `"yes"` or `0` must read as absent rather than as a truthy member.
 */
function booleanFlagOf(record: Record<string, unknown>, field: string, isAbsent: boolean): boolean {
    const value = record[field];
    if (typeof value === 'boolean') {
        return value;
    }

    return isAbsent;
}

/**
 * Missing flags fall back to the MVP defaults rather than failing the whole
 * binding: a binding stored before M7 has no `reviewRequest` at all, and it
 * reads as `false` (its operator never asked for it).
 */
function readTriggerFlags(value: unknown): PanelTriggers | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    return {
        assignment: booleanFlagOf(record, 'assignment', true),
        mention: booleanFlagOf(record, 'mention', false),
        reviewRequest: booleanFlagOf(record, 'reviewRequest', false),
        reviewSubmitted: booleanFlagOf(record, 'reviewSubmitted', false),
        checks: booleanFlagOf(record, 'checks', false),
    };
}

/**
 * Shared with `dispatches-service.ts`, which reads the same rows through the
 * runs projection — one reader, one rule, so the claim parser and the runs
 * parser can never disagree about what counts as an issue number. The number,
 * or `0` when absent (the entry was already refused).
 */
export function issueNumberFrom(record: Record<string, unknown>): number {
    const value = record.issueNumber;

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * The status row's history-scope read: a member this build cannot judge
 * **drops the row** (002 FR-063 — one refused member is never partially
 * applied, invariant 8), while an absent member reads as the documented
 * default — an answer from a build that does not report it is not a fault
 * (plan H13).
 */
interface StatusScopeRead {
    /** The mode, or `null` when the member is present and unusable. */
    readonly scope: HistoryScope | null;
}

/**
 * Read one status row, filling what the panel cannot trust with `''`/null.
 *
 * @returns The row, or `null` when its `historyScope` is present and unusable —
 *   which drops the whole row rather than rendering a mode this build could not
 *   judge (002 FR-063).
 */
function statusRowOf(
    record: Record<string, unknown>,
    ids: { readonly bindingId: string; readonly repository: string },
): BindingStatusRow | null {
    const scope: StatusScopeRead = { scope: readHistoryScope(record.historyScope) };
    if (scope.scope === null) {
        return null;
    }

    return {
        bindingId: ids.bindingId,
        repository: ids.repository,
        projectId: textOrEmpty(record, 'projectId'),
        accountLogin: textOrEmpty(record, 'accountLogin'),
        active: record.active === true,
        lastScanAt: textOrNull(record, 'lastScanAt'),
        lastError: textOrNull(record, 'lastError'),
        pendingCount: integerOrZero(record, 'pendingCount'),
        // Derived state the service computed (002 FR-092). Unknown members are
        // read leniently — `windowStart` from an older service reads as absent,
        // and the flag as not-in-force — because a *newer* row must not break an
        // older panel (R10.5).
        windowStart: textOrNull(record, 'windowStart'),
        historyScope: scope.scope,
        forceReplay: record.forceReplay === true,
    };
}

export function readStatusRows(rows: readonly unknown[]): BindingStatusRow[] {
    const usable: BindingStatusRow[] = [];
    for (const row of rows) {
        const statusRow = asRecord(row);
        if (statusRow === null) {
            continue;
        }

        const { bindingId, repository } = statusRow;
        if (typeof bindingId !== 'string' || typeof repository !== 'string') {
            continue;
        }

        const row2 = statusRowOf(statusRow, { bindingId, repository });
        if (row2 !== null) {
            usable.push(row2);
        }
    }

    return usable;
}

type AllowedUsersRead =
    /** Absent, or a non-empty list of logins with the submitted spelling. */
    | { readonly ok: true; readonly users: readonly string[] | undefined }
    /** Present and unusable; the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Read one binding's actor allow-list, fail closed (002 FR-047). A non-array
 * member and a non-text element are refused **whole** — neither can be
 * rendered, counted, or re-sent honestly, and a row that silently dropped the
 * field would let the next write take the binding back to open (invariant 8).
 * An **explicitly empty array** is refused too: 002 FR-047 makes `[]` a
 * refusal on write *and* on read, and holding a value that means neither
 * *open* nor *those logins* is the third reading this product refuses to pick
 * silently (005 renders it *unreadable*). The submitted spelling is preserved
 * **verbatim** — the service owns comparison and normalization.
 */
function readAllowedUsers(value: unknown): AllowedUsersRead {
    if (value === undefined) {
        return { ok: true, users: undefined };
    }

    if (!Array.isArray(value)) {
        return { ok: false };
    }

    const users: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') {
            return { ok: false };
        }

        users.push(entry);
    }

    return users.length === 0 ? { ok: false } : { ok: true, users };
}

/** The two optional members one entry reader refuses rather than defaults. */
type OptionalMembers =
    /** All three readable; the prompt is written as no key when it is `undefined`. */
    | {
        readonly ok: true;
        readonly startingPrompt: string | undefined;
        readonly allowedUsers: readonly string[] | undefined;
        readonly historyScope: HistoryScope;
    }
    /** A member present and unusable: the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Read the three members a binding carries *optionally*, refusing a bad one:
 * a value that is neither text, nor a list of text, nor one of the two scope
 * names cannot be rendered, cleared, or re-sent honestly, so the whole body
 * stops rather than half-applying it (004 FR-028, 002 FR-047, 002 FR-063;
 * invariant 8). Prompt and allow-list stay absent when they are; the **scope
 * never stays absent** — absence means the documented default, which the
 * service projects (002 FR-055, FR-058).
 */
function readOptionalMembers(record: Record<string, unknown>): OptionalMembers {
    const { startingPrompt } = record;
    if (startingPrompt !== undefined && typeof startingPrompt !== 'string') {
        return { ok: false };
    }

    const actors = readAllowedUsers(record.allowedUsers);
    if (!actors.ok) {
        return { ok: false };
    }

    // The history scope is judged by the same rule and refused by the same rule:
    // a member outside the two names is something this build cannot render or
    // re-send honestly, so the whole body stops (002 FR-063, invariant 8).
    // **Absent is not that case** — it is the documented default and is accepted
    // as one (002 FR-058).
    const scope = readHistoryScope(record.historyScope);
    if (scope === null) {
        return { ok: false };
    }

    return {
        ok: true,
        startingPrompt,
        allowedUsers: actors.users,
        // The service projects the documented default for a binding that stores
        // no member (002 FR-055), so an answer from a build that *does* report it
        // always carries one. An absent member here is an older service's answer,
        // which is not a fault, and it reads as the default downstream (plan H13).
        historyScope: scope,
    };
}

function parseBindingEntry(value: unknown): PanelBinding | null {
    const record = asRecord(value);
    if (record === null || !fieldsHoldText(record, BINDING_STRING_FIELDS)) {
        return null;
    }

    const { state, triggers } = record;
    if (state !== 'active' && state !== 'disabled') {
        return null;
    }

    const triggerFlags = readTriggerFlags(triggers);
    if (triggerFlags === null || !fieldsHoldText(record, BINDING_STAMP_FIELDS)) {
        return null;
    }

    const optional = readOptionalMembers(record);
    if (!optional.ok) {
        return null;
    }

    const { bindingId, accountNumericUserId, accountLogin, repository, projectId, worktreeOption } = record;

    return {
        bindingId: bindingId as string,
        accountNumericUserId: accountNumericUserId as string,
        accountLogin: accountLogin as string,
        repository: repository as string,
        projectId: projectId as string,
        worktreeOption: worktreeOption as string,
        triggers: triggerFlags,
        state,
        createdAt: record.createdAt as string,
        updatedAt: record.updatedAt as string,
        ...(optional.startingPrompt !== undefined && { startingPrompt: optional.startingPrompt }),
        ...(optional.allowedUsers !== undefined && { allowedUsers: optional.allowedUsers }),
        historyScope: optional.historyScope,
    };
}

/**
 * Read one event kind, defaulting to the M1 trigger for anything this build
 * does not know — a stored row from a future build must not break the relay.
 * Shared with `dispatches-service.ts` for the same reason: the runs list
 * renders rows the panel's own build may not have enqueued.
 */
export function eventKindOf(value: unknown): EventKind {
    if (value === 'mention' || value === 'review') {
        return value;
    }

    return 'assignment';
}


export function countEnabledBindings(bindings: readonly PanelBinding[]): number {
    return bindings.filter((binding) => binding.state === 'active').length;
}

export function parseBindingsBody(text: string): BindingsSnapshot | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.bindings)) {
        return null;
    }

    const bindings: PanelBinding[] = [];
    for (const entry of root.bindings) {
        const binding = parseBindingEntry(entry);
        if (binding === null) {
            return null;
        }

        bindings.push(binding);
    }

    const status = Array.isArray(root.status) ? root.status : [];

    return { bindings, status: readStatusRows(status) };
}
