/**
 * The first-run setup-prerequisites section (003 FR-071–FR-073, closing 002's
 * FR-038 conformance gap): six prerequisites, each with a state and its own
 * remediation line, derived on read from panel state — never persisted, never
 * fetched, never able to configure anything (spec `## Key Entities`: this
 * surface is read-only reporting).
 *
 * Three states only (FR-072): `met`, `not-met`, `not-checkable` — and a
 * prerequisite the panel cannot verify says so rather than displaying a
 * reassuring state it did not check. Two of the six are permanently not
 * checkable, deliberately:
 *
 * - The **Default Agent pin** no documented API exposes: it becomes knowable
 *   only after a dispatch, when the read-back reports which agent the session
 *   runs (FR-072).
 * - The **desktop-or-web surface** has no documented reporter either: the
 *   ready context's `surface` member is the guest surface kind (`panel`,
 *   `dialog`, `page`, `background`), not the OpenChamber app, and a refused
 *   `serviceRequest` cannot separate "unsupported surface" from "not
 *   approved" or "not running" (both answer `NO_SERVICE`). Its remediation
 *   names the consequence instead of asserting a check.
 *
 * What is checkable is checked fail-closed: absent scope evidence reads as no
 * evidence, a binding without a project id is unmet, an unaccepted consent
 * step is unmet. Every checkable `not-met` also raises a banner **outside**
 * the section (FR-073); a `met` item never does.
 *
 * Rendering follows the DispatchesBoard shape: SDK primitives mounted into a
 * wrapper whose `hidden` flag is the banner's state, repainted through
 * {@link repaintPrerequisites}. Mounted surfaces live in a `WeakMap` keyed by
 * runtime rather than on `PanelRuntime`, so this module owns all its state.
 */

import { mountBanner, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, TextHandle } from '@openchamber/sdk/ui';
import { DEFAULT_EXPECTED_AGENT } from './config.ts';
import { PROJECT_REGISTRATION_ROUTES } from './project-picker.ts';
import type { PanelRuntime, PanelState } from './panel-state.ts';
import type { HandoffState } from './handoff.ts';
import type { PanelAccount, PanelBinding } from './bindings-service.ts';

/** The three states FR-072 allows, and nothing else. */
export type PrerequisiteState = 'met' | 'not-met' | 'not-checkable';

/** The six prerequisites FR-071 names, as stable identifiers. */
export type PrerequisiteId =
    /** Session Defaults → Default Agent pin (002 prerequisite 1). */
    | 'default-agent'
    /** OpenChamber has to be running (002 prerequisite 2). */
    | 'openchamber-running'
    /** Guest services spawn on desktop and web only (002 prerequisite 3). */
    | 'desktop-or-web'
    /** Required GitHub token scopes, with no write scopes (002 prerequisite 4). */
    | 'token-scopes'
    /** A registered OpenChamber project per binding (002 prerequisite 5). */
    | 'registered-project'
    /** Service capability approval plus the in-panel consent step (002 prerequisite 6). */
    | 'service-capability';

/** One prerequisite: what it is, where it stands, and how to satisfy it. */
export interface Prerequisite {
    /** Stable identifier, so a test or a later surface can address it. */
    readonly id: PrerequisiteId;
    /** Operator-facing name. */
    readonly title: string;
    /** The state the panel could honestly determine. */
    readonly state: PrerequisiteState;
    /** What the panel observed, or why it could not observe anything. */
    readonly detail: string;
    /** The line that tells the operator what to do about it. */
    readonly remediation: string;
}

/** The banner FR-073 raises outside the section when something is unmet. */
export interface PrerequisiteNotice {
    /** Banner headline. */
    readonly title: string;
    /** Which prerequisites are unmet and where their fixes live. */
    readonly body: string;
}

/** Heading above the six lines. */
export const PREREQUISITES_HEADING = 'Setup prerequisites';

/** Stable identifiers, written once each (see {@link PrerequisiteId}). */
const IDS = {
    defaultAgent: 'default-agent',
    openchamberRunning: 'openchamber-running',
    desktopOrWeb: 'desktop-or-web',
    tokenScopes: 'token-scopes',
    registeredProject: 'registered-project',
    serviceCapability: 'service-capability',
} as const;

/** Operator-facing titles, written once each so copy cannot drift apart. */
const TITLES = {
    defaultAgent: 'Default Agent pin',
    openchamberRunning: 'OpenChamber running',
    desktopOrWeb: 'Desktop or web surface',
    tokenScopes: 'GitHub token scopes',
    registeredProject: 'Registered project per binding',
    serviceCapability: 'Service capability approval',
} as const;

/**
 * The three states as literals, written once each: the duplicate counter
 * counts every branch that reports one (sonarjs/no-duplicate-string).
 */
const STATE_MET = 'met';
const STATE_NOT_MET = 'not-met';
const STATE_NOT_CHECKABLE = 'not-checkable';

/**
 * Label one state is rendered with, in FR-072's own vocabulary.
 *
 * @param state - The prerequisite's state.
 * @returns The operator-facing label, never a bare enum value.
 */
export function prerequisiteStateLabel(state: PrerequisiteState): string {
    if (state === STATE_NOT_MET) {
        return 'not met';
    }

    if (state === STATE_NOT_CHECKABLE) {
        return 'not checkable by the panel';
    }

    return 'met';
}

/**
 * The Default Agent pin: checkable only after a dispatch (FR-072).
 *
 * The name in the remediation is {@link DEFAULT_EXPECTED_AGENT}, the
 * documented default 002 FR-029 falls back to when `GET /v1/config` carries
 * no `expectedAgent`: the prerequisite describes the documented setup step,
 * which is exactly that default, so the line cannot go stale when the
 * baseline itself is read per verification.
 *
 * @returns The prerequisite, always `not-checkable` and never `met`.
 */
function defaultAgentPin(): Prerequisite {
    const remediation =
        `Set Settings → Sessions → Session Defaults → Default Agent to ${DEFAULT_EXPECTED_AGENT}; ` +
        'every dispatch reads the session back afterwards and warns when the session reports another agent.';

    return {
        id: IDS.defaultAgent,
        title: TITLES.defaultAgent,
        state: STATE_NOT_CHECKABLE,
        detail: 'The panel cannot read this OpenChamber setting, so it never claims the pin is in place.',
        remediation,
    };
}

/**
 * Whether OpenChamber is running: the host has answered this panel or not.
 *
 * @param hostAnswered - Whether a settings/ready snapshot has arrived.
 * @returns `met` once the host answers, `not-checkable` before that.
 */
function openChamberRunning(hostAnswered: boolean): Prerequisite {
    if (!hostAnswered) {
        return {
            id: IDS.openchamberRunning,
            title: TITLES.openchamberRunning,
            state: STATE_NOT_CHECKABLE,
            detail: 'No snapshot has arrived from the host yet, so the panel has nothing to read.',
            remediation: 'Open this panel from OpenChamber; the line reads met as soon as the host answers.',
        };
    }

    return {
        id: IDS.openchamberRunning,
        title: TITLES.openchamberRunning,
        state: STATE_MET,
        detail: 'OpenChamber answered this panel, so the host is running.',
        remediation: 'Polling and dispatch stop when OpenChamber closes — keep it open while work is queued.',
    };
}

/**
 * The desktop-or-web requirement, which no documented API reports (see the
 * module doc for why this is honest rather than lazy).
 *
 * @returns The prerequisite, always `not-checkable`.
 */
function desktopOrWebSurface(): Prerequisite {
    return {
        id: IDS.desktopOrWeb,
        title: TITLES.desktopOrWeb,
        state: STATE_NOT_CHECKABLE,
        detail: 'The documented host surface never reports which OpenChamber app this panel runs in.',
        remediation:
            'Run OpenChamber desktop or web: VS Code and mobile do not spawn the local service, ' +
            'so this extension is unsupported there.',
    };
}

/**
 * The GitHub token scopes, read fail-closed across every usable account:
 * `missing` beats everything (a scope gap is a fact), then any account
 * without a readable matrix makes the whole set not checkable — one account
 * the panel cannot vouch for means it cannot vouch for the set. No surface in
 * this system reports write scopes, so *read* scopes decide the state and the
 * remediation keeps the no-write-scopes instruction visible (FR-071).
 *
 * @param accounts - Accounts as the last `GET /v1/accounts` read reported them.
 * @returns The prerequisite for the connected set.
 */
function tokenScopes(accounts: readonly PanelAccount[]): Prerequisite {
    const usable = accounts.filter((account) => account.usable);
    const title = TITLES.tokenScopes;

    if (usable.length === 0) {
        return {
            id: IDS.tokenScopes,
            title,
            state: STATE_NOT_MET,
            detail: 'No connected account holds a token this panel can vouch for.',
            remediation:
                'Add an account under Repositories → Poll as account, using a GitHub token with ' +
                'Metadata, Issues, and Pull requests read (Contents too when repository metadata is used) ' +
                'and no write scopes.',
        };
    }

    if (usable.some((account) => account.scope === 'missing')) {
        return {
            id: IDS.tokenScopes,
            title,
            state: STATE_NOT_MET,
            detail: 'A connected account is missing a required read scope.',
            remediation:
                'Rotate the token of the affected account with Metadata, Issues, and Pull requests ' +
                'read (and Contents), then reconnect it — the token must carry no write scopes.',
        };
    }

    if (usable.some((account) => account.scope !== 'ok')) {
        return {
            id: IDS.tokenScopes,
            title,
            state: STATE_NOT_CHECKABLE,
            detail: 'The recorded scope check carries no usable matrix for every connected account.',
            remediation:
                'Reconnect the account so the service records a scope check, and keep the token ' +
                'read-only: Metadata, Issues, Pull requests, Contents — no write scopes.',
        };
    }

    const plural = usable.length === 1 ? '' : 's';

    return {
        id: IDS.tokenScopes,
        title,
        state: STATE_MET,
        detail:
            `The recorded scope check reports every required read scope for ${usable.length} ` +
            `connected account${plural}; write scopes are not reported to the panel.`,
        remediation: 'Keep the token read-only: Metadata, Issues, Pull requests, and Contents — no write scopes.',
    };
}

/**
 * A registered OpenChamber project for every binding (plan D12: zero
 * bindings is nothing to satisfy, so a fresh install reads met rather than
 * nagging with nothing actionable).
 *
 * @param bindings - Bindings as the last read reported them.
 * @returns The prerequisite for the bound set.
 */
function registeredProjectPerBinding(bindings: readonly PanelBinding[]): Prerequisite {
    const title = TITLES.registeredProject;
    const unresolved = bindings.filter((binding) => binding.projectId.trim() === '');

    if (unresolved.length > 0) {
        const routes = PROJECT_REGISTRATION_ROUTES.join(', ');

        return {
            id: IDS.registeredProject,
            title,
            state: STATE_NOT_MET,
            detail: `${unresolved.length} of ${bindings.length} bindings has no registered project.`,
            remediation:
                `Register the project in OpenChamber (${routes}) and set it on the binding; ` +
                'the extension never creates a project.',
        };
    }

    const detail =
        bindings.length === 0
            ? 'No repository is bound yet, so there is no project left to resolve.'
            : `All ${bindings.length} bindings name a registered project.`;

    return {
        id: IDS.registeredProject,
        title,
        state: STATE_MET,
        detail,
        remediation:
            'When you bind a repository, pick an existing project from the list — register one first ' +
            'if the picker does not list it.',
    };
}

/**
 * Service-capability approval, observed through the two facts the panel can
 * actually see: the in-panel consent step (FR-008) and whether the local
 * service has ever answered a status read with a writable store.
 *
 * @param handoff - The one-shot handoff's state, which carries both signals.
 * @returns The prerequisite for the service half of the setup.
 */
function serviceCapability(handoff: HandoffState): Prerequisite {
    const title = TITLES.serviceCapability;

    if (!handoff.consentGiven) {
        return {
            id: IDS.serviceCapability,
            title,
            state: STATE_NOT_MET,
            detail: 'The in-panel consent step for the token handoff has not been accepted.',
            remediation:
                'Open Repositories → Poll as account and accept the consent step; approve the ' +
                'service capability in Settings → Extensions if the host asks.',
        };
    }

    if (!handoff.preflighted) {
        return {
            id: IDS.serviceCapability,
            title,
            state: STATE_NOT_CHECKABLE,
            detail: 'The panel has not had an answer from the local service yet.',
            remediation:
                'Keep the service capability approved in Settings → Extensions; the first status ' +
                'read confirms it here.',
        };
    }

    if (!handoff.storageWritable) {
        return {
            id: IDS.serviceCapability,
            title,
            state: STATE_NOT_MET,
            detail: 'The local service answered, but its store is not writable.',
            remediation:
                'Fix the store permissions under ~/.config/openchamber/mecha-turk/ (0700 directories, ' +
                '0600 files), then refresh.',
        };
    }

    return {
        id: IDS.serviceCapability,
        title,
        state: STATE_MET,
        detail: 'The local service answered the panel status read with a writable store.',
        remediation: 'Keep the service capability approved; polling and dispatch stop if it is withdrawn.',
    };
}

/**
 * Derive all six prerequisites from the panel's current state.
 *
 * Pure and synchronous: the same state always answers the same six records,
 * which is what makes the section testable without a host and impossible to
 * leave stale.
 *
 * @param state - Panel state to read.
 * @returns The six prerequisites, in FR-071's order.
 */
export function derivePrerequisites(state: PanelState): readonly Prerequisite[] {
    return [
        defaultAgentPin(),
        openChamberRunning(state.settings !== null),
        desktopOrWebSurface(),
        tokenScopes(state.bindings.accounts),
        registeredProjectPerBinding(state.bindings.bindings),
        serviceCapability(state.handoff),
    ];
}

/**
 * Render one prerequisite as the line its `TextHandle` shows.
 *
 * @param item - The prerequisite to render.
 * @returns `title · state — detail remediation`, in that order, so the state
 *   is readable even when the line wraps.
 */
export function prerequisiteLine(item: Prerequisite): string {
    return `${item.title} · ${prerequisiteStateLabel(item.state)} — ${item.detail} ${item.remediation}`;
}

/**
 * The banner FR-073 requires outside the section: only a state the panel
 * *determined* unmet raises it, because nagging about `not-checkable` would
 * teach the operator to ignore the banner, and `met` never raises it (FR-073's
 * second sentence).
 *
 * @param items - The derived prerequisites.
 * @returns The banner copy, or `null` when nothing checkable is unmet.
 */
export function prerequisiteNotice(items: readonly Prerequisite[]): PrerequisiteNotice | null {
    const unmet = items.filter((item) => item.state === STATE_NOT_MET);
    if (unmet.length === 0) {
        return null;
    }

    const titles = unmet.map((item) => item.title).join(', ');

    return {
        title: 'Setup prerequisites need attention',
        body: `Not met: ${titles}. Each fix is written under ${PREREQUISITES_HEADING}.`,
    };
}

/** The notice banner as it mounts: a wrapper and the banner inside it. */
interface NoticeSurface {
    /** Wrapper whose `hidden` flag is "nothing here needs attention". */
    box: HTMLElement;
    /** The banner itself (FR-073's notice). */
    banner: BannerHandle;
}

/** The section as it mounts: a wrapper, its heading, and its six lines. */
interface SectionSurface {
    /** Wrapper element that owns the heading and the lines. */
    root: HTMLElement;
    /** Section heading. */
    heading: TextHandle;
    /** One line per prerequisite, in {@link derivePrerequisites} order. */
    items: readonly TextHandle[];
}

/**
 * Mounted prerequisite surfaces, keyed by runtime.
 *
 * A `WeakMap` rather than fields on `PanelRuntime` so every piece of this
 * section's state lives in this module (and a runtime that never mounts one
 * keeps no entry at all).
 */
interface PrerequisitesSurface {
    /** Notice above the tab strip, absent until {@link mountPrerequisiteNotice}. */
    notice?: NoticeSurface;
    /** The six-line section, absent until {@link mountPrerequisitesSection}. */
    section?: SectionSurface;
}

/** Mounted surfaces per runtime; absent means "nothing to repaint or dispose". */
const surfaces = new WeakMap<PanelRuntime, PrerequisitesSurface>();

/**
 * Read (or create) one runtime's surface record.
 *
 * @param rt - Panel runtime.
 * @returns The mutable surface record for this runtime.
 */
function surfaceFor(rt: PanelRuntime): PrerequisitesSurface {
    const existing = surfaces.get(rt);
    if (existing !== undefined) {
        return existing;
    }

    const fresh: PrerequisitesSurface = {};
    surfaces.set(rt, fresh);

    return fresh;
}

/**
 * Repaint the notice and the six lines from the current state.
 *
 * Nothing happens on a runtime with no mounted surface, which is what lets
 * every state change route through `refresh` without knowing what is on
 * screen (headless tests, and the window before the first mount).
 *
 * @param rt - Panel runtime.
 */
export function repaintPrerequisites(rt: PanelRuntime): void {
    const surface = surfaces.get(rt);
    if (surface === undefined) {
        return;
    }

    const items = derivePrerequisites(rt.state);
    const { notice, section } = surface;

    if (notice !== undefined) {
        const banner = prerequisiteNotice(items);
        notice.box.hidden = banner === null;
        if (banner !== null) {
            notice.banner.update({ title: banner.title, body: banner.body });
        }
    }

    if (section !== undefined) {
        for (const [index, item] of items.entries()) {
            section.items[index]?.update({ text: prerequisiteLine(item) });
        }
    }
}

/**
 * Mount the FR-073 notice above the tab strip, outside both tab bodies: a
 * notice that disappears when the operator switches tabs is one they can
 * switch away from. The wrapper starts hidden, so a panel that has derived
 * nothing unmet shows no banner until the first repaint paints one.
 *
 * @param input - Runtime, and the panel-root element to append the wrapper to.
 */
export function mountPrerequisiteNotice(input: {
    /** Runtime whose state the banner repaints from. */
    readonly rt: PanelRuntime;
    /** Element above the tab strip the wrapper mounts into. */
    readonly parent: HTMLElement;
}): void {
    const box = input.parent.ownerDocument.createElement('div');
    box.hidden = true;
    input.parent.append(box);

    const banner = mountBanner(box, { tone: 'warning', title: PREREQUISITES_HEADING, body: '' });
    surfaceFor(input.rt).notice = { box, banner };
    repaintPrerequisites(input.rt);
}

/**
 * Mount the six-line section inside the panel's current shell: one wrapper so
 * the heading and its lines read as one thing, one handle per line because
 * each repaints from its own prerequisite.
 *
 * @param input - Runtime, and the spike body the wrapper mounts into.
 */
export function mountPrerequisitesSection(input: {
    /** Runtime whose state the lines repaint from. */
    readonly rt: PanelRuntime;
    /** Spike body the section wrapper mounts into. */
    readonly parent: HTMLElement;
}): void {
    const { rt, parent } = input;
    const root = parent.ownerDocument.createElement('div');
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '4px';
    parent.append(root);

    const heading = mountText(root, { text: PREREQUISITES_HEADING });
    const items = derivePrerequisites(rt.state).map((item) => mountText(root, { text: prerequisiteLine(item) }));
    surfaceFor(rt).section = { root, heading, items };
    repaintPrerequisites(rt);
}

/**
 * Remove every node and handle this module mounted for a runtime.
 *
 * Called from the app's teardown beside the other handle disposals: the
 * wrappers are not part of `PanelUi`, so nothing else would release them.
 *
 * @param rt - Panel runtime being torn down.
 */
export function disposePrerequisites(rt: PanelRuntime): void {
    const surface = surfaces.get(rt);
    if (surface === undefined) {
        return;
    }

    const { notice, section } = surface;
    if (notice !== undefined) {
        notice.banner.dispose();
        notice.box.remove();
    }

    if (section !== undefined) {
        section.heading.dispose();
        for (const item of section.items) {
            item.dispose();
        }

        section.root.remove();
    }

    surfaces.delete(rt);
}
