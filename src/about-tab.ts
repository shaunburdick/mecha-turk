/**
 * The About tab: identity, the single version, and Diagnostics behind a
 * disclosure (005 T-028 as re-cut by the 2026-10-01 product-owner scrub;
 * FR-074–FR-077, AC-132–AC-134, SC-109).
 *
 * The page is deliberately small — **name, version, description, repository
 * link** — because that is all an About page is asked for. The four
 * statements the scrub removed (the vocabulary mapping, the cleanup posture,
 * the release posture, and the data-directory line) either have a tab that
 * owns them or say nothing the operator can act on; the vocabulary block's
 * own module (`vocabulary.ts`) went with it, so the L1 scan
 * (`tests/vocabulary.test.ts`) now exempts nothing.
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
 * that rule can rot. The static half — the name, the description, and the
 * repository link — renders with or without the service (FR-078).
 *
 * **The repository link goes through the host.** A sandboxed iframe cannot
 * open a link itself, so the SDK text path hands every http(s) click to
 * `onOpenUrl`, which forwards it to `host.openUrl` — the opener the panel
 * already uses for a dispatch's source link. A refusal lands on the link's
 * own line rather than being swallowed (FR-003).
 *
 * **Diagnostics is read-only and closed by default** (FR-075): a disclosure
 * control reveals the ledger as `#seq · kind · time` lines, the two schema
 * versions, and the phase record. It deliberately renders **no entry detail**,
 * so an account identifier, a prompt, a fingerprint, or a filesystem path has
 * no way into this section (FR-076), and it offers nothing that writes — the
 * phase writer left with the tab it lived on.
 */

import { mountBanner, mountButton } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, TextHandle } from '@openchamber/sdk/ui';
import { parseJsonObject } from './json.ts';
import { nowIso } from './ids.ts';
import { HEALTH_PATH, serviceGet } from './service-calls.ts';
import { describeError } from './session.ts';
import { redact } from './redaction.ts';
import { createBlock, mountStyledText } from './style.ts';
import { ledgerLines, mountDiagnostics, phaseRecordLine } from './about-diagnostics.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The product name the manifest declares. */
const PRODUCT_NAME = 'Mecha Turk';

/** What About shows for a version it could not read. */
const VERSION_UNREACHABLE = 'unknown (service unreachable)';

/** What About shows before the first health answer lands (contract §2). */
const VERSION_UNREAD = 'Version: not yet read';

/** Heading above the identity block. */
const ABOUT_HEADING = 'About';

/** Heading above the read-only record. */
const DIAGNOSTICS_HEADING = 'Diagnostics (read-only)';

/** The disclosure control while the record is closed. */
const DIAGNOSTICS_SHOW = 'Diagnostics';

/** The disclosure control while the record is open (state as text, FR-083). */
const DIAGNOSTICS_HIDE = 'Hide diagnostics';

/** Where this project's source lives — the one link the page carries. */
const REPOSITORY_URL = 'https://github.com/shaunburdick/mecha-turk';

/** The link line: address and target are the same URL, so it is readable. */
const REPOSITORY_LINE = `Repository: [${REPOSITORY_URL}](${REPOSITORY_URL})`;

/** The one-line description of the tool. */
const DESCRIPTION =
    'Mecha Turk watches the GitHub repositories you bind — issues assigned to you, review requests, ' +
    'and mentions — and opens an OpenChamber session for each discovery.';

/** What the re-read control is called; also the failure notice's retry. */
const RETRY_LABEL = 'Retry version read';

/** Title of the failure notice, whatever the failure was. */
const FAILURE_TITLE = 'Version not read';

/**
 * Where the About tab's version read stands.
 *
 * `version` is deliberately separate from `phase`: a failed re-read keeps the
 * version that did land (and the read line marks it stale) rather than
 * replacing a real answer with the unreachable copy. `diagnosticsOpen` is the
 * disclosure's own state, and `repoProblem` is the link's refusal, if the
 * host ever sent one.
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
    /** Whether the Diagnostics disclosure is open. */
    diagnosticsOpen: boolean;
    /** Why the repository link could not be opened; `null` otherwise. */
    repoProblem: string | null;
}

/**
 * Build the empty About tab state.
 *
 * @returns The state before the first read.
 */
export function initialAboutTab(): AboutTabState {
    return { phase: 'idle', at: null, problem: null, version: null, diagnosticsOpen: false, repoProblem: null };
}

/** The mounted About tab: the handles a repaint updates, plus disposal. */
export interface AboutTabUi {
    /** Body root this view mounted into. */
    readonly pane: HTMLElement;
    /** The product name. */
    readonly identity: TextHandle;
    /** The single version line. */
    readonly version: TextHandle;
    /** The one-line description of the tool. */
    readonly description: TextHandle;
    /** The repository link, opened through the host. */
    readonly repoLink: TextHandle;
    /** The link's refusal line, empty until there is one (FR-003). */
    readonly repoNote: TextHandle;
    /** The tab's version control: an explicit re-read of the health answer. */
    readonly retry: ButtonHandle;
    /** One line of read state: idle, loading, landed, or failed with a cause. */
    readonly readLine: TextHandle;
    /** Wrapper around the failure notice, hidden while nothing failed. */
    readonly failureBox: HTMLElement;
    /** Failure notice naming what could not be read and from where. */
    readonly failure: BannerHandle;
    /** The disclosure control that reveals Diagnostics. */
    readonly diagnosticsToggle: ButtonHandle;
    /** Wrapper around the Diagnostics block, hidden until the control opens it. */
    readonly diagnosticsBox: HTMLElement;
    /** The two schema versions this build ships. */
    readonly schemas: TextHandle;
    /** The phase record, read-only. */
    readonly phaseRecord: TextHandle;
    /** The ledger, newest first, as text. */
    readonly ledger: TextHandle;
    /** Remove every node and handle this view mounted. */
    readonly dispose: () => void;
}

/**
 * The version line: read, unread, or unreachable — never a synthesised
 * number.
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
 * Repaint the About tab from state.
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it.
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
    ui.repoNote.update({ text: slice.repoProblem ?? '' });
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

    ui.diagnosticsBox.hidden = !slice.diagnosticsOpen;
    ui.diagnosticsToggle.update({ label: slice.diagnosticsOpen ? DIAGNOSTICS_HIDE : DIAGNOSTICS_SHOW });
    ui.phaseRecord.update({ text: phaseRecordLine(rt) });
    ui.ledger.update({ text: ledgerLines(rt) });
}

/**
 * Flip the Diagnostics disclosure.
 *
 * One named action rather than an inline closure, so the control's own
 * behaviour is testable without reaching through mount props: closed by
 * default, opened by its control, and its label says which it currently is.
 *
 * @param rt - Panel runtime whose About state the control flips.
 */
export function toggleDiagnostics(rt: PanelRuntime): void {
    rt.state.aboutTab.diagnosticsOpen = !rt.state.aboutTab.diagnosticsOpen;
    repaintAboutTab(rt);
}

/**
 * Open the repository link through the host, and say so when it refuses.
 *
 * `host.openUrl` is the opener the panel already uses for a dispatch's source
 * link, so the About page reaches for the same one — no capability, no
 * invented navigation, no anchor that could unload the panel. A refusal lands
 * on the link's own line rather than being swallowed.
 *
 * @param rt - Panel runtime.
 * @param url - The href the operator activated.
 */
export async function openRepository(rt: PanelRuntime, url: string): Promise<void> {
    try {
        await rt.host.openUrl(url);
        rt.state.aboutTab.repoProblem = null;
    } catch (cause) {
        rt.state.aboutTab.repoProblem = redact(
            `The repository link could not be opened: ${describeError(cause)}. Copy the address above instead.`,
        );
    }

    repaintAboutTab(rt);
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
 * Read the service's health answer and take its version.
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
 * Mount the identity block: name, version, description, and the repository
 * link with its refusal line.
 *
 * @param input - Runtime whose read state paints the version, and the pane.
 * @returns The five handles.
 */
function mountHeader(input: {
    /** Runtime whose read state the version line renders. */
    readonly rt: PanelRuntime;
    /** Pane the identity mounts into. */
    readonly pane: HTMLElement;
}): {
    readonly identity: TextHandle;
    readonly version: TextHandle;
    readonly description: TextHandle;
    readonly repoLink: TextHandle;
    readonly repoNote: TextHandle;
} {
    const { pane, rt } = input;
    // `.mt-prose` on all of them: without it these measured their own edge.
    const identity = mountStyledText(pane, { className: 'mt-prose', text: PRODUCT_NAME });
    const version = mountStyledText(pane, { className: 'mt-prose', text: versionLine(rt.state.aboutTab) });
    const description = mountStyledText(pane, { className: 'mt-prose', text: DESCRIPTION });
    const repoLink = mountStyledText(pane, {
        className: 'mt-prose',
        text: REPOSITORY_LINE,
        onOpenUrl: (url) => {
            void openRepository(rt, url);
        },
    });
    const repoNote = mountStyledText(pane, { className: 'mt-lede', text: rt.state.aboutTab.repoProblem ?? '' });

    return { identity, version, description, repoLink, repoNote };
}

/**
 * Mount the re-read row and the failure notice behind it.
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
 * Create the disclosure: the control, and the wrapper it reveals.
 *
 * The control sits outside the wrapper so opening and closing is one
 * `hidden` write on one element, and its label states which of the two it
 * currently is (FR-083: state as text, never colour alone).
 *
 * @param pane - Pane the disclosure mounts into.
 * @param onClick - What activating the control does.
 * @returns The control and the wrapper around the Diagnostics block.
 */
function mountDisclosure(pane: HTMLElement, onClick: () => void): {
    readonly toggle: ButtonHandle;
    readonly box: HTMLElement;
} {
    const row = pane.ownerDocument.createElement('div');
    row.className = 'mt-toolbar';
    pane.append(row);
    const toggle = mountButton(row, { label: DIAGNOSTICS_SHOW, variant: 'outline', onClick });

    const box = pane.ownerDocument.createElement('div');
    box.hidden = true;
    pane.append(box);

    return { toggle, box };
}

/**
 * Release every handle and node the About tab mounted.
 *
 * @param ui - The mounted view.
 */
function disposeAbout(ui: AboutTabUi): void {
    ui.identity.dispose();
    ui.version.dispose();
    ui.description.dispose();
    ui.repoLink.dispose();
    ui.repoNote.dispose();
    ui.retry.dispose();
    ui.readLine.dispose();
    ui.failure.dispose();
    ui.diagnosticsToggle.dispose();
    ui.schemas.dispose();
    ui.phaseRecord.dispose();
    ui.ledger.dispose();
    ui.failureBox.remove();
    ui.diagnosticsBox.remove();
    ui.pane.remove();
}

/**
 * Mount the About tab: the identity block, the one re-read control, and the
 * Diagnostics disclosure.
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

    // The identity block carries the tab title (one rule across the six
    // tabs); Diagnostics is its own block, behind the disclosure.
    const about = createBlock(pane, { heading: ABOUT_HEADING, title: true });
    const header = mountHeader({ rt, pane: about.body });
    const retryRow = mountRetryRow({ rt, pane: about.body });
    const disclosure = mountDisclosure(pane, (): void => {
        toggleDiagnostics(rt);
    });
    const record = createBlock(disclosure.box, { heading: DIAGNOSTICS_HEADING });
    const diagnostics = mountDiagnostics({ rt, pane: record.body });

    const ui: AboutTabUi = {
        pane,
        identity: header.identity,
        version: header.version,
        description: header.description,
        repoLink: header.repoLink,
        repoNote: header.repoNote,
        retry: retryRow.retry,
        readLine: retryRow.readLine,
        failureBox: retryRow.failureBox,
        failure: retryRow.failure,
        diagnosticsToggle: disclosure.toggle,
        diagnosticsBox: disclosure.box,
        schemas: diagnostics.schemas,
        phaseRecord: diagnostics.phaseRecord,
        ledger: diagnostics.ledger,
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
 * Dispose the About tab's handles and clear its slot.
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
