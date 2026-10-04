/**
 * Ascending text order, for putting two arrays of the same strings into a
 * comparable sequence.
 *
 * A no-arg `toSorted()` orders by UTF-16 code unit, which sorts every capital
 * before every lowercase letter — `Zoo` before `apple`. A test that builds two
 * lists independently and compares them wants the human order instead, which
 * is what a test failure otherwise reports as a mysterious mismatch.
 *
 * The array elements that may be `undefined` sort as the string `"undefined"`,
 * exactly as the no-arg comparator they replaced did, so a comparison against a
 * list with a hole still fails loudly rather than silently reordering.
 */
export function byText(left: string, right: string): number {
    return left.localeCompare(right);
}

/**
 * {@link byText} for a list that may hold holes, where the element type is
 * `string | undefined` because the member was read with an index.
 *
 * A hole sorts as the string `"undefined"`, which is what the no-arg comparator
 * this replaces did. The point is that a missing member still compares unequal
 * to a present one, so a test comparing two lists fails rather than passing on
 * two holes.
 */
export function byTextLoose(left: string | undefined, right: string | undefined): number {
    return String(left).localeCompare(String(right));
}
