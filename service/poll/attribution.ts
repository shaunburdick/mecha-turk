/**
 * Attribution: who a delivery is attributed to, and on what basis
 * (002 FR-043 – FR-045, NFR-011).
 */

/**
 * Longest author login one event carries, whether as its attributed actor or
 * inside a trigger note. Exported so the assignment path in `loop.ts` bounds the
 * same string with the same constant: a second bound for one field in two modules
 * would be two answers to one question.
 */
export const AUTHOR_LOGIN_MAX_CHARS = 60;

/**
 * Decide whether an author is a bot.
 *
 * GitHub marks its own accounts with a `[bot]` login suffix and reports
 * `type: 'Bot'` for the rest; either signal is enough. One predicate for all
 * three feeds, because `user` is where `type` lives on every one of them.
 */
export function isBotAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin.toLowerCase().endsWith('[bot]') || authorType.toLowerCase() === 'bot';
}

/**
 * Decide whether one author's text may be attributed to a detection at all.
 * One predicate for **all four** trigger kinds: bots are noise (they mention
 * each other for a living) and an author GitHub would not name
 * (`authorLogin === ''`) is ambiguous, so both fail closed (spec FR-016).
 * Exported because the assignment path in `loop.ts` needs the same judgement,
 * and two spellings of one rule are two rules that drift.
 */
export function isAttributableAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin !== '' && !isBotAuthor(authorLogin, authorType);
}

/**
 * Bound one attributed login to the length a row may carry.
 */
export function actorLoginOf(authorLogin: string): string {
    return authorLogin.slice(0, AUTHOR_LOGIN_MAX_CHARS);
}

/**
 * How one delivery's actor was attributed (002 FR-044). The union is closed
 * and stays closed: an unrecognized basis refuses the row rather than
 * defaulting to a guess. `direct` — GitHub named the identity that performed
 * the act — is the only basis any row written now carries, for all four
 * trigger kinds; `subject-author` is legacy and no longer produced, but still
 * read because the rows this product wrote carry it. Every surface that names
 * an actor honours the basis beside it and never presents an inference as a
 * fact, nor claims GitHub fails to record the actor.
 */
export type ActorAttribution = 'direct' | 'subject-author';

/** Attribution bases a stored row may carry, and nothing else. */
const ACTOR_ATTRIBUTIONS: ReadonlySet<string> = new Set(['direct', 'subject-author']);

/**
 * Read the attributed login one stored row carries.
 *
 * Absentable, and validated when present the same way {@link
 * readActorAttributionField} validates its sibling: a non-text value, or an
 * empty string, refuses the row. An empty actor is not a legal record — a
 * detection that could not name an author never becomes a row (002 FR-045(b)) —
 * so the only way to reach one is a hand edit, and a hand edit is refused.
 */
export function readActorLoginField(record: Record<string, unknown>): string | undefined | null {
    const value = record.actorLogin;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the attribution basis one stored row carries.
 *
 * Absentable — a row written before this member existed predates the feature
 * and reads as *no attribution recorded*, which is a third thing rather than
 * either member of the union. **Validated when present**: an unrecognized
 * basis refuses the row instead of defaulting.
 */
export function readActorAttributionField(record: Record<string, unknown>): ActorAttribution | undefined | null {
    const value = record.actorAttribution;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && ACTOR_ATTRIBUTIONS.has(value) ? (value as ActorAttribution) : null;
}

/** The actor members one row carries, when it carries them at all. */
export interface ActorFields {
    /** The login this delivery is attributed to. */
    readonly actorLogin?: string;
    /** How that attribution was made. */
    readonly actorAttribution?: ActorAttribution;
}

/**
 * Read the actor members a row carries, omitting the ones it does not.
 *
 * A row written carries neither and keeps neither: the
 * parser never fills in a value the file did not hold, because inventing a
 * basis would record an inference as a fact. `null` is
 * typed out here rather than asserted away because the caller has already
 * refused a row whose members it could not read.
 */
export function actorFieldsOf(record: Record<string, unknown>): ActorFields {
    const actorLogin = readActorLoginField(record);
    const actorAttribution = readActorAttributionField(record);

    return {
        ...(!(actorLogin === undefined || actorLogin === null) && { actorLogin }),
        ...(!(actorAttribution === undefined || actorAttribution === null) && { actorAttribution }),
    };
}
