/**
 * The selected binding's chip row (2026-09-30 visual redesign).
 *
 * A binding row prints *enabled* inside the subtitle the operator reads as
 * prose, and the form below it restates the triggers as checkboxes — so the
 * facts that decide whether a binding polls are present but never in one
 * place the eye can land on. This module lifts them out: one chip for the
 * state, coloured by whether the binding polls, and one chip per trigger it
 * actually listens to (005 FR-053's detail, given a shape).
 *
 * The trigger words are exported because the form's checkboxes use the same
 * labels: defined once here, an "Assignment" chip and an "Assignment" box
 * cannot drift into saying different things.
 */

import { mountBadge } from '@openchamber/sdk/ui';
import type { BadgeHandle } from '@openchamber/sdk/ui';
import type { BindingsTabState } from './panel-state.ts';

/** Trigger chip words — the form's own checkbox labels, written once each. */
export const TRIGGER_ASSIGNMENT = 'Assignment';

/** Mention trigger, shared with the form's checkbox. */
export const TRIGGER_MENTION = 'Mention';

/** Review-request trigger, shared with the form's checkbox. */
export const TRIGGER_REVIEW = 'Review request';

/** The two states a binding row can be in, as its chip prints them. */
const STATE_ON = 'enabled';

/** The state chip for a binding that does not poll. */
const STATE_OFF = 'disabled';

/** The chip row over the selected binding's detail line. */
export interface DetailChips {
    /** Repaint the chips from the current selection, or clear them. */
    paint(bindings: BindingsTabState): void;
    /** Release every chip handle the row owns. */
    dispose(): void;
}

/**
 * Mount the chip row above the selected binding's detail line.
 *
 * They describe the *selected* binding, which is exactly the one the form
 * underneath it edits — so the chips and the form cannot disagree about which
 * row they are about.
 *
 * @param detailBox - The wrapper the detail line lives in.
 * @returns The chip row, repainted and disposed as one unit.
 */
export function mountDetailChips(detailBox: HTMLElement): DetailChips {
    const container = detailBox.ownerDocument.createElement('div');
    container.className = 'mt-chiprow';
    detailBox.append(container);
    let chips: BadgeHandle[] = [];

    const paint = (bindings: BindingsTabState): void => {
        for (const chip of chips) {
            chip.dispose();
        }

        chips = [];
        const row = bindings.bindings.find((binding) => binding.bindingId === bindings.selectedBinding);
        if (row === undefined) {
            return;
        }

        const active = row.state === 'active';
        chips.push(mountBadge(container, {
            label: active ? STATE_ON : STATE_OFF,
            tone: active ? 'success' : 'warning',
        }));
        const triggers = [
            [row.triggers.assignment, TRIGGER_ASSIGNMENT],
            [row.triggers.mention, TRIGGER_MENTION],
            [row.triggers.reviewRequest, TRIGGER_REVIEW],
        ] as const;
        for (const [enabled, label] of triggers) {
            if (enabled) {
                chips.push(mountBadge(container, { label, tone: 'info' }));
            }
        }
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
