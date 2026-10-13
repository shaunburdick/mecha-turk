/**
 * Write-through persistence behind the redaction guard: plain JSON and secret-scanned before every `host.storage.set`.
 */

import { isJsonValue } from './json.ts';
import { assertRedacted } from './redaction.ts';
import type { PanelRuntime } from './panel-state.ts';

/**
 * Persist a value in `host.storage` behind the redaction guard.
 *
 * @returns `true` when the write succeeded, `false` when it was refused.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export async function writeStorage(
    rt: PanelRuntime,
    entry: { readonly key: string; readonly value: unknown },
): Promise<boolean> {
    if (!isJsonValue(entry.value)) {
        return false;
    }

    try {
        assertRedacted(entry.key, JSON.stringify(entry.value));
        await rt.host.storage.set(entry.key, entry.value);
    } catch {
        return false;
    }

    return true;
}
