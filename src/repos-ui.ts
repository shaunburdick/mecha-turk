/**
 * The Repositories pane (M3 re-cut): list, add, and enable/disable bindings.
 *
 * Every control is a documented SDK primitive repainted from runtime state,
 * so the pane never diverges from what the runtime knows. The add form
 * mirrors the spike's picker patterns: an `owner/name` text field, an
 * account select sourced from `GET /v1/accounts`, a project select sourced
 * from the host's own `listProjects()` state, then the trigger checkboxes
 * and the worktree option. All service-supplied strings reach the DOM
 * through the SDK primitives' `textContent` writes — no HTML sink is
 * touched (panel-service contract §3 invariant 11). The binding list rows
 * themselves — the scan stamp, skip reason, and pending count the operator
 * reads per row — live in `repos-rows.ts`, and the runs section's row copy
 * lives beside it in `runs-rows.ts` (M8).
 */

import {
    mountButton,
    mountCheckbox,
    mountList,
    mountSelect,
    mountText,
    mountTextField,
    mountTabs,
} from '@openchamber/sdk/ui';
import type {
    ButtonHandle,
    CheckboxHandle,
    ListHandle,
    SelectHandle,
    TabsHandle,
    SelectOption,
    TextHandle,
    TextFieldHandle,
} from '@openchamber/sdk/ui';
import type { PanelRuntime, Repositories } from './panel-state.ts';
import { bindingRows } from './repos-rows.ts';
import { mountRunsBoard, repaintRunsBoard } from './runs-ui.ts';
import type { RunsBoard } from './runs-ui.ts';

/** The pane handle: tab strip, pane element, and every repaint handle. */
export interface ReposPane {
    /** Tab strip the two panes share. */
    readonly tabs: TabsHandle;
    /** The pane root this view mounted. */
    readonly pane: HTMLElement;
    /** Status line at the top. */
    readonly status: TextHandle;
    /** Bindings list with per-binding scan lines. */
    readonly bindingsList: ListHandle;
    /** Bindings refresh button. */
    readonly refreshBindings: ButtonHandle;
    /** Repository owner/name input. */
    readonly repoField: TextFieldHandle;
    /** Account select (from `GET /v1/accounts`). */
    readonly accountSelect: SelectHandle;
    /** Project select (from the host's project list). */
    readonly projectSelect: SelectHandle;
    /** Assignment trigger checkbox. */
    readonly assignmentCheck: CheckboxHandle;
    /** Mention trigger checkbox. */
    readonly mentionCheck: CheckboxHandle;
    /** Review-request trigger checkbox. */
    readonly reviewRequestCheck: CheckboxHandle;
    /** Worktree option select. */
    readonly worktreeSelect: SelectHandle;
    /** Add-binding button. */
    readonly addBinding: ButtonHandle;
    /** Enable/disable toggle for the selected row. */
    readonly toggleSelected: ButtonHandle;
    /** Removal button for the selected row. */
    readonly removeSelected: ButtonHandle;
    /** Two-step Remove-account control (arm, then confirm). */
    readonly removeAccount: ButtonHandle;
    /** Note under the form. */
    readonly note: TextHandle;
    /** The runs half of the pane: heading, list, actions, and notes. */
    readonly runs: RunsBoard;
    /** Remove every node this pane mounted. */
    readonly dispose: () => void;
}

/** Callbacks the mounted Repositories pane invokes. */
export interface ReposPaneHandlers {
    /** Operators toggled the tab strip. */
    readonly switchTab: (id: 'spike' | 'repos') => void;
    /** Operators re-read the bindings and accounts. */
    readonly refresh: () => void;
    /** Operators submitted the add form. */
    readonly submit: () => void;
    /** Operators toggled a binding's enabled state (selected row). */
    readonly toggle: () => void;
    /** Operators removed the selected binding from the granted list. */
    readonly removeBinding: () => void;
    /** Operators clicked the Remove-account control (arm, then confirm). */
    readonly removeAccount: () => void;
    /** Operators changed the repository input. */
    readonly setRepoInput: (value: string) => void;
    /** Operators picked an account. */
    readonly selectAccount: (id: string) => void;
    /** Operators picked a project. */
    readonly selectProject: (id: string) => void;
    /** Operators set the assignment trigger checkbox. */
    readonly setAssignment: (checked: boolean) => void;
    /** Operators set the mention trigger checkbox. */
    readonly setMention: (checked: boolean) => void;
    /** Operators set the review-request trigger checkbox. */
    readonly setReviewRequest: (checked: boolean) => void;
    /** Operators picked a worktree option. */
    readonly setWorktree: (id: 'none' | 'generated') => void;
    /** Operators clicked a binding row. */
    readonly selectBinding: (id: string) => void;
    /** Operators reloaded the project list behind the picker. */
    readonly refreshProjects: () => void;
    /** Operators asked for a fresh runs history (M8). */
    readonly refreshRuns: () => void;
    /** Operators clicked a run row. */
    readonly selectRun: (id: string) => void;
    /** Operators asked to open the selected run's issue. */
    readonly openRun: () => void;
    /** Operators asked to requeue the selected run. */
    readonly retryRun: () => void;
    /** Operators asked to return the selected parked run to waiting. */
    readonly requeueRun: () => void;
    /** Operators confirmed FR-027's first resolution (a session exists). */
    readonly resolveSessionCreated: () => void;
    /** Operators confirmed FR-027's second resolution (no session exists). */
    readonly resolveNoSession: () => void;
    /** Operators typed into the session-id field. */
    readonly setSessionInput: (value: string) => void;
    /** Operators asked for the selected run's audit history (FR-053). */
    readonly loadAudit: () => void;
}

/** Worktree options the add form offers (MVP: `new:` comes later). */
const WORKTREE_OPTIONS = [
    { id: 'none', label: 'none — project default directory' },
    { id: 'generated', label: 'generated — OpenChamber creates a worktree' },
] as const;

/** Note under the mention checkbox (M6's comment *and* issue-body scan). */
export const MENTION_SCAN_NOTE = 'Issue bodies and comments that @mention the bound account open a dispatch.';

/** Note under the review-request checkbox (M7). */
export const REVIEW_SCAN_NOTE = 'Pull requests that ask the account to review open a dispatch.';

/** Idle label of the two-step Remove-account control. */
export const REMOVE_ACCOUNT_IDLE_LABEL = 'Remove account';

/** Confirm-step label after the first click (no `confirm()` in the frame). */
export const REMOVE_ACCOUNT_CONFIRM_LABEL = 'Confirm remove';

/**
 * Compose the pane's one status line.
 *
 * @param repos - The Repos tab's state.
 * @returns The summary text the status line shows.
 */
function composeStatus(repos: Repositories): string {
    const bindings = `${repos.bindings.length} bindings`;
    const accounts = `${repos.accounts.length} accounts`;

    return `Repositories: ${bindings} · ${accounts}`;
}

/** What `mountRepositoriesPane` builds; exactly {@link ReposPane} plus tabs. */
type MountedPane = ReposPane & { readonly pane: HTMLElement };

/** Inputs the add-form mounts share (runtime, pane root, handlers). */
interface MountInputs {
    /** Runtime whose state repaints the control. */
    readonly rt: PanelRuntime;
    /** The pane root the control mounts into. */
    readonly pane: HTMLElement;
    /** Handlers the control invokes. */
    readonly handlers: ReposPaneHandlers;
}

/** The bindings list half of the pane. */
interface Board {
    /** Status line at the top. */
    readonly status: TextHandle;
    /** Bindings list. */
    readonly bindingsList: ListHandle;
    /** Refresh button. */
    readonly refreshBindings: ButtonHandle;
}

/** The add-form half of the pane. */
interface Form {
    /** Repository input. */
    readonly repoField: TextFieldHandle;
    /** Account select. */
    readonly accountSelect: SelectHandle;
    /** Project select. */
    readonly projectSelect: SelectHandle;
    /** Assignment checkbox. */
    readonly assignment: CheckboxHandle;
    /** Mention checkbox. */
    readonly mention: CheckboxHandle;
    /** Review-request checkbox. */
    readonly reviewRequest: CheckboxHandle;
    /** Worktree select. */
    readonly worktree: SelectHandle;
    /** Bind button. */
    readonly add: ButtonHandle;
    /** Toggle button. */
    readonly toggle: ButtonHandle;
    /** Removal button for the selected row. */
    readonly removeSelected: ButtonHandle;
    /** Two-step Remove-account control. */
    readonly removeAccount: ButtonHandle;
    /** Note under the form. */
    readonly note: TextHandle;
}

/**
 * Mount the bindings list and its refresh.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The board handles.
 */
function mountBindingsBoard(input: MountInputs): Board {
    const status = mountText(input.pane, { text: composeStatus(input.rt.state.repos) });
    const list = mountList(input.pane, {
        items: [],
        ariaLabel: 'Repository bindings',
        emptyText: 'No repository bound yet — add one below or refresh.',
        onSelect: (id: string) => input.handlers.selectBinding(id),
    });
    const refresh = mountButton(
        input.pane,
        { label: 'Refresh bindings', variant: 'secondary', onClick: input.handlers.refresh },
    );
    return { status, bindingsList: list, refreshBindings: refresh };
}

function mountRepoField(input: MountInputs): TextFieldHandle {
    return mountTextField(input.pane, {
        label: 'Repository (owner/name)',
        value: input.rt.state.repos.repoInput,
        placeholder: 'acme/widget',
        mono: true,
        onChange: (value) => input.handlers.setRepoInput(value),
    });
}
function mountAccountSelect(input: MountInputs): SelectHandle {
    return mountSelect(input.pane, {
        label: 'Poll as account',
        value: input.rt.state.repos.accountSelection,
        options: [],
        searchable: true,
        placeholder: 'Select a verified account',
        disabled: true,
        onChange: (id) => input.handlers.selectAccount(id),
    });
}
function mountProjectSelect(input: MountInputs): SelectHandle {
    const options = {
        label: 'Dispatch project',
        value: input.rt.state.repos.repoProjectSelection,
        options: [],
        searchable: true,
        searchPlaceholder: 'Search projects by name or id',
        placeholder: 'Pick a project',
        disabled: true,
        onChange: (id: string) => input.handlers.selectProject(id),
    };

    return mountSelect(input.pane, options);
}
function mountTriggerChecks(input: MountInputs): {
    readonly assignment: CheckboxHandle;
    readonly mention: CheckboxHandle;
    readonly reviewRequest: CheckboxHandle;
} {
    const assignment = mountCheckbox(input.pane, {
        label: 'Assignment',
        checked: input.rt.state.repos.triggerAssignment,
        onChange: (checked) => input.handlers.setAssignment(checked),
    });
    const mention = mountCheckbox(input.pane, {
        label: 'Mention',
        description: MENTION_SCAN_NOTE,
        checked: input.rt.state.repos.triggerMention,
        onChange: (checked) => input.handlers.setMention(checked),
    });
    const reviewRequest = mountCheckbox(input.pane, {
        label: 'Review request',
        description: REVIEW_SCAN_NOTE,
        checked: input.rt.state.repos.triggerReviewRequest,
        onChange: (checked) => input.handlers.setReviewRequest(checked),
    });

    return { assignment, mention, reviewRequest };
}
function worktreeOptions(repos: Repositories, handlers: ReposPaneHandlers): {
    readonly label: string;
    readonly value: 'none' | 'generated';
    readonly options: { readonly id: string; readonly label: string }[];
    readonly onChange: (id: string) => void;
} {
    return {
        label: 'Worktree option',
        value: repos.worktreeSelection,
        options: WORKTREE_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
        onChange: (id: string) => handlers.setWorktree(id === 'generated' ? 'generated' : 'none'),
    };
}
/**
 * Mount the add form's controls.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The form handles.
 */
function mountAddForm(input: MountInputs): Form {
    const repoField = mountRepoField(input);
    const accountSelect = mountAccountSelect(input);
    const projectSelect = mountProjectSelect(input);
    const checks = mountTriggerChecks(input);
    const worktree = mountSelect(
        input.pane,
        worktreeOptions(input.rt.state.repos, input.handlers),
    );
    const add = mountButton(
        input.pane,
        { label: 'Bind repository', disabled: true, onClick: input.handlers.submit },
    );
    const toggle = mountButton(
        input.pane,
        { label: 'Toggle enabled', variant: 'outline', disabled: true, onClick: input.handlers.toggle },
    );
    const removeSelected = mountButton(
        input.pane,
        { label: 'Remove', variant: 'outline', disabled: true, onClick: input.handlers.removeBinding },
    );
    const removeAccount = mountButton(
        input.pane,
        {
            label: REMOVE_ACCOUNT_IDLE_LABEL,
            variant: 'outline',
            disabled: true,
            onClick: input.handlers.removeAccount,
        },
    );

    return {
        repoField,
        accountSelect,
        projectSelect,
        assignment: checks.assignment,
        mention: checks.mention,
        reviewRequest: checks.reviewRequest,
        worktree,
        add,
        toggle,
        removeSelected,
        removeAccount,
        note: mountText(input.pane, { text: input.rt.state.repos.note }),
    };
}

/**
 * The worktree select's documented options.
 *
 * @param repos - Repos state.
 * @returns The mount parameters for the SDK select.
 */

/**
 * Mount the repository owner/name input.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The text-field handle.
 */

/**
 * Mount the account select for the add form.
 *
 * @param input - Runtime, the pane root, and the handlers.
 * @returns The select handle.
 */

/**
 * Mount the project select for the add form.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The select handle.
 */

/**
 * Mount the trigger checkboxes.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The two checkbox handles.
 */

/**
 * Mount the Repositories pane.
 *
 * @param input - Panel root, runtime, and the handlers the controls invoke.
 * @returns The mounted pane, tab strip, and repaint handles.
 */
export function mountRepositoriesPane(input: {
    /** Panel root element. */
    readonly root: HTMLElement;
    /** Runtime whose state the pane repaints from. */
    readonly rt: PanelRuntime;
    /** Handlers the controls invoke. */
    readonly handlers: ReposPaneHandlers;
}): MountedPane {
    const { root, rt, handlers } = input;
    const tabs = mountTabs(root, {
        items: [
            { id: 'spike', label: 'Spike' },
            { id: 'repos', label: 'Repositories' },
        ],
        activeId: rt.state.repos.activeTab,
        trackBackground: true,
        onChange: (id) => handlers.switchTab(id === 'repos' ? 'repos' : 'spike'),
    });

    const pane = root.ownerDocument.createElement('div');
    pane.style.marginTop = '8px';
    root.append(pane);

    const board = mountBindingsBoard({ rt, pane, handlers });
    const runs = mountRunsBoard({ rt, pane, handlers });
    const form = mountAddForm({ rt, pane, handlers });

    return {
        tabs,
        pane,
        status: board.status,
        bindingsList: board.bindingsList,
        refreshBindings: board.refreshBindings,
        repoField: form.repoField,
        accountSelect: form.accountSelect,
        projectSelect: form.projectSelect,
        assignmentCheck: form.assignment,
        mentionCheck: form.mention,
        reviewRequestCheck: form.reviewRequest,
        worktreeSelect: form.worktree,
        addBinding: form.add,
        toggleSelected: form.toggle,
        removeSelected: form.removeSelected,
        removeAccount: form.removeAccount,
        note: form.note,
        runs,
        dispose: () => {
            pane.remove();
        },
    };
}

/**
 * Narrow the project picker's options for the add form's select.
 *
 * @param rt - Panel runtime.
 * @returns The options, only when a ready list is loaded.
 */
function pickerOptionsFor(rt: PanelRuntime): SelectOption[] {
    const { projects } = rt.state;
    if (projects.status !== 'ready') {
        return [];
    }

    return projects.projects.map((project) => ({
        id: project.id,
        label: `${project.name} · ${project.id}`,
    }));
}

/**
 * Repaint the pane from state.
 *
 * @param rt - Panel runtime.
 * @param view - The mounted pane.
 */
export function repaintReposPane(rt: PanelRuntime, view: ReposPane): void {
    const { repos } = rt.state;
    const accounts = repos.accounts.filter((account) => account.usable);

    view.tabs.update({ activeId: repos.activeTab });
    view.status.update({ text: composeStatus(repos) });
    view.bindingsList.update({ items: bindingRows(repos) });
    view.refreshBindings.update({ disabled: repos.status === 'loading' });
    view.repoField.update({ value: repos.repoInput });
    view.accountSelect.update({
        options: accounts.map((account) => ({ id: account.numericUserId, label: account.login })),
        value: repos.accountSelection,
        disabled: repos.status !== 'ready' || accounts.length === 0,
    });
    view.projectSelect.update({
        options: pickerOptionsFor(rt),
        value: repos.repoProjectSelection,
        disabled: repos.status !== 'ready',
    });
    view.assignmentCheck.update({ checked: repos.triggerAssignment });
    view.mentionCheck.update({ checked: repos.triggerMention });
    view.reviewRequestCheck.update({ checked: repos.triggerReviewRequest });
    view.worktreeSelect.update({ value: repos.worktreeSelection });
    view.addBinding.update({ disabled: repos.status !== 'ready' });
    view.toggleSelected.update({ disabled: repos.selectedBinding === null });
    view.removeSelected.update({ disabled: repos.selectedBinding === null });
    view.removeAccount.update({
        label: repos.removeAccountArmed ? REMOVE_ACCOUNT_CONFIRM_LABEL : REMOVE_ACCOUNT_IDLE_LABEL,
        disabled: repos.status !== 'ready' && !repos.removeAccountArmed,
    });
    view.note.update({ text: repos.note });

    // Runs section (M8 + 003 T-025): its own repaint, because its affordance
    // table decides which control group exists at all.
    repaintRunsBoard(rt, view.runs);
}
