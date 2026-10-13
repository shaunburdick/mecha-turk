/**
 * The whole-file bindings grant: the one `PUT /v1/bindings` replacing the stored list for every write (FR-050/058).
 */

import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { startRelayPolling } from './relay.ts';
import { BINDINGS_PATH, servicePut } from './service-calls.ts';
import { countEnabledBindings, parseBindingsBody } from './bindings-service.ts';
import { historyScopeForRow } from './bindings-history.ts';
import type { ActorPatch } from './bindings-actors.ts';
import type { HistoryScopePatch } from './bindings-history.ts';
import type { PanelBinding } from './bindings-service.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { ServiceErrorResult } from './service-calls.ts';

/** The one binding whose prompt a whole-file write carries. */
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
 */
function forGrant(binding: PanelBinding, patch: PromptPatch | null): PanelBinding {
    if (patch?.bindingId !== binding.bindingId) {
        return { ...binding, startingPrompt: undefined };
    }

    return { ...binding, startingPrompt: patch.startingPrompt };
}

/**
 * The three per-binding overrides one whole-file write applies.
 *
 * Grouped into one object so the row builder stays inside the two-parameter
 * rule and so "what a write overrides" is one named thing rather than three
 * positional arguments a caller could transpose.
 */
interface GrantOverrides {
    /** The list the grant replaces wholesale. */
    readonly bindings: readonly PanelBinding[];
    /** The edited binding's prompt, or `null` when none was edited. */
    readonly prompt: PromptPatch | null;
    /** The edited binding's allow-list, or `null` when the field was untouched. */
    readonly actors: ActorPatch | null;
    /**
     * The edited binding's mode, or `null` when the field was untouched.
     *
     * A **patch naming its row** rather than a bare value: the grant replaces the
     * whole list, so a value without a row would stamp one binding's choice onto
     * every binding — and for the wider mode the service answers that by arming a
     * bounded catch-up per binding, including the ones the operator never opened
     * (002 FR-084).
     */
    readonly historyScope: HistoryScopePatch | null;
}

/**
 * Build one row as it goes on the wire, carrying **both** per-binding values.
 * The allow-list is the one member a whole-file row must **always** state: an
 * omitted key means *unset* (contract §2), so a row that dropped it would take
 * its own binding back to open. The spread already carries whatever the row
 * holds; the edited row's override is an array when the field holds logins and
 * `undefined` (which `JSON.stringify` drops) when the operator cleared it.
 */
function rowForGrant(input: {
    /** The row being granted. */
    readonly binding: PanelBinding;
} & GrantOverrides): PanelBinding {
    const row = forGrant(input.binding, input.prompt);
    // The history scope rides on **every** row, but only the row the editor was
    // open on carries the control's value: every other row states its **own**
    // stored mode (002 FR-057). It is never omitted, because a whole-file row that
    // left the key out would be read as *leave this one alone* — and the row the
    // operator did open must state what its control showed, including when they
    // chose the documented default, which the service accepts either way.
    const scoped = { ...row, historyScope: historyScopeForRow(input.historyScope, input.binding) };
    if (input.actors?.bindingId !== input.binding.bindingId) {
        return scoped;
    }

    return { ...scoped, allowedUsers: input.actors.allowedUsers ?? undefined };
}

/**
 * Serialize one whole-file grant.
 */
function grantBody(overrides: GrantOverrides): string {
    return JSON.stringify({
        bindings: overrides.bindings.map((binding) => rowForGrant({ ...overrides, binding })),
    });
}

/**
 * Arm the event relay from one bindings list the service just confirmed. Arming used to happen at
 * exactly two mount-time signals, so a panel whose first binding landed in-session — or whose
 * mount-time `GET /v1/bindings` answered 503 (the first-run spawn race) — never armed and every
 * later event sat `pending` until a remount. Any read or grant landing here proves the service is
 * up and the binding exists, so it arms too; `startRelayPolling` is a no-op once `rt.relayArmed`
 * is set, and it kicks one immediate tick so the operator does not wait out
 * `RELAY_POLL_INTERVAL_MS`. An empty list must not arm: a relay draining against no binding would
 * mark queued events `binding-missing` before the binding they belong to lands.
 */
export function armRelayForBindings(rt: PanelRuntime, bindings: readonly PanelBinding[]): void {
    if (countEnabledBindings(bindings) > 0) {
        startRelayPolling(rt);
    }
}

/**
 * Report a refused whole-file write on the tab's note: the grant is
 * all-or-nothing after validation, so a refusal changed nothing and the panel
 * says so rather than looking as though it half-saved — the on-screen list
 * stays the last one the service confirmed, which is what makes AC-125's
 * byte-identical guarantee true. The service's own field-level copy is **not**
 * rendered here: it goes to the field it names, which the caller splits out of
 * the answer this returns.
 */
function noteRefusal(rt: PanelRuntime, result: ServiceErrorResult): void {
    if (result.ok) {
        return;
    }

    rt.state.bindings.note = redact(
        `${result.problem} — the service refused the whole-file write, so no binding changed; `
            + 'this list is still exactly what the service holds.',
    );
    refresh(rt);
}

/** The problem an answer the panel could not parse reports (invariant 8). */
const UNREADABLE_LIST_PROBLEM = 'service answered a list the panel could not read';

/**
 * The refusal a `2xx` body the panel cannot read produces: **no code, no
 * message, and no reference window** — the transport succeeded, so there is no
 * envelope to read the three from, and inventing one would be a verdict the
 * service never sent. Named as its own shape because the bindings grant is the
 * only caller that has to *return* this refusal.
 */
function unreadableListRefusal(): ServiceErrorResult {
    return { ok: false, problem: UNREADABLE_LIST_PROBLEM, code: null, message: null, referenceWindow: null };
}

/**
 * Replace the stored bindings with one PUT; never throws. On a refused body
 * the panel keeps its local draft and the note explains. A granted list with an
 * enabled row also arms the relay ({@link armRelayForBindings}), so the first
 * binding created in-session dispatches without waiting for a remount; every
 * row is built by {@link rowForGrant} — an untouched prompt is omitted rather
 * than re-submitted, every row states its own allow-list and history scope, and
 * only the row each patch names carries the operator's value instead (002
 * FR-047, contract §2; 002 FR-057). The result is handed back as well as
 * rendered, so a caller can put a field-level refusal next to its field.
 */
export async function grantBindings(input: {
    readonly rt: PanelRuntime;
    /** The replacement list. */
    readonly bindings: readonly PanelBinding[];
    /** Success note once the service stored it. */
    readonly note: string;
    /** The edited binding's prompt, or absent when no prompt was touched. */
    readonly prompt?: PromptPatch | undefined;
    /** The edited binding's allow-list, or absent when the field was untouched. */
    readonly actors?: ActorPatch | undefined;
    /**
     * The mode the editor's control chose, naming the row it was open on, or
     * absent when the editor is closed or the field was untouched. **The row id
     * is load-bearing**, not incidental: this grant replaces the whole list, so
     * an override that did not name its row would be written onto every
     * binding — and in the wider mode the service arms a bounded catch-up per
     * binding, including the ones the operator never opened (002 FR-084).
     */
    readonly historyScope?: HistoryScopePatch | undefined;
}): Promise<ServiceErrorResult> {
    const { rt, bindings, note } = input;
    const overrides: GrantOverrides = {
        bindings,
        prompt: input.prompt ?? null,
        actors: input.actors ?? null,
        historyScope: input.historyScope ?? null,
    };
    const result = await servicePut({
        serviceRequest: rt.host.serviceRequest,
        path: BINDINGS_PATH,
        body: grantBody(overrides),
    });

    if (rt.disposed) {
        return result;
    }

    if (!result.ok) {
        noteRefusal(rt, result);

        return result;
    }

    const parsed = parseBindingsBody(result.body);
    if (parsed === null) {
        rt.state.bindings.note = 'The service answered a list the panel could not read — refresh to see what stuck.';
        refresh(rt);

        return unreadableListRefusal();
    }

    rt.state.bindings.bindings = parsed.bindings;
    rt.state.bindings.statusRows = parsed.status;
    rt.state.bindingsActive = countEnabledBindings(parsed.bindings);
    armRelayForBindings(rt, parsed.bindings);
    rt.state.bindings.note = note;
    refresh(rt);

    return result;
}
