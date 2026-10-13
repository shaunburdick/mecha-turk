/**
 * The normalised GitHub issue shape the panel composes messages from. The
 * panel makes no GitHub request of its own (002 FR-031) — the REST access
 * this module used to hold went with the install-time credential — and two
 * live surfaces still read this record: the message composer and the relay.
 */

/** Normalised, minimal view of a GitHub issue as the panel reads it. */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export interface GitHubIssue {
    readonly issueNumber: number;
    /** Issue title. Untrusted source text. */
    readonly title: string;
    /** Canonical `https://github.com/...` URL. */
    readonly url: string;
    /** Repository state, `open` or `closed`. */
    readonly state: string;
    /** Issue body, or `null` when GitHub returned none. Untrusted source text. */
    readonly body: string | null;
    /** Logins of the current assignees. */
    readonly assignees: readonly string[];
    /** `true` when the entry is a pull request (GitHub lists PRs as issues). */
    readonly isPullRequest: boolean;
}
