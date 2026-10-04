/**
 * The actor allow-list gate — **one membership comparison, in one place, that
 * leaves a refusal behind.**
 *
 * The authorization module owns the decide → apply → record chain and the token.
 * This module owns the answer to *"may this run start a session at all?"* and
 * answers it purely, so the caller owns the store read and the write and the
 * retry path can re-run the **same predicate** against its own live read.
 *
 * Six rules are load-bearing, and each is a decision rather than a default:
 *
 * - **The gate is the authorization decision; detection-time filtering is
 *   forbidden.** A poll-loop filter is cheaper and writes **no audit row**, so
 *   *"why was this not dispatched?"* would have no answer — the exact defect 003
 *   exists to end, repeated in a new place. Detection records the actor and
 *   decides nothing.
 * - **At least one** reference naming an allowed actor admits the run. Both
 *   obvious alternatives wedge permanently, because a `blocked:*` run is
 *   non-terminal and new deliveries **join** it: refusing when *any* reference
 *   is disallowed lets one stranger's comment disable every dispatch on that
 *   issue forever, and judging only the **opening** reference lets a stranger
 *   open a run an allowed user's later mention can then never authorize. The
 *   rule is a set quantifier over the retained references, so it does not depend
 *   on join order.
 * - **A bot is never admitted, and this gate adds no second bot test.** The
 *   single judgement lives in `attribution.ts` beside the detection filters that
 *   already apply it; here it only refuses. An absent, empty, or bot-shaped
 *   actor is refused **regardless of the policy** — an open policy is permission
 *   for a named human actor, not for nobody — because the fail-closed reading of
 *   an unreadable actor is *no actor*, never *the list says yes*.
 * - **The refusal names the denial; the record names the policy's shape only.**
 *   Every denied login and its attribution basis go on the `dispatch.refused`
 *   row, because a refusal a reader cannot attribute is not an explainable
 *   refusal. A basis is stated as the provenance it is: for the one legacy
 *   basis, the rule that was in force when the row was written, and nothing at
 *   all about GitHub's capabilities — GitHub records both the assigner and the
 *   reviewer. No **permitted** login appears anywhere: an audit trail listing who
 *   may trigger a repository is a second copy of the access policy in a file
 *   retained for months.
 * - **A truncated reference list is said out loud, not admitted around.** The
 *   quantifier above runs over the *retained* references, and the run layer stops
 *   retaining at {@link MAX_SOURCE_REFERENCES}. A run that reached the cap can
 *   therefore be carrying an allowed actor among the dropped references —
 *   invisible to this gate under **every** policy, which is the permanent wedge
 *   the quantifier exists to prevent arriving by the other door. The gate
 *   **refuses** on the truncated list, because admitting would be admitting an
 *   authorization nobody granted (constitution II), and the message, the
 *   `dispatch.refused` detail, and the retry's own refusal all say the decision
 *   was made on an incomplete list and that widening `allowedUsers` cannot clear
 *   it (constitution IV).
 * - **Placement is load-bearing: after `judgeReserve` has answered `null` and
 *   before any token is derived.** A policy check placed first would pre-empt
 *   `already-dispatched` — which names the session FR-022 and AC-112 require — and
 *   `stale-lease`, making both unreachable on the paths they exist for.
 *
 * Requirements: 003 FR-076 – FR-080, NFR-107, NFR-113; contract §1 in
 * [`contracts/dispatch-authorization.md`](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md).
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
 * The declared `blocked:<reason>` cause a refused run waits in.
 *
 * Exported, and spelled once here, because this is the **only** place the gate
 * exists: the block report's declared set
 * ([`dispatch-block.ts`](./dispatch-block.ts)) admits it, the retry re-check
 * ([`run-operate.ts`](./run-operate.ts)) re-judges it against the live policy,
 * and the panel's affordance table reads the same word off the state. Four
 * modules naming one string is exactly why it is one exported constant.
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
 * unreadable entry without narrowing — which is precisely the confusion FR-080
 * exists to prevent.
 */
type ClassifiedActor =
    /** No readable actor: absent, empty, or bot-shaped. */
    | { readonly readable: false }
    /** A readable login, with the basis the run recorded for it. */
    | {
        /** Discriminant, so narrowing yields a usable login with no cast. */
        readonly readable: true;
        /** The attributed login: never empty, never bot-shaped. */
        readonly login: string;
        /** How it was attributed; `null` when the run records no basis. */
        readonly attribution: ActorAttribution | null;
    };

/** What the gate refused, and the detail set the row records. */
export interface ActorPolicyRefusal {
    /** The wire code and the secret-free cause the response carries. */
    readonly refusal: RunRefusal;
    /** The details FR-077 adds to the `dispatch.refused` row. */
    readonly actor: ActorGateRefusal;
}

/** What the gate decided about one run's actor policy (003 FR-077). */
export type ActorPolicyVerdict =
    /** At least one reference names an allowed, readable actor. */
    | { readonly admitted: true; readonly policy: ActorPolicy }
    /** No reference does; the row records why. */
    | { readonly admitted: false; readonly refused: ActorPolicyRefusal };

/**
 * Classify one reference's actor, without consulting any list.
 *
 * **An absent, empty, or bot-shaped actor is unreadable, whatever the policy
 * is.** That is FR-080's whole rule and the reason the gate never asks the
 * list: a login GitHub marked as a bot is never attributed onto an event at all,
 * so one here can only come from a hand-edited document.
 *
 * @param reference - One retained source reference.
 * @returns The reference's classification.
 */
function classifyActor(reference: Run['sourceReferences'][number]): ClassifiedActor {
    const login = reference.actorLogin;
    if (login === undefined || login === '' || login.toLowerCase().endsWith('[bot]')) {
        return { readable: false };
    }

    return { readable: true, login, attribution: reference.actorAttribution ?? null };
}

/** The references a run carries, split into readable and unreadable actors. */
interface ClassifiedRun {
    /** References naming a readable, non-bot login. */
    readonly readable: readonly Extract<ClassifiedActor, { readonly readable: true }>[];
    /** How many references named no readable actor at all. */
    readonly unreadableReferences: number;
}

/**
 * Split one run's references into the two kinds the verdict is about.
 *
 * @param run - The run being authorized.
 * @returns The readable actors and the unreadable count.
 */
function classifyRun(run: Run): ClassifiedRun {
    const classified = run.sourceReferences.map(classifyActor);

    return {
        readable: classified.filter((actor) => actor.readable),
        unreadableReferences: classified.filter((actor) => !actor.readable).length,
    };
}

/** How much of the run's trigger history the gate could actually see. */
interface JudgedWindow {
    /** How many references were on the list the gate judged. */
    readonly retained: number;
    /** How many joining triggers the cap refused to retain. */
    readonly notRetained: number;
    /** Whether the list was cut at the cap. */
    readonly truncated: boolean;
}

/**
 * Read the window the verdict was decided on, for the detail set and the
 * messages that must admit the decision was made on an incomplete list.
 *
 * @param run - The run being authorized.
 * @returns The three counts the refusal records.
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
    /** The run being authorized. */
    readonly run: Run;
    /** The shape the read found, or `null` when it found none at all. */
    readonly policy: ActorPolicy | null;
    /** Every denied login, in reference order, when a policy was compared. */
    readonly deniedLogins: readonly string[] | undefined;
    /** Each denied login's basis, index-parallel to the logins. */
    readonly deniedAttributions: readonly string[] | undefined;
    /** How many references named no readable actor. */
    readonly unreadableReferences: number;
}): ActorGateRefusal {
    const window = judgedWindow(input.run);

    return {
        bindingId: input.run.bindingId,
        actorPolicy: input.policy,
        ...(input.deniedLogins === undefined ? {} : { deniedLogins: input.deniedLogins }),
        ...(input.deniedAttributions === undefined ? {} : { deniedAttributions: input.deniedAttributions }),
        unreadableReferences: input.unreadableReferences,
        retainedReferences: window.retained,
        referencesNotRetained: window.notRetained,
        referencesTruncated: window.truncated,
    };
}

/**
 * The window this decision saw, as the wire states it.
 *
 * Read through {@link judgedWindow} — the same helper the detail set records
 * `referencesTruncated` from — so the word on the envelope and the flag on the
 * `dispatch.refused` row are two expressions of **one** read and cannot
 * disagree. It is also the only reader of the fact that reaches a *panel*: the
 * panel has no way to see the gate's chain task, so without this member it
 * would either re-derive the window from a document read at another moment or
 * match the message's prose, and both are a second opinion about a decision
 * this service made (constitution IV).
 *
 * Names no login — NFR-113's rule is absolute, and this word is about a list.
 *
 * @param run - The run being authorized.
 * @returns The window, complete or truncated.
 */
function judgedWindowWord(run: Run): ReferenceWindow {
    return judgedWindow(run).truncated ? 'truncated' : 'complete';
}

/**
 * The clause naming an incomplete reference list, and what cannot clear it.
 *
 * **The operator-facing half of the liveness rule.** The gate's quantifier runs
 * over the **retained** references, and the cap stops retaining at
 * {@link MAX_SOURCE_REFERENCES} — so a run whose list was cut can hold
 * an allowed actor among the *dropped* references, and no policy change can ever
 * admit it. That is exactly the permanent wedge the quantifier exists to
 * prevent, arriving by the other door: admitting on truncation would admit an
 * authorization nobody granted (constitution II), and refusing silently would
 * break constitution IV's promise that an operator can tell *why*. So the
 * refusal says the decision was made on a partial list and that the remedy is
 * **not** an allow-list edit.
 *
 * The sentence and {@link judgedWindowWord} are the same fact in two forms: the
 * first for a reader, the second for a machine. They are built from the same
 * boolean on purpose — the prose is for the operator, the word is for the
 * panel, and neither derives the other by parsing.
 *
 * Names no login — NFR-113's rule is absolute, and this clause has nothing to
 * do with whose login it is.
 *
 * @param run - The run being authorized.
 * @returns The clause, or the empty string when the list is complete.
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
 * Name every denied login with its basis, as the refusal message reads it.
 *
 * Each basis is spelled in the vocabulary 002 FR-044 defines, so a login is
 * named with the provenance of its attribution and never as a claim that a
 * denied actor caused anything.
 *
 * The `subject-author` clause is the one string here that had to be re-cut at
 * 002 v1.12.0. It used to say *"a proxy, GitHub does not record who assigned or
 * requested"*, which was **false**: GitHub records both, in `assigner` and
 * `review_requester` on the item's own event list, and every row this service
 * writes now carries `direct` because of it. What a `subject-author` row still
 * needs an operator to know is narrower — *this login was whatever the rule in
 * force at write time could name* — and that stays true whatever GitHub supports
 * now, so the clause states the row's provenance and asserts nothing about the
 * provider.
 *
 * @param actors - Every denied login, in reference order.
 * @returns The comma-separated list.
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
 *
 * @param unreadableReferences - How many such references the run carries.
 * @returns The clause, honest in both directions.
 */
function unreadableNote(unreadableReferences: number): string {
    return unreadableReferences === 0
        ? 'every reference names a readable actor'
        : `${unreadableReferences} of this run's references name no readable actor`;
}

/**
 * The refusal one denied run leaves behind, whatever its message.
 *
 *
 * **One builder for both denials**, because the two facts they add to the
 * message are added by the same two lines and must never be added to one and
 * not the other:
 *
 * - the truncation clause, which rides **every** refusal message: an operator
 *   told to widen a list that cannot widen it has been told to do something
 *   useless, and FR-078's retry re-judges from the same truncated list anyway;
 *
 * - and the window as a **word** beside it, so the panel can tell this case
 *   from an ordinary one without a second parse of a sentence it is otherwise
 *   only obliged to copy.
 *
 * @param input - The run, the policy in force, the message, and the run's
 *   classified actors.
 * @returns The refusal, carrying FR-077's detail set and the judged window.
 */
function deniedPolicyRefusal(input: {
    /** The run being authorized. */
    readonly run: Run;
    /** The shape the read found. */
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
 * Judge one run's actor policy (003 FR-076 – FR-080; plan D14).
 *
 * An unreadable actor is refused **regardless** of the policy, so the
 * admitted case requires at least one reference that names a readable login the
 * list allows. Under an **open** policy every readable login is allowed, so the
 * admitted condition reduces to "some reference names a readable actor" — and a
 * run with no readable actor at all is refused under either policy.
 *
 * The quantifier reads `sourceReferences` and nothing else, so a **truncated**
 * list is judged as though the dropped references did not exist — see the
 * module's fourth bullet. Every refusal this returns carries that fact in its
 * message, in its detail set, and as a word on the wire, so neither the caller
 * nor the panel has to guess whether the list it judged was the whole history.
 *
 * Pure: the caller owns the store read and the write, so the same
 * predicate can re-judge a `blocked:actor-not-allowed` run against a live read on
 * the retry path — which is what makes "a run cannot be
 * retried into a dispatch this gate would refuse again" a property rather than a
 * hope.
 *
 * @param input - The run, and the policy exactly as the live read found it.
 * @returns The shape in force, or the refusal carrying FR-077's detail set.
 */
export function judgeActorPolicy(input: {
    /** The run being authorized. */
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

/** Why the live policy could not be judged, when it could not be. */
export type UnreadablePolicyCause =
    /** `bindings.json` is absent, quarantined, or unreadable. */
    | 'document-unreadable'
    /** The document read cleanly and does not carry this run's binding. */
    | 'binding-absent';

/**
 * The gate's verdict when the policy could not be read at all (constitution II,
 * 002 FR-024; plan D15).
 *
 * **One code, not a new one.** A vocabulary addition is a compatibility tax
 * (`AGENTS.md` invariant 10, paid twice already), and this decision needs no new
 * one: an absent document, an unusable one, and a document that simply no longer
 * carries the binding leave the run in the same place and are repaired the same
 * way. What they are **not** the same is the operator's next action, so the
 * message names which of the three it was — "the allow-list for binding X could
 * not be read" is exactly the sentence an operator cannot act on, and pointing
 * somebody at a file that is perfectly readable is worse than saying nothing.
 *
 * `actorPolicy` is `null` rather than a guessed `'open'`, because there was no
 * policy to shape: the row says what it knows, which is that it knows nothing.
 * The **denial** members are omitted for the same reason — nothing was compared,
 * so there is no denial to record, and `[]` would read as *every actor was
 * refused* (constitution IV). The counts the run alone answers **are** recorded,
 * because they are facts about the run and not about a policy nobody read.
 *
 * @param run - The run being authorized.
 * @param cause - Which of the two unreadable-policy causes fired.
 * @returns The refusal, naming the cause without naming a login.
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

/** What {@link readLivePolicy} found: a policy to judge, or why there is none. */
export type LivePolicy =
    /** The binding's stored list, or `undefined` for an open policy. */
    | { readonly readable: true; readonly allowedUsers: readonly string[] | undefined }
    /** No policy could be judged, and why. */
    | { readonly readable: false; readonly cause: UnreadablePolicyCause };

/**
 * Read the binding's live allow-list, fail-closed (003 FR-076, plan D13/D15).
 *
 * Called **inside the one chain task**, so an operator's edit takes effect on the
 * next authorization with no re-scan, no restart, and **no cache**:
 * `ServiceStore` exposes no `stat`, so a cache invalidated only by
 * `writeBindings` would never see a hand edit — and a gate reading a stale policy
 * is worse than no gate at all. The **bindings write** joins that same chain
 * (see `routes/bindings.ts`), so an operator's tightening and this read cannot
 * interleave: a token is never minted against a list the operator has just
 * revoked.
 *
 * @param input - Open store, logger, and the binding the run dispatches through.
 * @returns The list to judge with `undefined` for an open policy, or the cause
 *   no policy could be judged.
 */
export async function readLivePolicy(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Binding the run names. */
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
