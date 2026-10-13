/**
 * Bindings-authoritative panel mode: an enabled binding becomes the dispatch context `rt.state.config` carries.
 */

import { DEFAULT_POLL_INTERVAL_MS, parseRepository, parseWorktreeOption } from './config.ts';
import type { BindingContext } from './config.ts';
import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime, PanelStatus } from './panel-state.ts';
import { loadBindings } from './bindings.ts';
import { startRelayPolling } from './relay.ts';
import type { PanelBinding } from './bindings-service.ts';

/**
 * Find the first enabled binding in the list.
 *
 * The list order is the service's stored order, so "first" is stable across
 * repaints and the operator can control it with the enable toggle.
 *
 * @returns The first binding whose state is `active`, or `null` when none is.
 */
export function firstEnabledBinding(bindings: readonly PanelBinding[]): PanelBinding | null {
    return bindings.find((binding) => binding.state === 'active') ?? null;
}

/**
 * Derive the dispatch context from one enabled binding. The binding's
 * repository, project, and worktree option are authoritative; `expectedLogin`
 * stays `null` because the panel's own connected token is a legacy concern the
 * relay never consults, and an inherited login would fail the identity check
 * whenever the panel token differs from the bound account. The poll interval
 * defaults: the relay polls on its own cadence. `null` when the binding row
 * does not parse — the service validates these fields, so this is defensive.
 */
export function bindingContext(binding: PanelBinding): BindingContext | null {
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
 * Derives the dispatch context from the first enabled binding and shows the
 * bindings banner instead of any legacy configuration verdict.
 */
export function applyBindingsMode(rt: PanelRuntime): void {
    const binding = firstEnabledBinding(rt.state.bindings.bindings);
    rt.state.config = binding === null ? null : bindingContext(binding);
    setStatus(rt, bindingsActiveStatus(rt.state.bindingsActive));
}

/**
 * Load the service bindings once at mount and arm the relay (MVP blocker 1). `applySettings` runs
 * before any service read has answered, so a panel with bindings but no legacy settings would show
 * the legacy refusal banner for the whole mount — this re-resolves the configuration once the
 * bindings are in state, and arms the relay only when bindings actually landed, because a relay
 * dispatching against an empty table would drain queued events as `binding-missing` before it saw
 * the binding they belong to. The mount-time arm is deliberately duplicated: `loadBindings` arms
 * on every later read or grant that lands an enabled binding, both idempotent through
 * `startRelayPolling`.
 */
export async function loadInitialBindings(rt: PanelRuntime): Promise<void> {
    await loadBindings(rt);
    if (rt.disposed) {
        return;
    }

    // A disabled-only binding list still arms the relay: pending events can
    // outlive the binding that produced them, and the loop must drain them.
    if (rt.state.bindings.bindings.length > 0) {
        startRelayPolling(rt);
    }
    if (rt.state.bindingsActive > 0) {
        applyBindingsMode(rt);
    }

    refresh(rt);
}
