/**
 * The binding editor's history-scope field (002 FR-089 – FR-094).
 *
 * **The one place in the panel the mode is ever rendered** (002 FR-091): a row
 * summary may name its short label, Status and Diagnostics must not carry it, and
 * no second editor may offer it. That single-rendering rule is why this field
 * lives in its own module beside `bindings-actors.ts` rather than inside the
 * editor — the count of surfaces that show it is the invariant, and one module is
 * what makes it countable.
 *
 * Five decisions the code does not show:
 *
 * - **A select, not a toggle or free text.** The field's whole domain is two
 *   fixed names (002 FR-053), and a select *offers* them rather than describing
 *   them: every option is reachable by keyboard, the accessible name comes from
 *   the SDK's own caption, and a value outside the two cannot be typed at all
 *   (FR-094). A checkbox could not express "which of two", and a text field would
 *   invite the third value the service refuses.
 * - **The panel never pre-empts the service** (002 FR-063). The select offers the
 *   two names and sends the one chosen; it validates **nothing**, so it can neither
 *   accept input the service would refuse nor reject input it would accept. The
 *   only judgement here is the *rendering* one: a stored value outside the two is
 *   shown as **unreadable**, because rendering it as the default would tell the
 *   operator their binding scans from now on when the service may hold something
 *   else.
 * - **The guidance travels with the field** (FR-090), in the operator's own terms
 *   and without opening anything else: what each option does, that the default
 *   watches from now on, that the look-back is a fixed **seven days, once**, that
 *   the window is bounded with **no "all history" option**, and that choosing it on
 *   an existing binding may offer many sessions at once.
 * - **The window in force is labelled derived state** (FR-092), never as something
 *   the operator set — the same sentence every cycle's row would otherwise be read
 *   as a setting.
 * - **The create path carries the default** (FR-089), so a choice the creator may
 *   indicate is met by a control that also works when they indicate nothing: an
 *   untouched select writes `'new-only'`, which is exactly what absence would have
 *   meant.
 *
 * Imports neither `panel-ui` nor `bindings.ts`, for the reason
 * `bindings-actors.ts` gives: a control that `bindings-ui` composes **and** that
 * `refresh` repaints has to stay a leaf, or the two form an import cycle.
 */

import { mountSelect } from '@openchamber/sdk/ui';
import type { SelectHandle, SelectOption } from '@openchamber/sdk/ui';
import { DEFAULT_HISTORY_SCOPE, readHistoryScope, RECENT_HISTORY_SCOPE } from './bindings-service.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { HistoryScope, PanelBinding } from './bindings-service.ts';

/** The wire member this field is the panel's client of record for (002 FR-056). */
export const HISTORY_SCOPE_FIELD = 'historyScope';

/**
 * What the field is words.
 *
 * The binding's own scope, and it names **the decision** rather than the value:
 * "when this binding starts watching" is what the operator is choosing, and the
 * two option labels below carry the two answers.
 */
export const HISTORY_SCOPE_LABEL = 'When this binding starts watching';

/**
 * The two options, as the operator reads them.
 *
 * Each label states the **behaviour**, not the stored name — `new-only` and
 * `recent-history` are the wire's spelling and the operator has no use for them.
 * The wording is deliberately parallel and factual, so the control reads as two
 * facts about a window rather than as a preference.
 */
const HISTORY_SCOPE_OPTIONS: readonly SelectOption[] = [
    { id: DEFAULT_HISTORY_SCOPE, label: 'From now on (default)' },
    { id: RECENT_HISTORY_SCOPE, label: 'From now on, and look back over the last seven days once' },
];

/** The option list, as the SDK select takes it. */
export function historyScopeOptions(): SelectOption[] {
    return HISTORY_SCOPE_OPTIONS.map((option) => ({ ...option }));
}

/**
 * The guidance the field carries (002 FR-090).
 *
 * Six things the operator must learn **without opening anything else**, and every
 * one of them is stated rather than implied:
 *
 * 1. the default watches from now on;
 * 2. the other option looks back over a fixed **seven-day** period;
 * 3. that look-back happens **once**, and does not repeat on its own;
 * 4. the window is **bounded** and there is **no "all history" option**;
 * 5. choosing it on an **existing** binding offers every matching item inside that
 *    window at once, which **may be many sessions**;
 * 6. a **recovery replay** after data loss re-offers work regardless of the
 *    setting — so the field is never read as the reason a burst of older events
 *    appeared.
 *
 * Returned rather than a module constant because point 5 is conditional on the
 * editor being open on an existing row: a **new** binding cannot open a catch-up,
 * because it has no completed scan to catch up from (002 FR-084; plan H6).
 *
 * @param mode - Whether the editor is editing a row that already exists.
 * @returns The helper text the select renders beneath it.
 */
export function historyScopeGuidance(isEditingStoredRow: boolean): string {
    const catchUp = isEditingStoredRow
        ? 'this offers every matching item inside that window at once, which may be many sessions;'
        : 'this looks back once, from before the binding existed;';

    return 'From now on is the default. The look-back covers a fixed seven days, once, and does not repeat on '
        + 'its own. The window is always bounded — there is no "all history" option. On the binding you are '
        + `editing, ${catchUp} a recovery replay after data loss re-offers work regardless of this setting.`;
}

/**
 * The window-in-force line the editor shows under the control (002 FR-092).
 *
 * **Derived state, labelled as such.** The service computed this window from the
 * binding's history scope and its scan state; the operator set nothing here. Three
 * facts, in the order that answers the question an operator actually has — *what
 * is it watching, since when, and is it recovering*:
 *
 * - no window yet, and the service's reason when it gave one (a refusal is the
 *   only state with no window, so silence would read as "nothing to say");
 * - the mode in force, named as the rule the window came from;
 * - the window's lower bound, next to the last completed scan, so **both ends** of
 *   the window are readable together.
 *
 * @param status - The status row for the binding being edited.
 * @returns The line to render, or `null` while the editor is on a new row.
 */
export function windowInForceLine(status: {
    readonly windowStart: string | null;
    readonly historyScope: HistoryScope;
    readonly forceReplay: boolean;
    readonly lastScanAt: string | null;
    readonly lastError: string | null;
} | null): string | null {
    if (status === null) {
        return null;
    }

    const head = 'Scan window the service computed:';
    const mode = status.historyScope === RECENT_HISTORY_SCOPE
        ? 'look-back mode (from now on, plus a one-off seven-day look-back)'
        : 'from now on';

    if (status.windowStart === null) {
        return `${head} not computed yet${status.lastError === null ? '' : ` — ${status.lastError}`}. `
            + `This binding is in ${mode}.`;
    }

    const replay = status.forceReplay
        ? ' A recovery replay is in force: the queue was lost, so this window re-offers work whatever the mode is.'
        : '';

    return `${head} watching from ${status.windowStart}`
        + `${status.lastScanAt === null ? '' : ` (last scan ${status.lastScanAt})`}. `
        + `This binding is in ${mode}.${replay}`;
}

/**
 * Read the stored mode for the editor's control.
 *
 * **Absent is the documented default** (002 FR-093): a binding storing no mode
 * renders `'new-only'`, because that is what the binding will do, and because
 * absence means the default everywhere (002 FR-058) — never `unset`, which is not
 * a state this field has.
 *
 * A stored mode the panel cannot judge arrives here already **refused** by
 * `parseBindingEntry` (002 FR-063), so this never has to render an unusable value.
 *
 * @param binding - The stored row the editor is open on, or `null` in add mode.
 * @returns The mode the control shows.
 */
export function historyScopeFor(binding: PanelBinding | null): HistoryScope {
    return binding === null ? DEFAULT_HISTORY_SCOPE : readHistoryScope(binding.historyScope) ?? DEFAULT_HISTORY_SCOPE;
}

/**
 * Read the short label a row summary may name (002 FR-091).
 *
 * A **label, not a claim**: 005 FR-091's reasoning is that a count is not a second
 * rendering of a value, and the same holds here — naming the mode in the row is
 * permitted, deriving anything *else* from it is not, and the row is never the
 * only place the operator can see or change it (the editor control is).
 *
 * @param binding - The stored row.
 * @returns The label the row may show, or `null` for the documented default — a
 *   row has nothing to add when the binding is in the mode every binding is in.
 */
export function historyScopeLabel(binding: PanelBinding): string | null {
    return historyScopeFor(binding) === RECENT_HISTORY_SCOPE ? 'one-off 7-day look-back' : null;
}

/** Callbacks the field invokes. */
export interface BindingHistoryScopeHandlers {
    /** The operator chose one of the two modes. */
    readonly setHistoryScope: (value: HistoryScope) => void;
}

/** The field, as the pane carries it. */
export interface BindingHistoryScopeControls {
    /** The one control the mode is rendered in, panel-wide (002 FR-091). */
    readonly select: SelectHandle;
}

/** The bindings-tab state this field reads, narrowed to what it needs. */
type ScopeState = Pick<BindingsTabState, 'bindings' | 'selectedBinding' | 'editing' | 'historyScopeInput'>;

/**
 * Read the editor's mode from the draft, not from the stored row.
 *
 * The draft owns the value while the editor is open, exactly as it owns the
 * repository input and the allow-list: what the control shows is what a save
 * writes, which is 005 FR-050's rule applied to this field. In **add mode** the
 * draft starts at the documented default, so an untouched control writes the
 * default and a chosen one writes the choice (002 FR-089).
 *
 * @param state - The Bindings tab's state.
 * @returns The mode the control should show.
 */
function draftScope(state: ScopeState): HistoryScope {
    return readHistoryScope(state.historyScopeInput) ?? DEFAULT_HISTORY_SCOPE;
}

/**
 * The mode a whole-file write carries for one row (002 FR-057).
 *
 * The scope is **omission-preserves** like the prompt, so every row states the
 * value the editor is showing and the row that was never edited states its own
 * stored value — which is what stops an unrelated save from taking a deliberate
 * choice back to the default.
 *
 * @param state - The Bindings tab's state.
 * @param binding - The row being granted.
 * @returns The mode this row submits.
 */
export function historyScopeForGrant(state: ScopeState, binding: PanelBinding): HistoryScope {
    return state.editing && state.selectedBinding === binding.bindingId
        ? draftScope(state)
        : historyScopeFor(binding);
}

/**
 * Mount the field into the editor, beside the allow-list and the trigger
 * switches — the controls that decide *what a trigger means for this repository*.
 *
 * @returns The handle the pane carries for repaint and disposal.
 */
export function mountBindingHistoryScope(input: {
    /** Runtime whose state the field renders from. */
    readonly rt: PanelRuntime;
    /** Editor root the field mounts into. */
    readonly pane: HTMLElement;
    /** Handlers the field invokes. */
    readonly handlers: BindingHistoryScopeHandlers;
}): BindingHistoryScopeControls {
    const state = input.rt.state.bindings;

    return {
        select: mountSelect(input.pane, {
            label: HISTORY_SCOPE_LABEL,
            value: draftScope(state),
            options: historyScopeOptions(),
            disabled: true,
            onChange: (id) => input.handlers.setHistoryScope(readHistoryScope(id) ?? DEFAULT_HISTORY_SCOPE),
        }),
    };
}

/**
 * Repaint the field from state.
 *
 * Disabled whenever the editor is closed or a read is in flight, like the
 * allow-list beside it: a control the operator could type into on a form that is
 * not going to submit would be a second write path (005 FR-050).
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted handles.
 */
export function repaintBindingHistoryScope(rt: PanelRuntime, controls: BindingHistoryScopeControls): void {
    const state = rt.state.bindings;
    const isEditable = state.editorOpen && state.status !== 'loading';

    controls.select.update({ value: draftScope(state), disabled: !isEditable });
}

/**
 * Read the stored mode a freshly selected binding carries.
 *
 * @param bindings - The bindings the tab holds.
 * @param bindingId - The row the operator just selected, or `null` in add mode.
 * @returns The mode that row opens the editor on.
 */
export function storedHistoryScopeFor(
    bindings: readonly PanelBinding[],
    bindingId: string | null,
): HistoryScope {
    if (bindingId === null) {
        return DEFAULT_HISTORY_SCOPE;
    }

    const binding = bindings.find((candidate) => candidate.bindingId === bindingId);

    return binding === undefined ? DEFAULT_HISTORY_SCOPE : historyScopeFor(binding);
}

/** Release the handle the field mounted. */
export function disposeBindingHistoryScope(controls: BindingHistoryScopeControls): void {
    controls.select.dispose();
}
