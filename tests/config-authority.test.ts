/**
 * Configuration authority (006 T-025, T-026 — block J; FR-090, AC-152).
 *
 * Three layers, in this order, with no overlap between them — so precedence
 * is a property of the ordering rather than a tie-break (FR-090):
 *
 * 1. **Bootstrap environment**, read at process start before the store opens:
 *    the host-provided pair only, validated fail-closed and never echoed.
 * 2. **`config.json`**, authoritative for every documented field once the
 *    store opens.
 * 3. **The manifest**, which carries **no** service configuration at all —
 *    its integration card is gone entirely (product-owner order,
 *    2026-09-30), so there is no second input surface to arbitrate.
 *
 * What is asserted here is layer 1: `readServiceEnv` starts from exactly the
 * host-provided pair, ignores an unrelated variable in the environment it is
 * handed, refuses a missing or malformed half naming the field that failed,
 * and echoes neither the token nor the value it refused.
 *
 * Offline: the pure environment reader (FR-086). No network, no PAT, no live
 * host.
 */

import { describe, expect, it } from 'vitest';
import { readServiceEnv } from '../service/env.ts';

/** The bootstrap pair the host sets and the service validates (FR-090). */
const PORT_KEY = 'OPENCHAMBER_SERVICE_PORT';

/** The second half of the bootstrap pair. */
const TOKEN_KEY = 'OPENCHAMBER_SERVICE_TOKEN';

/** A token shaped so that leaking it into a message would be obvious. */
const TOKEN_VALUE = 'the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789';

/**
 * Capture the message one call refused with.
 *
 * @param run - The call that is expected to throw.
 * @returns The error's message.
 */
function messageOf(run: () => unknown): string {
    try {
        run();
    } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
    }

    throw new Error('expected the environment to be refused');
}

describe('FR-090 / AC-152: the bootstrap pair is the only configuration environment', () => {
    it('starts from exactly the host-provided pair, ignoring anything else', () => {
        {
            const decoy = 'SOME_UNRELATED_VARIABLE';
            const env = readServiceEnv({
                [PORT_KEY]: '0',
                [TOKEN_KEY]: TOKEN_VALUE,
                [decoy]: 'ignored',
            });

            expect(env).toEqual({ port: 0, token: TOKEN_VALUE });
        }
        {
            const missingPort = messageOf(() => readServiceEnv({ [TOKEN_KEY]: TOKEN_VALUE }));
            const missingToken = messageOf(() => readServiceEnv({ [PORT_KEY]: '0' }));

            expect(missingPort).toContain(PORT_KEY);
            expect(missingPort).not.toContain(TOKEN_VALUE);
            expect(missingToken).toContain(TOKEN_KEY);
            expect(missingToken).not.toContain(TOKEN_VALUE);
        }
        {
            const badPort = 'not-a-port';
            const shortToken = 'too-short';
            const portMessage = messageOf(() => readServiceEnv({ [PORT_KEY]: badPort, [TOKEN_KEY]: TOKEN_VALUE }));
            const tokenMessage = messageOf(() => readServiceEnv({ [PORT_KEY]: '0', [TOKEN_KEY]: shortToken }));

            expect(portMessage).toContain(PORT_KEY);
            expect(tokenMessage).toContain(TOKEN_KEY);
            // Neither the token nor the malformed submission is echoed anywhere
            // (002 `token-handoff.md` F16; constitution: secrets never in logs).
            expect(portMessage).not.toContain(TOKEN_VALUE);
            expect(portMessage).not.toContain(badPort);
            expect(tokenMessage).not.toContain(TOKEN_VALUE);
            expect(tokenMessage).not.toContain(shortToken);
        }
    });
});
