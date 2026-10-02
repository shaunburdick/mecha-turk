/**
 * The whole-file bindings grant (005 FR-050, FR-054, FR-058; 004 FR-014).
 *
 * `bindings.ts` owns the tab's actions; this module owns the **one write**
 * every one of them shares: a single `PUT /v1/bindings` that replaces the
 * stored list wholesale, exactly as 002's grant is defined. There is no
 * per-binding endpoint here — 005 deliberately does not reopen 002's MVP debt
 * (FR-050) — so create, edit, enable, disable, and remove are all this call.
 *
 * Two rules live here rather than at each caller, because a second place they
 * could be got wrong is a second chance to violate them:
 *
 * - **A prompt travels only where it was edited** (004 FR-014). Every row is
 *   rebuilt without the member, and the one binding whose prompt the operator
 *   changed gets it back — an empty string when they cleared it. The route
 *   reads an absent key as *leave this one alone*, so an untouched prompt is
 *   preserved rather than resubmitted.
 * - **A refusal changed nothing and says so** (FR-058, AC-125). The grant is
 *   all-or-nothing after validation, and the note says exactly that instead
 *   of looking like a partial save. The service's own copy is handed back to
 *   the caller so the field it belongs to can render it (FR-052).
 */

import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { startRelayPolling } from './relay.ts';
import { BINDINGS_PATH, servicePut } from './service-calls.ts';
import { countEnabledBindings, parseBindingsBody } from './bindings-service.ts';
import type { PanelBinding } from './bindings-service.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { ServiceErrorResult } from './service-calls.ts';

/** The one binding whose prompt a whole-file write carries (004 FR-014). */
export interface PromptPatch {
    /** Binding whose prompt the operator edited. */
    readonly bindingId: string;
    /**
     * The value submitted for that binding: an **empty string** clears the
     * stored prompt (the field travels precisely when it was cleared), while
     * every other row omits the key so the route preserves its own prompt.
     */
    readonly startingPrompt: string;
}

/**
 * Strip the prompt from one row, then write it back on the edited one.
 *
 * @param binding - One row of the list being granted.
 * @param patch - The edited binding's prompt, or `null` when none was edited.
 * @returns The row as it goes on the wire.
 */
function forGrant(binding: PanelBinding, patch: PromptPatch | null): PanelBinding {
    if (patch?.bindingId !== binding.bindingId) {
        return { ...binding, startingPrompt: undefined };
    }

    return { ...binding, startingPrompt: patch.startingPrompt };
}

/**
 * Arm the event relay from one bindings list the service just confirmed.
 *
 * Arming used to happen in exactly two places — a *successful* mount-time
 * read with a binding in it (`bindings-mode.loadInitialBindings`) and an
 * integration-card connection while bindings were already active (the card
 * and its connection handler went with the 2026-09-30 de-spike sweep). Both
 * were mount-time signals, so a panel whose
 * first binding landed in-session, or whose mount-time `GET /v1/bindings`
 * answered 503 (the service's spawn race on a first run), never armed:
 * every later event sat `pending` until a remount. Any read or grant that
 * lands here is proof the service is up and the binding exists, so it arms
 * too. `startRelayPolling` is a no-op once `rt.relayArmed` is set, which
 * makes the extra calls idempotent — and it kicks one immediate tick, so the
 * operator does not wait out `RELAY_POLL_INTERVAL_MS` after binding.
 *
 * An empty list must not arm: a relay draining against no binding would
 * mark queued events `binding-missing` before the binding they belong to
 * ever lands.
 *
 * @param rt - Panel runtime.
 * @param bindings - The bindings list the service just confirmed as stored.
 */
export function armRelayForBindings(rt: PanelRuntime, bindings: readonly PanelBinding[]): void {
    if (countEnabledBindings(bindings) > 0) {
        startRelayPolling(rt);
    }
}

/**
 * Replace the stored bindings with one PUT; never throws.
 *
 * On a refused body the panel keeps its local draft and the note explains.
 * A granted list with an enabled row also arms the relay (see
 * {@link armRelayForBindings}), so the first binding created in-session
 * dispatches without waiting for a remount. Every row is built by
 * {@link forGrant}, so an untouched prompt is omitted rather than
 * re-submitted (004 FR-014).
 *
 * The result is handed back as well as rendered: the note carries the
 * operator-facing sentence, while the envelope's own code and copy let a
 * caller put a field-level refusal next to the field it belongs to.
 *
 * @param input - Runtime, the replacement list, the success note, and the one
 *   prompt this write carries (if any).
 * @returns The service's answer, including its refusal when it sent one.
 */
export async function grantBindings(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The replacement list. */
    readonly bindings: readonly PanelBinding[];
    /** Success note once the service stored it. */
    readonly note: string;
    /** The edited binding's prompt, or absent when no prompt was touched. */
    readonly prompt?: PromptPatch | undefined;
}): Promise<ServiceErrorResult> {
    const { rt, bindings, note } = input;
    const patch = input.prompt ?? null;
    const result = await servicePut({
        serviceRequest: rt.host.serviceRequest,
        path: BINDINGS_PATH,
        body: JSON.stringify({ bindings: bindings.map((binding) => forGrant(binding, patch)) }),
    });

    if (rt.disposed) {
        return result;
    }

    if (!result.ok) {
        // The whole-file grant is all-or-nothing after validation (FR-058), so
        // a refusal changed nothing — and the panel says so rather than
        // looking as though it half-saved. The list on screen is still the
        // last one the service confirmed, which is what makes AC-125's
        // byte-identical guarantee true rather than merely intended.
        rt.state.bindings.note = redact(
            `${result.problem} — the service refused the whole-file write, so no binding changed; `
                + 'this list is still exactly what the service holds.',
        );
        refresh(rt);

        return result;
    }

    const parsed = parseBindingsBody(result.body);
    if (parsed === null) {
        rt.state.bindings.note = 'The service answered a list the panel could not read — refresh to see what stuck.';
        refresh(rt);

        return { ok: false, problem: 'service answered a list the panel could not read', code: null, message: null };
    }

    rt.state.bindings.bindings = parsed.bindings;
    rt.state.bindings.statusRows = parsed.status;
    rt.state.bindingsActive = countEnabledBindings(parsed.bindings);
    armRelayForBindings(rt, parsed.bindings);
    rt.state.bindings.note = note;
    refresh(rt);

    return result;
}
