/**
 * The tracked-subject view the follow-up detectors read, and the terminal
 * facts that end tracking (002 FR-100 – FR-106).
 *
 * Two questions live here because they are the two halves of one fact — *which
 * subjects is this scan following, and has any of them concluded?* — and a
 * detector that answered either on its own would be a second reading of the run
 * document and of GitHub's own state words.
 *
 * **What "tracked" means, and what it does not.** A subject is tracked when a
 * run under **this binding and this account** carries a recorded session —
 * FR-100's recorded-session predicate, read from the same stored
 * `run.session` the join and the claim route both read. Nothing here invents a
 * tracked set of its own: there is no second index, no persisted registry, and
 * no per-account cap (FR-107), so the view is a pure function of the run
 * document this cycle already reads.
 *
 * **How the end of tracking is observed, and what the shipped feeds can and
 * cannot see.** Both list feeds the scan reads are filtered `state=open`, so a
 * closed issue or a merged pull request **leaves the list** rather than
 * arriving on it in a terminal state. That is a real limit of the two existing
 * reads and it is stated rather than designed around (`research.md` §R12.2): a
 * list row is therefore never the source of an end in production. The one read
 * that can observe an end is the **lazy per-item terminal read** FR-102 admits
 * and FR-106 fixes (001 FR-106): `GET …/issues/{number}` and `GET …/pulls/{number}`,
 * issued only when a follow-up has been detected on the subject, routed here
 * through the same {@link trackedIssueEnds} / {@link trackedPullEnds} builders a
 * (never-in-production) terminal list row would take. This module owns the
 * reader-side capability and its audit row; the timing and the failure posture
 * of the read live in `loop.ts`.
 */

import type { BindingRecord } from '../bindings.ts';
import type { ActorAttribution } from './attribution.ts';
import type { SubjectType } from './events-parse.ts';
import type { PollIssue, PollPull } from './poller-entries.ts';
import { buildSubjectKey } from './run-key.ts';
import type { Run, RunsDocument } from './runs-types.ts';

/** One subject the scan is following: the run that carries its recorded session. */
export interface TrackedSubject {
    /** The run a follow-up for this subject joins (FR-100). */
    readonly correlationId: string;
    /** Whether the subject is an issue or a pull request; written on every follow-up row (FR-101). */
    readonly subjectType: SubjectType;
    /**
     * The head-SHA seed the run holds, or `null` when none was recorded.
     *
     * `null` is **not** "the head changed": a run with no seed compares
     * nothing this cycle and records the head it observes (FR-103(b)).
     */
    readonly lastHeadSha: string | null;
    /**
     * The login the work item is attributed to, or `null` when the run's first
     * reference recorded none. A head-SHA movement carries no author of its own
     * on the pulls list, so it rides this one.
     */
    readonly actorLogin: string | null;
    /** How that attribution was made, or `null` when none was recorded. */
    readonly actorAttribution: ActorAttribution | null;
}

/**
 * The three terminal facts an item's own state can report (002 FR-106).
 *
 * A closed union rather than a raw GitHub word, because the pull-request object
 * carries no `state_reason` — the reason vocabulary is issue-only — so *which*
 * of the three was observed is a fact this module derives and the audit row
 * records, not a string it copies.
 */
export type TerminalFact = 'closed' | 'merged' | 'closed-unmerged';

/** What ending tracking on one subject records. */
export interface TrackingEnd {
    /** The subject's ordinal-free key, so the row groups with its run. */
    readonly subjectKey: string;
    /** The run that was following the subject. */
    readonly correlationId: string;
    /** Which shape of subject the row is about. */
    readonly subjectType: SubjectType;
    /** Issue or pull-request number the row names. */
    readonly subjectNumber: number;
    /** Which of the three terminal facts was observed. */
    readonly fact: TerminalFact;
    /** The raw GitHub `state` word the row carried. */
    readonly state: string;
    /** The issue's `state_reason`, or `null` for a pull request and when absent. */
    readonly stateReason: string | null;
    /** `closed_at` / `merged_at` as GitHub sent it, or `null` when it sent none. */
    readonly at: string | null;
}

/**
 * Read the ordinal-free subject key one tracked subject is filed under.
 *
 * @returns The key, or `null` when the stored coordinates cannot produce one.
 */
function subjectKeyOf(input: {
    readonly accountNumericUserId: string;
    readonly repository: string;
    readonly subjectType: SubjectType;
    readonly subjectNumber: number;
}): string | null {
    try {
        return buildSubjectKey({
            accountNumericUserId: input.accountNumericUserId,
            repository: input.repository,
            subjectType: input.subjectType,
            subjectNumber: input.subjectNumber,
            ordinal: 0,
        });
    } catch {
        return null;
    }
}

/**
 * Read one tracked subject out of a run that carries a recorded session.
 *
 * The subject is filed under its **own** key, so a pull-request run and an
 * issue run sharing a number are two subjects and never one. A run whose
 * stored coordinates cannot produce a key is not followed rather than filed
 * under a guess (constitution II).
 */
function trackedOf(run: Run): { readonly key: string; readonly subject: TrackedSubject } | null {
    const key = subjectKeyOf({
        accountNumericUserId: run.accountNumericUserId,
        repository: run.repository,
        subjectType: run.subjectType,
        subjectNumber: run.subjectNumber,
    });
    if (key === null) {
        return null;
    }

    const first = run.sourceReferences[0];

    return {
        key,
        subject: {
            correlationId: run.correlationId,
            subjectType: run.subjectType,
            lastHeadSha: run.lastHeadSha ?? null,
            actorLogin: first?.actorLogin ?? null,
            actorAttribution: first?.actorAttribution ?? null,
        },
    };
}

/**
 * Read every subject this binding and account is following.
 *
 * Keyed by subject number, because GitHub gives one repository one numbering
 * space, and the subject's **shape** rides the entry — which is what lets a
 * comment row whose issue list entry is missing still write the tracked
 * subject's own shape rather than a kind-derived guess (FR-101).
 *
 * @returns The tracked subjects, keyed by issue or pull-request number.
 */
export function trackedSubjectsOf(input: {
    /** Run document this cycle read. */
    readonly document: RunsDocument;
    /** Binding being scanned; both its id and its account scope the view. */
    readonly binding: BindingRecord;
}): ReadonlyMap<number, TrackedSubject> {
    const tracked = new Map<number, TrackedSubject>();
    for (const run of input.document.runs) {
        // FR-100's recorded-session predicate, and nothing else: a run in
        // `dead-lettered`, `failed`, or `blocked` holds no session and is
        // therefore not followed, however live its state looks.
        if (run.session === null
            || run.bindingId !== input.binding.bindingId
            || run.accountNumericUserId !== input.binding.accountNumericUserId) {
            continue;
        }

        const read = trackedOf(run);
        if (read !== null) {
            tracked.set(run.subjectNumber, read.subject);
        }
    }

    return tracked;
}

/**
 * Drop the subjects whose tracking already ended from a tracked-subject view.
 *
 * The end of tracking stops **new detection** on that subject and nothing else
 * (002 FR-106), so a row the same cycle observed as terminal is filtered out
 * before the detectors run: a comment that arrived in the same cycle as the
 * item's conclusion is not a follow-up, because the conclusion has already been
 * observed. A follow-up already queued keeps its place — the queue is not read
 * here at all.
 *
 * @returns The view without the ended subjects.
 */
export function withoutEnded(
    tracked: ReadonlyMap<number, TrackedSubject>,
    ends: readonly TrackingEnd[],
): ReadonlyMap<number, TrackedSubject> {
    if (ends.length === 0) {
        return tracked;
    }

    const ended = new Set(ends.map((end) => end.subjectNumber));
    const kept = new Map([...tracked].filter(([subject]) => !ended.has(subject)));

    return kept;
}

/**
 * Read the ends of tracking one cycle's **issue** rows report.
 *
 * Only a subject the scan is following can end tracking. The list rows a
 * `state=open` feed carries are never terminal, so in production the rows this
 * is called with are the single read objects the lazy terminal read produced
 * (FR-106) rather than list rows; it is the same builder either way, because a
 * concluded issue and a list row would carry the same `state` / `state_reason` /
 * `closed_at`. An open row reports nothing, and a closed one reports the fact,
 * the date, and the reason.
 *
 * @returns The ends, in issue-list order.
 */
export function trackedIssueEnds(input: {
    /** The binding being scanned; its coordinates key the ends. */
    readonly binding: BindingRecord;
    /** Issues the cycle's own issue list carried. */
    readonly issues: readonly PollIssue[];
    /** Subjects this binding and account is following. */
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
}): readonly TrackingEnd[] {
    const ends: TrackingEnd[] = [];
    for (const issue of input.issues) {
        const subject = input.tracked.get(issue.issueNumber);
        if (subject === undefined || issue.state !== 'closed') {
            continue;
        }

        const key = subjectKeyOf({
            accountNumericUserId: input.binding.accountNumericUserId,
            repository: input.binding.repository,
            subjectType: 'issue',
            subjectNumber: issue.issueNumber,
        });
        if (key === null) {
            continue;
        }

        ends.push({
            subjectKey: key,
            correlationId: subject.correlationId,
            subjectType: 'issue',
            subjectNumber: issue.issueNumber,
            fact: 'closed',
            state: issue.state,
            stateReason: issue.stateReason ?? null,
            at: issue.closedAt ?? null,
        });
    }

    return ends;
}

/**
 * Read which terminal fact one **pull-request** row reports, or `null` while it
 * is open.
 *
 * `merged: true` and `state: 'closed'` are the two GitHub reports a row can
 * carry and they are different conclusions: a merged pull request's work is
 * done, and a closed unmerged one was abandoned. An absent `merged` reads as
 * `false`, which is the direction that can only fail to end tracking and never
 * end it on a guess.
 *
 * @returns The fact, or `null`.
 */
function terminalPullFact(pull: PollPull): TerminalFact | null {
    if (pull.merged === true) {
        return 'merged';
    }

    return pull.state === 'closed' ? 'closed-unmerged' : null;
}

/**
 * Read the ends of tracking one cycle's **pull-request** rows report.
 *
 * `merged: true` and `state: 'closed'` are the two GitHub reports a row can
 * carry and they are different conclusions, so both are named distinctly.
 * An absent `merged` reads as `false`, which is the direction that can only
 * fail to end tracking and never end it on a guess.
 *
 * @returns The ends, in pulls-list order.
 */
export function trackedPullEnds(input: {
    /** The binding being scanned; its coordinates key the ends. */
    readonly binding: BindingRecord;
    /** Pull requests the cycle's own pulls list carried. */
    readonly pulls: readonly PollPull[];
    /** Subjects this binding and account is following. */
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
}): readonly TrackingEnd[] {
    const ends: TrackingEnd[] = [];
    for (const pull of input.pulls) {
        const subject = input.tracked.get(pull.pullNumber);
        const fact = terminalPullFact(pull);
        if (subject === undefined || fact === null) {
            continue;
        }

        const key = subjectKeyOf({
            accountNumericUserId: input.binding.accountNumericUserId,
            repository: input.binding.repository,
            subjectType: 'pull_request',
            subjectNumber: pull.pullNumber,
        });
        if (key === null) {
            continue;
        }

        ends.push({
            subjectKey: key,
            correlationId: subject.correlationId,
            subjectType: 'pull_request',
            subjectNumber: pull.pullNumber,
            fact,
            state: pull.state,
            stateReason: null,
            at: pull.mergedAt ?? null,
        });
    }

    return ends;
}

/**
 * Map the heads a cycle observed onto the run document's own key space.
 *
 * @returns The heads keyed by the ordinal-free subject key of a
 *   `pull_request` subject; a coordinates pair that cannot produce a key leaves
 *   its observation out rather than guessing one.
 */
export function observedHeadSeeds(input: {
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Observed heads keyed by pull-request number. */
    readonly observations: ReadonlyMap<number, string>;
}): ReadonlyMap<string, string> {
    const seeds = new Map<string, string>();
    for (const [pullNumber, headSha] of input.observations) {
        const key = subjectKeyOf({
            accountNumericUserId: input.binding.accountNumericUserId,
            repository: input.binding.repository,
            subjectType: 'pull_request',
            subjectNumber: pullNumber,
        });
        if (key !== null) {
            seeds.set(key, headSha);
        }
    }

    return seeds;
}
