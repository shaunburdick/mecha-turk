/**
 * Layered engine-token acquisition: the operator's env first, then the
 * registry pid's `/proc/<pid>/environ`, pid-alive and ownerPid verified. Any
 * failure classifies as an acquisition failure — fallback, never a hard stop —
 * and the password is never persisted, logged, or written anywhere
 * (FR-105 span D; invariant 9; spec §6).
 */

import { readFile } from 'node:fs/promises';
import { processAlive } from './discovery.ts';
import type { ManagedEngine } from './discovery.ts';

/** Password env var the engine's Basic auth uses; read per attempt, never stored. */
export const PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

/** Environment overlay plus a `/proc` reader; injectable so each layer fails on demand. */
export interface TokenSource {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** NUL-separated `/proc/<pid>/environ` content, or `null` when unreadable. */
    procEnviron(pid: number): string | null | Promise<string | null>;
}

/** The live layers: the real process environment and the real `/proc` filesystem. */
export function systemTokenSource(
    env: Readonly<Record<string, string | undefined>>,
): TokenSource {
    return {
        env,
        procEnviron: async (pid) => {
            try {
                return await readFile(`/proc/${pid}/environ`, 'utf8');
            } catch {
                return null;
            }
        },
    };
}

/** Which layer of the chain refused; credential-free by construction. */
export type TokenFailure =
    /** No env value, and the `/proc` chain answered with nothing usable. */
    | 'acquisition-failed'
    /** The registry's engine pid is not alive, so its environ is not ours to read. */
    | 'pid-dead'
    /** The registry entry's owner is not this process. */
    | 'owner-mismatch';

export type TokenOutcome =
    | { readonly ok: true; readonly password: string }
    | { readonly ok: false; readonly cause: TokenFailure };

/** Read one `NAME=value` entry out of a NUL-separated `/proc` environ block. */
function environValueOf(environ: string, name: string): string | null {
    for (const entry of environ.split('\0')) {
        if (entry.startsWith(`${name}=`)) {
            const value = entry.slice(name.length + 1);

            return value === '' ? null : value;
        }
    }

    return null;
}

/**
 * Acquire the engine password for one attempt: the env layer wins outright
 * when it carries a value, and only then is the `/proc` chain consulted —
 * reading another process's environment is exactly the step the pid-alive and
 * ownerPid checks exist to authorize (research §2.6).
 */
export async function acquireToken(input: {
    readonly source: TokenSource;
    readonly engine: ManagedEngine;
    /** Process the ownerPid check compares against; defaults to this one. */
    readonly selfPid?: number | undefined;
}): Promise<TokenOutcome> {
    const fromEnv = input.source.env[PASSWORD_ENV];
    if (fromEnv !== undefined && fromEnv !== '') {
        return { ok: true, password: fromEnv };
    }

    const selfPid = input.selfPid ?? process.pid;
    if (!processAlive(input.engine.pid)) {
        return { ok: false, cause: 'pid-dead' };
    }

    if (input.engine.ownerPid !== selfPid) {
        return { ok: false, cause: 'owner-mismatch' };
    }

    const environ = await input.source.procEnviron(input.engine.pid);
    const password = environ === null ? null : environValueOf(environ, PASSWORD_ENV);

    return password === null ? { ok: false, cause: 'acquisition-failed' } : { ok: true, password };
}
