/**
 * Shared configuration primitives for repository, worktree, and project
 * references.
 *
 * This module once parsed the integration card's `integration.settings`
 * values into a single-repo configuration. That path is **retired**: 002
 * FR-041 empties `contributes.integration.settings` to zero settings, so no
 * reader here — and none anywhere else in `src/` — takes `repository`,
 * `expected-login`, `project-id`, `worktree-option`, `poll-interval-ms`, or
 * `expected-agent` from `ctx.settings`. Bindings are
 * the only configuration resolution mode (`bindings-mode.ts`), the project id
 * comes from the panel picker's `mecha-turk:project` selection alone
 * ({@link parseProjectId}), and the agent-verification baseline is read from
 * `GET /v1/config` per verification (`agent-verify.ts`, 002 FR-029).
 *
 * What survives are the value parsers: the service and the binding editor
 * still hand this module an `owner/name` string, a worktree option, and a
 * project id, and each is still validated fail-closed here — a malformed
 * value is refused rather than forwarded to `host.startSession()`.
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

/**
 * Dispatch context for one repository.
 *
 * Since the card settings retired, the only producer of this shape is
 * `bindings-mode.ts`, which derives it from the first enabled binding; it is
 * no longer parsed out of `ctx.settings`.
 */
export interface SpikeConfig {
    /** Repository polled under this context. */
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

/** Default poll cadence, matching the service's documented 60-second poll. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Documented default for the agent-verification baseline (002 FR-029).
 *
 * **Blank, on purpose.** The product owner's order of 2026-10-01, verbatim:
 * *"Default Agent pin should default to blank, not everyone is going to use
 * project-manager."* OpenChamber's Settings → Sessions → Session Defaults →
 * Default Agent is the documented setup step an operator completes with
 * whichever agent they want dispatches to run on; this constant is what the
 * panel uses when `GET /v1/config` carries no usable `expectedAgent`, and an
 * empty answer means **no baseline to compare against** — the read-back then
 * records the observed agent with its provenance (`defaulted` or `unset`)
 * and compares nothing, never against a name the operator never chose.
 */
export const DEFAULT_EXPECTED_AGENT = '';

/** Characters GitHub allows in an owner or repository name. */
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Characters the panel accepts in a new worktree/branch name.
 *
 * Path separators are excluded on purpose: OpenChamber turns the name into a
 * worktree directory under the project, so a name shaped like a path could
 * address somewhere other than the project's own worktrees.
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Substring no new-branch name may contain, because it addresses a parent path. */
const PARENT_PATH_REFERENCE = '..';

/**
 * Project ids the panel accepts.
 *
 * A project id is host-generated and operator-visible, and it also reaches the
 * ledger (`projectId` details), so only printable ASCII with no surrounding
 * whitespace is accepted. Anything else is treated as absent, which keeps the
 * fail-closed behaviour instead of forwarding a malformed id to
 * `host.startSession()`.
 */
const PROJECT_ID_PATTERN = /^[\x20-\x7E]+$/;

/** Longest project id the panel accepts; the host's own ids are far shorter. */
const PROJECT_ID_MAX = 128;

/**
 * Parse an `owner/name` repository string.
 *
 * @param value - Raw repository string.
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
 * Parse a worktree option value.
 *
 * Accepted values are `none` (and the empty string), `generated`, and
 * `new:<branch-name>`. A new-branch name must be a plain branch name: no path
 * separators and no `..`, because the host derives a directory from it.
 *
 * @param value - Raw worktree option.
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
 * Validate one candidate project id.
 *
 * Shared by the panel's project picker and by the selection restore, so a
 * stored selection and a freshly picked id are held to the same rule. The
 * integration card no longer supplies a `project-id` value (002 FR-041): the
 * stored `mecha-turk:project` selection and the host's own project list are
 * the only sources, and a source that holds no valid id leaves the resolution
 * `null` rather than inventing a project (002 FR-004).
 *
 * @param raw - Candidate id from a stored selection or a picker pick.
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
 * Render a worktree selection in the option's own syntax.
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

/**
 * Split a stored `owner/name` label back into its reference — the inverse of
 * {@link repositoryLabel}, and beside it so the two directions of one
 * vocabulary cannot drift apart.
 *
 * The service's poll triggers need the reference (GitHub paths take `owner` and
 * `name` separately) while every stored row carries the label, and the split is
 * wanted by three modules that must not import each other. It therefore lives
 * here, in the module that already owns the label, and takes a **string** rather
 * than a binding: this is the panel's vocabulary and it must not reach for a
 * service type.
 *
 * A label with no `/` splits to an empty `name`, which is what the service's
 * reader has always answered. A stored binding cannot reach that case —
 * `parseRepository` refuses such a label on write and on read — so the branch is
 * here to keep the function total rather than to serve a caller.
 *
 * @param repository - Stored `owner/name` label.
 * @returns The repository reference.
 */
export function repositoryRefOf(repository: string): RepositoryRef {
    const index = repository.indexOf('/');
    if (index < 0) {
        return { owner: repository, name: '' };
    }

    return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}
