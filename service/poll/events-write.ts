/**
 * Assembling one queued event (the write side of the queue contract).
 */

import type { ActorAttribution, QueuedEvent, SubjectType } from './events-parse.ts';

interface BaseEventSnapshot {
    readonly bindingId: string;
    /** Issued repository in `owner/name` form. */
    readonly repository: string;
    /** The account's durable key. */
    readonly accountNumericUserId: string;
    readonly accountLogin: string;
    readonly projectId: string;
    /** Worktree option copied verbatim from the binding. */
    readonly worktreeOption: string;
    /** Issue fields, already normalized. */
    readonly issue: {
        readonly issueNumber: number;
        readonly issueTitle: string;
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
    readonly triggerNote: string;
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

/** Where a mention token matched: a comment, a review comment, or the issue body itself. */
export type MentionOrigin = 'comment' | 'review-comment' | 'body';

/** A mention the bound account's login appeared in (M6). */
interface MentionEventSnapshotBase extends BaseEventSnapshot {
    /** The M6 trigger. */
    readonly kind: 'mention';
    /** Which text carried the mention token; keys the id's last segment. */
    readonly origin: MentionOrigin;
}

/** A comment that mentioned the bound account (M6). */
export interface MentionEventSnapshot extends MentionEventSnapshotBase {
    readonly origin: 'comment';
    /** The comment's id: two comments on one issue are two events. */
    readonly commentId: number;
}

/**
 * An inline review comment that mentioned the bound account (011 FR-006).
 *
 * Its own origin, and therefore its own discriminator, because GitHub numbers
 * review comments on a feed separate from conversation comments: the same
 * integer can name one of each, and only the origin keeps the two apart.
 */
export interface MentionReviewCommentSnapshot extends MentionEventSnapshotBase {
    readonly origin: 'review-comment';
    /** The review comment's id: two review comments on one pull are two events. */
    readonly commentId: number;
}

/**
 * An issue body that mentioned the bound account (M6, operator product
 * decision 2026-09-28: a mention works in the issue body as well as in a
 * comment).
 */
export interface MentionBodyEventSnapshot extends MentionEventSnapshotBase {
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

/**
 * A **follow-up**: a comment on a subject whose run already carries a
 * recorded session (002 FR-102(a)). The row **reuses** the closed
 * `EventKind` union rather than widening it — widening it would make both
 * shipped parsers refuse the row and quarantine the queue and the run
 * document — so it carries `'mention'`, naming the feed the detection
 * rides, while the `~followup~…` discriminator records the *role* and never
 * claims anyone mentioned the account.
 */
export interface FollowUpCommentSnapshot extends BaseEventSnapshot {
    /** The feed the detection rides: the issue-comment list. */
    readonly kind: 'mention';
    /** Marks this row as a follow-up rather than a trigger, and which kind. */
    readonly followUp: 'comment';
    /** The comment's id: the id's last segment, and its dedupe key. */
    readonly commentId: number;
    /**
     * The tracked subject's shape, written from the run rather than inferred.
     *
     * **Required on a follow-up**, where it is optional on a trigger: the
     * kind-based fallback would read a head-SHA follow-up on a tracked pull as
     * an issue, because `'mention'` is the one kind that also rides issues
     * (002 FR-101).
     */
    readonly subjectType: SubjectType;
}

/**
 * A **follow-up**: a review request on a pull request whose run already
 * carries a session (011 FR-005).
 *
 * `'review'` is the feed the detection rides, exactly as the comment
 * follow-up carries `'mention'`; the `~followup~review~<eventId>` id records
 * the role. The id is the naming `review_requested` event's **own** integer
 * id, which is what makes a re-request a new observation: the first request's
 * row is a different event, so nothing dedupes the second into the first.
 */
export interface FollowUpReviewSnapshot extends BaseEventSnapshot {
    /** The feed the detection rides: the pulls list. */
    readonly kind: 'review';
    /** Marks this row as a follow-up rather than a trigger, and which kind. */
    readonly followUp: 'review';
    /** The naming event's integer id: the id's last segment, and its dedupe key. */
    readonly eventId: number;
    /** Head commit SHA at detection time, or `null` when GitHub sent none. */
    readonly headSha: string | null;
    /** Base ref name, or `null` when GitHub sent none. */
    readonly baseRef: string | null;
    /** The tracked subject's shape, required exactly as on a comment follow-up. */
    readonly subjectType: SubjectType;
}

/**
 * A **follow-up**: an inline review comment on a tracked pull request
 * (011 FR-006).
 *
 * `'mention'` names the feed family the detection rides — a review comment is
 * a comment — while `'review-comment'` records the role, so a review comment
 * never collides with a conversation comment's `~followup~<commentId>` id:
 * GitHub numbers the two comment feeds independently.
 */
export interface FollowUpReviewCommentSnapshot extends BaseEventSnapshot {
    /** The feed family the detection rides: comments. */
    readonly kind: 'mention';
    /** Marks this row as a follow-up rather than a trigger, and which kind. */
    readonly followUp: 'review-comment';
    /** The review comment's id: the id's last segment, and its dedupe key. */
    readonly commentId: number;
    /** The tracked subject's shape, required exactly as on a comment follow-up. */
    readonly subjectType: SubjectType;
}

/**
 * A **follow-up**: a head-SHA change on a tracked pull request
 * (002 FR-102(b)).
 *
 * `'review'` for the same reason the comment follow-up carries `'mention'`,
 * naming the pulls list the detection rides. `headSha` is the SHA **observed**
 * at detection — the follow-up's `to` — and is never `null`: an observation
 * with no SHA is not a change and produces no row at all.
 */
export interface FollowUpHeadSnapshot extends BaseEventSnapshot {
    /** The feed the detection rides: the pull-request list. */
    readonly kind: 'review';
    readonly followUp: 'head';
    /** The head SHA observed at detection; the follow-up's `to`. */
    readonly headSha: string;
    /** `null` always: a movement observation restates no base ref. */
    readonly baseRef: string | null;
    /** The tracked subject's shape, required exactly as on a comment follow-up. */
    readonly subjectType: SubjectType;
}

export type EventSnapshot =
    | AssignmentEventSnapshot
    | MentionEventSnapshot
    | MentionReviewCommentSnapshot
    | MentionBodyEventSnapshot
    | ReviewEventSnapshot
    | FollowUpCommentSnapshot
    | FollowUpReviewSnapshot
    | FollowUpReviewCommentSnapshot
    | FollowUpHeadSnapshot;

/**
 * Build the deterministic event id for one detection — the dedupe key, the
 * relay path segment, and the reference already recorded in ledgers, so the
 * actor rides the record and never its identity (003 FR-012). `~` joins the
 * `A-Za-z0-9_-` owner and repository parts; the fixed discriminators
 * (`~mention~body`, `~followup~head~<sha>`) keep every form inside one URL
 * path segment with no route ambiguity (002 FR-101).
 */
export function buildEventId(input: {
    readonly repository: { readonly owner: string; readonly name: string };
    readonly issueNumber: number;
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
 * A follow-up's discriminator records its **role**, and the snapshot's `kind`
 * records which feed the detection rode, so the two are read from two
 * different members rather than from one overloaded value.
 */
function discriminatorOf(snapshot: EventSnapshot): string | undefined {
    // `followUp` is declared on the two follow-up snapshots alone, so its
    // presence is what narrows the union — and the trigger snapshots carry no
    // role member at all, which is why no existing snapshot changed shape.
    if ('followUp' in snapshot) {
        if (snapshot.followUp === 'head') {
            return `~followup~head~${snapshot.headSha}`;
        }

        if (snapshot.followUp === 'review') {
            return `~followup~review~${snapshot.eventId}`;
        }

        return snapshot.followUp === 'review-comment'
            ? `~followup~review-comment~${snapshot.commentId}`
            : `~followup~${snapshot.commentId}`;
    }

    if (snapshot.kind === 'mention') {
        if (snapshot.origin === 'body') {
            return '~mention~body';
        }

        return snapshot.origin === 'review-comment'
            ? `~mention~review~${snapshot.commentId}`
            : `~mention~${snapshot.commentId}`;
    }

    return snapshot.kind === 'review' ? '~review' : undefined;
}

/**
 * Read the head SHA one snapshot contributes; `null` for the other triggers.
 *
 * A follow-up head row carries the SHA it **observed**, which is the only
 * value on it that is not a fact about a review request.
 */
function headShaOf(snapshot: EventSnapshot): string | null {
    return snapshot.kind === 'review' ? snapshot.headSha : null;
}

/**
 * Read the base ref one snapshot contributes; `null` for the other triggers.
 */
function baseRefOf(snapshot: EventSnapshot): string | null {
    return snapshot.kind === 'review' ? snapshot.baseRef : null;
}

/**
 * Read the subject shape one snapshot carries, defaulting the way a row
 * written before the run layer reads (data-model §2.1).
 */
function subjectTypeOfSnapshot(snapshot: EventSnapshot): SubjectType {
    if (snapshot.subjectType !== undefined) {
        return snapshot.subjectType;
    }

    return snapshot.kind === 'review' ? 'pull_request' : 'issue';
}

/**
 * Assemble one queued event from a fresh detection. The row carries **no
 * legacy lifecycle fields** — a post-003 row gets its state from the run it
 * joins (data-model §2.1) — and the two actor members ride the optional
 * snapshot members, never the id: `buildEventId` is untouched because that id
 * is already the dedupe key, the relay path segment, and the reference in
 * ledgers and audit rows, so tightening an allow-list can never manufacture
 * duplicate work. A follow-up snapshot records its role in the discriminator
 * so a head-SHA movement is never read as an issue.
 */
export function createEvent(snapshot: EventSnapshot): QueuedEvent {
    const separatorIndex = snapshot.repository.indexOf('/');
    const owner = separatorIndex === -1 ? snapshot.repository : snapshot.repository.slice(0, separatorIndex);
    const name = separatorIndex === -1 ? '' : snapshot.repository.slice(separatorIndex + 1);

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
