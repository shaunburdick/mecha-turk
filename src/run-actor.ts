/**
 * The actor members a runs-history row carries: two closed vocabularies, absentable and validated (FR-043/044).
 */

/** How one delivery's actor was attributed (002 FR-044); the closed union. */
export type ActorAttribution = 'direct' | 'subject-author';

/**
 * The **shape** of the binding's allow-list at authorization (003 FR-079).
 *
 * Two words, never the logins.
 */
export type ActorPolicy = 'open' | 'restricted';

const ACTOR_ATTRIBUTIONS: ReadonlySet<string> = new Set(['direct', 'subject-author']);

/**
 * The two actor members a reference may carry, as the panel holds them.
 *
 * Both optional because both are absentable on read — absence means *no
 * attribution was recorded*, a third thing that is neither an empty login nor a
 * guessed basis.
 */
export interface ActorFields {
    readonly actorLogin?: string;
    /**
     * How it was attributed. `'subject-author'` is a **legacy basis**: an
     * earlier build attributed the list feeds to the issue or pull-request
     * author because they named no actor, and GitHub records both, so no row
     * written now carries it — but on-disk rows do, and a surface that refused
     * or re-worded one would hide a whole dispatch (005 FR-019). It renders as
     * what it is: the rule that was in force when the row was written.
     */
    readonly actorAttribution?: ActorAttribution;
}

/**
 * Read a reference's two actor members, omitting the ones the row lacks.
 *
 * @returns The members present, or `null` when a present one is unusable.
 */
export function actorFieldsOf(record: Record<string, unknown>): ActorFields | null {
    const { actorLogin, actorAttribution } = record;
    const isLoginOk = actorLogin === undefined || (typeof actorLogin === 'string' && actorLogin !== '');
    const isBasisOk = actorAttribution === undefined
        || (typeof actorAttribution === 'string' && ACTOR_ATTRIBUTIONS.has(actorAttribution));
    if (!isLoginOk || !isBasisOk) {
        return null;
    }

    return {
        ...(typeof actorLogin === 'string' && { actorLogin }),
        ...(typeof actorAttribution === 'string' && { actorAttribution: actorAttribution as ActorAttribution }),
    };
}

/**
 * Read a member that **must** carry a policy shape, refusing absent and
 * unknown. {@link readActorPolicy} answers the *run* row's question, where
 * `null` is a real state ("no authorization has been recorded yet"); a
 * **status** row has no such state — the service derives the shape on every
 * projection (005 FR-093, contract `status-projection.md` §8), so an absent or
 * unrecognized member is a body this build must not half-read. This stricter
 * reader exists so NFR-113's rule — no surface may imply a control the service
 * never reported — is enforced at the parser rather than the renderer.
 */
export function readRequiredActorPolicy(raw: unknown): ActorPolicy | null {
    return raw === 'open' || raw === 'restricted' ? raw : null;
}

/**
 * The panel's own words for a **legacy** `subject-author` attribution (002
 * FR-044 as re-cut; NFR-011; 005 FR-094 as re-cut). The sentence it used to
 * carry was **false** — it claimed GitHub does not record who assigned or
 * requested the review; GitHub records both and the service reads them, so
 * every row written now is `direct` and this clause is a compatibility
 * rendering rather than a live surface. It therefore says what is still true:
 * **this login is whoever the rule in force when the row was written could
 * name** — a statement about provenance that never presents a corrected rule
 * as though it had always been the one in force (002 NFR-011).
 */
export const SUBJECT_AUTHOR_BASIS =
    'the issue or pull-request author, attributed under the rule in force when this row was written';

/**
 * Name one reference's actor, and its basis where attribution's provenance
 * needs one (005 FR-094 as re-cut). Three states, none of them a guess:
 * **`direct`** — the login **alone**, with no basis clause by rule (a
 * qualification that applies to every row teaches operators to stop reading the
 * ones that matter); **`subject-author`** — the login plus
 * {@link SUBJECT_AUTHOR_BASIS}; **absent** — *actor not recorded*, named rather
 * than filled in, because a plausible login there would record an inference as
 * a fact. Every reference gets its **own** phrase, because a coalesced run can
 * carry a person outside the binding's policy and that has to stay visible.
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

export type PolicyRead =
    | { readonly usable: true; readonly policy: ActorPolicy | null }
    /** A word this build does not know; the row refuses (AGENTS invariant 8). */
    | { readonly usable: false };

/**
 * Read the snapshotted allow-list shape, refusing anything unrecognized:
 * fail-closed like every other member — a policy word from a future build must
 * not render as one this build would mis-tint, and `null` is the documented
 * *no authorization recorded* rather than a default of `'open'`.
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
