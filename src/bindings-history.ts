/**
 * The editor's history-scope field: the panel's one render of the mode, which validates nothing (FR-089–094).
 */

import { mountSelect } from '@openchamber/sdk/ui';
import type { SelectHandle, SelectOption } from '@openchamber/sdk/ui';
import { DEFAULT_HISTORY_SCOPE, readHistoryScope, RECENT_HISTORY_SCOPE } from './bindings-service.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { HistoryScope, PanelBinding } from './bindings-service.ts';

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
 * The guidance the field carries (002 FR-090): six things the operator must
 * learn **without opening anything else**, each stated rather than implied —
 * the default watches from now on; the other option looks back over a fixed
 * **seven-day** period, **once**, never repeating on its own; the window is
 * **bounded** with **no "all history" option**; choosing it on an **existing**
 * binding offers every matching item inside that window at once, which **may
 * be many sessions**; and a **recovery replay** after data loss re-offers work
 * regardless of the setting. Returned rather than a module constant because
 * point 5 is conditional on editing an existing row: a **new** binding has no
 * completed scan to catch up from (002 FR-084; plan H6).
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
 * The window-in-force line the editor shows under the control (002 FR-092):
 * **derived state, labelled as such** — the service computed this window, the
 * operator set nothing. Three facts in the order that answers *what is it
 * watching, since when, and is it recovering*: no window yet with the
 * service's reason when it gave one (a refusal is the only windowless state);
 * the mode in force, named as the rule the window came from; and the lower
 * bound next to the last completed scan, so **both ends** are readable
 * together. `null` while the editor is on a new row.
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
 * Read the stored mode for the editor's control. **Absent is the documented
 * default** (002 FR-093): a binding storing no mode renders `'new-only'`,
 * because that is what the binding will do, and absence means the default
 * everywhere (002 FR-058) — never `unset`, which is not a state this field
 * has. A stored mode the panel cannot judge arrives already **refused** by
 * `parseBindingEntry` (002 FR-063), so this never renders an unusable value.
 */
export function historyScopeFor(binding: PanelBinding | null): HistoryScope {
    return binding === null ? DEFAULT_HISTORY_SCOPE : readHistoryScope(binding.historyScope) ?? DEFAULT_HISTORY_SCOPE;
}

/**
 * Read the short label a row summary may name (002 FR-091): a **label, not a
 * claim** — naming the mode in the row is permitted, deriving anything *else*
 * from it is not, and the row is never the only place the operator can see or
 * change it (the editor control is). `null` for the documented default: a row
 * has nothing to add when the binding is in the mode every binding is in.
 */
export function historyScopeLabel(binding: PanelBinding): string | null {
    return historyScopeFor(binding) === RECENT_HISTORY_SCOPE ? 'one-off 7-day look-back' : null;
}

export interface BindingHistoryScopeHandlers {
    readonly setHistoryScope: (value: HistoryScope) => void;
}

export interface BindingHistoryScopeControls {
    /** The one control the mode is rendered in, panel-wide (002 FR-091). */
    readonly select: SelectHandle;
}

/** The bindings-tab state this field reads, narrowed to what it needs. */
type ScopeState = Pick<BindingsTabState, 'historyScopeInput' | 'editing'>;

/**
 * The guidance this field shows, from the state the editor is currently in:
 * **repainted, not chosen once at mount.** The two variants differ on the one
 * claim an operator cannot otherwise learn — the look-back on a **new**
 * binding sweeps from before it existed, while on an **existing** one it opens
 * a catch-up that may offer many sessions at once (002 FR-090, FR-084) — and
 * the editor is mounted once for both modes, so a mount-time string would show
 * the add-path sentence at exactly the moment the warning exists for.
 */
export function historyScopeHelp(state: ScopeState): string {
    return historyScopeGuidance(state.editing);
}

/**
 * Read the editor's mode from the draft, not from the stored row.
 *
 * The draft owns the value while the editor is open, exactly as it owns the
 * repository input and the allow-list: what the control shows is what a save
 * writes, which is 005 FR-050's rule applied to this field. In **add mode** the
 * draft starts at the documented default, so an untouched control writes the
 * default and a chosen one writes the choice (002 FR-089).
 */
function draftScope(state: ScopeState): HistoryScope {
    return readHistoryScope(state.historyScopeInput) ?? DEFAULT_HISTORY_SCOPE;
}

/**
 * The one binding whose history scope a whole-file write overrides: **a patch
 * naming its row, not a bare value.** The scope is omission-preserves like the
 * prompt (002 FR-057), so every row states its own stored mode and only the
 * row the editor was open on states the control's value instead — and a bare
 * `HistoryScope` would stamp the edited binding's choice onto every row, which
 * in the wider mode arms a catch-up for bindings the operator never touched
 * (002 FR-084).
 */
export interface HistoryScopePatch {
    readonly bindingId: string;
    /** The mode this one row submits, in place of its stored one. */
    readonly historyScope: HistoryScope;
}

/**
 * The mode one row of a whole-file write submits.
 *
 * The counterpart of {@link historyScopeFor}, answering for the row itself: the
 * patch's value for the row it names, and that row's own stored mode for every
 * other one.
 */
export function historyScopeForRow(patch: HistoryScopePatch | null, binding: PanelBinding): HistoryScope {
    return patch?.bindingId === binding.bindingId ? patch.historyScope : historyScopeFor(binding);
}

/**
 * Mount the field into the editor, beside the allow-list and the trigger
 * switches — the controls that decide *what a trigger means for this repository*.
 */
export function mountBindingHistoryScope(input: {
    readonly rt: PanelRuntime;
    readonly pane: HTMLElement;
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
 */
export function repaintBindingHistoryScope(rt: PanelRuntime, controls: BindingHistoryScopeControls): void {
    const state = rt.state.bindings;
    const isEditable = state.editorOpen && state.status !== 'loading';

    controls.select.update({ value: draftScope(state), disabled: !isEditable });
}

/**
 * Read the stored mode a freshly selected binding carries.
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

export function disposeBindingHistoryScope(controls: BindingHistoryScopeControls): void {
    controls.select.dispose();
}
