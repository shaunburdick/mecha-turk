/**
 * Fixture detections and the queue writers the dispatch loop drives (003
 * T-031, T-036 — SC-101's batched trials).
 *
 * The vocabulary a fixture scan speaks lives here beside the two ways a test
 * hands it to the real queue: {@link EnqueueFamily.enqueue} for one subject,
 * and {@link EnqueueFamily.enqueueScan} for a scan-sized batch — exactly how
 * the production loop hands one binding's scan to `enqueueEvents`
 * (`service/poll/loop.ts`). Both paths go through the real coalescing writer;
 * nothing here forges a run.
 *
 * These helpers deliberately know nothing about the panel or the service —
 * only the store they write through and the logger they report to, which
 * [dispatch-loop.ts](./dispatch-loop.ts) supplies when it binds them.
 */

import { createEvent, enqueueEvents } from '../../service/poll/events.ts';
import type { EventSnapshot } from '../../service/poll/events.ts';
import { resolvePromptSnapshot } from '../../service/prompt.ts';
import type { ServiceLogger } from '../../service/log.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import { PROJECT_ID } from './panel.ts';

/** Trigger shapes the loop's fixtures enqueue. */
export type FixtureTrigger = 'assignment' | 'comment-mention' | 'body-mention';

/** Binding every fixture detection names; the mounts install it as active. */
export const BINDING_ID = 'bnd-loop';

/** Repository every fixture detection names. */
export const REPOSITORY = 'acme/loop';

/** Account every fixture detection is about. */
export const ACCOUNT_ID = '77331';

/** Login every fixture detection carries. */
export const ACCOUNT_LOGIN = 'octocat';

/** Worktree option every fixture binding dispatches with. */
export const WORKTREE_OPTION = 'none';

/** Stamp every fixture detection carries unless a test overrides it. */
export const FIXTURE_STAMP = '2026-09-20T00:00:00.000Z';

/** Inputs for one fixture subject handed to the queue. */
export interface EnqueueInput {
    /** Issue the triggers are about. */
    readonly issueNumber: number;
    /** Triggers detected for that issue; defaults to one assignment. */
    readonly triggers?: readonly FixtureTrigger[];
    /** Detection stamp; defaults to {@link FIXTURE_STAMP}. */
    readonly detectedAt?: string;
    /** The binding's prompt at detection, snapshotted onto the run (004 FR-015). */
    readonly prompt?: string;
}

/** The two ways a test hands fixture detections to the real queue. */
export interface EnqueueFamily {
    /** Enqueue one subject's fixture deliveries through the real coalescing path. */
    enqueue(input: EnqueueInput): Promise<void>;
    /**
     * Enqueue many subjects' fixture deliveries through **one** real
     * `enqueueEvents` call — a scan-sized batch, exactly how the production
     * loop hands one binding's scan to the queue.
     */
    enqueueScan(inputs: readonly EnqueueInput[]): Promise<void>;
}

/** Build the detection one fixture trigger maps onto. */
function detection(input: {
    /** Issue the detection is about. */
    readonly issueNumber: number;
    /** Which trigger fired. */
    readonly trigger: FixtureTrigger;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
}): EventSnapshot {
    const base = {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: WORKTREE_OPTION,
        issue: {
            issueNumber: input.issueNumber,
            issueTitle: `Issue ${input.issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${input.issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        triggerNote: `${input.trigger} fixture`,
        detectedAt: input.detectedAt,
    };

    // The basis is per trigger kind, not per fixture: both mention kinds name
    // the author of the text that carried the token directly, while an
    // assignment is attributed to the issue author as a documented proxy
    // (002 FR-044).
    if (input.trigger === 'assignment') {
        return { ...base, kind: 'assignment', actorAttribution: 'subject-author' };
    }

    if (input.trigger === 'body-mention') {
        return { ...base, kind: 'mention', actorAttribution: 'direct', origin: 'body' };
    }

    return {
        ...base,
        kind: 'mention',
        actorAttribution: 'direct',
        origin: 'comment',
        commentId: 4_000 + input.issueNumber,
    };
}

/**
 * Build the fixture events one {@link EnqueueInput} maps onto, as one scan's
 * detections.
 *
 * @returns The events a queue write would receive for that subject.
 */
function eventsFor(input: EnqueueInput): ReturnType<typeof createEvent>[] {
    const triggers: readonly FixtureTrigger[] = input.triggers ?? ['assignment'];

    return triggers.map((trigger) => createEvent(detection({
        issueNumber: input.issueNumber,
        trigger,
        detectedAt: input.detectedAt ?? FIXTURE_STAMP,
    })));
}

/**
 * Write one scan's detections through the real queue path.
 */
async function enqueueThroughQueue(input: {
    /** Open store to write through. */
    readonly store: ServiceStore;
    /** Logger the queue reports through. */
    readonly log: ServiceLogger;
    /** Every subject detected in this scan. */
    readonly inputs: readonly EnqueueInput[];
    /** The binding's prompt at detection, or `undefined` for none. */
    readonly prompt: string | undefined;
}): Promise<void> {
    const incoming = input.inputs.flatMap((subject) => eventsFor(subject));
    const snapshot = input.prompt === undefined
        ? null
        : resolvePromptSnapshot({ global: null, account: null, binding: { startingPrompt: input.prompt } });
    const queued = { store: input.store, log: input.log, incoming };
    await enqueueEvents(snapshot === null ? queued : { ...queued, prompt: snapshot });
}

/**
 * Bind the fixture queue writers to whichever service instance is running.
 *
 * @param input - Reads the open store of the running instance, and the logger
 *   the loop keeps out of the test output.
 * @returns The single-subject and scan-sized writers, ready to spread onto a
 *   {@link import('./dispatch-loop.ts').DispatchLoop}.
 */
export function bindEnqueue(input: {
    /** Reads the open store of whichever instance is running. */
    readonly storeOf: () => ServiceStore;
    /** Logger every direct store call reports through. */
    readonly log: ServiceLogger;
}): EnqueueFamily {
    return {
        enqueue: async (subject) =>
            await enqueueThroughQueue({
                store: input.storeOf(),
                log: input.log,
                inputs: [subject],
                prompt: subject.prompt,
            }),
        enqueueScan: async (inputs) =>
            await enqueueThroughQueue({
                store: input.storeOf(),
                log: input.log,
                inputs,
                prompt: inputs.find((subject) => subject.prompt !== undefined)?.prompt,
            }),
    };
}
