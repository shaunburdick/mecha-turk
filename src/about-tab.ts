/**
 * The About tab: static identity plus the read-only Diagnostics section
 * (005 T-028; FR-074–FR-077, FR-029, AC-132–AC-134, SC-109).
 *
 * **The version has exactly one source.** It is read from the service's own
 * health answer (`GET /health` serves `SERVICE_VERSION`, which mirrors
 * `package.json`), and this module carries **no version literal of its own** —
 * not a number, not a pre-release figure, nothing that could ever disagree
 * with the service. When the service cannot be reached the tab prints the
 * exact words *unknown (service unreachable)*, naming the service as the
 * source, instead of synthesising a plausible number (FR-074, NFR-112).
 * `tests/about-tab.test.ts` pins the path constant to the route the service
 * registers and scans `src/` for version-shaped literals, so neither half of
 * that rule can rot.
 *
 * The static half — product name, panel id, data directory and its backup
 * statement, the short vocabulary mapping, the manual-cleanup posture, and
 * the release posture — renders with or without the service (FR-078).
 *
 * **Diagnostics is read-only by design** (FR-075): it shows the ledger as
 * `#seq · kind · time` lines, the two schema versions, and the phase record.
 * It deliberately renders **no entry detail**, so an account identifier, a
 * prompt, a fingerprint, or a filesystem path has no way into this section
 * (FR-076), and it offers nothing that writes — the spike-era phase writer
 * left with the tab it lived on (FR-011).
 */

import { mountBanner, mountButton, mountList } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, ListHandle, TextHandle } from '@openchamber/sdk/ui';
import { EVIDENCE_SCHEMA_VERSION } from './evidence.ts';
import { parseJsonObject } from './json.ts';
import { nowIso } from './ids.ts';
import { LEDGER_SCHEMA_VERSION, ledgerTail } from './ledger.ts';
import { HEALTH_PATH, serviceGet } from './service-calls.ts';
import { createBlock, mountStyledText } from './style.ts';
import { VOCABULARY_HEADING, VOCABULARY_LIST_ITEMS } from './vocabulary.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The panel id the manifest declares (`AGENTS.md` invariant 4). */
const PANEL_ID = 'mecha-turk';

/** The product name the manifest declares. */
const PRODUCT_NAME = 'Mecha Turk';

/** What About shows for a version it could not read (FR-074, AC-134). */
const VERSION_UNREACHABLE = 'unknown (service unreachable)';

/** What About shows before the first health answer lands (contract §2). */
const VERSION_UNREAD = 'Version: not yet read';

/** How many ledger lines the diagnostics section shows, newest first. */
const VISIBLE_ENTRIES = 25;

/** Start offset of the time part inside an RFC 3339 timestamp. */
const TIME_START = 11;

/** End offset of the time part inside an RFC 3339 timestamp. */
const TIME_END = 19;

/** Heading above the identity block. */
const ABOUT_HEADING = 'About';

/** Heading above the read-only record (FR-075). */
const DIAGNOSTICS_HEADING = 'Diagnostics (read-only)';

/** What the re-read control is called; also the failure notice's retry. */
const RETRY_LABEL = 'Retry version read';

/** Title of the failure notice, whatever the failure was. */
const FAILURE_TITLE = 'Version not read';

/** The version's source, stated so a failure has somewhere to point (FR-074). */
const VERSION_SOURCE =
    "Version source: the local service's health answer. This panel carries no version of its own.";

/** The manual-cleanup posture, naming the surfaces that perform it (FR-077). */
const CLEANUP_POSTURE =
    'Cleanup: Mecha Turk creates sessions and worktrees and never removes them — the platform exposes ' +
    "no deletion API to extensions. Remove them from OpenChamber's own Sessions and Worktrees surfaces.";

/** The release posture, without a version literal of any kind (FR-075). */
const RELEASE_POSTURE =
    'Release posture: pre-release. This extension has not reached its first stable release, and a ' +
    'version bump is a product-owner decision, never a side effect of an update.';

/** The data-directory line while no status document has been read (FR-078). */
const DATA_DIR_UNREAD =
    "Data directory: not read yet — the Status tab's service block reports it, and this tab shows it here.";

/** What the ledger section says when this mount has recorded nothing. */
const LEDGER_EMPTY = 'No ledger entries yet.';

/**
 * Where the About tab's version read stands (FR-019, FR-074).
 *
 * `version` is deliberately separate from `phase`: a failed re-read keeps the
 * version that did land (and the read line marks it stale) rather than
 * replacing a real answer with the unreachable copy.
 */
export interface AboutTabState {
    /** Read phase: nothing yet, in flight, landed, or refused. */
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    /** RFC 3339 stamp of the read that last landed, or `null`. */
    at: string | null;
    /** Why the last read failed; `null` while there is nothing to report. */
    problem: string | null;
    /** The version the service answered, or `null` when it never did. */
    version: string | null;
}

/**
 * Build the empty About tab state.
 *
 * @returns The state before the first read.
 */
export function initialAboutTab(): AboutTabState {
    return { phase: 'idle', at: null, problem: null, version: null };
}

/** The mounted About tab: the handles a repaint updates, plus disposal. */
export interface AboutTabUi {
    /** Body root this view mounted into. */
    readonly pane: HTMLElement;
    /** Product name and the panel id it installs under (FR-075). */
    readonly identity: TextHandle;
    /** The single version line (FR-074). */
    readonly version: TextHandle;
    /** The version's one source, stated statically (FR-074). */
    readonly versionSource: TextHandle;
    /** The tab's only control: an explicit re-read of the health answer. */
    readonly retry: ButtonHandle;
    /** One line of read state: idle, loading, landed, or failed with a cause. */
    readonly readLine: TextHandle;
    /** Wrapper around the failure notice, hidden while nothing failed. */
    readonly failureBox: HTMLElement;
    /** Failure notice naming what could not be read and from where (FR-078). */
    readonly failure: BannerHandle;
    /** The data directory, and the statement that it is what to back up. */
    readonly dataDir: TextHandle;
    /** The short vocabulary mapping (FR-029), rendered as its own list. */
    readonly vocabulary: ListHandle;
    /** The manual-cleanup posture (FR-077). */
    readonly cleanup: TextHandle;
    /** The release posture (FR-075). */
    readonly release: TextHandle;
    /** The two schema versions this build ships (FR-075). */
    readonly schemas: TextHandle;
    /** The phase record, read-only (FR-075). */
    readonly phaseRecord: TextHandle;
    /** The ledger, newest first, as text (FR-075). */
    readonly ledger: TextHandle;
    /** Remove every node and handle this view mounted (FR-017). */
    readonly dispose: () => void;
}

/**
 * Format an RFC 3339 timestamp as `HH:MM:SS`.
 *
 * @param iso - Timestamp to format.
 * @returns The time slice, or the raw value when it is too short.
 */
function formatTime(iso: string): string {
    return iso.length > TIME_END ? iso.slice(TIME_START, TIME_END) : iso;
}

/**
 * The version line: read, unread, or unreachable — never a synthesised
 * number (FR-074, AC-133, AC-134).
 *
 * @param slice - The About tab's read state.
 * @returns The line the tab paints.
 */
export function versionLine(slice: AboutTabState): string {
    if (slice.version !== null) {
        return `Version: ${slice.version}`;
    }

    if (slice.phase === 'failed') {
        return `Version: ${VERSION_UNREACHABLE}`;
    }

    return VERSION_UNREAD;
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
 * @param slice - The About tab's read state.
 * @returns The read-state line the tab paints.
 */
export function readStateLine(slice: AboutTabState): string {
    if (slice.phase === 'idle') {
        return 'Version: not read yet.';
    }

    if (slice.phase === 'loading') {
        return 'Version: reading…';
    }

    if (slice.phase === 'loaded') {
        return `Version: read at ${slice.at ?? 'an unknown time'}.`;
    }

    const cause = slice.problem ?? 'the service did not answer';
    if (slice.version === null) {
        return `Version could not be read: ${cause}. Nothing has been read yet.`;
    }

    return `Version could not be re-read: ${cause}. Showing the read from ${slice.at}, which may be stale.`;
}

/**
 * The data-directory line, from the status projection the panel already
 * holds (FR-075, FR-076: this is the only path About may show).
 *
 * @param rt - Panel runtime whose status document the line reads.
 * @returns The line naming the directory, or its honest *not read* form.
 */
export function dataDirLine(rt: PanelRuntime): string {
    const { doc } = rt.state.statusTab;
    if (doc === null) {
        return DATA_DIR_UNREAD;
    }

    return `Data directory: ${doc.service.dataDir} — this is the directory to back up.`;
}

/**
 * The phase record, read-only (FR-075).
 *
 * @param rt - Panel runtime whose ledger the line reads.
 * @returns The last recorded phase, or that there is none yet.
 */
export function phaseRecordLine(rt: PanelRuntime): string {
    const phase = [...rt.state.ledger.entries].reverse().find((entry) => entry.kind === 'phase');
    if (phase === undefined) {
        return 'Phase record: none recorded yet.';
    }

    return `Phase record: ${phase.phase ?? 'unknown'} at ${phase.at} — read-only; this tab writes nothing.`;
}

/**
 * The ledger as text: sequence, kind, and time, newest first (FR-075).
 *
 * Entry **detail is deliberately not rendered**: it is free-form text the
 * panel recorded about a dispatch, and FR-076 keeps this section free of
 * account identifiers, prompts, fingerprints, and paths.
 *
 * @param rt - Panel runtime whose ledger the lines read.
 * @returns The lines, or the empty-state sentence.
 */
export function ledgerLines(rt: PanelRuntime): string {
    const entries = ledgerTail(rt.state.ledger, VISIBLE_ENTRIES);
    if (entries.length === 0) {
        return LEDGER_EMPTY;
    }

    return entries
        .map((entry) => {
            const what = entry.kind === 'phase' ? `phase: ${entry.phase ?? 'unknown'}` : entry.kind;

            return `#${entry.seq} · ${what} · ${formatTime(entry.at)}`;
        })
        .join('\n');
}

/**
 * Repaint the About tab from state (FR-019, FR-074, FR-075).
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it (FR-013).
 *
 * @param rt - Panel runtime.
 */
export function repaintAboutTab(rt: PanelRuntime): void {
    const ui = rt.aboutUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.aboutTab;
    const loading = slice.phase === 'loading';

    ui.version.update({ text: versionLine(slice) });
    ui.readLine.update({ text: readStateLine(slice) });
    ui.retry.update({ disabled: loading, loading });
    ui.failureBox.hidden = slice.phase !== 'failed';
    if (slice.phase === 'failed') {
        ui.failure.update({
            tone: 'warning',
            title: FAILURE_TITLE,
            body:
                `${slice.problem ?? 'the service did not answer'} — the version comes from the local ` +
                "service's health answer. Refresh to try again.",
        });
    }

    ui.dataDir.update({ text: dataDirLine(rt) });
    ui.phaseRecord.update({ text: phaseRecordLine(rt) });
    ui.ledger.update({ text: ledgerLines(rt) });
}

/**
 * Read the version out of a health answer, fail closed.
 *
 * @param body - Response body text.
 * @returns The version string, or `null` when the answer carries none.
 */
function versionFrom(body: string): string | null {
    const parsed = parseJsonObject(body);
    const version = parsed === null ? null : parsed.version;

    return typeof version === 'string' && version !== '' ? version : null;
}

/**
 * Whether the runtime was torn down mid-read: a call rather than a bare
 * `rt.disposed` read, so the analyzer cannot narrow the check away.
 *
 * @param rt - Panel runtime.
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Read the service's health answer and take its version (FR-074).
 *
 * Fail closed: an answer the panel cannot read is a failed read, never a
 * value. The tab retries only on an explicit operator action (contract §2).
 *
 * @param rt - Panel runtime.
 */
export async function loadVersion(rt: PanelRuntime): Promise<void> {
    const slice = rt.state.aboutTab;
    if (rt.disposed || slice.phase === 'loading') {
        return;
    }

    slice.phase = 'loading';
    repaintAboutTab(rt);

    const answer = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: HEALTH_PATH });
    if (tornDown(rt)) {
        return;
    }

    const version = answer.ok ? versionFrom(answer.body) : null;
    if (version === null) {
        slice.phase = 'failed';
        slice.problem = answer.ok
            ? 'the service answered a health document the panel could not read'
            : answer.problem;
        repaintAboutTab(rt);

        return;
    }

    slice.version = version;
    slice.phase = 'loaded';
    slice.problem = null;
    slice.at = nowIso();
    rt.shell?.noteRead('about', slice.at);
    repaintAboutTab(rt);
}

/**
 * Mount the heading, the identity line, the version line, and its source
 * (FR-074, FR-075).
 *
 * @param input - Runtime whose read state paints the version, and the pane.
 * @returns The four handles.
 */
function mountHeader(input: {
    /** Runtime whose read state the version line renders. */
    readonly rt: PanelRuntime;
    /** Pane the four mount into. */
    readonly pane: HTMLElement;
}): {
    readonly identity: TextHandle;
    readonly version: TextHandle;
    readonly versionSource: TextHandle;
} {
    const { pane } = input;
    // `.mt-prose` on all three: without it these three measured their own edge.
    const identity = mountStyledText(pane, { className: 'mt-prose', text: `${PRODUCT_NAME} — panel id: ${PANEL_ID}` });
    const version = mountStyledText(pane, { className: 'mt-prose', text: versionLine(input.rt.state.aboutTab) });
    const versionSource = mountStyledText(pane, { className: 'mt-prose', text: VERSION_SOURCE });

    return { identity, version, versionSource };
}

/**
 * Mount the re-read row and the failure notice behind it (FR-078).
 *
 * @param input - Runtime whose read the control starts, and the pane.
 * @returns The four handles plus the notice wrapper.
 */
function mountRetryRow(input: {
    /** Runtime whose read state the control re-reads. */
    readonly rt: PanelRuntime;
    /** Pane the row mounts into. */
    readonly pane: HTMLElement;
}): {
    readonly retry: ButtonHandle;
    readonly readLine: TextHandle;
    readonly failureBox: HTMLElement;
    readonly failure: BannerHandle;
} {
    const row = input.pane.ownerDocument.createElement('div');
    row.className = 'mt-toolbar';
    input.pane.append(row);

    const retry = mountButton(row, {
        label: RETRY_LABEL,
        variant: 'secondary',
        onClick: (): void => {
            void loadVersion(input.rt);
        },
    });
    const readLine = mountStyledText(row, {
        className: 'mt-lede',
        text: readStateLine(input.rt.state.aboutTab),
    });

    const failureBox = input.pane.ownerDocument.createElement('div');
    failureBox.hidden = true;
    input.pane.append(failureBox);
    const failure = mountBanner(failureBox, {
        tone: 'warning',
        title: FAILURE_TITLE,
        body: "The local service's health answer did not arrive.",
    });

    return { retry, readLine, failureBox, failure };
}

/**
 * Mount the data directory and the three static statements (FR-075, FR-077).
 *
 * @param input - Runtime whose status document the directory line reads, and
 *   the pane the four mount into.
 * @returns The four handles.
 */
function mountStatements(input: {
    /** Runtime whose status document the directory line reads. */
    readonly rt: PanelRuntime;
    /** Pane the statements mount into. */
    readonly pane: HTMLElement;
}): {
    readonly dataDir: TextHandle;
    readonly vocabulary: ListHandle;
    readonly cleanup: TextHandle;
    readonly release: TextHandle;
} {
    const dataDir = mountStyledText(input.pane, { className: 'mt-prose', text: dataDirLine(input.rt) });

    // The heading stays prose; the entries become rows so a wrapped line lands
    // under its own first word, not under the hand-typed `- ` marker (FR-029).
    mountStyledText(input.pane, { className: 'mt-prose', text: VOCABULARY_HEADING });
    const vocabulary = mountList(input.pane, {
        items: [...VOCABULARY_LIST_ITEMS],
        ariaLabel: VOCABULARY_HEADING,
        onSelect: () => {
            // Display-only: the rows are definitions, not a selection.
        },
    });

    return {
        dataDir,
        vocabulary,
        cleanup: mountStyledText(input.pane, { className: 'mt-prose', text: CLEANUP_POSTURE }),
        release: mountStyledText(input.pane, { className: 'mt-prose', text: RELEASE_POSTURE }),
    };
}

/**
 * Mount the read-only Diagnostics block (FR-075, FR-076).
 *
 * @param input - Runtime whose ledger the block reads, and the pane.
 * @returns The four handles.
 */
function mountDiagnostics(input: {
    /** Runtime whose ledger the block renders. */
    readonly rt: PanelRuntime;
    /** Pane the block mounts into. */
    readonly pane: HTMLElement;
}): {
    readonly schemas: TextHandle;
    readonly phaseRecord: TextHandle;
    readonly ledger: TextHandle;
} {
    const schemas = mountStyledText(input.pane, {
        className: 'mt-prose',
        text: `Evidence schema: ${EVIDENCE_SCHEMA_VERSION} · Ledger schema: ${LEDGER_SCHEMA_VERSION}`,
    });

    return {
        schemas,
        phaseRecord: mountStyledText(input.pane, { className: 'mt-prose', text: phaseRecordLine(input.rt) }),
        ledger: mountStyledText(input.pane, { className: 'mt-prose', text: ledgerLines(input.rt) }),
    };
}

/**
 * Release every handle and node the About tab mounted (FR-017).
 *
 * @param ui - The mounted view.
 */
function disposeAbout(ui: AboutTabUi): void {
    ui.identity.dispose();
    ui.version.dispose();
    ui.versionSource.dispose();
    ui.retry.dispose();
    ui.readLine.dispose();
    ui.failure.dispose();
    ui.dataDir.dispose();
    ui.vocabulary.dispose();
    ui.cleanup.dispose();
    ui.release.dispose();
    ui.schemas.dispose();
    ui.phaseRecord.dispose();
    ui.ledger.dispose();
    ui.failureBox.remove();
    ui.pane.remove();
}

/**
 * Mount the About tab: identity, version, the one re-read control, the three
 * static statements, and the read-only Diagnostics block (FR-074, FR-075).
 *
 * @param input - Runtime and the body container the shell created.
 * @returns The mounted view.
 */
export function mountAboutTab(input: {
    /** Runtime whose state the tab paints. */
    readonly rt: PanelRuntime;
    /** Body container the shell created for the About tab. */
    readonly body: HTMLElement;
}): AboutTabUi {
    const { rt, body } = input;
    const pane = body.ownerDocument.createElement('div');
    body.append(pane);

    // Two blocks: what this panel is, then the record it keeps about itself.
    // The first carries the tab title (one rule across the six tabs).
    const about = createBlock(pane, { heading: ABOUT_HEADING, title: true });
    const record = createBlock(pane, { heading: DIAGNOSTICS_HEADING });

    const header = mountHeader({ rt, pane: about.body });
    const retryRow = mountRetryRow({ rt, pane: about.body });
    const statements = mountStatements({ rt, pane: about.body });
    const diagnostics = mountDiagnostics({ rt, pane: record.body });

    const ui: AboutTabUi = {
        pane,
        ...header,
        ...retryRow,
        ...statements,
        ...diagnostics,
        dispose: (): void => {
            about.dispose();
            record.dispose();
            disposeAbout(ui);
        },
    };

    rt.aboutUi = ui;
    repaintAboutTab(rt);
    // The tab has never read the version at mount (FR-013: bodies read on
    // their first activation, and this is that activation's one read).
    if (rt.state.aboutTab.phase === 'idle') {
        void loadVersion(rt);
    }

    return ui;
}

/**
 * Dispose the About tab's handles and clear its slot (FR-017).
 *
 * @param rt - Panel runtime being torn down.
 */
export function disposeAboutTab(rt: PanelRuntime): void {
    const ui = rt.aboutUi;
    if (ui === null) {
        return;
    }

    ui.dispose();
    rt.aboutUi = null;
}
