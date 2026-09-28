/**
 * Service surface the Repos tab and the event relay read (M3/M4 re-cut).
 *
 * Every call here goes through the documented `host.serviceRequest()` bridge
 * with no credential material: bindings carry account identities only, the
 * accounts list is the credential-free DTO, and event payloads carry issue
 * text the service already deemed shippable. Parsing fails closed — a body
 * this module cannot fully understand reads as unreadable, and the caller
 * reports that on its own line rather than half-trusting the record.
 *
 * MVP-DEBT: these paths are the re-cut's simple relay; the contract's
 * per-binding PATCH and lease machinery roundtrips later.
 */

import { asRecord, parseJsonObject } from './json.ts';

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
    /** Comment-mention polling; implemented service-side for M6. */
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

/** One registered account the panel can bind (credential never present). */
export interface PanelAccount {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** `true` only for accounts whose latest verification succeeded. */
    readonly usable: boolean;
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

/** One queued event as the relay delivers it. */
export interface RelayEvent {
    /** Deterministic event id (the dedupe key and dispatch path segment). */
    readonly eventId: string;
    /** Binding that produced the event. */
    readonly bindingId: string;
    /** Trigger kind. */
    readonly kind: 'assignment' | 'mention' | 'review';
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** The account's GitHub id. */
    readonly accountNumericUserId: string;
    /** The account's login. */
    readonly accountLogin: string;
    /** Project id the dispatch targets. */
    readonly projectId: string;
    /** Worktree option snapshotted at enqueue. */
    readonly worktreeOption: string;
    /** Issue number. */
    readonly issueNumber: number;
    /** Issue title. */
    readonly issueTitle: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** Bounded body excerpt. */
    readonly issueBodyExcerpt: string;
    /** Trigger phrase for the PM context. */
    readonly triggerNote: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
}

/** What one bindings/GET answered with. */
export interface BindingsSnapshot {
    /** The service's stored bindings. */
    readonly bindings: readonly PanelBinding[];
    /** Per-binding scan status. */
    readonly status: readonly BindingStatusRow[];
}

/** One unclaimed-event answer after the claim. */
export interface PendingAnswer {
    /** The events the panel now owns (claimed service-side). */
    readonly events: readonly RelayEvent[];
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

/** Fields one queued event must carry as plain strings. */
const EVENT_STRING_FIELDS = [
    'id',
    'bindingId',
    'repository',
    'accountNumericUserId',
    'accountLogin',
    'projectId',
    'worktreeOption',
    'issueTitle',
    'issueUrl',
    'triggerNote',
    'detectedAt',
] as const;

/**
 * Check every field of one record holds usable text.
 *
 * @param record - Candidate record.
 * @param fields - Field names to require.
 * @returns `true` when every field is usable text.
 */
function fieldsHoldText(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => typeof record[field] === 'string' && record[field] !== '');
}

/**
 * Read one string field, defaulting to `''`.
 *
 * @param record - Parsed record.
 * @param field - Field name.
 * @returns The field text, or `''` when unusable.
 */
function textOrEmpty(record: Record<string, unknown>, field: string): string {
    const value = record[field];

    return typeof value === 'string' ? value : '';
}

/**
 * Read one stamp-or-null field.
 *
 * @param record - Parsed record.
 * @param field - Field name.
 * @returns The stamp, or `null` when unusable.
 */
function textOrNull(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Read one non-negative integer field.
 *
 * @param record - Parsed record.
 * @param field - Field name.
 * @returns The integer, or `0` when unusable.
 */
function integerOrZero(record: Record<string, unknown>, field: string): number {
    const value = record[field];

    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

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
 * @param record - Parsed row.
 * @returns The number, or `0` when absent (the entry was already refused).
 */
function issueNumberFrom(record: Record<string, unknown>): number {
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
function readStatusRows(rows: readonly unknown[]): BindingStatusRow[] {
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
 * @param value - Candidate kind from a stored row.
 * @returns A kind this panel can render.
 */
function eventKindOf(value: unknown): RelayEvent['kind'] {
    if (value === 'mention' || value === 'review') {
        return value;
    }

    return 'assignment';
}

/**
 * Parse one queued event.
 *
 * @param value - One element of the `events` array.
 * @returns The event, or `null` (the list then stays partial).
 */
function parseEventEntry(value: unknown): RelayEvent | null {
    const record = asRecord(value);
    if (record === null || !fieldsHoldText(record, EVENT_STRING_FIELDS)) {
        return null;
    }

    const issueNumber = issueNumberFrom(record);
    if (issueNumber === 0) {
        return null;
    }

    const { kind, id, bindingId, repository, accountNumericUserId, accountLogin, projectId, worktreeOption } = record;
    const { issueTitle, issueUrl, triggerNote, detectedAt } = record;

    return {
        eventId: id as string,
        bindingId: bindingId as string,
        kind: eventKindOf(kind),
        repository: repository as string,
        accountNumericUserId: accountNumericUserId as string,
        accountLogin: accountLogin as string,
        projectId: projectId as string,
        worktreeOption: worktreeOption as string,
        issueNumber,
        issueTitle: issueTitle as string,
        issueUrl: issueUrl as string,
        issueBodyExcerpt: textOrEmpty(record, 'issueBodyExcerpt'),
        triggerNote: triggerNote as string,
        detectedAt: detectedAt as string,
    };
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

        accounts.push({ numericUserId, login, usable: state === 'active' });
    }

    return accounts;
}

/**
 * Parse the pending-events response body.
 *
 * @param text - Response body text.
 * @returns The claim answer, or `null` when the shape is unusable.
 */
export function parsePendingBody(text: string): PendingAnswer | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.events)) {
        return null;
    }

    const events: RelayEvent[] = [];
    for (const entry of root.events) {
        const event = parseEventEntry(entry);
        if (event === null) {
            continue;
        }

        events.push(event);
    }

    const status = Array.isArray(root.status) ? root.status : [];

    return { events, status: readStatusRows(status) };
}

