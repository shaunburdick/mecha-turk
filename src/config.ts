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
 *
 * The project id has two operator-facing sources — the panel's project picker
 * (written to extension storage) and the `project-id` integration setting —
 * resolved by {@link resolveProjectId}, which prefers the panel selection.
 *
 * MVP-DEBT (blocker fix 2026-09-27): when the service reports enabled
 * repository bindings, the panel resolves its configuration from the first
 * enabled binding instead (see `bindings-mode.ts`) and the legacy
 * single-repo settings parsed here are ignored. The full settings/bindings
 * merge and precedence rules land post-MVP.
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

/**
 * Agent a dispatched session is expected to run on (M9, research §R3).
 *
 * The panel cannot read OpenChamber's Settings → Sessions → Session Defaults
 * (there is no settings writer at SDK 1.24.2), so the expected agent is the
 * `expected-agent` integration setting, defaulting to the agent the operator
 * is told to pin there. The resolved value lives on the panel state
 * (`PanelState.expectedAgent`) because both configuration modes — legacy
 * single-repo settings and bindings-authoritative mode — must see the same
 * answer; `applySettings` writes it before either mode diverges.
 */
export const DEFAULT_EXPECTED_AGENT = 'project-manager';

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

/**
 * Project ids the spike accepts, from either source.
 *
 * A project id is host-generated and operator-visible, and it also reaches the
 * ledger (`projectId` details), so the spike only accepts printable ASCII with
 * no surrounding whitespace. Anything else is treated as absent, which keeps
 * the fail-closed behaviour instead of forwarding a malformed id to
 * `host.startSession()`.
 */
const PROJECT_ID_PATTERN = /^[\x20-\x7E]+$/;

/** Longest project id the spike accepts; the host's own ids are far shorter. */
const PROJECT_ID_MAX = 128;

/** Blocking problems reported when a setting is missing or malformed. */
const PROBLEMS = {
    repository: 'repository must be "owner/name" using GitHub-safe characters',
    projectId: 'projectId is required; pick a project in the panel or set the "project-id" integration setting',
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
 * Read the expected session agent for post-dispatch verification (M9).
 *
 * Behaves like the other integration settings: the raw value is trimmed, and
 * an unset (or blank) setting falls back to
 * {@link DEFAULT_EXPECTED_AGENT} instead of failing — the expected agent is
 * a *comparison* input for the verification warning, never a gate, so a
 * missing value must not block configuration the way a missing repository or
 * project does.
 *
 * @param settings - Values delivered through `ctx.settings`.
 * @returns The agent the dispatched session should report.
 */
export function parseExpectedAgent(settings: SpikeSettings): string {
    const configured = readSetting(settings, 'expected-agent');

    return configured === '' ? DEFAULT_EXPECTED_AGENT : configured;
}

/**
 * Validate one candidate project id.
 *
 * Shared by configuration resolution and the panel's project picker, so the
 * stored selection, the `project-id` setting, and a freshly picked id are all
 * held to the same rule.
 *
 * @param raw - Candidate id from a stored selection, a setting, or a picker pick.
 * @returns The trimmed id, or `null` when the candidate is absent or malformed.
 */
export function parseProjectId(raw: string | null): string | null {
    if (raw === null) {
        return null;
    }

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.length > PROJECT_ID_MAX || !PROJECT_ID_PATTERN.test(trimmed)) {
        return null;
    }

    return trimmed;
}

/**
 * Where a resolved project id came from.
 *
 * `panel-picker` is the selection the panel stored; `integration-setting` is
 * the `project-id` manifest field. Both are operator configuration, never a
 * secret, so the source is safe to show in the banner.
 */
export type ProjectIdSource = 'panel-picker' | 'integration-setting';

/** A resolved project id paired with the source that supplied it. */
export interface ProjectIdResolution {
    /** Chosen id, or `null` when no source holds a valid one. */
    readonly projectId: string | null;
    /** Source of the chosen id, or `null` when none was found. */
    readonly source: ProjectIdSource | null;
}

/**
 * Choose the project id configuration resolution uses.
 *
 * Two sources can supply it: the selection the panel picker wrote to
 * extension storage, and the `project-id` integration setting. The stored
 * selection wins whenever it holds a valid id, because the panel is where an
 * operator who has no settings UI actually picks a project; the integration
 * setting is the fallback for a fresh install or a headless configuration.
 * Neither source ever creates a project — a source that holds no valid id
 * leaves the spike blocked (FR-020).
 *
 * @param storedProjectId - Selection restored from extension storage, or `null`.
 * @param settingProjectId - Raw `project-id` integration setting value.
 * @returns The chosen id and the source that supplied it.
 */
export function resolveProjectId(storedProjectId: string | null, settingProjectId: string): ProjectIdResolution {
    const stored = parseProjectId(storedProjectId);
    if (stored !== null) {
        return { projectId: stored, source: 'panel-picker' };
    }

    const configured = parseProjectId(settingProjectId);
    return { projectId: configured, source: configured === null ? null : 'integration-setting' };
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
 * Resolve the configured project id and record what the resolution means.
 *
 * Extracted from {@link parseSpikeConfig} so the precedence rule reads as one
 * decision: the panel selection wins, the setting is the fallback, and a
 * source that holds nothing is a blocking problem rather than an implicit
 * project.
 *
 * @param input - Settings, the stored selection, and the two collectors.
 * @returns The chosen project id, or `null` when no source holds one.
 */
function resolveConfiguredProject(input: {
    /** Values from `ctx.settings`. */
    readonly settings: SpikeSettings;
    /** Panel-picker selection restored from storage. */
    readonly storedProjectId: string | null;
    /** Collector for blocking problems. */
    readonly problems: string[];
    /** Collector for operator-visible notes. */
    readonly notes: string[];
}): string | null {
    const { settings, storedProjectId, problems, notes } = input;
    const resolved = resolveProjectId(storedProjectId, readSetting(settings, 'project-id'));
    if (resolved.projectId === null) {
        problems.push(PROBLEMS.projectId);
        return null;
    }

    if (resolved.source === 'panel-picker') {
        notes.push('projectId from the panel picker');
    }

    return resolved.projectId;
}

/**
 * Parse and validate the operator settings declared in the manifest.
 *
 * @param settings - Values from `ctx.settings`; missing keys arrive as `''`.
 * @param storedProjectId - Panel-picker selection restored from extension
 * storage, or `null`; it takes precedence over the `project-id` setting (see
 * {@link resolveProjectId}).
 * @returns A validated config with notes, or the list of blocking problems.
 */
export function parseSpikeConfig(settings: SpikeSettings, storedProjectId: string | null = null): ConfigResult {
    const problems: string[] = [];
    const notes: string[] = [];

    const repository = parseRepository(readSetting(settings, 'repository'));
    if (repository === null) {
        problems.push(PROBLEMS.repository);
    }

    const projectId = resolveConfiguredProject({ settings, storedProjectId, problems, notes });

    const worktree = parseWorktreeOption(readSetting(settings, 'worktree-option'));
    if (worktree === null) {
        problems.push(PROBLEMS.worktree);
    }

    const pollIntervalMs = readInterval(readSetting(settings, 'poll-interval-ms'), notes);
    const expectedLogin = readSetting(settings, 'expected-login');

    // A null resolution has already been pushed as a blocking problem, so the
    // trailing clause is redundant for control flow and load-bearing for the
    // narrowing that types `config.projectId` as a string.
    if (problems.length > 0 || repository === null || worktree === null || projectId === null) {
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
