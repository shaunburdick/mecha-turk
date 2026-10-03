/**
 * The three sentinels SC-105 / AC-123 count (005 v1.9.0's re-cut of the rule;
 * 004 FR-089).
 *
 * One fixture module rather than three copies of the same strings: the gate
 * seeds a **global**, an **account**, and a **binding** prompt with exactly
 * these values, renders all six tabs, and requires each to be carried by
 * exactly one element — and the per-surface suites (Settings, Accounts) seed
 * the very value the gate counts, so a "once" proved per surface and a
 * "once" proved panel-wide cannot drift into different texts.
 *
 * The three are distinct and none is a substring of another, so a count can
 * never pick up a sibling tier's element by accident.
 *
 * Offline fixtures only: nothing here reads a host, a store, or a network
 * (004 FR-086).
 */

/** The global tier's value: the one only the Settings row may carry (006 FR-010). */
export const GLOBAL_TIER_SENTINEL = 'SC105-TIER-GLOBAL-a41c: the value only the Settings row may carry';

/** The account tier's value: the one only an Accounts field may carry (004 FR-082). */
export const ACCOUNT_TIER_SENTINEL = 'SC105-TIER-ACCOUNT-b72e: the value only an Accounts field may carry';

/** The binding tier's value: the one only the binding editor may carry (005 FR-051). */
export const BINDING_TIER_SENTINEL = 'SC105-TIER-BINDING-c93d: the value only the binding editor may carry';
