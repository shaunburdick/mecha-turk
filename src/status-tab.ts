/**
 * The Status tab's surface: mount, repaint, and the one read (FR-019, FR-030).
 *
 * The copy this tab prints lives in [`status-lines.ts`](./status-lines.ts)
 * and the document it prints from in
 * [`status-document.ts`](./status-document.ts); this module owns only the
 * handles and the read that feeds them. Two blocking notices sit above the
 * sections because they are facts rather than rows: an unsupported surface
 * (FR-036) and an unwritable data directory (FR-035), whose copy names the
 * consequence — the token handoff pre-flight fails, so an account cannot be
 * added.
 *
 * The read is explicit (FR-014): the panel reads it once at mount and the
 * tab offers a refresh; activating the already-active tab reads nothing. A
 * failed read keeps the last document and marks it stale (FR-019) rather than
 * blanking the tab with a reassuring summary built from nothing.
 *
 * This module repaints itself instead of being reached from
 * `panel-ui.refresh`: its content depends on nothing but its own slice, so a
 * call inside the shared refresh would buy nothing and would put a back-edge
 * in a module graph where `refresh` is currently a leaf.
 */

import { mountBanner, mountButton } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle } from '@openchamber/sdk/ui';
import { STATUS_PATH } from './handoff-status.ts';
import { nowIso } from './ids.ts';
import { redact } from './redaction.ts';
import { refresh } from './panel-ui.ts';
import { CONFIG_PATH, serviceGet } from './service-calls.ts';
import {
    accountLines,
    agentPinLines,
    bindingLines,
    noticeStates,
    pollingLines,
    projectGuidanceLines,
    readStateLine,
    serviceLines,
} from './status-lines.ts';
import { createBlock, createRowList, EM_DASH_SEPARATOR, lineRow, mountCell, splitLine } from './style.ts';
import type { Block, Cell, DefRow, LineInput } from './style.ts';
import { configuredIntervalFrom, parseStatusView } from './status-document.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Heading above the projection's service block. */
const SERVICE_HEADING = 'Service';

/** Heading above the polling block; the effective interval lives here (FR-039). */
const POLLING_HEADING = 'Polling';

/** Heading above the per-account rows (FR-030). */
const ACCOUNTS_HEADING = 'Accounts';

/** Heading above the per-binding rows — the wire says `repositories` (FR-026). */
const BINDINGS_HEADING = 'Bindings';

/** Heading above the agent-pin block (FR-033). */
const AGENT_PIN_HEADING = 'Agent pin';

/** Label treatment for the two groups whose subjects are identifiers. */
const SUBJECT_KEY_CLASS = 'mt-key--mono';

/** Inputs for {@link mountNotice}; one object so the two notices stay ordered. */
interface NoticeInput {
    /** Element to append into. */
    readonly parent: HTMLElement;
    /** Banner tone; the copy carries the state as well (FR-083). */
    readonly tone: 'warning' | 'error';
    /** Banner title. */
    readonly title: string;
    /** Banner copy. */
    readonly body: string;
    /** Whether the wrapper starts hidden. */
    readonly hidden: boolean;
}

/** A heading plus the rows under it, repainted as one group. */
export interface StatusRowGroup {
    /** The block surface: heading above, body below. */
    readonly block: Block;
    /** The row list every line of this group renders into. */
    readonly list: HTMLElement;
    /** Class words for this group's label cells, or `null` for the default. */
    readonly keyClass: string | null;
    /** One row per line; rebuilt whenever the line set changes. */
    rows: readonly DefRow[];
}

/** One of the two blocking notices, wrapped so it can be shown and hidden. */
export interface StatusNotice {
    /** Wrapper whose `hidden` flag is "there is nothing to report here". */
    readonly box: HTMLElement;
    /** The banner inside the wrapper (FR-035, FR-036). */
    readonly banner: BannerHandle;
}

/** What the Status body mounts, and what a repaint updates. */
export interface StatusTabUi {
    /** Unsupported-surface notice, hidden while the surface supports a service (FR-036). */
    readonly unsupported: StatusNotice;
    /** Blocking storage notice, hidden while the data directory is writable (FR-035). */
    readonly storageBlocked: StatusNotice;
    /** Explicit refresh — the tab's one way to re-read (FR-014). */
    readonly refreshButton: ButtonHandle;
    /** One line of read state: loading, loaded with a stamp, failed with a cause. */
    readonly readLine: Cell;
    /** Process health, uptime, location, schema, storage. */
    readonly service: StatusRowGroup;
    /** Effective interval, configured interval, cadence, and next poll. */
    readonly polling: StatusRowGroup;
    /** One row per account, with its rate baseline. */
    readonly accounts: StatusRowGroup;
    /** One row per binding, under the heading **Bindings**. */
    readonly bindings: StatusRowGroup;
    /** The Default Agent pin's three shapes. */
    readonly agentPin: StatusRowGroup;
}

/**
 * Whether the runtime has been torn down.
 *
 * A function call rather than a bare `rt.disposed` read: the analyzer narrows
 * that property across the first `await` and then reports a later direct
 * check as unreachable, while the frame really can go away between two awaits.
 *
 * @param rt - Panel runtime.
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Create a notice banner inside a wrapper the tab can hide.
 *
 * @param input - Where it mounts, its tone and copy, and its initial state.
 * @returns The wrapped notice.
 */
function mountNotice(input: NoticeInput): StatusNotice {
    const box = input.parent.ownerDocument.createElement('div');
    box.hidden = input.hidden;
    input.parent.append(box);

    return { box, banner: mountBanner(box, { tone: input.tone, title: input.title, body: input.body }) };
}

/**
 * Rows whose *value* is machine-shaped — a path, a stamp — and so reads best
 * in the mono stack. Matched against the label the split produced, so a
 * service that reorders its block cannot quietly turn a path into
 * proportional text.
 */
const MONO_VALUE_LABELS: readonly string[] = ['Data directory', 'Next poll'];

/**
 * Build one row's inputs from the line the copy module produced.
 *
 * @param group - The group the row belongs to, for its label treatment.
 * @param line - One line of this group's copy.
 * @returns The line, plus the cell classes this row takes.
 */
function rowInput(group: StatusRowGroup, line: string): LineInput {
    const split = splitLine(line);
    const machine = split !== null && MONO_VALUE_LABELS.includes(split.key);
    const subject = split !== null && split.separator === EM_DASH_SEPARATOR;

    return {
        line,
        ...(machine ? { valueClass: 'mt-val--mono' } : {}),
        ...(subject && group.keyClass !== null ? { keyClass: group.keyClass } : {}),
    };
}

/**
 * Create one heading-and-rows block.
 *
 * The heading is the block's own element rather than a text row, which is
 * what gives each group a place in the tab's heading hierarchy and its own
 * surface to sit on.
 *
 * @param parent - Element to append into.
 * @param input - The section heading, and the label treatment its rows take.
 * @returns The group, with no rows yet.
 */
function mountRowGroup(
    parent: HTMLElement,
    input: { readonly heading: string; readonly keyClass?: string },
): StatusRowGroup {
    const block = createBlock(parent, { heading: input.heading });

    return {
        block,
        list: createRowList(block.body),
        keyClass: input.keyClass ?? null,
        rows: [],
    };
}

/**
 * Paint a group's rows, rebuilding them on every pass.
 *
 * A row is a label cell and a value cell, and which one a line becomes is a
 * fact about the line — so repainting in place would leave a row showing a
 * label it no longer has. Rebuilding keeps exactly one row per line, and the
 * handles are released as they go.
 *
 * @param group - The group to repaint.
 * @param lines - The lines to show, one per row.
 */
function paintRowGroup(group: StatusRowGroup, lines: readonly string[]): void {
    for (const row of group.rows) {
        row.dispose();
    }

    group.rows = lines.map((line) => lineRow(group.list, rowInput(group, line)));
}

/**
 * Remove one group's nodes and handles.
 *
 * @param group - The group to dispose.
 */
function disposeRowGroup(group: StatusRowGroup): void {
    for (const row of group.rows) {
        row.dispose();
    }

    group.block.dispose();
}

/**
 * The project ids the host lists, or `null` until that list has loaded.
 *
 * `null` is load-bearing: the guidance line claims a project is *not
 * registered*, and it may only claim that from a list that actually arrived.
 *
 * @param rt - Panel runtime whose picker state the answer comes from.
 * @returns The registered ids, or `null` when they are not known yet.
 */
function registeredProjects(rt: PanelRuntime): readonly string[] | null {
    const picker = rt.state.projects;

    return picker.status === 'ready' ? picker.projects.map((project) => project.id) : null;
}

/**
 * Repaint the Status body from the current read (FR-019, FR-030).
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it (FR-013).
 *
 * @param rt - Panel runtime.
 */
export function repaintStatusTab(rt: PanelRuntime): void {
    const ui = rt.statusUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.statusTab;
    const view = slice.doc;
    const loading = slice.phase === 'loading';

    ui.refreshButton.update({ disabled: loading, loading });
    ui.readLine.update(readStateLine(slice));

    // The two blocking notices are facts about the *last* document the panel
    // holds; with nothing read there is nothing to claim either way.
    const notices = noticeStates(view);
    ui.unsupported.box.hidden = !notices.unsupported;
    ui.storageBlocked.box.hidden = !notices.storageBlocked;

    if (view === null) {
        for (const group of [ui.service, ui.polling, ui.accounts, ui.bindings, ui.agentPin]) {
            paintRowGroup(group, []);
        }

        return;
    }

    paintRowGroup(ui.service, serviceLines(view));
    paintRowGroup(ui.polling, pollingLines({ view, configured: slice.configuredIntervalMs, nowMs: Date.now() }));
    paintRowGroup(ui.accounts, accountLines(view));
    paintRowGroup(ui.bindings, [
        ...bindingLines(view),
        ...projectGuidanceLines({ bindings: view.bindings, registeredProjectIds: registeredProjects(rt) }),
    ]);
    paintRowGroup(ui.agentPin, agentPinLines(view));
}

/**
 * Repaint the shared framing and then this tab, after one step of a read.
 *
 * @param rt - Panel runtime.
 */
function repaintAfterRead(rt: PanelRuntime): void {
    refresh(rt);
    repaintStatusTab(rt);
}

/**
 * Read `GET /v1/status` (and the configured interval beside it).
 *
 * The status read is the tab's own: if it fails, the tab says so and keeps
 * whatever it last rendered marked stale. The configuration read is
 * supplementary — its failure renders as *not read* on one line rather than
 * failing a tab whose primary document arrived (FR-039, FR-019).
 *
 * @param rt - Panel runtime.
 */
export async function loadStatus(rt: PanelRuntime): Promise<void> {
    const slice = rt.state.statusTab;
    if (rt.disposed || slice.phase === 'loading') {
        return;
    }

    slice.phase = 'loading';
    repaintAfterRead(rt);

    const status = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: STATUS_PATH });
    if (tornDown(rt)) {
        return;
    }

    const view = status.ok ? parseStatusView(status.body) : null;
    if (view === null) {
        slice.phase = 'failed';
        slice.problem = redact(
            status.ok ? 'the service answered a status document the panel could not read' : status.problem,
        );
        slice.stale = slice.doc !== null;
        repaintAfterRead(rt);

        return;
    }

    const config = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: CONFIG_PATH });
    if (tornDown(rt)) {
        return;
    }

    slice.doc = view;
    slice.configuredIntervalMs = config.ok ? configuredIntervalFrom(config.body) : null;
    slice.phase = 'loaded';
    slice.problem = null;
    slice.stale = false;
    slice.at = nowIso();
    rt.shell?.noteRead('status', slice.at);
    repaintAfterRead(rt);
}

/**
 * Mount the refresh control and the read-state line (FR-014, FR-019).
 *
 * @param rt - Panel runtime whose read state the line reports.
 * @param parent - Element to append into.
 * @returns The two handles.
 */
function mountControls(rt: PanelRuntime, parent: HTMLElement): {
    readonly refreshButton: ButtonHandle;
    readonly readLine: Cell;
} {
    const row = parent.ownerDocument.createElement('div');
    row.className = 'mt-toolbar';
    parent.append(row);

    const refreshButton = mountButton(row, {
        label: 'Refresh status',
        onClick: () => {
            void loadStatus(rt);
        },
    });

    return {
        refreshButton,
        readLine: mountCell(row, { className: 'mt-lede', text: readStateLine(rt.state.statusTab) }),
    };
}

/**
 * Mount the Status body above the prerequisites section (FR-030, FR-037).
 *
 * @param input - Runtime and the Status body container the shell created.
 * @returns The handles a repaint updates.
 */
export function mountStatusTab(input: {
    /** Runtime whose state the tab reads. */
    readonly rt: PanelRuntime;
    /** The Status body container the shell created. */
    readonly parent: HTMLElement;
}): StatusTabUi {
    const { rt, parent } = input;
    // Top of the tab, in FR-036's order: the blocking facts come before
    // anything that could read as a healthy row.
    const unsupported = mountNotice({
        parent,
        tone: 'warning',
        title: 'Unsupported surface',
        body: 'OpenChamber cannot run a local service here, so polling, custody, and the relay are not operating.',
        hidden: true,
    });
    const storageBlocked = mountNotice({
        parent,
        tone: 'error',
        title: 'Storage is not writable',
        body: 'The token handoff pre-flight fails, so no account can be added until the data directory accepts writes.',
        hidden: true,
    });
    const controls = mountControls(rt, parent);

    const ui: StatusTabUi = {
        unsupported,
        storageBlocked,
        ...controls,
        service: mountRowGroup(parent, { heading: SERVICE_HEADING }),
        polling: mountRowGroup(parent, { heading: POLLING_HEADING }),
        accounts: mountRowGroup(parent, { heading: ACCOUNTS_HEADING, keyClass: SUBJECT_KEY_CLASS }),
        bindings: mountRowGroup(parent, { heading: BINDINGS_HEADING, keyClass: SUBJECT_KEY_CLASS }),
        agentPin: mountRowGroup(parent, { heading: AGENT_PIN_HEADING }),
    };
    rt.statusUi = ui;
    repaintStatusTab(rt);

    return ui;
}

/**
 * Dispose the Status body's handles (FR-017).
 *
 * @param rt - Panel runtime being torn down.
 */
export function disposeStatusTab(rt: PanelRuntime): void {
    const ui = rt.statusUi;
    if (ui === null) {
        return;
    }

    ui.unsupported.banner.dispose();
    ui.unsupported.box.remove();
    ui.storageBlocked.banner.dispose();
    ui.storageBlocked.box.remove();
    ui.refreshButton.dispose();
    ui.readLine.dispose();
    disposeRowGroup(ui.service);
    disposeRowGroup(ui.polling);
    disposeRowGroup(ui.accounts);
    disposeRowGroup(ui.bindings);
    disposeRowGroup(ui.agentPin);
    rt.statusUi = null;
}
