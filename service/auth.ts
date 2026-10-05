/**
 * Bearer authentication for the loopback proxy.
 *
 * Every request the host forwards — `GET /health` included — carries
 * `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` (contract §1), and the
 * comparison must not leak where a candidate diverged from the secret.
 * `crypto.timingSafeEqual` only accepts equal-length buffers, so both sides
 * are hashed to a fixed 32-byte digest first: a length probe through timing
 * is closed off, and a missing or malformed header is answered exactly like a
 * wrong token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Prefix the host puts in front of the shared secret. */
const BEARER_PREFIX = 'Bearer ';

/** Digest algorithm used to normalise both sides to equal length. */
const DIGEST_ALGORITHM = 'sha256';

/**
 * Extract the credential behind the `Bearer ` prefix.
 *
 * @returns The presented credential, or `''` for a missing or differently
 *   shaped header (indistinguishable from an empty credential by design).
 */
function bearerCredential(header: string | undefined): string {
    if (header === undefined) {
        return '';
    }

    return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
}

/**
 * Compare two strings in constant time via their digests.
 *
 * @param presented - Credential taken from the request.
 * @param expected - Token the service was started with.
 * @returns `true` when the digests are byte-identical.
 */
function digestsMatch(presented: string, expected: string): boolean {
    const left = createHash(DIGEST_ALGORITHM).update(presented).digest();
    const right = createHash(DIGEST_ALGORITHM).update(expected).digest();

    return timingSafeEqual(left, right);
}

/**
 * Decide whether an `Authorization` header carries the expected token.
 *
 * @param token - The expected `OPENCHAMBER_SERVICE_TOKEN`.
 * @returns `true` only when the bearer credential matches in constant time.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export function isAuthorized(header: string | undefined, token: string): boolean {
    return digestsMatch(bearerCredential(header), token);
}
