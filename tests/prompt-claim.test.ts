/**
 * The prompt on the wire: the claim answer, the two audit rows, and the run
 * projection (004 T-007/T-008; FR-015, FR-037, FR-050, FR-052, AC-139,
 * SC-124).
 *
 * Everything here is **additive and credential-free**: four members on a claim
 * entry, four `details` keys on the two rows that record what was sent, three
 * on a run-history row. What is asserted is that those additions carry a
 * *reference* — presence, fingerprint, length — and never the instruction
 * itself, on any surface, at any size:
 *
 * - an unset run answers the five members explicitly (`false`, `null`,
 *   `null`, `null`, `null`), because the co-ship build parses them;
 * - a maximal claim batch still fits inside `GUEST_REQUEST_RESPONSE_MAX`;
 * - `dispatch.reserved` and `dispatch.result` both name the binding and the
 *   fingerprint, under the run's own correlation id;
 * - a correlation-filtered `GET /v1/audit` surfaces them (SC-124), and the
 *   run-history row shows the trio with no text anywhere in it.
 *
 * Offline: the real loopback service on a temp directory, fixed stamps, no
 * network and no timers.
 */

import { GUEST_REQUEST_RESPONSE_MAX } from '@openchamber/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { DISPATCHED_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH } from '../service/routes/events.ts';
import { promptFingerprint, resolvePromptSnapshot } from '../service/prompt.ts';
import { findSecretLeak } from '../src/redaction.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import { startTestService } from './support/service.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';
import type { TestService } from './support/service.ts';

/** Stamp every fixture uses, so no test ever waits on a clock. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** Binding every fixture detection names. */
const BINDING_ID = 'bnd-wire';

/** The instruction this suite puts on runs. */
const PROMPT = 'Reproduce first, then patch. Keep the public API stable.';

/** The cap-length instruction the batch fixture uses. */
const MAX_PROMPT = 'x'.repeat(2_000);

/** One run this suite claimed: the coordinates every later call needs. */
interface Attempt {
    /** The run's correlation id, which every path and body is addressed by. */
    readonly correlationId: string;
    /** Attempt the claim leased under. */
    readonly attempt: number;
    /** Lease the reserve must be made under. */
    readonly leaseId: string;
}

/**
 * Build the header map the run-scoped operations take.
 *
 * @param pairs - Header name/value pairs.
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/** The two rows that record what was sent (004 `### Audit Vocabulary Delta`). */
const SENT_ROWS = ['dispatch.reserved', 'dispatch.result'] as const;

/** Log sink for the enqueue calls; nothing here asserts on it. */
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
});

/** The store the harness instance is serving, already open. */
function storeOf(service: TestService): NonNullable<TestService['handle']['store']> {
    const { store } = service.handle;
    if (store === null) {
        throw new Error('the harness started without a store');
    }

    return store;
}

/** Start the real service against the offline GitHub fixture. */
async function startService(): Promise<TestService> {
    const service = await startTestService();
    running.push(service);
    await service.handle.reconciled;
    // The gate reads `bindings.json` at authorization and denies when it cannot
    // (003 FR-076); the open policy keeps every "what was sent" assertion here
    // about the prompt rather than the allow-list (002 FR-047).
    await writeOpenBinding({ store: storeOf(service), bindingId: BINDING_ID });

    return service;
}

/** Build an assignment detection for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: `body of issue ${issueNumber}`,
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** What one seeding of this suite performs. */
interface SeedInput {
    /** Harness instance whose store receives the detections. */
    readonly service: TestService;
    /** The binding's prompt, or `null` for a run queued with none. */
    readonly prompt: string | null;
    /** The detections to enqueue. */
    readonly snapshots: readonly EventSnapshot[];
}

/** Enqueue detections through the production path, optionally with a prompt. */
async function seed(input: SeedInput): Promise<void> {
    const { service, snapshots } = input;
    const snapshot = input.prompt === null
        ? null
        : resolvePromptSnapshot({ global: null, account: null, binding: { startingPrompt: input.prompt } });
    await enqueueEvents({
        store: storeOf(service),
        log: LOGGER,
        incoming: snapshots.map(createEvent),
        ...(snapshot !== null && { prompt: snapshot }),
    });
}

/** One run this suite claimed: the coordinates every later call needs. */
interface Attempt {
    /** The run's correlation id, which every path and body is addressed by. */
    readonly correlationId: string;
    /** Attempt the claim leased under. */
    readonly attempt: number;
    /** Lease the reserve must be made under. */
    readonly leaseId: string;
}

/**
 * Claim through the route and return the first offered run's coordinates.
 *
 * @param service - Harness instance.
 * @param query - Optional query string for the claim.
 * @returns The coordinates, or a failure when nothing was offered.
 */
async function claimFirst(service: TestService, query = ''): Promise<Attempt> {
    const response = await service.call(`${EVENTS_PENDING_PATH}${query}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly events: readonly Record<string, unknown>[] };
    const [row] = body.events;
    if (row === undefined) {
        throw new Error('the claim offered no run');
    }

    const lease = row.lease as { readonly leaseId: string };

    return {
        correlationId: String(row.correlationId),
        attempt: row.attempt as number,
        leaseId: lease.leaseId,
    };
}

/** What one dispatched attempt of this suite performs. */
interface DispatchInput {
    /** Session the report claims the host call created. */
    readonly sessionId: string;
    /** Optional query string for the claim that precedes it. */
    readonly query?: string;
}

/** Claim, reserve, and report one dispatched attempt; returns its coordinates. */
async function dispatchOnce(service: TestService, input: DispatchInput): Promise<Attempt> {
    const attempt = await claimFirst(service, input.query ?? '');
    const scoped = (suffix: string): string =>
        suffix.replace(':correlationId', encodeURIComponent(attempt.correlationId));

    const reserve = await service.call(scoped(RESERVE_PATH), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
            correlationId: attempt.correlationId,
            leaseId: attempt.leaseId,
            attempt: attempt.attempt,
        }),
    });
    if (reserve.status !== 200) {
        throw new Error(`reserve answered ${reserve.status}: ${await reserve.text()}`);
    }
    const reservation = (await reserve.json()) as { readonly dispatchToken: string };

    const report = await service.call(scoped(DISPATCHED_PATH), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
            correlationId: attempt.correlationId,
            attempt: attempt.attempt,
            dispatchToken: reservation.dispatchToken,
            sessionId: input.sessionId,
        }),
    });
    if (report.status !== 200) {
        throw new Error(`result report answered ${report.status}: ${await report.text()}`);
    }

    return attempt;
}

/** Every stored row of one event type, as plain records. */
async function rowsOf(service: TestService, eventType: string): Promise<readonly Record<string, unknown>[]> {
    const entries = await readAuditEntries(storeOf(service));

    return entries
        .filter((entry) => entry.eventType === eventType)
        .map((entry) => JSON.parse(JSON.stringify(entry)) as Record<string, unknown>);
}

describe('T-007 the claim answer carries the five prompt members (FR-015, FR-037, FR-087)', () => {
    it('answers all five explicitly when the run queued with no prompt', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: null, snapshots: [assignment(1)] });

            const response = await service.call(EVENTS_PENDING_PATH);
            expect(response.status).toBe(200);
            const body = (await response.json()) as { readonly events: readonly Record<string, unknown>[] };
            const [row] = body.events;
            expect(row).toBeDefined();
            expect(row?.promptPresent).toBe(false);
            expect(row?.promptFingerprint).toBeNull();
            expect(row?.promptLength).toBeNull();
            expect(row?.promptSources).toBeNull();
            expect(row?.promptText).toBeNull();
        }
    });

    it('carries the text for transport only, with the reference beside it', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: PROMPT, snapshots: [assignment(2)] });

            const response = await service.call(EVENTS_PENDING_PATH);
            const text = await response.text();
            const body = JSON.parse(text) as { readonly events: readonly Record<string, unknown>[] };
            const [row] = body.events;
            expect(row?.promptPresent).toBe(true);
            expect(row?.promptFingerprint).toBe(promptFingerprint(PROMPT));
            expect(row?.promptLength).toBe([...PROMPT].length);
            // The binding tier seeded this run, so the list is that one source (FR-087).
            expect(row?.promptSources).toEqual(['binding']);
            expect(row?.promptText).toBe(PROMPT);
            // The reference is an identity, never a credential.
            expect(findSecretLeak(text)).toBeNull();
        }
    });

    it('keeps a maximal batch inside the transport response cap', async () => {
        {
            const service = await startService();
            const issues = Array.from({ length: 50 }, (_unused, index) => assignment(index + 1));
            await seed({ service, prompt: MAX_PROMPT, snapshots: issues });

            const response = await service.call(`${EVENTS_PENDING_PATH}?holder=maximal-batch`);
            expect(response.status).toBe(200);
            const text = await response.text();
            const body = JSON.parse(text) as { readonly events: readonly Record<string, unknown>[] };
            expect(body.events).toHaveLength(50);
            expect(text.length).toBeLessThan(GUEST_REQUEST_RESPONSE_MAX);
            expect(body.events.every((row) => row.promptPresent === true)).toBe(true);
            expect(findSecretLeak(text)).toBeNull();
        }
    });

    it('leaves eligibility, the lease, and the claim row to 003 unchanged', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: PROMPT, snapshots: [assignment(3)] });

            const attempt = await claimFirst(service);
            expect(attempt.leaseId).toMatch(/^lse-[0-9a-f]{24}$/);
            // `dispatch.claimed` is 003's row: no prompt member joined it.
            const claimed = await rowsOf(service, 'dispatch.claimed');
            expect(claimed).toHaveLength(1);
            expect(Object.keys(claimed[0]?.details as Record<string, unknown>)).not.toContain('promptFingerprint');
        }
    });

});

describe('T-008 the two "what was sent" rows and the run projection (FR-050, FR-052, AC-139)', () => {
    it('names the binding and the fingerprint on both rows, under the run’s id', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: PROMPT, snapshots: [assignment(4)] });
            const attempt = await dispatchOnce(service, { sessionId: 'ses_prompt_wire' });

            for (const eventType of SENT_ROWS) {
                const rows = await rowsOf(service, eventType);
                expect(rows, `${eventType} must appear`).toHaveLength(1);
                const details = rows[0]?.details as Record<string, unknown>;
                expect(details.bindingId).toBe(BINDING_ID);
                expect(details.promptPresent).toBe(true);
                expect(details.promptFingerprint).toBe(promptFingerprint(PROMPT));
                expect(details.promptLength).toBe([...PROMPT].length);
                expect(rows[0]?.correlationId).toBe(attempt.correlationId);
                expect(rows[0]?.entity).toEqual({ kind: 'run', id: attempt.correlationId });
            }

            // No row in the whole trail carries the instruction (AC-139), and no
            // row names the transport member either — the text lives on the claim
            // answer alone (004 FR-053, T-027's secret-surface scan).
            const trail = await readAuditEntries(storeOf(service));
            const trailText = JSON.stringify(trail);
            expect(trailText).not.toContain(PROMPT);
            expect(trailText).not.toContain('promptText');
        }
    });

    it('surfaces those rows from a correlation-filtered audit read', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: PROMPT, snapshots: [assignment(5)] });
            const attempt = await dispatchOnce(service, { sessionId: 'ses_prompt_sc' });

            const response = await service.call(
                `${AUDIT_PATH}?correlationId=${encodeURIComponent(attempt.correlationId)}`,
            );
            expect(response.status).toBe(200);
            const text = await response.text();
            const body = JSON.parse(text) as { readonly entries: readonly Record<string, unknown>[] };
            const types = body.entries.map((entry) => entry.eventType);
            for (const eventType of SENT_ROWS) {
                expect(types).toContain(eventType);
            }

            const reserved = body.entries.find((entry) => entry.eventType === 'dispatch.reserved');
            expect((reserved?.details as Record<string, unknown>).promptFingerprint).toBe(promptFingerprint(PROMPT));
            // The answer to "which prompt produced this run" never needs the text.
            expect(text).not.toContain(PROMPT);
        }
    });

    it('projects presence, fingerprint, and length — and no text — on the run row', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: PROMPT, snapshots: [assignment(6)] });
            await claimFirst(service);

            const response = await service.call(EVENTS_PATH);
            expect(response.status).toBe(200);
            const text = await response.text();
            const body = JSON.parse(text) as { readonly events: readonly Record<string, unknown>[] };
            const [row] = body.events;
            expect(row?.promptPresent).toBe(true);
            expect(row?.promptFingerprint).toBe(promptFingerprint(PROMPT));
            expect(row?.promptLength).toBe([...PROMPT].length);
            expect(row?.promptSources).toEqual(['binding']);
            expect(text).not.toContain(PROMPT);
            expect(findSecretLeak(text)).toBeNull();
        }
    });

    it('projects a run queued with no prompt as false / null / null / null', async () => {
        {
            const service = await startService();
            await seed({ service, prompt: null, snapshots: [assignment(7)] });
            await claimFirst(service);

            const response = await service.call(EVENTS_PATH);
            const body = (await response.json()) as { readonly events: readonly Record<string, unknown>[] };
            const [row] = body.events;
            expect(row?.promptPresent).toBe(false);
            expect(row?.promptFingerprint).toBeNull();
            expect(row?.promptLength).toBeNull();
            expect(row?.promptSources).toBeNull();
        }
    });

});
