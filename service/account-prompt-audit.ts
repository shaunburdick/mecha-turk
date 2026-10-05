/**
 * The **account-tier** prompt observer (004 FR-088, plan N8).
 *
 * An account's `startingPrompt` can change on two paths that must never both
 * record it: the account profile write (`PUT /v1/accounts/:numericUserId`) and
 * a hand edit of `accounts/<id>.json` that a later read notices. This module
 * gives the account tier the same lane the binding tier already has — a
 * per-store chain plus a trail-seeded baseline — with its own event vocabulary
 * and its own details shape, so the two lanes cannot be confused:
 *
 * - **one chain per store handle**: every baseline seed, every diff, and the
 *   profile write's read → write → diff sequence run as tasks on the same
 *   chain, so a read observation racing a write cannot interleave with it and
 *   SC-125's "exactly one row per change" is a property of serialisation;
 * - **one baseline per store handle**, seeded once from the trail itself (the
 *   highest-`seq` `account.prompt-updated` row per account) so
 *   `previousFingerprint` survives a restart without a new store file and a
 *   trimmed trail honestly yields `null`;
 * - **the baseline advances even when an append fails** — 003 FR-063's
 *   posture: state stands, the failure is logged as a `warn` naming the
 *   account and the fingerprint (never the text), and nothing rolls back.
 *
 * The row carries the account, presence, fingerprint, length, the previous
 * fingerprint, and the actor — and **never the prompt's text** (004 FR-053,
 * FR-088). A `displayName`-only change is not a tier change and never reaches
 * this lane: the label is not a prompt and 005 adds no event type.
 */

import { newCorrelationId } from '../src/ids.ts';
import { AUDIT_FILE, appendAudit, parseAuditEntry } from './audit.ts';
import { PROMPT_FINGERPRINT_PATTERN, promptTierOf } from './prompt.ts';
import type { TierPrompt } from './prompt.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/**
 * The one event type the account tier adds (004 `### Audit Vocabulary Delta`).
 *
 * The reserved `account.` prefix 003's data-model §4.2 already carries
 * (`account.verified`, `account.deleted`, …): no dispatch-lifecycle type is
 * added, renamed, or changed, and the row is a non-run row with its own
 * generated correlation id.
 */
export const ACCOUNT_PROMPT_UPDATED_EVENT = 'account.prompt-updated';

/** Who caused the change: `operator` through the write, `service` observed. */
export type AccountPromptActor = 'operator' | 'service';

/** The account members an observation reads. */
export interface ObservedAccount {
    /** GitHub numeric user id — the account the tier lives on. */
    readonly numericUserId: string;
    /** Its stored prompt, or `null`/absent when the tier is unset. */
    readonly startingPrompt?: string | null;
}

/** What one observation of the account custody carries. */
export interface AccountPromptObservation {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger for a failed append (account id and fingerprint only). */
    readonly log: ServiceLogger;
    /** The accounts this observation saw isPresent. */
    readonly accounts: readonly ObservedAccount[];
    /**
     * Ids whose record this observation proved **absent**. Their baselines are
     * forgotten, so a re-added account reads as a fresh `set` rather than as a
     * diff against a tier that died with the old record.
     */
    readonly absent?: readonly string[];
    /**
     * `true` when {@link accounts} is the whole custody directory (a list
     * read), so every baseline id not isPresent here is forgotten on the same
     * rule as `absent`. Single-account reads and the profile write leave other
     * accounts' baselines alone.
     */
    readonly complete?: boolean;
    /** Who made the changes this observation carries. */
    readonly actor: AccountPromptActor;
}

/** Per-store observation state, created on first use. */
interface AccountPromptObservationState {
    /** `numericUserId` → the fingerprint the last recorded change produced. */
    readonly baseline: Map<string, string | null>;
    /** Whether the baseline has been seeded from the trail for this handle. */
    seeded: boolean;
    /** The task queue every read/write/diff of an account joins. */
    chain: Promise<unknown>;
}

/** One state per store handle: a restart re-seeds, a shared handle shares. */
const observationStates = new WeakMap<ServiceStore, AccountPromptObservationState>();

/**
 * Get (or create) the observation state for one store handle.
 *
 * @returns The handle's baseline and chain.
 */
function stateFor(store: ServiceStore): AccountPromptObservationState {
    let state = observationStates.get(store);
    if (state === undefined) {
        state = { baseline: new Map(), seeded: false, chain: Promise.resolve() };
        observationStates.set(store, state);
    }

    return state;
}

/**
 * Seed the baseline from the audit trail: highest-`seq` row per account.
 *
 * @param store - Open store holding `audit.ndjson`.
 * @param baseline - The map to fill (empty on first use for this handle).
 * @throws {StorageUnavailableError} When the trail cannot be read — a chain
 *   that cannot establish its baseline must not start guessing at diffs.
 */
async function seedBaseline(store: ServiceStore, baseline: Map<string, string | null>): Promise<void> {
    const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
    const highest = new Map<string, { readonly seq: number; readonly fingerprint: string | null }>();
    for (const entry of trail.entries) {
        if (entry.eventType !== ACCOUNT_PROMPT_UPDATED_EVENT || entry.entity.kind !== 'account') {
            continue;
        }

        // The account is the row's entity, not a details key: the details
        // shape is exactly the four prompt scalars the contract fixes.
        const { id: numericUserId } = entry.entity;
        // Only a value that already carries the `mtp-` shape is trusted (the
        // same rule `config-audit.ts` applies to its own trail seed). This
        // value becomes the lane's baseline, and a baseline is written back
        // into a later row as `previousFingerprint` — so anything that is not
        // a fingerprint (text a row should never have carried, a number, an
        // object) would otherwise be echoed forward into a new row. Reading it
        // as `null` keeps 004 FR-053's never-the-text rule in force on the
        // **read** side too.
        const recorded = entry.details.promptFingerprint;
        const fingerprint =
            typeof recorded === 'string' &&
            entry.details.promptPresent === true &&
            PROMPT_FINGERPRINT_PATTERN.test(recorded)
                ? recorded
                : null;
        const prior = highest.get(numericUserId);
        if (prior === undefined || entry.seq > prior.seq) {
            highest.set(numericUserId, { seq: entry.seq, fingerprint });
        }
    }

    for (const [numericUserId, value] of highest) {
        baseline.set(numericUserId, value.fingerprint);
    }
}

/**
 * Run one task inside the observation chain, seeding the baseline first.
 *
 * The chain promise stored in the state always **resolves**, so a failed task
 * rejects for its own caller without wedging the next one — the same shape the
 * bindings lane's chain uses, deliberately: two chains, one discipline.
 *
 * @param task - The read/write/diff work to serialise.
 * @returns The task's result or rejection, exactly as the task produced it.
 * @throws {StorageUnavailableError} When the baseline cannot be seeded.
 */
export async function runAccountPromptChain<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    const state = stateFor(store);
    const start = async (): Promise<T> => {
        if (!state.seeded) {
            await seedBaseline(store, state.baseline);
            state.seeded = true;
        }

        return await task();
    };
    // Both handlers are the same continuation: a rejected predecessor must not
    // stop the next task.
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs start on its own rejection; this runs once.
    const run = state.chain.then(start, start);
    state.chain = run;

    return await run;
}

/** What one account prompt-change row records (004 FR-088; data-model §7.2). */
export interface AccountPromptChange {
    /** Open store whose audit trail this row joins. */
    readonly store: ServiceStore;
    /** Account whose prompt changed. */
    readonly numericUserId: string;
    /** The prompt **after** the change, or `null` when it was cleared. */
    readonly current: TierPrompt | null;
    /** The fingerprint the previous row for this account recorded, else `null`. */
    readonly previousFingerprint: string | null;
    /** Who actually made the change, never claimed for anyone else. */
    readonly actor: AccountPromptActor;
}

/**
 * Append exactly one `account.prompt-updated` row.
 *
 * The decision is derived from the two fingerprints rather than passed in, so
 * the vocabulary (`set` | `changed` | `cleared`) cannot drift from what the
 * baseline says happened.
 *
 * @param input - The account, both fingerprints, and the actor.
 * @throws {StorageUnavailableError} When the append fails; the caller decides
 *   whether that rolls anything back (it never does — see the module header).
 */
export async function appendAccountPromptChange(input: AccountPromptChange): Promise<void> {
    const isPresent = input.current !== null;
    let decision: string;
    if (input.current === null) {
        decision = 'cleared';
    } else {
        decision = input.previousFingerprint === null ? 'set' : 'changed';
    }

    await appendAudit(input.store, {
        eventType: ACCOUNT_PROMPT_UPDATED_EVENT,
        actorSource: input.actor,
        entity: { kind: 'account', id: input.numericUserId },
        correlationId: newCorrelationId(),
        decision,
        reason: null,
        details: {
            promptPresent: isPresent,
            promptFingerprint: input.current?.fingerprint ?? null,
            // Data-model §4.1 types this `number`: an absent prompt is zero
            // characters of instruction, which is a length rather than a hole.
            promptLength: input.current?.length ?? 0,
            previousFingerprint: input.previousFingerprint,
        },
    });
}

/**
 * Append one difference's row, or log its failure and count nothing.
 *
 * @param context - The observation, the account, its snapshot, and both fingerprints.
 * @returns `1` when the row reached the trail, `0` when the append failed.
 */
async function recordOneChange(context: {
    /** The observation this difference belongs to. */
    readonly input: AccountPromptObservation;
    /** Account whose prompt differs from the baseline. */
    readonly account: ObservedAccount;
    /** Its snapshot, or `null` when the prompt is unset. */
    readonly snapshot: TierPrompt | null;
    /** The fingerprint the snapshot carries, or `null`. */
    readonly current: string | null;
    /** The fingerprint the baseline held, or `null`. */
    readonly previous: string | null;
}): Promise<number> {
    const { input, account, snapshot, current, previous } = context;
    try {
        await appendAccountPromptChange({
            store: input.store,
            numericUserId: account.numericUserId,
            current: snapshot,
            previousFingerprint: previous,
            actor: input.actor,
        });

        return 1;
    } catch (cause) {
        input.log.warn('account prompt change audit row could not be appended', {
            numericUserId: account.numericUserId,
            promptFingerprint: current,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return 0;
    }
}

/**
 * Diff the observed accounts against the baseline and record the differences.
 *
 * **Must run inside {@link runAccountPromptChain}** — the baseline it reads and
 * writes is only safe while no other observation can interleave with it.
 *
 * @param input - The accounts seen, the ids proved absent, the actor, the logger.
 * @returns How many rows this observation appended.
 */
export async function recordAccountPromptChanges(input: AccountPromptObservation): Promise<number> {
    const state = stateFor(input.store);
    const observed = new Set<string>();
    let rows = 0;

    for (const account of input.accounts) {
        observed.add(account.numericUserId);
        const snapshot = promptTierOf(account);
        const current = snapshot === null ? null : snapshot.fingerprint;
        const previous = state.baseline.get(account.numericUserId) ?? null;
        // Advance first: an append that fails must not re-report the same
        // change on every later read (003 FR-063's posture, plan D8).
        state.baseline.set(account.numericUserId, current);
        if (previous === current) {
            continue;
        }

        rows += await recordOneChange({ input, account, snapshot, current, previous });
    }

    const absent = input.absent ?? [];
    for (const numericUserId of absent) {
        state.baseline.delete(numericUserId);
    }

    if (input.complete === true) {
        // Deleting the current entry mid-iteration is well defined for a
        // `Map`'s own key iterator, which is why no snapshot copy is needed.
        for (const numericUserId of state.baseline.keys()) {
            if (!observed.has(numericUserId)) {
                state.baseline.delete(numericUserId);
            }
        }
    }

    return rows;
}

/**
 * Observe the accounts on the chain: seed, diff, record, advance.
 *
 * This is the entry point the observed read funnels (`readAccount`,
 * `listAccounts`) call with actor `service`, so a prompt edited outside the
 * panel is recorded by whoever the service could actually attribute the change
 * to.
 *
 * @param input - The accounts seen, the ids proved absent, the actor, the logger.
 * @returns How many rows this observation appended.
 */
export async function observeAccountPromptChanges(input: AccountPromptObservation): Promise<number> {
    return await runAccountPromptChain(input.store, async () => await recordAccountPromptChanges(input));
}
