/**
 * The service's minimal poll loop (MVP task M1; 002 FR-065 – FR-073): each
 * enabled binding with an on trigger is scanned once per interval, and one
 * observation can only ever produce one queued event.
 */

import { readAccount } from '../accounts/store.ts';
import { readBindings, readStoredCreationStamps } from '../bindings-read.ts';
import { appendAudit } from '../audit.ts';
import { resolvePromptSnapshot } from '../prompt.ts';
import { runRetentionPasses } from '../retention.ts';
import { repositoryRefOf } from '../../src/config.ts';
import type { ServiceConfig } from '../config.ts';
import type { BindingRecord } from '../bindings.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { readCycleConfig } from './cycle-config.ts';
import { runEngineDeliveryPass } from './engine-delivery.ts';
import { enqueueEvents, readEvents } from './events.ts';
import type { QueuedEvent } from './events.ts';
import { followUpSubjects, withoutEndedFollowUps } from './follow-up.ts';
import type { GitHubIssuePoller, ListPace, PollFailure, PollIssue, PollPull } from './poller-github.ts';
import { previewRunsDocument } from './runs-document.ts';
import { bindingScanOf, readScanState, serializeScan, withBindingScanState, writeScanState } from './scan.ts';
import type { BindingScanState, ScanState } from './scan.ts';
import { collectTriggerEvents } from './triggers.ts';
import { checksAuditReason, watchDropsForEnds } from './triggers-checks.ts';
import type { ChecksAudit } from './trigger-scan.ts';
import type { ChecksWatch, RunsDocument  } from './runs-types.ts';
import { observedHeadSeeds, trackedIssueEnds, trackedPullEnds, trackedSubjectsOf } from './tracking.ts';
import type { TrackedSubject, TrackingEnd } from './tracking.ts';
import { answersCatchUp, baselineFor, bindingsNeedingBaseline, widenBaseline, windowFor } from './window.ts';
import type { WindowRefusal } from './window.ts';

// The window rule lives beside its own rationale in `window.ts`; the loop
// re-exports it so `windowFor` keeps one import path for the cycle and for
// the suites that drive it.
export { baselineFor, windowFor };
export type { WindowRefusal, WindowVerdict } from './window.ts';

/**
 * Short machine reasons a scan was skipped, logged instead of upstream text.
 * Six are `PollFailure` classifications, three are 002 FR-072's window
 * refusals — verdicts rather than failures of any call (FR-024) — and the
 * seventh is the run document's own refusal, a stop condition rather than an
 * empty history (constitution II). One vocabulary, because two would be two
 * answers to *why did this scan do nothing* (constitution IV).
 */
export type ScanSkip =
    | 'missing-account'
    | 'inactive-account'
    | 'auth-failed'
    | 'rate-limited'
    | 'offline'
    | 'upstream'
    | 'runs-unreadable'
    | WindowRefusal;

export interface BindingScan {
    readonly bindingId: string;
    /** `owner/name` label. */
    readonly repository: string;
    /** Events enqueued by this scan, after dedupe. */
    readonly enqueued: number;
    /** New window stamp, or `null` when the scan did not complete. */
    readonly windowFrom: string | null;
    /**
     * The lower bound this scan **opened at**, or `null` when it listed nothing.
     *
     * Carried out of {@link scanBinding} and into the slot write, because the
     * retained baseline must be the widest window the binding has ever scanned
     * from and only the scan that opened one can widen it (002 FR-073; plan H8).
     */
    readonly openedFrom: string | null;
    readonly skipped: ScanSkip | null;
}

export interface ScanResult {
    /** Per-binding outcomes, in binding-file order. */
    readonly bindings: readonly BindingScan[];
    readonly enqueued: number;
}

/** Dependencies one scan cycle needs; fixed once at server start. */
export interface ScanDeps {
    /** Open store, or `null` when the data directory is unusable. */
    readonly store: ServiceStore | null;
    readonly log: ServiceLogger;
    readonly poller: GitHubIssuePoller;
    /** The entry point's own environment, read only by the engine pass's two seams; an absent map fails safe. */
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** The narrowed dependencies, built after the null-store check. */
interface ScanContext {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly poller: GitHubIssuePoller;
    /**
     * The configuration this cycle runs on — read **once** at the boundary
     * (006 FR-055, FR-057–FR-059's "one read, once per cycle").
     *
     * The window, the page size, and the retry ladder all take their values
     * from here, which is why one save changes all of them at the same
     * boundary and why no consumer can see a half-updated configuration.
     */
    readonly config: ServiceConfig;
    /** Page size and retry ladder derived from `config`, carried on every list call. */
    readonly pace: ListPace;
}

/** Scheduler state the status projection reads; see [`view.ts`](./view.ts). */
export interface PollLoopState {
    readonly stopped: boolean;
    /** Epoch milliseconds of the next armed cycle, or `null` when none is armed. */
    readonly nextPollAtMs: number | null;
}

export interface PollLoop {
    /** Cancel the pending cycle; an in-flight cycle finishes on its own. */
    stop(): void;
    /**
     * Read the scheduler's own state; never mutates it.
     *
     * The status projection reads the loop through this reader rather than
     * keeping a second copy of the schedule it could drift from.
     */
    state(): PollLoopState;
}

/**
 * Decide whether a binding watches anything this loop implements.
 *
 * A binding whose switches are all off is walked but never scanned, so the
 * scan state stays honest (and no rate budget is spent on a silent binding).
 */
function watchesAnything(binding: BindingRecord): boolean {
    const { assignment, mention, reviewRequest, reviewSubmitted, checks } = binding.triggers;

    return assignment || mention || reviewRequest || reviewSubmitted || checks;
}

/**
 * Translate one upstream failure into a skip reason.
 *
 * One mapping for **every** upstream call the scan makes, the per-item events
 * read included: `skipOf` is what turns a `PollFailure` into the one honest
 * reason a binding's scan reports, and a second mapping for the actor read
 * would be a second answer to "why did this scan stop" (constitution IV).
 */
function skipOf(outcome: PollFailure): ScanSkip {
    if (outcome.kind === 'auth-failed') {
        return 'auth-failed';
    }

    if (outcome.kind === 'rate-limited') {
        return 'rate-limited';
    }

    return outcome.detail === 'timeout' || outcome.detail === 'offline' ? 'offline' : 'upstream';
}

function blankScan(binding: BindingRecord): BindingScan {
    return {
        bindingId: binding.bindingId,
        repository: binding.repository,
        enqueued: 0,
        windowFrom: null,
        openedFrom: null,
        skipped: null,
    };
}

/**
 * Record the end of tracking for every tracked subject observed terminal: one
 * `tracking.ended` row carrying the terminal fact, GitHub's date, and the
 * issue's `state_reason`, so *when did this work item conclude?* is
 * answerable from the trail (002 FR-106). The row names the run and never the
 * session — the item's own state ended tracking. The write is best-effort on
 * the enqueue's terms: a failed append is logged, not thrown back into a scan
 * that succeeded.
 */
async function recordTrackingEnds(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly binding: BindingRecord;
    readonly ends: readonly TrackingEnd[];
}): Promise<void> {
    for (const end of input.ends) {
        try {
            await appendAudit(input.store, {
                eventType: 'tracking.ended',
                actorSource: 'service',
                entity: { kind: 'run', id: end.correlationId },
                correlationId: end.correlationId,
                decision: null,
                reason: `the GitHub item reached its terminal state (${end.fact}); follow-up detection ends`,
                details: {
                    bindingId: input.binding.bindingId,
                    subjectKey: end.subjectKey,
                    subjectType: end.subjectType,
                    subjectNumber: end.subjectNumber,
                    kind: end.fact,
                    state: end.state,
                    ...(end.stateReason !== null && { reason: end.stateReason }),
                    // data-model §"AuditEntry" names the date member after the
                    // fact it records: a merge is the only one that reports one.
                    ...(end.at !== null && (end.fact === 'merged' ? { mergedAt: end.at } : { closedAt: end.at })),
                },
            });
        } catch (cause) {
            input.log.warn('tracking end audit row could not be appended', {
                subjectNumber: end.subjectNumber,
                errorKind: cause instanceof Error ? cause.name : typeof cause,
            });
        }
    }
}

/**
 * Bindings whose `checks.unavailable` row this process has already written,
 * per store handle.
 *
 * Keyed by the handle too: a restarted service writes the row again only after
 * a fresh read of the same store, which is the per-process posture the queue's
 * quarantine recovery takes.
 */
const unavailableBindings = new WeakMap<ServiceStore, Set<string>>();

/**
 * Write the checks audit rows a cycle asked for, best-effort after the run
 * document landed: a failed append is logged rather than failing a scan whose
 * watch write already succeeded (FR-126, NFR-007). `checks.unavailable` is
 * deduped per binding per process here rather than at detection, because this
 * is the one place that writes it: a credential missing the Checks scope fails
 * every cycle, and a row per cycle would bury the trail it explains.
 */
async function recordChecksAudits(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly audits: readonly ChecksAudit[];
}): Promise<void> {
    const reported = unavailableBindings.get(input.store) ?? new Set<string>();
    unavailableBindings.set(input.store, reported);

    for (const audit of input.audits) {
        if (audit.eventType === 'checks.unavailable') {
            if (reported.has(audit.bindingId)) {
                continue;
            }

            reported.add(audit.bindingId);
        }

        try {
            await appendAudit(input.store, {
                eventType: audit.eventType,
                actorSource: 'service',
                entity: { kind: 'run', id: audit.correlationId },
                correlationId: audit.correlationId,
                decision: null,
                reason: checksAuditReason(audit.eventType),
                details: audit.details,
            });
        } catch (cause) {
            input.log.warn('checks audit row could not be appended', {
                eventType: audit.eventType,
                errorKind: cause instanceof Error ? cause.name : typeof cause,
            });
        }
    }
}

/**
 * Read the run document for the tracked-subject view, answering a refusal
 * rather than throwing one: the scan cycle never throws, while the run layer's
 * reader is fail-closed by throwing, and a `runs.json` that exists but cannot
 * be read — or is absent while the queue already carries post-run-layer
 * deliveries — is a state no reader may answer with an empty history. This is
 * the one place a scan turns that refusal into a **skip reason**.
 */
async function previewTrackedDocument(
    input: { readonly store: ServiceStore; readonly log: ServiceLogger },
): Promise<{ readonly value: RunsDocument } | { readonly refused: 'runs-unreadable' }> {
    try {
        return { value: await previewRunsDocument(input) };
    } catch (cause) {
        input.log.warn('run document could not be read for this binding\'s scan; nothing was detected', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return { refused: 'runs-unreadable' };
    }
}

type ScanListing =
    | {
        readonly ok: true;
        readonly events: readonly QueuedEvent[];
        /** Observed heads keyed by pull-request number (FR-103(b)'s seed source). */
        readonly observedHeads?: ReadonlyMap<number, string>;
        /** Tracked subjects whose own list row reported a terminal state (FR-106). */
        readonly ends?: readonly TrackingEnd[];
        /** Check watches armed or advanced this cycle, by run correlation id. */
        readonly checksWrites?: ReadonlyMap<string, ChecksWatch>;
        /** Check watches dropped this cycle, by run correlation id. */
        readonly checksDrops?: readonly string[];
        /** Check audit rows the cycle writes after the run document lands. */
        readonly checksAudits?: readonly ChecksAudit[];
    }
    | { readonly ok: false; readonly skipped: ScanSkip };

/**
 * Observe the terminal state of every subject that produced a follow-up this
 * cycle, and drop the follow-ups whose subject ended (002 FR-106). FR-102
 * admits exactly one read and bounds it: only for a subject that produced a
 * detected follow-up, at most once per subject per cycle, and before the
 * enqueue so a terminal answer drops the row instead of retracting a queued
 * one (NFR-003). Its failure is the scan's own — the whole binding's
 * detection refuses and the checkpoint is retained, so tracking never ends
 * on a guess a `404` might have been a deletion.
 */
async function terminalFollowUpState(input: {
    readonly deps: ScanContext;
    readonly binding: BindingRecord;
    readonly token: string;
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
    readonly events: readonly QueuedEvent[];
}): Promise<
    { readonly events: readonly QueuedEvent[]; readonly ends: readonly TrackingEnd[] }
    | { readonly skipped: ScanSkip }
> {
    const { deps, binding, token, tracked, events } = input;
    const subjects = followUpSubjects(events);
    // FR-102's bound, made visible: a cycle that detected no follow-up issues no
    // read at all, so detection stays zero-added-request.
    if (subjects.issues.length === 0 && subjects.pulls.length === 0) {
        return { events, ends: [] };
    }

    const repository = repositoryRefOf(binding.repository);
    const issueReads: PollIssue[] = [];
    const pullReads: PollPull[] = [];

    for (const itemNumber of subjects.issues) {
        const read = await deps.poller.readIssueState({
            token,
            owner: repository.owner,
            name: repository.name,
            itemNumber,
            pace: deps.pace,
        });
        if (read.kind !== 'ok') {
            return { skipped: skipOf(read) };
        }
        issueReads.push(read.issue);
    }

    for (const itemNumber of subjects.pulls) {
        const read = await deps.poller.readPullState({
            token,
            owner: repository.owner,
            name: repository.name,
            itemNumber,
            pace: deps.pace,
        });
        if (read.kind !== 'ok') {
            return { skipped: skipOf(read) };
        }
        pullReads.push(read.pull);
    }

    const ends = [
        ...trackedIssueEnds({ binding, issues: issueReads, tracked }),
        ...trackedPullEnds({ binding, pulls: pullReads, tracked }),
    ];
    const ended = new Set(ends.map((end) => end.subjectNumber));

    return { events: withoutEndedFollowUps(events, ended), ends };
}

/**
 * List every feed this binding's triggers ask for and collect its events,
 * applying FR-106's terminal read before the events leave for the enqueue.
 * The work belongs to `triggers.ts`; what this function contributes is the
 * cycle's own rule — **the first failure of any call ends the listing and
 * becomes the loop's one skip reason for the binding**, the terminal read
 * included. A binding with none of its switches on lists nothing at all, so
 * the rate budget only pays for triggers the operator turned on.
 */
async function collectScanEvents(input: {
    readonly deps: ScanContext;
    readonly binding: BindingRecord;
    /** The window this cycle opened; every scan has a computable lower bound (002 FR-065). */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
    readonly token: string;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
}): Promise<ScanListing> {
    const { deps, binding, windowStart, detectedAt, token, login, tracked } = input;
    const collected = await collectTriggerEvents({
        poller: deps.poller,
        log: deps.log,
        token,
        binding,
        login,
        windowStart,
        detectedAt,
        pace: deps.pace,
        tracked,
    });
    if (!collected.ok) {
        return { ok: false, skipped: skipOf(collected.failure) };
    }

    // FR-106's one read, before the enqueue: it observes the terminal state of
    // each subject that produced a follow-up and drops the ones that ended. Its
    // failure is the same skip any other call's is, which is why it lives here
    // rather than after the enqueue.
    const terminal = await terminalFollowUpState({
        deps,
        binding,
        token,
        tracked,
        events: collected.events,
    });
    if ('skipped' in terminal) {
        return { ok: false, skipped: terminal.skipped };
    }

    // The one place a tracking-end drop is decided, over the ends both reads
    // reported: an end observed on either is what clears the watch, however the
    // same cycle's watch write turned out (FR-126).
    const ends = [...(collected.ends ?? []), ...terminal.ends];
    const checksDrops = watchDropsForEnds({ tracked, ends });

    return {
        ok: true,
        events: terminal.events,
        ...(collected.observedHeads !== undefined && { observedHeads: collected.observedHeads }),
        ...(ends.length > 0 && { ends }),
        ...(collected.checksWrites !== undefined && { checksWrites: collected.checksWrites }),
        ...(checksDrops.length > 0 && { checksDrops }),
        ...(collected.checksAudits !== undefined && { checksAudits: collected.checksAudits }),
    };
}

/** The enqueue's own input, built once so the scan body stays flat. */
function enqueueScanInput(input: {
    readonly deps: ScanContext;
    readonly binding: BindingRecord;
    readonly account: Awaited<ReturnType<typeof readAccount>>;
    readonly listed: Extract<ScanListing, { readonly ok: true }>;
}): Parameters<typeof enqueueEvents>[0] {
    const { deps, binding, account, listed } = input;
    const { observedHeads, checksWrites, checksDrops } = listed;

    return {
        store: deps.store,
        log: deps.log,
        incoming: listed.events,
        // The same records that produced `projectId`/`worktreeOption` for
        // these events resolve this snapshot — this cycle's configuration
        // (global tier), the account this scan read (account tier), and the
        // binding being scanned (binding tier) — so resolution and project
        // resolution cannot disagree (004 FR-015: "at the same moment";
        // FR-080: resolved once, at detection). A tier the records do not
        // carry is unset and contributes nothing.
        prompt: resolvePromptSnapshot({ global: deps.config, account, binding }),
        // The heads this cycle observed, mapped from the pull-request numbers the
        // pulls feed reported onto the run document's own subject keys, so a run
        // with no seed records its baseline inside the same two writes its
        // follow-up row lands in (FR-103(b)) — never a second write path.
        ...(observedHeads !== undefined && {
            observedHeads: observedHeadSeeds({ binding, observations: observedHeads }),
        }),
        ...(checksWrites !== undefined && { checksWrites }),
        ...(checksDrops !== undefined && { checksDrops }),
    };
}

/**
 * Scan one binding: list the feeds its triggers ask for, collect every
 * match, enqueue.
 *
 * The first list failure ends the scan with that failure's skip reason —
 * one cycle reports one honest reason per binding.
 */
async function scanBinding(input: {
    readonly deps: ScanContext;
    readonly binding: BindingRecord;
    /** This binding's slot, as it stood after the cycle derived any baseline. */
    readonly scanned: BindingScanState;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): Promise<BindingScan> {
    const { deps, scanned, detectedAt, binding } = input;
    const blank = blankScan(binding);
    const { store, log } = deps;
    const account = await readAccount({ store, numericUserId: binding.accountNumericUserId, log });
    if (account === null || account.credential.token === '') {
        return { ...blank, skipped: 'missing-account' };
    }

    if (account.state !== 'active') {
        return { ...blank, skipped: 'inactive-account' };
    }

    // The **verdict**, not a stamp: a scan that cannot compute a lower bound
    // records the refusal and lists nothing, which is the only state in which a
    // binding opens no window (002 FR-072). Nothing on this path reads the
    // history scope — it was consumed once, by `ensureBaselines`, and a branch
    // below needs only a window start (002 FR-068).
    const verdict = windowFor({ binding, scanned, overlapMs: deps.config.overlapMs });
    if ('refused' in verdict) {
        return { ...blank, skipped: verdict.refused };
    }

    // The tracked-subject view is read from the run document this cycle is about
    // to mutate, before any feed is listed: a follow-up is a property of the run
    // that already carries a session (FR-100), so *already in progress* is the
    // document as it stands at the start of the cycle — and the read is a preview
    // that takes no write chain and claims nothing (research §R14.6). An
    // unreadable document is a stop condition, never an empty history
    // (constitution II), so the refusal becomes this binding's skip reason.
    const document = await previewTrackedDocument({ store, log });
    if ('refused' in document) {
        return { ...blank, skipped: document.refused };
    }

    const tracked = trackedSubjectsOf({ document: document.value, binding });

    const listed = await collectScanEvents({
        deps,
        binding,
        // The window this cycle opens is widened by the overlap the cycle's own
        // configuration declared (006 FR-059(a)), or by the binding's history
        // scope on its first scan (002 FR-066, FR-067).
        windowStart: verdict.window,
        detectedAt,
        token: account.credential.token,
        login: account.login === '' ? binding.accountLogin : account.login,
        tracked,
    });
    if (!listed.ok) {
        return { ...blank, skipped: listed.skipped };
    }

    const appended = await enqueueEvents(enqueueScanInput({ deps, binding, account, listed }));

    await recordChecksAudits({ store, log, audits: listed.checksAudits ?? [] });

    // The end of tracking is recorded for every tracked subject whose own
    // terminal read reported a terminal state (FR-106). One-directional by
    // construction: the row goes to the trail and nothing is withdrawn from the
    // queue, so a follow-up already queued when the end was observed still
    // delivers.
    await recordTrackingEnds({ store, log, binding, ends: listed.ends ?? [] });

    // The window this scan opened is carried out, because it is the only thing
    // that can widen the retained baseline — and widening it is what keeps a later
    // recovery replay from being narrower than the work it must re-cover
    // (002 FR-073).
    return { ...blank, enqueued: appended.length, windowFrom: detectedAt, openedFrom: verdict.window };
}

/**
 * Persist per-binding scan state: the stamp on completion, the skip reason
 * otherwise, and — in one atomic write per scan (002 FR-018) — the three
 * facts that must agree. A completed scan advances `lastScanAt` and clears
 * `forceReplay`; `rescanFrom` clears only when the window covered the armed
 * bound, so a narrower recovery replay keeps the request alive (002 FR-076,
 * FR-084; plan H7); an incomplete scan retains its stamp and leaves both
 * one-shots armed (006 FR-058). `baselineAt` widens, never narrows
 * (002 FR-073, FR-066).
 */
async function saveBindingScanState(deps: ScanContext, scan: BindingScan): Promise<void> {
    await serializeScan(async () => {
        const state = await readScanState(deps);
        const prior = bindingScanOf(state, scan.bindingId);
        const didComplete = scan.windowFrom !== null;
        // 006 FR-058: a scan that did not complete **retains** the checkpoint it
        // already had. The next successful scan re-covers the failed period
        // through `lastScanAt − overlapMs`, or through the baseline when there
        // is no stamp yet.
        const retained = scan.windowFrom ?? prior.lastScanAt;
        await writeScanState({
            store: deps.store,
            state: withBindingScanState({
                state,
                bindingId: scan.bindingId,
                slot: {
                    lastScanAt: retained,
                    lastError: scan.skipped,
                    // Only a scan that actually listed may widen the bound, and only
                    // ever earlier: an incomplete scan opened no window, so it has
                    // nothing to contribute and must not move a bound another scan
                    // set (002 FR-076).
                    baselineAt: didComplete
                        ? widenBaseline({ retained: prior.baselineAt, opened: scan.openedFrom })
                        : prior.baselineAt,
                    // Only the scan that answered a one-shot clears it; a scan that
                    // did not complete leaves it armed (002 FR-076; plan H7).
                    forceReplay: !didComplete && prior.forceReplay,
                    // **Coverage, not completion.** A scan that completed at a window
                    // covering the armed bound served the request; one that opened
                    // later — a recovery replay at a narrower baseline than
                    // `now − 7 days` on a young binding — did not, so the arming
                    // survives for the next scan. Clearing on completion alone
                    // discarded the operator's explicit look-back with nothing
                    // recording that it had been asked for (002 FR-076, FR-084).
                    rescanFrom: answersCatchUp({ opened: scan.openedFrom, armed: prior.rescanFrom })
                        ? null
                        : prior.rescanFrom,
                },
            }),
        });
    });
}

/**
 * Derive and retain the baseline for every binding that needs one (002
 * FR-066): once per cycle, once per binding, and only when needed, so a
 * steady-state cycle pays nothing here. The derivation reads each row's
 * **stored** creation stamp, because an unreadable one must refuse rather
 * than silently become `now − overlapMs` (FR-072, plan H3, AC-038). Read and
 * write happen inside one `serializeScan` task so a `PUT /v1/bindings` or a
 * recovery reset landing in between cannot be reverted by a stale map
 * (FR-018, FR-076; plan H7), and the write lands before any scan reads a
 * window.
 */
async function ensureBaselines(
    deps: ScanContext,
    bindings: readonly BindingRecord[],
): Promise<ScanState> {
    const byId = new Map(bindings.map((binding) => [binding.bindingId, binding]));

    return await serializeScan(async (): Promise<ScanState> => {
        const state = await readScanState(deps);
        // Recomputed against the state read **here**, not against a snapshot the
        // caller took before entering the chain: a binding whose baseline another
        // writer derived while this task waited must not have it overwritten.
        const needing = bindingsNeedingBaseline({ bindings, slots: state.bindings });
        if (needing.length === 0) {
            return state;
        }

        const stamps = await readStoredCreationStamps({
            store: deps.store,
            log: deps.log,
            bindingIds: needing,
        });
        let derived: ScanState | null = null;
        for (const bindingId of needing) {
            const binding = byId.get(bindingId);
            const stored = stamps.get(bindingId);
            if (binding === undefined || stored === undefined) {
                continue;
            }

            // The one place the history scope is read: it decides *which* lower bound
            // a no-completed-scan window opens at, and is not consulted again (FR-068).
            const verdict = baselineFor({ binding, stored, overlapMs: deps.config.overlapMs });
            if ('refused' in verdict) {
                // No baseline is written, so `windowFor` refuses on every cycle until
                // the record is repaired — and records the reason each time (FR-072).
                continue;
            }

            const prior = bindingScanOf(derived ?? state, bindingId);
            derived = withBindingScanState({
                state: derived ?? state,
                bindingId,
                slot: { ...prior, baselineAt: verdict.window },
            });
        }

        if (derived === null) {
            return state;
        }

        await writeScanState({ store: deps.store, state: derived });

        return derived;
    });
}

/**
 * Read this cycle's configuration and narrow the dependencies around it.
 *
 * One read, once per cycle: the window, the page
 * size, and the retry ladder all take their values from this one document and
 * keep them for the whole cycle, so a single save changes all of them at the
 * same boundary and no consumer sees a half-updated configuration.
 */
async function cycleContext(input: {
    /** Open store; the null check lives at the cycle's own entry. */
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly poller: GitHubIssuePoller;
}): Promise<ScanContext> {
    const config = await readCycleConfig({ store: input.store, log: input.log });
    const pace: ListPace = {
        perPage: config.perPage,
        retry: {
            maxAttempts: config.retryMaxAttempts,
            baseMs: config.retryBaseMs,
            maxMs: config.retryMaxMs,
        },
    };

    return { store: input.store, log: input.log, poller: input.poller, config, pace };
}

/**
 * Run one poll cycle over every eligible binding.
 *
 * Never throws: every failure it can see is one binding's `skipped` reason,
 * logged once at the end with counts only. The cycle keeps walking the
 * remaining bindings so one broken account cannot block another.
 */
export async function runScanCycle(deps: ScanDeps): Promise<ScanResult> {
    if (deps.store === null) {
        return { bindings: [], enqueued: 0 };
    }

    const context = await cycleContext({ store: deps.store, log: deps.log, poller: deps.poller });
    // 006 FR-055(b)/FR-057: both retention passes run at the cycle boundary,
    // on the configuration this cycle already read — the boundary adds no
    // second read, and a save takes effect here rather than at the write.
    //  Nothing below may throw because a pass failed: each one is
    // guarded inside `runRetentionPasses`.
    await runRetentionPasses({ store: context.store, log: context.log, config: context.config });
    // Health pass before this cycle reads its windows: a quarantined queue
    // file clears every binding's `lastScanAt` **and sets `forceReplay`**
    // inside that read, so the scan-state read below sees the cleared slots
    // rather than cached stamps. A cleared binding then opens from its
    // **retained baseline** and re-offers in-window work whatever its history
    // scope or catch-up (002 FR-073; plan H8); the flag's job beyond
    // precedence is visibility (FR-074, FR-078), and deterministic event ids
    // keep the re-detection duplicate-free (002 FR-075, FR-082).
    await readEvents({ store: context.store, log: context.log });
    const bindings = await readBindings({ store: context.store, log: context.log });
    // Any baseline a binding still lacks is derived **once**, before the first
    // scan reads a window, and retained (002 FR-066). A binding whose stored
    // creation stamp cannot be read derives nothing, so its own window verdict
    // refuses for as long as the record says so (002 FR-072). The read-modify-write
    // is one task on the scan-state chain, so it reads fresh state rather than a
    // snapshot this cycle took before it queued (plan H7).
    const scannedState = await ensureBaselines(context, bindings);
    const detectedAt = new Date().toISOString();

    const outcomes: BindingScan[] = [];
    let total = 0;
    for (const binding of bindings) {
        if (binding.state !== 'active' || !watchesAnything(binding)) {
            continue;
        }

        const scan = await scanBinding({
            deps: context,
            binding,
            scanned: bindingScanOf(scannedState, binding.bindingId),
            detectedAt,
        });
        await saveBindingScanState(context, scan);
        if (scan.windowFrom !== null) {
            total += scan.enqueued;
        }

        outcomes.push(scan);
    }

    // One engine-delivery pass per cycle, after the enqueue phase — it never
    // throws, so a broken engine path stops no binding and no cycle.
    await runEngineDeliveryPass({
        store: context.store,
        log: context.log,
        env: deps.env ?? {},
        retry: {
            maxAttempts: context.config.retryMaxAttempts,
            baseMs: context.config.retryBaseMs,
            maxMs: context.config.retryMaxMs,
        },
    });

    if (outcomes.length > 0) {
        context.log.info('poll cycle complete', {
            bindings: outcomes.length,
            enqueued: total,
            skipped: outcomes.filter((scan) => scan.skipped !== null).length,
        });
    }

    return { bindings: outcomes, enqueued: total };
}
