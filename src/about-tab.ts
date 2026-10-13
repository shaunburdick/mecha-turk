/**
 * The About tab: name, version, description, documentation and repository
 * links, with Diagnostics behind a disclosure (005 FR-074–FR-077,
 * AC-132–AC-134, SC-109); the version comes only from the service's health
 * answer, never a literal of this module's own (FR-074, NFR-112).
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

const PRODUCT_NAME = 'Mecha Turk';

const VERSION_UNREACHABLE = 'unknown (service unreachable)';

/** What About shows before the first health answer lands (contract §2). */
const VERSION_UNREAD = 'Version: not yet read';

const ABOUT_HEADING = 'About';

const DIAGNOSTICS_HEADING = 'Diagnostics (read-only)';

const DIAGNOSTICS_SHOW = 'Diagnostics';

const DIAGNOSTICS_HIDE = 'Hide diagnostics';

/**
 * Where this project's source lives — one of the two links the page carries.
 */
const REPOSITORY_URL = 'https://github.com/shaunburdick/mecha-turk';

const REPOSITORY_LINE = `Repository: [${REPOSITORY_URL}](${REPOSITORY_URL})`;

/**
 * Where the documentation is published — the other link, and the entry point
 * into the site from inside the product. Its trailing slash is the site's own
 * published address: the site is served from a subpath, and the trailing slash
 * is what makes it that address rather than a redirect to it.
 */
const DOCUMENTATION_URL = 'https://shaunburdick.github.io/mecha-turk/';

const DOCUMENTATION_LINE = `Documentation: [${DOCUMENTATION_URL}](${DOCUMENTATION_URL})`;

const DESCRIPTION =
    'Mecha Turk watches the GitHub repositories you bind — issues assigned to you, review requests, ' +
    'and mentions — and opens an OpenChamber session for each discovery.';

/** What the re-read control is called; also the failure notice's retry. */
const RETRY_LABEL = 'Retry version read';

const FAILURE_TITLE = 'Version not read';

/**
 *
 * `version` is deliberately separate from `phase`: a failed re-read keeps the
 * version that did land (and the read line marks it stale) rather than
 * replacing a real answer with the unreachable copy. `diagnosticsOpen` is the
 * disclosure's own state, and `repoProblem` and `docsProblem` are the two
 * links' refusals, if the host ever sent one — a slot each, so neither link's
 * refusal can overwrite the other's.
 */
export interface AboutTabState {
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    at: string | null;
    problem: string | null;
    version: string | null;
    diagnosticsOpen: boolean;
    repoProblem: string | null;
    docsProblem: string | null;
}

/**
 * Build the empty About tab state.
 */
export function initialAboutTab(): AboutTabState {
    return {
        phase: 'idle',
        at: null,
        problem: null,
        version: null,
        diagnosticsOpen: false,
        repoProblem: null,
        docsProblem: null,
    };
}

export interface AboutTabUi {
    readonly pane: HTMLElement;
    readonly identity: TextHandle;
    readonly version: TextHandle;
    readonly description: TextHandle;
    /** The documentation link, opened through the host. */
    readonly docsLink: TextHandle;
    /** The documentation link's refusal line, empty until there is one (FR-003). */
    readonly docsNote: TextHandle;
    /** The repository link, opened through the host. */
    readonly repoLink: TextHandle;
    /** The repository link's refusal line, empty until there is one (FR-003). */
    readonly repoNote: TextHandle;
    /** The tab's version control: an explicit re-read of the health answer. */
    readonly retry: ButtonHandle;
    /** One line of read state: idle, loading, landed, or failed with a cause. */
    readonly readLine: TextHandle;
    /** Wrapper around the failure notice, hidden while nothing failed. */
    readonly failureBox: HTMLElement;
    readonly failure: BannerHandle;
    readonly diagnosticsToggle: ButtonHandle;
    /** Wrapper around the Diagnostics block, hidden until the control opens it. */
    readonly diagnosticsBox: HTMLElement;
    readonly schemas: TextHandle;
    readonly phaseRecord: TextHandle;
    readonly ledger: TextHandle;
    readonly dispose: () => void;
}

/**
 * The version line: read, unread, or unreachable — never a synthesised
 * number.
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
 * The tab's own read state, in the three shapes.
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
 *
 * Nothing runs when the tab has never been activated: the state still
 * updates, and the first activation repaints from it.
 */
export function repaintAboutTab(rt: PanelRuntime): void {
    const ui = rt.aboutUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.aboutTab;
    const isLoading = slice.phase === 'loading';

    ui.version.update({ text: versionLine(slice) });
    ui.docsNote.update({ text: slice.docsProblem ?? '' });
    ui.repoNote.update({ text: slice.repoProblem ?? '' });
    ui.readLine.update({ text: readStateLine(slice) });
    ui.retry.update({ disabled: isLoading, loading: isLoading });
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
 *
 * One named action rather than an inline closure, so the control's own
 * behaviour is testable without reaching through mount props: closed by
 * default, opened by its control, and its label says which it currently is.
 */
export function toggleDiagnostics(rt: PanelRuntime): void {
    rt.state.aboutTab.diagnosticsOpen = !rt.state.aboutTab.diagnosticsOpen;
    repaintAboutTab(rt);
}

/**
 * Hand one of the page's links to the host's opener and describe a refusal.
 * `host.openUrl` is the opener the panel already uses for a dispatch's source
 * link, so the About page reaches for the same one — no capability, no invented
 * navigation, no anchor that could unload the panel. The refusal text names the
 * link it belongs to and is redacted like every other operator-facing string,
 * so neither link's failure can carry a credential out of the host's answer.
 */
async function openThroughHost(rt: PanelRuntime, url: string, label: string): Promise<string | null> {
    try {
        await rt.host.openUrl(url);

        return null;
    } catch (cause) {
        return redact(`${label} could not be opened: ${describeError(cause)}. Copy the address above instead.`);
    }
}

/**
 *
 * A refusal lands on the link's own line rather than being swallowed.
 */
export async function openRepository(rt: PanelRuntime, url: string): Promise<void> {
    rt.state.aboutTab.repoProblem = await openThroughHost(rt, url, 'The repository link');
    repaintAboutTab(rt);
}

/**
 *
 * The route into the site from inside the product, and the same two rules as
 * the repository link beside it: the panel opens nothing itself, and a refusal
 * is rendered on the link's own line with the address still readable (FR-060).
 */
export async function openDocumentation(rt: PanelRuntime, url: string): Promise<void> {
    rt.state.aboutTab.docsProblem = await openThroughHost(rt, url, 'The documentation link');
    repaintAboutTab(rt);
}

/**
 * Read the version out of a health answer, fail closed.
 */
function versionFrom(body: string): string | null {
    const parsed = parseJsonObject(body);
    const version = parsed === null ? null : parsed.version;

    return typeof version === 'string' && version !== '' ? version : null;
}

/**
 * Whether the runtime was torn down mid-read: a call rather than a bare
 * `rt.disposed` read, so the analyzer cannot narrow the check away.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 *
 * Fail closed: an answer the panel cannot read is a failed read, never a
 * value. The tab retries only on an explicit operator action (contract §2).
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
 * Mount the identity block: name, version, description, and the two links, each
 * with its own refusal line.
 *
 * The documentation link comes first because the README puts it first too: it
 * is the route into the published documentation, and the repository is the
 * secondary address beside it.
 */
function mountHeader(input: {
    readonly rt: PanelRuntime;
    readonly pane: HTMLElement;
}): {
    readonly identity: TextHandle;
    readonly version: TextHandle;
    readonly description: TextHandle;
    readonly docsLink: TextHandle;
    readonly docsNote: TextHandle;
    readonly repoLink: TextHandle;
    readonly repoNote: TextHandle;
} {
    const { pane, rt } = input;
    // `.mt-prose` on all of them: without it these measured their own edge.
    const identity = mountStyledText(pane, { className: 'mt-prose', text: PRODUCT_NAME });
    const version = mountStyledText(pane, { className: 'mt-prose', text: versionLine(rt.state.aboutTab) });
    const description = mountStyledText(pane, { className: 'mt-prose', text: DESCRIPTION });
    const docsLink = mountStyledText(pane, {
        className: 'mt-prose',
        text: DOCUMENTATION_LINE,
        onOpenUrl: (url) => {
            void openDocumentation(rt, url);
        },
    });
    const docsNote = mountStyledText(pane, { className: 'mt-lede', text: rt.state.aboutTab.docsProblem ?? '' });
    const repoLink = mountStyledText(pane, {
        className: 'mt-prose',
        text: REPOSITORY_LINE,
        onOpenUrl: (url) => {
            void openRepository(rt, url);
        },
    });
    const repoNote = mountStyledText(pane, { className: 'mt-lede', text: rt.state.aboutTab.repoProblem ?? '' });

    return { identity, version, description, docsLink, docsNote, repoLink, repoNote };
}

/**
 * Mount the re-read row and the failure notice behind it.
 */
function mountRetryRow(input: {
    readonly rt: PanelRuntime;
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

function disposeAbout(ui: AboutTabUi): void {
    ui.identity.dispose();
    ui.version.dispose();
    ui.description.dispose();
    ui.docsLink.dispose();
    ui.docsNote.dispose();
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
 */
export function mountAboutTab(input: {
    readonly rt: PanelRuntime;
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
        docsLink: header.docsLink,
        docsNote: header.docsNote,
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
 */
export function disposeAboutTab(rt: PanelRuntime): void {
    const ui = rt.aboutUi;
    if (ui === null) {
        return;
    }

    ui.dispose();
    rt.aboutUi = null;
}
