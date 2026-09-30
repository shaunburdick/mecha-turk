/**
 * The Bindings tab's service surface: bindings, accounts, and the per-binding
 * status rows they answer with.
 *
 * Every call here goes through the documented `host.serviceRequest()` bridge
 * with no credential material: bindings carry account identities only and the
 * accounts list is the credential-free DTO. Parsing fails closed — a body this
 * module cannot fully understand reads as unreadable, and the caller reports
 * that on its own line rather than half-trusting the record.
 *
 * The relay's claim and reserve answers live beside it in
 * [`claim-service.ts`](./claim-service.ts); the two share exactly three
 * things, all exported from here: the {@link BindingStatusRow} row the status
 * member carries, its reader {@link readStatusRows}, and the two row readers
 * `dispatches-service.ts` also holds an opinion about ({@link issueNumberFrom} and
 * {@link eventKindOf}).
 */

import { asRecord, fieldsHoldText, integerOrZero, parseJsonObject, textOrEmpty, textOrNull } from './json.ts';
import { readScopeMirror } from './account-mirror.ts';

/** Path of the bindings collection. */

/** Path the panel polls for queued events. */

/** Path pattern for one dispatch-result POST. */

/** Lowest HTTP status code a service answer counts as success. */

/** HTTP status the service answers with a `validation` error body. */

/** HTTP status just past the last success code (`2xx`). */

/** Triggers as the panel edits and stores them. */
export interface PanelTriggers {
    /** Issue-assignment polling; implemented service-side for M1. */
    readonly assignment: boolean;
    /** Mention polling (comments and issue bodies); service-side for M6. */
    readonly mention: boolean;
    /** Review-request polling (open PRs naming the account); M7. */
    readonly reviewRequest: boolean;
}

/** One binding as the panel reads, edits, and grants it. */
export interface PanelBinding {
    /** Panel-generated id; opaque. */
    readonly bindingId: string;
    /** The bound account's GitHub id. */
    readonly accountNumericUserId: string;
    /** The account's login at bind time. */
    readonly accountLogin: string;
    /** The repository as `owner/name`. */
    readonly repository: string;
    /** The OpenChamber project the dispatch targets. */
    readonly projectId: string;
    /** `none`, `generated`, or `new:<branch-name>`. */
    readonly worktreeOption: string;
    /** The triggers the binding watches. */
    readonly triggers: PanelTriggers;
    /** Whether the binding currently polls. */
    readonly state: 'active' | 'disabled';
    /** RFC 3339 creation stamp. */
    readonly createdAt: string;
    /** RFC 3339 stamp of the last change. */
    readonly updatedAt: string;
}

/** Verdict one account's recorded scope matrix gives its token (FR-010). */
export type AccountScopeVerdict = 'ok' | 'missing' | 'unknown';

/** One registered account the panel can bind (credential never present). */
export interface PanelAccount {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** `true` only for accounts whose latest verification succeeded. */
    readonly usable: boolean;
    /**
     * What this account's recorded FR-010 scope matrix says about its token
     * (003 T-029), absent when the DTO carried no matrix this build reads.
     *
     * Absent means *no evidence*, never *no problem*: the prerequisites
     * section renders it as not checkable, never as satisfied (FR-072).
     */
    readonly scope?: AccountScopeVerdict;
}

/** One per-binding poll-status row from the service. */
export interface BindingStatusRow {
    /** The binding the row describes. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** The binding's project id. */
    readonly projectId: string;
    /** The account login the binding polls under. */
    readonly accountLogin: string;
    /** `true` when the binding is enabled. */
    readonly active: boolean;
    /** RFC 3339 last-scan stamp, or `null` before the first scan. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
    /** Pending or in-flight events for the binding. */
    readonly pendingCount: number;
}

/** Trigger kinds the panel can render; a stored row from a future build reads as `assignment`. */
export type EventKind = 'assignment' | 'mention' | 'review';

/** What one bindings/GET answered with. */
export interface BindingsSnapshot {
    /** The service's stored bindings. */
    readonly bindings: readonly PanelBinding[];
    /** Per-binding scan status. */
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
 * Read one triggers object leniently; missing flags fall back to the MVP
 * defaults rather than failing the whole binding — a binding stored before
 * M7 has no `reviewRequest` at all, and it reads as `false` (its operator
 * never asked for it).
 *
 * @param value - Candidate triggers.
 * @returns The flags, or `null` when the object itself is unusable.
 */
function readTriggerFlags(value: unknown): PanelTriggers | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    return {
        assignment: typeof record.assignment === 'boolean' ? record.assignment : true,
        mention: typeof record.mention === 'boolean' ? record.mention : false,
        reviewRequest: typeof record.reviewRequest === 'boolean' ? record.reviewRequest : false,
    };
}

/**
 * Read one positive issue number from a stored event row.
 *
 * Shared with `dispatches-service.ts`, which reads the same rows through the runs
 * projection — one reader, one rule, so the claim parser and the runs parser
 * can never disagree about what counts as an issue number.
 *
 * @param record - Parsed row.
 * @returns The number, or `0` when absent (the entry was already refused).
 */
export function issueNumberFrom(record: Record<string, unknown>): number {
    const value = record.issueNumber;

    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Read one status row, filling what the panel cannot trust with `''`/null.
 *
 * @param record - Parsed row.
 * @param ids - The identity fields the caller already narrowed.
 * @returns The row.
 */
function statusRowOf(
    record: Record<string, unknown>,
    ids: { readonly bindingId: string; readonly repository: string },
): BindingStatusRow {
    return {
        bindingId: ids.bindingId,
        repository: ids.repository,
        projectId: textOrEmpty(record, 'projectId'),
        accountLogin: textOrEmpty(record, 'accountLogin'),
        active: record.active === true,
        lastScanAt: textOrNull(record, 'lastScanAt'),
        lastError: textOrNull(record, 'lastError'),
        pendingCount: integerOrZero(record, 'pendingCount'),
    };
}

/**
 * Read a status row collection leniently.
 *
 * @param rows - Parsed status rows.
 * @returns Rows this panel can render, dropping rows it cannot.
 */
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

        usable.push(statusRowOf(statusRow, { bindingId, repository }));
    }

    return usable;
}

/**
 * Read one binding entry.
 *
 * @param value - One element of the `bindings` array.
 * @returns The binding, or `null` when its shape is unusable.
 */
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
    };
}

/**
 * Read one event kind, defaulting to the M1 trigger for anything this build
 * does not know — a stored row from a future build must not break the relay.
 *
 * Shared with `dispatches-service.ts` for exactly the same reason: the runs list
 * renders rows the panel's own build may not have enqueued.
 *
 * @param value - Candidate kind from a stored row.
 * @returns A kind this panel can render.
 */
export function eventKindOf(value: unknown): EventKind {
    if (value === 'mention' || value === 'review') {
        return value;
    }

    return 'assignment';
}


/**
 * Count the enabled bindings in a list.
 *
 * @param bindings - Bindings as the panel last read (or granted) them.
 * @returns How many are currently `active`.
 */
export function countEnabledBindings(bindings: readonly PanelBinding[]): number {
    return bindings.filter((binding) => binding.state === 'active').length;
}

/**
 * Parse the bindings response body.
 *
 * @param text - Response body text.
 * @returns The snapshot, or `null` when the shape is unusable.
 */
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

/**
 * Narrow one account's `scopeCheck` DTO field to a verdict (003 T-029).
 *
 * The narrowing itself is account-mirror's {@link readScopeMirror} — the same
 * four-capability matrix the handoff records into storage — so the mirror and
 * the wire DTO can never drift into two different meanings of "readable". A
 * body without a usable matrix answers `null`, which is *no evidence* rather
 * than *no problem*: the prerequisites section renders that as not checkable
 * and never as satisfied (FR-072).
 *
 * @param raw - `scopeCheck` from the accounts DTO, or anything else.
 * @returns The verdict, or `null` when the DTO carries no readable matrix.
 */
function accountScope(raw: unknown): AccountScopeVerdict | null {
    const mirror = readScopeMirror(raw);
    if (mirror === null) {
        return null;
    }

    const results = Object.values(mirror.results);
    if (results.includes('missing')) {
        return 'missing';
    }

    return results.includes('unknown') ? 'unknown' : 'ok';
}

/**
 * Parse the accounts response body into the records the picker offers.
 *
 * @param text - Response body text.
 * @returns The accounts, or `null` when the shape is unusable.
 */
export function parseAccountsBody(text: string): PanelAccount[] | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.accounts)) {
        return null;
    }

    const accounts: PanelAccount[] = [];
    for (const entry of root.accounts) {
        const record = asRecord(entry);
        if (record === null) {
            return null;
        }

        const { numericUserId, login, state } = record;
        if (typeof numericUserId !== 'string' || typeof login !== 'string') {
            return null;
        }

        // The key stays *absent* when there is no readable matrix, so a
        // record that never carried one and a matrix this build cannot read
        // are indistinguishable — both mean "no evidence".
        const scope = accountScope(record.scopeCheck);
        accounts.push({
            numericUserId,
            login,
            usable: state === 'active',
            ...(scope === null ? {} : { scope }),
        });
    }

    return accounts;
}
