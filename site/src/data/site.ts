/**
 * The site's address knowledge, and the only module in the site that holds any.
 *
 * `astro.config.ts` declares `base`; this module reads it, and no page or
 * component writes an `href` of its own — every internal link goes through
 * `withBase` below. That is what makes a repository rename one edit (FR-005).
 */

/** One published page. `path` is below the site's base; the label is what a reader sees. */
export interface SitePage {
    readonly path: string;
    readonly title: string;
}

/** The five published pages, in navigation order (FR-001). */
export const PAGES: readonly SitePage[] = [
    { path: '/', title: 'Mecha Turk' },
    { path: '/install/', title: 'Install' },
    { path: '/configure/', title: 'Configure' },
    { path: '/use/', title: 'Use' },
    { path: '/debug/', title: 'Debug' },
];

/**
 * A placeholder origin for `URL` resolution only. `.invalid` is reserved and
 * never resolves, so this is safe to name even though nothing is ever fetched:
 * the join reads the resolved `pathname` and discards the origin.
 */
const RESOLUTION_ORIGIN = 'https://site.invalid';

/**
 * Join a page path onto a base path, for any spelling of the base.
 *
 * `import.meta.env.BASE_URL`'s trailing slash is decided by `trailingSlash`, not
 * by `base` — Astro's configuration reference says so outright, and both
 * spellings occur in practice: `/mecha-turk` under the default `'ignore'` and
 * `/mecha-turk/` under the `'always'` this site sets. A join written against
 * either one alone is wrong under the other, and it fails *quietly*: the build
 * stays green while every published link points somewhere else. Measured, both
 * failures — a concatenation emitting `/mecha-turkinstall/`, and a `URL`
 * resolution treating `/mecha-turk` as a file and emitting `/install/` — build
 * cleanly and ship a broken site, which is why this is a function under test
 * rather than a one-line expression.
 *
 * Normalising the base to a directory form before it meets the path makes the
 * result the same under all three settings of `trailingSlash`. `URL` does the
 * joining so the result is resolved rather than glued together, and the query
 * and fragment are carried across from it — the documentation pages link to
 * their own sections by anchor, and `pathname` alone would drop them.
 *
 * @param baseUrl A base path such as `/mecha-turk`, with or without a trailing slash.
 * @param pagePath A path below that base, with or without a leading slash.
 * @returns An absolute path with any query and fragment kept, ready to be an `href`.
 */
export function underBase(baseUrl: string, pagePath: string): string {
    const directory = `${baseUrl.replace(/\/+$/, '')}/`;
    const relative = pagePath.replace(/^\/+/, '');
    const joined = new URL(relative, `${RESOLUTION_ORIGIN}${directory}`);
    return `${joined.pathname}${joined.search}${joined.hash}`;
}

/**
 * `underBase` against the base this build actually uses.
 *
 * `BASE_URL` is read inside the function rather than at module scope so that
 * `tests/base-path.assertions.mjs` can exercise the join against every spelling
 * of it without a build — the spelling that matters is the one the build does
 * not use.
 */
export function withBase(pagePath: string): string {
    return underBase(import.meta.env.BASE_URL, pagePath);
}
