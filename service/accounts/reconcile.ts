/**
 * Startup reconciliation for accounts left mid-handoff by a crash (F13,
 * contract §5/SEC-05).
 */

import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import type { GitHubVerifier, VerifyOutcome } from '../github.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { Account } from './model.ts';
import { listAccounts, writeAccount } from './store.ts';

/** Reason recorded when a handoff was interrupted by a restart (F13). */
export const INTERRUPTED_HANDOFF_REASON = 'interrupted-handoff';

/** Lifecycle states a crash can strand an account in (data-model transitions). */
const TRANSIENT_STATES: ReadonlySet<Account['state']> = new Set(['pending_handoff', 'verifying']);

/** What startup reconciliation found and did. */
export interface ReconcileSummary {
    /** Accounts found in a transient state. */
    readonly examined: number;
    /** Accounts rewritten to `error:interrupted-handoff`. */
    readonly marked: number;
    /** Accounts re-verified back to `active`. */
    readonly restored: number;
}

/** Dependencies the reconciliation pass runs against. */
export interface ReconcileDeps {
    /** Open store, or `null` when the data directory is unusable. */
    readonly store: ServiceStore | null;
    /** GitHub verifier used for the re-verification step. */
    readonly github: GitHubVerifier;
    readonly log: ServiceLogger;
}

/**
 * Mark one stranded account as an interrupted handoff, audited (F13).
 */
async function markInterrupted(input: {
    readonly store: ServiceStore;
    /** The account in a transient state. */
    readonly account: Account;
    readonly correlationId: string;
}): Promise<Account> {
    const { store, account, correlationId } = input;
    const marked: Account = {
        ...account,
        state: 'error',
        errorReason: INTERRUPTED_HANDOFF_REASON,
        updatedAt: nowIso(),
    };
    await writeAccount(store, marked);
    await appendAudit(store, {
        eventType: 'account.error',
        actorSource: 'service',
        entity: { kind: 'account', id: account.numericUserId },
        decision: 'error',
        reason: INTERRUPTED_HANDOFF_REASON,
        correlationId,
        details: { previousState: account.state, operation: 'startup-reconciliation' },
    });

    return marked;
}

/**
 * Apply a successful re-verification to a marked account.
 */
async function restoreAccount(input: {
    readonly store: ServiceStore;
    /** The account after {@link markInterrupted}. */
    readonly marked: Account;
    /** The accepted GitHub outcome. */
    readonly outcome: Extract<VerifyOutcome, { kind: 'ok' }>;
    readonly correlationId: string;
}): Promise<Account> {
    const { store, marked, outcome, correlationId } = input;
    const at = nowIso();
    const restored: Account = {
        ...marked,
        login: outcome.identity.login,
        credential: { ...marked.credential, kind: outcome.credentialKind, verifiedAt: at },
        scopeCheck: outcome.scopeCheck,
        state: 'active',
        connectionState: 'connected',
        verifiedAt: at,
        errorReason: null,
        updatedAt: at,
    };
    await writeAccount(store, restored);
    await appendAudit(store, {
        eventType: 'account.verified',
        actorSource: 'service',
        entity: { kind: 'account', id: restored.numericUserId },
        decision: 'accept',
        reason: 'interrupted handoff re-verified at startup',
        correlationId,
        details: { login: restored.login, operation: 'startup-reconciliation' },
    });

    return restored;
}

/**
 * Reconcile one stranded account: mark it, then try to re-verify it.
 */
async function reconcileAccount(
    deps: ReconcileDeps,
    account: Account,
): Promise<{ readonly marked: boolean; readonly restored: boolean }> {
    const { store } = deps;
    if (store === null) {
        return { marked: false, restored: false };
    }

    const correlationId = newCorrelationId();
    const marked = await markInterrupted({ store, account, correlationId });
    deps.log.info('interrupted handoff found at startup', {
        numericUserId: account.numericUserId,
        previousState: account.state,
    });

    let outcome: VerifyOutcome;
    try {
        outcome = await deps.github.verify(account.credential.token);
    } catch (error) {
        deps.log.warn('startup re-verification failed to run', {
            numericUserId: account.numericUserId,
            errorKind: error instanceof Error ? error.name : typeof error,
        });

        return { marked: true, restored: false };
    }

    if (outcome.kind !== 'ok' || outcome.identity.numericUserId !== account.numericUserId) {
        deps.log.info('startup re-verification did not restore the account', {
            numericUserId: account.numericUserId,
            outcome: outcome.kind,
        });

        return { marked: true, restored: false };
    }

    await restoreAccount({ store, marked, outcome, correlationId });
    deps.log.info('interrupted handoff restored at startup', {
        numericUserId: account.numericUserId,
    });

    return { marked: true, restored: true };
}

/**
 * Run the startup reconciliation pass.
 */
export async function reconcileInterruptedAccounts(deps: ReconcileDeps): Promise<ReconcileSummary> {
    if (deps.store === null) {
        return { examined: 0, marked: 0, restored: 0 };
    }

    const accounts = await listAccounts(deps.store, deps.log);
    const stranded = accounts.filter((account) => TRANSIENT_STATES.has(account.state));
    let marked = 0;
    let restored = 0;
    for (const account of stranded) {
        const outcome = await reconcileAccount(deps, account);
        marked += outcome.marked ? 1 : 0;
        restored += outcome.restored ? 1 : 0;
    }

    return { examined: stranded.length, marked, restored };
}
