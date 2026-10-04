/**
 * The operator's policy change and the authorization gate's read-and-mint are
 * **one serialized pair** (003 FR-076; constitution II).
 *
 * The TOCTOU this suite exists to close is small and specific. The gate reads
 * the binding's live `allowedUsers` and mints a dispatch token inside the
 * **queue chain** ([`run-chain.ts`](../service/poll/run-chain.ts)); the bindings
 * grant used to run on the **prompt-observation chain** alone
 * ([`prompt-audit.ts`](../service/prompt-audit.ts)). Two mutexes, so the window
 * between the gate's read and the `runs.json` write that persists its token was
 * one bindings read wide: an operator tightening the list at T could have a
 * reserve that read the *old* list at T−ε persist a live token at T+ε, and
 * `host.startSession()` would then fire under a policy that had just been
 * revoked. The fix is **serialization**, not a second read.
 *
 * ## What is asserted, and why this shape
 *
 * "These two cannot interleave" is a claim about a **mechanism**, and a
 * mechanism is proved by making one side wait — not by running both to
 * completion and reading the order, which can only ever happen in the world
 * where they do *not* interleave. So each case parks one operation, issues the
 * other behind it, and asserts that the second **cannot reach its first
 * contended step** while the first holds the chain.
 *
 * That assertion is timing-independent: a grant that cannot enter the chain
 * cannot write `bindings.json` *however long the test waits*, so the bounded
 * drain below can only ever be generous, never wrong. A suite that instead
 * asserted "the write landed first" would pass in the broken world for the same
 * reason it passes here — the release ordering, not the locking.
 *
 * Two cases, one direction each, because a chain is wrong in one direction at a
 * time:
 *
 * 1. **The grant enters first** — the gate cannot read the policy until the
 *    operator's write is durable, so the reserve behind it is **refused**. This
 *    is the direction the security claim rests on, so it is also asserted by
 *    outcome.
 * 2. **The gate enters first** — the grant cannot write until the gate's read →
 *    mint → persist has finished, so an authorization already in flight is not
 *    retroactively voided by a change that lands after it began.
 *
 * Offline and host-free: the grant is the **real** route handler and the reserve
 * the **real** module, both over a temp store and a real account record.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountPath, BINDINGS_FILE } from '../service/accounts/store.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { RUNS_FILE } from '../service/poll/runs-document.ts';
import { createPollingView } from '../service/poll/view.ts';
import { BINDINGS_PATH, putBindingsRoute } from '../service/routes/bindings.ts';
import { createVerifyThrottle } from '../service/throttle.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { RouteContext, RouteRequest } from '../service/routes/types.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { offlineVerifier } from './support/github.ts';
import { CAPABILITIES } from './support/verify.ts';

/** Stamp every fixture uses; no test waits on a clock (NFR-112). */
const STAMP = '2026-10-03T09:00:00.000Z';

/** Lease and result window the fixtures configure, so a lease is live at {@link STAMP}. */
const WINDOW_MS = 120_000;

/** Binding every case in this suite dispatches through. */
const BINDING_ID = 'bnd-serialized';

/** Repository the binding watches. */
const REPOSITORY = 'acme/widget';

/** Account the binding is bound to. */
const ACCOUNT_ID = '77331';

/** Login the fixture account and the binding both carry. */
const ACCOUNT_LOGIN = 'octocat-serialized';

/** Project the dispatch targets. */
const PROJECT_ID = 'prj_42';

/** Mount holding the claim, as the panel's own host identity would be. */
const HOLDER = 'panel-serialized';

/** Issue number the one detection is about. */
const ISSUE = 7;

/**
 * The login the run is attributed to, and the login the operator replaces it
 * with when they tighten the list.
 *
 * The run's own actor is deliberately **absent** from the tightened list, so a
 * refusal is attributable to the tightening rather than to some incidental
 * reason the fixture happened to produce.
 */
const RUN_ACTOR = 'alice';
const TIGHTENED_ACTOR = 'mallory';

/** The outcome status an applied transition answers with. */
const APPLIED = 'applied';

/** The gate's refusal code (003 FR-077). */
const ACTOR_NOT_ALLOWED = 'actor-not-allowed';

/**
 * One observation point on a store operation, with an option to **hold** there.
 *
 * `reached` reports that the operation arrived; `park` decides whether it waits
 * for {@link Hook.release}. The two cases in this suite need both shapes: a
 * *holding* point to create the contention, and a *watching* point to assert the
 * contention exists.
 *
 * A hook holds only its **first** arrival. That is not a simplification, it is
 * what makes the hook usable at all: the grant reads `bindings.json` once
 * itself before writing it, so a hook that held every arrival would either catch
 * the wrong operation or deadlock the grant behind the very gate it is waiting
 * on. Counting arrivals rather than flagging a boolean lets a case state *how
 * many* times a point was reached, which is what the "cannot reach it at all"
 * assertion needs.
 */
interface Hook {
    /** Store-relative path this point watches. */
    readonly path: string;
    /** Which half of that file's traffic arrives here. */
    readonly operation: 'read' | 'write';
    /** `true` to hold the first arriving operation; `false` to only count. */
    readonly holds: boolean;
    /** Resolves once an operation has arrived at this point. */
    readonly reached: Promise<void>;
    /** How many operations have arrived here. */
    readonly arrivals: () => number;
    /** Lets a held operation continue. */
    readonly release: () => void;
    /** Call at this point; resolves once {@link Hook.release} is called. */
    readonly park: () => Promise<void>;
}

/** A promise plus the resolver that opens it. */
interface Latch {
    /** Settles when {@link Latch.open} is called. */
    readonly opened: Promise<void>;
    /** Opens the latch. */
    readonly open: () => void;
}

/**
 * Build one closed latch.
 *
 * `Promise.withResolvers` is ES2024 and this project targets ES2022, so the pair
 * is spelled here once rather than in every helper that needs one.
 *
 * @returns The latch, closed.
 */
function latch(): Latch {
    const resolvers: (() => void)[] = [];
    const opened = new Promise<void>((resolve) => {
        resolvers.push(resolve);
    });

    return {
        opened,
        open: () => {
            for (const resolve of resolvers) {
                resolve();
            }
        },
    };
}

/**
 * Arm one observation point, holding or watching as asked.
 *
 * @param input - Which file, which half of its traffic, and whether to hold.
 * @returns The hook, with `reached` still pending.
 */
function armHook(input: {
    /** Store-relative path to watch. */
    readonly path: string;
    /** Which half of that file's traffic to observe. */
    readonly operation: 'read' | 'write';
    /** `true` to hold the first arriving operation. */
    readonly holds: boolean;
}): Hook {
    const { path, operation, holds } = input;
    const arrived = latch();
    const released = latch();
    let count = 0;

    return {
        path,
        operation,
        holds,
        reached: arrived.opened,
        arrivals: () => count,
        release: released.open,
        park: async () => {
            count += 1;
            arrived.open();
            if (holds && count === 1) {
                await released.opened;
            }
        },
    };
}

/**
 * Let every already-scheduled in-memory continuation run, a bounded number of
 * times.
 *
 * **Not a sleep and not a deadline.** It advances the event loop through
 * macrotasks so promise chains that need no I/O settle. The assertions it serves
 * are timing-*independent* — a writer that cannot enter the chain cannot write
 * the file however many turns pass — so a slow machine can only make this drain
 * more generous, never wrong, and a fast one cannot make it miss anything that
 * was going to happen at all.
 *
 * @param turns - How many macrotask boundaries to cross.
 */
async function drainInMemoryWork(turns = 8): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }
}

/** Every store call this suite asserts on, in the order it completed. */
type StoreEvent = `read:${string}` | `write:${string}`;

let tempRoot = '';
let store: ServiceStore;

/** Capture sink; this suite asserts on locking, not on log text. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'debug', sink: (line) => LOG_LINES.push(line) });

/** Per-test setup: a fresh store, a live lease window, and no log noise. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-serialized-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, leaseMs: WINDOW_MS, resultDeadlineMs: WINDOW_MS });
    LOG_LINES.length = 0;
};

beforeEach(beforeEachWork1);

/** Per-test teardown. */
const afterEachWork1 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork1);

/**
 * Seed the one account the grant's existence check requires.
 *
 * Written straight to `accounts/<id>.json` because the grant's rule is *every
 * referenced account exists in the custody directory*; a fixture that satisfied
 * that with a real handoff would be asserting the verify route instead of the
 * locking.
 *
 * @returns A promise that settles once the record is durable.
 */
async function seedAccount(): Promise<void> {
    await store.writeJson(accountPath(ACCOUNT_ID), {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        verifiedAt: STAMP,
        errorReason: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        startingPrompt: null,
        credential: { token: `serialization-credential-${'p'.repeat(32)}`, kind: 'classic', verifiedAt: STAMP },
        scopeCheck: {
            checkedAt: STAMP,
            // Built from the capability list rather than spelled out: the wire
            // keys are the capabilities themselves, hyphenated.
            results: Object.fromEntries(CAPABILITIES.map((capability) => [capability, 'ok'])),
        },
        state: 'active',
        connectionState: 'connected',
    });
}

/**
 * The one binding row, with the allow-list the case under test submits.
 *
 * @param allowedUsers - The list the operator is saving.
 * @returns The row exactly as the panel's whole-file grant sends it.
 */
function bindingRow(allowedUsers: readonly string[]): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        triggers: { assignment: true, mention: true, reviewRequest: false },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
        allowedUsers: [...allowedUsers],
    };
}

/**
 * Write the stored bindings document directly.
 *
 * The *starting* policy is the fixture's, never a grant's: the subject of this
 * suite is the locking, and driving the setup through the route would put the
 * operation under test on both sides of it.
 *
 * @param allowedUsers - The list to store.
 * @returns A promise that settles once the document is durable.
 */
async function seedBindings(allowedUsers: readonly string[]): Promise<void> {
    await store.writeJson(BINDINGS_FILE, [bindingRow(allowedUsers)]);
}

/** The assignment detection the one run is enqueued from. */
function detection(): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber: ISSUE,
            issueTitle: `Issue ${ISSUE}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE}`,
            issueBodyExcerpt: 'body',
        },
        // Attributed the way an assignment is: GitHub records the issue author,
        // not who assigned it (002 FR-044).
        actorLogin: RUN_ACTOR,
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/**
 * Enqueue one detection and claim it, as the panel would.
 *
 * @param log - The logger the enqueue and the claim report through.
 * @returns The claim coordinates a reserve needs.
 */
async function seedAndClaim(log: ServiceLogger): Promise<{
    /** The claimed run's correlation id. */
    readonly correlationId: string;
    /** The lease the claim minted. */
    readonly leaseId: string;
}> {
    await enqueueEvents({ store, log, incoming: [createEvent(detection())] });
    const claimed = await claimPendingRuns({ store, log, holder: HOLDER, now: STAMP });
    const run = claimed.runs.find((candidate) => candidate.issueNumber === ISSUE);
    if (run?.lease === undefined) {
        throw new Error('the fixture run was not claimed');
    }

    return { correlationId: run.correlationId, leaseId: run.lease.leaseId };
}

/**
 * Wrap a store so one file's reads or writes are observable, and so every read
 * and write of a file this suite cares about is recorded in completion order.
 *
 * A decorator rather than a fake: the assertion is about **which real operation
 * reaches the disk first**, so both sides have to be the real ones.
 *
 * @param inner - The store every other call is delegated to.
 * @param hooks - The observation points to install.
 * @param events - The ordered record of `bindings.json` and `runs.json` traffic.
 * @returns The decorated store.
 */
function observedStore(input: {
    /** The real store underneath. */
    readonly inner: ServiceStore;
    /** The observation points to install; read live, so a case may add one later. */
    readonly hooks: Hook[];
    /** Ordered record of the traffic this suite asserts on. */
    readonly events: StoreEvent[];
}): ServiceStore {
    const { inner, hooks, events } = input;
    const recorded = new Set<string>([BINDINGS_FILE, RUNS_FILE]);
    const arriveAt = async (operation: 'read' | 'write', relativePath: string): Promise<void> => {
        for (const hook of hooks) {
            if (hook.path === relativePath && hook.operation === operation) {
                await hook.park();
            }
        }
    };

    return {
        dataDir: inner.dataDir,
        schemaVersion: inner.schemaVersion,
        readJson: async (relativePath, validate) => {
            if (recorded.has(relativePath)) {
                events.push(`read:${relativePath}`);
            }
            await arriveAt('read', relativePath);

            return await inner.readJson(relativePath, validate);
        },
        writeJson: async (relativePath, value) => {
            await arriveAt('write', relativePath);
            await inner.writeJson(relativePath, value);
            if (recorded.has(relativePath)) {
                events.push(`write:${relativePath}`);
            }
        },
        appendLine: async (relativePath, entry) => await inner.appendLine(relativePath, entry),
        writeLines: async (relativePath, entries) => await inner.writeLines(relativePath, entries),
        readLines: async (relativePath, parse) => await inner.readLines(relativePath, parse),
        listDir: async (relativePath) => await inner.listDir(relativePath),
        removeFile: async (relativePath) => await inner.removeFile(relativePath),
    };
}

/** The route context the grant needs; every member but the store is inert here. */
function routeContext(target: ServiceStore): RouteContext {
    return {
        store: target,
        dataDir: tempRoot,
        startedAt: 0,
        log: LOGGER,
        schemaVersion: target.schemaVersion,
        github: offlineVerifier(),
        throttle: createVerifyThrottle(),
        polling: createPollingView().view,
    };
}

/**
 * One whole-file grant through the **real** route handler.
 *
 * @param target - The store the grant writes through.
 * @param allowedUsers - The list the operator is saving.
 * @returns The response status.
 */
async function grant(target: ServiceStore, allowedUsers: readonly string[]): Promise<number> {
    const request: RouteRequest = {
        method: 'PUT',
        url: new URL(`http://127.0.0.1${BINDINGS_PATH}`),
        body: { bindings: [bindingRow(allowedUsers)] },
        params: {},
    };

    const response = await putBindingsRoute.handler(routeContext(target), request);

    return response.status;
}

/**
 * One reserve through the **real** module, as the panel's relay calls it.
 *
 * @param target - The store the gate reads and writes through.
 * @param claim - The claim coordinates the reserve presents.
 * @returns Whatever the reserve answered.
 */
async function reserve(target: ServiceStore, claim: {
    /** The claimed run's correlation id. */
    readonly correlationId: string;
    /** The lease the claim minted. */
    readonly leaseId: string;
}): Promise<Awaited<ReturnType<typeof reserveDispatch>>> {
    return await reserveDispatch({
        store: target,
        log: LOGGER,
        correlationId: claim.correlationId,
        leaseId: claim.leaseId,
        attempt: 1,
        now: STAMP,
    });
}

describe('the bindings grant and the authorization gate share one chain (003 FR-076)', () => {
    it('holds the gate out of the policy read while a grant is in flight', async () => {
        await seedAccount();
        await seedBindings([RUN_ACTOR]);
        const claim = await seedAndClaim(LOGGER);

        // The **grant** holds, parked at its write — inside the chain, after its
        // own read of the stored document. The gate's read is watched and is
        // installed only *after* the grant is parked, so the grant's own read can
        // never be mistaken for the gate's.
        const hooks: Hook[] = [];
        const events: StoreEvent[] = [];
        const grantWrite = armHook({ path: BINDINGS_FILE, operation: 'write', holds: true });
        const gateRead = armHook({ path: BINDINGS_FILE, operation: 'read', holds: false });
        hooks.push(grantWrite);
        const target = observedStore({ inner: store, hooks, events });

        const granted = grant(target, [TIGHTENED_ACTOR]);
        await grantWrite.reached;
        hooks.push(gateRead);

        const reserved = reserve(target, claim);
        await drainInMemoryWork();

        // **The claim under test.** The gate cannot read the policy while the
        // grant holds the chain, so it cannot reach this point at all — however
        // long the drain runs. With the grant on its own chain it would arrive
        // here, read the pre-tightening list, and mint a token against a policy
        // the operator had just revoked.
        expect(gateRead.arrivals(), 'the gate read the policy mid-grant').toBe(0);

        grantWrite.release();
        expect(await granted).toBe(200);
        const outcome = await reserved;

        // And the consequence the blocking guarantees: the reserve read the
        // **tightened** list and was refused, having minted nothing.
        expect(outcome.status).toBe('refused');
        expect(outcome.status === 'refused' ? outcome.refusal.code : '').toBe(ACTOR_NOT_ALLOWED);
        expect(events.indexOf(`write:${RUNS_FILE}`), 'a refused reserve persists nothing').toBe(-1);
        // The order behind that verdict: the operator's write is durable before
        // the gate ever reads the document.
        expect(gateRead.arrivals(), 'the gate read the policy exactly once, afterwards').toBe(1);
        expect(events.lastIndexOf(`read:${BINDINGS_FILE}`))
            .toBeGreaterThan(events.indexOf(`write:${BINDINGS_FILE}`));
    });

    it('lets a reserve that entered first finish before the grant lands', async () => {
        await seedAccount();
        await seedBindings([RUN_ACTOR]);
        const claim = await seedAndClaim(LOGGER);

        // The **gate** holds, parked at its policy read — inside the chain, having
        // already read the policy in force.
        const hooks: Hook[] = [];
        const events: StoreEvent[] = [];
        const gateRead = armHook({ path: BINDINGS_FILE, operation: 'read', holds: true });
        hooks.push(gateRead);
        const target = observedStore({ inner: store, hooks, events });

        const reserved = reserve(target, claim);
        await gateRead.reached;

        const granted = grant(target, [TIGHTENED_ACTOR]);
        // The mirror direction, asserted as the **order** the chain guarantees rather
        // than as a blocking. "Did not happen within N event-loop turns" is not a
        // fact about locking — the store write this case is watching is a
        // filesystem round trip — so this direction cannot be *proved* the way the
        // case above is, and pretending otherwise would buy a flaky test. What it
        // does pin is the FIFO consequence: the grant's write lands after the gate
        // has persisted its decision, never inside it. The discriminating negative
        // lives in the case above, where the watched step needs no I/O.
        await drainInMemoryWork();

        gateRead.release();
        const outcome = await reserved;
        expect(await granted).toBe(200);

        // The gate read the policy that was in force when it began, so it was
        // admitted — an authorization already in flight is not retroactively
        // voided by a change that lands after it started.
        expect(outcome.status).toBe(APPLIED);
        expect(events.indexOf(`write:${RUNS_FILE}`))
            .toBeLessThan(events.indexOf(`write:${BINDINGS_FILE}`));
    });
});
