/**
 * Repository bindings (MVP task M3 — re-cut 2026-09-27).
 *
 * A binding says "poll this repository under that account, dispatch to that
 * project with those triggers and that worktree option". The MVP cut keeps
 * one JSON file (`bindings.json`, an array of these records) and grants it
 * whole through `GET/PUT /v1/bindings`. The hardened account-delete guard in
 * `accounts/store.ts` reads the same file and writes `state: 'disabled'` onto
 * entries it force-disables, so these records keep that exact field:
 * `state` is *the* disabled truth, and there is no separate enabled flag.
 *
 * MVP-DEBT: the contract's per-binding `PATCH /v1/bindings/:bindingId` and
 * its draft/project-missing state machine are not implemented — the
 * whole-file grant is the simplest honest surface for one operator and one
 * panel.
 */

import { nowIso } from '../src/ids.ts';
import { parseProjectId, parseRepository, parseWorktreeOption } from '../src/config.ts';
import { isRecord } from './json.ts';
import { BINDINGS_FILE } from './accounts/store.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/** Store file the bindings live in; shared with the hardened delete guard. */
export { BINDINGS_FILE } from './accounts/store.ts';

/** Trigger set stored on one binding (comment scanning ships with M6). */
export interface BindingTriggers {
    /** Issue-assignment polling; implemented for M1. */
    readonly assignment: boolean;
    /** Comment-mention polling; stored only until M6. */
    readonly mention: boolean;
}

/** One repository binding as the service stores and reports it. */
export interface BindingRecord {
    /** Panel-generated id; opaque, URL-safe, unique per binding. */
    readonly bindingId: string;
    /** The bound account's durable GitHub id (digits). */
    readonly accountNumericUserId: string;
    /** The account's login at bind time; display convenience for the panel. */
    readonly accountLogin: string;
    /** The repository, in `owner/name` form. */
    readonly repository: string;
    /** The OpenChamber project the dispatch targets. */
    readonly projectId: string;
    /** `none`, `generated`, or `new:<branch-name>`. */
    readonly worktreeOption: string;
    /** Triggers the binding watches. */
    readonly triggers: BindingTriggers;
    /** `active` until the account-delete guard (or the operator) disables it. */
    readonly state: 'active' | 'disabled';
    /** RFC 3339 creation stamp; kept stable across refreshes. */
    readonly createdAt: string;
    /** RFC 3339 stamp of the last change. */
    readonly updatedAt: string;
}

/** One rejected field, in the field + remediation vocabulary the config sets. */
export interface BindingIssue {
    /** Field name as the panel emitted it. */
    readonly field: string;
    /** Actionable instruction; never echoes what the panel submitted. */
    readonly remediation: string;
}

/** Result of validating one candidate binding. */
type BindingVerdict = { readonly binding: BindingRecord } | { readonly issue: BindingIssue };

/** Result of validating a whole PUT document. */
export type BindingValidation =
    | { readonly ok: true; readonly bindings: readonly BindingRecord[] }
    | { readonly ok: false; readonly issues: readonly BindingIssue[] };

/** Upper bound on bindings one operator may keep. */
export const MAX_BINDINGS = 100;

/** Longest binding id accepted (panel-generated, opaque). */
const MAX_BINDING_ID_CHARS = 128;

/** Longest `owner/name` label accepted. */
const MAX_REPOSITORY_CHARS = 200;

/** Recognise a digit-only GitHub numeric user id. */
const NUMERIC_ID_PATTERN = /^\d+$/;

/** The identity partial collected before the rest of the record joins it. */
interface BindingIdentity {
    /** The unique panel-generated id. */
    readonly bindingId: string;
    /** The bound account's GitHub id. */
    readonly accountNumericUserId: string;
    /** The account's login at bind time. */
    readonly accountLogin: string;
}

/** The dispatch target partial collected next. */
interface BindingTarget {
    /** `owner/name` repository label. */
    readonly repository: string;
    /** The OpenChamber project id. */
    readonly projectId: string;
    /** Canonical worktree option text. */
    readonly worktreeOption: string;
}

/**
 * Read one non-empty string field.
 *
 * @param value - Candidate value.
 * @returns The value, or `null` when it is not usable text.
 */
function stringFieldOf(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Build the single issue verdict.
 *
 * @param value - The refusal to return.
 * @returns The issue verdict carrying that refusal.
 */
function issue(value: BindingIssue): { readonly issue: BindingIssue } {
    return { issue: value };
}

/**
 * Validate the `triggers` field shape.
 *
 * @param value - Candidate value.
 * @returns The triggers, or `null` when the shape is unusable.
 */
function triggersFieldOf(value: unknown): BindingTriggers | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const { assignment, mention } = record;
    if (typeof assignment !== 'boolean' || typeof mention !== 'boolean') {
        return null;
    }

    return { assignment, mention };
}

/**
 * Validate the `state` field, treating an absent state as `active`.
 *
 * @param value - Candidate value.
 * @returns The state, or `null` when it is neither of the two values.
 */
function stateFieldOf(value: unknown): 'active' | 'disabled' | null {
    if (value === undefined) {
        return 'active';
    }

    if (value === 'active' || value === 'disabled') {
        return value;
    }

    return null;
}

/**
 * Read one stamp, keeping a fallback when the candidate is unusable.
 *
 * @param value - Candidate stamp.
 * @param fallback - Stamp to keep when the candidate is unusable.
 * @returns The usable stamp.
 */
function stampOrKeep(value: unknown, fallback: string): string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

/**
 * Read one `owner/name` repository field.
 *
 * @param value - Candidate value.
 * @returns The canonical label, or `null` when unusable.
 */
function repositoryFieldOf(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > MAX_REPOSITORY_CHARS) {
        return null;
    }

    const parsed = parseRepository(value);

    return parsed === null ? null : `${parsed.owner}/${parsed.name}`;
}

/**
 * Read one worktree option field, rendering the canonical text.
 *
 * @param value - Candidate value.
 * @returns The canonical option text, or `null` when unusable.
 */
function worktreeFieldOf(value: unknown): string | null {
    const parsed = parseWorktreeOption(typeof value === 'string' ? value : '');
    if (parsed === null) {
        return null;
    }

    if (parsed.kind === 'new') {
        return `new:${parsed.name}`;
    }

    return parsed.kind;
}

/**
 * Read the identity fields (binding id, account id, and login).
 *
 * @param raw - Candidate record.
 * @param accountExists - `true` when the account custody holds the id.
 * @returns The identity partial, or the blocking issue.
 */
function bindingIdentityOf(raw: Record<string, unknown>, accountExists: boolean): {
    readonly binding: BindingIdentity;
} | { readonly issue: BindingIssue } {
    const bindingId = stringFieldOf(raw.bindingId);
    if (bindingId === null || bindingId.length > MAX_BINDING_ID_CHARS) {
        return issue({
            field: 'bindingId',
            remediation: `bindingId must be a unique string of at most ${MAX_BINDING_ID_CHARS} characters`,
        });
    }

    const accountId = raw.accountNumericUserId;
    const accountCopy = 'accountNumericUserId must be the GitHub numeric user id of a registered account';
    if (typeof accountId !== 'string' || !NUMERIC_ID_PATTERN.test(accountId)) {
        return issue({ field: 'accountNumericUserId', remediation: accountCopy });
    }

    if (!accountExists) {
        return issue({
            field: 'accountNumericUserId',
            remediation: 'register the account before binding it',
        });
    }

    const login = stringFieldOf(raw.accountLogin);
    if (login === null || login.trim() === '') {
        return issue({
            field: 'accountLogin',
            remediation: 'accountLogin must be the login shown for this account',
        });
    }

    return { binding: { bindingId, accountNumericUserId: accountId, accountLogin: login } };
}

/**
 * Read the dispatch-target fields (repository, project, worktree).
 *
 * @param raw - Candidate record.
 * @returns The target partial, or the blocking issue.
 */
function bindingTargetOf(raw: Record<string, unknown>): {
    readonly binding: BindingTarget;
} | { readonly issue: BindingIssue } {
    const repository = repositoryFieldOf(raw.repository);
    if (repository === null) {
        return issue({
            field: 'repository',
            remediation: 'repository must be an existing GitHub repository written as `owner/name`',
        });
    }

    const projectId = parseProjectId(stringFieldOf(raw.projectId));
    if (projectId === null) {
        return issue({
            field: 'projectId',
            remediation: 'projectId must be an existing OpenChamber project id (from the panel picker)',
        });
    }

    const worktreeOption = worktreeFieldOf(raw.worktreeOption);
    if (worktreeOption === null) {
        return issue({
            field: 'worktreeOption',
            remediation: 'worktreeOption must be `none`, `generated`, or `new:<branch-name>`',
        });
    }

    return { binding: { repository, projectId, worktreeOption } };
}

/**
 * Read the `triggers` and `state` mode fields.
 *
 * @param raw - Candidate record.
 * @returns The fields, or the blocking issue.
 */
function bindingModeOf(raw: Record<string, unknown>): {
    readonly binding: { readonly triggers: BindingTriggers; readonly state: 'active' | 'disabled' };
} | { readonly issue: BindingIssue } {
    const triggers = triggersFieldOf(raw.triggers);
    if (triggers === null) {
        return issue({
            field: 'triggers',
            remediation: 'triggers must be an object with assignment and mention boolean flags',
        });
    }

    const state = stateFieldOf(raw.state);
    if (state === null) {
        return issue({
            field: 'state',
            remediation: 'state must be `active` or `disabled`',
        });
    }

    return { binding: { triggers, state } };
}

/**
 * Parse one candidate binding field by field.
 *
 * Every refusal names the field and the remediation; no submitted value is
 * ever echoed back (the same SEC-11 posture the config route fixed).
 *
 * @param input - The candidate record and whether the referenced account exists.
 * @returns The ready record, or the one blocking issue.
 */
export function parseBinding(input: {
    /** Candidate binding, already known to be a record. */
    readonly raw: Record<string, unknown>;
    /** `true` when the account custody holds `accountNumericUserId`. */
    readonly accountExists: boolean;
}): BindingVerdict {
    const { raw, accountExists } = input;

    const identity = bindingIdentityOf(raw, accountExists);
    if ('issue' in identity) {
        return identity;
    }

    const target = bindingTargetOf(raw);
    if ('issue' in target) {
        return target;
    }

    const mode = bindingModeOf(raw);
    if ('issue' in mode) {
        return mode;
    }

    const login = identity.binding.accountLogin.trim();
    const createdAt = stampOrKeep(raw.createdAt, nowIso());

    return {
        binding: {
            ...identity.binding,
            accountLogin: login,
            ...target.binding,
            ...mode.binding,
            createdAt,
            updatedAt: stampOrKeep(raw.updatedAt, createdAt),
        },
    };
}

/**
 * Run the per-binding checks and collect every issue.
 *
 * @param candidates - The raw candidate rows.
 * @param accountExists - `true` only for ids the custody has verified.
 * @returns The validated records, or the collected issues.
 */
function collectBindingIssues(
    candidates: readonly unknown[],
    accountExists: (numericUserId: string) => boolean,
): BindingValidation {
    const issues: BindingIssue[] = [];
    const seen = new Set<string>();
    const bindings: BindingRecord[] = [];
    for (const candidate of candidates) {
        const record = isRecord(candidate) ? candidate : null;
        if (record === null) {
            issues.push({ field: 'bindings[]', remediation: 'each binding must be a JSON object' });
            continue;
        }

        const exists = typeof record.accountNumericUserId === 'string' && accountExists(record.accountNumericUserId);
        const verdict = parseBinding({ raw: record, accountExists: exists });
        if ('issue' in verdict) {
            issues.push(verdict.issue);
            continue;
        }

        if (seen.has(verdict.binding.bindingId)) {
            issues.push({ field: 'bindingId', remediation: 'each binding must carry a unique bindingId' });
            continue;
        }

        seen.add(verdict.binding.bindingId);
        bindings.push(verdict.binding);
    }

    if (issues.length > 0) {
        return { ok: false, issues };
    }

    return { ok: true, bindings };
}

/**
 * Validate a whole `PUT /v1/bindings` document.
 *
 * The body must be `{ bindings: [...] }`; each binding is parsed in turn and
 * the collected issues are returned together, so one 422 answers every bad
 * field at once (the same additive-reporting shape the config route uses).
 * Binding ids must be unique; the count stays inside the operator cap.
 *
 * @param input - Raw body and the account-existence predicate to consult.
 * @returns The validated records, or every issue found.
 */
export function validateBindings(input: {
    /** The PUT body, or anything else. */
    readonly raw: unknown;
    /** `true` only for ids the account custody has verified. */
    readonly accountExists: (numericUserId: string) => boolean;
}): BindingValidation {
    const bodyCopy = 'send `{ bindings: [...] }` holding every binding the panel keeps';
    const body = isRecord(input.raw) ? input.raw : null;
    if (body === null || !Array.isArray(body.bindings)) {
        return {
            ok: false,
            issues: [{ field: 'body', remediation: bodyCopy }],
        };
    }

    const capCopy = `keep the list to ${MAX_BINDINGS} bindings`;
    if (body.bindings.length > MAX_BINDINGS) {
        return {
            ok: false,
            issues: [{ field: 'bindings', remediation: capCopy }],
        };
    }

    return collectBindingIssues(body.bindings, input.accountExists);
}

/**
 * Validate a whole bindings file, as the store's read path wants.
 *
 * @param raw - Parsed file.
 * @returns The bindings, or `null` to quarantine the file (never fail-stuck).
 */
function parseBindingsFile(raw: unknown): BindingRecord[] | null {
    if (!Array.isArray(raw) || raw.some((entry) => !isRecord(entry))) {
        return null;
    }

    const bindings: BindingRecord[] = [];
    for (const entry of raw) {
        const verdict = parseBinding({ raw: entry, accountExists: true });
        if ('issue' in verdict) {
            return null;
        }

        bindings.push(verdict.binding);
    }

    return bindings;
}

/**
 * Read the stored bindings, best-effort.
 *
 * A quarantined file is skipped rather than aborting the poll: the store
 * logs its quarantine path and the loop simply has nothing to scan this
 * cycle.
 *
 * @param input - Open store and logger.
 * @returns The bindings, or `[]` when the file is absent/unusable.
 */
export async function readBindings(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<BindingRecord[]> {
    const { store, log } = input;
    try {
        const result = await store.readJson(BINDINGS_FILE, parseBindingsFile);
        if (result.status === 'ok') {
            return result.value;
        }

        if (result.status === 'quarantined') {
            log.warn('stored bindings were unusable and have been set aside', {
                quarantinePath: result.quarantinePath,
            });
        }

        return [];
    } catch (cause) {
        log.warn('bindings read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return [];
    }
}

/**
 * Store the bindings atomically, restoring the array-of-records shape the
 * hardened delete guard reads.
 *
 * @param input - Open store and the records to store.
 */
export async function writeBindings(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** The records to store. */
    readonly bindings: readonly BindingRecord[];
}): Promise<void> {
    await input.store.writeJson(BINDINGS_FILE, input.bindings);
}
