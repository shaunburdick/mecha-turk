/**
 * The first-run setup-prerequisites section (003 FR-071–FR-073, closing 002's
 * FR-038 conformance gap): five prerequisites, each with a state and its own
 * remediation line, derived on read from panel state — never persisted, never
 * fetched, never able to configure anything (spec `## Key Entities`: this
 * surface is read-only reporting).
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
 * evidence, a binding without a project id is unmet. Every checkable
 * `not-met` also raises a banner **outside**
 * the section (FR-073); a `met` item never does.
 *
 * Rendering follows the DispatchesBoard shape: SDK primitives mounted into a
 * wrapper whose `hidden` flag is the banner's state, repainted through
 * {@link repaintPrerequisites}. Mounted surfaces live in a `WeakMap` keyed by
 * runtime rather than on `PanelRuntime`, so this module owns all its state.
 */

import { mountBadge, mountBanner } from '@openchamber/sdk/ui';
import type { BadgeHandle, BannerHandle } from '@openchamber/sdk/ui';
import { createBlock, mountCell } from './style.ts';
import type { Block, Cell } from './style.ts';
import {
    derivePrerequisites,
    prerequisiteStateLabel,
    prerequisiteTone,
    STATE_NOT_MET,
} from './prerequisite-records.ts';
import type { Prerequisite } from './prerequisite-records.ts';
import type { PanelRuntime } from './panel-state.ts';

// The derivation is the module's public answer as much as the section is:
// callers and suites reach both halves from this one path.
export { derivePrerequisites, prerequisiteStateLabel, prerequisiteTone };
export type { Prerequisite, PrerequisiteId, PrerequisiteState } from './prerequisite-records.ts';

/** The banner FR-073 raises outside the section when something is unmet. */
export interface PrerequisiteNotice {
    /** Banner headline. */
    readonly title: string;
    /** Which prerequisites are unmet and where their fixes live. */
    readonly body: string;
}

/** Heading above the five lines. */
export const PREREQUISITES_HEADING = 'Setup prerequisites';

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

/** One prerequisite as it mounts: title, state chip, remediation, detail. */
interface PrereqCard {
    /** The card surface the four parts live in. */
    readonly card: HTMLElement;
    /** The state chip FR-072's three words paint (005 FR-083). */
    readonly badge: BadgeHandle;
    /** The line that tells the operator what to do about it. */
    readonly remediation: Cell;
    /** What the panel observed, or why it could not observe anything. */
    readonly detail: Cell;
    /** Repaint the three repainted parts from one derived prerequisite. */
    update(item: Prerequisite): void;
    /** Release the badge and both cells, then remove the card. */
    dispose(): void;
}

/** The section as it mounts: a block, its heading, and its five cards. */
interface SectionSurface {
    /** The block surface, disposed with the cards inside it. */
    readonly block: Block;
    /** One card per prerequisite, in {@link derivePrerequisites} order. */
    items: readonly PrereqCard[];
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
    /** The five-line section, absent until {@link mountPrerequisitesSection}. */
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
 * Repaint the notice and the five lines from the current state.
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
            section.items[index]?.update(item);
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
 * Mount one prerequisite as a card: title and state chip on the head line,
 * the remediation under an accent rule, and the observation beneath it.
 *
 * Each of the four strings is the prerequisite's own field, rendered exactly
 * as the derivation produced it — the structure replaces the ` · ` and ` — `
 * the single-line format used to print between them, and changes no word
 * inside any of them.
 *
 * @param parent - The block body to append the card into.
 * @param item - The prerequisite this card shows.
 * @returns The card, repainted and disposed as one unit.
 */
function mountPrereqCard(parent: HTMLElement, item: Prerequisite): PrereqCard {
    const document = parent.ownerDocument;
    const card = document.createElement('article');
    card.className = 'mt-card';
    parent.append(card);

    const head = document.createElement('div');
    head.className = 'mt-card-head';
    const title = document.createElement('h3');
    title.className = 'mt-card-title';
    title.textContent = item.title;
    head.append(title);
    const badge = mountBadge(head, { label: prerequisiteStateLabel(item.state), tone: prerequisiteTone(item.state) });
    card.append(head);

    const remediation = mountCell(card, { className: 'mt-fix', text: item.remediation });
    const detail = mountCell(card, { className: 'mt-card-body', text: item.detail });

    return {
        card,
        badge,
        remediation,
        detail,
        update: (next) => {
            title.textContent = next.title;
            badge.update({ label: prerequisiteStateLabel(next.state), tone: prerequisiteTone(next.state) });
            remediation.update(next.remediation);
            detail.update(next.detail);
        },
        dispose: () => {
            badge.dispose();
            remediation.dispose();
            detail.dispose();
            card.remove();
        },
    };
}

/**
 * Mount the five-card section inside the Status body: one block so the
 * heading and its cards read as one thing, one card per prerequisite because
 * each repaints from its own record.
 *
 * @param input - Runtime, and the Status body the block mounts into.
 */
export function mountPrerequisitesSection(input: {
    /** Runtime whose state the cards repaint from. */
    readonly rt: PanelRuntime;
    /** Status body the block mounts into. */
    readonly parent: HTMLElement;
}): void {
    const { rt, parent } = input;
    const block = createBlock(parent, { heading: PREREQUISITES_HEADING });
    const items = derivePrerequisites(rt.state).map((item) => mountPrereqCard(block.body, item));
    surfaceFor(rt).section = { block, items };
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
        for (const item of section.items) {
            item.dispose();
        }

        section.block.dispose();
    }

    surfaces.delete(rt);
}
