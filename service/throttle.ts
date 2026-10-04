/**
 * Verify throttling for the credential handoff routes (contract §1
 * Concurrency, SEC-04).
 *
 * Two independent limits guard `POST /v1/accounts/verify` and
 * `POST /v1/accounts/:numericUserId/token`:
 *
 * 1. **Concurrency** — at most one verification may be in flight; a second
 *    concurrent attempt answers `429 verify-busy` rather than racing the first
 *    one against the same account store.
 * 2. **Rate** — at most 10 attempts in a rolling 5-minute window; the 11th
 *    answers `429 rate-limited` with `retry-after`, so a retry loop (or a
 *    scripted paste storm) cannot hammer GitHub through this service.
 *
 * The state here is **only timestamps**: no token, no login, no body — it
 * cannot echo or log a credential because it never holds one (SEC-04's
 * "throttle state never echoes/logs the token").
 */

/** Rolling window over which attempts are counted. */
export const VERIFY_WINDOW_MS = 5 * 60_000;

/** Maximum verify attempts inside {@link VERIFY_WINDOW_MS}. */
export const VERIFY_MAX_ATTEMPTS = 10;

/** Milliseconds in one second, used to report `retry-after` in seconds. */
const MS_PER_SECOND = 1_000;

/** Outcome of asking for permission to start one verification. */
export type ThrottleDecision =
    | { readonly allowed: true; readonly lease: VerifyLease }
    | { readonly allowed: false; readonly code: 'verify-busy' | 'rate-limited'; readonly retryAfterSeconds: number };

/** Handle isReleased when the attempt finishes, so the slot frees exactly once. */
export interface VerifyLease {
    /** Marks the attempt finished; idempotent across repeated calls. */
    release(): void;
}

/** The throttle routes share: one rolling window plus one in-flight slot. */
export interface VerifyThrottle {
    /** Ask to start an attempt; every accepted lease must be isReleased. */
    attempt(): ThrottleDecision;
    /** Number of attempts currently in flight. */
    inFlight(): number;
}

/**
 * Build a throttle instance over a rolling window.
 *
 * @param now - Clock injection so tests can advance time deterministically.
 * @returns The throttle bound to that clock.
 */
export function createVerifyThrottle(now: () => number = Date.now): VerifyThrottle {
    const stamps: number[] = [];
    let active = 0;

    const prune = (at: number): void => {
        while (stamps.length > 0 && at - (stamps[0] ?? 0) >= VERIFY_WINDOW_MS) {
            stamps.shift();
        }
    };

    return {
        attempt: (): ThrottleDecision => {
            const at = now();
            prune(at);
            if (active > 0) {
                return { allowed: false, code: 'verify-busy', retryAfterSeconds: 1 };
            }

            const oldest = stamps[0];
            if (oldest !== undefined && stamps.length >= VERIFY_MAX_ATTEMPTS) {
                const waitMs = VERIFY_WINDOW_MS - (at - oldest);

                return {
                    allowed: false,
                    code: 'rate-limited',
                    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / MS_PER_SECOND)),
                };
            }

            stamps.push(at);
            active += 1;
            let isReleased = false;

            return {
                allowed: true,
                lease: {
                    release: (): void => {
                        if (isReleased) {
                            return;
                        }

                        isReleased = true;
                        active -= 1;
                    },
                },
            };
        },
        inFlight: (): number => active,
    };
}
