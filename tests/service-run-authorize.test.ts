/**
 * The authorization routes: reserve, result, abandon, and block report (003
 * FR-020 – FR-023, FR-026, FR-028, FR-040, FR-042; contract §1–§4; T-011, T-012,
 * T-013).
 *
 * Driven through the **real loopback service**, so what is asserted is the wire a
 * panel actually gets: statuses, envelopes, and the runs left behind. The pure
 * decisions are covered where they live; what this suite owns is that the
 * decision and the store agree, and that the things 003 exists to make impossible
 * are impossible *through the wire*:
 *
 * - **One live authorization.** A second reserve on a run that already holds one
 *   is refused naming the reservation, and one on a run with a session is refused
 *   naming that session (FR-022, AC-112).
 * - **The staleness matrix**, in full: unknown token, expired lease, superseded
 *   attempt, identical repeat, conflicting repeat, unconsumed from `starting`,
 *   unconsumed from `unconfirmed` (FR-025, plan D7).
 * - **A `problem` never yields `dispatched`** anywhere in the answer or the
 *   stored row (FR-040, AC-113).
 * - **Idempotency ×10**: one `dispatch.result` and nine `dispatch.duplicate-report`
 *   rows, state byte-stable (NFR-102, contract invariant 3).
 * - **No audit row carries a token value** — the fingerprint rule re-checked on
 *   this wave's rows, since these are the rows that *most* want to name one.
 *
 * Offline: temp stores, injected service-clock stamps, no sleeping, no network,
 * no host.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { buildDispatchToken } from '../service/poll/run-key.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { blockDispatch } from '../service/poll/dispatch-block.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { sweepOnce } from '../service/poll/sweep.ts';
import { emptyRunsDocument, readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { openStore } from '../service/store/index.ts';
import {
    ABANDON_PATH as ABANDON_ROUTE,
    BLOCKED_PATH as BLOCKED_ROUTE,
    DISPATCHED_PATH as DISPATCHED_ROUTE,
    RESERVE_PATH as RESERVE_ROUTE,
} from '../service/routes/dispatch.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { startTestService } from './support/service.ts';

/** Stamp every fixture uses; no test ever waits on a clock. */
const STAMP = '2026-09-28T08:00:00.000Z';
/** Past every fixture's lease expiry, so an expired lease is genuinely expired. */
const AFTER_LEASE = '2026-09-28T09:00:00.000Z';
/** Lease duration the fixtures configure; half the documented maximum. */
const LEASE_MS = 45_000;
const BINDING_ID = 'bnd-authorize';
const REPOSITORY = 'acme/widget';
const ACCOUNT_ID = '77331';
const HOLDER = 'panel-authorize';
/** A well-formed correlation id, for the route-level validation probes. */
const RUN_ID = `mt-run-${'0'.repeat(24)}`;
/** A well-formed lease id, for the route-level validation probes. */
const LEASE = `lse-${'a'.repeat(24)}`;
/** A well-formed dispatch token, for the route-level validation probes. */
const TOKEN = `dtk-${'b'.repeat(32)}`;
/** A well-formed token no run ever recorded, for the staleness probes. */
const FORGED_TOKEN = `dtk-${'c'.repeat(32)}`;
const ASSIGNMENT = 'assignment';
const FAILED = 'failed';
const UNCONFIRMED = 'unconfirmed';
const STARTING = 'starting';
const BLOCKED_ROW = 'run.blocked';
const REFUSED_ROW = 'dispatch.refused';
const RESERVED_ROW = 'dispatch.reserved';
const RESULT_ROW = 'dispatch.result';
const DUPLICATE_ROW = 'dispatch.duplicate-report';
const ABANDONED_ROW = 'dispatch.abandoned';
/** The first of the four declared guard causes (data-model §2.2). */
const PROJECT_MISSING = 'project-missing';
/** The one blocked cause the service can corroborate itself (contract §6). */
const BINDING_MISSING = 'binding-missing';
/** Why the abandon fixture says its reserved attempt produced no session. */
const ABANDON_REASON = 'project unresolved after reserve';
/** The store file the degraded-trail fixtures make unwritable. */
const AUDIT_FILE = 'audit.ndjson';
/** The error those fixtures raise instead of appending a lifecycle row. */
const APPEND_REFUSED = 'append refused by the fixture';

/** The outcome status every refusal carries. */
const REFUSED = 'refused';
/** The outcome status every applied transition carries. */
const APPLIED = 'applied';
/** The outcome status a repeated report carries. */
const DUPLICATE = 'duplicate';
/** The problem a fixture reports when the host call returned no session. */
const BOOTSTRAP_FAILED = 'bootstrap-failed';
/** The message a fixture raises when the reserve it depends on was refused. */
const RESERVE_DID_NOT_APPLY = 'reserve did not apply';
/** The wire code a lease or token staleness verdict carries. */
const STALE_LEASE = 'stale-lease';
/** The wire code a second authorization on a live run carries. */
const ALREADY_RESERVED = 'already-reserved';
/** The wire code a state verdict carries, whatever the operation. */
const INVALID_TRANSITION = 'invalid-transition';
/** The account login the fixtures report under. */
const ACCOUNT_LOGIN = 'octocat';
/** The project id the fixtures snapshot. */
const PROJECT_ID = 'prj_42';

const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'debug', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-authorize-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    await store.writeJson('config.json', { ...DEFAULT_CONFIG, leaseMs: LEASE_MS, resultDeadlineMs: LEASE_MS });
    LOG_LINES.length = 0;
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/** Build an assignment detection for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        kind: ASSIGNMENT,
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: `body ${issueNumber}`,
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/**
 * The lease a hand-seeded run carries, where its state calls for one.
 *
 * Hand-built only where the state is asserted directly; every lease a panel
 * would hold is minted by the real claim (T-040e's parser refuses an id or
 * provenance this build could never have written).
 *
 * @param state - The state being seeded.
 * @returns The lease, or `null` for a state that holds none.
 */
function leaseFor(state: Run['state']): Run['lease'] {
    return state === 'claimed' || state === STARTING
        ? {
            leaseId: `lse-${'a'.repeat(24)}`,
            attempt: 1,
            holder: HOLDER,
            issuedAt: STAMP,
            expiresAt: '2026-09-28T08:00:45.000Z',
            provenance: 'panel',
        }
        : null;
}

/**
 * A live lease for a state that does not normally hold one.
 *
 * The parser accepts it — it requires only that a lease's attempt match the
 * run's — and it is the shape the `invalid-transition` branches exist for: a run
 * whose outcome moved on while a panel still held a valid claim.
 *
 * @returns A lease that is live at {@link STAMP}.
 */
function liveLease(): Run['lease'] {
    return {
        leaseId: `lse-${'b'.repeat(24)}`,
        attempt: 1,
        holder: HOLDER,
        issuedAt: STAMP,
        expiresAt: '2026-09-28T08:00:45.000Z',
        provenance: 'panel',
    };
}


/** Enqueue detections, one per issue. */
async function seed(...snapshots: readonly EventSnapshot[]): Promise<void> {
    await enqueueEvents({ store, log: LOGGER, incoming: snapshots.map(createEvent) });
}

/** Claim the run waiting for one issue, as the panel would. */
async function claimRun(issueNumber: number): Promise<{ readonly correlationId: string; readonly leaseId: string }> {
    const claimed = await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: STAMP });
    const [run] = claimed.runs.filter((candidate) => candidate.issueNumber === issueNumber);
    if (run === undefined) {
        throw new Error(`the run for issue ${issueNumber} was not claimed`);
    }

    return { correlationId: run.correlationId, leaseId: run.lease.leaseId };
}

/** Read one stored run back. */
async function readRun(correlationId: string): Promise<Run> {
    const document = await readRunsDocument({ store, log: LOGGER });
    const run = document.runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('run is no longer stored');
    }

    return run;
}

/** Read every audit row the trail holds, with seeding settled. */
async function trail(): Promise<ReturnType<typeof readAuditEntries>> {
    await readRunsDocument({ store, log: LOGGER });

    return await readAuditEntries(store);
}

/** The details of every row of one type. */
async function rowsOf(eventType: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];

    for (const entry of await trail()) {
        if (entry.eventType === eventType) {
            rows.push(entry.details);
        }
    }

    return rows;
}

/**
 * Reserve one run through the real route module, as the panel would.
 *
 * Defaults to {@link STAMP} — the instant the claim leased at — because these are
 * *injected*-clock fixtures (NFR-112): letting the operation read the real clock
 * would make every lease look expired the moment the suite's date differs from
 * the fixture's, which is a flaky test rather than a real failure.
 *
 * @param input - The claim coordinates and the stamp to judge them at.
 * @returns Whatever the reserve answered.
 */
async function reserve(input: {
    readonly correlationId: string;
    readonly leaseId: string;
    readonly attempt?: number;
    readonly now?: string;
}) {
    return await reserveDispatch({
        store,
        log: LOGGER,
        correlationId: input.correlationId,
        leaseId: input.leaseId,
        attempt: input.attempt ?? 1,
        now: input.now ?? STAMP,
    });
}

/**
 * Report one outcome through the real route module.
 *
 * @param input - The run, token, and outcome being reported.
 * @returns Whatever the report answered.
 */
async function report(input: {
    readonly correlationId: string;
    readonly dispatchToken: string;
    readonly attempt?: number;
    readonly operation?: 'result' | 'abandon';
    readonly sessionId?: string | null;
    readonly problem?: string | null;
    readonly reason?: string | null;
    readonly now?: string;
}) {
    const abandoned = input.operation === 'abandon';

    return await reportDispatch({
        store,
        log: LOGGER,
        correlationId: input.correlationId,
        dispatchToken: input.dispatchToken,
        attempt: input.attempt ?? 1,
        operation: abandoned ? 'abandon' : 'result',
        outcome: abandoned
            ? { attemptOutcome: 'abandoned', sessionId: null, reason: input.reason ?? '' }
            : {
                attemptOutcome: input.sessionId === undefined || input.sessionId === null ? FAILED : 'dispatched',
                sessionId: input.sessionId ?? null,
                reason: input.problem ?? null,
            },
        // Injected clock, for the same reason as the reserve helper.
        now: input.now ?? STAMP,
    });
}

/** The header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** The path parameter every run-scoped route captures. */
const CORRELATION_PARAM = ':correlationId';

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/**
 * The concrete path one run-scoped route answers on.
 *
 * @param pattern - The route's declared pattern.
 * @returns The same path with its parameter bound to {@link RUN_ID}.
 */
function routePath(pattern: string): string {
    return pattern.replace(CORRELATION_PARAM, RUN_ID);
}

/** The claim coordinates a reserve or a block report needs. */
interface Claim {
    /** The run the claim leased. */
    readonly correlationId: string;
    /** The lease it was taken under. */
    readonly leaseId: string;
}

/**
 * Seed one issue, claim it, and hand back the coordinates a reserve needs.
 *
 * @param issueNumber - Issue to detect and claim.
 * @returns The claimed run's correlation id and the lease it was claimed under.
 */
async function seedAndClaim(issueNumber: number): Promise<Claim> {
    await seed(assignment(issueNumber));

    return await claimRun(issueNumber);
}

/**
 * Block one run through the real route module.
 *
 * @param input - The claim coordinates, cause, and detail.
 * @returns Whatever the block answered.
 */
async function block(input: {
    /** The claim coordinates the guard refused under. */
    readonly claim: { readonly correlationId: string; readonly leaseId: string };
    /** Which of the four documented causes fired. */
    readonly blockedReason: string;
    /** The cause in the operator's words. */
    readonly detail: string;
    /** In-panel guidance offered alongside the block. */
    readonly guidance?: string | null;
}) {
    return await blockDispatch({
        store,
        log: LOGGER,
        correlationId: input.claim.correlationId,
        leaseId: input.claim.leaseId,
        attempt: 1,
        blockedReason: input.blockedReason,
        detail: input.detail,
        guidance: input.guidance ?? null,
        // Injected clock, for the same reason as the reserve helper.
        now: STAMP,
    });
}

/**
 * Seed one run directly in a state, with the record that state implies.
 *
 * @param issueNumber - Issue to build the run from.
 * @param state - The state to seed.
 * @returns The seeded run.
 */
async function seedRunInState(input: {
    /** Issue to build the run from. */
    readonly issueNumber: number;
    /** The state to seed. */
    readonly state: Run['state'];
    /** Whether to keep a live lease on a state that does not normally hold one. */
    readonly liveLease?: boolean;
}): Promise<Run> {
    const { issueNumber, state } = input;
    const delivery = createEvent(assignment(issueNumber));
    const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: [delivery], now: STAMP });
    const created = planned.created[0];
    if (created === undefined) {
        const subjects = Object.keys(planned.document.subjects).join(',');
        throw new Error(
            `seed run was not created for issue ${issueNumber} state ${state} `
            + `keys ${subjects} runs ${planned.document.runs.length}`,
        );
    }

    const holdsLease = input.liveLease === true || leaseFor(state) !== null;
    const run: Run = {
        ...created,
        state,
        stateReason: `seeded as ${state}`,
        lease: holdsLease ? leaseFor(state) ?? liveLease() : null,
        reservation: state === STARTING
            ? {
                dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
                attempt: 1,
                reservedAt: STAMP,
                resultDeadlineAt: '2026-09-28T08:01:00.000Z',
                consumed: false,
            }
            : null,
    };
    await writeRunsDocument({
        store,
        log: LOGGER,
        document: {
            ...planned.document,
            subjects: { [`github|${ACCOUNT_ID}|${REPOSITORY}|issue|${issueNumber}`]: 1 },
            runs: [run],
        },
    });

    return run;
}

/**
 * Seed one run that already produced a session.
 *
 * Deliberately **leaseless**: an applied result clears the lease, so this is the
 * shape a dispatched run actually has, and the reserve refusal the fixture
 * reaches has to survive having no lease to ride on (T-042e, AC-112).
 *
 * @param issueNumber - Issue to build the run from.
 * @param sessionId - The session the run recorded.
 * @returns The seeded run.
 */
async function seedRunWithSession(input: {
    /** Issue to build the run from. */
    readonly issueNumber: number;
    /** The session the run recorded. */
    readonly sessionId: string;
}): Promise<Run> {
    const { issueNumber, sessionId } = input;
    const delivery = createEvent(assignment(issueNumber));
    const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: [delivery], now: STAMP });
    const created = planned.created[0];
    if (created === undefined) {
        throw new Error('seed run was not created');
    }

    const run: Run = {
        ...created,
        state: 'dispatched',
        stateReason: `session ${sessionId} created`,
        lease: null,
        session: {
            sessionId,
            attachmentId: created.attachmentId,
            dispatchedAt: STAMP,
            title: '',
            sourceUrl: created.sourceReferences[0]?.sourceUrl ?? '',
            worktree: null,
        },
        attempts: [{
            attempt: 1,
            dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
            reservedAt: STAMP,
            outcome: 'dispatched',
            sessionId,
            reason: null,
            resultReportedAt: STAMP,
        }],
    };
    await writeRunsDocument({
        store,
        log: LOGGER,
        document: {
            ...planned.document,
            subjects: { [`github|${ACCOUNT_ID}|${REPOSITORY}|issue|${issueNumber}`]: 1 },
            runs: [run],
        },
    });

    return run;
}

/** The lease id a seeded run carries, for a refusal path that presents one. */
function leaseOf(run: Run): string {
    return run.lease?.leaseId ?? `lse-${'a'.repeat(24)}`;
}

describe('T-011 reserve mints exactly one live authorization (FR-020, FR-021)', () => {
    it('moves the run to starting, records the reservation, and answers the token', async () => {
        const claimed = await seedAndClaim(1);

        const outcome = await reserve(claimed);

        expect(outcome.status).toBe(APPLIED);
        if (outcome.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const stored = await readRun(claimed.correlationId);
        // Constraint: the state move and the reservation are one write. A `claimed`
        // run holding a reservation would match neither sweep rule and strand.
        expect(stored.state).toBe(STARTING);
        expect(stored.reservation).toMatchObject({ attempt: 1, consumed: false });
        expect(stored.reservation?.dispatchToken).toBe(outcome.dispatchToken);
        // The token rides on the lease it was authorized under (contract §1).
        expect(outcome.tokenExpiresAt).toBe(stored.lease?.expiresAt);
    });

    it('derives the token from the run key and attempt, byte-for-byte', async () => {
        const claimed = await seedAndClaim(2);
        const outcome = await reserve(claimed);
        if (outcome.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const stored = await readRun(claimed.correlationId);
        expect(outcome.dispatchToken).toBe(buildDispatchToken(stored.runKey, stored.attempt));
        expect(outcome.dispatchToken).toMatch(/^dtk-[0-9a-f]{32}$/);
    });

    it('writes a dispatch.reserved row naming the lease, attempt, and attachment', async () => {
        const claimed = await seedAndClaim(3);

        await reserve(claimed);

        const [row] = await rowsOf(RESERVED_ROW);
        expect(row).toMatchObject({ leaseId: claimed.leaseId, attempt: 1, attachmentId: claimed.correlationId });
    });

    it('arms the result deadline from the configured window', async () => {
        const claimed = await seedAndClaim(4);

        await reserve(claimed);

        const stored = await readRun(claimed.correlationId);
        expect(Date.parse(stored.reservation?.resultDeadlineAt ?? '') - Date.parse(STAMP)).toBe(LEASE_MS);
    });

    it('answers 404 for a run this service does not have', async () => {
        const outcome = await reserve({
            correlationId: 'mt-run-000000000000000000000000',
            leaseId: 'lse-000000000000000000000000',
        });

        expect(outcome.status).toBe('not-found');
    });
});

describe('T-011 the reserve refusal matrix (FR-022, AC-109, AC-112)', () => {
    it('refuses an expired lease as stale, without minting anything', async () => {
        const claimed = await seedAndClaim(5);

        const outcome = await reserve({ ...claimed, now: AFTER_LEASE });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe('claimed');
        expect(stored.reservation).toBeNull();
        expect(await rowsOf(RESERVED_ROW)).toEqual([]);
    });

    it('refuses a lease belonging to another attempt', async () => {
        const claimed = await seedAndClaim(6);

        const outcome = await reserve({ ...claimed, attempt: 7 });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
    });

    it('refuses a lease this run never held', async () => {
        const claimed = await seedAndClaim(7);

        const outcome = await reserve({ ...claimed, leaseId: `lse-${'f'.repeat(24)}` });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
    });

    it('refuses a second reserve as already-reserved, naming attempt and deadline', async () => {
        const claimed = await seedAndClaim(8);
        await reserve(claimed);
        const authorized = await readRun(claimed.correlationId);

        const outcome = await reserve(claimed);

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(ALREADY_RESERVED);
        // FR-022's "names the reservation": an operator reading this can tell
        // which authorization is already outstanding.
        expect(refusal?.message).toContain('attempt 1');
        expect(refusal?.message).toContain(authorized.reservation?.resultDeadlineAt ?? '');
        // One live authorization: exactly one reservation survives.
        const afterDuplicate = await readRun(claimed.correlationId);
        expect(afterDuplicate.reservation?.dispatchToken).toBe(authorized.reservation?.dispatchToken);
    });

    it('refuses a leaseless dispatched run by naming the session, not the absent lease', async () => {
        // AC-112 on the natural path: a dispatched run holds **no lease** — an
        // applied result clears it — so the session check has to be asked before
        // the lease check or this verdict is unreachable and every such run
        // answers `stale-lease` instead (FR-022). The fixture is leaseless for
        // exactly that reason; a live lease here would have hidden the ordering
        // it exists to pin.
        const run = await seedRunWithSession({ issueNumber: 9, sessionId: 'ses_already' });
        expect(run.lease).toBeNull();

        const outcome = await reserve({ correlationId: run.correlationId, leaseId: leaseOf(run) });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe('already-dispatched');
        // AC-112 in full: the refusal names the session.
        expect(refusal?.message).toContain('ses_already');
        const refusals = await rowsOf(REFUSED_ROW);
        expect(refusals.some((row) => row.code === 'already-dispatched')).toBe(true);
    });

    it('refuses a live-lease run that is not claimed as invalid-transition, naming the state', async () => {
        // Contract §1's verdict order is session → lease → reservation → state
        // (T-042e), so `invalid-transition` is reachable only for a run whose
        // lease is still live while its state is not `claimed`. The parser
        // accepts exactly that (it requires only that a lease's attempt match the
        // run's), which makes it the real shape this branch exists for: a run
        // that failed or was resolved while a panel still held its claim.
        for (const [index, state] of ([FAILED, UNCONFIRMED] as const).entries()) {
            const run = await seedRunInState({ issueNumber: 20 + index, state, liveLease: true });

            const outcome = await reserve({ correlationId: run.correlationId, leaseId: leaseOf(run) });

            expect(outcome.status, `${state} must be refused`).toBe(REFUSED);
            const refusal = outcome.status === REFUSED ? outcome.refusal : null;
            expect(refusal?.code).toBe(INVALID_TRANSITION);
            expect(refusal?.message).toContain(state);
        }
    });

    it('refuses a leaseless run as stale, because the session check finds no session first', async () => {
        // The other half of the ordering, and the honest answer: a run in
        // `failed`, `unconfirmed`, or `dead-lettered` holds no lease, so there is
        // nothing for a reserve to ride on regardless of its state. The session
        // check runs before the lease check now (T-042e), and none of these
        // fixtures records a session — which is what leaves the lease verdict as
        // the first one that can fire.
        for (const [index, state] of (['pending', FAILED, UNCONFIRMED, 'dead-lettered'] as const).entries()) {
            const run = await seedRunInState({ issueNumber: 24 + index, state });

            const outcome = await reserve({ correlationId: run.correlationId, leaseId: leaseOf(run) });

            expect(outcome.status, `${state} must be refused`).toBe(REFUSED);
            expect(outcome.status === REFUSED ? outcome.refusal.code : '').toBe(STALE_LEASE);
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe(state);
        }
    });

    it('writes exactly one dispatch.refused row per refusal, naming the operation', async () => {
        const claimed = await seedAndClaim(10);
        await reserve({ ...claimed, now: AFTER_LEASE });
        await reserve(claimed);
        await reserve(claimed);

        const entries = await trail();
        const refusedRows = entries.filter((entry) => entry.eventType === REFUSED_ROW);
        expect(refusedRows).toHaveLength(2);
        for (const refusal of refusedRows) {
            // `priorState` is the state the run was in *when refused*, so the two
            // rows differ: the stale one refused a `claimed` run, and the
            // already-reserved one refused a run the first reserve had started.
            expect(refusal.details).toMatchObject({ operation: 'reserve', attempt: 1 });
            expect(refusal.correlationId).toBe(claimed.correlationId);
            expect(refusal.actorSource).toBe('service');
        }
        expect(refusedRows.map((entry) => entry.details.code)).toEqual([STALE_LEASE, ALREADY_RESERVED]);
        expect(refusedRows.map((entry) => entry.details.priorState)).toEqual(['claimed', STARTING]);
    });
});

describe('T-012 result settles the reservation in one write (FR-040, constraint)', () => {
    it('records a session as dispatched, consumed, with a session ref', async () => {
        const claimed = await seedAndClaim(11);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_created',
        });

        expect(outcome.status).toBe(APPLIED);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe('dispatched');
        // Constraint: the outcome and the consumed reservation are one write, so a
        // run can never hold a token that authorizes nothing while looking live.
        expect(stored.reservation?.consumed).toBe(true);
        expect(stored.session?.sessionId).toBe('ses_created');
        expect(stored.lease).toBeNull();
        expect(stored.attempts.at(-1)).toMatchObject({ outcome: 'dispatched', sessionId: 'ses_created' });
    });

    it('records a problem as failed and never as dispatched (FR-040, AC-113)', async () => {
        const claimed = await seedAndClaim(12);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            problem: BOOTSTRAP_FAILED,
        });

        expect(outcome.status).toBe(APPLIED);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe(FAILED);
        expect(stored.state).not.toBe('dispatched');
        expect(stored.session).toBeNull();
        expect(stored.stateReason).toBe(BOOTSTRAP_FAILED);
        expect(stored.reservation?.consumed).toBe(true);
    });

    it('writes a dispatch.result row whose decision is failed for a problem', async () => {
        const claimed = await seedAndClaim(13);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            problem: BOOTSTRAP_FAILED,
        });

        const [row] = await rowsOf(RESULT_ROW);
        expect(row).toMatchObject({ attempt: 1, failureReason: BOOTSTRAP_FAILED });
        const entries = await trail();
        const resultRow = entries.find((entry) => entry.eventType === RESULT_ROW);
        expect(resultRow?.decision).toBe(FAILED);
    });

    it('leaves the run retryable after a problem, not wedged', async () => {
        const claimed = await seedAndClaim(14);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            problem: BOOTSTRAP_FAILED,
        });

        const stored = await readRun(claimed.correlationId);
        // FR-026/FR-041: `failed` is retryable and is never `unconfirmed`.
        expect(stored.state).toBe(FAILED);
        expect(stored.state).not.toBe(UNCONFIRMED);
    });
});

describe('T-012 the staleness / idempotency matrix (plan D7, FR-025, AC-109)', () => {
    it('is idempotent ten times over: one result row, nine duplicate rows, stable state', async () => {
        const claimed = await seedAndClaim(15);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const body = {
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_idem',
        };
        await report(body);
        const afterFirst = await readRun(claimed.correlationId);
        for (let index = 0; index < 9; index += 1) {
            const repeat = await report(body);
            expect(repeat.status, `repeat ${index + 1} must be accepted`).toBe(DUPLICATE);
        }

        const afterTenth = await readRun(claimed.correlationId);
        // Contract invariant 3: byte-stable across the repeats.
        expect(afterTenth).toEqual(afterFirst);
        const rows = await trail();
        expect(rows.filter((entry) => entry.eventType === RESULT_ROW)).toHaveLength(1);
        expect(rows.filter((entry) => entry.eventType === DUPLICATE_ROW)).toHaveLength(9);
    });

    it('refuses a token this run never recorded, as stale', async () => {
        const claimed = await seedAndClaim(16);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: 'dtk-ffffffffffffffffffffffffffffffff',
            sessionId: 'ses_forged',
        });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe(STARTING);
    });

    it('refuses a report carrying a superseded attempt', async () => {
        const claimed = await seedAndClaim(17);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            attempt: 2,
            sessionId: 'ses_late',
        });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
    });

    it('refuses a conflicting repeat rather than overwriting a recorded session', async () => {
        const claimed = await seedAndClaim(18);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        const body = { correlationId: claimed.correlationId, dispatchToken: authorized.dispatchToken };

        await report({ ...body, sessionId: 'ses_first' });
        const outcome = await report({ ...body, problem: BOOTSTRAP_FAILED });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(INVALID_TRANSITION);
        // The session survives: a session id can never be replaced by a problem.
        expect(refusal?.message).toContain('ses_first');
        const stored = await readRun(claimed.correlationId);
        expect(stored.session?.sessionId).toBe('ses_first');
    });

    it('refuses a repeated problem carrying a different cause', async () => {
        const claimed = await seedAndClaim(19);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        const body = { correlationId: claimed.correlationId, dispatchToken: authorized.dispatchToken };

        await report({ ...body, problem: BOOTSTRAP_FAILED });
        const outcome = await report({ ...body, problem: 'session-create-failed' });

        expect(outcome.status).toBe(REFUSED);
        expect(await readRun(claimed.correlationId).then((found) => found.stateReason)).toBe(BOOTSTRAP_FAILED);
    });

    it('applies an unconsumed report from starting even after the lease expired', async () => {
        const claimed = await seedAndClaim(25);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        // The reservation, not the lease, authorizes a *report* (plan D7) — this
        // is what lets AC-111's remount-after-expiry reconciliation succeed.
        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_late_but_real',
            now: AFTER_LEASE,
        });

        expect(outcome.status).toBe(APPLIED);
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe('dispatched');
    });

    it('applies an unconsumed report from unconfirmed, reconciling the run', async () => {
        const claimed = await seedAndClaim(26);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        // Let the deadline pass so the sweep wedges the run (FR-023).
        await sweepOnce({ store, log: LOGGER, now: AFTER_LEASE });
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe(UNCONFIRMED);

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_reconciled',
        });

        // Contract §2's `unconfirmed` row: applied, not refused.
        expect(outcome.status).toBe(APPLIED);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe('dispatched');
        expect(stored.session?.sessionId).toBe('ses_reconciled');
    });

    it('refuses a second reservation token over a newer one', async () => {
        const claimed = await seedAndClaim(27);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        // The run has one authorization; a report carrying any other token is
        // stale regardless of state.
        const outcome = await report({
            correlationId: claimed.correlationId,
            // A well-formed token that is not this run's: the mint function is the
            // real one, so the value passes every shape check and is still refused
            // on the comparison, which is what makes this a staleness test rather
            // than a malformed-input test.
            dispatchToken: buildDispatchToken(`${claimed.correlationId}|another-run`, 1),
            sessionId: 'ses_wrong_chain',
        });

        expect(outcome.status).toBe(REFUSED);
        expect(await readRun(claimed.correlationId).then((found) => found.session)).toBeNull();
    });
});

describe('T-012 abandon is honest and retryable (FR-026)', () => {
    it('records a reserved attempt that created no session as failed', async () => {
        const claimed = await seedAndClaim(30);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const outcome = await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            operation: 'abandon',
            reason: ABANDON_REASON,
        });

        expect(outcome.status).toBe(APPLIED);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe(FAILED);
        expect(stored.state).not.toBe(UNCONFIRMED);
        expect(stored.stateReason).toBe(ABANDON_REASON);
        expect(stored.reservation?.consumed).toBe(true);
        expect(stored.attempts.at(-1)).toMatchObject({ outcome: 'abandoned', reason: ABANDON_REASON });
    });

    it('writes a dispatch.abandoned row with the no-session decision', async () => {
        const claimed = await seedAndClaim(31);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        await report({
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            operation: 'abandon',
            reason: 'guard failed after reserve',
        });

        const [row] = await rowsOf(ABANDONED_ROW);
        expect(row).toMatchObject({ attempt: 1, reason: 'guard failed after reserve' });
        const entries = await trail();
        const abandonedEntry = entries.find((entry) => entry.eventType === ABANDONED_ROW);
        expect(abandonedEntry?.decision).toBe('no-session');
    });

    it('is idempotent: a repeated abandon is a duplicate, not a second failure', async () => {
        const claimed = await seedAndClaim(32);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        const body = {
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            operation: 'abandon' as const,
            reason: 'panel aborted',
        };

        await report(body);
        const outcome = await report(body);

        expect(outcome.status).toBe(DUPLICATE);
        expect(await rowsOf(ABANDONED_ROW)).toHaveLength(1);
        expect(await rowsOf(DUPLICATE_ROW)).toHaveLength(1);
    });
});

describe('T-013 block report holds the run in blocked:<reason> (FR-042, AC-114)', () => {
    it('blocks from claimed under the live lease, consuming nothing', async () => {
        const claimed = await seedAndClaim(40);

        const outcome = await block({
            claim: claimed,
            blockedReason: PROJECT_MISSING,
            detail: 'project "prj_9" is not registered',
        });

        expect(outcome.status).toBe(APPLIED);
        const stored = await readRun(claimed.correlationId);
        expect(stored.state).toBe('blocked:project-missing');
        expect(stored.stateReason).toBe('project "prj_9" is not registered');
        // Gate Q3: a guard refusal consumes neither the attempt nor the budget.
        expect(stored.attempt).toBe(1);
        expect(stored.requeuesUsed).toBe(0);
        expect(stored.reservation).toBeNull();
    });

    it('writes a run.blocked row naming the cause, prior state, and guidance', async () => {
        const claimed = await seedAndClaim(41);

        await block({
            claim: claimed,
            blockedReason: BINDING_MISSING,
            detail: 'binding gone',
            guidance: 'restore the binding, then retry',
        });

        const [row] = await rowsOf(BLOCKED_ROW);
        expect(row).toMatchObject({
            blockedReason: BINDING_MISSING,
            priorState: 'claimed',
            guidance: 'restore the binding, then retry',
        });
        const entries = await trail();
        const blockedEntry = entries.find((entry) => entry.eventType === BLOCKED_ROW);
        expect(blockedEntry?.actorSource).toBe('panel');
    });

    it('leaves a blocked run untouched by ten sweep ticks', async () => {
        const claimed = await seedAndClaim(42);
        await block({ claim: claimed, blockedReason: 'policy', detail: 'no policy profile matched' });

        for (let index = 0; index < 10; index += 1) {
            await sweepOnce({ store, log: LOGGER, now: AFTER_LEASE });
        }

        const stored = await readRun(claimed.correlationId);
        // FR-036: the sweep touches exactly two conditions, and this is neither.
        expect(stored.state).toBe('blocked:policy');
        expect(stored.attempt).toBe(1);
        expect(stored.requeuesUsed).toBe(0);
    });

    it('never records a blocked run as dispatched, even with a session-shaped id present', async () => {
        const claimed = await seedAndClaim(43);

        await block({ claim: claimed, blockedReason: 'credential', detail: 'token scopes insufficient' });

        const stored = await readRun(claimed.correlationId);
        expect(stored.state).not.toBe('dispatched');
        expect(stored.session).toBeNull();
    });

    it('refuses a block under an expired lease, as stale', async () => {
        const claimed = await seedAndClaim(44);

        const outcome = await blockDispatch({
            store,
            log: LOGGER,
            correlationId: claimed.correlationId,
            leaseId: claimed.leaseId,
            attempt: 1,
            blockedReason: PROJECT_MISSING,
            detail: 'gone',
            guidance: null,
            now: AFTER_LEASE,
        });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(STALE_LEASE);
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe('claimed');
    });

    it('refuses a live-lease run that is not claimed as invalid-transition, naming the state', async () => {
        // Same shape as the reserve's: the lease is valid and current, so the
        // refusal is about the state rather than the authorization. A guard that
        // fires late — after the run failed — must not rewrite it as `blocked`.
        const run = await seedRunInState({ issueNumber: 45, state: FAILED, liveLease: true });

        const outcome = await blockDispatch({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            leaseId: leaseOf(run),
            attempt: 1,
            blockedReason: PROJECT_MISSING,
            detail: 'gone',
            guidance: null,
            now: STAMP,
        });

        expect(outcome.status).toBe(REFUSED);
        const refusal = outcome.status === REFUSED ? outcome.refusal : null;
        expect(refusal?.code).toBe(INVALID_TRANSITION);
        expect(refusal?.message).toContain(FAILED);
        expect(await readRun(run.correlationId).then((found) => found.state)).toBe(FAILED);
    });

    it('writes exactly one run.blocked row for a guard refusal, carrying the run id', async () => {
        const claimed = await seedAndClaim(46);

        await block({ claim: claimed, blockedReason: 'policy', detail: 'no policy profile matched' });

        const entries = await trail();
        const rows = entries.filter((entry) => entry.eventType === BLOCKED_ROW);
        expect(rows).toHaveLength(1);
        // FR-062: the lifecycle row carries the run's id, never a fresh one.
        expect(rows[0]?.correlationId).toBe(claimed.correlationId);
        expect(rows[0]?.entity).toEqual({ kind: 'run', id: claimed.correlationId });
    });
});

describe('T-011..T-013 no audit row ever carries a dispatch token value (FR-061)', () => {
    it('scans every row this wave writes for a token-shaped string', async () => {
        const reserved = await seedAndClaim(50);
        const authorized = await reserve(reserved);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        await report({
            correlationId: reserved.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_scan',
        });

        const abandoned = await seedAndClaim(51);
        const second = await reserve(abandoned);
        if (second.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        await report({
            correlationId: abandoned.correlationId,
            dispatchToken: second.dispatchToken,
            operation: 'abandon',
            reason: 'abandoned for the scan',
        });

        const blocked = await seedAndClaim(52);
        await block({ claim: blocked, blockedReason: PROJECT_MISSING, detail: 'gone' });

        const refused = await seedAndClaim(53);
        await reserve({ ...refused, now: AFTER_LEASE });

        const entries = await trail();
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(JSON.stringify(entry), `${entry.eventType} carried a dispatch token`)
                .not.toMatch(/dtk-[0-9a-f]{8,}/);
        }
    });

    it('names each authorization by a distinct fingerprint', async () => {
        const first = await seedAndClaim(54);
        const firstToken = await reserve(first);
        if (firstToken.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const second = await seedAndClaim(55);
        const secondToken = await reserve(second);
        if (secondToken.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const reservedRows = await rowsOf(RESERVED_ROW);
        const fingerprints = reservedRows.map((row) => row.dispatchTokenFingerprint);
        expect(fingerprints).toHaveLength(2);
        for (const fingerprint of fingerprints) {
            expect(fingerprint).toMatch(/^tokfp-[0-9a-f]{16}$/);
        }
        expect(new Set(fingerprints).size).toBe(2);
    });
});


describe('T-011..T-013 every route answers the documented validation failures (contract §4)', () => {
    it('refuses a reserve whose body contradicts the path, naming the field', async () => {
        // FR-051: the service mints the id; a panel that substitutes one is not
        // talking about the run it addressed, so the request is refused rather
        // than reconciled. This is a validation failure, not a staleness verdict:
        // the service never got to compare an authorization.
        const service = await startTestService();

        const response = await service.call(routePath(RESERVE_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ correlationId: 'mt-run-111111111111111111111111', attempt: 1, leaseId: LEASE }),
        });
        const failure = (await response.json()) as { error: { code: string; issues?: readonly { field: string }[] } };

        expect(response.status).toBe(422);
        expect(failure.error.code).toBe('validation');
        expect(failure.error.issues?.map((issue) => issue.field)).toContain('correlationId');
        // SEC-11: the received value is never echoed back.
        expect(JSON.stringify(failure)).not.toContain('mt-run-111111111111111111111111');
    });

    it('refuses a result carrying both a session and a problem', async () => {
        const service = await startTestService();

        const response = await service.call(routePath(DISPATCHED_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
                correlationId: RUN_ID,
                attempt: 1,
                dispatchToken: TOKEN,
                sessionId: 'ses_a',
                problem: BOOTSTRAP_FAILED,
            }),
        });

        // FR-040's whole point is that the two are different facts; resolving
        // "which did the caller mean" by a precedence rule is exactly the guess
        // constitution II forbids.
        expect(response.status).toBe(422);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('validation');
    });

    it('refuses a result carrying neither a session nor a problem', async () => {
        const service = await startTestService();

        const response = await service.call(routePath(DISPATCHED_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ correlationId: RUN_ID, attempt: 1, dispatchToken: TOKEN }),
        });

        expect(response.status).toBe(422);
    });

    it('refuses an abandon with no reason, since the row would be unreadable', async () => {
        const service = await startTestService();

        const response = await service.call(routePath(ABANDON_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ correlationId: RUN_ID, attempt: 1, dispatchToken: TOKEN }),
        });

        expect(response.status).toBe(422);
    });

    it('refuses a blocked reason outside the four declared causes', async () => {
        const service = await startTestService();

        const response = await service.call(routePath(BLOCKED_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
                correlationId: RUN_ID,
                attempt: 1,
                leaseId: LEASE,
                blockedReason: 'invented',
                detail: 'x',
            }),
        });

        // The four-value set is what keeps `blocked:<reason>` states parseable
        // (data-model §2.2); a fifth value would make the document unreadable.
        expect(response.status).toBe(422);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('validation');
    });

    it('accepts each of the four declared blocked reasons', async () => {
        const service = await startTestService();

        for (const reason of [PROJECT_MISSING, BINDING_MISSING, 'credential', 'policy']) {
            const response = await service.call(routePath(BLOCKED_ROUTE), {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({
                    correlationId: RUN_ID,
                    attempt: 1,
                    leaseId: LEASE,
                    blockedReason: reason,
                    detail: 'x',
                }),
            });

            // Not 422: the reason is one this build declares. `unknown-run` is the
            // honest answer for an empty store.
            expect(response.status, `${reason} must be accepted`).toBe(404);
            expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unknown-run');
        }
    });

    it('refuses a body that is not a JSON object', async () => {
        const service = await startTestService();

        const response = await service.call(routePath(RESERVE_ROUTE), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify(['not', 'an', 'object']),
        });

        expect(response.status).toBe(422);
    });
});

describe('T-011..T-013 a degraded trail is reported, never swallowed (FR-063, AC-119)', () => {
    it('answers 200 with auditWritten false and keeps the state change when the append fails', async () => {
        const claimed = await seedAndClaim(80);
        const failing = {
            ...store,
            appendLine: async (path: string, line: unknown): Promise<void> => {
                // Fail only the lifecycle rows, so the fixture still has a store
                // whose run document is writable and readable.
                if (path === AUDIT_FILE) {
                    throw new Error(APPEND_REFUSED);
                }

                await store.appendLine(path, line);
            },
        };

        const outcome = await reserveDispatch({
            store: failing,
            log: LOGGER,
            correlationId: claimed.correlationId,
            leaseId: claimed.leaseId,
            attempt: 1,
            now: STAMP,
        });

        // The durable change stands: FR-063 forbids rolling it back, because the
        // panel is already acting on the token this call handed out.
        expect(outcome.status).toBe(APPLIED);
        if (outcome.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        expect(outcome.auditWritten).toBe(false);
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe(STARTING);
    });

    it('logs the failure naming the run, so the degradation is diagnosable', async () => {
        const claimed = await seedAndClaim(81);
        LOG_LINES.length = 0;

        await reserveDispatch({
            store: {
                ...store,
                appendLine: async (path: string, line: unknown): Promise<void> => {
                    if (path === AUDIT_FILE) {
                        throw new Error(APPEND_REFUSED);
                    }

                    await store.appendLine(path, line);
                },
            },
            log: LOGGER,
            correlationId: claimed.correlationId,
            leaseId: claimed.leaseId,
            attempt: 1,
            now: STAMP,
        });

        const warning = LOG_LINES.find((line) => line.includes('could not be appended'));
        expect(warning).toBeDefined();
        expect(warning).toContain(claimed.correlationId);
        expect(warning).toContain(RESERVED_ROW);
    });

    it('reports auditWritten false for a refusal whose own row failed', async () => {
        const claimed = await seedAndClaim(82);

        const outcome = await reserveDispatch({
            store: {
                ...store,
                appendLine: async (path: string, line: unknown): Promise<void> => {
                    if (path === AUDIT_FILE) {
                        throw new Error(APPEND_REFUSED);
                    }

                    await store.appendLine(path, line);
                },
            },
            log: LOGGER,
            correlationId: claimed.correlationId,
            leaseId: claimed.leaseId,
            attempt: 1,
            now: AFTER_LEASE,
        });

        expect(outcome.status).toBe(REFUSED);
        expect(outcome.status === REFUSED ? outcome.auditWritten : true).toBe(false);
        // Nothing moved either way.
        expect(await readRun(claimed.correlationId).then((found) => found.state)).toBe('claimed');
    });
});

describe('T-012 one live authorization survives concurrent reserves (AC-109, AC-112)', () => {
    it('lets exactly one of two concurrent reserves through', async () => {
        const claimed = await seedAndClaim(83);

        // Two panels, one live lease. Both read the same `claimed` run and both
        // believe they may authorize it; the shared write chain is what makes one
        // of them win. This is the race a check-then-act design would lose.
        const [first, second] = await Promise.all([
            reserveDispatch({
                store,
                log: LOGGER,
                correlationId: claimed.correlationId,
                leaseId: claimed.leaseId,
                attempt: 1,
                now: STAMP,
            }),
            reserveDispatch({
                store,
                log: LOGGER,
                correlationId: claimed.correlationId,
                leaseId: claimed.leaseId,
                attempt: 1,
                now: STAMP,
            }),
        ]);

        const applied = [first, second].filter((outcome) => outcome.status === APPLIED);
        const refused = [first, second].filter((outcome) => outcome.status === REFUSED);
        expect(applied).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.status === 'refused' ? refused[0].refusal.code : '').toBe(ALREADY_RESERVED);
        // Exactly one reservation and one `dispatch.reserved` row survive.
        expect(await rowsOf(RESERVED_ROW)).toHaveLength(1);
    });

    it('lets exactly one of two concurrent identical results through', async () => {
        const claimed = await seedAndClaim(84);
        const authorized = await reserve(claimed);
        if (authorized.status !== 'applied') {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }

        const body = {
            correlationId: claimed.correlationId,
            dispatchToken: authorized.dispatchToken,
            sessionId: 'ses_race',
        };
        const [first, second] = await Promise.all([report(body), report(body)]);

        // One applies, one is recognised as a repeat: a double-reported outcome
        // can never be applied twice, so a session cannot be recorded twice.
        const applied = [first, second].filter((outcome) => outcome.status === APPLIED);
        const duplicates = [first, second].filter((outcome) => outcome.status === DUPLICATE);
        expect(applied).toHaveLength(1);
        expect(duplicates).toHaveLength(1);
        const raced = await readRun(claimed.correlationId);
        expect(raced.attempts.filter((entry) => entry.sessionId !== null)).toHaveLength(1);
    });
});

describe('T-011..T-013 every refusing operation owes exactly one refusal row (FR-003)', () => {
    it('records a reserve, result, abandon, and block refusal each once, naming itself', async () => {
        const staleReserve = await seedAndClaim(60);
        await reserve({ ...staleReserve, now: AFTER_LEASE });

        const staleResult = await seedAndClaim(61);
        const resultAuth = await reserve(staleResult);
        if (resultAuth.status !== APPLIED) {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        await report({
            correlationId: staleResult.correlationId,
            dispatchToken: FORGED_TOKEN,
            sessionId: 'ses_forged',
        });

        const staleAbandon = await seedAndClaim(62);
        const abandonAuth = await reserve(staleAbandon);
        if (abandonAuth.status !== APPLIED) {
            throw new Error(RESERVE_DID_NOT_APPLY);
        }
        await report({
            correlationId: staleAbandon.correlationId,
            dispatchToken: FORGED_TOKEN,
            operation: 'abandon',
            reason: 'forged token',
        });

        const expiredBlock = await seedAndClaim(63);
        await blockDispatch({
            store,
            log: LOGGER,
            correlationId: expiredBlock.correlationId,
            leaseId: expiredBlock.leaseId,
            attempt: 1,
            blockedReason: PROJECT_MISSING,
            detail: 'gone',
            guidance: null,
            now: AFTER_LEASE,
        });

        const entries = await trail();
        const refusals = entries.filter((entry) => entry.eventType === REFUSED_ROW);
        // One row per refusal, in call order, each naming the operation that
        // refused it: contract §9's "exactly one row per refusal", asserted
        // across the three operations T-011–T-013 add rather than for reserve
        // alone, which is the only one Wave 2's vocabulary already implied.
        expect(refusals.map((entry) => entry.details.operation))
            .toEqual(['reserve', 'result', 'abandon', 'blocked']);
        for (const refusal of refusals) {
            expect(refusal.details.code).toBe(STALE_LEASE);
            expect(refusal.actorSource).toBe('service');
            expect(refusal.details.attempt).toBe(1);
        }

        // The token verdicts reference the authorization they judged — by
        // fingerprint, so the row answers which token was presented without
        // storing the capability itself (contract §9 / fingerprint rule).
        const tokenVerdicts = refusals.filter((entry) =>
            entry.details.operation === 'result' || entry.details.operation === 'abandon');
        expect(tokenVerdicts).toHaveLength(2);
        for (const verdict of tokenVerdicts) {
            expect(verdict.details.dispatchTokenFingerprint).toMatch(/^tokfp-[0-9a-f]{16}$/);
        }
    });
});
