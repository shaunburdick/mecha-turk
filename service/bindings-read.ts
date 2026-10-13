/**
 * The bindings read path: file parsing, quarantine reporting, and the two
 * readers (004 FR-019, FR-051; plan C3).
 */

import { BINDINGS_FILE } from './accounts/store.ts';
import { isRecord } from './json.ts';
import { parseBinding, storedStampOf } from './bindings.ts';
import { observeHistoryScopeChanges } from './history-scope-audit.ts';
import { observePromptChanges } from './prompt-audit.ts';
import type { BindingIssue, BindingRecord } from './bindings.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/** What a read records when it had to set the file aside. */
interface RefusalNote {
    /** First `field: remediation` the parser refused, or `null` when none was named. */
    reason: string | null;
}

/**
 * The two log messages three readers here share.
 *
 * Named once because the string is duplicated by each reader that reports a
 * quarantine or a failed read, and because the two messages carry a decision: a
 * quarantined file says *which* problem was refused in field-and-remediation terms
 * (which never echo a stored value, so the line cannot leak one), while a failed
 * read says only the error's **name** and never one word of its text (SEC-11).
 */
const BINDINGS_UNUSABLE = 'stored bindings were unusable and have been set aside';
const BINDINGS_READ_FAILED = 'bindings read failed';

/**
 * Record the first refusal as the `field: remediation` line the log carries.
 */
function noteFirstRefusal(note: RefusalNote, issues: readonly BindingIssue[]): void {
    const first = issues[0];
    if (first !== undefined && note.reason === null) {
        note.reason = `${first.field}: ${first.remediation}`;
    }
}

/**
 * Validate a whole bindings file, as the store's read path wants.
 *
 * @returns The bindings, or `null` to quarantine the file (never fail-stuck).
 */
function parseBindingsFile(raw: unknown, note: RefusalNote): BindingRecord[] | null {
    if (!Array.isArray(raw) || raw.some((entry) => !isRecord(entry))) {
        return null;
    }

    const bindings: BindingRecord[] = [];
    for (const entry of raw) {
        const verdict = parseBinding({ raw: entry, hasAccount: true });
        if ('issues' in verdict) {
            noteFirstRefusal(note, verdict.issues);
            return null;
        }

        bindings.push(verdict.binding);
    }

    return bindings;
}

/**
 * Read the stored bindings without running the prompt-change observer.
 *
 * This is the reader the chain-holding write path uses.
 */
export async function readBindingsUnobserved(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<BindingRecord[]> {
    const { store, log } = input;
    const note: RefusalNote = { reason: null };
    try {
        const result = await store.readJson(BINDINGS_FILE, (raw) => parseBindingsFile(raw, note));
        if (result.status === 'ok') {
            return result.value;
        }

        if (result.status === 'quarantined') {
            // The reason is field + remediation only: the refusal vocabulary
            // never echoes a value, so this line cannot leak one.
            log.warn(BINDINGS_UNUSABLE, {
                quarantinePath: result.quarantinePath,
                ...(note.reason !== null && { reason: note.reason }),
            });
        }

        return [];
    } catch (cause) {
        log.warn(BINDINGS_READ_FAILED, { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return [];
    }
}

/**
 * Read the stored bindings, best-effort, recording any prompt change the
 * document carries. A quarantined file is skipped rather than aborting the
 * poll: the store logs its quarantine path and the loop has nothing to scan
 * this cycle. This reader is also the **observation funnel** for a prompt
 * edited outside the panel — it runs inside the per-store prompt chain, so
 * a hand edit is recorded exactly once, by whoever actually made it.
 */
export async function readBindings(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<BindingRecord[]> {
    const bindings = await readBindingsUnobserved(input);
    // The observation runs *after* the read answered, on the per-store chain,
    // so a hand edit of the store file is recorded exactly once with the actor
    // that actually made it — `service`, because no panel asked for it (004
    // FR-051, plan C3). A failed append is logged and never blocks the read.
    await observePromptChanges({
        store: input.store,
        log: input.log,
        bindings,
        actor: 'service',
    });
    // The history scope's own observer, on **its own** chain over the same
    // handle (002 FR-086's third path — a hand edit of the stored mode). Two
    // observers for two fields rather than one chain doing both: each field's row
    // is written by the observer that owns that field, and a second chain reading
    // and diffing one document would reintroduce the interleaving that has
    // produced one-writer-two-readers bugs here twice (plan H12).
    await observeHistoryScopeChanges({
        store: input.store,
        log: input.log,
        bindings,
        actor: 'service',
    });

    return bindings;
}

/**
 * What the authorization read produced.
 *
 * The `unreadable` half is the whole point of a separate reader: every other
 * caller degrades an unusable document to "no bindings", which is the right
 * answer for a poll cycle and the wrong one for a gate — a policy that could
 * not be judged must be a **denial**, never an absent restriction that reads as
 * permission (constitution II).
 */
export type AuthorizationBindings =
    /** The document parsed; the binding may or may not be among these. */
    | { readonly readable: true; readonly bindings: readonly BindingRecord[] }
    /** The file is absent, quarantined, or unreadable — the policy cannot be judged. */
    | { readonly readable: false };

/**
 * Read the stored bindings for one authorization decision (003 FR-076, plan
 * D13/D15). **No prompt observation here**: the funnel exists to record a
 * prompt edit exactly once at the poll loop's cadence, and running it per
 * authorization would put a second writer on that chain for a decision that
 * has nothing to do with prompts. **No cache** either — `ServiceStore`
 * exposes no `stat`, so a cache invalidated only by `writeBindings` would
 * never see a hand edit, and a gate reading a stale policy is worse than no
 * gate.
 */
export async function readBindingsForAuthorization(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<AuthorizationBindings> {
    const { store, log } = input;
    const note: RefusalNote = { reason: null };
    try {
        const result = await store.readJson(BINDINGS_FILE, (raw) => parseBindingsFile(raw, note));
        if (result.status === 'ok') {
            return { readable: true, bindings: result.value };
        }

        if (result.status === 'quarantined') {
            // The reason is field + remediation only: the refusal vocabulary
            // never echoes a value, so this line cannot leak one.
            log.warn(BINDINGS_UNUSABLE, {
                quarantinePath: result.quarantinePath,
                ...(note.reason !== null && { reason: note.reason }),
            });
        }

        return { readable: false };
    } catch (cause) {
        log.warn(BINDINGS_READ_FAILED, { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return { readable: false };
    }
}

/**
 * What one binding's stored creation stamp says (002 FR-072; plan H3).
 *
 * A closed union of the three answers rather than a nullable string, because
 * "no stamp was stored" and "a stamp was stored and the clock cannot read it"
 * are different facts and a scan window's baseline treats them differently: the
 * first falls back to the row's assembled stamp, the second **refuses**.
 */
export type StoredCreationStamp =
    /** The row carries no creation stamp at all — a panel-created row legitimately has none. */
    | { readonly kind: 'absent' }
    /** The row carries one and the clock can read it. */
    | { readonly kind: 'stamp'; readonly at: string }
    /** The row carries one and the clock cannot read it (002 FR-072). */
    | { readonly kind: 'unreadable' };

/**
 * The answer a reader gives when it could not establish a row's stamp at all.
 *
 * `unreadable` rather than `absent` on purpose: an operator whose bindings file
 * cannot be read gets a binding that scans nothing and says so, never a baseline
 * silently computed from a clock reading (constitution II).
 */
const NOT_ESTABLISHED: StoredCreationStamp = { kind: 'unreadable' };

/**
 * Read one raw row's creation stamp into its three-state verdict.
 */
function creationStampOf(entry: Record<string, unknown>): StoredCreationStamp {
    const stored = storedStampOf(entry.createdAt);
    if (stored === null) {
        return { kind: 'absent' };
    }

    return stored === undefined ? { kind: 'unreadable' } : { kind: 'stamp', at: stored };
}

/**
 * Read the stored creation stamps of the bindings this cycle needs (002
 * FR-072) — a fourth reader over the same file and the narrowest: one
 * provenance question about the raw rows and nothing else. It parses neither
 * the records nor the history scope, because the answer has to survive the
 * assembly, which substitutes a clock reading for exactly the case FR-072
 * names. Called only in a cycle where some binding has no baseline yet, so
 * nothing in steady state pays for the extra read (plan H3, FR-064).
 */
export async function readStoredCreationStamps(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The bindings whose stamps this cycle needs. */
    readonly bindingIds: readonly string[];
}): Promise<ReadonlyMap<string, StoredCreationStamp>> {
    const answers = new Map<string, StoredCreationStamp>();
    if (input.bindingIds.length === 0) {
        return answers;
    }

    const fail = (): ReadonlyMap<string, StoredCreationStamp> => {
        for (const bindingId of input.bindingIds) {
            answers.set(bindingId, NOT_ESTABLISHED);
        }

        return answers;
    };

    try {
        const result = await input.store.readJson(BINDINGS_FILE, (raw) => {
            if (!Array.isArray(raw)) {
                return null;
            }

            const stamps = new Map<string, StoredCreationStamp>();
            for (const entry of raw) {
                if (!isRecord(entry) || typeof entry.bindingId !== 'string') {
                    continue;
                }

                stamps.set(entry.bindingId, creationStampOf(entry));
            }

            return stamps;
        });
        if (result.status === 'ok') {
            for (const bindingId of input.bindingIds) {
                answers.set(bindingId, result.value.get(bindingId) ?? NOT_ESTABLISHED);
            }

            return answers;
        }

        if (result.status === 'quarantined') {
            input.log.warn(BINDINGS_UNUSABLE, {
                quarantinePath: result.quarantinePath,
            });
        }
    } catch (cause) {
        input.log.warn(BINDINGS_READ_FAILED, {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }

    return fail();
}
