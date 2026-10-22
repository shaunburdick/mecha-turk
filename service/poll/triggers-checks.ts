/**
 * The failing-checks detector: one bounded check-runs read per new head SHA
 * (FR-126 – FR-130).
 */

import { repositoryRefOf } from '../../src/config.ts';
import { checksFollowUp } from './follow-up.ts';
import type { HeadMovement } from './follow-up.ts';
import type { PollPull } from './poller-github.ts';
import type { HeadChecksOutcome } from './poller-checks.ts';
import type { QueuedEvent } from './events.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

/**
 * Read each movement's new SHA once and collect one row per tracked pull.
 *
 * Two pulls moved to one SHA share one read. A truncated walk is recorded with
 * the SHA and produces no row; no failing conclusion produces no row either.
 * The actor gate lives in {@link checksFollowUp}, exactly as it does for the
 * head follow-up.
 */
export async function triggersChecks(
    input: TriggerScanInput & {
        readonly pulls: readonly PollPull[];
        readonly movements: readonly HeadMovement[];
    },
): Promise<TriggerEvents> {
    const { binding, poller, token, pace, tracked, detectedAt, movements, pulls } = input;
    const repository = repositoryRefOf(binding.repository);
    const byNumber = new Map(pulls.map((pull) => [pull.pullNumber, pull]));
    const reads = new Map<string, HeadChecksOutcome>();
    const events: QueuedEvent[] = [];

    for (const movement of movements) {
        let listed = reads.get(movement.headSha);
        if (listed === undefined) {
            listed = await poller.listHeadChecks({
                token,
                owner: repository.owner,
                name: repository.name,
                headSha: movement.headSha,
                pace,
            });
            reads.set(movement.headSha, listed);
        }

        if (listed.kind !== 'ok') {
            return { ok: false, failure: listed };
        }

        if (listed.truncated) {
            input.log.warn('check-runs walk truncated; this head produces nothing this cycle', {
                headSha: movement.headSha,
            });
            continue;
        }

        const pull = byNumber.get(movement.pullNumber);
        const subject = tracked.get(movement.pullNumber);
        if (pull === undefined || subject === undefined || listed.conclusion === null) {
            continue;
        }

        const row = checksFollowUp({
            binding,
            pull,
            tracked: subject,
            conclusion: listed.conclusion,
            names: listed.names,
            detectedAt,
        });
        if (row !== null) {
            events.push(row);
        }
    }

    return { ok: true, events };
}
