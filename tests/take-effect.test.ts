/**
 * Take-effect observations (006 T-027; FR-031, FR-032, FR-037, FR-100(e),
 * FR-100(f); AC-104, AC-155, SC-106, SC-107; 002 FR-029).
 *
 * FR-031's rule is that a declared take-effect class is a **tested claim**,
 * and SC-107 is what keeps it one: a class declared with no observation must
 * fail a suite somewhere. This file is that somewhere, in two halves:
 *
 * 1. **The declaration is counted** (SC-106): over 006's own eleven fields the
 *    projection must read nine `next-cycle`, one `immediate`, one
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
 * in-flight verification keeps the baseline it started with, and a missing or
 * unreadable one falls back to the documented default **with its provenance
 * recorded** — never blocking a run on the baseline's own absence.
 *
 * Offline: fixtures, a fake host, and local files (FR-086).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { verifyAgentAfterDispatch } from '../src/agent-verify.ts';
import { DEFAULT_EXPECTED_AGENT } from '../src/config.ts';
import { CONFIG_PATH, verificationPath } from '../src/service-calls.ts';
import { takeEffectWords } from '../src/settings-rows.ts';
import type { TakeEffectClass } from '../src/settings-schema.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { SESSION_ID, createTestRuntime, fakeHost } from './support/panel.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The eleven fields 006 declares (AC-101, SC-106); 003's two are counted apart. */
const SPECS_006_FIELDS: readonly string[] = [
    'intervalMs',
    'logLevel',
    'overlapMs',
    'perPage',
    'retryMaxAttempts',
    'retryBaseMs',
    'retryMaxMs',
    'auditRetentionDays',
    'auditMaxEntries',
    'excerptRetentionDays',
    'expectedAgent',
];

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

/** Provenance recorded when the documented default supplied the baseline. */
const DEFAULTED = 'defaulted';

/** Provenance recorded when the stored document supplied the baseline. */
const CONFIGURED = 'configured';

/** The class nine of 006's fields declare: effective from the next poll cycle. */
const NEXT_CYCLE: TakeEffectClass = 'next-cycle';

/** The suite the three retry fields' ladder observation lives in. */
const BACKOFF_SUITE = 'tests/service-backoff.test.ts';

/** The observation the three retry fields share: every delay inside its bounds. */
const BACKOFF_MARKER = 'keeps every delay of a capped ladder inside [retryMaxMs / 2, retryMaxMs] (AC-148)';

/** One observation a field's consumer is proven by. */
interface Observation {
    /** The class the observation was written for. */
    readonly declared: TakeEffectClass;
    /** Repository-relative suite that observes the consumer. */
    readonly suite: string;
    /** A substring of that suite's own test titles: the observation itself. */
    readonly marker: string;
}

/**
 * Field → the observation that proves its consumer runs (SC-107).
 *
 * Every entry names a suite by path and a marker that suite must still carry,
 * so deleting or renaming the observation breaks this suite rather than
 * quietly leaving a class with nothing behind it. A field the projection gains
 * with no entry below fails `has an observation for every field it declares`.
 */
const OBSERVATIONS: Readonly<Record<string, Observation>> = {
    intervalMs: {
        declared: NEXT_CYCLE,
        suite: BACKOFF_SUITE,
        marker: 'arms the next cycle from the cycle end',
    },
    overlapMs: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-cycle-config.test.ts',
        marker: 'opens since at lastScanAt minus overlapMs',
    },
    perPage: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-cycle-config.test.ts',
        marker: 'asks for per_page=12 and stops at two pages',
    },
    retryMaxAttempts: {
        declared: NEXT_CYCLE,
        suite: BACKOFF_SUITE,
        marker: BACKOFF_MARKER,
    },
    retryBaseMs: {
        declared: NEXT_CYCLE,
        suite: BACKOFF_SUITE,
        marker: BACKOFF_MARKER,
    },
    retryMaxMs: {
        declared: NEXT_CYCLE,
        suite: BACKOFF_SUITE,
        marker: BACKOFF_MARKER,
    },
    auditRetentionDays: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-trim.test.ts',
        marker: 'removes only unprotected rows, oldest first',
    },
    auditMaxEntries: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-trim.test.ts',
        marker: 'removes only unprotected rows, oldest first',
    },
    excerptRetentionDays: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-excerpt-trim.test.ts',
        marker: 'clears and marks an old terminal row',
    },
    logLevel: {
        declared: 'immediate',
        suite: 'tests/service-config.test.ts',
        marker: 'logLevel is immediate',
    },
    expectedAgent: {
        declared: 'next-dispatch',
        suite: 'tests/agent-verify.test.ts',
        marker: 'T-027 the read-back reaches the service',
    },
    leaseMs: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-sweep.test.ts',
        marker: 'halves the shorter of the two durations for its cadence',
    },
    resultDeadlineMs: {
        declared: NEXT_CYCLE,
        suite: 'tests/service-sweep.test.ts',
        marker: 'halves the shorter of the two durations for its cadence',
    },
};

/**
 * Read one referenced suite.
 *
 * @param path - Repository-relative suite path.
 * @returns Its text.
 */
function suiteText(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}

/** The projected descriptor for one field, failing loudly when absent. */
function descriptorOf(name: string): ReturnType<typeof configSchema>[number] {
    const descriptor = configSchema().find((entry) => entry.name === name);
    if (descriptor === undefined) {
        throw new Error(`the projection declares no ${name} row`);
    }

    return descriptor;
}

describe('SC-106: eleven fields, eleven consumers, zero inert rows', () => {
    it('counts 006\'s own eleven as nine next-cycle, one immediate, one next-dispatch', () => {
        const histogram = new Map<string, number>();
        for (const name of SPECS_006_FIELDS) {
            const { takesEffect } = descriptorOf(name);
            histogram.set(takesEffect, (histogram.get(takesEffect) ?? 0) + 1);
        }

        expect(histogram.get(NEXT_CYCLE)).toBe(9);
        expect(histogram.get('immediate')).toBe(1);
        expect(histogram.get('next-dispatch')).toBe(1);
        expect(histogram.get('restart')).toBeUndefined();
        expect(histogram.get('none')).toBeUndefined();
    });

    it('AC-104: every declared class is one this build delivers, in words that say so', () => {
        for (const name of SPECS_006_FIELDS) {
            const { takesEffect } = descriptorOf(name);
            const words = takeEffectWords(takesEffect);

            expect(words).not.toBe('');
            expect(words).not.toBe('no take-effect boundary declared');
            expect(words).not.toContain('changes nothing in this build');
        }
    });

    it('keeps the closed vocabulary renderable for the class nobody declares', () => {
        // The `none` harness: a genuinely inert field would still be *labelled*
        // honestly rather than silently — and the observation check below is
        // what refuses to let one ship unnoticed.
        expect(takeEffectWords('none')).toBe('no take-effect boundary declared');
        expect(takeEffectWords('restart')).toBe('in effect after a service restart');
    });
});

describe('SC-107: a declared class with no backing observation fails', () => {
    it('has an observation for every field the projection carries', () => {
        for (const descriptor of configSchema()) {
            expect(OBSERVATIONS[descriptor.name], `${descriptor.name} has no observation`).toBeDefined();
        }
    });

    it('still finds the observation each field points at', () => {
        for (const [name, observation] of Object.entries(OBSERVATIONS)) {
            const path = resolve(ROOT, observation.suite);
            expect(existsSync(path), `${name} points at a suite that is gone`).toBe(true);
            expect(
                suiteText(observation.suite),
                `${name}'s observation is no longer in ${observation.suite}`,
            ).toContain(observation.marker);
        }
    });

    it('declares the class the projection declares — a moved class fails here', () => {
        for (const [name, observation] of Object.entries(OBSERVATIONS)) {
            expect(
                descriptorOf(name).takesEffect,
                `${name}'s class moved without its observation moving`,
            ).toBe(observation.declared);
        }
    });
});

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
 * @returns The response body.
 */
function configBody(expectedAgent?: string): string {
    const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
    if (expectedAgent === undefined) {
        delete config.expectedAgent;
    } else {
        config.expectedAgent = expectedAgent;
    }

    return JSON.stringify({ config });
}

/**
 * The report the verification posted, parsed from the recorded bodies.
 *
 * @param run - The run to read.
 * @returns The POST body.
 */
function reportOf(run: VerificationRun): Record<string, unknown> {
    const index = run.calls.findIndex((call) => call.startsWith('POST '));
    const body = index < 0 ? undefined : run.bodies[index];
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
 * @param run - The scripted run.
 * @param id - The run's correlation identifier.
 * @returns The verification's promise.
 */
function startVerification(run: VerificationRun, id: string): Promise<void> {
    return verifyAgentAfterDispatch({ rt: run.rt, correlationId: id, attempt: 1, sessionId: SESSION });
}

describe('AC-155 / FR-100(e): next-dispatch reads the saved baseline per verification', () => {
    it('compares against the saved value with no restart and no cycle boundary between', async () => {
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
    });

    it('a verification already in flight keeps the baseline it started with', async () => {
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
    });

    it('defaults to the documented agent with its provenance recorded, and never blocks on it', async () => {
        const run = verificationRun(DEFAULT_EXPECTED_AGENT);
        run.setConfig(configBody());

        await startVerification(run, `${RUN_ID}-missing`);

        // The default is the documented one, pinned to the service's own
        // declaration rather than retyped (002 FR-029, plan X7).
        expect(DEFAULT_EXPECTED_AGENT).toBe(DEFAULT_CONFIG.expectedAgent);
        expect(reportOf(run)).toMatchObject({ expectedAgent: DEFAULT_EXPECTED_AGENT, ok: true });

        const entry = run.rt.state.ledger.entries.at(-1);
        expect(entry?.detail.baselineProvenance).toBe(DEFAULTED);
        expect(entry?.detail.agentVerified).toBe(true);
        // The outcome records *which* baseline was used — and a defaulted one
        // that matched leaves the run verified rather than blocked.
        expect(entry?.detail.verification).toBe('match');
    });

    it('defaults the same way when the read itself fails', async () => {
        const run = verificationRun(DEFAULT_EXPECTED_AGENT);
        run.setConfig(null);

        await startVerification(run, `${RUN_ID}-unreadable`);

        expect(reportOf(run)).toMatchObject({ expectedAgent: DEFAULT_EXPECTED_AGENT, ok: true });
        expect(run.rt.state.ledger.entries.at(-1)?.detail.baselineProvenance).toBe(DEFAULTED);
    });

    it('warns — and does not block — when the observed agent differs from a defaulted baseline', async () => {
        const run = verificationRun('executor');
        run.setConfig(null);

        await startVerification(run, `${RUN_ID}-mismatch`);

        const entry = run.rt.state.ledger.entries.at(-1);
        expect(entry?.detail.baselineProvenance).toBe(DEFAULTED);
        expect(entry?.detail.agentVerified).toBe(false);
        // Warn-only: the banner carries the mismatch, and no run state was
        // written — a baseline problem is never a block (002 FR-029).
        expect(run.rt.state.dispatches.agentNotice?.tone).toBe('warning');
        expect(reportOf(run)).toMatchObject({ ok: false, expectedAgent: DEFAULT_EXPECTED_AGENT });
    });
});
