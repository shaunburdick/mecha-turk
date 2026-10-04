/**
 * Attribution: **who** a delivery is attributed to, and **on what basis.**
 *
 * One concept with two sides, kept together because either alone is unreadable.
 * The **detection side** decides whether an entry may be attributed at all and
 * bounds the login a row may carry; the **stored side** holds the vocabulary the
 * row is read back with. Split across two modules, a reader would have to hold
 * both in their head to answer *"is this proxy or a fact?"* — which is precisely
 * the question 002 NFR-011 exists to keep honest.
 *
 * What *follows* from an attribution is not here: whether an attributed actor may
 * start a session under a binding's allow-list belongs to the authorization gate
 * in `dispatch-actor-gate.ts`, the only caller of the membership comparison in
 * `service/bindings-allow-list.ts`.
 *
 * Four properties are load-bearing and are stated once, here:
 *
 * - **The basis is closed, and an unrecognized value refuses the row.** There is
 *   no third member and no default: defaulting would record an inference as a
 *   fact. `direct` means GitHub named the identity that **performed the act**, and
 *   that is the basis for **all four** trigger kinds — the author of the text for
 *   the two mention kinds, and the `assigner` of the naming `assigned` event and
 *   the `review_requester` of the naming `review_requested` event, both read from
 *   the item's own event list (`poller-events.ts`). `subject-author` is
 *   **readable and unproduced**: rows this product wrote before GitHub's actor
 *   fields were read carry it in `events.json`, and a vocabulary a stored file
 *   still holds cannot be deleted without invalidating that file. Nothing writes
 *   it now.
 * - **Attribution is mandatory, and the exclusion is fail-closed.** A bot or an
 *   unreadable author is dropped as non-actionable at detection, never enqueued
 *   with an empty actor for a later gate to guess about. The same two judgements
 *   apply to the actor the **event** names, which is what makes a `null`
 *   `assigner` a refusal rather than a prompt to reach for the row's `actor`
 *   member, the issue author, or the `assignee`.
 * - **Both stored members are absentable, and validated when present.** The queue
 *   file outlives the build that wrote it, so a row enqueued before this feature
 *   carries neither and must still parse — requiring them would quarantine every
 *   pre-existing row, which is a migration by side effect and exactly what the
 *   product owner ruled out. Absence reads as *no attribution was recorded*, a
 *   third thing that never silently becomes either member of the union. The
 *   fail-closed duty lands at the gate instead, which refuses a run whose
 *   references name no readable actor rather than reading absence as permission.
 * - **One bound for the login, wherever it is used**, so the actor and the
 *   trigger note can never disagree about how long it may be.
 *
 * Requirements: 002 FR-043 – FR-045, NFR-011, research §R8 as rewritten.
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
 *
 * @param authorLogin - Author's login.
 * @param authorType - Author type (`User`, `Bot`, …), `''` when absent.
 * @returns `true` when the author is a bot.
 */
export function isBotAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin.toLowerCase().endsWith('[bot]') || authorType.toLowerCase() === 'bot';
}

/**
 * Decide whether one author's text may be attributed to a detection at all.
 *
 * One predicate for **all four** trigger kinds (002 FR-045, plan D3): the two
 * judgements this product already applied to mention authorship, applied
 * unchanged rather than reinvented. Bots are noise (they mention each other for
 * a living), and an author GitHub would not name (`authorLogin === ''`) is
 * ambiguous, so both fail closed (spec FR-016, FR-024).
 *
 * Exported because the assignment path in `loop.ts` needs the same judgement
 * for the same reason, and two spellings of one rule are two rules that drift.
 *
 * @param authorLogin - Author's login, `''` when GitHub sent no `user`.
 * @param authorType - Author type (`User`, `Bot`, …), `''` when absent.
 * @returns `true` only for a readable, non-bot author.
 */
export function isAttributableAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin !== '' && !isBotAuthor(authorLogin, authorType);
}

/**
 * Bound one attributed login to the length a row may carry.
 *
 * @param authorLogin - The login the feed reported.
 * @returns The bounded login.
 */
export function actorLoginOf(authorLogin: string): string {
    return authorLogin.slice(0, AUTHOR_LOGIN_MAX_CHARS);
}

/**
 * How one delivery's actor was attributed (002 FR-044).
 *
 * The union is closed and stays closed — an unrecognized basis refuses the row
 * rather than defaulting to a guess (002 FR-024) — and the distinction is
 * load-bearing, because it is the difference between a record and an inference:
 *
 * - `direct` — GitHub named the identity that **performed the act**: the author
 *   of the text for a comment or issue-body mention, and, since v1.12.0, the
 *   `assigner` of the naming `assigned` event and the `review_requester` of the
 *   naming `review_requested` event. This is the **only** basis any row written
 *   now carries, for all four kinds.
 * - `subject-author` — a **legacy** basis, and no longer produced. It stood the
 *   issue or pull-request author in for an actor the two *list* feeds could not
 *   name. It is still read, because the rows this product wrote before v1.12.0
 *   carry it and a refused row is a hidden dispatch; it is written by nothing.
 *
 * Every surface that names an actor must honour this basis beside it and must
 * never present an inference as a fact (002 NFR-011) — and, after v1.12.0, must
 * never claim GitHub fails to record the actor, because it does.
 */
export type ActorAttribution = 'direct' | 'subject-author';

/** Attribution bases a stored row may carry (002 FR-044), and nothing else. */
const ACTOR_ATTRIBUTIONS: ReadonlySet<string> = new Set(['direct', 'subject-author']);

/**
 * Read the attributed login one stored row carries (002 FR-043).
 *
 * Absentable, and validated when present the same way {@link
 * readActorAttributionField} validates its sibling: a non-text value, or an
 * empty string, refuses the row. An empty actor is not a legal record — a
 * detection that could not name an author never becomes a row (002 FR-045(b)) —
 * so the only way to reach one is a hand edit, and a hand edit is refused.
 *
 * @param record - Parsed candidate row.
 * @returns `undefined` when the row carries no actor, the login, or `null`
 *   when the value is not usable text.
 */
export function readActorLoginField(record: Record<string, unknown>): string | undefined | null {
    const value = record.actorLogin;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the attribution basis one stored row carries (002 FR-044).
 *
 * Absentable — a row written before this member existed predates the feature
 * and reads as *no attribution recorded*, which is a third thing rather than
 * either member of the union. **Validated when present**: an unrecognized
 * basis refuses the row instead of defaulting (002 FR-024, plan D2).
 *
 * @param record - Parsed candidate row.
 * @returns `undefined` when the row carries no basis, the basis, or `null`
 *   when the value is from another vocabulary.
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
    /** The login this delivery is attributed to (002 FR-043). */
    readonly actorLogin?: string;
    /** How that attribution was made (002 FR-044). */
    readonly actorAttribution?: ActorAttribution;
}

/**
 * Read the actor members a row carries, omitting the ones it does not.
 *
 * A row written before 002 v1.11.0 carries neither and keeps neither: the
 * parser never fills in a value the file did not hold, because inventing a
 * basis would record an inference as a fact (002 FR-044, NFR-011). `null` is
 * typed out here rather than asserted away because the caller has already
 * refused a row whose members it could not read.
 *
 * @param record - Parsed candidate row, already validated.
 * @returns The actor fields present on this row.
 */
export function actorFieldsOf(record: Record<string, unknown>): ActorFields {
    const actorLogin = readActorLoginField(record);
    const actorAttribution = readActorAttributionField(record);

    return {
        ...(actorLogin === undefined || actorLogin === null ? {} : { actorLogin }),
        ...(actorAttribution === undefined || actorAttribution === null ? {} : { actorAttribution }),
    };
}
