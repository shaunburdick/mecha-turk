/**
 * Take-effect observations (006 T-027; FR-031, FR-032, FR-037, FR-100(e),
 * FR-100(f); AC-104, AC-155, SC-106, SC-107; 002 FR-029).
 *
 * FR-031's rule is that a declared take-effect class is a **tested claim**,
 * and SC-107 is what keeps it one: a class declared with no observation must
 * fail a suite somewhere. This file is that somewhere, in two halves:
 *
 * 1. **The declaration is counted** (SC-106): over 006's own twelve fields the
 *    projection must read ten `next-cycle`, one `immediate`, one
 *    `next-dispatch`, zero `restart`, zero `none`.
 * 2. **Every field the projection carries is pointed at the observation that
 *    proves its consumer runs** (SC-107). The observations themselves live
 *    where the consumers live — the widened `since` and the configured
 *    `per_page` with the cycle read, the backoff ladder with the loop, both
 *    trim passes with their passes, the level with the logger, the sweep
 *    cadence with the sweep, the baseline with `agent-verify.ts` — so this
 *    suite **references** them rather than running them a second time, and
 *    fails when a referenced suite loses its marker or when a field gains a
 *    class nobody wrote an observation for.
 *
 * The `next-dispatch` class is observed here directly (AC-155), because it is
 * the one class whose consumer the panel owns end to end: a saved baseline is
 * read per verification, with no restart and no cycle boundary in between, an
 * in-flight verification keeps the baseline it started with, and a missing,
 * unreadable, or explicitly **blank** one means **no comparison is possible** —
 * the read-back still records the observed agent with its provenance
 * (`defaulted` or `unset`), never blocks a run on the baseline's own absence,
 * and never claims a mismatch from an absence either (002 FR-029 as amended at
 * v1.10.0).
 *
 * Offline: fixtures, a fake host, and local files (FR-086).
 */

import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { verifyAgentAfterDispatch } from '../src/agent-verify.ts';
import { DEFAULT_EXPECTED_AGENT } from '../src/config.ts';
import { CONFIG_PATH, verificationPath } from '../src/service-calls.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { SESSION_ID, createTestRuntime, fakeHost } from './support/panel.ts';

/** The run this file's verifications report against. */
const RUN_ID = 'mt-run-take-effect-1';

/** The session every read-back observes. */
const SESSION = SESSION_ID;

/** How the configured baseline is read, once per verification. */
const GET_CONFIG = `GET ${CONFIG_PATH}`;

/** The baseline the operator saved, so its literals appear once. */
const SAVED_AGENT = 'other-agent';

/** The baseline one in-flight verification started with. */
const FIRST_AGENT = 'first-agent';

/** The agent the fixture session reports — nobody pinned it until a config says so. */
const REPORTED_AGENT = 'project-manager';

/** Provenance recorded when the documented default supplied the baseline. */
const DEFAULTED = 'defaulted';

/** Provenance recorded when the stored document supplied the baseline. */
const CONFIGURED = 'configured';

/** Provenance recorded when the document itself carried a blank baseline. */
const UNSET = 'unset';

/** One scripted verification run against a fake host. */
interface VerificationRun {
    /** Runtime the verification records into. */
    readonly rt: PanelRuntime;
    /** Every call the verification made, in order. */
    readonly calls: string[];
    /** Bodies the calls carried, in the same order. */
    readonly bodies: (string | undefined)[];
    /** How many configuration reads have happened. */
    readonly reads: () => number;
    /** Replace the document `GET /v1/config` answers with; `null` makes it fail. */
    setConfig: (body: string | null) => void;
}

/**
 * Build a host whose verification path is fully scripted.
 *
 * @param agent - The agent the opened session reports.
 * @returns The runtime, the recorded calls, and the config script.
 */
function verificationRun(agent: string): VerificationRun {
    const calls: string[] = [];
    const bodies: (string | undefined)[] = [];
    let scriptedBody: string | null = null;
    let reads = 0;
    let listener: ((snapshot: SessionSnapshot | null) => void) | null = null;
    /** Note one host-side call, keeping `calls` and `bodies` index-aligned. */
    const note = (call: string): void => {
        calls.push(call);
        bodies.push(undefined);
    };

    const host = fakeHost({
        onSession: (next) => {
            note('onSession');
            listener = next;

            return () => {
                note('unsubscribe');
            };
        },
        openSession: async (id) => {
            note(`openSession:${id}`);
            listener?.({
                id,
                title: 'Take the effect',
                busy: false,
                agent,
            });
        },
        serviceRequest: async (request) => {
            calls.push(`${request.method} ${request.path}`);
            bodies.push(request.body);
            if (request.method === 'GET' && request.path === CONFIG_PATH) {
                reads += 1;

                return scriptedBody === null
                    ? { status: 503, body: '{"error":{"code":"storage-unavailable"}}' }
                    : { status: 200, body: scriptedBody };
            }

            return { status: 200, body: '{"verification":{"ok":true}}' };
        },
    });

    return {
        rt: createTestRuntime(host),
        calls,
        bodies,
        reads: () => reads,
        setConfig: (body) => {
            scriptedBody = body;
        },
    };
}

/**
 * The body `GET /v1/config` answers with for one baseline.
 *
 * @param expectedAgent - The stored baseline; omit it to model a document
 *   written before the field existed (AC-155's missing-baseline case).
 */
function configBody(expectedAgent?: string): string {
    const base = Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([key]) => key !== 'expectedAgent'));
    const config = expectedAgent === undefined ? base : { ...base, expectedAgent };

    return JSON.stringify({ config });
}

/**
 * The report the verification posted, parsed from the recorded bodies.
 *
 * @returns The POST body.
 */
function reportOf(run: VerificationRun): Record<string, unknown> {
    const index = run.calls.findIndex((call) => call.startsWith('POST '));
    const body = index === -1 ? undefined : run.bodies[index];
    if (body === undefined) {
        throw new Error('the verification never reported to the service');
    }

    return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Start one verification against a scripted run, without awaiting it.
 *
 * The baseline read happens inside the call's own synchronous prefix, so a
 * caller can change the scripted document the moment this returns — which is
 * what makes "already in flight" an observable state rather than a claim.
 *
 * @returns The verification's promise.
 */
function startVerification(run: VerificationRun, id: string): Promise<void> {
    return verifyAgentAfterDispatch({ rt: run.rt, correlationId: id, attempt: 1, sessionId: SESSION });
}

describe('AC-155 / FR-100(e): next-dispatch reads the saved baseline per verification', () => {
    it('compares against the saved value with no restart and no cycle boundary between', async () => {
        {
            const run = verificationRun(SAVED_AGENT);
            run.setConfig(configBody(SAVED_AGENT));

            await startVerification(run, RUN_ID);

            // Exactly the baseline read and the report: no restart exists to
            // perform, and nothing polls a cycle in between — the value read for
            // *this* dispatch is the value compared.
            expect(run.calls).toEqual([
                GET_CONFIG,
                'onSession',
                `openSession:${SESSION}`,
                'unsubscribe',
                `POST ${verificationPath(RUN_ID)}`,
            ]);
            expect(run.reads()).toBe(1);
            expect(reportOf(run)).toMatchObject({ expectedAgent: SAVED_AGENT, ok: true });

            const entry = run.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.expectedAgent).toBe(SAVED_AGENT);
            expect(entry?.detail.baselineProvenance).toBe(CONFIGURED);
            expect(entry?.detail.agentVerified).toBe(true);
        }
    });

    it('a verification already in flight keeps the baseline it started with', async () => {
        {
            const run = verificationRun(FIRST_AGENT);
            run.setConfig(configBody(FIRST_AGENT));
            // The first read has already happened by the time this returns, so the
            // document changes while that verification sits between its read and
            // its report.
            const first = startVerification(run, `${RUN_ID}-a`);
            run.setConfig(configBody('second-agent'));
            const second = startVerification(run, `${RUN_ID}-b`);
            await Promise.all([first, second]);

            const reports = run.calls
                .map((call, index) => ({ call, body: run.bodies[index] }))
                .filter((entry) => entry.call.startsWith('POST '))
                .map((entry) => JSON.parse(entry.body ?? '{}') as Record<string, unknown>)
                .map((body) => body.expectedAgent);

            expect(reports).toEqual([FIRST_AGENT, 'second-agent']);
            // Two verifications, two reads — each took its own baseline at its own
            // start, and neither borrowed the other's.
            expect(run.reads()).toBe(2);
        }
    });

    it('records a defaulted blank baseline and compares nothing when the field is absent', async () => {
        {
            const run = verificationRun(REPORTED_AGENT);
            run.setConfig(configBody());

            await startVerification(run, `${RUN_ID}-missing`);

            // The default is the documented one, pinned to the service's own
            // declaration rather than retyped (002 FR-029, plan X7) — and since
            // 006 v1.5.0 / 002 v1.10.0 it is **blank**, so this read-back has
            // nothing to compare the observed agent against.
            expect(DEFAULT_EXPECTED_AGENT).toBe(DEFAULT_CONFIG.expectedAgent);
            expect(DEFAULT_EXPECTED_AGENT).toBe('');
            expect(reportOf(run)).toMatchObject({ expectedAgent: '', ok: false });

            const entry = run.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.baselineProvenance).toBe(DEFAULTED);
            expect(entry?.detail.agentVerified).toBe(false);
            // The outcome records *which* baseline was in force — an absence is
            // named as one, never as a match and never as a mismatch.
            expect(entry?.detail.verification).toBe('uncompared');
            expect(run.rt.state.dispatches.agentNotice?.tone).toBe('info');
        }
    });

    it('answers the same blank baseline when the read itself fails', async () => {
        {
            const run = verificationRun(REPORTED_AGENT);
            run.setConfig(null);

            await startVerification(run, `${RUN_ID}-unreadable`);

            expect(reportOf(run)).toMatchObject({ expectedAgent: '', ok: false });
            expect(run.rt.state.ledger.entries.at(-1)?.detail.baselineProvenance).toBe(DEFAULTED);
        }
    });

    it('reads an explicitly blank baseline as `unset` — the operator\'s own answer', async () => {
        {
            const run = verificationRun(REPORTED_AGENT);
            run.setConfig(configBody(''));

            await startVerification(run, `${RUN_ID}-unset`);

            expect(reportOf(run)).toMatchObject({ expectedAgent: '', ok: false });
            const entry = run.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.expectedAgent).toBe('');
            expect(entry?.detail.baselineProvenance).toBe(UNSET);
            expect(entry?.detail.verification).toBe('uncompared');
            expect(run.rt.state.dispatches.agentNotice?.tone).toBe('info');
        }
    });

    it('warns — and does not block — when the observed agent differs from a configured baseline', async () => {
        {
            const run = verificationRun('executor');
            run.setConfig(configBody(SAVED_AGENT));

            await startVerification(run, `${RUN_ID}-mismatch`);

            const entry = run.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.baselineProvenance).toBe(CONFIGURED);
            expect(entry?.detail.agentVerified).toBe(false);
            // Warn-only: the banner carries the mismatch, and no run state was
            // written — a baseline problem is never a block (002 FR-029).
            expect(run.rt.state.dispatches.agentNotice?.tone).toBe('warning');
            expect(reportOf(run)).toMatchObject({ ok: false, expectedAgent: SAVED_AGENT });
        }
    });

});
