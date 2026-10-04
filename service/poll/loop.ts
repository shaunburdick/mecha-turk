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
 * The first scan of a binding *replays*: with no recorded `lastScanAt` the
 * loop sends no `since` filter, so every open item matching a trigger is
 * enqueued — an operator who binds a repository and immediately wants work
 * on already-assigned issues gets it even when the issue (or the assignment)
 * predates the binding (product decision, 2026-09-28). Every scan after the
 * first is incremental from the recorded `lastScanAt`, and dedupe by the
 * deterministic event id keeps the replay idempotent. Queued events reach
 * the panel through the relay (M2); the panel dispatches (M4). MVP-DEBT:
 * the production plan's checkpoint machinery (overlap windows, run keys,
 * lease renewal) is deliberately not here — this is the simple stand-in the
 * MVP cut asked for.
 */

import { readAccount } from '../accounts/store.ts';
import { readBindings } from '../bindings-read.ts';
import { resolvePromptSnapshot } from '../prompt.ts';
import { runRetentionPasses } from '../retention.ts';
import type { ServiceConfig } from '../config.ts';
import type { BindingRecord } from '../bindings.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { readCycleConfig } from './cycle-config.ts';
import { enqueueEvents, readEvents } from './events.ts';
import type { QueuedEvent } from './events.ts';
import type { GitHubIssuePoller, ListPace, PollFailure } from './poller-github.ts';
import { readScanState, serializeScan, withBindingScanState, writeScanState } from './scan.ts';
import type { ScanState } from './scan.ts';
import { collectTriggerEvents } from './triggers.ts';
import { windowFor } from './window.ts';

// The window rule lives beside its own rationale in `window.ts`; the loop
// re-exports it so `windowFor` keeps one import path for the cycle and for
// the suites that drive it.
export { windowFor };

/** Short machine reasons a scan was skipped, logged instead of upstream text. */
export type ScanSkip = 'missing-account' | 'inactive-account' | 'auth-failed' | 'rate-limited' | 'offline' | 'upstream';

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
     * keeping a second copy of the schedule it could drift from (005 FR-031).
     */
    state(): PollLoopState;
}

/**
 * Decide whether a binding watches anything this loop implements.
 *
 * A binding whose switches are all off is walked but never scanned, so the
 * scan state stays honest (and no rate budget is spent on a silent binding).
 *
 * @param binding - Binding the cycle is about to walk.
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
 * @param binding - The binding the blank belongs to.
 * @returns The all-clear baseline.
 */
function blankScan(binding: BindingRecord): BindingScan {
    return {
        bindingId: binding.bindingId,
        repository: binding.repository,
        enqueued: 0,
        windowFrom: null,
        skipped: null,
    };
}

/** What one binding's listings produced: every event, or the skip reason. */
type ScanListing =
    | { readonly ok: true; readonly events: readonly QueuedEvent[] }
    | { readonly ok: false; readonly skipped: ScanSkip };

/**
 * List every feed this binding's triggers ask for and collect its events.
 *
 * The work itself belongs to `triggers.ts`, which owns each branch's detection
 * and its per-item actor read; what this function contributes is the cycle's own
 * rule — **the first failure of any call ends the listing and becomes the loop's
 * one skip reason for the binding**. A binding with none of its switches on lists
 * nothing at all, so the rate budget only ever pays for triggers the operator
 * turned on.
 *
 * @param input - Poller, credential, logger, binding, window, and the cycle stamp.
 * @returns Every event this scan matched, or the skip reason.
 */
async function collectScanEvents(input: {
    /** Narrowed store/logger/poller. */
    readonly deps: ScanContext;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Window start; `null` opens an unbounded (replay) listing. */
    readonly windowStart: string | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
}): Promise<ScanListing> {
    const { deps, binding, windowStart, detectedAt, token, login } = input;
    const collected = await collectTriggerEvents({
        poller: deps.poller,
        log: deps.log,
        token,
        binding,
        login,
        windowStart,
        detectedAt,
        pace: deps.pace,
    });

    return collected.ok ? { ok: true, events: collected.events } : { ok: false, skipped: skipOf(collected.failure) };
}

/**
 * Scan one binding: list the feeds its triggers ask for, collect every
 * match, enqueue.
 *
 * The first list failure ends the scan with that failure's skip reason —
 * one cycle reports one honest reason per binding.
 *
 * @param input - Binding, scan state, and the stamp pinned at cycle start.
 * @returns The binding's outcome.
 */
async function scanBinding(input: {
    /** Narrowed store/logger/poller. */
    readonly deps: ScanContext;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Scan state read at cycle start. */
    readonly scanned: ScanState;
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

    const listed = await collectScanEvents({
        deps,
        binding,
        // The window this cycle opens is widened by the overlap the cycle's
        // own configuration declared (006 FR-059(a)).
        windowStart: windowFor({ binding, scanned, overlapMs: deps.config.overlapMs }),
        detectedAt,
        token: account.credential.token,
        login: account.login === '' ? binding.accountLogin : account.login,
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
    });
    return { ...blank, enqueued: appended.length, windowFrom: detectedAt };
}

/**
 * Persist per-binding scan state: the stamp on completion, the skip reason
 * otherwise.
 *
 * @param deps - Narrowed store/logger for this cycle.
 * @param scan - The binding's outcome.
 */
async function saveBindingScanState(deps: ScanContext, scan: BindingScan): Promise<void> {
    await serializeScan(async () => {
        const state = await readScanState(deps);
        const prior = state.bindings[scan.bindingId];
        // FR-058 (006): a scan that did not complete **retains** the checkpoint
        // it already had — it neither advances past data that was never
        // durably represented nor clears to a full replay. The next successful
        // scan re-covers the failed period through `lastScanAt − overlapMs`.
        // The queue-recovery reset remains the one path that clears the stamp.
        const retained = scan.windowFrom ?? (prior?.lastScanAt ?? null);
        await writeScanState({
            store: deps.store,
            state: withBindingScanState({
                state,
                bindingId: scan.bindingId,
                slot: {
                    lastScanAt: retained,
                    lastError: scan.skipped,
                },
            }),
        });
    });
}

/**
 * Run one poll cycle over every eligible binding.
 *
 * Never throws: every failure it can see is one binding's `skipped` reason,
 * logged once at the end with counts only. The cycle keeps walking the
 * remaining bindings so one broken account cannot block another.
 *
 * @param deps - Store, logger, and poller.
 * @returns The cycle outcome.
 */
/**
 * Read this cycle's configuration and narrow the dependencies around it.
 *
 * One read, once per cycle (006 FR-055, FR-057–FR-059): the window, the page
 * size, and the retry ladder all take their values from this one document and
 * keep them for the whole cycle, so a single save changes all of them at the
 * same boundary and no consumer sees a half-updated configuration.
 *
 * @param input - Store, logger, and poller; the store is already known open.
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
    // to be quarantined clears every binding's `lastScanAt` inside that read,
    // so the scan-state read below must see the cleared slots rather than
    // the stamps a pre-recovery read would have cached. The cycle then opens
    // each window with no `since` filter at all — a full replay that
    // re-detects whatever the lost queue carried (deterministic ids keep
    // that replay duplicate-free).
    await readEvents({ store: context.store, log: context.log });
    const [bindings, scannedState] = await Promise.all([
        readBindings({ store: context.store, log: context.log }),
        readScanState({ store: context.store, log: context.log }),
    ]);
    const detectedAt = new Date().toISOString();

    const outcomes: BindingScan[] = [];
    let total = 0;
    for (const binding of bindings) {
        if (binding.state !== 'active' || !watchesAnything(binding)) {
            continue;
        }

        const scan = await scanBinding({ deps: context, binding, scanned: scannedState, detectedAt });
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
