/**
 * File-backed account custody: read, list, write, and remove accounts
 * under `accounts/<numericUserId>.json` (data-model.md storage tier 1).
 */

import { observeAccountPromptChanges } from '../account-prompt-audit.ts';
import { isRecord } from '../json.ts';
import type { JsonReadResult } from '../store/json.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { Account, AccountRefusalNote } from './model.ts';
import { isNumericUserId, parseStoredAccount } from './model.ts';

/** Store-relative directory holding one credential file per account. */
export const ACCOUNTS_DIR = 'accounts';

/** Store-relative file holding the repository bindings (DELETE refusal check). */
export const BINDINGS_FILE = 'bindings.json';

/** Suffix of an account credential file. */
const ACCOUNT_FILE_SUFFIX = '.json';

/**
 * Build the store-relative path of one account file.
 */
export function accountPath(numericUserId: string): string {
    if (!isNumericUserId(numericUserId)) {
        throw new Error('account paths key on a numeric GitHub user id only');
    }

    return `${ACCOUNTS_DIR}/${numericUserId}${ACCOUNT_FILE_SUFFIX}`;
}

/** One read of a stored account. */
interface ReadAccountInput {
    readonly store: ServiceStore;
    /** Key of the account to read. */
    readonly numericUserId: string;
    /** Logger used when the stored document had to be quarantined. */
    readonly log: ServiceLogger;
}

/**
 * Log a quarantine without ever failing the read that discovered it.
 */
function reportQuarantine(input: {
    /** Outcome of the store read. */
    readonly result: JsonReadResult<Account>;
    /** What was set aside, for the log line. */
    readonly subject: string;
    readonly log: ServiceLogger;
    /** First `field: remediation` the parser refused, when one was named. */
    readonly note: AccountRefusalNote;
}): void {
    const { result, subject, log, note } = input;
    if (result.status === 'quarantined') {
        // The reason is field + remediation only: the refusal vocabulary never
        // echoes a value, so this line cannot leak one.
        log.warn('stored record was unusable and has been set aside', {
            subject,
            quarantinePath: result.quarantinePath,
            ...(note.reason !== null && { reason: note.reason }),
        });
    }
}

/**
 * Read one account **without** running the prompt-change observer.
 *
 * This is the reader the chain-holding profile write uses, so the chain can
 * never deadlock against itself (plan C20, mirroring `readBindingsUnobserved`).
 */
export async function readAccountUnobserved(input: ReadAccountInput): Promise<Account | null> {
    const { store, numericUserId, log } = input;
    const note: AccountRefusalNote = { reason: null };
    const result = await store.readJson(accountPath(numericUserId), (raw) => parseStoredAccount(raw, note));
    reportQuarantine({ result, subject: `account ${numericUserId}`, log, note });

    return result.status === 'ok' ? result.value : null;
}

/**
 * Read one account, recording any prompt change the stored record carries.
 * The observation runs *after* the read answered, on the per-store account
 * chain, so a prompt edited outside the panel is recorded exactly once with
 * the actor the service can actually attribute it to — `service`. A read that
 * finds **no** account forgets that id's baseline: the tier died with the
 * record, so a re-added account reads as a fresh `set` rather than a diff
 * against a fingerprint nobody holds any more.
 */
export async function readAccount(input: ReadAccountInput): Promise<Account | null> {
    const account = await readAccountUnobserved(input);
    await observeAccountPromptChanges({
        store: input.store,
        log: input.log,
        accounts: account === null ? [] : [account],
        ...(account === null && { absent: [input.numericUserId] }),
        actor: 'service',
    });

    return account;
}

/**
 * List every stored account **without** running the prompt-change observer.
 */
export async function listAccountsUnobserved(store: ServiceStore, log: ServiceLogger): Promise<readonly Account[]> {
    const names = await store.listDir(ACCOUNTS_DIR);
    const accounts: Account[] = [];
    for (const name of names) {
        if (!name.endsWith(ACCOUNT_FILE_SUFFIX)) {
            continue;
        }

        const id = name.slice(0, -ACCOUNT_FILE_SUFFIX.length);
        if (!isNumericUserId(id)) {
            continue;
        }

        const account = await readAccountUnobserved({ store, numericUserId: id, log });
        if (account !== null) {
            accounts.push(account);
        }
    }

    return accounts.toSorted((left, right) => left.numericUserId.localeCompare(right.numericUserId));
}

/**
 * Read every stored account, observing the whole custody directory.
 *
 * This is the **complete** observation: a record that is gone from the
 * directory is forgotten from the baseline, so deletion and re-addition read
 * as the tier's own story rather than a diff across a hole (004 FR-088,
 * AC-149).
 */
export async function listAccounts(store: ServiceStore, log: ServiceLogger): Promise<readonly Account[]> {
    const accounts = await listAccountsUnobserved(store, log);
    await observeAccountPromptChanges({ store, log, accounts, complete: true, actor: 'service' });

    return accounts;
}

/**
 * Persist an account (credential included) with the store's atomic writer.
 */
export async function writeAccount(store: ServiceStore, account: Account): Promise<void> {
    await store.writeJson(accountPath(account.numericUserId), account);
}

/**
 * Remove an account credential file (operator-driven delete only).
 */
export async function removeAccount(store: ServiceStore, numericUserId: string): Promise<void> {
    await store.removeFile(accountPath(numericUserId));
}

/** One stored repository binding as the delete-refusal check sees it. */
export interface BindingRecord {
    /** Binding id, echoed back in the refusal message. */
    readonly bindingId: string;
    /** The raw document, preserved verbatim when other fields are rewritten. */
    readonly raw: Record<string, unknown>;
}

/**
 * Read the bindings that reference one account.
 *
 * The binding model itself lands with task T-020, so this reads the file
 * leniently: entries that do not carry both a `bindingId` and an
 * `accountNumericUserId` are skipped rather than rejected, and survivors keep
 * every field they arrived with.
 */
export async function bindingsReferencing(
    store: ServiceStore,
    numericUserId: string,
): Promise<readonly BindingRecord[]> {
    const result = await store.readJson(BINDINGS_FILE, (raw) => (Array.isArray(raw) ? raw : null));
    if (result.status !== 'ok') {
        return [];
    }

    const matches: BindingRecord[] = [];
    for (const entry of result.value) {
        if (!isRecord(entry) || entry.accountNumericUserId !== numericUserId) {
            continue;
        }

        if (typeof entry.bindingId === 'string') {
            matches.push({ bindingId: entry.bindingId, raw: entry });
        }
    }

    return matches;
}

/**
 * Disable every binding that references one account, preserving all fields.
 */
export async function disableBindings(
    store: ServiceStore,
    bindings: readonly BindingRecord[],
): Promise<readonly BindingRecord[]> {
    const disabled = bindings.map((binding) => ({
        bindingId: binding.bindingId,
        raw: { ...binding.raw, state: 'disabled' },
    }));
    const result = await store.readJson(BINDINGS_FILE, (raw) => (Array.isArray(raw) ? raw : null));
    const entries =
        result.status === 'ok'
            ? result.value.map((entry) => {
                const replaced = disabled.find(
                    (binding) => isRecord(entry) && entry.bindingId === binding.bindingId,
                );

                return replaced?.raw ?? entry;
            })
            : disabled.map((binding) => binding.raw);

    await store.writeJson(BINDINGS_FILE, entries);

    return disabled;
}
