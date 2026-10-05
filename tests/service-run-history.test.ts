/**
 * The run-history projection, member by member (003 T-016; contract
 * [run-history-audit.md](../specs/003-dispatch-integrity/contracts/run-history-audit.md) §1).
 *
 * `tests/service-runs.test.ts` owns the route's *shape* from outside: the exact
 * field set, the ordering, and the cap. This suite owns what those members
 * **mean** as one run moves through the state machine, because a row that
 * carries the right keys with stale values is exactly the sort of record an
 * operator then trusts:
 *
 * - every member contract §1 names is present at every step a run can be read
 *   in — waiting, leased, authorized (with its deadline), dispatched (with its
 *   session), and verified (with its read-back);
 * - a hostile issue title and a hostile state reason come back **byte-identical
 *   as plain strings** — neither HTML-escaped nor interpreted (NFR-109: the
 *   panel is the renderer, this route is the record);
 * - the answer carries no credential, even with one registered in the same
 *   store and a dispatch token minted along the way (NFR-106, AC-120).
 *
 * Offline: a temp data directory per instance, runs reached through the real
 * loopback routes, injected stamps, no sleeping, no network, no host.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { findSecretLeak } from '../src/redaction.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { projectRunHistory } from '../service/poll/run-history-project.ts';
import { applyEnqueue, emptyRunsDocument, MAX_SOURCE_REFERENCES, readRunsDocument } from '../service/poll/runs.ts';
import { createLogger } from '../service/log.ts';
import { resolvePromptSnapshot } from '../service/prompt.ts';
import { DISPATCHED_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH, MAX_LISTED_EVENTS } from '../service/routes/events.ts';
import { VERIFICATION_PATH } from '../service/routes/run-ops.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import type { EventKind, EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { RunHistoryRow } from '../service/poll/run-history-project.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { PromptSnapshot } from '../service/prompt.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';

/** Credential registered with this suite; must never reach an answer. */
const REGISTERED_TOKEN = `run-history-credential-${'q'.repeat(32)}`;

/** Login the fixture token belongs to; the projection must not carry it. */
const ACCOUNT_LOGIN = 'octocat-history';

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Header GitHub reports granted classic scopes in. */
const OAUTH_SCOPES_HEADER = 'x-oauth-scopes';

/** Binding every fixture detection names. */
const BINDING_ID = 'bnd-history';

/** Repository every fixture detection names. */
const REPOSITORY = 'acme/history';

/** Project the fixtures snapshot onto the run. */
const PROJECT_ID = 'prj_42';

/** Opaque mount id the fixture claim takes. */
const HOLDER = 'panel-history';

/** Session the fixture result reports; host-shaped, so every route accepts it. */
const SESSION_ID = 'ses_history_ok';

/** Agent the fixture read-back reports. */
const PROBE_AGENT = 'project-manager';

/** The plainest trigger kind, named once for the fixtures. */
const ASSIGNMENT_KIND: EventKind = 'assignment';

/** The comment-origin trigger, named once for the coalescing fixture. */
const MENTION_KIND: EventKind = 'mention';

/** Issue title an attacker would love to see executed. */
const HOSTILE_TITLE = '<img src=x onerror="alert(1)">';

/** Failure text a panel could report verbatim, and which must stay text. */
const HOSTILE_PROBLEM = '<img src=y onerror="alert(2)">';

/** Issue the waiting-run fixture opens. */
const ISSUE_ONE = 1;

/** Issue the hostile fixture opens. */
const ISSUE_TWO = 2;

/** Issue the credential fixture opens. */
const ISSUE_THREE = 3;

/** Issue the reference-cap fixture opens; it never reaches a service. */
const ISSUE_FOUR = 4;

/** Title the reference-cap fixture carries. */
const CAP_TITLE = 'Reference cap fixture';

/** Title the waiting-run fixture carries. */
const PARSER_TITLE = 'Ship the parser';

/** Detection stamp the waiting-run fixture carries. */
const FIRST_DETECTED_AT = '2026-09-28T09:00:00.000Z';

/**
 * Every member contract §1's table names for a `RunHistoryRow`.
 *
 * The list is transcribed from the contract rather than from the code, so a
 * field the implementation forgets to project fails this suite instead of
 * quietly missing from the row.
 */
const CONTRACT_MEMBERS = [
    'id',
    'state',
    'stateReason',
    'runKey',
    'ordinal',
    'attempt',
    'correlationId',
    'attachmentId',
    'projectId',
    'worktreeOption',
    'leaseExpiresAt',
    'sourceReferences',
    'referenceCount',
    'referencesTruncated',
    'referencesNotRetained',
    'session',
    'verification',
    'kind',
    'repository',
    'issueNumber',
    'issueTitle',
    'issueUrl',
    'detectedAt',
    'bindingId',
    'dispatchResult',
] as const;

/** The header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/** One response, with its status and parsed body. */
interface WireAnswer {
    /** HTTP status. */
    readonly status: number;
    /** Parsed body, read as an untrusted record. */
    readonly json: Record<string, unknown>;
}

/** Log lines the fixture logger keeps out of the test output. */
const LOG_LINES: string[] = [];

/** Logger every direct store call in this suite reports through. */
const LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => void LOG_LINES.push(line) });

let running: TestService | null = null;
let store: ServiceStore;

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    LOG_LINES.length = 0;
});

/**
 * Start a service against a fresh temp store and register it for cleanup.
 *
 * @param options - Pass `registered` to also register the fixture credential.
 * @returns The running instance, with its store handle open for seeding.
 */
async function startSeededService(options: { readonly registered?: boolean } = {}): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: { [OAUTH_SCOPES_HEADER]: 'repo, user' },
        },
    });
    const service = await startTestService({ github: github.verifier });
    running = service;
    const opened = service.handle.store;
    if (opened === null) {
        throw new Error('the harness store is unavailable');
    }

    store = opened;
    // The gate reads `bindings.json` at authorization and denies when it cannot
    // (003 FR-076); the open policy keeps every projection assertion here about
    // the projection (002 FR-047).
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, projectId: PROJECT_ID },
    });
    if (options.registered === true) {
        const registered = await service.call(VERIFY_PATH, {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ token: REGISTERED_TOKEN }),
        });
        if (registered.status !== 201) {
            throw new Error(`the fixture credential did not register: ${registered.status}`);
        }
    }

    return service;
}

/**
 * Build the detection one fixture delivery is assembled from.
 *
 * @param input - Issue number, title, trigger kind, detection stamp, and the
 *   comment a mention matched on (which is what makes two mentions two
 *   deliveries — the id is a function of the observation).
 * @returns A complete event snapshot of the kind asked for.
 */
function detection(input: {
    readonly issueNumber: number;
    readonly title: string;
    readonly kind: EventKind;
    readonly detectedAt: string;
    readonly commentId?: number;
}): EventSnapshot {
    const base = {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        issue: {
            issueNumber: input.issueNumber,
            issueTitle: input.title,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${input.issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        triggerNote: `${input.kind} fixture`,
        detectedAt: input.detectedAt,
    };

    // The basis is per trigger kind, not per fixture: a comment mention names
    // its own author directly, while an assignment and a review request are
    // attributed to the subject's author as a documented proxy (002 FR-044).
    if (input.kind === 'review') {
        return {
            ...base,
            kind: 'review',
            actorAttribution: 'subject-author',
            headSha: 'deadbeefcafe000000000000000000000000beef',
            baseRef: 'main',
        };
    }

    return input.kind === MENTION_KIND
        ? {
            ...base,
            kind: 'mention',
            actorAttribution: 'direct',
            origin: 'comment',
            commentId: input.commentId ?? 4_242,
        }
        : { ...base, kind: 'assignment', actorAttribution: 'subject-author' };
}

/**
 * The dispatch token a stored run holds, or the fixture's own failure.
 *
 * @param run - The run whose reservation carries the token.
 * @returns The token the reserve minted.
 */
function tokenOf(run: Run): string {
    if (run.reservation === null) {
        throw new Error('the fixture run holds no reservation to report against');
    }

    return run.reservation.dispatchToken;
}

/** Read the run document, draining the durable audit outbox with it. */
async function readDocument(): Promise<readonly Run[]> {
    const document = await readRunsDocument({ store, log: LOGGER });

    return document.runs;
}

/**
 * Enqueue one delivery and return the run it produced.
 *
 * @param snapshot - The detection to enqueue.
 * @param prompt - The scan's prompt snapshot to queue the run under (004
 *   FR-015); omitted for a run queued with no tier set.
 * @returns The freshly created run.
 * @throws {Error} When the enqueue produced no new run.
 */
async function enqueueRun(snapshot: EventSnapshot, prompt?: PromptSnapshot): Promise<Run> {
    const before = await readDocument();
    const known = new Set(before.map((run) => run.correlationId));
    await enqueueEvents({
        store,
        log: LOGGER,
        incoming: [createEvent(snapshot)],
        ...(prompt !== undefined && { prompt }),
    });
    const after = await readDocument();
    const created = after.find((run) => !known.has(run.correlationId));
    if (created === undefined) {
        throw new Error('the fixture run was not enqueued');
    }

    return created;
}

/**
 * Read one stored run back, by the id the fixture created it with.
 *
 * @returns The stored run.
 * @throws {Error} When the run is no longer stored.
 */
async function readRun(correlationId: string): Promise<Run> {
    const runs = await readDocument();
    const run = runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('the fixture run is no longer stored');
    }

    return run;
}

/**
 * The concrete path one run-scoped route answers on, bound to a run id.
 *
 * @returns The same path with its parameter bound.
 */
function bound(pattern: string, correlationId: string): string {
    return pattern.replace(':correlationId', () => correlationId);
}

/**
 * POST one run-scoped body over the loopback service.
 *
 * @param request - The concrete path and the body to post.
 * @returns The status and the parsed body.
 */
async function post(
    service: TestService,
    request: { readonly path: string; readonly body: Readonly<Record<string, unknown>> },
): Promise<WireAnswer> {
    const response = await service.call(request.path, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(request.body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * Claim every waiting run, exactly as the relay does.
 *
 * @returns The claim answer, for the lease it issued.
 */
async function claim(service: TestService): Promise<WireAnswer> {
    const response = await service.call(`${EVENTS_PENDING_PATH}?holder=${HOLDER}`);

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * Read the history route and return its single row with the raw text beside it.
 *
 * @returns The one row this suite's fixtures produce, plus the answer text.
 * @throws {Error} When the answer is not exactly one row.
 */
async function onlyRow(service: TestService): Promise<{ readonly row: RunHistoryRow; readonly text: string }> {
    const response = await service.call(EVENTS_PATH);
    if (response.status !== 200) {
        throw new Error(`the history route answered ${response.status}`);
    }

    const text = await response.text();
    const body = JSON.parse(text) as { events: RunHistoryRow[] };
    const [row] = body.events;
    if (row === undefined || body.events.length !== 1) {
        throw new Error(`expected exactly one history row, got ${body.events.length}`);
    }

    return { row, text };
}

/**
 * Reserve the fixture run under the lease its claim just issued.
 *
 * @param run - The claimed run.
 * @returns The reserve answer, carrying the token and both deadlines.
 */
async function reserve(service: TestService, run: Run): Promise<WireAnswer> {
    const leased = await readRun(run.correlationId);
    if (leased.lease === null) {
        throw new Error('the fixture run holds no lease to reserve under');
    }

    return await post(service, {
        path: bound(RESERVE_PATH, run.correlationId),
        body: { correlationId: run.correlationId, attempt: leased.attempt, leaseId: leased.lease.leaseId },
    });
}

/**
 * Report the outcome of the fixture run's authorization.
 *
 * @param input - The running instance, the run to report for, and exactly one
 *   of `sessionId` / `problem` (FR-040 refuses a body carrying both or neither).
 * @returns The result answer.
 */
async function report(input: {
    /** The running instance to call. */
    readonly service: TestService;
    /** The run whose reservation is being spent. */
    readonly run: Run;
    /** Exactly one outcome. */
    readonly outcome: { readonly sessionId?: string; readonly problem?: string };
}): Promise<WireAnswer> {
    const authorized = await readRun(input.run.correlationId);
    const { sessionId, problem } = input.outcome;

    return await post(input.service, {
        path: bound(DISPATCHED_PATH, input.run.correlationId),
        body: {
            correlationId: input.run.correlationId,
            attempt: authorized.attempt,
            dispatchToken: tokenOf(authorized),
            ...(sessionId !== undefined && { sessionId }),
            ...(problem !== undefined && { problem }),
        },
    });
}

describe('T-016 the history row carries every member contract §1 names', () => {
    it('updates the members as one run waits, is leased, authorizes, dispatches, and verifies', async () => {
        const service = await startSeededService();
        const run = await enqueueRun(detection({
            issueNumber: ISSUE_ONE,
            title: PARSER_TITLE,
            kind: ASSIGNMENT_KIND,
            detectedAt: FIRST_DETECTED_AT,
        }));

        // Waiting: every identity member is present, every pointer is null.
        const waiting = await onlyRow(service);
        for (const member of CONTRACT_MEMBERS) {
            expect(Object.hasOwn(waiting.row, member), `row must carry ${member}`).toBe(true);
        }

        expect(waiting.row.id).toBe(run.correlationId);
        expect(waiting.row.correlationId).toBe(run.correlationId);
        expect(waiting.row.attachmentId).toBe(run.correlationId);
        expect(waiting.row.state).toBe('pending');
        expect(waiting.row.runKey).toBe(run.runKey);
        expect(waiting.row.ordinal).toBe(0);
        expect(waiting.row.attempt).toBe(1);
        expect(waiting.row.projectId).toBe(PROJECT_ID);
        expect(waiting.row.worktreeOption).toBe('none');
        expect(waiting.row.bindingId).toBe(BINDING_ID);
        expect(waiting.row.repository).toBe(REPOSITORY);
        expect(waiting.row.issueNumber).toBe(ISSUE_ONE);
        expect(waiting.row.issueTitle).toBe(PARSER_TITLE);
        expect(waiting.row.kind).toBe(ASSIGNMENT_KIND);
        expect(waiting.row.detectedAt).toBe(FIRST_DETECTED_AT);
        expect(waiting.row.leaseExpiresAt).toBeNull();
        expect(waiting.row.resultDeadlineAt).toBeNull();
        expect(waiting.row.claimedAt).toBeNull();
        expect(waiting.row.dispatchedAt).toBeNull();
        expect(waiting.row.dispatchResult).toBeNull();
        expect(waiting.row.session).toBeNull();
        expect(waiting.row.verification).toBeNull();
        expect(waiting.row.referenceCount).toBe(1);
        expect(waiting.row.referencesTruncated).toBe(false);
        expect(waiting.row.referencesNotRetained).toBe(0);
        expect(waiting.row.sourceReferences).toHaveLength(1);
        expect(waiting.row.sourceReferences[0]).toMatchObject({
            kind: ASSIGNMENT_KIND,
            origin: 'assignment',
            presentAtAuthorization: true,
            detectedAt: FIRST_DETECTED_AT,
        });

        // Leased: the expiry and the one claim stamp the run stores appear.
        const claimAnswer = await claim(service);
        expect(claimAnswer.status).toBe(200);
        const leased = await readRun(run.correlationId);
        const afterClaim = await onlyRow(service);
        expect(afterClaim.row.state).toBe('claimed');
        expect(afterClaim.row.leaseExpiresAt).toBe(leased.lease?.expiresAt ?? null);
        expect(afterClaim.row.claimedAt).toBe(leased.lease?.issuedAt ?? null);
        expect(afterClaim.row.stateReason).toContain(String(leased.lease?.expiresAt));

        // Authorized: the result deadline joins, and it is the reserve's own.
        const reserved = await reserve(service, run);
        expect(reserved.status).toBe(200);
        const starting = await readRun(run.correlationId);
        const afterReserve = await onlyRow(service);
        expect(afterReserve.row.state).toBe('starting');
        expect(afterReserve.row.resultDeadlineAt).toBe(starting.reservation?.resultDeadlineAt ?? null);
        expect(afterReserve.row.resultDeadlineAt).toBe(reserved.json.resultDeadlineAt);
        expect(afterReserve.row.leaseExpiresAt).not.toBeNull();

        // A trigger that joins after authorization is marked as such (FR-015).
        await enqueueEvents({
            store,
            log: LOGGER,
            incoming: [createEvent(detection({
                issueNumber: ISSUE_ONE,
                title: PARSER_TITLE,
                kind: MENTION_KIND,
                detectedAt: '2026-09-28T09:05:00.000Z',
            }))],
        });
        const joined = await onlyRow(service);
        expect(joined.row.referenceCount).toBe(2);
        expect(joined.row.sourceReferences).toHaveLength(2);
        expect(joined.row.referencesTruncated).toBe(false);
        expect(joined.row.referencesNotRetained).toBe(0);
        expect(joined.row.sourceReferences[1]?.presentAtAuthorization).toBe(false);
        expect(joined.row.sourceReferences[1]?.origin).toBe('comment:4242');
        expect(joined.row.sourceReferences[1]?.kind).toBe(MENTION_KIND);

        // Dispatched: session pointer, dispatch stamp, and the session id as
        // the retained result; the consumed deadline reads `null`.
        const reported = await report({ service, run, outcome: { sessionId: SESSION_ID } });
        expect(reported.status).toBe(200);
        const dispatched = await readRun(run.correlationId);
        const afterResult = await onlyRow(service);
        expect(afterResult.row.state).toBe('dispatched');
        expect(afterResult.row.session).toMatchObject({
            sessionId: SESSION_ID,
            attachmentId: run.correlationId,
        });
        expect(afterResult.row.dispatchedAt).toBe(dispatched.session?.dispatchedAt ?? null);
        expect(afterResult.row.dispatchResult).toBe(SESSION_ID);
        expect(afterResult.row.claimedAt).toBeNull();
        expect(afterResult.row.leaseExpiresAt).toBeNull();
        expect(afterResult.row.resultDeadlineAt).toBeNull();

        // Verified: the read-back rides the row without changing its state.
        const verification = await post(service, {
            path: bound(VERIFICATION_PATH, run.correlationId),
            body: {
                correlationId: run.correlationId,
                attempt: dispatched.attempt,
                sessionId: SESSION_ID,
                expectedAgent: PROBE_AGENT,
                observedAgent: PROBE_AGENT,
                baselineProvenance: 'configured',
                ok: true,
            },
        });
        expect(verification.status).toBe(200);
        const verified = await onlyRow(service);
        expect(verified.row.state).toBe('dispatched');
        expect(verified.row.verification).toMatchObject({
            observedAgent: PROBE_AGENT,
            expectedAgent: PROBE_AGENT,
            ok: true,
        });
        expect(verified.row.session).toMatchObject({ sessionId: SESSION_ID });
    });
});

describe('T-016 hostile source text round-trips as plain strings', () => {
    it('returns a hostile title and state reason byte-identical, neither escaped nor interpreted', async () => {
        const service = await startSeededService();
        const run = await enqueueRun(detection({
            issueNumber: ISSUE_TWO,
            title: HOSTILE_TITLE,
            kind: ASSIGNMENT_KIND,
            detectedAt: '2026-09-28T10:00:00.000Z',
        }));
        await claim(service);
        const reserved = await reserve(service, run);
        expect(reserved.status).toBe(200);

        const failed = await report({ service, run, outcome: { problem: HOSTILE_PROBLEM } });
        expect(failed.status).toBe(200);

        const { row, text } = await onlyRow(service);
        expect(row.state).toBe('failed');
        expect(row.issueTitle).toBe(HOSTILE_TITLE);
        expect(row.stateReason).toBe(HOSTILE_PROBLEM);
        // The recorded cause is the same untrusted string, not a sanitised copy.
        expect(row.dispatchResult).toBe(HOSTILE_PROBLEM);
        // …and the wire carried it as data: present verbatim, never HTML-escaped
        // (escaping is the renderer's job — NFR-109 forbids a second one here).
        expect(text).not.toContain('&lt;img');
        expect(row.issueUrl).toBe(`https://github.com/${REPOSITORY}/issues/${ISSUE_TWO}`);
    });
});

describe('T-016 the history answer is credential-free (NFR-106, AC-120)', () => {
    it('carries neither the registered credential, the login, nor a dispatch token', async () => {
        const service = await startSeededService({ registered: true });
        const run = await enqueueRun(detection({
            issueNumber: ISSUE_THREE,
            title: 'Rotate the credential',
            kind: ASSIGNMENT_KIND,
            detectedAt: '2026-09-28T11:00:00.000Z',
        }));
        await claim(service);
        const reserved = await reserve(service, run);
        // The token is real and on the wire — from the reserve, never the history.
        expect(String(reserved.json.dispatchToken)).toMatch(/^dtk-[0-9a-f]{32}$/);

        const reported = await report({ service, run, outcome: { sessionId: SESSION_ID } });
        expect(reported.status).toBe(200);

        const { row, text } = await onlyRow(service);
        expect(row.id).toBe(run.correlationId);
        expect(text).not.toContain(REGISTERED_TOKEN);
        expect(text).not.toContain(ACCOUNT_LOGIN);
        expect(text).not.toMatch(/dtk-[0-9a-f]{8,}/);
        expect(findSecretLeak(text)).toBeNull();
    });
});

describe('T-016 the truncation members carry the overflow, not a placeholder', () => {
    it('projects the cap counts and keeps the retained list bounded (T-038, AC-129)', () => {
        // The join pass is pure, so the overflow case costs one call instead of
        // 201 round trips: one assignment opens the run and `MAX_SOURCE_REFERENCES`
        // mentions fill it exactly, so the next join is the overflow one
        // (data-model §6 scenario 11 — 201 coalescing deliveries).
        const deliveries = [
            createEvent(detection({
                issueNumber: ISSUE_FOUR,
                title: CAP_TITLE,
                kind: ASSIGNMENT_KIND,
                detectedAt: FIRST_DETECTED_AT,
            })),
            ...Array.from({ length: MAX_SOURCE_REFERENCES }, (_unused, index) =>
                createEvent(detection({
                    issueNumber: ISSUE_FOUR,
                    title: CAP_TITLE,
                    kind: MENTION_KIND,
                    commentId: index + 1,
                    detectedAt: FIRST_DETECTED_AT,
                }))),
        ];
        const planned = applyEnqueue({
            document: emptyRunsDocument(),
            deliveries,
            now: FIRST_DETECTED_AT,
        });
        expect(planned.document.runs).toHaveLength(1);

        const byId = new Map<string, QueuedEvent>();
        for (const delivery of deliveries) {
            byId.set(delivery.id, delivery);
        }

        const rows = projectRunHistory({ runs: planned.document.runs, deliveries: byId, cap: MAX_LISTED_EVENTS });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (row === undefined) {
            throw new Error('the cap fixture projected no row');
        }

        // The marker rides the row the operator reads, and what the cap kept
        // out stays out: a row that rendered as complete — or as an empty list
        // — would be exactly the silently lossy record T-038 forbids.
        expect(row.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);
        expect(row.referenceCount).toBe(MAX_SOURCE_REFERENCES + 1);
        expect(row.referencesNotRetained).toBe(1);
        expect(row.referencesTruncated).toBe(true);
        const overflowId = deliveries.at(-1)?.id ?? '';
        expect(overflowId).not.toBe('');
        expect(row.sourceReferences.some((reference) => reference.deliveryId === overflowId)).toBe(false);
        expect(row.state).toBe('pending');
        expect(row.issueTitle).toBe(CAP_TITLE);
    });
});

describe('T-025 the history row names the sources and never the text (FR-052, FR-087)', () => {
    /** The global tier's instruction, stacked into the fixture snapshot. */
    const GLOBAL_TIER_TEXT = 'Always reproduce the failure before patching.';

    /** The binding tier's instruction, stacked after the global one. */
    const BINDING_TIER_TEXT = 'Reproduce first, then patch. Do not widen the public API.';

    /** Detection stamp the prompted fixture opens with. */
    const PROMPT_DETECTED_AT = '2026-09-28T12:00:00.000Z';

    /**
     * The snapshot the prompted fixture queues under — resolved exactly as the
     * scan resolves one at detection (004 FR-080), with the global and binding
     * tiers set and the account tier unset.
     *
     * @returns The composed snapshot, sources included.
     * @throws {Error} When the fixture tiers resolve to no snapshot.
     */
    function stackedSnapshot(): PromptSnapshot {
        const snapshot = resolvePromptSnapshot({
            global: { startingPrompt: GLOBAL_TIER_TEXT },
            account: null,
            binding: { startingPrompt: BINDING_TIER_TEXT },
        });
        if (snapshot === null) {
            throw new Error('the fixture tiers resolved to no snapshot');
        }

        return snapshot;
    }

    it('projects the snapshot’s ordered promptSources for a post-amendment run', async () => {
        const service = await startSeededService();
        const snapshot = stackedSnapshot();
        // The resolution really stacked both tiers, so what follows is an
        // assertion about a body that carries both texts, not a lone tier.
        expect(snapshot.sources).toEqual(['global', 'binding']);
        expect(snapshot.text).toContain(GLOBAL_TIER_TEXT);
        expect(snapshot.text).toContain(BINDING_TIER_TEXT);

        await enqueueRun(detection({
            issueNumber: ISSUE_ONE,
            title: PARSER_TITLE,
            kind: ASSIGNMENT_KIND,
            detectedAt: PROMPT_DETECTED_AT,
        }), snapshot);

        const { row, text } = await onlyRow(service);
        // The pre-amendment trio stands exactly as it did (FR-052: no field is
        // removed), and the new member carries the snapshot's own list.
        expect(row.promptPresent).toBe(true);
        expect(row.promptFingerprint).toBe(snapshot.fingerprint);
        expect(row.promptLength).toBe(snapshot.length);
        expect(Object.hasOwn(row, 'promptSources')).toBe(true);
        expect(row.promptSources).toEqual(['global', 'binding']);

        // Nothing else moved: every member 003's contract names is still here.
        for (const member of CONTRACT_MEMBERS) {
            expect(Object.hasOwn(row, member), `row must still carry ${member}`).toBe(true);
        }

        // The row never carries the text — the key is absent, not null — and
        // neither tier's words reach the answer's bytes (FR-052, FR-053).
        expect(Object.hasOwn(row, 'promptText')).toBe(false);
        expect(Object.keys(row)).not.toContain('promptText');
        expect(text).not.toContain('promptText');
        expect(text).not.toContain(GLOBAL_TIER_TEXT);
        expect(text).not.toContain(BINDING_TIER_TEXT);
        expect(findSecretLeak(text)).toBeNull();
    });

    it('answers null sources for a run queued with no tier, the member still present', async () => {
        const service = await startSeededService();
        await enqueueRun(detection({
            issueNumber: ISSUE_ONE,
            title: PARSER_TITLE,
            kind: ASSIGNMENT_KIND,
            detectedAt: FIRST_DETECTED_AT,
        }));

        const { row, text } = await onlyRow(service);
        // Present with `null` — an own member on the wire, never an omitted
        // key a reader would have to default (FR-087: no absence-defaulting).
        expect(Object.hasOwn(row, 'promptSources')).toBe(true);
        expect(row.promptSources).toBeNull();
        expect(row.promptPresent).toBe(false);
        expect(row.promptFingerprint).toBeNull();
        expect(row.promptLength).toBeNull();
        expect(Object.hasOwn(row, 'promptText')).toBe(false);
        expect(text).not.toContain('promptText');
    });
});
