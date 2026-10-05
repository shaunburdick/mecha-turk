/**
 * The Status tab (005 T-012–T-014; FR-030–FR-039, AC-104–AC-111).
 *
 * The tab's honesty lives in two pure layers, so that is where this suite
 * lives: [`status-document.ts`](../src/status-document.ts) must refuse a body
 * it cannot fully read instead of partly applying it (AGENTS invariant 8),
 * and [`status-lines.ts`](../src/status-lines.ts) must print what the service
 * actually said — *not measured yet* instead of `0 of 0`, *unreadable*
 * instead of a dropped row, an out-of-vocabulary pause reason verbatim, an
 * overdue next-poll stamp marked overdue, and an agent pin that is never
 * "ok" before a dispatch has checked it. The read path is driven headlessly
 * through `loadStatus`, which is where the failed-read / stale rule
 * (FR-019) is decided.
 *
 * Nothing here needs a live host, a real token, or a network (FR-086), and
 * nothing here mounts the SDK's UI: this repository asserts panels through
 * their pure builders and their state, never through a browser.
 */

import { describe, expect, it } from 'vitest';
import { loadStatus } from '../src/status-tab.ts';
import {
    accountLines,
    actorPolicyLines,
    agentPinLines,
    bindingLines,
    formatUptime,
    noticeStates,
    pollingLines,
    projectGuidanceLines,
    rateLine,
    readStateLine,
    serviceLines,
} from '../src/status-lines.ts';
import { configuredIntervalFrom, parseStatusView } from '../src/status-document.ts';
import type {
    StatusBindingView,
    StatusRateView,
    StatusTabState,
    StatusView,
} from '../src/status-document.ts';
import type { PanelRuntime, TabId } from '../src/panel-state.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';

/** Stamp every fixture's next poll points at, unless a case moves it. */
const FUTURE_STAMP = '2099-01-01T00:00:00.000Z';

/** Stamp a case uses to model a poll the timer has not reached yet. */
const PAST_STAMP = '2020-01-01T00:00:00.000Z';

/** Stamp the fixtures record scans and read-backs with. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** Data directory every service block reports. */
const DATA_DIR = '/home/agent/.config/openchamber/mecha-turk';

/** The fixture account's login, asserted in a line it appears in. */
const ACCOUNT = 'octocat-mt';

/** The fixture service's `expectedAgent` mirror reason. */
const NO_MIRROR = 'no-service-mirror';

/** The problem copy a 503 read reports. */
const PROBLEM_503 = 'service answered 503';

/** Read phase a document has landed in. */
const PHASE_LOADED = 'loaded';

/** Read phase a document has been refused in. */
const PHASE_FAILED = 'failed';

/** The fixture service's process health. */
const HEALTH_OK = 'ok';

/** Copy for an unmeasured budget, asserted rather than re-typed (FR-034). */
const UNMEASURED = 'not measured yet';

/** Path the projection is read from. */
const STATUS_PATH = '/v1/status';

/** Path the configured interval is read from. */
const CONFIG_PATH = '/v1/config';

/** A config document that carries no usable interval. */
const EMPTY_CONFIG = '{"config":{}}';

/**
 * Merge overrides into one service block.
 *
 * @returns The service block.
 */
function serviceFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status: HEALTH_OK,
        uptimeMs: 61_000,
        dataDir: DATA_DIR,
        schemaVersion: 1,
        storage: { writable: true },
        ...overrides,
    };
}

/**
 * Merge overrides into one account row: measured nothing yet (FR-034).
 *
 * @returns One `accounts[]` element.
 */
function accountFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        numericUserId: '77331',
        login: ACCOUNT,
        connectionState: 'connected',
        rate: { remaining: null, limit: null, resetAt: null, usedLastHour: 0 },
        streams: [],
        ...overrides,
    };
}

/**
 * Merge overrides into one binding row.
 *
 * @returns One `repositories[]` element.
 */
function bindingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        bindingId: 'bnd_status_1',
        repository: 'acme/widget',
        projectId: 'prj_42',
        accountLogin: ACCOUNT,
        active: true,
        lastScanAt: STAMP,
        lastError: null,
        pendingCount: 2,
        readable: true,
        // FR-093: the shape of the allow-list, never its logins. The fixture
        // models a binding with no list, which is the open state.
        actorPolicy: 'open',
        ...overrides,
    };
}

/**
 * Merge overrides into one agent-pin block.
 *
 * @returns The `agentPin` member.
 */
function agentPinFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { expectedAgent: null, lastVerification: null, ...overrides };
}

/**
 * Merge overrides into one polling block.
 *
 * @returns The `polling` member.
 */
function pollingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        intervalMs: 60_000,
        nextPollAt: FUTURE_STAMP,
        paused: false,
        pausedReason: '',
        ...overrides,
    };
}

/**
 * The status document every fixture starts from.
 *
 * @param overrides - Top-level members to replace.
 * @returns The object `GET /v1/status` is modeled as answering.
 */
function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        service: serviceFixture(),
        accounts: [accountFixture()],
        repositories: [bindingFixture()],
        agentPin: agentPinFixture(),
        polling: pollingFixture(),
        surface: { supported: true },
        ...overrides,
    };
}

/**
 * Replace one top-level member of a fixture document.
 *
 * @param member - Member to replace.
 * @returns A new document; the fixture is never mutated in place.
 */
function withMember(member: string, value: unknown): Record<string, unknown> {
    return { ...statusFixture(), [member]: value };
}

/**
 * Serialize one fixture document.
 *
 * @returns Its JSON body.
 */
function bodyOf(document: Record<string, unknown>): string {
    return JSON.stringify(document);
}

/**
 * Parse a fixture document, failing loudly when it will not parse.
 *
 * @returns The view.
 */
function viewOf(document: Record<string, unknown>): StatusView {
    const view = parseStatusView(bodyOf(document));
    if (view === null) {
        throw new Error('the fixture document did not parse');
    }

    return view;
}

/**
 * The view for a fixture with one member replaced — the pipeline twenty-odd
 * assertions spell out, named once so a test reads as one line of arrangement.
 *
 * @returns The parsed view.
 */
function viewForMember(member: string, value: unknown): StatusView {
    return viewOf(withMember(member, value));
}

/**
 * The view for the plain fixture document, with nothing overridden.
 *
 * @returns The parsed view.
 */
function defaultView(): StatusView {
    return viewOf(statusFixture());
}

/**
 * The parse verdict for a fixture with one member replaced.
 *
 * The counterpart to {@link viewForMember}: it returns `null` instead of
 * throwing, which is what the rejection tests need and what {@link viewOf}
 * cannot give them.
 *
 * @returns The parsed view, or `null` when the fixture does not parse.
 */
function parseMember(member: string, value: unknown): StatusView | null {
    return parseStatusView(bodyOf(withMember(member, value)));
}

/**
 * Build a host whose service answers the two reads the tab makes.
 *
 * @param statusBody - Body `GET /v1/status` answers with.
 * @param configBody - Body `GET /v1/config` answers with.
 * @returns A runtime whose host answers both paths with 200.
 */
function runtimeAnswering(statusBody: string, configBody: string): PanelRuntime {
    return createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            const body = request.path === CONFIG_PATH ? configBody : statusBody;

            return { status: 200, body };
        },
    }));
}

/**
 * Render the polling block over one overridden polling member.
 *
 * @param overrides - Members of the polling block to replace.
 * @param configured - Configured interval the tab read beside it.
 * @returns The lines.
 */
function pollingLinesFor(overrides: Record<string, unknown>, configured: number | null): readonly string[] {
    return pollingLines({
        view: viewOf({ ...statusFixture(), polling: pollingFixture(overrides) }),
        configured,
        nowMs: Date.parse(FUTURE_STAMP),
    });
}

/**
 * The binding rows the Status → picker guidance is asserted against.
 *
 * @returns The fixture document's binding rows.
 */
function guidanceBindings(): readonly StatusBindingView[] {
    return viewOf(statusFixture()).bindings;
}

/**
 * Build the inputs {@link projectGuidanceLines} takes.
 *
 * @param bindings - The binding rows to check.
 * @param registeredProjectIds - Registered ids, or `null` when not loaded.
 * @returns The inputs.
 */
function guidanceInput(
    bindings: readonly StatusBindingView[],
    registeredProjectIds: readonly string[] | null,
): { readonly bindings: readonly StatusBindingView[]; readonly registeredProjectIds: readonly string[] | null } {
    return { bindings, registeredProjectIds };
}

/**
 * The guidance inputs for the fixture's own bindings.
 *
 * Every caller wants the default binding rows and varies only the registered
 * ids, so the pairing is here rather than repeated.
 *
 * @param registeredProjectIds - Registered ids, or `null` when not loaded.
 * @returns The inputs.
 */
function guidanceFor(registeredProjectIds: readonly string[] | null): {
    readonly bindings: readonly StatusBindingView[];
    readonly registeredProjectIds: readonly string[] | null;
} {
    return guidanceInput(guidanceBindings(), registeredProjectIds);
}

/**
 * Install a shell stub that records every call, so a test can prove the read
 * path stamped the tab without navigating it.
 *
 * @returns The record of calls the stub received.
 */
function stubShell(rt: PanelRuntime): { readonly calls: string[] } {
    const calls: string[] = [];
    rt.shell = {
        activate: (id: TabId) => {
            calls.push(`activate:${id}`);
        },
        noteRead: (id, at) => {
            rt.tabLastRead.set(id, at);
            calls.push(`noteRead:${id}`);
        },
        associate: () => {
            calls.push('associate');
        },
        dispose: () => {
            calls.push('dispose');
        },
    };

    return { calls };
}

/**
 * Build a runtime whose service refuses every read with one status code.
 *
 * @param status - HTTP status to answer with.
 * @param body - Body to answer with.
 * @returns The runtime.
 */
function refusingRuntime(status: number, body: string): PanelRuntime {
    return createTestRuntime(fakeHost({ serviceRequest: async () => ({ status, body }) }));
}

/**
 * Build a runtime whose first status read succeeds and whose second fails.
 *
 * @returns The runtime; flip it with {@link flipAndReload}.
 */
function flakyStatusRuntime(): PanelRuntime {
    let statusReads = 0;
    return createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            if (request.path === CONFIG_PATH) {
                return { status: 200, body: EMPTY_CONFIG };
            }

            statusReads += 1;

            return statusReads > 1
                ? { status: 503, body: EMPTY_CONFIG }
                : { status: 200, body: bodyOf(statusFixture()) };
        },
    }));
}

/**
 * Build a runtime whose first status read succeeds and whose second answers
 * a document the panel must refuse.
 *
 * @returns The runtime.
 */
function malformedAfterFirstRuntime(): PanelRuntime {
    let reads = 0;
    return createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            if (request.path === CONFIG_PATH) {
                return { status: 200, body: EMPTY_CONFIG };
            }

            reads += 1;

            return { status: 200, body: reads > 1 ? '{"unexpected":"shape"}' : bodyOf(statusFixture()) };
        },
    }));
}

describe('parseStatusView (fail closed, AGENTS invariant 8)', () => {
    it('reads a complete document', () => {
        {
            const view = viewOf(statusFixture());

            expect(view.service.status).toBe(HEALTH_OK);
            expect(view.service.dataDir).toBe(DATA_DIR);
            expect(view.accounts).toHaveLength(1);
            expect(view.bindings).toHaveLength(1);
            expect(view.polling.paused).toBe(false);
            expect(view.agentPin.verification).toEqual({ kind: 'none' });
            expect(view.supported).toBe(true);
        }
        {
            expect(parseStatusView('not json'), 'a body that is not JSON').toBeNull();

            for (const member of ['service', 'accounts', 'repositories', 'polling', 'agentPin', 'surface']) {
                const partial = Object.fromEntries(
                    Object.entries(statusFixture()).filter(([key]) => key !== member),
                );

                expect(parseStatusView(bodyOf(partial)), `a document missing ${member}`).toBeNull();
            }

            expect(
                parseMember('service', serviceFixture({ uptimeMs: 'a while' })),
                'a partially typed service block',
            ).toBeNull();

            const rate = { remaining: null, usedLastHour: 0 };
            expect(
                parseMember('accounts', [accountFixture({ rate })]),
                'an account row with an incomplete rate block',
            ).toBeNull();

            expect(
                parseMember('repositories', [bindingFixture({ readable: 'yes' })]),
                'a binding row whose flags are not booleans',
            ).toBeNull();

            const brokenPin = withMember('agentPin', agentPinFixture({ lastVerification: { somethingElse: true } }));
            expect(parseStatusView(bodyOf(brokenPin)), 'a verification member of an unknown shape').toBeNull();
        }
        {
            expect(viewOf(statusFixture()).agentPin.verification).toEqual({ kind: 'none' });

            const unavailable = withMember(
                'agentPin',
                agentPinFixture({ lastVerification: { available: false, reason: NO_MIRROR } }),
            );
            expect(viewOf(unavailable).agentPin.verification).toEqual({ kind: 'unavailable', reason: NO_MIRROR });

            const outcome = withMember(
                'agentPin',
                agentPinFixture({
                    lastVerification: {
                        observedAgent: 'planner',
                        expectedAgent: 'project-manager',
                        ok: false,
                        at: STAMP,
                    },
                }),
            );
            expect(viewOf(outcome).agentPin.verification).toMatchObject({ kind: 'outcome', ok: false });
        }
    });
});

describe('configuredIntervalFrom (FR-039)', () => {
    it('reads the configured interval beside the effective one', () => {
        {
            expect(configuredIntervalFrom('{"config":{"intervalMs":45000}}')).toBe(45_000);
        }
        {
            expect(configuredIntervalFrom(EMPTY_CONFIG)).toBeNull();
            expect(configuredIntervalFrom('{"other":1}')).toBeNull();
            expect(configuredIntervalFrom('nonsense')).toBeNull();
        }
    });
});

describe('the service block (FR-030)', () => {
    it('reports health, uptime, location, schema, and storage', () => {
        {
            const lines = serviceLines(viewOf(statusFixture()));

            expect(lines[1]).toBe('Uptime: 1m 1s');
            expect(lines[2]).toBe(`Data directory: ${DATA_DIR} — this is the directory to back up`);
            expect(lines[3]).toBe('Store schema version: 1');
        }
        {
            const service = serviceFixture({
                status: 'degraded',
                schemaVersion: null,
                storage: { writable: false },
            });
            const lines = serviceLines(viewOf(withMember('service', service)));

            expect(lines[0]).toContain('degraded');
        }
        {
            expect(formatUptime(0)).toBe('0s');
            expect(formatUptime(3_600_000)).toBe('1h 0m 0s');
        }
    });
});

describe('the polling block (FR-031, FR-039)', () => {
    it('reports the effective and the configured interval', () => {
        {
            const lines = pollingLinesFor({ intervalMs: 60_000 }, 60_000);

            expect(lines).toContain('Effective interval: 60,000 ms');
            expect(lines).toContain('Configured interval: 60,000 ms');
            expect(lines.some((line) => line.includes('differ'))).toBe(false);
        }
        {
            const lines = pollingLinesFor({ intervalMs: 60_000 }, 45_000);

            expect(lines.some((line) => line.includes('differ'))).toBe(true);
            expect(lines.some((line) => line.includes('45,000 ms'))).toBe(true);
        }
        {
            const lines = pollingLines({
                view: viewOf(statusFixture()),
                configured: null,
                nowMs: Date.parse(PAST_STAMP),
            });
            expect(lines[3]).toBe(`Next poll: ${FUTURE_STAMP}`);

            const overdue = pollingLinesFor({ nextPollAt: PAST_STAMP }, null);
            expect(overdue.some((line) => line.includes('(overdue)'))).toBe(true);
        }
        {
            const view = viewOf(withMember('surface', { supported: false }));
            const lines = pollingLines({ view, configured: null, nowMs: Date.now() });

            expect(lines.some((line) => line.startsWith('Polling: running'))).toBe(false);
        }
    });
});

describe('rate honesty (FR-034, AC-107)', () => {
    const unmeasured: StatusRateView = { remaining: null, limit: null, resetAt: null, usedLastHour: 0 };

    it('reports an unmeasured budget as not measured yet, never as 0 of 0', () => {
        {
            const line = rateLine(unmeasured);

            expect(line).toContain(UNMEASURED);
            expect(line).not.toContain('0 of 0');
            expect(line).toContain('0 used in the last hour');
        }
        {
            expect(rateLine({ ...unmeasured, usedLastHour: 7 })).toContain('7 used in the last hour');
        }
        {
            const line = rateLine({ remaining: 4_200, limit: 5_000, resetAt: PAST_STAMP, usedLastHour: 800 });

            expect(line).toContain('800 used in the last hour of 5,000');
            expect(line).toContain('4,200 left in this window');
        }
        {
            const rows = accountLines(viewOf(statusFixture()));

            expect(rows[0]).toBe(`${ACCOUNT} (77331) — connected · not measured yet (0 used in the last hour)`);
        }
        {
            expect(accountLines(viewForMember('accounts', []))).toEqual(['No accounts connected yet.']);
        }
    });
});

describe('binding rows (FR-032, AC-104, AC-105)', () => {
    it('reports scan, pending count, and enabled state', () => {
        {
            const rows = bindingLines(viewOf(statusFixture()));

            expect(rows[0]).toContain('acme/widget — enabled');
            expect(rows[0]).toContain(`last scan ${STAMP}`);
            expect(rows[0]).toContain('2 pending');
        }
        {
            const rows = bindingLines(viewForMember('repositories', [bindingFixture({ readable: false })]));

            expect(rows).toHaveLength(1);
            expect(rows[0]).toContain('unreadable');
        }
        {
            const row = bindingFixture({ lastError: 'rate-limited' });
            const rows = bindingLines(viewOf(withMember('repositories', [row])));

            expect(rows[0]).toContain('rate-limited');
        }
        {
            expect(bindingLines(viewForMember('repositories', []))).toEqual(['No bindings yet.']);
        }
        {
            const degraded = statusFixture({
                service: serviceFixture({ status: 'degraded', storage: { writable: false } }),
                accounts: [],
                repositories: [],
            });

            expect(bindingLines(viewOf(degraded))).toEqual([
                'The binding list could not be read: the data directory is unavailable.',
            ]);
            expect(accountLines(viewOf(degraded))).toEqual([
                'The account list could not be read: the data directory is unavailable.',
            ]);
        }
    });
});

describe('the agent pin (FR-033, AC-106)', () => {
    it('reads not checkable before any dispatch, and names the first dispatch', () => {
        {
            const lines = agentPinLines(viewOf(statusFixture()));

            expect(lines.some((line) => line.includes('ok'))).toBe(false);
        }
        {
            const agentPin = agentPinFixture({
                expectedAgent: 'planner',
                lastVerification: {
                    observedAgent: 'executor',
                    expectedAgent: 'planner',
                    ok: false,
                    at: STAMP,
                },
            });
            const lines = agentPinLines(viewOf(withMember('agentPin', agentPin)));

            expect(lines[1]).toContain('executor');
        }
        {
            // `ok: false` with an empty baseline is *no comparison*, and the
            // Status tab must not render it as a mismatch the panel never made.
            const agentPin = agentPinFixture({
                expectedAgent: '',
                lastVerification: {
                    observedAgent: 'executor',
                    expectedAgent: '',
                    ok: false,
                    at: STAMP,
                },
            });
            const lines = agentPinLines(viewOf(withMember('agentPin', agentPin)));

            expect(lines[0]).toBe('No comparison baseline configured.');
            expect(lines[1]).toContain('executor');
            expect(lines[1]).toContain('without comparison');
            expect(lines.join(' ')).not.toContain('did not match');
        }
    });
});

describe('the two blocking notices (FR-035, FR-036, AC-108, AC-109)', () => {
    it('raises nothing for a document that is healthy', () => {
        {
            expect(noticeStates(defaultView())).toEqual({ unsupported: false, storageBlocked: false });
        }
        {
            expect(noticeStates(null)).toEqual({ unsupported: false, storageBlocked: false });
        }
        {
            const service = serviceFixture({ storage: { writable: false } });

            expect(noticeStates(viewForMember('service', service))).toEqual({
                unsupported: false,
                storageBlocked: true,
            });
        }
        {
            expect(noticeStates(viewForMember('surface', { supported: false }))).toEqual({
                unsupported: true,
                storageBlocked: false,
            });
        }
    });
});

describe('the Status → picker link (FR-038)', () => {
    it('claims nothing while the host project list has not loaded', () => {
        {
            expect(projectGuidanceLines(guidanceFor(null))).toEqual([]);
        }
        {
            const lines = projectGuidanceLines(guidanceFor(['prj_other']));

            expect(lines).toHaveLength(1);
            // The three manual routes belong to the picker alone (FR-038).
            expect(lines[0]).not.toContain('command palette');
            expect(lines[0]).not.toContain('sidebar');
        }
        {
            expect(projectGuidanceLines(guidanceFor(['prj_42']))).toEqual([]);
        }
    });
});

describe('the tab read state (FR-019)', () => {
    const idle: StatusTabState = {
        phase: 'idle',
        at: null,
        problem: null,
        stale: false,
        doc: null,
        configuredIntervalMs: null,
    };

    it('reports each phase in the tab’s own words', () => {
        expect(readStateLine({ ...idle, phase: PHASE_LOADED, at: 'T1' })).toBe('Status: read at T1.');
    });
});

describe('loadStatus', () => {
    /** Where the in-flight gate's release lands, written from the executor. */
    const holder: { release: (() => void) | null } = { release: null };

    it('lands the document and the configured interval, and stamps the tab', async () => {
        {
            const rt = runtimeAnswering(bodyOf(statusFixture()), '{"config":{"intervalMs":45000}}');
            const shell = stubShell(rt);

            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_LOADED);
            expect(slice.doc?.service.status).toBe(HEALTH_OK);
            expect(slice.configuredIntervalMs).toBe(45_000);
            expect(slice.at).not.toBeNull();
            expect(shell.calls).toEqual(['noteRead:status']);
            expect(rt.tabLastRead.get('status')).toBe(slice.at);
        }
    });

    it('keeps reading the tab honest when the status read fails', async () => {
        {
            const rt = refusingRuntime(503, PROBLEM_503);

            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_FAILED);
            expect(slice.doc).toBeNull();
            expect(slice.stale).toBe(false);
            expect(slice.problem).toContain('503');
        }
    });

    it('keeps the last document and marks it stale when a re-read fails', async () => {
        {
            const rt = flakyStatusRuntime();

            await loadStatus(rt);
            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_FAILED);
            expect(slice.stale).toBe(true);
            expect(slice.doc).not.toBeNull();
            expect(slice.at, 'the retained stamp stays on screen').not.toBeNull();
            expect(readStateLine(slice)).toContain(slice.at ?? '');
        }
    });

    it('fails the read when the document will not parse, and keeps the previous one', async () => {
        {
            const rt = malformedAfterFirstRuntime();

            await loadStatus(rt);
            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_FAILED);
            expect(slice.stale).toBe(true);
        }
    });

    it('reads the configured interval as not read when that half fails', async () => {
        {
            const rt = createTestRuntime(fakeHost({
                serviceRequest: async (request) => {
                    if (request.path === CONFIG_PATH) {
                        return { status: 503, body: EMPTY_CONFIG };
                    }

                    return { status: 200, body: bodyOf(statusFixture()) };
                },
            }));

            await loadStatus(rt);

            expect(rt.state.statusTab.phase).toBe(PHASE_LOADED);
            expect(rt.state.statusTab.configuredIntervalMs).toBeNull();
        }
    });

    it('refuses a second read while one is in flight', async () => {
        {
            const gate = new Promise<void>((resolve) => {
                holder.release = resolve;
            });
            let statusCalls = 0;
            const rt = createTestRuntime(fakeHost({
                serviceRequest: async (request) => {
                    if (request.path !== STATUS_PATH) {
                        return { status: 200, body: EMPTY_CONFIG };
                    }

                    statusCalls += 1;
                    await gate;

                    return { status: 200, body: bodyOf(statusFixture()) };
                },
            }));

            const first = loadStatus(rt);
            const second = loadStatus(rt);
            expect(rt.state.statusTab.phase).toBe('loading');
            holder.release?.();
            await Promise.all([first, second]);

            expect(statusCalls).toBe(1);
            expect(rt.state.statusTab.phase).toBe(PHASE_LOADED);
        }
    });

});

describe('hostile strings stay text (FR-080)', () => {
    /** Markup an operator or GitHub could have put in a field. */
    const HOSTILE = '<img src=x onerror="alert(1)">';

    it('passes a hostile repository through the line as literal text', () => {
        {
            const repository = bindingFixture({ repository: HOSTILE });
            const rows = bindingLines(viewOf(withMember('repositories', [repository])));

            expect(rows[0]).toContain(HOSTILE);
            expect(rows[0]?.startsWith('acme/')).toBe(false);
        }
        {
            const account = accountFixture({ connectionState: HOSTILE });
            const rows = accountLines(viewOf(withMember('accounts', [account])));

            expect(rows[0]).toContain(HOSTILE);
        }
    });
});

/* -------------------------------------------------------------------- *
 * The allow-list roll-up (005 FR-093 as re-cut at v1.14.0, NFR-113, AC-144, AC-149)
 * -------------------------------------------------------------------- */

/** The third fixture repository, named once where three cases reuse it. */
const THIRD_REPOSITORY = 'acme/three';

/** The positive statement FR-093 scopes to *enabled* bindings. */
const EVERY_ENABLED_RESTRICTS = 'every enabled binding restricts who may trigger';

/** The repository the disabled-open fixture's third row names. */
const OFF_REPOSITORY = 'acme/off';

/** The *unscoped* positive statement, which a disabled open binding makes false. */
const EVERY_BINDING_RESTRICTS = 'every binding restricts';

describe('the actor allow-list roll-up (005 FR-093, AC-144, AC-149)', () => {
    it('counts the open ENABLED bindings, states the consequence, and never names one', () => {
        {
            const view = viewOf(withMember('repositories', [
                bindingFixture({ bindingId: 'bnd_a', repository: 'acme/one', actorPolicy: 'restricted' }),
                bindingFixture({ bindingId: 'bnd_b', repository: 'acme/two', actorPolicy: 'restricted' }),
                bindingFixture({ bindingId: 'bnd_c', repository: THIRD_REPOSITORY, actorPolicy: 'open' }),
            ]));
            const [line] = actorPolicyLines(view);

            expect(line).toContain('1 of 3 enabled bindings has no allow-list');
            // …and the consequence, not only the count (FR-092).
            expect(line).toContain('start a session');
            // Status points at the Bindings tab and does not duplicate its field
            // (FR-039).
            expect(line).toContain('Bindings tab');
            // No login, and no repository (005 clarification row 42).
            for (const named of ['acme/one', 'acme/two', THIRD_REPOSITORY, ACCOUNT, 'prj_42']) {
                expect(line, named).not.toContain(named);
            }
        }

        // silence — and the statement is scoped to `enabled`, because the
        // unqualified form is false the moment a disabled binding is open.
        {
            const view = viewOf(withMember('repositories', [
                bindingFixture({ bindingId: 'bnd_a', actorPolicy: 'restricted' }),
                bindingFixture({ bindingId: 'bnd_b', repository: 'acme/other', actorPolicy: 'restricted' }),
                // A third binding, open but off: it must not make the sentence
                // above false, and it must not enter the denominator either.
                bindingFixture({ bindingId: 'bnd_c', repository: OFF_REPOSITORY, active: false, actorPolicy: 'open' }),
            ]));
            const [line] = actorPolicyLines(view);

            // The criterion fails on an absent row or an empty line: an operator
            // reading silence cannot tell it from a panel that did not check.
            expect(line).toContain(EVERY_ENABLED_RESTRICTS);
            expect(line).toContain('2 of 2 enabled');
            // Not the unscoped claim, and not a denominator that counted the
            // disabled row.
            expect(line).not.toContain(EVERY_BINDING_RESTRICTS);
            expect(line).not.toContain('3 of 3');
            expect(line).not.toContain('3 of 2');
        }

        {
            const [line] = actorPolicyLines(null);

            expect(line).toContain('not available');
            // The service is named as the source, so the reader knows who to go
            // and ask (NFR-112).
            expect(line).toContain('service');
            // Never the reassuring default a count of zero would be.
            expect(line).not.toContain('every binding');
            expect(line).not.toContain('0 of 0');
        }

        {
            const [line] = actorPolicyLines(viewOf(withMember('repositories', [])));

            expect(line).toContain('no bindings yet');
            expect(line).not.toContain(EVERY_BINDING_RESTRICTS);
        }

        {
            for (const value of ['closed', 'OPEN', '', 1, null, undefined, ['open']]) {
                expect(
                    parseMember('repositories', [bindingFixture({ actorPolicy: value })]),
                    `actorPolicy ${JSON.stringify(value)}`,
                ).toBeNull();
            }
            // …and the two legal words parse.
            for (const value of ['open', 'restricted']) {
                const view = parseMember('repositories', [bindingFixture({ actorPolicy: value })]);
                expect(view?.bindings[0]?.actorPolicy, value).toBe(value);
            }
        }

        // from the binding rather than from the scan projection
        {
            const view = viewOf(withMember('repositories', [
                bindingFixture({ readable: false, actorPolicy: 'restricted' }),
                bindingFixture({ bindingId: 'bnd_b', repository: 'acme/other', actorPolicy: 'open' }),
            ]));
            const [line] = actorPolicyLines(view);

            expect(line).toContain('1 of 2 enabled bindings has no allow-list');
            // The unreadable row is still counted from what the service said.
            expect(bindingLines(view)[0]).toContain('unreadable');
        }
    });

    /* ---------------------------------------------------------------- *
     * AC-149 — the denominator rule, asserted by the fixture that
     * exposed the defect: three bindings whose ONLY open one is disabled.
     * ---------------------------------------------------------------- */

    describe('AC-149 the denominator counts enabled bindings only', () => {
        /** The fixture that exposed defect 1: three rows, one open, and it is off. */
        const DISABLED_OPEN: readonly Record<string, unknown>[] = [
            bindingFixture({ bindingId: 'bnd_a', repository: 'acme/one', actorPolicy: 'restricted' }),
            bindingFixture({ bindingId: 'bnd_b', repository: 'acme/two', actorPolicy: 'restricted' }),
            bindingFixture({ bindingId: 'bnd_c', repository: OFF_REPOSITORY, active: false, actorPolicy: 'open' }),
        ];

        it('excludes a disabled open binding from both halves of the count', () => {
            {
                const [line] = actorPolicyLines(viewOf(withMember('repositories', DISABLED_OPEN)));

                expect(line).toContain('every enabled binding restricts who may trigger (2 of 2 enabled)');
                // The two sentences the defect produced, asserted **absent**. A
                // suite holding only enabled open bindings cannot tell the
                // conforming count from one that ignores `active`, so this case
                // is the load-bearing one for the whole requirement.
                expect(line).not.toContain('1 of 3');
                expect(line).not.toContain('1 of 3 bindings');
                expect(line).not.toContain('lets anyone');
                expect(line).not.toContain(EVERY_BINDING_RESTRICTS);
                expect(line).not.toContain('of 0 ');
                expect(line).not.toContain('0 of 0');

                // Non-vacuous: the fixture really does hold a disabled open
                // binding, so the assertion above is about *this* panel's
                // filtering and not about a document with nothing to filter.
                const rows = viewOf(withMember('repositories', DISABLED_OPEN)).bindings;
                expect(rows).toHaveLength(3);
                expect(rows.filter((row) => row.active)).toHaveLength(2);
                expect(rows.filter((row) => !row.active && row.actorPolicy === 'open')).toHaveLength(1);
            }

            // consequence, and nothing that names a login, a repository, or an
            // act.
            {
                const [line] = actorPolicyLines(viewForMember('repositories', [
                    bindingFixture({ bindingId: 'bnd_a', repository: 'acme/one', actorPolicy: 'restricted' }),
                    bindingFixture({ bindingId: 'bnd_b', repository: 'acme/two', actorPolicy: 'open' }),
                ]));

                expect(line).toContain('1 of 2 enabled bindings has no allow-list');
                expect(line).toContain('whoever the trigger lets act can start a session');
                // The clause names no act: one clause spans N bindings whose
                // switch sets differ, and no single act is true of all of them.
                for (const act of ['open an issue', 'comment', 'assign', 'request a review', 'issue']) {
                    expect(line?.toLowerCase(), act).not.toContain(act);
                }
                for (const named of ['acme/one', 'acme/two', ACCOUNT, 'prj_42']) {
                    expect(line, named).not.toContain(named);
                }
            }

            // never `0 of 0` and never the vacuously-true positive statement.
            {
                const [line] = actorPolicyLines(viewForMember('repositories', [
                    bindingFixture({ bindingId: 'bnd_a', active: false, actorPolicy: 'open' }),
                    bindingFixture({
                        bindingId: 'bnd_b', repository: 'acme/two', active: false, actorPolicy: 'restricted',
                    }),
                    bindingFixture({
                        bindingId: 'bnd_c', repository: THIRD_REPOSITORY, active: false, actorPolicy: 'open',
                    }),
                ]));

                expect(line).toContain('none of the 3 bindings is enabled');
                expect(line).toContain('nothing can start a session right now');
                // Both facts are named, so the operator never has to infer a
                // denominator of zero — and neither banned shape renders.
                expect(line).not.toContain('0 of 0');
                expect(line).not.toContain(EVERY_BINDING_RESTRICTS);
                expect(line).not.toContain(EVERY_ENABLED_RESTRICTS);
                // Distinct from the *no bindings* case, which is about count.
                expect(line).not.toContain('no bindings yet');
            }
        });
    });
});

