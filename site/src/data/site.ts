/**
 * The site's address knowledge, and the only module that holds any: `astro.config.ts` declares
 * `base`, and every internal link goes through `withBase` below, so a repository rename is one
 * edit (FR-005).
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

/** A placeholder origin for `URL` resolution only: `.invalid` never resolves and nothing is
 * fetched — the join reads the resolved `pathname` and discards the origin. */
const RESOLUTION_ORIGIN = 'https://site.invalid';

/**
 * Join a page path onto a base path, for any spelling of the base. `import.meta.env.BASE_URL`'s
 * trailing slash is decided by `trailingSlash`, not by `base` (Astro's configuration reference
 * says so outright), and both spellings occur — a join written against either alone fails
 * *quietly* with the build green: a concatenation emits `/mecha-turkinstall/`, a `URL`
 * resolution treats `/mecha-turk` as a file and emits `/install/`. Normalising the base to
 * directory form makes the result the same under all three settings of `trailingSlash`; `URL`
 * does the joining so the result is resolved rather than glued, and query and fragment are
 * carried across because the documentation pages link to their own sections by anchor.
 */
export function underBase(baseUrl: string, pagePath: string): string {
    const directory = `${baseUrl.replace(/\/+$/, '')}/`;
    const relative = pagePath.replace(/^\/+/, '');
    const joined = new URL(relative, `${RESOLUTION_ORIGIN}${directory}`);
    return `${joined.pathname}${joined.search}${joined.hash}`;
}

/**
 * `underBase` against the base this build actually uses. `BASE_URL` is read inside the function
 * rather than at module scope so `tests/base-path.assertions.mjs` can exercise the join against
 * every spelling without a build — the spelling that matters is the one the build does not use.
 */
export function withBase(pagePath: string): string {
    return underBase(import.meta.env.BASE_URL, pagePath);
}
