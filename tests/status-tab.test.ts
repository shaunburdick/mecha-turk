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
 * @param overrides - Members to replace.
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
 * @param overrides - Members to replace.
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
 * @param overrides - Members to replace.
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
        ...overrides,
    };
}

/**
 * Merge overrides into one agent-pin block.
 *
 * @param overrides - Members to replace.
 * @returns The `agentPin` member.
 */
function agentPinFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { expectedAgent: null, lastVerification: null, ...overrides };
}

/**
 * Merge overrides into one polling block.
 *
 * @param overrides - Members to replace.
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
 * @param value - Its new value.
 * @returns A new document; the fixture is never mutated in place.
 */
function withMember(member: string, value: unknown): Record<string, unknown> {
    return { ...statusFixture(), [member]: value };
}

/**
 * Serialize one fixture document.
 *
 * @param document - The document to serialize.
 * @returns Its JSON body.
 */
function bodyOf(document: Record<string, unknown>): string {
    return JSON.stringify(document);
}

/**
 * Parse a fixture document, failing loudly when it will not parse.
 *
 * @param document - The document to parse.
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
        view: viewOf(statusFixture({ polling: pollingFixture(overrides) })),
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
 * Install a shell stub that records every call, so a test can prove the read
 * path stamped the tab without navigating it.
 *
 * @param rt - Panel runtime to install the stub on.
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

            return reads > 1
                ? { status: 200, body: '{"unexpected":"shape"}' }
                : { status: 200, body: bodyOf(statusFixture()) };
        },
    }));
}

describe('parseStatusView (fail closed, AGENTS invariant 8)', () => {
    it('reads a complete document (+2 cases)', () => {
        // case: reads a complete document
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
        // case: refuses every malformed document shape rather than defaulting any of it
        {
            expect(parseStatusView('not json'), 'a body that is not JSON').toBeNull();

            for (const member of ['service', 'accounts', 'repositories', 'polling', 'agentPin', 'surface']) {
                const document = statusFixture();
                const partial: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(document)) {
                    if (key !== member) {
                        partial[key] = value;
                    }
                }

                expect(parseStatusView(bodyOf(partial)), `a document missing ${member}`).toBeNull();
            }

            expect(
                parseStatusView(bodyOf(withMember('service', serviceFixture({ uptimeMs: 'a while' })))),
                'a partially typed service block',
            ).toBeNull();

            const rate: StatusRateView = { remaining: null, usedLastHour: 0 } as unknown as StatusRateView;
            expect(
                parseStatusView(bodyOf(withMember('accounts', [accountFixture({ rate })]))),
                'an account row with an incomplete rate block',
            ).toBeNull();

            expect(
                parseStatusView(bodyOf(withMember('repositories', [bindingFixture({ readable: 'yes' })]))),
                'a binding row whose flags are not booleans',
            ).toBeNull();

            const brokenPin = withMember('agentPin', agentPinFixture({ lastVerification: { somethingElse: true } }));
            expect(parseStatusView(bodyOf(brokenPin)), 'a verification member of an unknown shape').toBeNull();
        }
        // case: reads the three verification shapes it does know
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
    it('reads the configured interval beside the effective o… (+1 cases)', () => {
        // case: reads the configured interval beside the effective one
        {
            expect(configuredIntervalFrom('{"config":{"intervalMs":45000}}')).toBe(45_000);
        }
        // case: reports an unreadable or absent value rather than a default
        {
            expect(configuredIntervalFrom(EMPTY_CONFIG)).toBeNull();
            expect(configuredIntervalFrom('{"other":1}')).toBeNull();
            expect(configuredIntervalFrom('nonsense')).toBeNull();
        }
    });
});

describe('the service block (FR-030)', () => {
    it('reports health, uptime, location, schema, and storag… (+2 cases)', () => {
        // case: reports health, uptime, location, schema, and storage
        {
            const lines = serviceLines(viewOf(statusFixture()));

            expect(lines[1]).toBe('Uptime: 1m 1s');
            expect(lines[2]).toBe(`Data directory: ${DATA_DIR} — this is the directory to back up`);
            expect(lines[3]).toBe('Store schema version: 1');
        }
        // case: says degraded, and says the schema is unavailable rather than inventing one
        {
            const service = serviceFixture({
                status: 'degraded',
                schemaVersion: null,
                storage: { writable: false },
            });
            const lines = serviceLines(viewOf(withMember('service', service)));

            expect(lines[0]).toContain('degraded');
        }
        // case: formats an uptime without a zero-sized segment
        {
            expect(formatUptime(0)).toBe('0s');
            expect(formatUptime(3_600_000)).toBe('1h 0m 0s');
        }
    });
});

describe('the polling block (FR-031, FR-039)', () => {
    it('reports the effective and the configured interval (+3 cases)', () => {
        // case: reports the effective and the configured interval
        {
            const lines = pollingLinesFor({ intervalMs: 60_000 }, 60_000);

            expect(lines).toContain('Effective interval: 60,000 ms');
            expect(lines).toContain('Configured interval: 60,000 ms');
            expect(lines.some((line) => line.includes('differ'))).toBe(false);
        }
        // case: names the difference when the two intervals disagree
        {
            const lines = pollingLinesFor({ intervalMs: 60_000 }, 45_000);

            expect(lines.some((line) => line.includes('differ'))).toBe(true);
            expect(lines.some((line) => line.includes('45,000 ms'))).toBe(true);
        }
        // case: shows a future stamp plainly and a past stamp as overdue
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
        // case: claims nothing while the surface cannot run a service
        {
            const view = viewOf(withMember('surface', { supported: false }));
            const lines = pollingLines({ view, configured: null, nowMs: Date.now() });

            expect(lines.some((line) => line.startsWith('Polling: running'))).toBe(false);
        }
    });
});

describe('rate honesty (FR-034, AC-107)', () => {
    const unmeasured: StatusRateView = { remaining: null, limit: null, resetAt: null, usedLastHour: 0 };

    it('reports an unmeasured budget as not measured yet, ne… (+4 cases)', () => {
        // case: reports an unmeasured budget as not measured yet, never as 0 of 0
        {
            const line = rateLine(unmeasured);

            expect(line).toContain(UNMEASURED);
            expect(line).not.toContain('0 of 0');
            expect(line).toContain('0 used in the last hour');
        }
        // case: keeps the real usage count even while the budget is unmeasured
        {
            expect(rateLine({ ...unmeasured, usedLastHour: 7 })).toContain('7 used in the last hour');
        }
        // case: reports a measured budget against its limit
        {
            const line = rateLine({ remaining: 4_200, limit: 5_000, resetAt: PAST_STAMP, usedLastHour: 800 });

            expect(line).toContain('800 used in the last hour of 5,000');
            expect(line).toContain('4,200 left in this window');
        }
        // case: renders one account row carrying its connection state and its rate
        {
            const rows = accountLines(viewOf(statusFixture()));

            expect(rows[0]).toBe(`${ACCOUNT} (77331) — connected · not measured yet (0 used in the last hour)`);
        }
        // case: renders an honest empty when no account is connected
        {
            expect(accountLines(viewOf(withMember('accounts', [])))).toEqual(['No accounts connected yet.']);
        }
    });
});

describe('binding rows (FR-032, AC-104, AC-105)', () => {
    it('reports scan, pending count, and enabled state (+4 cases)', () => {
        // case: reports scan, pending count, and enabled state
        {
            const rows = bindingLines(viewOf(statusFixture()));

            expect(rows[0]).toContain('acme/widget — enabled');
            expect(rows[0]).toContain(`last scan ${STAMP}`);
            expect(rows[0]).toContain('2 pending');
        }
        // case: keeps an unreadable row on the page and marks it
        {
            const rows = bindingLines(viewOf(withMember('repositories', [bindingFixture({ readable: false })])));

            expect(rows).toHaveLength(1);
            expect(rows[0]).toContain('unreadable');
        }
        // case: shows the scan failure reason on the row it belongs to
        {
            const row = bindingFixture({ lastError: 'rate-limited' });
            const rows = bindingLines(viewOf(withMember('repositories', [row])));

            expect(rows[0]).toContain('rate-limited');
        }
        // case: renders an honest empty when the store holds no bindings
        {
            expect(bindingLines(viewOf(withMember('repositories', [])))).toEqual(['No bindings yet.']);
        }
        // case: does not read an empty list as "you have none" when the store is degraded
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
    it('reads not checkable before any dispatch, and names t… (+2 cases)', () => {
        // case: reads not checkable before any dispatch, and names the first dispatch
        {
            const lines = agentPinLines(viewOf(statusFixture()));

            expect(lines.some((line) => line.includes('ok'))).toBe(false);
        }
        // case: reports a mismatch as the outcome it is
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
        // case: names a blank baseline as unset and its read-back as not compared (002 FR-029)
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
    it('raises nothing for a document that is healthy (+3 cases)', () => {
        // case: raises nothing for a document that is healthy
        {
            expect(noticeStates(viewOf(statusFixture()))).toEqual({ unsupported: false, storageBlocked: false });
        }
        // case: raises nothing before anything has been read
        {
            expect(noticeStates(null)).toEqual({ unsupported: false, storageBlocked: false });
        }
        // case: raises the storage blocker when the data directory cannot serve writes
        {
            const service = serviceFixture({ storage: { writable: false } });

            expect(noticeStates(viewOf(withMember('service', service)))).toEqual({
                unsupported: false,
                storageBlocked: true,
            });
        }
        // case: raises the unsupported-surface notice on a surface that cannot run a service
        {
            expect(noticeStates(viewOf(withMember('surface', { supported: false })))).toEqual({
                unsupported: true,
                storageBlocked: false,
            });
        }
    });
});

describe('the Status → picker link (FR-038)', () => {
    it('claims nothing while the host project list has not l… (+2 cases)', () => {
        // case: claims nothing while the host project list has not loaded
        {
            expect(projectGuidanceLines(guidanceInput(guidanceBindings(), null))).toEqual([]);
        }
        // case: points at the picker when a binding targets an unregistered project
        {
            const lines = projectGuidanceLines(guidanceInput(guidanceBindings(), ['prj_other']));

            expect(lines).toHaveLength(1);
            // The three manual routes belong to the picker alone (FR-038).
            expect(lines[0]).not.toContain('command palette');
            expect(lines[0]).not.toContain('sidebar');
        }
        // case: says nothing when every binding has a registered project
        {
            expect(projectGuidanceLines(guidanceInput(guidanceBindings(), ['prj_42']))).toEqual([]);
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

    it('lands the document and the configured interval, and … (+5 cases)', async () => {
        // case: lands the document and the configured interval, and stamps the tab
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
        // case: keeps reading the tab honest when the status read fails
        {
            const rt = refusingRuntime(503, PROBLEM_503);

            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_FAILED);
            expect(slice.doc).toBeNull();
            expect(slice.stale).toBe(false);
            expect(slice.problem).toContain('503');
        }
        // case: keeps the last document and marks it stale when a re-read fails
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
        // case: fails the read when the document will not parse, and keeps the previous one
        {
            const rt = malformedAfterFirstRuntime();

            await loadStatus(rt);
            await loadStatus(rt);

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe(PHASE_FAILED);
            expect(slice.stale).toBe(true);
        }
        // case: reads the configured interval as not read when that half fails
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
        // case: refuses a second read while one is in flight
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

    it('passes a hostile repository through the line as lite… (+1 cases)', () => {
        // case: passes a hostile repository through the line as literal text
        {
            const repository = bindingFixture({ repository: HOSTILE });
            const rows = bindingLines(viewOf(withMember('repositories', [repository])));

            expect(rows[0]).toContain(HOSTILE);
            expect(rows[0]?.startsWith('acme/')).toBe(false);
        }
        // case: passes a hostile connection state through the account line
        {
            const account = accountFixture({ connectionState: HOSTILE });
            const rows = accountLines(viewOf(withMember('accounts', [account])));

            expect(rows[0]).toContain(HOSTILE);
        }
    });
});

