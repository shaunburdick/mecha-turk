/**
 * Lifecycle experiment plan and mount bookkeeping (T008): the panel does not
 * assume the host's documented cleanup or that it runs in the background — it
 * records explicit phase markers plus poll activity, and the verdict comes
 * from stored entries ({@link analyzeLastCloseGap}).
 */

import { analyzePollingGap } from './ledger.ts';
import type { GapAnalysis, LifecyclePhase, PanelLedger } from './ledger.ts';

export interface LifecycleStep {
    readonly id: string;
    readonly phase: LifecyclePhase;
    readonly operatorAction: string;
    readonly expectedObservation: string;
    readonly evidenceSource: string;
}

/**
 * The exact S6 lifecycle experiment, in execution order.
 *
 * Every step distinguishes "poll executed" from "extension unloaded" from
 * "subscription cleared": a step is only answered by ledger entries written by
 * a running panel, never by an open panel's appearance.
 */
export const LIFECYCLE_EXPERIMENT_PLAN: readonly LifecycleStep[] = [
    {
        id: 'L1-mounted',
        phase: 'mounted',
        operatorAction: 'Open the panel and let two poll intervals elapse.',
        expectedObservation: 'One mounted phase entry, then two or more poll entries with rising timestamps.',
        evidenceSource: 'host.storage ledger: mounted phase entries and poll entries',
    },
    {
        id: 'L2-closed',
        phase: 'closed',
        operatorAction: 'Close the panel for two poll intervals, then reopen it.',
        expectedObservation: 'A closed entry on unload, no poll entries inside the gap, polling-stopped on reopen.',
        evidenceSource: 'host.storage ledger: closed to mounted gap analysis (analyzePollingGap)',
    },
    {
        id: 'L3-paused',
        phase: 'paused',
        operatorAction: 'Pause the extension, wait two intervals, re-enable it, then reopen the panel.',
        expectedObservation: 'Storage survives a pause: a new mount generation plus an operator paused marker.',
        evidenceSource: 'host.storage ledger: panelGeneration increase and the paused marker',
    },
    {
        id: 'L4-removed',
        phase: 'removed',
        operatorAction: 'Remove the extension, install the folder again, then open the panel.',
        expectedObservation: 'Removal deletes storage, so the new panel reads no prior ledger at all.',
        evidenceSource: 'host.storage ledger: storagePresentBeforeMount and an empty entries list',
    },
    {
        id: 'L5-server-switch',
        phase: 'server-switch',
        operatorAction: 'Switch the OpenChamber server while the panel is closed, then reopen it.',
        expectedObservation: 'Storage is per server, so the panel records no prior ledger on the new server.',
        evidenceSource: 'host.storage ledger on each server: storagePresentBeforeMount and createdAt',
    },
];

export interface MountContext {
    readonly panelGeneration: number;
    readonly storagePresent: boolean;
    readonly priorCorrelationId: string | null;
    readonly priorCreatedAt: string | null;
}

/**
 * Derive mount bookkeeping from whatever ledger storage held.
 *
 * A missing ledger is itself evidence (removal deletes storage, and each
 * server owns its own namespace), so absence is recorded rather than hidden by
 * a silently fresh state.
 */
export function buildMountContext(existing: PanelLedger | null): MountContext {
    if (existing === null) {
        return {
            panelGeneration: 1,
            storagePresent: false,
            priorCorrelationId: null,
            priorCreatedAt: null,
        };
    }

    return {
        panelGeneration: existing.panelGeneration + 1,
        storagePresent: true,
        priorCorrelationId: existing.correlationId,
        priorCreatedAt: existing.createdAt,
    };
}

/**
 * Find the timestamp the gap analysis should start from.
 *
 * @returns The last `closed` phase time, else the last entry time, else `null`.
 */
function findBaseline(ledger: PanelLedger): string | null {
    let baseline: string | null = null;
    for (const entry of ledger.entries) {
        if (entry.kind === 'phase' && entry.phase === 'closed') {
            baseline = entry.at;
        }
    }

    baseline ??= ledger.entries.at(-1)?.at ?? null;

    return baseline;
}

/**
 * Analyse the interval since the panel last stopped writing entries.
 *
 * The baseline is the most recent `closed` phase entry; when the unload write
 * did not survive the frame going away, the last stored entry is used instead.
 * Either way the analysis is driven by stored evidence: a running panel is the
 * only thing that writes `poll` entries.
 *
 * @returns The gap verdict, or `null` when the ledger has no baseline yet.
 */
export function analyzeLastCloseGap(input: { prior: PanelLedger | null; mountedAt: string }): GapAnalysis | null {
    const { prior } = input;
    if (prior === null) {
        return null;
    }

    const baseline = findBaseline(prior);
    if (baseline === null) {
        return null;
    }

    return analyzePollingGap({ ledger: prior, closedAt: baseline, reopenedAt: input.mountedAt });
}
