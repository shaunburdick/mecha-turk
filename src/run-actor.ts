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
 */

/** How one delivery's actor was attributed (002 FR-044); the closed union. */
export type ActorAttribution = 'direct' | 'subject-author';

/**
 * The **shape** of the binding's allow-list at authorization (003 FR-079).
 *
 * Two words, never the logins (002 NFR-113).
 */
export type ActorPolicy = 'open' | 'restricted';

/** Attribution bases a stored reference may carry (002 FR-044), and nothing else. */
const ACTOR_ATTRIBUTIONS: ReadonlySet<string> = new Set(['direct', 'subject-author']);

/**
 * The two actor members a reference may carry, as the panel holds them.
 *
 * Both optional because both are absentable on read — absence means *no
 * attribution was recorded*, a third thing that is neither an empty login nor a
 * guessed basis.
 */
export interface ActorFields {
    /** The actor this delivery is attributed to (002 FR-043). */
    readonly actorLogin?: string;
    /**
     * How it was attributed (002 FR-044).
     *
     * `'subject-author'` is a **documented proxy**: GitHub records the issue or
     * pull-request author and does not record who assigned or requested, so a
     * surface rendering it must say so rather than present it as a fact.
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
 * *no authorization recorded* rather than a default of `'open'` (005 FR-093).
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
