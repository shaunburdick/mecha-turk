/**
 * The bindings **read** path: file parsing, quarantine reporting, and the two
 * readers (004 FR-019, FR-051; plan C3).
 *
 * This lives beside [`bindings.ts`](./bindings.ts) rather than inside it for
 * one reason: the read path is where a stored document is *refused*. It has to
 * capture why, log it without echoing a byte of the value, and — for the
 * observed reader — funnel the document through the prompt-change chain. Those
 * are reading concerns; the write path never runs them.
 *
 * Three readers, and the differences between them are load-bearing:
 *
 * - {@link readBindingsUnobserved} is the plain read. The `PUT` route calls it
 *   **while holding** the prompt-observation chain, so it must not take that
 *   chain itself (plan D8: "the chain cannot self-deadlock").
 * - {@link readBindings} is the observation funnel the poll loop, the claim
 *   route, and the `GET` route all use: same bytes, plus one diff against the
 *   baseline so a prompt edited in the store file is recorded exactly once,
 *   with actor `service`.
 * - {@link readBindingsForAuthorization} answers a *different question*: not
 *   "what bindings does the operator have?" but "can this binding's actor
 *   policy be judged at all?". It is the one reader that keeps the difference
 *   between **no bindings** and **an unreadable document** visible, because the
 *   authorization gate denies on the second and cannot deny on the first for a
 *   reason it would have to invent (003 FR-076, FR-077, plan D15; constitution
 *   II: a policy that cannot be read is never permissive).
 */

import { BINDINGS_FILE } from './accounts/store.ts';
import { isRecord } from './json.ts';
import { parseBinding } from './bindings.ts';
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
 * Record the first refusal as the `field: remediation` line the log carries.
 *
 * @param note - Sink to fill once; later refusals do not overwrite the first.
 * @param issues - Every problem the parser found on that binding.
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
 * @param raw - Parsed file.
 * @param note - Sink the first field-level refusal is captured into, so the
 *   caller can log *why* the file was quarantined without ever logging a byte
 *   of what it held.
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
 *
 * @param input - Open store and logger.
 * @returns The bindings, or `[]` when the file is absent/unusable.
 */
export async function readBindingsUnobserved(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
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
            log.warn('stored bindings were unusable and have been set aside', {
                quarantinePath: result.quarantinePath,
                ...(note.reason !== null && { reason: note.reason }),
            });
        }

        return [];
    } catch (cause) {
        log.warn('bindings read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return [];
    }
}

/**
 * Read the stored bindings, best-effort, recording any prompt change the
 * document carries.
 *
 * A quarantined file is skipped rather than aborting the poll: the store logs
 * its quarantine path and the loop simply has nothing to scan this cycle. This
 * reader is also the **observation funnel** for a prompt edited outside the
 * panel — it runs inside the per-store prompt chain, so a hand edit is
 * recorded exactly once, by whoever actually made it.
 *
 * @param input - Open store and logger.
 * @returns The bindings, or `[]` when the file is absent/unusable.
 */
export async function readBindings(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
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
 * D13/D15).
 *
 * **No prompt observation here.** This reader answers "may this run start a
 * session?", and the observation funnel exists to record a prompt edit exactly
 * once at the cadence the poll loop already gives it;
 * running it per authorization would put a second writer on that chain for a
 * decision that has nothing to do with prompts. The gate reads the live
 * document exactly as it stands at this instant, which is the point of D13:
 * **no cache**, because `ServiceStore` exposes no `stat`, so a cache invalidated
 * only by `writeBindings` would never see a hand edit — and a gate reading a
 * stale policy is worse than no gate.
 *
 * @param input - Open store and logger.
 * @returns The parsed bindings, or the `unreadable` verdict that denies.
 */
export async function readBindingsForAuthorization(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
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
            log.warn('stored bindings were unusable and have been set aside', {
                quarantinePath: result.quarantinePath,
                ...(note.reason !== null && { reason: note.reason }),
            });
        }

        return { readable: false };
    } catch (cause) {
        log.warn('bindings read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return { readable: false };
    }
}
