/**
 * Repository bindings (MVP task M3).
 */

import { nowIso } from '../src/ids.ts';
import { parseProjectId, parseRepository, parseWorktreeOption } from '../src/config.ts';
import { isRecord } from './json.ts';
import { validateStartingPrompt } from './prompt.ts';
import { bindingAllowedUsersOf } from './bindings-allow-list.ts';
import { historyScopeOf } from './bindings-history-scope.ts';
import { BINDINGS_FILE } from './accounts/store.ts';
import type { HistoryScope } from './bindings-history-scope.ts';
import type { ServiceStore } from './store/index.ts';

export { BINDINGS_FILE } from './accounts/store.ts';

/** Trigger set stored on one binding (mention and review scanning ship with M6/M7). */
export interface BindingTriggers {
    /** Issue-assignment polling; implemented for M1. */
    readonly assignment: boolean;
    /** Mention polling (comments and issue bodies); implemented for M6. */
    readonly mention: boolean;
    /** Review-request polling (open PRs naming the account); implemented for M7. */
    readonly reviewRequest: boolean;
    /**
     * Review-submitted polling: a changes-requested review on the account's own
     * open pull request (FR-125).
     */
    readonly reviewSubmitted: boolean;
    /**
     * Failing checks on a tracked pull request's new head (FR-129). A
     * follow-up switch: it can continue a session but never start one.
     */
    readonly checks: boolean;
}

export interface BindingRecord {
    /** Panel-generated id; opaque, URL-safe, unique per binding. */
    readonly bindingId: string;
    /** The bound account's durable GitHub id (digits). */
    readonly accountNumericUserId: string;
    /** The account's login at bind time; display convenience for the panel. */
    readonly accountLogin: string;
    /** The repository, in `owner/name` form. */
    readonly repository: string;
    readonly projectId: string;
    /** `none`, `generated`, or `new:<branch-name>`. */
    readonly worktreeOption: string;
    readonly triggers: BindingTriggers;
    /** `active` until the account-delete guard (or the operator) disables it. */
    readonly state: 'active' | 'disabled';
    /** RFC 3339 creation stamp; kept stable across refreshes. */
    readonly createdAt: string;
    /** RFC 3339 stamp of the last change. */
    readonly updatedAt: string;
    /**
     * The operator's starting prompt for sessions this binding starts.
     *
     * **The key is absent when the prompt is unset** — never `''`, never
     * `null` — so "unset" is a complete state that needs no sentinel. It is
     * validated on every read and every write of the
     * file by {@link validateStartingPrompt}, which is what makes a hand-edited
     * file and a panel save answer the same rules.
     */
    readonly startingPrompt?: string;
    /**
     * The GitHub logins allowed to trigger dispatches from this repository.
     * **Absent means any human actor may trigger**: the key is
     * omitted, never `[]`/`null`/`''`, and `[]` is a refusal, not a
     * state. The stored spelling is preserved; only the comparison folds case,
     * and {@link bindingAllowedUsersOf} validates it on every read
     * and write. **Configuration, and it never leaves this store** — only the
     * policy's *shape* is reported elsewhere.
     */
    readonly allowedUsers?: readonly string[];
    /**
     * Where this binding's scan window's lower bound comes from (002 FR-053).
     * **Absent when the mode is the documented default `new-only`** — never
     * spelled out, never `null` — so unset, cleared and written-before-the-field
     * are one state (FR-058, FR-062). A stored name means the binding also
     * looked back over the fixed seven-day period once, on its first scan.
     * Validated on every read and write by {@link historyScopeOf} (FR-061);
     * two fixed names, so nothing credential-shaped is reported (FR-054).
     */
    readonly historyScope?: HistoryScope;
}

export interface BindingIssue {
    readonly field: string;
    /** Actionable instruction; never echoes what the panel submitted. */
    readonly remediation: string;
}

export type BindingVerdict =
    | { readonly binding: BindingRecord }
    | { readonly issues: readonly BindingIssue[] };

/**
 * The six field verdicts, as {@link refusalsIn} reads them.
 *
 * A union rather than a single weak all-optional shape: TypeScript rejects an
 * object with "no properties in common" against every-optional types, and the
 * success shapes here are deliberately different (`binding`, `binding`,
 * `binding`, `prompt`, `users`, `scope`).
 */
type FieldVerdict =
    | { readonly issue: BindingIssue }
    | { readonly binding: unknown }
    | { readonly prompt: string | null }
    | { readonly users: readonly string[] | null }
    | { readonly scope: HistoryScope | null };

/** Result of validating a whole PUT document. */
export type BindingValidation =
    | { readonly ok: true; readonly bindings: readonly BindingRecord[] }
    | { readonly ok: false; readonly issues: readonly BindingIssue[] };

export const MAX_BINDINGS = 100;

const MAX_BINDING_ID_CHARS = 128;

const MAX_REPOSITORY_CHARS = 200;

const NUMERIC_ID_PATTERN = /^\d+$/;

/** The identity partial collected before the rest of the record joins it. */
interface BindingIdentity {
    readonly bindingId: string;
    readonly accountNumericUserId: string;
    readonly accountLogin: string;
}

/** The dispatch target partial collected next. */
interface BindingTarget {
    readonly repository: string;
    readonly projectId: string;
    /** Canonical worktree option text. */
    readonly worktreeOption: string;
}

/**
 * Read one non-empty string field.
 */
function stringFieldOf(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function issue(value: BindingIssue): { readonly issue: BindingIssue } {
    return { issue: value };
}

/**
 * Validate the `triggers` field shape.
 *
 * `reviewRequest`, `reviewSubmitted` and `checks` are read parse-tolerantly: a
 * binding stored before a switch existed has no such field and reads as
 * `false` (its operator never asked for it), and a field that is present but is
 * not a boolean refuses the record — a half-read trigger is worse than a
 * missing one.
 */
function triggersFieldOf(value: unknown): BindingTriggers | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const { assignment, mention, reviewRequest, reviewSubmitted, checks } = record;
    if (typeof assignment !== 'boolean' || typeof mention !== 'boolean') {
        return null;
    }

    for (const flag of [reviewRequest, reviewSubmitted, checks]) {
        if (flag !== undefined && typeof flag !== 'boolean') {
            return null;
        }
    }

    return {
        assignment,
        mention,
        reviewRequest: reviewRequest === true,
        reviewSubmitted: reviewSubmitted === true,
        checks: checks === true,
    };
}

/**
 * Validate the `state` field, treating an absent state as `active`.
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
 */
function stampOrKeep(value: unknown, fallback: string): string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

/**
 * Read a stored stamp **without** substituting a clock reading: three
 * answers, not two — absent, readable, and present-but-unreadable.
 * {@link stampOrKeep} answers `now` for the last two, which is right for
 * assembly and wrong for a scan window's baseline, where `now − overlapMs`
 * is the unbounded-window defect FR-072 exists to remove (plan H3). Only the
 * middle answer may serve as a time authority.
 */
export function storedStampOf(value: unknown): string | null | undefined {
    if (value === undefined) {
        return null;
    }

    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * Read one `owner/name` repository field.
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
 */
function bindingIdentityOf(raw: Record<string, unknown>, hasAccount: boolean): {
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
    if (typeof accountId !== 'string' || !NUMERIC_ID_PATTERN.test(accountId)) {
        return issue({
            field: 'accountNumericUserId',
            remediation: 'accountNumericUserId must be the GitHub numeric user id of a registered account',
        });
    }

    if (!hasAccount) {
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
 */
function bindingModeOf(raw: Record<string, unknown>): {
    readonly binding: { readonly triggers: BindingTriggers; readonly state: 'active' | 'disabled' };
} | { readonly issue: BindingIssue } {
    const triggers = triggersFieldOf(raw.triggers);
    if (triggers === null) {
        return issue({
            field: 'triggers',
            remediation: 'triggers must be an object with assignment, mention, reviewRequest, '
                + 'reviewSubmitted, and checks boolean flags',
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
 * Read the optional starting prompt through the one prompt validator.
 *
 * The same function runs on the write path and the read path, so a submitted
 * value and a hand-edited file are judged by exactly one refusal set.
 */
function bindingPromptOf(raw: Record<string, unknown>): {
    readonly prompt: string | null;
} | { readonly issue: BindingIssue } {
    const verdict = validateStartingPrompt(raw.startingPrompt);

    return verdict.ok ? { prompt: verdict.prompt } : { issue: verdict.issue };
}

/**
 * Build the record from five already-validated parts, refusing at the first
 * one that will not fit.
 *
 * The short-circuit here is **not** the reporting order: {@link parseBinding}
 * reports every problem the record has. This short-circuit exists so the
 * assembly reads top to
 * bottom and each part narrows without a redundant guard.
 */
function assembleBinding(raw: Record<string, unknown>, hasAccount: boolean): BindingRecord | null {
    const identity = bindingIdentityOf(raw, hasAccount);
    if ('issue' in identity) {
        return null;
    }

    const target = bindingTargetOf(raw);
    if ('issue' in target) {
        return null;
    }

    const mode = bindingModeOf(raw);
    if ('issue' in mode) {
        return null;
    }

    const prompt = bindingPromptOf(raw);
    if ('issue' in prompt) {
        return null;
    }

    const allowedUsers = bindingAllowedUsersOf(raw);
    if ('issue' in allowedUsers) {
        return null;
    }

    const historyScope = historyScopeOf(raw);
    if ('issue' in historyScope) {
        return null;
    }

    const login = identity.binding.accountLogin.trim();
    const createdAt = stampOrKeep(raw.createdAt, nowIso());

    return {
        ...identity.binding,
        accountLogin: login,
        ...target.binding,
        ...mode.binding,
        ...(prompt.prompt !== null && { startingPrompt: prompt.prompt }),
        ...(allowedUsers.users !== null && { allowedUsers: allowedUsers.users }),
        // FR-058: the documented default is **omitted**, not spelled out, so a
        // binding that never chose a mode and one whose mode was cleared are
        // byte-identical and the upgrade writes nothing.
        ...(historyScope.scope !== null && { historyScope: historyScope.scope }),
        createdAt,
        updatedAt: stampOrKeep(raw.updatedAt, createdAt),
    };
}

/**
 * Collect every refusal six field verdicts produced, in field order.
 */
function refusalsIn(verdicts: readonly FieldVerdict[]): readonly BindingIssue[] {
    return verdicts.flatMap((verdict) => ('issue' in verdict ? [verdict.issue] : []));
}

/**
 * Parse one candidate binding field by field, collecting **every** problem:
 * every refusal names the field and the remediation and echoes no submitted
 * value (the same posture the config route fixed). Issues accumulate rather
 * than short-circuit, because one answer must list every problem in the
 * submission — a bad prompt *and* a bad repository arrive in the same 422 —
 * and a first-issue-only reader could never satisfy that.
 */
export function parseBinding(input: {
    readonly raw: Record<string, unknown>;
    /** `true` when the account custody holds `accountNumericUserId`. */
    readonly hasAccount: boolean;
}): BindingVerdict {
    const { raw, hasAccount } = input;
    const record = assembleBinding(raw, hasAccount);
    if (record !== null) {
        return { binding: record };
    }

    // The build refused, so re-run the readers purely to collect *every*
    // problem for one answer. They are pure, so the second
    // pass can only ever disagree with the first by also refusing.
    return {
        issues: refusalsIn([
            bindingIdentityOf(raw, hasAccount),
            bindingTargetOf(raw),
            bindingModeOf(raw),
            bindingPromptOf(raw),
            bindingAllowedUsersOf(raw),
            historyScopeOf(raw),
        ]),
    };
}

/**
 * Run the per-binding checks and collect every issue.
 */
function collectBindingIssues(
    candidates: readonly unknown[],
    hasAccount: (numericUserId: string) => boolean,
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

        const isKnown = typeof record.accountNumericUserId === 'string' && hasAccount(record.accountNumericUserId);
        const verdict = parseBinding({ raw: record, hasAccount: isKnown });
        if ('issues' in verdict) {
            issues.push(...verdict.issues);
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
 */
export function validateBindings(input: {
    readonly raw: unknown;
    /** `true` only for ids the account custody has verified. */
    readonly hasAccount: (numericUserId: string) => boolean;
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

    return collectBindingIssues(body.bindings, input.hasAccount);
}

/**
 * Store the bindings atomically, restoring the array-of-records shape the
 * hardened delete guard reads.
 */
export async function writeBindings(input: {
    readonly store: ServiceStore;
    readonly bindings: readonly BindingRecord[];
}): Promise<void> {
    await input.store.writeJson(BINDINGS_FILE, input.bindings);
}
