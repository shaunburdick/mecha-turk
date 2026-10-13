/**
 * The actor allow-list gate — one membership comparison, in one place,
 * that leaves a refusal behind (003 dispatch-authorization contract §1).
 */

import { isActorAllowed } from '../bindings-allow-list.ts';
import { readBindingsForAuthorization } from '../bindings-read.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { ActorAttribution } from './attribution.ts';
import { refuseOnWindow } from './run-refusal.ts';
import type { ReferenceWindow, RunRefusal } from './run-refusal.ts';
import type { ActorGateRefusal, ActorPolicy, Run } from './runs-types.ts';

/** The wire code the gate refuses with, and the declared `blocked:` cause it parks in. */
export const ACTOR_NOT_ALLOWED = 'actor-not-allowed';

/**
 * The declared `blocked:<reason>` cause a refused run waits in. Exported,
 * and spelled once here, because this is the **only** place the gate
 * exists: the block report's declared set admits it, the retry re-check
 * re-judges it against the live policy, and the panel's affordance table
 * reads the same word off the state. Four modules naming one string is
 * exactly why it is one exported constant.
 */
export const ACTOR_BLOCKED_REASON = ACTOR_NOT_ALLOWED;

/**
 * The word a denied login's basis reads as when the run recorded none.
 *
 * `subject-author` and `direct` are the only two legal values, so a
 * login with no basis beside it came from a reference stored before attribution
 * existed. It is **named** rather than defaulted: printing `direct` there would
 * record an inference as a fact.
 */
const UNRECORDED_BASIS = 'unrecorded';

/**
 * One retained reference's actor, classified.
 *
 * A **closed union rather than a nullable triple**: `login` exists exactly when
 * the reference names a readable actor, so no call site can read a login off an
 * unreadable entry without narrowing — which is precisely the confusion a closed
 * union exists to prevent.
 */
type ClassifiedActor =
    /** No readable actor: absent, empty, or bot-shaped. */
    | { readonly readable: false }
    | {
        /** Discriminant, so narrowing yields a usable login with no cast. */
        readonly readable: true;
        /** The attributed login: never empty, never bot-shaped. */
        readonly login: string;
        /** How it was attributed; `null` when the run records no basis. */
        readonly attribution: ActorAttribution | null;
    };

export interface ActorPolicyRefusal {
    /** The wire code and the secret-free cause the response carries. */
    readonly refusal: RunRefusal;
    /** The details the `dispatch.refused` row adds. */
    readonly actor: ActorGateRefusal;
}

export type ActorPolicyVerdict =
    /** At least one reference names an allowed, readable actor. */
    | { readonly admitted: true; readonly policy: ActorPolicy }
    /** No reference does; the row records why. */
    | { readonly admitted: false; readonly refused: ActorPolicyRefusal };

/**
 * Classify one reference's actor, without consulting any list.
 *
 * **An absent, empty, or bot-shaped actor is unreadable, whatever the policy
 * is.** That is the whole rule, and the reason the gate never asks the
 * list: a login GitHub marked as a bot is never attributed onto an event at all,
 * so one here can only come from a hand-edited document.
 */
function classifyActor(reference: Run['sourceReferences'][number]): ClassifiedActor {
    const login = reference.actorLogin;
    if (login === undefined || login === '' || login.toLowerCase().endsWith('[bot]')) {
        return { readable: false };
    }

    return { readable: true, login, attribution: reference.actorAttribution ?? null };
}

interface ClassifiedRun {
    /** References naming a readable, non-bot login. */
    readonly readable: readonly Extract<ClassifiedActor, { readonly readable: true }>[];
    readonly unreadableReferences: number;
}

function classifyRun(run: Run): ClassifiedRun {
    const classified = run.sourceReferences.map((reference) => classifyActor(reference));

    return {
        readable: classified.filter((actor) => actor.readable),
        unreadableReferences: classified.filter((actor) => !actor.readable).length,
    };
}

interface JudgedWindow {
    readonly retained: number;
    readonly notRetained: number;
    readonly truncated: boolean;
}

/**
 * Read the window the verdict was decided on, for the detail set and the
 * messages that must admit the decision was made on an incomplete list.
 */
function judgedWindow(run: Run): JudgedWindow {
    return {
        retained: run.sourceReferences.length,
        notRetained: run.referencesNotRetained,
        truncated: run.referencesTruncated,
    };
}

/** The detail set one denial records, whatever its message. */
function refusalDetails(input: {
    readonly run: Run;
    /** The shape the read found, or `null` when it found none at all. */
    readonly policy: ActorPolicy | null;
    /** Every denied login, in reference order, when a policy was compared. */
    readonly deniedLogins: readonly string[] | undefined;
    /** Each denied login's basis, index-parallel to the logins. */
    readonly deniedAttributions: readonly string[] | undefined;
    readonly unreadableReferences: number;
}): ActorGateRefusal {
    const window = judgedWindow(input.run);

    return {
        bindingId: input.run.bindingId,
        actorPolicy: input.policy,
        ...(input.deniedLogins !== undefined && { deniedLogins: input.deniedLogins }),
        ...(input.deniedAttributions !== undefined && { deniedAttributions: input.deniedAttributions }),
        unreadableReferences: input.unreadableReferences,
        retainedReferences: window.retained,
        referencesNotRetained: window.notRetained,
        referencesTruncated: window.truncated,
    };
}

/**
 * The window this decision saw, as the wire states it. Read through
 * {@link judgedWindow} — the same helper the detail set records
 * `referencesTruncated` from — so the envelope's word and the row's flag are
 * two expressions of **one** read that cannot disagree, and the panel gets
 * the fact rather than re-deriving it from a document read at another moment
 * or matching message prose (constitution IV). Names no login: this word is
 * about a list.
 */
function judgedWindowWord(run: Run): ReferenceWindow {
    return judgedWindow(run).truncated ? 'truncated' : 'complete';
}

/**
 * The clause naming an incomplete reference list, and what cannot clear it:
 * the decision was made on a partial list, so the remedy is **not** an
 * allow-list edit — the operator-facing half of the liveness rule the module
 * header states. The sentence and {@link judgedWindowWord} are that one fact
 * in two forms, built from the same boolean on purpose so neither derives
 * the other by parsing.
 */
function truncatedNote(run: Run): string {
    if (!run.referencesTruncated) {
        return '';
    }

    return `; this run's source reference list was cut at ${run.sourceReferences.length} of `
        + `${run.referenceCount} triggers, so this decision was made on an incomplete list and adding a login to `
        + "the binding's allowedUsers cannot clear it";
}

/**
 * Name every denied login with its basis, as the refusal message reads it:
 * each basis is spelled in the attribution union's vocabulary, so a login is
 * named with the provenance of its attribution and never as a claim that a
 * denied actor caused anything. The `subject-author` clause states only the
 * row's provenance — *whatever the rule in force at write time could name* —
 * and asserts nothing about the provider, after the earlier wording's false
 * premise was corrected (GitHub records both actors, in `assigner` and
 * `review_requester`).
 */
function namedActors(actors: readonly Extract<ClassifiedActor, { readonly readable: true }>[]): string {
    return actors
        .map((actor) => `${actor.login} (${actor.attribution === 'subject-author'
            ? 'the issue or pull-request author, attributed under the rule in force when this row was written'
            : actor.attribution ?? UNRECORDED_BASIS})`)
        .join(', ');
}

/**
 * The trailing clause naming references the list could never have judged.
 */
function unreadableNote(unreadableReferences: number): string {
    return unreadableReferences === 0
        ? 'every reference names a readable actor'
        : `${unreadableReferences} of this run's references name no readable actor`;
}

/**
 * The refusal one denied run leaves behind, whatever its message.
 *
 * **One builder for both denials**, because the two facts it adds — the
 * truncation clause and the window word — are added by the same two lines and
 * must never be added to one denial and not the other. An operator told to
 * widen a list that cannot widen it has been told to do something useless, and
 * the retry re-judges from the same truncated list anyway.
 */
function deniedPolicyRefusal(input: {
    readonly run: Run;
    readonly policy: ActorPolicy;
    /** The verdict's own words, before the truncation clause. */
    readonly message: string;
    /** Every readable actor, in reference order — all of them denied. */
    readonly readable: readonly Extract<ClassifiedActor, { readonly readable: true }>[];
    /** How many references named no readable actor. */
    readonly unreadableReferences: number;
}): ActorPolicyVerdict {
    return {
        admitted: false,
        refused: {
            refusal: refuseOnWindow({
                code: ACTOR_NOT_ALLOWED,
                message: `${input.message}${truncatedNote(input.run)}`,
                referenceWindow: judgedWindowWord(input.run),
            }),
            actor: refusalDetails({
                run: input.run,
                policy: input.policy,
                deniedLogins: input.readable.map((actor) => actor.login),
                deniedAttributions: input.readable.map((actor) => actor.attribution ?? UNRECORDED_BASIS),
                unreadableReferences: input.unreadableReferences,
            }),
        },
    };
}

/**
 * An unreadable actor is refused **regardless** of the policy, so admission
 * requires at least one reference naming a readable login the list allows;
 * under an **open** policy that reduces to *some reference names a readable
 * actor*. Pure, so the caller owns the store read and the write and the same
 * predicate can re-judge a `blocked:actor-not-allowed` run on the retry path
 * — which is what makes *cannot be retried into a dispatch this gate would
 * refuse again* a property rather than a hope.
 */
export function judgeActorPolicy(input: {
    readonly run: Run;
    /** The binding's stored list, or `undefined` when the policy is open. */
    readonly allowedUsers: readonly string[] | undefined;
}): ActorPolicyVerdict {
    const { run, allowedUsers } = input;
    const { readable, unreadableReferences } = classifyRun(run);
    const policy: ActorPolicy = allowedUsers === undefined ? 'open' : 'restricted';

    // A readable actor naming an allowed login is the whole admitted rule, and
    // `isActorAllowed` is the one membership comparison in the product.
    if (readable.some((actor) => isActorAllowed(actor.login, allowedUsers))) {
        return { admitted: true, policy };
    }

    const refuseWith = (message: string): ActorPolicyVerdict =>
        deniedPolicyRefusal({ run, policy, message, readable, unreadableReferences });

    if (readable.length > 0) {
        return refuseWith('no source reference on this run names an actor the binding\'s allowedUsers permits: '
            + `${namedActors(readable)}; ${unreadableNote(unreadableReferences)}`);
    }

    // Every reference is unreadable, or the run carries none at all. Neither is
    // something a list can admit, so the message says which one it is rather
    // than implying a policy refused an actor it never saw.
    return refuseWith(unreadableReferences === 0
        ? 'this run records no source reference, so no actor can be permitted'
        : `this run records no readable actor: all ${unreadableReferences} of its references name no `
            + 'attribution or name a bot account, which no binding can permit');
}

export type UnreadablePolicyCause =
    /** `bindings.json` is absent, quarantined, or unreadable. */
    | 'document-unreadable'
    /** The document read cleanly and does not carry this run's binding. */
    | 'binding-absent';

/**
 * The gate's verdict when the policy could not be read at all — **one code,
 * not a new one**: an absent document, an unusable one, and one that no
 * longer carries the binding leave the run in the same place and are
 * repaired the same way, and a vocabulary addition is a compatibility tax.
 * The message names which it was, because *the allow-list for binding X
 * could not be read* is a sentence an operator cannot act on. `actorPolicy`
 * is `null` rather than a guessed `'open'`, the denial members are omitted
 * (nothing was compared, so `[]` would read as *every actor was refused*),
 * and the run's own counts are still recorded (constitution IV).
 */
export function unreadablePolicyRefusal(run: Run, cause: UnreadablePolicyCause): ActorPolicyVerdict {
    const { unreadableReferences } = classifyRun(run);
    const message = cause === 'binding-absent'
        ? `no binding ${run.bindingId} exists, so its allow-list cannot be read and no dispatch is authorized`
        : `the bindings document could not be read, so the allow-list for binding ${run.bindingId} cannot be `
            + 'judged and no dispatch is authorized';

    return {
        admitted: false,
        refused: {
            refusal: refuseOnWindow({
                code: ACTOR_NOT_ALLOWED,
                message: `${message}${truncatedNote(run)}`,
                referenceWindow: judgedWindowWord(run),
            }),
            actor: refusalDetails({
                run,
                policy: null,
                deniedLogins: undefined,
                deniedAttributions: undefined,
                unreadableReferences,
            }),
        },
    };
}

export type LivePolicy =
    /** The binding's stored list, or `undefined` for an open policy. */
    | { readonly readable: true; readonly allowedUsers: readonly string[] | undefined }
    | { readonly readable: false; readonly cause: UnreadablePolicyCause };

/**
 * Read the binding's live allow-list, fail-closed. Called **inside the one
 * chain task**, so an operator's edit takes effect on the next
 * authorization with no re-scan, no restart and **no cache**: `ServiceStore`
 * exposes no `stat`, so a cache invalidated only by `writeBindings` would
 * never see a hand edit, and a stale-policy gate is worse than no gate. The
 * bindings write joins that same chain, so a tightening can never
 * interleave with this read — a token is never minted against a list the
 * operator has just revoked.
 */
export async function readLivePolicy(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly bindingId: string;
}): Promise<LivePolicy> {
    const read = await readBindingsForAuthorization({ store: input.store, log: input.log });
    if (!read.readable) {
        return { readable: false, cause: 'document-unreadable' };
    }

    const binding = read.bindings.find((candidate) => candidate.bindingId === input.bindingId);

    return binding === undefined
        ? { readable: false, cause: 'binding-absent' }
        : { readable: true, allowedUsers: binding.allowedUsers };
}
