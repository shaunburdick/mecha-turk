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
import { MAX_PROJECTED_FOLLOW_UPS } from '../service/poll/run-history-project.ts';
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

/**
 * How many follow-ups the bound tests put on one run: the read's own bound, plus
 * five, so the last one sits past it.
 */
const BOUND_FOLLOW_UPS = MAX_PROJECTED_FOLLOW_UPS + 5;

/** The comment id of the owed follow-up those tests carry: the last of the set. */
const OWED_COMMENT = 700 + BOUND_FOLLOW_UPS - 1;

/** The comment ids the bound set carries, in detection order. */
const BOUND_COMMENT_IDS: readonly number[] = Array.from(
    { length: BOUND_FOLLOW_UPS },
    (_unused, index) => 700 + index,
);

/** The deterministic delivery id one comment follow-up row carries. */
function commentDeliveryId(commentId: number): string {
    return `evt-acme~widget~7~77331~followup~${commentId}`;
}

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
 * The write-holder a host double hands back for a write it is holding open.
 *
 * One write to the dispatch record can be held at a time. That is what lets a
 * test land a second writer *inside* the first one's read-modify-write: the
 * panel has already read the document, and the write that would publish the
 * result has not landed yet.
 */
interface WriteHolder {
    /** Let the held write land; a no-op while nothing is held. */
    readonly release: () => void;
}

/** Let queued promises and timers settle; the shared `tick`, a few times over. */
async function settle(rounds = 4): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
        await tick();
    }
}

/**
 * A host double that serves the relay's own view of one run's follow-ups.
 *
 * The runs view mirrors the route's own window rule — open at or after the
 * named delivery id, **up to the same bound** the route applies
 * ({@link MAX_PROJECTED_FOLLOW_UPS}: the oldest twenty rows in detection order,
 * delivered or not), and from the start when the parameter is absent or names
 * an id this row does not carry — so a test can land a follow-up *behind* the
 * window's opening the way a delivered successor does in production. The bound
 * is the half that matters: a double that answered every row would prove a
 * delivery the real read cannot make, because the route cannot page inside one
 * run's follow-up list. The service-side rule is proven against the real
 * service in `follow-up-lifecycle.test.ts`; what this double exists for is the
 * panel's half.
 */
function reofferHost(input: {
    /** The follow-ups the run carries, in detection order. */
    readonly followUps: readonly RunFollowUp[];
    /** The stored dispatch-record document the mount starts from. */
    readonly stored?: JsonValue;
    /** The prompt switch; every prompt is accepted while it is `true`. */
    readonly sent?: SentHolder;
    /** Hold the first write to the dispatch record until the holder releases it. */
    readonly holdFirstWrite?: boolean;
}): { readonly host: PanelHost; readonly log: ReofferLog; readonly sent: SentHolder; readonly hold: WriteHolder } {
    const prompts: string[] = [];
    const writes: { key: string; value: unknown }[] = [];
    const opened: string[] = [];
    const values = new Map<string, JsonValue>();
    const sent: SentHolder = input.sent ?? { value: true };
    let held: (() => void) | null = null;
    let isHolding = input.holdFirstWrite === true;
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
                const window = opening < 0
                    ? input.followUps.slice(0, MAX_PROJECTED_FOLLOW_UPS)
                    : input.followUps.slice(opening, opening + MAX_PROJECTED_FOLLOW_UPS);

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
                    if (isHolding && key === DISPATCH_STORAGE_KEY) {
                        isHolding = false;
                        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2024; lib is ES2023.
                        const gate = new Promise<void>((resolve) => {
                            held = resolve;
                        });
                        await gate;
                    }

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
        hold: {
            release: () => {
                const resolve = held;
                held = null;
                resolve?.();
            },
        },
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
            // the next tick must deliver — and opening at the *start* instead
            // is just as bad, because the read's oldest-twenty bound would put
            // the owed record out of range once it sits at position 21 or
            // later. The opening is the owed record's own id.
            const owed = documentOf(
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
                recordFixture({ attempt: 2, nextAttemptAtMs: 5_000, reason: 'session-busy' }),
            );
            expect(followUpWindowOpening(owed)).toBe(DELIVERY);

            // A parked record is excluded from automatic handling, so the walk
            // goes on past it — and a re-offer is what turns it owed again.
            const parked = documentOf(
                recordFixture({ attempt: 3, parked: true, reason: 'session-busy' }),
                recordFixture({ deliveryId: SUCCESSOR, delivered: true }),
            );
            expect(followUpWindowOpening(parked)).toBe(SUCCESSOR);
        }
    });

    it('opens at an owed follow-up past the read\'s bound, rather than before it', () => {
        {
            // The bound is the service's and the panel cannot page inside one
            // run's follow-up list, so the window opening is the only thing that
            // crosses it. Twenty-four delivered records and an owed one at
            // position 25: opening at the start projects the oldest twenty rows,
            // every one of them delivered, and the owed one never retries and
            // never parks — it is reported as waiting forever.
            const delivered = BOUND_COMMENT_IDS
                .filter((commentId) => commentId !== OWED_COMMENT)
                .map((commentId) => recordFixture({ deliveryId: commentDeliveryId(commentId), delivered: true }));
            const owed = recordFixture({
                deliveryId: commentDeliveryId(OWED_COMMENT),
                attempt: 2,
                nextAttemptAtMs: 5_000,
                reason: 'session-busy',
            });

            expect(followUpWindowOpening(documentOf(...delivered, owed)))
                .toBe(commentDeliveryId(OWED_COMMENT));
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
            // Honest copy: the re-offer buys one more attempt under the ladder
            // the follow-up already spent, so a second failure parks it again.
            expect(rt.state.dispatches.note).toContain('buys one more attempt');
            expect(rt.state.dispatches.note).toContain('the retry ladder is not refreshed');
            expect(rt.state.dispatches.note).toContain('parks it again at once');
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
 * The concurrent writer: a re-offer landing inside a relay tick.
 *
 * Every writer of `mecha-turk:dispatches` is `load → transform → persist`,
 * and the section spans two awaits. A re-offer that reads the document and
 * then waits behind a slow host write while a relay tick writes its own
 * outcome publishes the document derived from its earlier read, so whichever
 * write lands second erases the other — and the erased one is either a park
 * that comes back or a `delivered: true` the next tick re-sends: the second
 * prompt NFR-002 and constitution III exist to prevent.
 * ------------------------------------------------------------------ */

describe('the re-offer inside a relay tick (NFR-002, constitution III)', () => {
    it('keeps the tick’s delivery write, so the re-offer cannot unpick it', async () => {
        {
            const parked = recordFixture({ attempt: 3, parked: true, reason: 'session-busy' });
            const followUps = [
                followUpFixture(),
                followUpFixture({
                    deliveryId: SUCCESSOR,
                    sourceUrl: 'https://github.com/acme/widget/issues/7#issuecomment-502',
                }),
            ];
            const { host, log, hold } = reofferHost({
                followUps,
                stored: storedDocument([parked]),
                holdFirstWrite: true,
            });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(followUps), [parked]);

            await reofferFollowUp(rt);
            // The second click starts the re-offer's write, which the double
            // holds open: the panel has read the document and nothing is
            // published yet.
            const reoffer = reofferFollowUp(rt);
            await settle();

            // A relay tick lands inside it. It reads the same document the
            // re-offer read, delivers the follow-up that is still outstanding,
            // and records the outcome.
            const tickRun = pollRelay(rt);
            await settle();
            expect(log.prompts).toHaveLength(1);
            expect(COMMENT_URL.exec(log.prompts[0] ?? '')?.[1]).toBe('502');

            hold.release();
            await settle();
            await tickRun;
            await reoffer;

            // Both writes survived, in the document storage actually holds.
            // The unsynchronized re-offer publishes the document it derived from
            // its earlier read, so whichever write lands second erases the other
            // — and the erased one is either a park that comes back or a
            // delivery the next tick sends again.
            const durable = readDispatchRecord(await host.storage.get(DISPATCH_STORAGE_KEY));
            const records = new Map((durable?.followUps ?? []).map((record) => [record.deliveryId, record]));
            expect(records.get(DELIVERY)).toMatchObject({ parked: false, delivered: false });
            expect(records.get(SUCCESSOR)).toMatchObject({ delivered: true });

            // The durable record is what makes that the end of it, not the write
            // that happened to land last: the next tick owes the re-offered
            // follow-up its session, and the follow-up the tick already
            // delivered is never sent a second time.
            await pollRelay(rt);
            await tick();
            await pollRelay(rt);
            await tick();
            const delivered = log.prompts.map((message) => COMMENT_URL.exec(message)?.[1]);

            expect(log.prompts).toHaveLength(2);
            expect(new Set(delivered).size).toBe(2);
            expect(delivered.at(-1)).toBe('501');
        }
    });
});

/* ------------------------------------------------------------------ *
 * The read's bound: an owed follow-up the oldest twenty cannot reach.
 *
 * `GET /v1/events` projects a run's **oldest twenty** follow-up rows in
 * detection order, delivered or not, and it cannot page inside one run's list
 * (`run-history-project.ts`) — so the window opening is the only thing that
 * crosses the bound. An owed follow-up past position 20 is therefore reachable
 * only when the opening lands at or before it, and the pre-fix opening (the
 * read's start) does not: it projects twenty rows that are all delivered.
 * ------------------------------------------------------------------ */

/** The follow-up rows of the bound set, as the run history projection carries them. */
function boundFollowUps(): readonly RunFollowUp[] {
    return BOUND_COMMENT_IDS.map((commentId) => followUpFixture({
        deliveryId: commentDeliveryId(commentId),
        sourceUrl: `https://github.com/acme/widget/issues/7#issuecomment-${commentId}`,
    }));
}

/** A durable record for every follow-up of the bound set, delivered in detection order. */
function boundDeliveredRecords(): readonly FollowUpDeliveryRecord[] {
    return BOUND_COMMENT_IDS
        .filter((commentId) => commentId !== OWED_COMMENT)
        .map((commentId) => recordFixture({ deliveryId: commentDeliveryId(commentId), delivered: true }));
}

/** The owed record at the end of the bound set, mid-ladder on its second attempt. */
function owedRecord(overrides: Partial<FollowUpDeliveryRecord> = {}): FollowUpDeliveryRecord {
    return recordFixture({
        deliveryId: commentDeliveryId(OWED_COMMENT),
        attempt: 2,
        nextAttemptAtMs: 5_000,
        reason: 'session-busy',
        ...overrides,
    });
}

describe('the owed follow-up past the read\'s bound (FR-104, FR-105)', () => {
    it('is delivered by the next tick, rather than stranded behind the oldest twenty', async () => {
        {
            // The regression the walk used to carry: a subject that kept moving
            // filled the projected window with delivered follow-ups, and the one
            // still owed a session sat at position 25 — outside it. Resetting the
            // opening to the start (the read's own pre-parameter answer) does
            // not reach it, because the bound counts rows, not positions: the
            // oldest twenty are all delivered and the owed one is never
            // projected. It then never retries and never parks, and the row
            // reports it as waiting forever.
            const { host, log } = reofferHost({
                followUps: boundFollowUps(),
                stored: storedDocument([...boundDeliveredRecords(), owedRecord()]),
            });
            const rt = relayRuntime(host);

            await pollRelay(rt);
            await tick();

            // The opening is the owed record's own id, so the window is the one
            // row that matters and the ladder continues from where it left off.
            expect(log.prompts).toHaveLength(1);
            expect(COMMENT_URL.exec(log.prompts[0] ?? '')?.[1]).toBe(String(OWED_COMMENT));
            expect(lastRecordWrite(log.writes)?.followUps?.at(-1)).toMatchObject({
                deliveryId: commentDeliveryId(OWED_COMMENT),
                delivered: true,
                parked: false,
                reason: null,
                attempt: 3,
            });

            // At most once, exactly as before the bound was crossed.
            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(1);
            expect(log.opened).toEqual([]);
        }
    });

    it('is delivered after a re-offer, which is the commit\'s own purpose', async () => {
        {
            // The re-offer turns a parked record into an owed one. If that owed
            // record resets the opening to the start, the read projects the
            // oldest twenty delivered rows and the re-offered follow-up is
            // invisible: the operator clears the park and gets a wait that never
            // resolves — the exact no-op the re-offer exists to end.
            const records = [...boundDeliveredRecords(), owedRecord({
                attempt: 3,
                nextAttemptAtMs: null,
                reason: 'session-busy',
                parked: true,
            })];
            const followUps = boundFollowUps();
            const { host, log } = reofferHost({ followUps, stored: storedDocument(records) });
            const rt = relayRuntime(host);
            rt.state.dispatches = dispatchesState(rowFixture(followUps), records);

            await pollRelay(rt);
            await tick();
            expect(log.prompts).toHaveLength(0);

            await reofferFollowUp(rt);
            await reofferFollowUp(rt);
            await tick();

            await pollRelay(rt);
            await tick();

            expect(log.prompts).toHaveLength(1);
            expect(COMMENT_URL.exec(log.prompts[0] ?? '')?.[1]).toBe(String(OWED_COMMENT));
            expect(lastRecordWrite(log.writes)?.followUps?.at(-1)).toMatchObject({
                deliveryId: commentDeliveryId(OWED_COMMENT),
                delivered: true,
                parked: false,
                attempt: 4,
            });

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
