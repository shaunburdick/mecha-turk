/** Layered token acquisition: env first, then the verified pid's `/proc` environ — the password is never stored. */

import { readFile } from 'node:fs/promises';
import { processAlive } from './discovery.ts';
import type { ManagedEngine } from './discovery.ts';

/** Read per attempt, never stored. */
export const PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

export interface TokenSource {
    readonly env: Readonly<Record<string, string | undefined>>;
    procEnviron(pid: number): string | null | Promise<string | null>;
}

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

/** Which layer refused; credential-free by construction. */
export type TokenFailure =
    | 'acquisition-failed'
    | 'pid-dead'
    | 'owner-mismatch';

export type TokenOutcome =
    | { readonly ok: true; readonly password: string }
    | { readonly ok: false; readonly cause: TokenFailure };

function environValueOf(environ: string, name: string): string | null {
    for (const entry of environ.split('\0')) {
        if (entry.startsWith(`${name}=`)) {
            const value = entry.slice(name.length + 1);

            return value === '' ? null : value;
        }
    }

    return null;
}

// The env layer wins outright; only then is `/proc` consulted — reading another
// process's environment is exactly what the pid-alive and ownerPid checks authorize.
export async function acquireToken(input: {
    readonly source: TokenSource;
    readonly engine: ManagedEngine;
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
