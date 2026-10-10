/**
 * The service's minimal poll loop (MVP task M1 — re-cut 2026-09-27, grown
 * for the Slice-2 triggers M6 mention and M7 review request).
 *
 * Once per configured interval (existing `ServiceConfig.intervalMs`, default
 * 60 s) the loop walks every *enabled* binding carrying at least one trigger
 * this loop implements. Each scan presents the bound account's credential and
 * turns the scan over to `triggers.ts`, which lists only the feeds those
 * switches ask for — open issues newest-updated first for the assignment, for
 * the mention scan's issue-body pass, and for the titles comment mentions
 * resolve against; issue comments for M6; open pull requests for M7 — each
 * capped per the cut (two pages at ≤ 30 items each, inside
 * `poller-github.ts`). Every match becomes one queued event: one observation
 * (an assignment, a comment or issue-body mention, a review request) can only
 * ever produce one event, because the event id is deterministic.
 *
 * Two of those observations are now attributed from a **second** read, one per
 * matched candidate: the item's own `…/issues/{number}/events` list, which is
 * where GitHub records who assigned an issue and who requested a review (002
 * FR-049). What this loop contributes to that is the rule that a **failure**
 * there behaves like a list failure — one honest skip reason per binding, and a
 * checkpoint that is retained rather than advanced (006 FR-058) — so a read that
 * could not name the actor cannot slide the window past the assignment it could
 * not attribute. A candidate that simply produced no event is a different
 * outcome, recorded by the read itself and never a skip.
 *
 * **Every scan opens at a computable lower bound** (002 FR-065, added at
 * v1.13.0). What a binding's *first* window starts at is what its **history
 * scope** fixes: the binding's own creation boundary widened by the configured
 * overlap under the documented default, or one fixed seven-day look-back before
 * that boundary when the operator asked for it (FR-066, FR-067). Every scan
 * after the first is incremental from the recorded `lastScanAt` widened by the
 * same overlap, in **both** modes — the mode is not consulted again at all
 * (FR-068). A queue-recovery reset re-offers the binding's in-window work
 * whatever its mode is (FR-073), deduplicating through the unchanged
 * deterministic event id (FR-075, FR-082). The pre-v1.13.0 rule — a binding
 * with no recorded stamp replays *everything* — is retired as a window source,
 * together with the "an unreadable stamp is the same as no window" fallback;
 * neither is reachable any more (FR-065).
 *
 * A scan window that cannot be computed at all **refuses** rather than falling
 * open: no listing, no event, and the reason recorded against that binding
 * (FR-072, FR-024). Queued events reach the panel through the relay (M2); the
 * panel dispatches (M4). MVP-DEBT: the production plan's checkpoint machinery
 * (overlap windows, run keys, lease renewal) is deliberately not here — this is
 * the simple stand-in the MVP cut asked for.
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
import { enqueueEvents, readEvents } from './events.ts';
import type { QueuedEvent } from './events.ts';
import { followUpSubjects, withoutEndedFollowUps } from './follow-up.ts';
import type { GitHubIssuePoller, ListPace, PollFailure, PollIssue, PollPull } from './poller-github.ts';
import { previewRunsDocument } from './runs-document.ts';
import { bindingScanOf, readScanState, serializeScan, withBindingScanState, writeScanState } from './scan.ts';
import type { BindingScanState, ScanState } from './scan.ts';
import { collectTriggerEvents } from './triggers.ts';
import { observedHeadSeeds, trackedIssueEnds, trackedPullEnds, trackedSubjectsOf } from './tracking.ts';
import type { TrackedSubject, TrackingEnd } from './tracking.ts';
import type { RunsDocument } from './runs-types.ts';
import { answersCatchUp, baselineFor, bindingsNeedingBaseline, widenBaseline, windowFor } from './window.ts';
import type { WindowRefusal } from './window.ts';

// The window rule lives beside its own rationale in `window.ts`; the loop
// re-exports it so `windowFor` keeps one import path for the cycle and for
// the suites that drive it.
export { baselineFor, windowFor };
export type { WindowRefusal, WindowVerdict } from './window.ts';

/**
 * Short machine reasons a scan was skipped, logged instead of upstream text.
 *
 * The six upstream ones are classifications of a `PollFailure`. The three window
 * ones are 002 FR-072's refusals and are **not** failures of any call: they are
 * the verdict that this binding's scan window could not be computed, so the
 * cycle lists nothing and the reason is recorded against the binding (FR-024).
 * The seventh is the run document's own refusal, which the tracking lifecycle's
 * read made reachable from a scan: a document this build cannot read is a stop
 * condition, never an empty history (constitution II).
 * They are named in the same vocabulary because they answer the same question an
 * operator asks — *why did this scan do nothing* — and two vocabularies would be
 * two answers (constitution IV).
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

/** What one binding's scan produced. */
export interface BindingScan {
    /** Binding scanned. */
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
    /** Skip reason for the whole scan, else `null`. */
    readonly skipped: ScanSkip | null;
}

/** Result of one poll cycle across every eligible binding. */
export interface ScanResult {
    /** Per-binding outcomes, in binding-file order. */
    readonly bindings: readonly BindingScan[];
    /** Total new events enqueued this cycle. */
    readonly enqueued: number;
}

/** Dependencies one scan cycle needs; fixed once at server start. */
export interface ScanDeps {
    /** Open store, or `null` when the data directory is unusable. */
    readonly store: ServiceStore | null;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** GitHub poller used for every issue list. */
    readonly poller: GitHubIssuePoller;
}

/** The narrowed dependencies, built after the null-store check. */
interface ScanContext {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** GitHub poller. */
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
    /** Whether `stop()` has been called on this loop. */
    readonly stopped: boolean;
    /** Epoch milliseconds of the next armed cycle, or `null` when none is armed. */
    readonly nextPollAtMs: number | null;
}

/** Handle to the running poll loop. */
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
 *
 * @returns `true` when at least one trigger is on.
 */
function watchesAnything(binding: BindingRecord): boolean {
    const { assignment, mention, reviewRequest } = binding.triggers;

    return assignment || mention || reviewRequest;
}

/**
 * Translate one upstream failure into a skip reason.
 *
 * One mapping for **every** upstream call the scan makes, the per-item events
 * read included: `skipOf` is what turns a `PollFailure` into the one honest
 * reason a binding's scan reports, and a second mapping for the actor read
 * would be a second answer to "why did this scan stop" (constitution IV).
 *
 * @param outcome - The upstream classification; never `ok`.
 * @returns The short machine reason logged for the binding.
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

/**
 * The outcome a binding's scan starts from, before anything is observed.
 *
 * @returns The all-clear baseline.
 */
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
 * Record the end of tracking for every tracked subject observed terminal.
 *
 * One `tracking.ended` row per subject, carrying the terminal **fact** (which
 * of the three it was), the date GitHub reported, and the issue's own
 * `state_reason` when there is one — so *"when did this work item conclude?"*
 * is answerable from the trail (002 FR-106). The row names the run the subject
 * was following and never the session: it is the item's own state that ended
 * tracking, and a completed or failed session has no effect on that decision.
 *
 * The write is best-effort on exactly the terms the enqueue's own audit rows
 * are: the cycle has already done its work, so a failed append is logged rather
 * than thrown back into a scan that succeeded.
 */
async function recordTrackingEnds(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Binding the ended subjects belong to. */
    readonly binding: BindingRecord;
    /** The ends this cycle observed. */
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
 * Read the run document for the tracked-subject view, answering a refusal
 * rather than throwing one.
 *
 * The scan cycle's own contract is that it never throws, and the run layer's
 * reader is fail-closed by throwing: a `runs.json` that exists but cannot be
 * read, or one that is absent while the queue already carries post-run-layer
 * deliveries, is a state no reader may answer with an empty history. This is the
 * one place a scan has to turn that refusal into a **skip reason**, so the
 * binding records why it did nothing instead of the cycle unwinding.
 *
 * @returns The document, or the refusal that keeps this binding's scan empty.
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

/** What one binding's listings produced: every event, or the skip reason. */
type ScanListing =
    | {
        readonly ok: true;
        readonly events: readonly QueuedEvent[];
        /** Observed heads keyed by pull-request number (FR-103(b)'s seed source). */
        readonly observedHeads?: ReadonlyMap<number, string>;
        /** Tracked subjects whose own list row reported a terminal state (FR-106). */
        readonly ends?: readonly TrackingEnd[];
    }
    | { readonly ok: false; readonly skipped: ScanSkip };

/**
 * Observe the terminal state of every subject that produced a follow-up this
 * cycle, and drop the follow-ups whose subject ended (002 FR-106).
 *
 * FR-102 admits exactly one read — FR-106's — and bounds it: issued only for a
 * subject that produced at least one detected follow-up in this cycle, at most
 * **once per subject per cycle**, and **before** the enqueue so a terminal
 * answer drops the follow-up from this cycle rather than retracting a queued
 * row. A cycle in which nothing arrived therefore issues **no** read at all, so
 * the added cost scales with detections rather than with tracked subjects
 * (NFR-003). Both feeds the scan reads are filtered `state=open`, so a concluded
 * item leaves them rather than arriving on one — this per-item read is the only
 * source that can observe the end, and it routes each answer through the same
 * {@link trackedIssueEnds} / {@link trackedPullEnds} builders a terminal list row
 * (never produced in production) would reach.
 *
 * **The failure posture is the scan's own, copied from the per-item actor read**
 * (`resolveCandidateActor`), not a per-subject skip: a read that could not answer
 * — a transport failure (a `404` arrives as the shared `auth-failed` class,
 * `poller-transport.ts:210`), or a body/`state` the reader refuses — refuses the
 * **whole binding's** detection for this cycle and stops the scan with its class,
 * the checkpoint **retained** rather than advanced so the next cycle's detected
 * follow-up asks again. It never ends tracking on a guess: an unreadable answer
 * is neither a terminal state nor an open one, and a `404` that is really a
 * revoked credential must not be read as a deletion. Dropping only the candidate
 * would advance the window past work nobody judged.
 *
 * @returns The events without the ended subjects' follow-ups and the ends to
 *   record, or the skip that ends this binding's scan.
 */
async function terminalFollowUpState(input: {
    /** Narrowed store/logger/poller/pace. */
    readonly deps: ScanContext;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Subjects this binding and account is following. */
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
    /** Every event this scan detected, follow-ups included. */
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
 *
 * The work itself belongs to `triggers.ts`, which owns each branch's detection
 * and its per-item actor read; what this function contributes is the cycle's own
 * rule — **the first failure of any call ends the listing and becomes the loop's
 * one skip reason for the binding**, FR-106's terminal read included. A binding
 * with none of its switches on lists nothing at all, so the rate budget only ever
 * pays for triggers the operator turned on.
 *
 * @returns Every event this scan matched (ended subjects' follow-ups dropped),
 *   the heads observed, the ends to record, or the skip reason.
 */
async function collectScanEvents(input: {
    /** Narrowed store/logger/poller. */
    readonly deps: ScanContext;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** The window this cycle opened; every scan has a computable lower bound (002 FR-065). */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Subjects this binding and account is following. */
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

    const ends = [...(collected.ends ?? []), ...terminal.ends];

    return {
        ok: true,
        events: terminal.events,
        ...(collected.observedHeads !== undefined && { observedHeads: collected.observedHeads }),
        ...(ends.length > 0 && { ends }),
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
    /** Narrowed store/logger/poller. */
    readonly deps: ScanContext;
    /** The binding being scanned. */
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
    // to mutate, **before** any feed is listed: a follow-up is a property of the
    // run that already carries a session (FR-100), so what counts as "already
    // in progress" is the document as it stands at the start of the cycle. The
    // read is a preview — it takes no write chain and claims nothing, which is
    // exactly the instrument for an observation that must not consume a
    // dispatch authorization (research §R14.6).
    //
    // A document this build cannot read is a **stop condition**, not an empty
    // history: answering "nothing is in progress" from a store that cannot say
    // so is the one reading constitution II forbids, and it is what would let a
    // second disjoint session open for work already underway. So the refusal
    // becomes this binding's skip reason and the cycle lists nothing at all.
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

    const appended = await enqueueEvents({
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
        ...(listed.observedHeads !== undefined && {
            observedHeads: observedHeadSeeds({ binding, observations: listed.observedHeads }),
        }),
    });

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
 * otherwise — and, on completion, the clearing of the two one-shot facts.
 *
 * **One atomic write per scan** (002 FR-018), which is what makes the three
 * facts agree with each other rather than merely being stored near one another:
 *
 * - a scan that **completes** advances `lastScanAt` and clears `forceReplay`,
 *   because the lost work has been re-detected (002 FR-075);
 * - `rescanFrom` is cleared **only by a scan whose window covered the armed
 *   bound** (`answersCatchUp`), which is a stricter test than completion: a
 *   recovery replay outranks the arming, so a replay at a *narrower* baseline than
 *   `now − 7 days` completes without having reached the ground the operator asked
 *   for, and the request must survive to be the next scan's window (002 FR-076,
 *   FR-084; plan H7);
 * - a scan that **does not complete** leaves `lastScanAt` where it was (006
 *   FR-058: an incomplete scan neither advances past data that was never
 *   durably represented nor clears to a replay) **and leaves both one-shots
 *   armed** — a transient failure must not silently consume a recovery replay
 *   (002 FR-076) or an operator's explicit catch-up request (plan H7).
 *
 * `baselineAt` is **widened, never narrowed** (002 FR-073, FR-066). It is derived
 * once, before the binding's first scan, from the creation boundary — which is
 * what FR-066's stability rests on — and every scan that opened a window wider
 * than the one already retained moves it **earlier** and never later. That is
 * what makes a recovery replay re-cover *at least* everything some earlier scan
 * covered: an armed `rescanFrom` bound (`now − 7 days` on a binding younger than
 * that) is narrower than the binding's own creation boundary on a fresh default,
 * and a replay opening at the un-widened baseline would silently drop the older
 * rows the catch-up had already queued.
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
 * Derive and retain the baseline for every binding that needs one (002 FR-066).
 *
 * **Once per cycle, once per binding, and only when needed.** A binding whose
 * slot already carries a `baselineAt` — or a completed scan — is not touched, so
 * a steady-state cycle pays nothing here and no `bindings.json` read happens at
 * all (plan H3: the extra `readJson` exists *only* in a cycle where some binding
 * has no baseline yet, which is the first cycle and the one after a recovery
 * reset).
 *
 * The derivation reads each row's **stored** creation stamp, because the
 * assembled record substitutes a clock reading for a stamp the clock cannot read
 * and FR-072 requires that case to **refuse** rather than silently become
 * `now − overlapMs` (plan H3, AC-038). A refusal writes no baseline, so the
 * binding keeps refusing on every cycle until an operator repairs the stamp — the
 * honest direction, and never a widening.
 *
 * The read and the write happen **inside one `serializeScan` task**, which is why
 * this is not a bare read-then-write: the slots are re-read inside the chain and
 * `needing` is recomputed against that fresh read, so a `PUT /v1/bindings` that
 * arms `rescanFrom` — or a recovery reset that sets `forceReplay` — landing
 * between this cycle's scan-state read and its write cannot be reverted by a stale
 * map written back over it (002 FR-018, FR-076; plan H7).
 *
 * The write is one atomic scan-state write for every binding that derived
 * something, and it happens **before** any scan so the scan's own window reads a
 * slot that already carries its baseline (FR-018).
 *
 * @returns The scan state to scan under, with any newly derived baselines in it.
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
 *
 * @returns The context every binding in this cycle is scanned under.
 */
async function cycleContext(input: {
    /** Open store; the null check lives at the cycle's own entry. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** GitHub poller. */
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
 *
 * @returns The cycle outcome.
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
    // Health pass before this cycle reads its windows: a queue file that has
    // to be quarantined clears every binding's `lastScanAt` **and sets its
    // `forceReplay` flag** inside that read, so the scan-state read below must
    // see the cleared slots rather than the stamps a pre-recovery read would
    // have cached. A cleared binding then opens from its **retained baseline** —
    // the widest window it has ever scanned from, widened by every scan that
    // opened one — so a recovery re-offers the binding's in-window work **whatever
    // its history scope is and whatever catch-up was armed** (002 FR-073; plan H8,
    // corrected 2026-10-05). What the flag adds beyond precedence is visibility,
    // and the guarantee that no reader mistakes this for a first scan (FR-074,
    // FR-078). Deterministic event ids keep the re-detection duplicate-free
    // (002 FR-075, FR-082).
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

    if (outcomes.length > 0) {
        context.log.info('poll cycle complete', {
            bindings: outcomes.length,
            enqueued: total,
            skipped: outcomes.filter((scan) => scan.skipped !== null).length,
        });
    }

    return { bindings: outcomes, enqueued: total };
}
