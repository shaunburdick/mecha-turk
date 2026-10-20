/**
 * The bounded mention-token match every comment and body feed shares
 * (002 FR-016; 011 FR-005, FR-007).
 */

/** Decide whether one character belongs to GitHub's username alphabet. */
function isLoginCharacter(character: string): boolean {
    return /^[A-Za-z0-9_-]$/.test(character);
}

/**
 * Decide whether a body of text carries the bound account's mention token.
 *
 * The token is `@<login>`, matched case-insensitively and bounded on both
 * sides by GitHub's username alphabet (`A-Za-z0-9_-`), so `@octocat-mt`
 * neither matches inside `@octocat-mt2` nor inside `x@octocat-mt`. The scan
 * is written out rather than compiled from the login, so no untrusted string
 * ever reaches a regular-expression engine.
 */
export function mentionsLogin(body: string, login: string): boolean {
    if (login === '') {
        return false;
    }

    const haystack = body.toLowerCase();
    const token = `@${login.toLowerCase()}`;
    let from = haystack.indexOf(token);
    while (from !== -1) {
        const before = from === 0 ? '' : haystack.charAt(from - 1);
        const after = haystack.charAt(from + token.length);
        if (!isLoginCharacter(before) && !isLoginCharacter(after)) {
            return true;
        }

        from = haystack.indexOf(token, from + 1);
    }

    return false;
}
