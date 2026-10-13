/**
 * Bearer authentication for the loopback proxy.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Prefix the host puts in front of the shared secret. */
const BEARER_PREFIX = 'Bearer ';

/** Digest algorithm used to normalise both sides to equal length. */
const DIGEST_ALGORITHM = 'sha256';

/**
 * Extract the credential behind the `Bearer ` prefix.
 */
function bearerCredential(header: string | undefined): string {
    if (header === undefined) {
        return '';
    }

    return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
}

/**
 * Compare two strings in constant time via their digests.
 */
function digestsMatch(presented: string, expected: string): boolean {
    const left = createHash(DIGEST_ALGORITHM).update(presented).digest();
    const right = createHash(DIGEST_ALGORITHM).update(expected).digest();

    return timingSafeEqual(left, right);
}

/**
 * Decide whether an `Authorization` header carries the expected token.
 *
 * @returns `true` only when the bearer credential matches in constant time.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export function isAuthorized(header: string | undefined, token: string): boolean {
    return digestsMatch(bearerCredential(header), token);
}
