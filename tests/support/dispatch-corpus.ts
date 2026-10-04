/**
 * Raw materials and verbs for the dispatch corpus (003 T-018): the planted
 * legacy queue, the loopback helpers, and the injected-clock sweep.
 *
 * The *sequence* those verbs are driven in lives beside this file in
 * [`dispatch-drive.ts`](./dispatch-drive.ts); splitting them keeps both halves
 * inside the file-length gate, and keeps this one importable by any suite that
 * needs "a service whose store already holds a run" without inheriting the
 * whole drive.
 *
 * Everything is offline by construction: a temp data directory, the real
 * loopback service, and sweep stamps the caller injects (NFR-112 — no timer
 * this fixture ever waits on).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAuditEntries } from '../../service/audit.ts';
import { createEvent, enqueueEvents, EVENTS_FILE } from '../../service/poll/events.ts';
import { readRunsDocument } from '../../service/poll/runs.ts';
import { sweepOnce } from '../../service/poll/sweep.ts';
import { createLogger } from '../../service/log.ts';
import { EVENTS_PENDING_PATH } from '../../service/routes/events.ts';
import type { AuditEntry } from '../../service/audit.ts';
import type { EventSnapshot } from '../../service/poll/events.ts';
import type { Run } from '../../service/poll/runs-types.ts';
import type { ServiceLogger } from '../../service/log.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import { startTestService } from './service.ts';
import type { TestService } from './service.ts';
import { writeOpenBinding } from './binding-fixture.ts';

/** Hex characters behind the lease id prefix this build mints. */
const LEASE_HEX_CHARS = 24;

/** Hex characters behind the dispatch token prefix this build mints. */
const TOKEN_HEX_CHARS = 32;

/** Passes the dead-letter drive allows itself before it gives up. */
const MAX_DEAD_LETTER_PASSES = 8;

/** Issue the adopted run belongs to; a later trigger coalesces onto it. */
const ADOPTED_ISSUE = 7;

/** Issue the normally created run belongs to; enqueued last, never claimed. */
export const CREATED_ISSUE = 8;

/** Binding, repository, and account every fixture detection names. */
const BINDING_ID = 'bnd-vocab';
const REPOSITORY = 'acme/vocab';
const ACCOUNT_ID = '77331';

/** Stamp the planted legacy row carries. */
const LEGACY_STAMP = '2026-09-20T00:00:00.000Z';

/** Milliseconds a lease and a result deadline both sit inside. */
const WINDOW_MS = 120_000;

/** Milliseconds past both windows, so one injected stamp passes every expiry. */
const PAST_BOTH_WINDOWS_MS = WINDOW_MS + 1_000;

/** Opaque mount id every fixture claim takes. */
const HOLDER = 'panel-vocab';

/** Session the fixture result reports; host-shaped, so every route accepts it. */
export const SESSION_ID = 'ses_vocab_ok';

/** Agent the fixture read-back expects. */
export const EXPECTED_AGENT = 'project-manager';

/** Agent the mismatching read-back observes. */
export const OTHER_AGENT = 'docs-writer';

/** The lease id no run ever held, for the stale-lease refusal. */
export const UNKNOWN_LEASE = `lse-${'d'.repeat(LEASE_HEX_CHARS)}`;

/** The well-formed token no run ever recorded, for the body-level refusals. */
export const UNKNOWN_TOKEN = `dtk-${'e'.repeat(TOKEN_HEX_CHARS)}`;

/** The guard cause the block report names; one of the four the spec declares. */
export const BLOCKED_CAUSE = 'project-missing';

/** In-panel guidance the block report offers with its detail. */
export const BLOCK_GUIDANCE = 'register the project in OpenChamber, then retry';

/** Header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Log lines the corpus keeps out of the test output. */
const LOG_LINES: string[] = [];

/** Logger every direct store call in the corpus reports through. */
const CORPUS_LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

/** One refusal the corpus took, with the verdict it observed on the wire. */
export interface RefusalObservation {
    /** Operation name the `dispatch.refused` row records. */
    readonly operation: string;
    /** HTTP status the route answered. */
    readonly status: number;
    /** Error code that status carried. */
    readonly code: string;
}

/** One response, with its status and parsed body. */
export interface WireAnswer {
    /** HTTP status. */
    readonly status: number;
    /** Parsed body, read as an untrusted record. */
    readonly json: Record<string, unknown>;
}

/** The corpus the drive produced, ready for a suite to assert over. */
export interface DispatchCorpus {
    /** The running service the corpus was driven against. */
    readonly service: TestService;
    /** Every audit row the corpus wrote, in `seq` order. */
    readonly trail: readonly AuditEntry[];
    /** The adopted run: every transition in §4.3 happened to this one. */
    readonly adoptedRunId: string;
    /** The run the `run.created` row names. */
    readonly createdRunId: string;
    /** One refusal per refusing operation, in the order they were taken. */
    readonly refusals: readonly RefusalObservation[];
}

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/** The detection behind one fixture delivery. */
function detection(input: {
    /** Issue the delivery is about. */
    readonly issueNumber: number;
    /** Trigger kind to detect under. */
    readonly kind: EventSnapshot['kind'];
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
}): EventSnapshot {
    const base = {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        issue: {
            issueNumber: input.issueNumber,
            issueTitle: `Issue ${input.issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${input.issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        triggerNote: `${input.kind} fixture`,
        detectedAt: input.detectedAt,
    };

    // The basis is per trigger kind, not per fixture: a comment mention names
    // its own author directly, an assignment is attributed to the issue author
    // as a documented proxy (002 FR-044).
    return input.kind === 'mention'
        ? { ...base, kind: 'mention', actorAttribution: 'direct', origin: 'comment', commentId: 4242 }
        : { ...base, kind: 'assignment', actorAttribution: 'subject-author' };
}

/** The legacy row adoption starts from: shipped vocabulary, still `pending`. */
function legacyRow(): ReturnType<typeof createEvent> {
    return {
        ...createEvent(detection({
            issueNumber: ADOPTED_ISSUE,
            kind: 'assignment',
            detectedAt: LEGACY_STAMP,
        })),
        state: 'pending',
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
    };
}

/** Temp roots the drive planted legacy queues in, removed by its shutdown. */
const plantedRoots: string[] = [];

/**
 * Plant the legacy queue, then start the service so boot adopts it.
 *
 * @returns The running instance and its open store.
 * @throws {Error} When the harness store is unavailable.
 */
export async function startWithLegacyQueue(): Promise<{
    /** The running instance. */
    readonly service: TestService;
    /** The open store. */
    readonly store: ServiceStore;
}> {
    const root = await mkdtemp(join(tmpdir(), 'mecha-turk-vocab-'));
    plantedRoots.push(root);
    const dataDir = join(root, 'store');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, EVENTS_FILE), JSON.stringify([legacyRow()]), 'utf8');

    const service = await startTestService({ dataDir });
    const opened = service.handle.store;
    if (opened === null) {
        await service.shutdown();

        throw new Error('the harness store is unavailable');
    }

    // The corpus drives every transition in the data model, several of which
    // authorize a dispatch — and the authorization gate reads `bindings.json` at
    // that moment and denies when it cannot (003 FR-076, constitution II). So the
    // store holds the corpus's own binding, with the **open** policy a store
    // predating the allow-list would carry (002 FR-047): the corpus keeps
    // exercising the vocabulary, and the gate admits every run it reserves.
    await writeOpenBinding({
        store: opened,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, accountNumericUserId: ACCOUNT_ID },
    });

    return { service, store: opened };
}

/** Enqueue one fixture delivery through the real coalescing path. */
export async function enqueueFixture(input: {
    /** Open store to write through. */
    readonly store: ServiceStore;
    /** Issue the delivery is about. */
    readonly issueNumber: number;
    /** Trigger kind to detect under. */
    readonly kind: EventSnapshot['kind'];
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
}): Promise<void> {
    await enqueueEvents({
        store: input.store,
        log: CORPUS_LOGGER,
        incoming: [createEvent(detection({
            issueNumber: input.issueNumber,
            kind: input.kind,
            detectedAt: input.detectedAt,
        }))],
    });
}

/** Read every stored run, draining the durable audit outbox with it. */
export async function readRuns(store: ServiceStore): Promise<readonly Run[]> {
    const document = await readRunsDocument({ store, log: CORPUS_LOGGER });

    return document.runs;
}

/** Read one stored run back, or fail the fixture loudly. */
export async function readRun(store: ServiceStore, correlationId: string): Promise<Run> {
    const runs = await readRuns(store);
    const run = runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('the fixture run is no longer stored');
    }

    return run;
}

/** The lease a stored run holds, or the fixture's own failure. */
export function leaseOf(run: Run): string {
    if (run.lease === null) {
        throw new Error('the fixture run holds no lease');
    }

    return run.lease.leaseId;
}

/** The dispatch token a stored run holds, or the fixture's own failure. */
export function tokenOf(run: Run): string {
    if (run.reservation === null) {
        throw new Error('the fixture run holds no reservation');
    }

    return run.reservation.dispatchToken;
}

/**
 * POST one run-scoped body over the loopback service.
 *
 * @param input - The running instance, the concrete path, and the body.
 * @returns The status and the parsed body.
 */
export async function post(input: {
    /** The running instance to call. */
    readonly service: TestService;
    /** The concrete path to post to. */
    readonly path: string;
    /** The body to send. */
    readonly body: Readonly<Record<string, unknown>>;
}): Promise<WireAnswer> {
    const response = await input.service.call(input.path, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(input.body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** The concrete path one run-scoped route answers on. */
export function bound(pattern: string, correlationId: string): string {
    return pattern.replace(':correlationId', correlationId);
}

/** The error code a failure envelope carries, read without trusting its shape. */
export function codeOf(json: Record<string, unknown>): string {
    const { error } = json;
    if (typeof error !== 'object' || error === null) {
        return '';
    }

    const { code } = error as { code?: unknown };

    return typeof code === 'string' ? code : '';
}

/** Fail loudly when a fixture step answered anything but its own verdict. */
export function expectStatus(input: {
    /** What this step was, for the failure message. */
    readonly step: string;
    /** The answer as it arrived. */
    readonly answer: WireAnswer;
    /** The status the step owed. */
    readonly status: number;
}): void {
    if (input.answer.status !== input.status) {
        throw new Error(`${input.step} answered ${input.answer.status}, expected ${input.status} `
            + `(${codeOf(input.answer.json)})`);
    }
}

/** Claim every waiting run, as the relay does. */
export async function claim(service: TestService): Promise<WireAnswer> {
    const response = await service.call(`${EVENTS_PENDING_PATH}?holder=${HOLDER}`);

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Run one sweep pass at an injected stamp past both configured windows. */
export async function sweep(store: ServiceStore): Promise<void> {
    await sweepOnce({
        store,
        log: CORPUS_LOGGER,
        now: new Date(Date.now() + PAST_BOTH_WINDOWS_MS).toISOString(),
    });
}

/**
 * Cycle claim and sweep until the automatic requeue budget parks the run
 * (FR-033); three expiries burn the budget and the fourth parks it.
 *
 * @param input - The running instance, the store, and the run to exhaust.
 * @throws {Error} When the budget does not park the run within the bound.
 */
export async function driveToDeadLetter(input: {
    /** The running instance. */
    readonly service: TestService;
    /** The open store. */
    readonly store: ServiceStore;
    /** The run to exhaust. */
    readonly correlationId: string;
}): Promise<void> {
    for (let pass = 0; pass < MAX_DEAD_LETTER_PASSES; pass += 1) {
        const run = await readRun(input.store, input.correlationId);
        if (run.state === 'dead-lettered') {
            return;
        }

        if (run.state === 'pending') {
            const answer = await claim(input.service);
            expectStatus({ step: 'claim for expiry', answer, status: 200 });
        }

        await sweep(input.store);
    }

    throw new Error('the fixture run never dead-lettered');
}

/** Drain the audit outbox and read the trail exactly as the store holds it. */
export async function readTrail(store: ServiceStore): Promise<readonly AuditEntry[]> {
    // Reading the run document first retires any durable intent the drive owed
    // but had not appended (T-037), so the trail is complete before assertions.
    await readRunsDocument({ store, log: CORPUS_LOGGER });

    return await readAuditEntries(store);
}

/**
 * Drain the corpus's service and remove every temp root it planted.
 *
 * @param corpus - The corpus the drive produced.
 */
export async function shutdownDispatchCorpus(corpus: DispatchCorpus): Promise<void> {
    await corpus.service.shutdown();
    while (plantedRoots.length > 0) {
        const root = plantedRoots.pop();
        if (root !== undefined) {
            await rm(root, { recursive: true, force: true });
        }
    }

    LOG_LINES.length = 0;
}
