/**
 * The Status tab's surface: mount, repaint, and the one read (FR-019, FR-030).
 *
 * The copy this tab prints lives in [`status-lines.ts`](./status-lines.ts)
 * and the document it prints from in
 * [`status-document.ts`](./status-document.ts); this module owns only the
 * handles and the read that feeds them. The tab opens with one title block
 * whose heading is the tab title, and the two blocking notices sit inside it
 * above the refresh control because they are facts rather than rows: an
 * unsupported surface (FR-036) and an unwritable data directory (FR-035),
 * whose copy names the consequence — the token handoff pre-flight fails, so an
 * account cannot be added.
 *
 * The read is explicit and repeating (FR-014, FR-100): the panel reads it once
 * at mount, on every activation of this tab, on a tick armed from the interval
 * the document itself reports, and on a press of the tab's own refresh control.
 * A failed read keeps the last document and marks it stale (FR-019) rather than
 * blanking the tab with a reassuring summary built from nothing, and a failing
 * tick is a failing read in every observable respect — including leaving the
 * armed period exactly where it was.
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
    actorPolicyLines,
    agentPinLines,
    bindingLines,
    cadenceLine,
    followUpQueueLine,
    noticeStates,
    pollingLines,
    projectGuidanceLines,
    readStateLine,
    serviceLines,
} from './status-lines.ts';
import { createBlock, createRowList, EM_DASH_SEPARATOR, lineRow, mountCell, splitLine } from './style.ts';
import type { Block, Cell, DefRow, LineInput } from './style.ts';
import { configuredIntervalFrom, parseStatusView } from './status-document.ts';
import { STATUS_TAB } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Heading above the projection's service block. */
const SERVICE_HEADING = 'Service';

/** Heading above the polling block; the effective interval lives here. */
const POLLING_HEADING = 'Polling';

/** Heading above the per-account rows. */
const ACCOUNTS_HEADING = 'Accounts';

/** Heading above the per-binding rows — the wire says `repositories`. */
const BINDINGS_HEADING = 'Bindings';

/** Heading above the agent-pin block. */
const AGENT_PIN_HEADING = 'Agent pin';

/** Heading above the follow-up queue block (002 FR-036, as amended). */
const FOLLOW_UPS_HEADING = 'Follow-ups';

/**
 * The tab title: the heading of the block every Status control lives in.
 *
 * One rule across the six tabs (product-owner review 2026-10-01) — the tab
 * title is the first block's heading, and the controls sit inside that block
 * rather than floating in the body above it.
 */
const OVERVIEW_HEADING = 'Status';

/** Label treatment for the two groups whose subjects are identifiers. */
const SUBJECT_KEY_CLASS = 'mt-key--mono';

/** Inputs for {@link mountNotice}; one object so the two notices stay ordered. */
interface NoticeInput {
    /** Element to append into. */
    readonly parent: HTMLElement;
    /** Banner tone; the copy carries the state as well. */
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
    /** The banner inside the wrapper. */
    readonly banner: BannerHandle;
}

/** What the Status body mounts, and what a repaint updates. */
export interface StatusTabUi {
    /** The first block: the tab title over the two notices and the controls. */
    readonly overview: Block;
    /** Unsupported-surface notice, hidden while the surface supports a service. */
    readonly unsupported: StatusNotice;
    /** Blocking storage notice, hidden while the data directory is writable. */
    readonly storageBlocked: StatusNotice;
    /** Explicit refresh — the tab's one on-demand read (FR-014). */
    readonly refreshButton: ButtonHandle;
    /** One line of read state: loading, loaded with a stamp, failed with a cause. */
    readonly readLine: Cell;
    /**
     * One line stating the tab's own refresh cadence and period, or that it is
     * not refreshing itself (FR-101).
     */
    readonly cadenceLine: Cell;
    /** Process health, uptime, location, schema, storage. */
    readonly service: StatusRowGroup;
    /** Effective interval, configured interval, cadence, and next poll. */
    readonly polling: StatusRowGroup;
    /** One row per account, with its rate baseline. */
    readonly accounts: StatusRowGroup;
    /** The allow-list roll-up, then one row per binding, under **Bindings**. */
    readonly bindings: StatusRowGroup;
    /** The Default Agent pin's three shapes. */
    readonly agentPin: StatusRowGroup;
    /**
     * The follow-ups waiting to be delivered (002 FR-036, as amended).
     *
     * Its own block rather than a line inside another group: the amendment
     * requires the queue to be reported *as a queue*, and a queue folded into
     * the service's health block reads as a service fact rather than as work
     * the panel owes.
     */
    readonly followUps: StatusRowGroup;
}


/**
 * Whether the runtime has been torn down.
 *
 * A function call rather than a bare `rt.disposed` read: the analyzer narrows
 * that property across the first `await` and then reports a later direct
 * check as unreachable, while the frame really can go away between two awaits.
 *
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Create a notice banner inside a wrapper the tab can hide.
 *
 * @returns The wrapped notice.
 */
function mountNotice(input: NoticeInput): StatusNotice {
    const box = input.parent.ownerDocument.createElement('div');
    box.hidden = input.hidden;
    input.parent.append(box);

    return { box, banner: mountBanner(box, { tone: input.tone, title: input.title, body: input.body }) };
}

/**
 * Rows whose *value* is isMachine-shaped — a path, a stamp — and so reads best
 * in the mono stack. Matched against the label the split produced, so a
 * service that reorders its block cannot quietly turn a path into
 * proportional text.
 */
const MONO_VALUE_LABELS: ReadonlySet<string> = new Set(['Data directory', 'Next poll']);

/**
 * Build one row's inputs from the line the copy module produced.
 *
 * @returns The line, plus the cell classes this row takes.
 */
function rowInput(group: StatusRowGroup, line: string): LineInput {
    const split = splitLine(line);
    const isMachine = split !== null && MONO_VALUE_LABELS.has(split.key);
    const isSubject = split !== null && split.separator === EM_DASH_SEPARATOR;

    return {
        line,
        ...(isMachine && { valueClass: 'mt-val--mono' }),
        ...(isSubject && group.keyClass !== null && { keyClass: group.keyClass }),
    };
}

/**
 * Create one heading-and-rows block.
 *
 * The heading is the block's own element rather than a text row, which is
 * what gives each group a place in the tab's heading hierarchy and its own
 * surface to sit on.
 *
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
 */
function paintRowGroup(group: StatusRowGroup, lines: readonly string[]): void {
    for (const row of group.rows) {
        row.dispose();
    }

    group.rows = lines.map((line) => lineRow(group.list, rowInput(group, line)));
}

/**
 * Remove one group's nodes and handles.
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
 * @returns The registered ids, or `null` when they are not known yet.
 */
function registeredProjects(rt: PanelRuntime): readonly string[] | null {
    const picker = rt.state.projects;

    return picker.status === 'ready' ? picker.projects.map((project) => project.id) : null;
}

/**
 * Repaint the Status body from the current read.
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it.
 */
export function repaintStatusTab(rt: PanelRuntime): void {
    const ui = rt.statusUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.statusTab;
    const view = slice.doc;
    const isLoading = slice.phase === 'loading';

    ui.refreshButton.update({ disabled: isLoading, loading: isLoading });
    ui.readLine.update(readStateLine(slice));
    // The cadence is a statement about what this tab is doing, not about the
    // service's scheduler, so it sits beside the refresh control rather than in
    // the Polling block (FR-039, FR-101).
    ui.cadenceLine.update(cadenceLine({ refreshMs: rt.statusRefreshMs }));

    // The two blocking notices are facts about the *last* document the panel
    // holds; with nothing read there is nothing to claim either way.
    const notices = noticeStates(view);
    ui.unsupported.box.hidden = !notices.unsupported;
    ui.storageBlocked.box.hidden = !notices.storageBlocked;

    if (view === null) {
        for (const group of [ui.service, ui.polling, ui.accounts, ui.bindings, ui.agentPin]) {
            paintRowGroup(group, []);
        }

        // The one exception to "nothing claimed with nothing read": the
        // allow-list roll-up states *not available* rather than vanishing,
        // because an operator who cannot see it cannot tell a missing warning
        // from a panel that did not check.
        paintRowGroup(ui.bindings, actorPolicyLines(view));
        // The follow-up queue is panel state, not part of the status document,
        // so it paints the same whether or not a document has landed.
        paintRowGroup(ui.followUps, [followUpQueueLine(rt.state.relay.waitingFollowUps)]);

        return;
    }

    paintRowGroup(ui.service, serviceLines(view));
    paintRowGroup(ui.polling, pollingLines({ view, configured: slice.configuredIntervalMs, nowMs: Date.now() }));
    paintRowGroup(ui.accounts, accountLines(view));
    paintRowGroup(ui.bindings, [
        ...actorPolicyLines(view),
        ...bindingLines(view),
        ...projectGuidanceLines({ bindings: view.bindings, registeredProjectIds: registeredProjects(rt) }),
    ]);
    paintRowGroup(ui.agentPin, agentPinLines(view));
    paintRowGroup(ui.followUps, [followUpQueueLine(rt.state.relay.waitingFollowUps)]);
}

/**
 * Repaint the shared framing and then this tab, after one step of a read.
 */
function repaintAfterRead(rt: PanelRuntime): void {
    refresh(rt);
    repaintStatusTab(rt);
}

/**
 * Release the refresh tick, and with it the period the tab was running on.
 *
 * Called when another tab takes over and when the tab's body is disposed, so
 * the tab claims no cadence it is not running (FR-100, FR-101) and no timer
 * survives the panel (NFR-108).
 */
export function stopStatusRefresh(rt: PanelRuntime): void {
    rt.statusRefreshMs = null;
    if (rt.statusRefreshTimer === null) {
        return;
    }

    clearInterval(rt.statusRefreshTimer);
    rt.statusRefreshTimer = null;
}

/**
 * Arm the tab's refresh tick on the interval the last landed document reported.
 *
 * Two properties are structural rather than tested for, because both are
 * FR-100's "at most one tick per panel" rule: the arm is idempotent for an
 * unchanged period (so re-entering the tab cannot leave a second timer behind),
 * and the period is a function of the reported interval **and nothing else** —
 * never of the last read's outcome, which is what keeps a cadence from
 * becoming the retry loop `contracts/panel-service.md` §1 forbids (FR-100).
 *
 * The tick's body is a parameter rather than a call to {@link loadStatus},
 * because the read arms this function and this function's timer calls the read:
 * naming the read here would make the two mutually referential, and the honest
 * shape is that arming is told what the timer runs. `loadStatus` is its only
 * caller and passes itself.
 *
 * @param input - The runtime, the period just read, and what the timer runs.
 */
export function armStatusRefresh(input: {
    /** Runtime whose tick slot is armed. */
    readonly rt: PanelRuntime;
    /** The effective `polling.intervalMs` just read. */
    readonly intervalMs: number;
    /** What the timer runs on each period. */
    readonly tick: () => void;
}): void {
    const { rt, intervalMs, tick } = input;
    // Nothing is armed for a torn-down panel or for a background tab: the tick
    // belongs to Status only while Status is what the operator is looking at
    // (FR-100), and a timer that outlived its tab would repaint a hidden body.
    if (rt.disposed || rt.activeTab !== STATUS_TAB) {
        return;
    }

    if (rt.statusRefreshMs === intervalMs && rt.statusRefreshTimer !== null) {
        return;
    }

    stopStatusRefresh(rt);
    rt.statusRefreshMs = intervalMs;
    // Unref'd like the relay's loop, so an idle panel never holds a process
    // open; teardown clears it through `disposeStatusTab` (NFR-108).
    rt.statusRefreshTimer = setInterval(tick, intervalMs);
    if (typeof rt.statusRefreshTimer.unref === 'function') {
        rt.statusRefreshTimer.unref();
    }
}

/**
 * Read `GET /v1/status` (and the configured interval beside it).
 *
 * The status read is the tab's own: if it fails, the tab says so and keeps
 * whatever it last rendered marked stale. The configuration read is
 * supplementary — its failure renders as *not read* on one line rather than
 * failing a tab whose primary document arrived.
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
    // The armed period follows this document: a service whose interval changed
    // has said so, and the tick is not pinned to what it was armed with
    // (FR-030, FR-100). Arming *after* the slice lands and *before* the repaint
    // is what makes the cadence statement and the timer agree on one number.
    armStatusRefresh({
        rt,
        intervalMs: view.polling.intervalMs,
        tick: () => {
            void loadStatus(rt);
        },
    });
    repaintAfterRead(rt);
}

/**
 * Mount the refresh control and the read-state line.
 *
 * @returns The two handles.
 */
function mountControls(rt: PanelRuntime, parent: HTMLElement): {
    readonly refreshButton: ButtonHandle;
    readonly readLine: Cell;
    readonly cadenceLine: Cell;
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
        // Mounted already stating the honest value: the first read has not run
        // yet, so no period is known and the tab says it is not refreshing
        // itself rather than showing a number nobody reported (FR-101, NFR-112).
        cadenceLine: mountCell(row, { className: 'mt-lede', text: cadenceLine({ refreshMs: rt.statusRefreshMs }) }),
    };
}

/**
 * Mount the Status body above the prerequisites section.
 *
 * @returns The handles a repaint updates.
 */
export function mountStatusTab(input: {
    /** Runtime whose state the tab reads. */
    readonly rt: PanelRuntime;
    /** The Status body container the shell created. */
    readonly parent: HTMLElement;
}): StatusTabUi {
    const { rt, parent } = input;
    // One rule across the six tabs: the tab title is the
    // first block's heading, and the tab's controls live inside that block.
    // The two blocking notices go in with them own order — the
    // blocking facts still come before anything that could read as healthy.
    const overview = createBlock(parent, { heading: OVERVIEW_HEADING, title: true });
    const unsupported = mountNotice({
        parent: overview.body,
        tone: 'warning',
        title: 'Unsupported surface',
        body: 'OpenChamber cannot run a local service here, so polling, custody, and the relay are not operating.',
        hidden: true,
    });
    const storageBlocked = mountNotice({
        parent: overview.body,
        tone: 'error',
        title: 'Storage is not writable',
        body: 'The token handoff pre-flight fails, so no account can be added until the data directory accepts writes.',
        hidden: true,
    });
    const controls = mountControls(rt, overview.body);

    const ui: StatusTabUi = {
        overview,
        unsupported,
        storageBlocked,
        ...controls,
        service: mountRowGroup(parent, { heading: SERVICE_HEADING }),
        polling: mountRowGroup(parent, { heading: POLLING_HEADING }),
        accounts: mountRowGroup(parent, { heading: ACCOUNTS_HEADING, keyClass: SUBJECT_KEY_CLASS }),
        bindings: mountRowGroup(parent, { heading: BINDINGS_HEADING, keyClass: SUBJECT_KEY_CLASS }),
        agentPin: mountRowGroup(parent, { heading: AGENT_PIN_HEADING }),
        followUps: mountRowGroup(parent, { heading: FOLLOW_UPS_HEADING }),
    };
    rt.statusUi = ui;
    repaintStatusTab(rt);

    return ui;
}

/**
 * Dispose the Status body's handles.
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
    ui.cadenceLine.dispose();
    ui.overview.dispose();
    disposeRowGroup(ui.service);
    disposeRowGroup(ui.polling);
    disposeRowGroup(ui.accounts);
    disposeRowGroup(ui.bindings);
    disposeRowGroup(ui.agentPin);
    disposeRowGroup(ui.followUps);
    rt.statusUi = null;
    stopStatusRefresh(rt);
}
