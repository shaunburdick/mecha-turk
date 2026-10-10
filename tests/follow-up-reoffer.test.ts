/**
 * The operator-initiated re-offer of a parked follow-up (002 FR-105, AC-051).
 *
 * The audit that closed PR #43 found the clause undelivered: a follow-up that
 * exhausted its retry ladder parked on the panel's own record with its cause
 * named, and **nothing anywhere cleared the park** — the flag had no writer, so
 * the delivery was visible and unrecoverable. This suite holds the delivered
 * behaviour, and each test names the regression it would catch if the fix were
 * reverted:
 *
 * 1. **The record** — the re-offer clears the park and its cause and nothing
 *    else: `delivered` and `attempt` are the at-most-once evidence and stay as
 *    they were, and the re-offered record is appended so the relay's window
 *    opening cannot sit past it (`follow-up.ts`'s walk).
 * 2. **The action** — two clicks, the panel's own idiom, with the honest
 *    refusals: a delivered follow-up and a never-attempted one are neither
 *    offered nor written.
 * 3. **The relay** — the re-offered follow-up actually reaches `host.prompt`
 *    into the run's session on a later tick, exactly once, including when a
 *    later follow-up on the same run was delivered after it parked.
 * 4. **The remount** — a partially-attempted record is *resumed*, not parked:
 *    a closed panel leaves the follow-up due, which is why the `panel-closed`
 *    failure kind has no writer and is not in the union any more.
 *
 * Offline by construction: the fake host, a storage double, and the relay
 * driven tick by tick — no live OpenChamber, no PAT, no network (AGENTS.md).
 */

import { describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult, JsonValue, PromptRequest, SessionSnapshot } from '@openchamber/sdk';
import {
    DISPATCH_SCHEMA_VERSION,
    DISPATCH_STORAGE_KEY,
    readDispatchRecord,
    reofferFollowUpDelivery,
    reofferFollowUpRecords,
} from '../src/dispatch-record.ts';
import type { DispatchRecordDocument, FollowUpDeliveryRecord } from '../src/dispatch-record.ts';
import { reofferableFollowUps } from '../src/dispatches-detail.ts';
import { dispatchRow } from '../src/dispatches-rows.ts';
import { reofferFollowUp } from '../src/dispatches.ts';
import { followUpWindowOpening, trackCurrentSession } from '../src/follow-up.ts';
import { pollRelay } from '../src/relay.ts';
import { initialDispatches } from '../src/panel-state.ts';
import type { DispatchesState, PanelRuntime } from '../src/panel-state.ts';
import type { RunFollowUp, RunRow } from '../src/dispatches-service.ts';
import type { PanelHost } from '../src/session.ts';
import { parseJsonValue } from '../src/json.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Session id the fixture dispatch recorded, and the host shows as current. */
const SESSION = 'ses_reoffer_1';

/** Correlation id of the run the fixture follow-ups belong to. */
const CORRELATION = 'mt-run-aaaabbbbccccddddeeeeffff';

/** The delivery id the parked fixture follow-up carries. */
const DELIVERY = 'evt-acme~widget~7~77331~followup~501';

/** The delivery id of a later follow-up on the same run, already delivered. */
const SUCCESSOR = 'evt-acme~widget~7~77331~followup~502';

/** The comment id the composed message names, read off its source URL. */
const COMMENT_URL = /#issuecomment-(\d+)/;

/** RFC 3339 stamp every fixture record carries. */
const STAMP = '2026-10-10T12:00:00.000Z';

/** Releases a host subscription; the fake host registers nothing to release. */
function release(): void {
    // Nothing to release: the double's `onSession` fires once, synchronously.
}

/** Build one follow-up as the runs-history projection carries it. */
function followUpFixture(overrides: Partial<RunFollowUp> = {}): RunFollowUp {
    return {
        deliveryId: DELIVERY,
        kind: 'comment',
        excerpt: 'the drift is back',
        actorLogin: 'alice',
        detectedAt: STAMP,
        sourceUrl: 'https://github.com/acme/widget/issues/7#issuecomment-501',
        ...overrides,
    };
}

/** Build the dispatched row the fixture follow-ups ride on. */
function rowFixture(followUps: readonly RunFollowUp[] = [followUpFixture()]): RunRow {
    return {
        id: CORRELATION,
        correlationId: CORRELATION,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        state: 'dispatched',
        stateReason: 'dispatched',
        runKey: 'github|77331|acme/widget|issue|7|0',
        ordinal: 0,
        attempt: 1,
        attachmentId: CORRELATION,
        projectId: 'prj_42',
        worktreeOption: 'none',
        leaseExpiresAt: null,
        resultDeadlineAt: null,
        sourceReferences: [],
        referenceCount: 0,
        referencesTruncated: false,
        referencesNotRetained: 0,
        session: { sessionId: SESSION, attachmentId: CORRELATION, dispatchedAt: STAMP },
        verification: null,
        detectedAt: STAMP,
        claimedAt: null,
        dispatchedAt: STAMP,
        dispatchResult: SESSION,
        bindingId: 'bnd-1',
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        actorPolicy: null,
        followUps,
    };
}

/** Build one durable follow-up record, as the panel's own store holds it. */
function recordFixture(overrides: Partial<FollowUpDeliveryRecord> = {}): FollowUpDeliveryRecord {
    return {
        deliveryId: DELIVERY,
        correlationId: CORRELATION,
        sessionId: SESSION,
        attempt: 1,
        nextAttemptAtMs: null,
        delivered: false,
        reason: null,
        parked: false,
        updatedAt: STAMP,
        ...overrides,
    };
}

/** The stored document the fixture records live in. */
function storedDocument(records: readonly FollowUpDeliveryRecord[]): JsonValue {
    const document: DispatchRecordDocument = {
        schemaVersion: DISPATCH_SCHEMA_VERSION,
        attempts: [],
        followUps: records,
    };

    return parseJsonValue(JSON.stringify(document));
}

/** What one relay-serving host double saw. */
interface ReofferLog {
    /** Every message text a prompt carried, in order. */
    readonly prompts: readonly string[];
    /** Every `storage.set` the host received, with key and value. */
    readonly writes: readonly { readonly key: string; readonly value: unknown }[];
    /** The host session reads, in order. */
    readonly opened: readonly string[];
}

/** The holder a test flips to make the next prompt succeed or be skipped. */
interface SentHolder {
    /** Whether the next prompt is accepted. */
    value: boolean;
}

/**
 * A host double that serves the relay's own view of one run's follow-ups.
 *
 * The runs view mirrors the route's own window rule — open at or after the
 * named delivery id, and from the start when the parameter is absent or names
 * an id this row does not carry — so a test can land a follow-up *behind* the
 * window's opening the way a delivered successor does in production. The
 * service-side half of that rule is proven against the real service in
 * `follow-up-lifecycle.test.ts`; what this double exists for is the panel's
 * half.
 */
function reofferHost(input: {
    /** The follow-ups the run carries, in detection order. */
    readonly followUps: readonly RunFollowUp[];
    /** The stored dispatch-record document the mount starts from. */
    readonly stored?: JsonValue;
    /** The prompt switch; every prompt is accepted while it is `true`. */
    readonly sent?: SentHolder;
}): { readonly host: PanelHost; readonly log: ReofferLog; readonly sent: SentHolder } {
    const prompts: string[] = [];
    const writes: { key: string; value: unknown }[] = [];
    const opened: string[] = [];
    const values = new Map<string, JsonValue>();
    const sent: SentHolder = input.sent ?? { value: true };
    if (input.stored !== undefined) {
        values.set(DISPATCH_STORAGE_KEY, input.stored);
    }

    return {
        host: fakeHost({
            serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                if (request.path === '/v1/config') {
                    return { status: 200, body: '{}' };
                }

                if (request.path === '/v1/events/pending') {
                    return { status: 200, body: JSON.stringify({ events: [], status: [], auditWritten: true }) };
                }

                if (!request.path.startsWith('/v1/events')) {
                    return { status: 404, body: '{}' };
                }

                const from = new URL(`http://relay${request.path}`).searchParams.get('followUpsFrom');
                const opening = from === null
                    ? -1
                    : input.followUps.findIndex((entry) => entry.deliveryId === from);
                const window = opening < 0 ? input.followUps : input.followUps.slice(opening);

                return {
                    status: 200,
                    body: JSON.stringify({
                        events: [rowFixture(window)],
                        page: {
                            limit: 100,
                            nextCursor: null,
                            hasMore: false,
                            total: 1,
                            snapshotAt: STAMP,
                            filter: { bindingId: null, state: 'dispatched' },
                        },
                    }),
                };
            },
            storage: {
                get: async (key: string): Promise<JsonValue | undefined> => values.get(key),
                set: async (key: string, value: JsonValue) => {
                    writes.push({ key, value });
                    values.set(key, value);
                },
                delete: async (key: string) => {
                    values.delete(key);
                },
                keys: async () => [...values.keys()],
            },
            onSession: (listener: (session: SessionSnapshot | null) => void) => {
                listener({ id: SESSION, title: 't', busy: false });

                return release;
            },
            openSession: async (sessionId: string) => {
                opened.push(sessionId);
            },
            prompt: async (request: PromptRequest) => {
                prompts.push(request.text);

                return { sent: sent.value ? 'sent' : 'skipped' };
            },
        }),
        log: { prompts, writes, opened },
        sent,
    };
}

/** A runtime whose host session tracking is armed, as `startRelayPolling` arms it. */
function relayRuntime(host: PanelHost): PanelRuntime {
    const rt = createTestRuntime(host);
    rt.unsubscribes.push(trackCurrentSession(rt));

    return rt;
}

/** The Dispatches state a mounted board holds with one selected row. */
function dispatchesState(
    row: RunRow,
    records: readonly FollowUpDeliveryRecord[],
): DispatchesState {
    return {
        ...initialDispatches(),
        status: 'ready',
        rows: [row],
        selectedRun: row.id,
        followUpRecords: records,
    };
}

/**
 * The dispatch-record document the last record write carried.
 *
 * The last write **to that key**, not the last write of any kind: the trail
 * entry a settled attempt appends rides `mecha-turk:ledger` and lands after it.
 */
function lastRecordWrite(writes: ReofferLog['writes']): DispatchRecordDocument | null {
    const recorded = writes.findLast((write) => write.key === DISPATCH_STORAGE_KEY)?.value;

    return recorded === undefined ? null : recorded as DispatchRecordDocument;
}

/* ------------------------------------------------------------------ *
 * The record: the park clears, the bookkeeping stands.
 * ------------------------------------------------------------------ */

describe('the re-offer record (FR-105, NFR-002)', () => {
    it('clears the park and its cause, and keeps the delivery and attempt bookkeeping', () => {
        {
            const document: DispatchRecordDocument = {
                schemaVersion: DISPATCH_SCHEMA_VERSION,
                attempts: [],
                followUps: [recordFixture({ attempt: 3, parked: true, reason: 'session-busy' })],
            };

            const next = reofferFollowUpRecords({
                document,
                deliveryIds: [DELIVERY],
                at: '2026-10-10T13:00:00.000Z',
            });

            const reoffered = next?.followUps ?? [];
            expect(reoffered).toHaveLength(1);
            expect(reoffered[0]).toEqual({
                deliveryId: DELIVERY,
                correlationId: CORRELATION,
                sessionId: SESSION,
                // The ladder's count is history, not bookkeeping to reset.
                attempt: 3,
                nextAttemptAtMs: null,
                delivered: false,
                reason: null,
                parked: false,
                updatedAt: '2026-10-10T13:00:00.000Z',
            });
        }
    });

    it('appends the re-offered record, so the window opening cannot sit past it', () => {
        {
            const document: DispatchRecordDocument = {
                schemaVersion: DISPATCH_SCHEMA_VERSION,
                attempts: [],
                followUps: [
                    recordFixture({ deliveryId: DELIVERY, attempt: 3, parked: true, reason: 'session-busy' }),
                    recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
                ],
            };

            const next = reofferFollowUpRecords({
                document,
                deliveryIds: [DELIVERY],
                at: '2026-10-10T13:00:00.000Z',
            });

            // Write order is what the walk reads (`followUpWindowOpening`), so a
            // re-offered record that stayed in place would leave an owed
            // follow-up behind the opening and be delivered by nobody.
            expect(next?.followUps?.map((record) => record.deliveryId)).toEqual([SUCCESSOR, DELIVERY]);
        }
    });

    it('re-offers nothing that is delivered, unrecorded, or never parked', () => {
        {
            const delivered: DispatchRecordDocument = {
                schemaVersion: DISPATCH_SCHEMA_VERSION,
                attempts: [],
                followUps: [recordFixture({ delivered: true, parked: false })],
            };
            const midLadder: DispatchRecordDocument = {
                schemaVersion: DISPATCH_SCHEMA_VERSION,
                attempts: [],
                followUps: [recordFixture({ attempt: 2, nextAttemptAtMs: 5_000, reason: 'session-busy' })],
            };
            const empty: DispatchRecordDocument = { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: [] };

            for (const document of [delivered, midLadder, empty]) {
                expect(reofferFollowUpRecords({
                    document,
                    deliveryIds: [DELIVERY],
                    at: '2026-10-10T13:00:00.000Z',
                })).toBeNull();
            }

            // An id this panel never recorded is not a re-offer either.
            expect(reofferFollowUpRecords({
                document: midLadder,
                deliveryIds: ['evt-acme~widget~7~77331~followup~999'],
                at: '2026-10-10T13:00:00.000Z',
            })).toBeNull();
        }
    });

    it('writes nothing when the panel cannot read its own record', async () => {
        {
            const writes: { key: string; value: unknown }[] = [];
            const rt = createTestRuntime(fakeHost({
                storage: {
                    get: async () => {
                        throw new Error('storage unavailable');
                    },
                    set: async (key: string, value: JsonValue) => {
                        writes.push({ key, value });
                    },
                    delete: () => Promise.resolve(),
                    keys: async () => [],
                },
            }));

            const wasChanged = await reofferFollowUpDelivery({ rt, deliveryIds: [DELIVERY] });

            // Fail closed (invariant 8): an unreadable record is not a licence
            // to write one, and the operator is told nothing changed.
            expect(wasChanged).toBe(false);
            expect(writes).toEqual([]);
        }
    });

    it('refuses a parked reason outside the closed union, because a closed panel parks nothing', () => {
        {
            // `panel-closed` was the orphan the audit found: a failure kind the
            // union carried with no writer anywhere. A panel that closes leaves
            // its follow-up due and the remount resumes it (User Story 7's
            // third scenario), so the kind is gone — and a stored document that
            // still names it is refused rather than half-applied. The value is
            // spelled straight into the serialized document rather than cast
            // into the record type: the reader is being handed exactly what a
            // rogue writer would put on disk, not what the type admits.
            const parked = recordFixture({ attempt: 3, parked: true });
            const orphan = parseJsonValue(JSON.stringify({
                schemaVersion: DISPATCH_SCHEMA_VERSION,
                attempts: [],
                followUps: [{ ...parked, reason: 'panel-closed' }],
            }));

            expect(readDispatchRecord(orphan)).toBeNull();
        }
    });
});

/* ------------------------------------------------------------------ *
 * The walk's opening: past what settled, never past what is owed.
 * ------------------------------------------------------------------ */

/** A record document holding exactly these records. */
function documentOf(...records: readonly FollowUpDeliveryRecord[]): DispatchRecordDocument {
    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: [], followUps: records };
}

describe('the follow-up window opening (FR-104, FR-105)', () => {
    it('opens past the newest delivered follow-up, and from the start with nothing delivered', () => {
        {
            expect(followUpWindowOpening(documentOf())).toBeNull();

            const delivered = documentOf(recordFixture({ delivered: true }));
            expect(followUpWindowOpening(delivered)).toBe(DELIVERY);

            const twoDelivered = documentOf(
                recordFixture({ delivered: true }),
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
            );
            expect(followUpWindowOpening(twoDelivered)).toBe(SUCCESSOR);
        }
    });

    it('stops at an owed follow-up, and a parked one never stops it', () => {
        {
            // A mid-ladder record the relay still owes a session: opening past
            // the delivered successor behind it would hide the very follow-up
            // the next tick must deliver.
            const owed = documentOf(
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
                recordFixture({ attempt: 2, nextAttemptAtMs: 5_000, reason: 'session-busy' }),
            );
            expect(followUpWindowOpening(owed)).toBeNull();

            // A parked record is excluded from automatic handling, so the walk
            // goes on past it — and a re-offer is what turns it owed again.
            const parked = documentOf(
                recordFixture({ attempt: 3, parked: true, reason: 'session-busy' }),
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
            );
            expect(followUpWindowOpening(parked)).toBe(SUCCESSOR);
        }
    });
});

/* ------------------------------------------------------------------ *
 * The action: two clicks, and the refusals that keep it honest.
 * ------------------------------------------------------------------ */

describe('the operator action (FR-105, AC-051)', () => {
    it('arms with the copy, then clears the park on the panel’s own record', async () => {
        {
            const parked = recordFixture({ attempt: 3, parked: true, reason: 'session-busy' });
            const { host, log } = reofferHost({
                followUps: [followUpFixture()],
                stored: storedDocument([parked]),
            });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(), [parked]);

            await reofferFollowUp(rt);

            // The first click states what will happen and writes nothing.
            expect(rt.state.dispatches.pendingAction).toBe('reoffer-follow-up');
            expect(rt.state.dispatches.note).toContain('Confirm: re-offer the parked follow-up for #7');
            expect(rt.state.dispatches.note).toContain('the next relay poll delivers it once more');
            expect(log.writes).toEqual([]);

            await reofferFollowUp(rt);
            await tick();

            // The second click writes the record and refreshes the row's view
            // of it, so the parked line drops without waiting for a refresh.
            expect(rt.state.dispatches.pendingAction).toBeNull();
            expect(rt.state.dispatches.note).toContain('Re-offered the parked follow-up for #7');
            expect(rt.state.dispatches.followUpRecords).toEqual([expect.objectContaining({
                deliveryId: DELIVERY,
                parked: false,
                reason: null,
                nextAttemptAtMs: null,
                delivered: false,
            })]);
            // The record document is the only thing written — no service call,
            // no other key (FR-107's closed surface).
            expect(log.writes.map((write) => write.key)).toEqual([DISPATCH_STORAGE_KEY]);
        }
    });

    it('offers no re-offer for a delivered follow-up, and writes nothing', async () => {
        {
            const delivered = recordFixture({ delivered: true });
            const { host, log } = reofferHost({ followUps: [followUpFixture()], stored: storedDocument([delivered]) });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(), [delivered]);

            expect(reofferableFollowUps(rowFixture(), [delivered])).toEqual([]);

            await reofferFollowUp(rt);

            // The refusal names both absences, because both are facts the
            // operator can act on: a delivered follow-up has nothing to send
            // again, and an unattempted one is already due.
            expect(rt.state.dispatches.pendingAction).toBeNull();
            expect(rt.state.dispatches.note).toContain('Nothing to re-offer');
            expect(rt.state.dispatches.note).toContain('already due');
            expect(log.writes).toEqual([]);
        }
    });

    it('offers no re-offer for a follow-up nobody attempted', async () => {
        {
            const { host, log } = reofferHost({ followUps: [followUpFixture()] });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(), []);

            // Nothing recorded means outstanding, not parked: the relay's own
            // tick owes it a session, so there is nothing to re-offer.
            expect(reofferableFollowUps(rowFixture(), [])).toEqual([]);

            await reofferFollowUp(rt);

            expect(rt.state.dispatches.note).toContain('Nothing to re-offer');
            expect(log.writes).toEqual([]);
        }
    });
});

/* ------------------------------------------------------------------ *
 * The relay: the re-offered follow-up reaches the session, once.
 * ------------------------------------------------------------------ */

describe('the relay delivers what the re-offer frees (FR-104, FR-105)', () => {
    it('delivers the re-offered follow-up exactly once on a later tick', async () => {
        {
            const parked = recordFixture({ attempt: 3, parked: true, reason: 'session-busy' });
            const { host, log } = reofferHost({ followUps: [followUpFixture()], stored: storedDocument([parked]) });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(), [parked]);

            // The park holds while it holds: no tick attempts it, and the cause
            // a parked reason named is what the row keeps.
            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(0);
            expect(dispatchRow(rowFixture(), [parked]).subtitle).toContain('parked: the session was mid-turn');

            await reofferFollowUp(rt);
            await reofferFollowUp(rt);
            await tick();

            // The next relay tick is what delivers it — the re-offer moved the
            // record, it did not send anything itself.
            await pollRelay(rt);
            await tick();

            expect(log.prompts).toHaveLength(1);
            // Into the run's own session: the composed message names the
            // movement and the session the dispatch recorded, and no navigation
            // happened — the host was already showing it.
            expect(log.prompts[0]).toContain(`Session: ${SESSION}`);
            expect(COMMENT_URL.exec(log.prompts[0] ?? '')?.[1]).toBe('501');
            // The durable record agrees: delivered once, the ladder's count
            // continues from where the park left it, and the cause is gone.
            const document = lastRecordWrite(log.writes);
            expect(document?.followUps?.at(-1)).toMatchObject({
                deliveryId: DELIVERY,
                delivered: true,
                parked: false,
                reason: null,
                attempt: 4,
            });

            // At-most-once: the ticks after that deliver nothing further, and
            // no navigation happened either — the target was already current.
            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(1);
            expect(log.opened).toEqual([]);
        }
    });

    it('delivers a re-offered follow-up that parked behind a delivered successor', async () => {
        {
            // The busy-subject case the walk is about: a later follow-up on the
            // same run was delivered after this one parked, so the read's
            // window opening sits past it. Without the re-offer moving the
            // record to the end of the list, the relay would never see it
            // again and the re-offer would be a silent no-op.
            const records = [
                recordFixture({ attempt: 3, parked: true, reason: 'session-busy' }),
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
            ];
            const { host, log } = reofferHost({
                followUps: [followUpFixture(), followUpFixture({ deliveryId: SUCCESSOR })],
                stored: storedDocument(records),
            });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture([followUpFixture(), followUpFixture({
                deliveryId: SUCCESSOR,
            })]), records);

            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(0);

            await reofferFollowUp(rt);
            await reofferFollowUp(rt);
            await tick();

            await pollRelay(rt);
            await tick();

            expect(log.prompts).toHaveLength(1);
            expect(COMMENT_URL.exec(log.prompts[0] ?? '')?.[1]).toBe('501');

            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(1);
        }
    });
});

/* ------------------------------------------------------------------ *
 * The remount: a partially-attempted record is resumed, not parked.
 * ------------------------------------------------------------------ */

describe('a remount resumes a partially-attempted follow-up', () => {
    it('delivers the follow-up the mount it left behind was mid-ladder on', async () => {
        {
            // What a panel that closed between attempts leaves: the attempt it
            // used, the cause the interrupted call answered with, and no park.
            // The remount is a fresh runtime over the same stored record.
            const partial = recordFixture({ attempt: 2, nextAttemptAtMs: null, reason: 'host-unavailable' });
            const { host, log } = reofferHost({ followUps: [followUpFixture()], stored: storedDocument([partial]) });
            const rt = relayRuntime(host);

            // Parked is false and the record is due: the follow-up is waiting,
            // and the relay's next tick owes it an attempt — no park, and no
            // `panel-closed` cause invented for a mount nobody can see.
            expect(dispatchRow(rowFixture(), [partial]).subtitle).not.toContain('parked:');

            await pollRelay(rt);
            await tick();

            expect(log.prompts).toHaveLength(1);
            const document = lastRecordWrite(log.writes);
            expect(document?.followUps?.at(-1)).toMatchObject({
                deliveryId: DELIVERY,
                attempt: 3,
                delivered: true,
                parked: false,
            });
        }
    });

    it('resumes the ladder when the resumed attempt fails, parking nothing on the mount it cannot see', async () => {
        {
            const partial = recordFixture({ attempt: 2, nextAttemptAtMs: null, reason: 'host-unavailable' });
            const { host, log } = reofferHost({
                followUps: [followUpFixture()],
                stored: storedDocument([partial]),
                sent: { value: false },
            });
            const rt = relayRuntime(host);

            await pollRelay(rt);
            await tick();

            // One attempt, recorded, with the cause the host actually answered
            // — the ladder continued rather than the record parking a mount.
            expect(log.prompts).toHaveLength(1);
            const document = lastRecordWrite(log.writes);
            expect(document?.followUps?.at(-1)).toMatchObject({
                deliveryId: DELIVERY,
                attempt: 3,
                delivered: false,
                parked: false,
                reason: 'session-busy',
            });
        }
    });
});
