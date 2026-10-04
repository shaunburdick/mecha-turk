/**
 * The actor members a runs-history row carries (002 FR-043, FR-044; 003 FR-079).
 *
 * A fourth reference beside the state words in
 * [`run-state.ts`](./run-state.ts) — the one place the panel holds the two
 * *closed vocabularies* this feature adds, and the one place that reads them
 * off the wire. Split out of [`dispatches-service.ts`](./dispatches-service.ts)
 * for the file-length gate, and because the alternative was a policy word and an
 * attribution basis living in a module about *rows*.
 *
 * Two properties these readers hold, and each is a decision rather than a
 * default:
 *
 * - **Both members are absentable, and validated when present.** A run stored
 *   before attribution existed carries neither and must still parse: a
 *   runs-history row the panel refuses would hide an *entire* dispatch, which is
 *   a far worse lie than one reference rendering as *no attribution recorded*.
 *   A member that **is** present must be usable — an unrecognized basis refuses
 *   the row rather than defaulting, because defaulting would record an
 *   inference as a fact (002 FR-024, NFR-011).
 * - **The panel computes no policy verdict.** `actorPolicy` is the **shape** the
 *   service snapshotted at authorization (003 FR-079), and `null` is *no
 *   authorization recorded yet* — never a default of `'open'`, which would be the
 *   panel deciding a binding's policy on the service's behalf (005 FR-093).
 *
 * What this module deliberately **cannot** do is read a permitted login: the
 * permitted set's home is `bindings.json`, and a panel that rendered a copy of
 * it would be a second index of the access policy (002 NFR-113, 005 FR-091).
 *
 * It also owns the **one rendering** of those two vocabularies,
 * {@link actorPhrase}, because the dispatch row and its reveal both name an
 * actor and — for a legacy row — its basis: two copies of that sentence is two
 * chances for the panel to misdescribe one reference (005 FR-094).
 */

/** How one delivery's actor was attributed (002 FR-044); the closed union. */
export type ActorAttribution = 'direct' | 'subject-author';

/**
 * The **shape** of the binding's allow-list at authorization (003 FR-079).
 *
 * Two words, never the logins.
 */
export type ActorPolicy = 'open' | 'restricted';

/** Attribution bases a stored reference may carry, and nothing else. */
const ACTOR_ATTRIBUTIONS: ReadonlySet<string> = new Set(['direct', 'subject-author']);

/**
 * The two actor members a reference may carry, as the panel holds them.
 *
 * Both optional because both are absentable on read — absence means *no
 * attribution was recorded*, a third thing that is neither an empty login nor a
 * guessed basis.
 */
export interface ActorFields {
    /** The actor this delivery is attributed to. */
    readonly actorLogin?: string;
    /**
     * How it was attributed.
     *
     * `'subject-author'` is a **legacy basis**: an earlier build attributed
     * assignment and review triggers to the issue or pull-request author because
     * the two *list* feeds named no actor. GitHub does record both, so no row
     * written now carries it — but rows already on disk do, and a surface that
     * refused or silently re-worded one would hide a whole dispatch (005
     * FR-019). It renders as what it is: the rule that was in force when the row
     * was written.
     */
    readonly actorAttribution?: ActorAttribution;
}

/**
 * Read a reference's two actor members, omitting the ones the row lacks.
 *
 * @param record - The parsed reference, read as an untrusted record.
 * @returns The members present, or `null` when a present one is unusable.
 */
export function actorFieldsOf(record: Record<string, unknown>): ActorFields | null {
    const { actorLogin, actorAttribution } = record;
    const loginOk = actorLogin === undefined || (typeof actorLogin === 'string' && actorLogin !== '');
    const basisOk = actorAttribution === undefined
        || (typeof actorAttribution === 'string' && ACTOR_ATTRIBUTIONS.has(actorAttribution));
    if (!loginOk || !basisOk) {
        return null;
    }

    return {
        ...(typeof actorLogin === 'string' ? { actorLogin } : {}),
        ...(typeof actorAttribution === 'string' ? { actorAttribution: actorAttribution as ActorAttribution } : {}),
    };
}

/**
 * Read a member that **must** carry a policy shape, refusing absent and unknown.
 *
 * {@link readActorPolicy} answers the *run* row's question, where `null` is a
 * real state ("no authorization has been recorded yet"). A **status** row has
 * no such state: the service derives the shape from the binding every time it
 * projects the document (005 FR-093, contract `status-projection.md` §8), so an
 * absent or unrecognized member is a body this build must not half-read. This is
 * the stricter of the two readers, and it exists so NFR-113's rule — that no
 * surface may imply a control the service never reported — is enforced at the
 * parser rather than left to the renderer.
 *
 * @param raw - The `actorPolicy` member as received.
 * @returns The shape, or `null` when the member is absent or outside the union.
 */
export function readRequiredActorPolicy(raw: unknown): ActorPolicy | null {
    return raw === 'open' || raw === 'restricted' ? raw : null;
}

/**
 * The panel's own words for a **legacy** `subject-author` attribution
 * (002 FR-044 as re-cut; NFR-011; 005 FR-094 as re-cut).
 *
 * This clause reached only rows written **before** 002 v1.12.0, and it had to
 * be re-cut rather than re-worded, because the sentence it used to carry was
 * **false**: it told the operator that *"GitHub does not record who assigned it
 * or requested the review"*. GitHub records both — `assigner` on the `assigned`
 * event, `review_requester` on the `review_requested` event — and the service
 * reads them, so every row written now is `direct` and this clause is a
 * compatibility rendering rather than a live surface.
 *
 * So it says the one thing that is still true and still useful: **this login is
 * whoever the rule in force when the row was written could name** — which is a
 * statement about the row's provenance, holds whatever GitHub supports today,
 * and does not make the panel argue with the record in front of it. A panel that
 * claims the row is wrong is as misleading as one that claims the rule was
 * always right (002 NFR-011: never present a corrected rule as though it had
 * always been the one in force).
 */
export const SUBJECT_AUTHOR_BASIS =
    'the issue or pull-request author, attributed under the rule in force when this row was written';

/**
 * Name one reference's actor, and its basis where the attribution's provenance
 * needs one (005 FR-094 as re-cut).
 *
 * Three states, none of them a guess:
 *
 * - **`direct`** — GitHub named the identity that performed the act: the login
 *   **alone**. No basis clause is rendered, and that is the rule rather than an
 *   omission: there is nothing to qualify, and a qualification that applies to
 *   every row teaches an operator to stop reading the ones that matter.
 * - **`subject-author`** — a legacy row, rendered as one: the login plus
 *   {@link SUBJECT_AUTHOR_BASIS}.
 * - **Absent** — *actor not recorded*, which is a run stored before attribution
 *   existed. It is named rather than filled in, because printing a plausible
 *   login there would record an inference as a fact.
 *
 * Every reference gets its **own** phrase, because a coalesced run carries
 * several and a person outside the binding's policy can ride in on a run an
 * allowed actor authorized — which is exactly what has to stay visible.
 *
 * @param actor - One reference's two actor members, as the panel holds them.
 * @returns The clause naming the actor, and the basis for a legacy row.
 */
export function actorPhrase(actor: ActorFields): string {
    if (actor.actorLogin === undefined) {
        return 'actor not recorded';
    }

    if (actor.actorAttribution !== 'subject-author') {
        return `actor ${actor.actorLogin}`;
    }

    return `actor ${actor.actorLogin} — attributed to ${SUBJECT_AUTHOR_BASIS}`;
}

/** What reading one row's policy shape found. */
export type PolicyRead =
    /** The shape, or `null` for *no authorization recorded yet*. */
    | { readonly usable: true; readonly policy: ActorPolicy | null }
    /** A word this build does not know; the row refuses (AGENTS invariant 8). */
    | { readonly usable: false };

/**
 * Read the snapshotted allow-list shape, refusing anything unrecognized.
 *
 * Fail-closed like every other member: a policy word from a future build must
 * not render as one this build would mis-tint, and `null` is the documented
 * *no authorization recorded* rather than a default of `'open'`.
 *
 * @param record - The parsed row, read as an untrusted record.
 * @returns The read, marked unusable for a value outside the closed union.
 */
export function readActorPolicy(record: Record<string, unknown>): PolicyRead {
    const { actorPolicy } = record;
    if (actorPolicy === null || actorPolicy === undefined) {
        return { usable: true, policy: null };
    }

    return actorPolicy === 'open' || actorPolicy === 'restricted'
        ? { usable: true, policy: actorPolicy }
        : { usable: false };
}
