/**
 * The normalised GitHub issue shape the panel composes messages from.
 *
 * The panel makes no GitHub request of its own: every read originates in the
 * *service* (002 FR-031). The REST access this module used to hold — path
 * building, the `host.request()` bridge, the provider payloads, and the
 * `/user` diagnostic — went with the install-time credential.
 *
 * What stays is the record they produced, because two live surfaces still
 * read it: the message composer (`session.ts`) takes one as its issue input,
 * and the relay (`relay-attempt.ts`) projects each claimed run into one.
 * Provider payload fields were always read through accessors rather than
 * destructured, so GitHub's own snake_case names never became identifiers
 * here; nothing in this module parses a payload any more.
 */

/** Normalised, minimal view of a GitHub issue as the panel reads it. */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export interface GitHubIssue {
    /** Issue number within the repository. */
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
