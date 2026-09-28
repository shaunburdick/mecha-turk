/**
 * The FR-008 handoff consent: copy, version, and the panel-side mirror rules
 * (token-handoff contract §1.1/§1.2).
 *
 * The contract block quoted in `specs/002-agent-event-extension/contracts/
 * token-handoff.md` §1.1 is the **only** definition of this wording in the
 * repository (SEC-12). The machine-readable copy lives in
 * `consent-copy.json` — plain JSON, so the long paragraphs stay readable and
 * line-for-line comparable with the contract — and the panel renders those
 * paragraphs without reading a Markdown file that is not part of the
 * installed extension folder. `tests/consent.test.ts` extracts the contract
 * block and fails whenever the two drift in any word, so a wording change
 * without a version bump (or a bump without a wording change) breaks the
 * build rather than shipping a stale "yes".
 *
 * The only permitted transformation is the removal of Markdown `**emphasis**`
 * markers: the panel renders through `textContent`, where those characters
 * would appear literally instead of as emphasis.
 */

import consentCopy from './consent-copy.json';
import type { PanelRuntime } from './panel-state.ts';

/** Current consent copy version; bumps whenever any character of the copy changes. */
export const CONSENT_VERSION: number = consentCopy.version;

/** `CONSENT_COPY_V1` as the contract's §1.1 blockquote holds it: four paragraphs. */
export const CONSENT_COPY_PARAGRAPHS: readonly string[] = consentCopy.paragraphs;

/** The consent copy as one renderable string; paragraphs separated by a blank line. */
export const CONSENT_COPY_V1: string = CONSENT_COPY_PARAGRAPHS.join('\n\n');

/**
 * What the panel records in `host.storage` after the operator accepts the
 * consent step — an occurrence only, never a token and never a login (§1.1).
 */
export interface ConsentMirror {
    /** RFC 3339 timestamp of the acceptance. */
    readonly givenAt: string;
    /** Consent copy version the operator accepted. */
    readonly version: number;
}

/** `host.storage` key holding {@link ConsentMirror} (data-model.md storage tier 2). */
export const CONSENT_STORAGE_KEY = 'consent';

/**
 * Narrow a stored value to a consent mirror.
 *
 * @param raw - Value read from `host.storage`, in any shape.
 * @returns The mirror, or `null` when absent or structurally unusable — an
 *   unreadable consent is treated as *no* consent, never as an accepted one.
 */
export function readConsentMirror(raw: unknown): ConsentMirror | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const { givenAt, version } = record;
    if (typeof givenAt !== 'string' || typeof version !== 'number' || !Number.isInteger(version)) {
        return null;
    }

    return { givenAt, version };
}

/**
 * Decide whether a stored consent still covers the current copy.
 *
 * Implements the §1.2 re-consent rule: a mirror whose `version` is below the
 * current `CONSENT_VERSION` forces the consent step again, so an old "yes"
 * never covers new wording. `null` (never consented, or unreadable) is always
 * unsatisfied.
 *
 * @param mirror - Stored mirror, or `null`.
 * @param currentVersion - Version to compare against; defaults to this build's.
 * @returns `true` only when the stored acceptance covers the current copy.
 */
export function consentCurrent(mirror: ConsentMirror | null, currentVersion: number = CONSENT_VERSION): boolean {
    return mirror !== null && mirror.version >= currentVersion;
}

/**
 * Restore the consent repaint state from the stored mirror (§1.1/§1.2).
 *
 * The stored acceptance is the durable record, but until now it was read only
 * when a credential was submitted: a panel that remounted after Accepting
 * re-showed the consent step, so the operator's "yes" never appeared to stick.
 * Run this at mount, before the first handoff repaint — an unreadable or
 * stale mirror is *no* consent, exactly as {@link consentCurrent} rules.
 *
 * @param rt - Panel runtime whose handoff state receives the restored flag.
 */
export async function restoreStoredConsent(rt: PanelRuntime): Promise<void> {
    try {
        const mirror = readConsentMirror(await rt.host.storage.get(CONSENT_STORAGE_KEY));
        rt.state.handoff.consentGiven = consentCurrent(mirror);
    } catch {
        rt.state.handoff.consentGiven = false;
    }
}
