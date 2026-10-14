/**
 * Managed-OpenCode discovery: the registry read plus the pid-alive and ownerPid
 * checks, re-run per attempt because the engine's port is per-boot random
 * (FR-104 span A; FR-105 span D; research §2.6).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord, readPositiveInt } from '../json.ts';

/** Env var pointing discovery at an alternate registry directory (tests' seam). */
export const MANAGED_REGISTRY_ENV = 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY';

/** Where the host writes the registry when no override names a directory. */
const DEFAULT_REGISTRY_RELATIVE_PATH = '.config/openchamber/managed-opencode';

/** Registry file suffix; the host names each file after the pid it carries. */
const REGISTRY_FILE_SUFFIX = '.json';

/** Largest legal TCP port number; the registry names the engine's loopback port. */
const MAX_PORT = 65_535;

/** One registry entry the adapter verified: the engine's pid, owner, and port. */
export interface ManagedEngine {
    /** Engine process the entry names; also the file's own name. */
    readonly pid: number;
    /** Owner process the entry names; verified against this process. */
    readonly ownerPid: number;
    /** Loopback port the engine answers on — per-boot random. */
    readonly port: number;
}

/** Why one discovery attempt found no engine to talk to. */
export type DiscoveryFailure =
    /** No registry directory, no readable entries in it — never a guessed port. */
    | 'registry-absent'
    /** An entry file exists but does not parse into pid/ownerPid/port. */
    | 'entry-unreadable'
    /** The named engine process is not alive. */
    | 'pid-dead'
    /** The entry's owner is not this process, so it is not our engine. */
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

/** Read one registry entry file into a verified engine, or a failure cause. */
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

/** Judge one entry against liveness and ownership. */
function entryVerdict(engine: ManagedEngine, selfPid: number): DiscoveryFailure | null {
    if (!processAlive(engine.pid)) {
        return PID_DEAD;
    }

    return engine.ownerPid === selfPid ? null : OWNER_MISMATCH;
}

/**
 * The first entry, in file-name order, that survives pid-alive and ownerPid —
 * or the first entry's failure, so one stale file cannot hide behind a later
 * one. An empty list answers `null`, which the caller reports as
 * `registry-absent`: a live pid with no registry file is a discovery failure,
 * never a guess (research §2.6).
 */
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

/** The registry file names in one directory, or `null` when there are none to read. */
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

/** The registry directory this environment names, or `null` when it names none. */
function registryDirectory(env: Readonly<Record<string, string | undefined>>): string | null {
    const override = env[MANAGED_REGISTRY_ENV];
    if (override !== undefined && override !== '') {
        return override;
    }

    const home = env.HOME;

    return home === undefined || home === '' ? null : resolve(home, DEFAULT_REGISTRY_RELATIVE_PATH);
}

/**
 * Discover the managed engine: every registry entry is judged in file-name
 * order and the first one that survives pid-alive and ownerPid wins. A live
 * pid with no registry file is a discovery failure, never a guess — the port
 * is per-boot random, so an unverified port could reach a different service
 * entirely (research §2.6).
 */
export async function discoverEngine(input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Process the ownerPid check compares against; defaults to this one. */
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
