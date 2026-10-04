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

// The accounts record moved to its own module for the file-length gate; these
// names stay importable from here so no call site had to change with it.
export { parseAccountsBody } from './accounts-service.ts';
export type { AccountScopeMatrix, AccountScopeVerdict, PanelAccount } from './accounts-service.ts';

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
    /**
     * The stored starting prompt, or absent when this binding has none.
     *
     *
     * Read only: the row summary renders presence and length, never this text
     * and never a fingerprint, and a whole-file write carries it
     * for exactly one binding — the one whose prompt the operator edited —
     * so every other row omits the key and the service preserves its prompt.
     * `| undefined` is what lets that omission be expressed as
     * data: `JSON.stringify` drops the member, and the route reads an absent
     * key as *leave this one alone*.
     */
    readonly startingPrompt?: string | undefined;
    /**
     * The GitHub logins allowed to trigger dispatches from this binding, or
     * **absent** when it carries no list.
     *
     * Three states on the wire and two here: **absent** — no policy is
     * configured, so any human actor may trigger this repository — and **a
     * non-empty list**, meaning exactly those logins may. The third wire state,
     * an explicitly empty array, is a **refusal** rather than a value
     * (002 FR-047), so {@link parseBindingEntry} refuses it rather than holding
     * a list the service would never send (invariant 8,
     * `contracts/binding-allow-list.md` §1).
     *
     * Read only: the logins are rendered **exactly once** panel-wide — in the
     * editor field the operator types into — while a row summary shows the
     * **count** and nothing else. `| undefined` is
     * load-bearing in the *other* direction from the prompt's: a whole-file
     * write carries this member on **every** row and **omission means unset**
     * (contract §2), so an operator who clears the field takes the binding
     * back to open. `| undefined` is explicit because `exactOptionalPropertyTypes`
     * is on and the whole-file write spells the member out on every row.
     */
    readonly allowedUsers?: readonly string[] | undefined;
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

/** What reading one row's `allowedUsers` member found. */
type AllowedUsersRead =
    /** Absent, or a non-empty list of logins with the submitted spelling. */
    | { readonly ok: true; readonly users: readonly string[] | undefined }
    /** Present and unusable; the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Read one binding's actor allow-list, fail closed (002 FR-047).
 *
 * Two refusals, each a decision rather than a default. A member that is not an
 * array, and an element that is not text, are refused **whole**: neither can be
 * rendered, counted, or re-sent honestly, and a row that silently dropped the
 * field would let the next write take the binding back to open (invariant 8).
 *
 * An **explicitly empty array** is refused too, though the service refuses it
 * first: 002 FR-047 makes `[]` a refusal on write *and* on read, so no
 * compliant service can send one. Holding a value that means neither *open*
 * nor *those logins* would be the third reading this product refuses to pick
 * silently, and 005 renders that case as *unreadable* rather than as open.
 *
 * The submitted spelling is preserved **verbatim** — the
 * panel compares nothing and normalizes nothing here; the service owns that.
 *
 * @param value - The member as received.
 * @returns The read, marked unusable for a shape this build may not half-apply.
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
    /** Both readable; `undefined` members are written as no key at all. */
    | {
        readonly ok: true;
        readonly startingPrompt: string | undefined;
        readonly allowedUsers: readonly string[] | undefined;
    }
    /** A member present and unusable: the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Read the two members a binding carries *optionally*, refusing a bad one.
 *
 * Both are fail-closed for the same reason and together because they share the
 * shape: a value that is neither text nor a list of text cannot be rendered,
 * cleared, or re-sent honestly, so the whole body stops rather than
 * half-applying it (004 FR-028, 002 FR-047, invariant 8). Absent stays absent
 * for both — that is the complete "this binding has none" state, never a
 * default the operator did not ask for.
 *
 * @param record - The parsed entry.
 * @returns Both members, or the refusal that stops the read.
 */
function readOptionalMembers(record: Record<string, unknown>): OptionalMembers {
    const { startingPrompt } = record;
    if (startingPrompt !== undefined && typeof startingPrompt !== 'string') {
        return { ok: false };
    }

    const actors = readAllowedUsers(record.allowedUsers);

    return actors.ok ? { ok: true, startingPrompt, allowedUsers: actors.users } : { ok: false };
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
