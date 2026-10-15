/**
 * Startup vocabulary, console milestones, and the two failure surfaces (005
 * FR-140 – FR-142, NFR-115): one builder per failure, so the console entry and
 * the surface an operator sees carry the same stage string and the same error
 * text by construction rather than by promise.
 */

import { mountBanner } from '@openchamber/sdk/ui';
import { correlationIdMode } from './ids.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The mount-lifecycle stages, closed: no surface or test may coin a label. */
export const STARTUP_STAGES = [
    'startup markup',
    'host bridge',
    'runtime construction',
    'shell mount',
    'initial setup',
] as const;

export type StartupStage = (typeof STARTUP_STAGES)[number];

/** The static notice, outside `#root`, so it survives a bundle that never runs. */
export const STARTUP_NOTICE = '#panel-startup-notice';

/** Its detail node — where a failure that never mounted a shell is written. */
export const STARTUP_DETAIL = '#panel-startup-detail';

/** The one recovery a startup failure offers: the operator reopens the panel. */
export const STARTUP_RECOVERY = 'Reopen the panel to try again.';

/** What a never-mounted failure adds when the frame explicitly reports insecure. */
const INSECURE_CONTEXT_NOTE =
    ' The environment is not a secure context; serve OpenChamber over HTTPS or localhost.';

/** FR-144's announcement, on the milestone that first carries the environment. */
const FALLBACK_MINT = 'getRandomValues'
    + ' (crypto.randomUUID is unavailable; the getRandomValues fallback is in use)';

/**
 * The document face this module addresses: an `#id` lookup whose result can
 * take text or leave the page. Both the frame's `Document` and the test
 * double satisfy it, which is what keeps the runner testable without a DOM.
 */
export interface StartupDocument {
    querySelector(selectors: string): StartupNode | null;
}

/** What the notice path needs of a node: a text slot, and removal. */
export interface StartupNode {
    textContent: string | null;
    remove(): void;
}

/** The environment record only a startup's first milestone carries. */
export interface StartupEnvironment {
    readonly secureContext: boolean;
    readonly randomUuidAvailable: boolean;
    readonly mint: string;
}

/** One failure as both surfaces read it: the stage token and the full text. */
export interface StartupFailure {
    readonly stage: StartupStage;
    readonly text: string;
}

/** What `recordStartupFailure` routes and records. */
export interface StartupFailureInput {
    readonly stage: StartupStage;
    readonly cause: unknown;
    /** Whether the `shell mount` stage completed — the one routing predicate. */
    readonly shellMounted: boolean;
    readonly runtime: PanelRuntime | null;
    readonly doc: StartupDocument | null;
    /** Attached to a startup's first entry only, so a stage-1 failure still records it. */
    readonly environment: StartupEnvironment | null;
    /** True only where the environment reports `window.isSecureContext === false`. */
    readonly insecureContext: boolean;
}

/**
 * The environment the first milestone of a startup records: secure context,
 * `crypto.randomUUID` availability, and the mint in use — naming the
 * `getRandomValues` fallback in full whenever it is taken, which is FR-144's
 * exactly-once announcement. Nothing failed when it appears, so it is a
 * milestone, never a failure surface.
 */
export function startupEnvironment(isSecureContext: boolean): StartupEnvironment {
    const mode = correlationIdMode();

    return {
        secureContext: isSecureContext,
        randomUuidAvailable: mode === 'randomUUID',
        mint: mode === 'getRandomValues' ? FALLBACK_MINT : mode,
    };
}

/** The version the single version source carries, `unknown` before it answers. */
function versionOf(runtime: PanelRuntime | null): string {
    return runtime?.state.aboutTab.version ?? 'unknown';
}

/** Write one milestone in the fixed entry shape FR-142 pins. */
function writeMilestone(entry: {
    readonly stage: StartupStage;
    readonly outcome: 'ok' | 'failed';
    readonly runtime: PanelRuntime | null;
    readonly environment: StartupEnvironment | null;
    readonly error: string | null;
}): void {
    const { environment } = entry;
    const env = environment === null
        ? ''
        : ` secure-context=${String(environment.secureContext)}`
            + ` random-uuid=${String(environment.randomUuidAvailable)}`
            + ` mint="${environment.mint}"`;
    const failure = entry.error === null ? '' : ` error="${entry.error}"`;
    const head = `stage="${entry.stage}" outcome=${entry.outcome}`;
    const version = `version=${versionOf(entry.runtime)}`;

    // Two arguments, one line: the log rules want a literal message first.
    // eslint-disable-next-line no-console -- FR-142 makes these shipped product behaviour, not a debugging leftover
    console.log('[mecha-turk/startup]', `${head}${env} ${version}${failure}`);
}

/**
 * Record one stage that ran to completion. The runner emits these for the
 * first four stages; `begin` emits the fifth, after the runner has returned.
 */
export function emitStartupStage(input: {
    readonly stage: StartupStage;
    readonly runtime: PanelRuntime | null;
    readonly environment: StartupEnvironment | null;
}): void {
    writeMilestone({
        stage: input.stage,
        outcome: 'ok',
        runtime: input.runtime,
        environment: input.environment,
        error: null,
    });
}

/**
 * Build one failure: the message verbatim — never `describeError()`, which
 * would prefix it — plus the insecure-context remediation exactly where the
 * environment reports an insecure frame and nowhere else.
 */
function buildFailure(input: StartupFailureInput): StartupFailure {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const annotation = input.insecureContext ? INSECURE_CONTEXT_NOTE : '';

    return { stage: input.stage, text: `${message}${annotation}` };
}

/**
 * Render one failure where the operator is looking: the top-of-panel banner
 * once the shell exists (it shows whichever tab is active), the static notice
 * before it — the only surface a half-built shell can reach. Both write text
 * through created nodes, never markup (FR-080).
 */
function renderFailure(input: StartupFailureInput, failure: StartupFailure): void {
    const root = input.runtime?.root ?? null;
    if (root !== null && input.shellMounted) {
        const box = root.ownerDocument.createElement('div');
        root.prepend(box);
        mountBanner(box, { tone: 'error', title: failure.stage, body: `${failure.text} ${STARTUP_RECOVERY}` });

        return;
    }

    const detail = input.doc?.querySelector(STARTUP_DETAIL) ?? null;
    if (detail !== null) {
        detail.textContent = `${failure.stage}: ${failure.text}`;
    }
}

/**
 * Record a failed startup: the console entry first, so a DOM the operator
 * edited by hand still leaves the record; then the fail-closed gate fields
 * whenever there is a runtime to clear; then the visible surface.
 */
export function recordStartupFailure(input: StartupFailureInput): void {
    const failure = buildFailure(input);
    writeMilestone({
        stage: input.stage,
        outcome: 'failed',
        runtime: input.runtime,
        environment: input.environment,
        error: failure.text,
    });

    if (input.runtime !== null) {
        // Nothing settles this gate again: a panel whose startup failed may
        // not claim a dispatch or start a session (FR-141's fail-closed clause).
        input.runtime.reconcileSettled = false;
        input.runtime.relayArmPending = false;
    }

    renderFailure(input, failure);
}
