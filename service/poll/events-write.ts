/**
 * Assembling one queued event (the write side of the queue contract).
 *
 * `events.ts` owns the queue's chain, dedupe, claim, and dispatch; the row
 * schema and validator sit beside it in `events-parse.ts`; this module is
 * the third slice of that contract — the detection snapshots each trigger
 * produces and the deterministic id built from one. The split keeps every
 * module inside the file-length gate, and `events.ts` re-exports {@link
 * createEvent} so callers keep a single import path.
 *
 * The id is the dedupe key, so it must be derivable from the detection
 * alone: the same assignment, the same comment, the same issue-body mention,
 * or the same review request must produce the same bytes on every scan.
 */

import type { ActorAttribution, QueuedEvent, SubjectType } from './events-parse.ts';

/** Fields every trigger's detection snapshot carries. */
interface BaseEventSnapshot {
    /** Binding that produced the detection. */
    readonly bindingId: string;
    /** Issued repository in `owner/name` form. */
    readonly repository: string;
    /** The account's durable key. */
    readonly accountNumericUserId: string;
    /** The account's login. */
    readonly accountLogin: string;
    /** Project the binding dispatches to. */
    readonly projectId: string;
    /** Worktree option copied verbatim from the binding. */
    readonly worktreeOption: string;
    /** Issue fields, already normalized. */
    readonly issue: {
        /** Issue number. */
        readonly issueNumber: number;
        /** Issue title. */
        readonly issueTitle: string;
        /** Issue URL. */
        readonly issueUrl: string;
        /** The (bounded) issue body excerpt. */
        readonly issueBodyExcerpt: string;
    };
    /**
     * The GitHub login this delivery is attributed to.
     *
     * **Required on every snapshot**, because attribution is mandatory and
     * fail-closed: a trigger that cannot name a human author must not build a
     * snapshot at all (002 FR-045(b)). The value is public repository identity,
     * never a credential, so it is credential-free by construction.
     */
    readonly actorLogin: string;
    /**
     * How that attribution was made — the difference between a
     * record and an inference, and never left implicit: `direct` when GitHub
     * named the identity that performed the act, which is every
     * kind — the text's author for a mention, and the `assigner` /
     * `review_requester` the naming event recorded for an assignment or a
     * review request. The legacy `subject-author` member is still
     * readable and is written by nothing.
     */
    readonly actorAttribution: ActorAttribution;
    /** The panel-rendered trigger phrase. */
    readonly triggerNote: string;
    /** Detection stamp. */
    readonly detectedAt: string;
    /**
     * Whether the subject is an issue or a pull request, captured from the
     * listing's `isPullRequest` at detection so the run key's subject type is
     * truthful. Omitted by older fixtures, which read as the trigger kind's
     * own shape (a review is always a pull request; every other kind falls
     * back to `issue`).
     */
    readonly subjectType?: SubjectType;
}

/** An assignment the bound account picked up (M1). */
export interface AssignmentEventSnapshot extends BaseEventSnapshot {
    /** The M1 trigger. */
    readonly kind: 'assignment';
}

/** Where a mention token matched: a comment, or the issue body itself. */
export type MentionOrigin = 'comment' | 'body';

/** A mention the bound account's login appeared in (M6). */
interface MentionEventSnapshotBase extends BaseEventSnapshot {
    /** The M6 trigger. */
    readonly kind: 'mention';
    /** Which text carried the mention token; keys the id's last segment. */
    readonly origin: MentionOrigin;
}

/** A comment that mentioned the bound account (M6). */
export interface MentionEventSnapshot extends MentionEventSnapshotBase {
    /** The comment carried the mention. */
    readonly origin: 'comment';
    /** The comment's id: two comments on one issue are two events. */
    readonly commentId: number;
}

/**
 * An issue body that mentioned the bound account (M6, operator product
 * decision 2026-09-28: a mention works in the issue body as well as in a
 * comment).
 */
export interface MentionBodyEventSnapshot extends MentionEventSnapshotBase {
    /** The issue body carried the mention. */
    readonly origin: 'body';
}

/** A pull request that asked the bound account to review (M7). */
export interface ReviewEventSnapshot extends BaseEventSnapshot {
    /** The M7 trigger. */
    readonly kind: 'review';
    /** Head commit SHA at detection time, or `null` when GitHub sent none. */
    readonly headSha: string | null;
    /** Base ref name, or `null` when GitHub sent none. */
    readonly baseRef: string | null;
}

/** Inputs used to assemble one queued event, narrowed by trigger kind. */
export type EventSnapshot =
    | AssignmentEventSnapshot
    | MentionEventSnapshot
    | MentionBodyEventSnapshot
    | ReviewEventSnapshot;

/**
 * Build the deterministic event id for one detection.
 *
 * The id doubles as the dedupe key and the relay path segment, so the join
 * character is `~` — GitHub owners and repositories (pattern
 * `A-Za-z0-9_-`) joined with `~` never collide — and the result stays inside
 * `[A-Za-z0-9._~]`, which is one URL path segment and no route ambiguity.
 *
 * The base (owner, repository, issue number, account) is enough for an
 * assignment and must stay byte-identical to the rows the queue already
 * holds. The optional discriminator extends it for the Slice-2 triggers:
 * `~mention~<commentId>` makes two comments on one issue two events,
 * `~mention~body` is the fixed suffix of an issue-body mention (fixed, so an
 * edited body re-detects to the same id and dedupes), and `~review` keeps a
 * review request distinct from the same PR's assignment. A comment id is
 * always a number, so `~mention~body` can never collide with one.
 *
 * `evt-<owner>~<repo>~<issueNumber>~<accountNumericUserId>` plus its optional
 * discriminator — `~mention~<commentId>`, the fixed `~mention~body`, or
 * `~review` — is **unchanged by this amendment**, for the reason 003 FR-012
 * already gives for the same identifier: it is simultaneously the delivery's
 * dedupe key, its relay path segment, and the reference recorded in existing
 * panel ledgers, audit rows, and the run history. The actor therefore
 * **rides the record and never its identity**.
 *
 * @param input - Repository, issue, account, and discriminator for the id.
 * @returns A `[A-Za-z0-9._~]`-only id of one path segment.
 */
export function buildEventId(input: {
    /** Repository the issue belongs to. */
    readonly repository: { readonly owner: string; readonly name: string };
    /** Matched issue (or pull request) number. */
    readonly issueNumber: number;
    /** The account the issue is assigned to. */
    readonly accountNumericUserId: string;
    /** Extra id segment; absent for an assignment, whose id never changes. */
    readonly discriminator?: string | undefined;
}): string {
    const { repository } = input;
    const base = `evt-${repository.owner}~${repository.name}~${input.issueNumber}~${input.accountNumericUserId}`;

    return input.discriminator === undefined ? base : `${base}${input.discriminator}`;
}

/**
 * Read the id discriminator one snapshot contributes.
 *
 * @param snapshot - Detection inputs.
 * @returns `undefined` for an assignment, the discriminator otherwise.
 */
function discriminatorOf(snapshot: EventSnapshot): string | undefined {
    if (snapshot.kind === 'mention') {
        return snapshot.origin === 'body' ? '~mention~body' : `~mention~${snapshot.commentId}`;
    }

    return snapshot.kind === 'review' ? '~review' : undefined;
}

/**
 * Read the head SHA one snapshot contributes; `null` for the other triggers.
 *
 * @param snapshot - Detection inputs.
 * @returns The SHA, or `null`.
 */
function headShaOf(snapshot: EventSnapshot): string | null {
    return snapshot.kind === 'review' ? snapshot.headSha : null;
}

/**
 * Read the base ref one snapshot contributes; `null` for the other triggers.
 *
 * @param snapshot - Detection inputs.
 * @returns The ref, or `null`.
 */
function baseRefOf(snapshot: EventSnapshot): string | null {
    return snapshot.kind === 'review' ? snapshot.baseRef : null;
}

/**
 * Read the subject shape one snapshot carries, defaulting the way a row
 * written before the run layer reads (data-model §2.1).
 *
 * @param snapshot - Detection inputs.
 * @returns The subject shape this row stores.
 */
function subjectTypeOfSnapshot(snapshot: EventSnapshot): SubjectType {
    if (snapshot.subjectType !== undefined) {
        return snapshot.subjectType;
    }

    return snapshot.kind === 'review' ? 'pull_request' : 'issue';
}

/**
 * Assemble one queued event from a fresh detection.
 *
 * The row carries **no legacy lifecycle fields**: `state`, `claimedAt`,
 * `dispatchedAt`, and `dispatchResult` belong to the shipped three-state
 * queue, and a row 003 enqueues gets its state from the run it joins
 * (data-model §2.1 — still parsed as migration input, never written again by
 * a fresh detection). `runCorrelationId` is added by the enqueue pass, which
 * is the only place the ordinal — and therefore the run — is known.
 *
 * The two actor members ride beside the other optional snapshot members
 * (`subjectType`), **not** the id: `buildEventId` is untouched, because that
 * id is simultaneously the dedupe key, the relay path segment, and the
 * reference already recorded in panel ledgers, audit rows, and the run history.
 * An issue observed once before this change and once after it is
 * still **one** event, and tightening a binding's allow-list can never
 * manufacture duplicate work.
 *
 * @param snapshot - Detection inputs.
 * @returns A fresh delivery row.
 */
export function createEvent(snapshot: EventSnapshot): QueuedEvent {
    const separatorIndex = snapshot.repository.indexOf('/');
    const owner = separatorIndex < 0 ? snapshot.repository : snapshot.repository.slice(0, separatorIndex);
    const name = separatorIndex < 0 ? '' : snapshot.repository.slice(separatorIndex + 1);

    const base = {
        bindingId: snapshot.bindingId,
        kind: snapshot.kind,
        repository: snapshot.repository,
        accountNumericUserId: snapshot.accountNumericUserId,
        accountLogin: snapshot.accountLogin,
        projectId: snapshot.projectId,
        worktreeOption: snapshot.worktreeOption,
        issueNumber: snapshot.issue.issueNumber,
        issueTitle: snapshot.issue.issueTitle,
        issueUrl: snapshot.issue.issueUrl,
        issueBodyExcerpt: snapshot.issue.issueBodyExcerpt,
        actorLogin: snapshot.actorLogin,
        actorAttribution: snapshot.actorAttribution,
        headSha: headShaOf(snapshot),
        baseRef: baseRefOf(snapshot),
        triggerNote: snapshot.triggerNote,
        detectedAt: snapshot.detectedAt,
        subjectType: subjectTypeOfSnapshot(snapshot),
    };

    return {
        ...base,
        id: buildEventId({
            repository: { owner, name },
            issueNumber: snapshot.issue.issueNumber,
            accountNumericUserId: snapshot.accountNumericUserId,
            discriminator: discriminatorOf(snapshot),
        }),
    };
}
