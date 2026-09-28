/**
 * The service's minimal poll loop (MVP task M1 — re-cut 2026-09-27).
 *
 * Once per configured interval (existing `ServiceConfig.intervalMs`, default
 * 60 s) the loop walks every *enabled* binding carrying the assignment
 * trigger. Each scan presents the bound account's credential, lists its
 * repository's open issues newest-updated first (capped per the cut: two
 * pages at ≤ 30 items each), and turns every new assignment into one queued
 * event — one open issue assigned to one bound account can only ever produce
 * one event, because the event id is deterministic.
 *
 * The first scan of a binding *replays*: with no recorded `lastScanAt` the
 * loop sends no `since` filter, so every open issue matching the trigger is
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

import { repositoryLabel } from '../../src/config.ts';
import type { RepositoryRef } from '../../src/config.ts';
import { newCorrelationId } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import { readAccount } from '../accounts/store.ts';
import { readBindings } from '../bindings.ts';
import type { BindingRecord } from '../bindings.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { createEvent, enqueueEvents, readEvents } from './events.ts';
import type { QueuedEvent } from './events.ts';
import type { GitHubIssuePoller, IssueListOutcome, PollIssue } from './poller-github.ts';
import { readScanState, serializeScan, withBindingScanState, writeScanState } from './scan.ts';
import type { ScanState } from './scan.ts';

/** Items requested per page; each page stays well inside the response cap. */
const PAGE_SIZE = 30;

/** Pages read per binding scan; a full page justifies one more. */
const MAX_SCAN_PAGES = 2;

/** Longest issue-body excerpt one event carries (bounded untrusted text). */
const ISSUE_BODY_EXCERPT_MAX_CHARS = 600;

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
}

/** Handle to the running poll loop. */
export interface PollLoop {
    /** Cancel the pending cycle; an in-flight cycle finishes on its own. */
    stop(): void;
}

/** Return the caught value's error name alone; never one word of the cause (SEC-11). */
export function describeKind(cause: unknown): string {
    return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * Read the effective interval for the next cycle.
 *
 * @param store - Open store, or `null` when unusable.
 * @param log - Logger used when the config file cannot be read.
 * @returns Milliseconds until the next cycle.
 */
export async function currentIntervalMs(store: ServiceStore | null, log: ServiceLogger): Promise<number> {
    if (store === null) {
        return DEFAULT_CONFIG.intervalMs;
    }

    try {
        const config = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);

        return config.intervalMs;
    } catch (cause) {
        log.warn('poll interval read failed', { errorKind: describeKind(cause) });

        return DEFAULT_CONFIG.intervalMs;
    }
}

/**
 * The repository reference behind a binding's validated `owner/name` label.
 *
 * @param binding - Binding whose repository is scanned.
 * @returns The owner/name reference.
 */
function repositoryRefOf(binding: BindingRecord): RepositoryRef {
    const index = binding.repository.indexOf('/');
    if (index < 0) {
        return { owner: binding.repository, name: '' };
    }

    return { owner: binding.repository.slice(0, index), name: binding.repository.slice(index + 1) };
}

/**
 * The window the next scan opens from: the last completed scan's stamp when
 * there is one, else `null` — no `since` filter at all, a full replay.
 *
 * A binding that has never completed a scan (`lastScanAt: null` in its slot,
 * or no slot at all) replays every open issue on its next scan instead of
 * opening a baseline at `createdAt`: pre-binding assignments must work
 * (product decision, 2026-09-28), so an issue assigned before the binding
 * existed is still detected. A recovery reset writes the same `null`, so the
 * reset replays too — the same contract, and deterministic event ids keep
 * both replays duplicate-free.
 *
 * @param binding - Binding being scanned.
 * @param scanned - Scan state read at cycle start.
 * @returns The recorded stamp, or `null` for an unbounded (replay) window.
 */
export function windowFor(binding: BindingRecord, scanned: ScanState): string | null {
    const recorded = scanned.bindings[binding.bindingId];

    return recorded !== undefined && recorded.lastScanAt !== null ? recorded.lastScanAt : null;
}

/**
 * Decide whether one issue is an assignment the binding should react to.
 *
 * Pull requests are skipped (review requests belong to the M7 trigger),
 * closed issues are skipped, and the assignment must name the bound
 * account's login.
 *
 * @param issue - Normalized issue.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when the issue is an open issue assigned to that account.
 */
export function isIssueAssignment(issue: PollIssue, bindingLogin: string): boolean {
    if (issue.state !== 'open' || issue.isPullRequest) {
        return false;
    }

    return issue.assignees.some((login) => login.toLowerCase() === bindingLogin.toLowerCase());
}

/**
 * Decide whether an issue falls inside the scan window.
 *
 * With no window (`windowStart === null` — the first scan, and any replay
 * after a recovery reset) every listed issue is in-window: the replay's
 * contract is that everything open matching the trigger enqueues, whether or
 * not the issue can report its own freshness (product decision,
 * 2026-09-28). With a window, an issue that cannot report its own freshness
 * is never in-window: a feed entry without a date cannot honestly claim to
 * be new.
 *
 * @param updatedAt - GitHub `updated_at` stamp, or `null`.
 * @param windowStart - Window start stamp, or `null` for a replay scan.
 * @returns `true` when in-window — always, when there is no window.
 */
export function updatedInWindow(updatedAt: string | null, windowStart: string | null): boolean {
    if (windowStart === null) {
        return true;
    }

    if (updatedAt === null) {
        return false;
    }

    const stamp = Date.parse(updatedAt);
    const start = Date.parse(windowStart);

    return !Number.isNaN(stamp) && !Number.isNaN(start) && stamp >= start;
}

/**
 * Slice untrusted issue text to the excerpt one event can carry.
 *
 * @param body - Raw issue body, or `null` when GitHub sent none.
 * @returns The excerpt, or `''` when there was no body.
 */
function bodyExcerptOf(body: string | null): string {
    if (body === null) {
        return '';
    }

    if (body.length <= ISSUE_BODY_EXCERPT_MAX_CHARS) {
        return body;
    }

    return `${body.slice(0, ISSUE_BODY_EXCERPT_MAX_CHARS - 1)}…`;
}

/**
 * Translate one upstream failure into a skip reason.
 *
 * @param outcome - The upstream classification; never `ok`.
 * @returns The short machine reason logged for the binding.
 */
function skipOf(outcome: Exclude<IssueListOutcome, { readonly kind: 'ok' }>): ScanSkip {
    if (outcome.kind === 'auth-failed') {
        return 'auth-failed';
    }

    if (outcome.kind === 'rate-limited') {
        return 'rate-limited';
    }

    return outcome.detail === 'timeout' || outcome.detail === 'offline' ? 'offline' : 'upstream';
}

/**
 * Read every issue page one binding's scan covers.
 *
 * Page 2 is requested only when page 1 filled its cap, so the rate budget
 * never sees a burst. The first failed page stops the paging and reports.
 *
 * @param input - Poller call inputs.
 * @returns The normalized issues, or the page failure's skip reason.
 */
/** Outcome of listing every page one binding's scan covers. */
type IssuePageResult =
    | { readonly ok: true; readonly issues: readonly PollIssue[] }
    | { readonly ok: false; readonly skipped: ScanSkip };

/**
 * Read every issue page one binding's scan covers.
 *
 * Page 2 is requested only when page 1 filled its cap, so the rate budget
 * never sees a burst. The first failed page stops the paging and reports.
 *
 * @param input - Poller call inputs.
 * @returns The normalized issues, or the page failure's skip reason.
 */
async function listBindingIssues(input: {
    /** Poller the pages are requested through. */
    readonly poller: GitHubIssuePoller;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Repository coordinates. */
    readonly owner: string;
    readonly name: string;
    /** Scan window start; `null` opens an unbounded (replay) listing. */
    readonly since: string | null;
}): Promise<IssuePageResult> {
    const pageInputs = {
        token: input.token,
        owner: input.owner,
        name: input.name,
        since: input.since,
        perPage: PAGE_SIZE,
    };

    const issues: PollIssue[] = [];
    for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
        const outcome = await input.poller.listOpenIssues(pageInputs);
        if (outcome.kind !== 'ok') {
            return { ok: false, skipped: skipOf(outcome) };
        }

        issues.push(...outcome.issues);
        if (outcome.issues.length < PAGE_SIZE) {
            break;
        }
    }

    return { ok: true, issues };
}

/**
 * Record one detection in the audit trail.
 *
 * @param deps - Store and logger for the audit and its failures.
 * @param event - The event that was enqueued.
 */
async function recordDetection(deps: ScanContext, event: QueuedEvent): Promise<void> {
    try {
        await appendAudit(deps.store, {
            eventType: 'delivery.detected',
            actorSource: 'service',
            entity: { kind: 'delivery', id: event.id },
            decision: null,
            reason: `${event.kind} trigger matched a binding`,
            correlationId: newCorrelationId(),
            details: {
                bindingId: event.bindingId,
                repository: event.repository,
                kind: event.kind,
            },
        });
    } catch (cause) {
        // The queue file is the durable record; the audit row is an extra
        // guard whose failure is logged, not escalated to the cycle.
        deps.log.warn('detection audit row could not be appended', {
            eventId: event.id,
            errorKind: describeKind(cause),
        });
    }
}

/**
 * Collect the events one binding's scan should enqueue.
 *
 * @param input - Binding, its window, the issues on the page, and the stamp.
 * @returns The events, in page order.
 */
function eventsForBinding(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The window start the scan used; `null` on a replay scan. */
    readonly windowStart: string | null;
    /** The issues the pages yielded. */
    readonly issues: readonly PollIssue[];
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const repository = repositoryRefOf(input.binding);
    const { accountNumericUserId, accountLogin, projectId, worktreeOption } = input.binding;
    const label = repositoryLabel(repository);

    const events: QueuedEvent[] = [];
    for (const issue of input.issues) {
        const eligible = updatedInWindow(issue.updatedAt, input.windowStart)
            && isIssueAssignment(issue, input.binding.accountLogin);
        if (!eligible) {
            continue;
        }

        events.push(
            createEvent({
                bindingId: input.binding.bindingId,
                repository: label,
                accountNumericUserId,
                accountLogin,
                projectId,
                worktreeOption,
                kind: 'assignment',
                issue: {
                    issueNumber: issue.issueNumber,
                    issueTitle: issue.title,
                    issueUrl: issue.url,
                    issueBodyExcerpt: bodyExcerptOf(issue.body),
                },
                triggerNote: 'Issue assigned to the bound account',
                detectedAt: input.detectedAt,
            }),
        );
    }

    return events;
}

/**
 * Scan one binding: list pages, collect the assignment matches, enqueue.
 *
 * @param deps - Narrowed store/logger/poller for this cycle.
 * @param binding - The binding being scanned.
 * @param scanned - Scan state read at cycle start.
 * @param detectedAt - RFC 3339 stamp pinned at cycle start.
 * @returns The binding's outcome.
 */
/**
 * The outcome a binding's scan starts from, before anything is observed.
 *
 * @param binding - The binding the blank belongs to.
 * @returns The all-clear baseline.
 */
function blankScan(binding: BindingRecord): BindingScan {
    return {
        bindingId: binding.bindingId,
        repository: repositoryLabel(repositoryRefOf(binding)),
        enqueued: 0,
        windowFrom: null,
        skipped: null,
    };
}

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
    const repository = repositoryRefOf(binding);
    const blank = blankScan(binding);
    const account = await readAccount({ store: deps.store, numericUserId: binding.accountNumericUserId });
    if (account === null || account.credential.token === '') {
        return { ...blank, skipped: 'missing-account' };
    }

    if (account.state !== 'active') {
        return { ...blank, skipped: 'inactive-account' };
    }

    const pages = await listBindingIssues({
        poller: deps.poller,
        token: account.credential.token,
        owner: repository.owner,
        name: repository.name,
        since: windowFor(binding, scanned),
    });
    if (!pages.ok) {
        return { ...blank, skipped: pages.skipped };
    }

    const incoming = eventsForBinding({
        binding,
        windowStart: windowFor(binding, scanned),
        issues: pages.issues,
        detectedAt,
    });
    const appended = await enqueueEvents({
        store: deps.store,
        log: deps.log,
        incoming,
    });
    for (const event of appended) {
        await recordDetection({ ...deps }, event);
    }

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
        await writeScanState({
            store: deps.store,
            state: withBindingScanState({
                state,
                bindingId: scan.bindingId,
                slot: {
                    lastScanAt: scan.windowFrom,
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
export async function runScanCycle(deps: ScanDeps): Promise<ScanResult> {
    if (deps.store === null) {
        return { bindings: [], enqueued: 0 };
    }

    const context: ScanContext = { store: deps.store, log: deps.log, poller: deps.poller };
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
        if (binding.state !== 'active' || binding.triggers.assignment !== true) {
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
