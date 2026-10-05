/**
 * The selected account's chip row.
 *
 * An account row already prints its connection and its scope inside the
 * subtitle the operator reads as prose, and the detail line under it restates
 * both at greater length — so the two facts that decide whether an account
 * can poll are present but never in one place the eye can land on. This
 * module lifts them out: one chip for the connection the service reported,
 * one for the recorded scope verdict, each coloured so a problem reads as a
 * problem (005 FR-062, FR-083).
 *
 * Every label is existing copy: the connection chip is the phrase the row
 * already prints, and the scope chip is the same `scope: …` prefix with the
 * verdict the mirror recorded. Nothing here invents a verdict the service did
 * not give — an absent matrix reads *not checked*, never *ok* (FR-003).
 */

import { mountBadge } from '@openchamber/sdk/ui';
import type { BadgeHandle, Tone } from '@openchamber/sdk/ui';
import { connectionPhrase, SCOPE_UNCHECKED } from './accounts-rows.ts';
import type { PanelAccount } from './bindings-service.ts';

/** Prefix the scope chip shares with the detail line's own scope phrase. */
const SCOPE_LABEL_PREFIX = 'scope: ';

/** The chip row over the selected account's detail line. */
export interface DetailChips {
    /** Repaint the chips for the open account, or clear them. */
    paint(account: PanelAccount | null): void;
    /** Release every chip handle the row owns. */
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
 *
 * @param phrase - The connection phrase the row prints.
 * @returns The badge tone for that phrase.
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
 * @param account - The account whose matrix decides it.
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
 *
 * @returns The chip row, repainted and disposed as one unit.
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
