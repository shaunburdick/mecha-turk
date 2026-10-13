/**
 * The selected account's chip row: connection and scope verdict lifted into
 * one place, each coloured so a problem reads as a problem (005 FR-062,
 * FR-083); an absent matrix reads *not checked*, never *ok* (FR-003).
 */

import { mountBadge } from '@openchamber/sdk/ui';
import type { BadgeHandle, Tone } from '@openchamber/sdk/ui';
import { connectionPhrase, SCOPE_UNCHECKED } from './accounts-rows.ts';
import type { PanelAccount } from './bindings-service.ts';

const SCOPE_LABEL_PREFIX = 'scope: ';

export interface DetailChips {
    paint(account: PanelAccount | null): void;
    dispose(): void;
}

/** The connection phrases the panel reads as an amber warning rather than a pass. */
const WARNING_PHRASES: ReadonlySet<string> = new Set(['auth-failed', 'rate-limited', 'offline']);

/**
 * The tone for one reported connection.
 *
 * Only the state the service actually reports colours the chip: *connected*
 * is green, the three named failures are amber, and anything else — a state
 * this build does not name, or none reported at all — stays neutral rather
 * than being read as either a pass or a fault.
 */
function connectionTone(phrase: string): Tone {
    if (phrase === 'connected') {
        return 'success';
    }

    if (WARNING_PHRASES.has(phrase)) {
        return 'warning';
    }

    return 'neutral';
}

/**
 * The tone for the recorded scope verdict.
 *
 * @returns The badge tone, neutral while there is no evidence either way.
 */
function scopeTone(account: PanelAccount): Tone {
    if (account.scope === 'ok') {
        return 'success';
    }

    return account.scope === 'missing' ? 'error' : 'neutral';
}

/**
 * Mount the chip row above the selected account's detail line.
 *
 * They describe the *selected* account, which is exactly the one the display
 * name, rotation, and removal controls underneath them act on.
 */
export function mountDetailChips(detailBox: HTMLElement): DetailChips {
    const container = detailBox.ownerDocument.createElement('div');
    container.className = 'mt-chiprow';
    detailBox.append(container);
    let chips: BadgeHandle[] = [];

    const paint = (account: PanelAccount | null): void => {
        for (const chip of chips) {
            chip.dispose();
        }

        chips = [];
        if (account === null) {
            return;
        }

        const connection = connectionPhrase(account);
        chips.push(mountBadge(container, { label: connection, tone: connectionTone(connection) }));
        const scope = account.scope === undefined ? SCOPE_UNCHECKED : `${SCOPE_LABEL_PREFIX}${account.scope}`;
        chips.push(mountBadge(container, { label: scope, tone: scopeTone(account) }));
    };

    return {
        paint,
        dispose: () => {
            for (const chip of chips) {
                chip.dispose();
            }

            chips = [];
        },
    };
}
