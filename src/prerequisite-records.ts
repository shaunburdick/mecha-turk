/**
 * The five first-run prerequisites as pure records (003 FR-071–FR-073).
 *
 * Everything here is a function of panel state and nothing else: no mount, no
 * host call, no storage, no persistence — the derivation runs on read so the
 * section can never be stale and can never configure anything (spec
 * `## Key Entities`: read-only reporting). The mounted surfaces that paint
 * these records live in [`prerequisites.ts`](./prerequisites.ts), which is why
 * the two modules split where they do: this file owns *what is true*, that
 * one owns *what it looks like*.
 *
 * Three states only (FR-072): `met`, `not-met`, `not-checkable` — and a
 * prerequisite the panel cannot verify says so rather than displaying a
 * reassuring state it did not check. Two of the five are permanently not
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
 * evidence, and a binding without a project id is unmet.
 *
 * The sixth item this list used to carry — *Service capability approval*,
 * derived from the in-panel consent step — was **removed** by product-owner
 * order on 2026-10-01 together with the consent dialog it read (002 FR-008 as
 * re-cut at v1.9.0; 005 v1.7.0 records the prerequisite's retirement).
 */

import type { Tone } from '@openchamber/sdk/ui';
import { PROJECT_REGISTRATION_ROUTES } from './project-picker.ts';
import type { PanelState } from './panel-state.ts';
import type { PanelAccount, PanelBinding } from './bindings-service.ts';

/** The three states FR-072 allows, and nothing else. */
export type PrerequisiteState = 'met' | 'not-met' | 'not-checkable';

/** The five prerequisites FR-071 names after 005 v1.7.0, as stable identifiers. */
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
    | 'registered-project';

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

/** Stable identifiers, written once each (see {@link PrerequisiteId}). */
const IDS = {
    defaultAgent: 'default-agent',
    openchamberRunning: 'openchamber-running',
    desktopOrWeb: 'desktop-or-web',
    tokenScopes: 'token-scopes',
    registeredProject: 'registered-project',
} as const;

/** Operator-facing titles, written once each so copy cannot drift apart. */
const TITLES = {
    defaultAgent: 'Default Agent pin',
    openchamberRunning: 'OpenChamber running',
    desktopOrWeb: 'Desktop or web surface',
    tokenScopes: 'GitHub token scopes',
    registeredProject: 'Registered project per binding',
} as const;

/**
 * The three states as literals, written once each: the duplicate counter
 * counts every branch that reports one (sonarjs/no-duplicate-string).
 */
export const STATE_MET = 'met';
export const STATE_NOT_MET = 'not-met';
export const STATE_NOT_CHECKABLE = 'not-checkable';

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

    return STATE_MET;
}

/**
 * The chip tone for one state, so a problem is a colour the eye finds.
 *
 * Deliberately three different answers: *met* is green because it is settled,
 * *not met* is red because it is the one state that raises FR-073's notice,
 * and *not checkable* stays neutral because a panel that could not look must
 * not paint a verdict it never reached (FR-072, AC-122).
 *
 * @param state - The prerequisite's state.
 * @returns The badge tone that state renders with.
 */
export function prerequisiteTone(state: PrerequisiteState): Tone {
    if (state === STATE_MET) {
        return 'success';
    }

    if (state === STATE_NOT_MET) {
        return 'error';
    }

    return 'neutral';
}

/**
 * The Default Agent pin: checkable only after a dispatch (FR-072).
 *
 * The remediation names the **setting path** and no agent name, because the
 * default is blank since 006 v1.5.0 / 002 v1.10.0 (product-owner order:
 * *"Default Agent pin should default to blank, not everyone is going to use
 * project-manager"*). Prescribing an agent here would tell every operator the
 * same thing the owner just refused to assume, so the line asks for the agent
 * **they** want dispatches to run on and names the matching `expectedAgent`
 * baseline the comparison actually reads.
 *
 * @returns The prerequisite, always `not-checkable` and never `met`.
 */
function defaultAgentPin(): Prerequisite {
    const remediation =
        'Set Settings → Sessions → Session Defaults → Default Agent to the agent you want dispatches to run on, ' +
        'and set the matching baseline in Settings → expectedAgent; the first dispatch is what checks it — ' +
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
                'Add an account under Accounts, using a GitHub token with ' +
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
 * Derive all five prerequisites from the panel's current state.
 *
 * Pure and synchronous: the same state always answers the same five records,
 * which is what makes the section testable without a host and impossible to
 * leave stale.
 *
 * @param state - Panel state to read.
 * @returns The five prerequisites, in FR-071's order.
 */
export function derivePrerequisites(state: PanelState): readonly Prerequisite[] {
    return [
        defaultAgentPin(),
        openChamberRunning(state.settings !== null),
        desktopOrWebSurface(),
        tokenScopes(state.bindings.accounts),
        registeredProjectPerBinding(state.bindings.bindings),
    ];
}
