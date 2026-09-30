/**
 * Refusals, failures, and the audit outcome the panel owes the operator
 * (006 T-023, T-024; FR-060 – FR-064, FR-070, FR-074; AC-129 – AC-134,
 * AC-137, AC-139, AC-140, SC-111, NFR-111).
 *
 * The rule every case here exists to prove is the one line that separates a
 * refusal from a failure: **`answer.code === 'validation'`**. A `503`, a
 * `401`, a dropped connection, and an undocumented `500` are four *causes*,
 * each with its own copy — never "the service refused your values", which
 * would send an operator back to re-edit a document that was fine (FR-063).
 *
 * What is asserted, per the spec:
 *
 * - **A read the service could not answer keeps the tab readable** (AC-129,
 *   AC-140, FR-089): static content stays, the reason is named, and there is
 *   not one input control or save affordance on the screen — because there is
 *   no document to edit.
 * - **Three read states, three distinct causes** (SC-111): unreachable, store
 *   unavailable, and grant absent each say something different.
 * - **A stale read says when the values were read and why the new one failed**
 *   (AC-134).
 * - **A failed write names its own cause and its correlation id** (AC-130 –
 *   AC-133), and never retries itself.
 * - **A save whose audit row never landed still shows as saved, plus a
 *   visible warning naming the row it did not get** (AC-139, FR-070).
 *
 * Offline: the SDK mounts record their props and `host.serviceRequest`
 * answers from the test (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { auditStatusText, parseAuditBody } from '../src/audit-view.ts';
import { auditPath } from '../src/service-calls.ts';
import {
    AUDIT_MISSING_LINE,
    FAILURE_LINES,
    readFailureBody,
    readStateLine,
    writeFailure,
    writeFailureLines,
} from '../src/settings-state.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { SettingsFailureCause } from '../src/settings-edit.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { DEFAULT_BODY, DEFAULT_STATUS, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => {
                        mounts.log.push({ key: `${key}:dispose`, props: undefined });
                    },
                };
            };
        }
    }

    return stubbed;
});

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** The notice wording the transport case must show verbatim (AC-129). */
const NOT_RUNNING = 'service not running — settings read-only';

/** The route both configuration methods use. */
const CONFIG_ROUTE = '/v1/config';

/** The machine code of a store the service could not open. */
const STORE_CODE = 'storage-unavailable';

/** The phrase that marks 002 FR-039's setup-prerequisite framing. */
const PREREQUISITE = 'setup prerequisite';

/** The audit event type a configuration write is recorded under (FR-070). */
const CONFIG_EVENT = 'config.changed';

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(config: Record<string, unknown> = { ...DEFAULT_CONFIG }): string {
    return JSON.stringify({ config, fields: configSchema(), source: 'stored', defaultsApplied: [] });
}

/** One error-envelope body carrying a machine code and, optionally, an id. */
function errorBody(code: string, correlationId?: string): string {
    const id = correlationId === undefined ? {} : { correlationId };

    return JSON.stringify({ error: { code, message: 'the write could not complete', ...id } });
}

/** One `422 validation` body, shaped the way the service sends it. */
const REFUSAL = JSON.stringify({
    error: {
        code: 'validation',
        message: 'set intervalMs to an integer between 15000 and 300000 milliseconds',
        issues: [
            { field: 'intervalMs', remediation: 'set intervalMs to an integer between 15000 and 300000 milliseconds' },
        ],
    },
});

/** What one mount of the Settings body recorded. */
interface SettingsMount {
    /** The runtime the body mounted against. */
    readonly rt: PanelRuntime;
    /** The shell's disposer for this body. */
    readonly dispose: () => void;
    /** Every request the tab made, in order. */
    readonly requests: readonly GuestRequest[];
}

/** One scripted answer for one request. */
type Answer = (request: GuestRequest) => GuestRequestResult;

/**
 * Every string the SDK mounts were handed, mount **and** update.
 *
 * @returns The strings, in record order.
 */
function recordedStrings(): readonly string[] {
    return mounts.log.flatMap((entry) => {
        const { props } = entry;
        if (typeof props === 'string') {
            return [props];
        }

        if (typeof props !== 'object' || props === null) {
            return [];
        }

        return Object.values(props).filter((value): value is string => typeof value === 'string');
    });
}

/**
 * The banner bodies this mount painted, newest last — the last one is the
 * failure notice whenever a read failed (FR-078).
 *
 * @returns The bodies.
 */
function bannerBodies(): readonly string[] {
    return mounts.log
        .filter((entry) => entry.key.startsWith('mountBanner'))
        .map((entry) => (entry.props as { readonly body?: unknown }).body)
        .filter((body): body is string => typeof body === 'string');
}

/**
 * The last banner body this mount painted: the failure notice.
 *
 * @returns The notice.
 */
function notice(): string {
    return bannerBodies().at(-1) ?? '';
}

/**
 * Mount only the Settings body against a scripted service.
 *
 * @param answer - How `host.serviceRequest` answers; throwing counts as a
 *   call that never reached the service.
 * @returns The runtime, the disposer, and the requests the tab made.
 */
async function mountSettings(answer: Answer): Promise<SettingsMount> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            return answer(request);
        },
    });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'settings');
    if (spec === undefined) {
        throw new Error('the Settings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Settings body mounted no disposer');
    }

    await tick();

    return { rt, dispose, requests };
}

/**
 * Mount a tab whose read succeeds, so the cases below are about the **write**.
 *
 * @param put - How `PUT /v1/config` answers.
 * @returns The mounted body.
 */
function mountForWrite(put: Answer): Promise<SettingsMount> {
    return mountSettings((request) => {
        if (request.method === 'GET' && request.path === CONFIG_ROUTE) {
            return { status: 200, body: envelopeBody() };
        }

        if (request.method === 'PUT' && request.path === CONFIG_ROUTE) {
            return put(request);
        }

        return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
    });
}

/**
 * Type into the interval field, then activate Save once and let it settle.
 *
 * @returns Resolves once the answer has been applied.
 */
async function saveOnce(): Promise<void> {
    const change = mounts.log.find(
        (mount) => mount.key === 'mountTextField'
            && (mount.props as { readonly label?: string }).label?.startsWith('intervalMs') === true,
    );
    if (change === undefined) {
        throw new Error('no control for intervalMs was mounted');
    }

    (change.props as { readonly onChange: (next: string) => void }).onChange('120000');
    const button = mounts.log.find(
        (mount) => mount.key === 'mountButton'
            && (mount.props as { readonly label?: string }).label === 'Save configuration',
    );
    if (button === undefined) {
        throw new Error('no save control was mounted');
    }

    (button.props as { readonly onClick: () => void }).onClick();
    await tick();
    await tick();
}

/**
 * How many input controls this mount painted (SC-111: zero in every case).
 *
 * @returns The count.
 */
function inputCount(): number {
    return mounts.log.filter((entry) => entry.key === 'mountTextField' || entry.key === 'mountSelect').length;
}

/** The unreachable read: a call that never reached the service (FR-063). */
const unreachableRead: Answer = () => {
    throw new Error('connection refused');
};

/** The store-unavailable read (002 FR-039's setup prerequisite). */
const storeRead: Answer = () => ({ status: 503, body: errorBody(STORE_CODE) });

/** The unauthorised read: no grant, and no workaround (constitution II). */
const grantRead: Answer = () => ({ status: 401, body: errorBody('unauthorized') });

describe('a read the service could not answer keeps the tab readable (AC-129, AC-140, FR-060)', () => {
    it('AC-129: an unreachable service reads *service not running — settings read-only*', async () => {
        const view = await mountSettings(unreachableRead);

        expect(notice()).toContain(NOT_RUNNING);
        expect(inputCount()).toBe(0);
        expect(view.rt.settingsUi?.saveBox.hidden).toBe(true);
        expect(view.rt.settingsUi?.armBox.hidden).toBe(true);
        view.dispose();
    });

    it('AC-140: static content and the reason are present, and no number that did not come from a read', async () => {
        const view = await mountSettings(unreachableRead);
        const rendered = recordedStrings().join('\n');

        expect(rendered).toContain('Settings');
        expect(rendered).toContain('No configuration has been read yet');
        expect(rendered).toContain('service unreachable');
        // The one digit this surface legitimately carries is the route's own
        // version segment; strip it and nothing numeric is left (AC-140).
        expect(rendered.replaceAll(CONFIG_ROUTE, '')).not.toMatch(/\d/);
        view.dispose();
    });

    it('SC-111: three read states, three distinct causes, no input control in any of them', async () => {
        const answers: readonly Answer[] = [unreachableRead, storeRead, grantRead];
        const painted: string[] = [];
        for (const answer of answers) {
            const view = await mountSettings(answer);
            painted.push(notice());
            expect(inputCount()).toBe(0);
            expect(view.requests).toHaveLength(1);
            view.dispose();
        }

        expect(new Set(painted).size).toBe(3);
        expect(painted[0]).toContain(NOT_RUNNING);
        expect(painted[1]).toContain(PREREQUISITE);
        expect(painted[2]).toContain('not authorised');
    });
});

describe('a failed read marks the values it keeps (006 AC-134)', () => {
    it('AC-134: the values stay visible, marked stale, with the cause named', async () => {
        let reads = 0;
        const view = await mountSettings((request) => {
            if (request.method !== 'GET' || request.path !== CONFIG_ROUTE) {
                return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
            }

            reads += 1;

            return reads === 1
                ? { status: 200, body: envelopeBody() }
                : { status: 503, body: errorBody(STORE_CODE) };
        });
        expect(view.rt.state.settingsTab.stale).toBe(false);

        // The tab's own re-read control: the second read fails.
        const refresh = mounts.log.find(
            (mount) => mount.key === 'mountButton'
                && (mount.props as { readonly label?: string }).label === 'Refresh configuration',
        );
        if (refresh === undefined) {
            throw new Error('no re-read control was mounted');
        }

        (refresh.props as { readonly onClick: () => void }).onClick();
        await tick();

        const slice = view.rt.state.settingsTab;
        expect(slice.stale).toBe(true);
        // The document is still there, so the rows are still on screen…
        expect(slice.doc).not.toBeNull();
        expect(readStateLine(slice)).toContain('may be stale');
        // …and the notice says why the new read failed *and* how old the
        // values it is showing are (FR-019, FR-061).
        expect(notice()).toContain(PREREQUISITE);
        expect(notice()).toContain('may be stale');
        expect(notice()).toContain(String(slice.at));
        view.dispose();
    });

    it('a first read that never landed is not stale — there is nothing to be stale about', async () => {
        const view = await mountSettings(storeRead);

        expect(view.rt.state.settingsTab.stale).toBe(false);
        expect(view.rt.state.settingsTab.phase).toBe('failed');
        expect(view.rt.state.settingsTab.doc).toBeNull();
        view.dispose();
    });
});

describe('a failed write names its own cause, never a refusal (006 T-023, AC-130 – AC-133)', () => {
    /** One write failure: the cause it must report, and the copy it must show. */
    interface WriteFailureCase {
        /** The cause the recorded failure must carry. */
        readonly cause: SettingsFailureCause;
        /** How `PUT` answers. */
        readonly put: Answer;
        /** A fragment the rendered copy must contain. */
        readonly expect: string;
    }

    /** The four causes the write path can report. */
    const cases: readonly WriteFailureCase[] = [
        {
            cause: 'store',
            put: () => ({ status: 503, body: errorBody(STORE_CODE) }),
            expect: PREREQUISITE,
        },
        {
            cause: 'unauthorised',
            put: () => ({ status: 401, body: errorBody('unauthorized') }),
            expect: 'Not authorised',
        },
        {
            cause: 'transport',
            put: () => {
                throw new Error('connection refused');
            },
            expect: 'transport failure',
        },
        {
            cause: 'unexpected',
            put: () => ({ status: 500, body: errorBody('internal', 'mt-cfg-7') }),
            expect: 'did not document',
        },
    ];

    it('AC-130 – AC-133: each cause renders its own copy, and none renders the refusal copy', async () => {
        for (const failure of cases) {
            const view = await mountForWrite(failure.put);
            await saveOnce();

            const slice = view.rt.state.settingsTab;
            expect(slice.edit.saveState).toBe('failed');
            expect(slice.edit.failure?.cause).toBe(failure.cause);
            const rendered = recordedStrings().join('\n');
            expect(rendered, `${failure.cause} copy missing`).toContain(failure.expect);
            expect(rendered).toContain('The write could not be completed.');
            expect(rendered).not.toContain('The service refused these values.');
            view.dispose();
            mounts.log.length = 0;
        }
    });

    it('AC-133: an unexpected failure renders its correlation identifier as copyable text', async () => {
        const view = await mountForWrite(() => ({ status: 500, body: errorBody('internal', 'mt-cfg-7') }));
        await saveOnce();

        expect(recordedStrings().join('\n')).toContain('Correlation id: mt-cfg-7');
        expect(view.rt.state.settingsTab.edit.failure?.correlationId).toBe('mt-cfg-7');
        view.dispose();
    });

    it('AC-130/AC-133: a failure issues one write and nothing after it — no automatic retry', async () => {
        for (const failure of cases) {
            const view = await mountForWrite(failure.put);
            await saveOnce();

            // One read, one write, and no second of either (FR-061, FR-064).
            expect(view.requests).toHaveLength(2);
            view.dispose();
            mounts.log.length = 0;
        }
    });

    it('a refusal still renders the service issues, so the split has not moved', async () => {
        const view = await mountForWrite(() => ({ status: 422, body: REFUSAL }));
        await saveOnce();

        const slice = view.rt.state.settingsTab;
        expect(slice.edit.saveState).toBe('refused');
        expect(slice.edit.failure).toBeNull();
        expect(recordedStrings().join('\n')).toContain('The service refused these values.');
        view.dispose();
    });
});

describe('the copy each cause gets is its own (006 SC-111, FR-061 – FR-063)', () => {
    it('gives the four write causes four different sentences, none of them a refusal', () => {
        const causes: readonly SettingsFailureCause[] = ['store', 'unauthorised', 'transport', 'unexpected'];
        const lines = causes.map((cause) => FAILURE_LINES[cause]);

        expect(new Set(lines).size).toBe(4);
        for (const line of lines) {
            expect(line).not.toContain('refused these values');
        }
    });

    it('gives the read its own three sentences, the transport one being AC-129s wording', () => {
        const bodies = [
            readFailureBody('service unreachable'),
            readFailureBody('service answered 503'),
            readFailureBody('service answered 401'),
        ];

        expect(new Set(bodies).size).toBe(3);
        expect(bodies[0]).toContain(NOT_RUNNING);
        expect(bodies[1]).toContain(PREREQUISITE);
        expect(bodies[2]).toContain('not authorised');
    });

    it('adds the correlation id only when the answer carried one', () => {
        const plain = writeFailure({ code: 'internal', problem: 'service answered 500', correlationId: null });
        const traced = writeFailure({ code: 'internal', problem: 'service answered 500', correlationId: 'mt-cfg-9' });

        expect(writeFailureLines(plain)).toHaveLength(1);
        expect(writeFailureLines(traced)).toHaveLength(2);
        expect(writeFailureLines(traced)[1]).toBe('Correlation id: mt-cfg-9');
    });
});

/**
 * Mount a tab and complete one save against the given write answer.
 *
 * @param body - The body the configuration write answers with.
 * @returns The mounted body, after that save.
 */
async function savedWith(body: string): Promise<SettingsMount> {
    const view = await mountForWrite(() => ({ status: 200, body }));
    await saveOnce();

    return view;
}

describe('a save whose audit row never landed still shows as saved (006 T-024, AC-139)', () => {
    it('AC-139: `auditWritten: false` renders a visible warning naming the missing row', async () => {
        const view = await savedWith(JSON.stringify({
            config: { ...DEFAULT_CONFIG, intervalMs: 120_000 },
            auditWritten: false,
        }));

        const slice = view.rt.state.settingsTab;
        expect(slice.edit.saveState).toBe('saved');
        expect(slice.edit.auditWritten).toBe(false);
        const rendered = recordedStrings().join('\n');
        // The save is shown *and* the gap is shown — never one instead of the other.
        expect(rendered).toContain('Saved.');
        expect(rendered).toContain(AUDIT_MISSING_LINE);
        expect(AUDIT_MISSING_LINE).toContain(CONFIG_EVENT);
        expect(AUDIT_MISSING_LINE).toContain('did not reach the trail');
        view.dispose();
    });

    it('AC-139: a write whose row landed renders no such warning', async () => {
        const view = await savedWith(JSON.stringify({
            config: { ...DEFAULT_CONFIG, intervalMs: 120_000 },
            auditWritten: true,
        }));

        expect(view.rt.state.settingsTab.edit.auditWritten).toBe(true);
        expect(recordedStrings().join('\n')).not.toContain(AUDIT_MISSING_LINE);
        view.dispose();
    });

    it('the contract write shape — `{ config, auditWritten }` with no projection — still renders', async () => {
        const view = await savedWith(JSON.stringify({
            config: { ...DEFAULT_CONFIG, intervalMs: 120_000 },
            auditWritten: true,
        }));

        const slice = view.rt.state.settingsTab;
        expect(slice.edit.saveState).toBe('saved');
        expect(slice.doc?.config.intervalMs).toBe(120_000);
        expect(slice.edit.draft.intervalMs).toBe('120000');
        expect(slice.edit.blocked).toBeNull();
        expect(slice.edit.confirm).toBeNull();
        view.dispose();
    });
});

describe('AC-137 panel half: a configuration row keeps its own id, and a run view never claims one', () => {
    /** The correlation identifier a `config.changed` row mints for itself. */
    const CONFIG_ROW_ID = 'mt-config-4242';

    /** One `config.changed` row, shaped the way the trail stores it. */
    const CONFIG_ROW = JSON.stringify({
        entries: [{
            seq: 412,
            timestamp: '2026-09-30T10:00:00.000Z',
            correlationId: CONFIG_ROW_ID,
            eventType: CONFIG_EVENT,
            actorSource: 'operator',
            decision: 'applied',
            reason: 'configuration replaced',
            details: { changes: [] },
        }],
    });

    it('renders a configuration row under its own correlation identifier', () => {
        const rows = parseAuditBody(CONFIG_ROW);
        expect(rows).toHaveLength(1);

        const text = auditStatusText({
            status: 'ready',
            correlationId: rows?.[0]?.correlationId ?? '',
            rows: rows ?? [],
            note: '',
        });
        expect(text).toContain(CONFIG_ROW_ID);
        expect(rows?.[0]?.eventType).toBe(CONFIG_EVENT);
    });

    it('keeps the panel audit read run-filtered, so a configuration row cannot enter it', () => {
        // The service compares `correlationId` byte for byte (003 contract §2),
        // and a configuration row mints an id no run ever owns (FR-074) — so
        // asking for a run's trail can never return one.
        expect(auditPath('mt-run-1')).toBe('/v1/audit?correlationId=mt-run-1');
    });
});
