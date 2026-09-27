/**
 * Bindings-authoritative panel mode (MVP blocker 1 fix, 2026-09-27).
 *
 * When the service reports at least one enabled repository binding, the
 * panel's configuration comes from that binding, not from the legacy
 * Settings→Integrations single-repo settings — a banner demanding
 * `repository` is simply wrong with the MVP bindings flow in place. The
 * event relay already dispatches from binding data (the claimed event
 * carries repository, project, and worktree option), so this module only
 * has to keep the banner and the spike surfaces honest: the first enabled
 * binding becomes the authoritative dispatch context for `rt.state.config`,
 * and the legacy single-repo poll loop is stopped so it cannot duplicate
 * the relay's dispatches.
 *
 * MVP-DEBT: the spike tab's manual poll/dispatch buttons still work against
 * the derived context, so a manual "Start session" click could double-start
 * a session the relay also dispatches automatically. Unifying the two
 * dispatch paths is post-MVP work.
 */

import { DEFAULT_POLL_INTERVAL_MS, parseRepository, parseWorktreeOption } from './config.ts';
import type { SpikeConfig } from './config.ts';
import { stopPolling } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime, PanelStatus } from './panel-state.ts';
import { loadRepositories } from './repos.ts';
import { startRelayPolling } from './relay.ts';
import type { PanelBinding } from './repos-service.ts';

/**
 * Find the first enabled binding in the list.
 *
 * The list order is the service's stored order, so "first" is stable across
 * repaints and the operator can control it with the enable toggle.
 *
 * @param bindings - Bindings as the panel last read them from the service.
 * @returns The first binding whose state is `active`, or `null` when none is.
 */
export function firstEnabledBinding(bindings: readonly PanelBinding[]): PanelBinding | null {
    return bindings.find((binding) => binding.state === 'active') ?? null;
}

/**
 * Derive the spike dispatch context from one enabled binding.
 *
 * The binding's repository, project, and worktree option are authoritative;
 * `expectedLogin` stays `null` because the panel's own connected token is a
 * legacy-spike concern the relay never consults, and an inherited login would
 * fail the identity check whenever the panel token differs from the bound
 * account. The poll interval defaults: the relay polls on its own cadence.
 *
 * @param binding - The binding to derive from.
 * @returns The configuration, or `null` when the binding row does not parse
 *   (the service validates these fields, so this is a defensive fallback).
 */
export function bindingContext(binding: PanelBinding): SpikeConfig | null {
    const repository = parseRepository(binding.repository);
    if (repository === null) {
        return null;
    }

    return {
        repository,
        expectedLogin: null,
        projectId: binding.projectId,
        worktree: parseWorktreeOption(binding.worktreeOption) ?? { kind: 'none' },
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    };
}

/**
 * Build the info banner for bindings-authoritative mode.
 *
 * @param count - How many bindings are enabled.
 * @returns The banner content.
 */
export function bindingsActiveStatus(count: number): PanelStatus {
    return {
        tone: 'info',
        title: 'Bindings active',
        body: `${count} binding(s) active; legacy single-repo settings ignored`,
    };
}

/**
 * Put the panel into bindings-authoritative mode.
 *
 * Derives the dispatch context from the first enabled binding, stops the
 * legacy single-repo poll loop (the relay owns the loop in this mode), and
 * shows the bindings banner instead of any legacy configuration verdict.
 *
 * @param rt - Panel runtime.
 */
export function applyBindingsMode(rt: PanelRuntime): void {
    const binding = firstEnabledBinding(rt.state.repos.bindings);
    rt.state.config = binding === null ? null : bindingContext(binding);
    stopPolling(rt);
    setStatus(rt, bindingsActiveStatus(rt.state.bindingsActive));
}

/**
 * Load the service bindings once at mount and arm the relay (MVP blocker 1).
 *
 * `applySettings` runs before any service read has answered, so a panel with
 * bindings but no legacy settings would otherwise show the legacy refusal
 * banner for the whole mount. This check re-resolves the configuration once
 * the bindings are in state, and arms the event relay — but only when
 * bindings actually landed, because a relay dispatching against an empty
 * binding table would drain queued events as `binding-missing` before it
 * ever saw the binding they belong to.
 *
 * @param rt - Panel runtime.
 */
export async function loadInitialBindings(rt: PanelRuntime): Promise<void> {
    await loadRepositories(rt);
    if (rt.disposed) {
        return;
    }

    // A disabled-only binding list still arms the relay: pending events can
    // outlive the binding that produced them, and the loop must drain them.
    if (rt.state.repos.bindings.length > 0) {
        startRelayPolling(rt);
    }
    if (rt.state.bindingsActive > 0) {
        applyBindingsMode(rt);
    }

    refresh(rt);
}
