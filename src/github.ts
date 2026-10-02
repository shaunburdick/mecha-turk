/**
 * The normalised GitHub issue shape the panel composes messages from.
 *
 * This module once carried the spike's REST access: it built paths, called
 * the documented `host.request()` bridge, and parsed provider payloads. That
 * machinery went with the install-time GitHub credential — the panel has no
 * GitHub traffic of its own any more (002 FR-031: read-only, and every read
 * originates in the *service*), so the manifest card, the fetchers, and the
 * `/user` diagnostic that used them are all gone (product-owner order,
 * 2026-09-30).
 *
 * What stays is the record they produced, because two live surfaces still
 * read it: the message composer (`session.ts`) takes one as its issue input,
 * and the relay (`relay-attempt.ts`) projects each claimed run into one.
 * Provider payload fields were always read through accessors rather than
 * destructured, so GitHub's own snake_case names never became identifiers
 * here; nothing in this module parses a payload any more.
 */

/** Normalised, minimal view of a GitHub issue as the panel reads it. */
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
