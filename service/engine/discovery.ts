/** Managed-OpenCode discovery: the registry read plus pid-alive and ownerPid checks — re-run per attempt. */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord, readPositiveInt } from '../json.ts';

export const MANAGED_REGISTRY_ENV = 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY';

const DEFAULT_REGISTRY_RELATIVE_PATH = '.config/openchamber/managed-opencode';

const REGISTRY_FILE_SUFFIX = '.json';

const MAX_PORT = 65_535;

export interface ManagedEngine {
    readonly pid: number;
    readonly ownerPid: number;
    readonly port: number;
}

export type DiscoveryFailure =
    | 'registry-absent'
    | 'entry-unreadable'
    | 'pid-dead'
    | 'owner-mismatch';

export type DiscoveryOutcome =
    | { readonly ok: true; readonly engine: ManagedEngine }
    | { readonly ok: false; readonly cause: DiscoveryFailure };

const REGISTRY_ABSENT: DiscoveryFailure = 'registry-absent';
const ENTRY_UNREADABLE: DiscoveryFailure = 'entry-unreadable';
const PID_DEAD: DiscoveryFailure = 'pid-dead';
const OWNER_MISMATCH: DiscoveryFailure = 'owner-mismatch';

/** Whether a pid exists right now; `EPERM` means alive-but-not-ours, which still counts. */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (cause) {
        return cause instanceof Error && 'code' in cause && cause.code === 'EPERM';
    }
}

async function engineEntryOf(path: string): Promise<ManagedEngine | DiscoveryFailure> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return ENTRY_UNREADABLE;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return ENTRY_UNREADABLE;
    }

    if (!isRecord(parsed)) {
        return ENTRY_UNREADABLE;
    }

    const pid = readPositiveInt(parsed.pid);
    const ownerPid = readPositiveInt(parsed.ownerPid);
    const port = readPositiveInt(parsed.port);
    if (pid === null || ownerPid === null || port === null || port > MAX_PORT) {
        return ENTRY_UNREADABLE;
    }

    return { pid, ownerPid, port };
}

function entryVerdict(engine: ManagedEngine, selfPid: number): DiscoveryFailure | null {
    if (!processAlive(engine.pid)) {
        return PID_DEAD;
    }

    return engine.ownerPid === selfPid ? null : OWNER_MISMATCH;
}

// The first entry in file-name order wins, and the first failure is the one
// reported — so one stale file cannot hide behind a later one.
async function firstEngineOf(directory: string, names: readonly string[], selfPid: number): Promise<
    ManagedEngine | DiscoveryFailure | null
> {
    let firstCause: DiscoveryFailure | null = null;
    for (const name of names) {
        const entry = await engineEntryOf(join(directory, name));
        if (typeof entry === 'string') {
            firstCause ??= entry;
            continue;
        }

        const verdict = entryVerdict(entry, selfPid);
        if (verdict === null) {
            return entry;
        }

        firstCause ??= verdict;
    }

    return firstCause;
}

async function registryNames(directory: string): Promise<readonly string[] | null> {
    let entries: readonly string[];
    try {
        entries = await readdir(directory);
    } catch {
        return null;
    }

    return entries
        .filter((name) => name.endsWith(REGISTRY_FILE_SUFFIX))
        .toSorted((left, right) => left.localeCompare(right));
}

function registryDirectory(env: Readonly<Record<string, string | undefined>>): string | null {
    const override = env[MANAGED_REGISTRY_ENV];
    if (override !== undefined && override !== '') {
        return override;
    }

    const home = env.HOME;

    return home === undefined || home === '' ? null : resolve(home, DEFAULT_REGISTRY_RELATIVE_PATH);
}

// A live pid with no registry file is a discovery failure, never a guess: the
// port is per-boot random, so an unverified port could reach a different service.
export async function discoverEngine(input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly selfPid?: number | undefined;
}): Promise<DiscoveryOutcome> {
    const directory = registryDirectory(input.env);
    if (directory === null) {
        return { ok: false, cause: REGISTRY_ABSENT };
    }

    const names = await registryNames(directory);
    if (names === null || names.length === 0) {
        return { ok: false, cause: REGISTRY_ABSENT };
    }

    const verdict = await firstEngineOf(directory, names, input.selfPid ?? process.pid);

    return verdict === null || typeof verdict === 'string'
        ? { ok: false, cause: verdict ?? ENTRY_UNREADABLE }
        : { ok: true, engine: verdict };
}
