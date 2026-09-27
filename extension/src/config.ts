/**
 * Spike configuration parsed from the extension's declared integration
 * settings.
 *
 * OpenChamber delivers `integration.settings` values to the panel as plain
 * strings on the ready snapshot. Nothing in the spike reads files or
 * environment variables at runtime, so this module is the single place where
 * operator input is turned into a validated {@link SpikeConfig}. Validation is
 * fail-closed: a missing or malformed repository, project reference, or
 * worktree option stops the spike before it can poll or dispatch.
 */

/** GitHub repository coordinates as shown in the `owner/name` form. */
export interface RepositoryRef {
    /** GitHub organization or user that owns the repository. */
    readonly owner: string;
    /** Repository name without the owner. */
    readonly name: string;
}

/** How `host.startSession()` should treat the worktree for a dispatch. */
export type WorktreeSelection =
    /** Start the session in the project's target directory; no worktree option is sent. */
    | { readonly kind: 'none' }
    /** Ask OpenChamber to generate a worktree for the session. */
    | { readonly kind: 'generated' }
    /** Ask OpenChamber for a named new worktree/branch. */
    | { readonly kind: 'new'; readonly name: string };

/** Validated spike configuration. */
export interface SpikeConfig {
    /** Repository polled by the spike. */
    readonly repository: RepositoryRef;
    /** Optional expected login; when set it must equal the PAT identity. */
    readonly expectedLogin: string | null;
    /** OpenChamber project the dispatch must target. */
    readonly projectId: string;
    /** Worktree option forwarded to `host.startSession()`. */
    readonly worktree: WorktreeSelection;
    /** Poll cadence in milliseconds, clamped to the supported range. */
    readonly pollIntervalMs: number;
}

/** Result of parsing operator settings: either a config or the blocking problems. */
export type ConfigResult =
    | { readonly ok: true; readonly config: SpikeConfig; readonly notes: readonly string[] }
    | { readonly ok: false; readonly problems: readonly string[] };

/** Shape of `ctx.settings` as delivered by the documented host snapshot. */
export type SpikeSettings = Readonly<Record<string, string>>;

/** Default poll cadence, matching the deferred daemon's documented 60-second poll. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Lower bound the spike accepts for polling, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 15_000;

/** Upper bound the spike accepts for polling, in milliseconds. */
export const MAX_POLL_INTERVAL_MS = 300_000;

/** Characters GitHub allows in an owner or repository name. */
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Characters the spike accepts in a new worktree/branch name.
 *
 * Path separators are excluded on purpose: OpenChamber turns the name into a
 * worktree directory under the project, so a name shaped like a path could
 * address somewhere other than the project's own worktrees.
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Substring no new-branch name may contain, because it addresses a parent path. */
const PARENT_PATH_REFERENCE = '..';

/** Blocking problems reported when a setting is missing or malformed. */
const PROBLEMS = {
    repository: 'repository must be "owner/name" using GitHub-safe characters',
    projectId: 'projectId is required; the spike never creates a project implicitly',
    worktree: 'worktreeOption must be "none", "generated", or "new:<branch-name>"',
} as const;

/**
 * Parse an `owner/name` repository string.
 *
 * @param value - Raw setting value.
 * @returns The repository reference, or `null` when the value is not `owner/name`.
 */
export function parseRepository(value: string): RepositoryRef | null {
    const parts = value.trim().split('/');
    if (parts.length !== 2) {
        return null;
    }

    const owner = parts[0];
    const name = parts[1];
    if (owner === undefined || name === undefined || owner === '' || name === '') {
        return null;
    }

    if (!REPOSITORY_PART_PATTERN.test(owner) || !REPOSITORY_PART_PATTERN.test(name)) {
        return null;
    }

    return { owner, name };
}

/**
 * Parse the worktree option setting.
 *
 * Accepted values are `none` (and the empty string), `generated`, and
 * `new:<branch-name>`. A new-branch name must be a plain branch name: no path
 * separators and no `..`, because the host derives a directory from it.
 *
 * @param value - Raw setting value.
 * @returns The worktree selection, or `null` when the value is not understood.
 */
export function parseWorktreeOption(value: string): WorktreeSelection | null {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'none') {
        return { kind: 'none' };
    }

    if (trimmed === 'generated') {
        return { kind: 'generated' };
    }

    if (!trimmed.startsWith('new:')) {
        return null;
    }

    const name = trimmed.slice('new:'.length).trim();
    if (name === '' || name.includes(PARENT_PATH_REFERENCE) || !BRANCH_NAME_PATTERN.test(name)) {
        return null;
    }

    return { kind: 'new', name };
}

/**
 * Read one setting value, treating a missing key as an empty string.
 *
 * @param settings - Values delivered through `ctx.settings`.
 * @param key - Setting id declared in the manifest.
 * @returns The trimmed value, or `''` when the operator left it unset.
 */
function readSetting(settings: SpikeSettings, key: string): string {
    return (settings[key] ?? '').trim();
}

/**
 * Read the poll interval, clamping out-of-range values and noting any change.
 *
 * @param raw - Raw setting value; empty means "use the default".
 * @param notes - Collector for operator-visible notes about adjustments.
 * @returns The interval the spike will use, in milliseconds.
 */
function readInterval(raw: string, notes: string[]): number {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return DEFAULT_POLL_INTERVAL_MS;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isNaN(parsed)) {
        notes.push(`pollIntervalMs "${trimmed}" is not a number; using ${DEFAULT_POLL_INTERVAL_MS}`);
        return DEFAULT_POLL_INTERVAL_MS;
    }

    const clamped = Math.min(Math.max(parsed, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
    if (clamped !== parsed) {
        notes.push(`pollIntervalMs ${parsed} clamped to ${clamped}`);
    }

    return clamped;
}

/**
 * Parse and validate the operator settings declared in the manifest.
 *
 * @param settings - Values from `ctx.settings`; missing keys arrive as `''`.
 * @returns A validated config with notes, or the list of blocking problems.
 */
export function parseSpikeConfig(settings: SpikeSettings): ConfigResult {
    const problems: string[] = [];
    const notes: string[] = [];

    const repository = parseRepository(readSetting(settings, 'repository'));
    if (repository === null) {
        problems.push(PROBLEMS.repository);
    }

    const projectId = readSetting(settings, 'project-id');
    if (projectId === '') {
        problems.push(PROBLEMS.projectId);
    }

    const worktree = parseWorktreeOption(readSetting(settings, 'worktree-option'));
    if (worktree === null) {
        problems.push(PROBLEMS.worktree);
    }

    const pollIntervalMs = readInterval(readSetting(settings, 'poll-interval-ms'), notes);
    const expectedLogin = readSetting(settings, 'expected-login');

    if (problems.length > 0 || repository === null || worktree === null) {
        return { ok: false, problems };
    }

    return {
        ok: true,
        notes,
        config: {
            repository,
            expectedLogin: expectedLogin === '' ? null : expectedLogin,
            projectId,
            worktree,
            pollIntervalMs,
        },
    };
}

/**
 * Render a worktree selection in the setting's own syntax.
 *
 * @param selection - Selection to render.
 * @returns The `none` / `generated` / `new:<name>` string.
 */
export function formatWorktreeOption(selection: WorktreeSelection): string {
    if (selection.kind === 'new') {
        return `new:${selection.name}`;
    }

    return selection.kind;
}

/**
 * Render a repository reference as `owner/name`.
 *
 * @param repository - Repository to render.
 * @returns The `owner/name` label used by GitHub paths and evidence records.
 */
export function repositoryLabel(repository: RepositoryRef): string {
    return `${repository.owner}/${repository.name}`;
}
