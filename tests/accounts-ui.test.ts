/**
 * Rendering-contract tests for the one-shot handoff (task T-009,
 * token-handoff §1.1/§2 step ①, panel-service §3 invariant 11).
 *
 * The render step is a pure mapping from state onto a view, so these tests
 * drive it with the recording double: the consent copy must arrive verbatim,
 * the input must stay gated on consent **and** a writable pre-flight, and no
 * rendered string may carry a credential. The DOM adapter itself is checked
 * by a static scan — it must write through `textContent`/`setAttribute` only
 * and must pin `type="password"` with `autocomplete="new-password"` — and
 * (review F-E) that sink scan now covers **every** module under
 * `extension/src`, not just the adapter.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptServiceAccounts } from '../extension/src/account-adoption.ts';
import {
    acceptConsentAndRepaint,
    handoffInputEnabled,
    refreshHandoff,
    renderHandoff,
} from '../extension/src/accounts-ui.ts';
import {
    CONSENT_COPY_V1,
    CONSENT_STORAGE_KEY,
    CONSENT_VERSION,
    restoreStoredConsent,
} from '../extension/src/consent.ts';
import { ACCOUNTS_STORAGE_KEY } from '../extension/src/account-mirror.ts';
import { STORAGE_REFUSAL } from '../extension/src/handoff-copy.ts';
import {
    CONNECTED_ID,
    CONNECTED_LOGIN,
    GIVEN_AT,
    PANEL_TOKEN,
    STATUS_BODY,
    initialState,
    recordingView,
    scopeResults,
    scriptedRuntime,
} from './support/handoff.ts';
import { createStorageDouble, createTestRuntime, fakeHost } from './support/panel.ts';

/** Filesystem path of the DOM adapter, for the static rendering scan. */
const DOM_SOURCE_PATH = resolve(import.meta.dirname, '../extension/src/accounts-ui.ts');

/** Directory holding every panel module the widened scan reads (F-E). */
const SRC_DIR = resolve(import.meta.dirname, '../extension/src');

/** Usage patterns of the HTML sinks contract §4 rule 5 forbids. */
const HTML_SINKS: readonly RegExp[] = [
    /\.innerHTML\b/,
    /insertAdjacentHTML\s*\(/,
    /\.outerHTML\b/,
    /\.insertAdjacentText\s*\(/,
    /\bdocument\.write\s*\(/,
];
/** Assert that a list of rendered strings carries no registered credential. */
function expectNoCredentialInStrings(strings: readonly string[]): void {
    expect(strings.join('\n')).not.toContain(PANEL_TOKEN);
}
describe('rendering (contract §1.1, §4 rule 5, SEC-17)', () => {
    it('renders CONSENT_COPY_V1 verbatim into the consent step', () => {
        const record = recordingView();

        renderHandoff(
            { ...initialState(), consentGiven: false },
            record.view,
        );

        expect(record.consentText).toBe(CONSENT_COPY_V1);
        expect(record.consentShown).toBe(true);
        expectNoCredentialInStrings(record.rendered);
    });

    it('hides the consent step once the current copy is accepted', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), consentGiven: true }, record.view);

        expect(record.consentShown).toBe(false);
    });

    it('enables the credential input only after consent and a writable pre-flight', () => {
        const base = initialState();
        const record = recordingView();

        expect(handoffInputEnabled({ ...base, consentGiven: true })).toBe(false);
        expect(handoffInputEnabled({ ...base, storageWritable: true })).toBe(false);
        expect(
            handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true }),
        ).toBe(true);
        expect(handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true, busy: true })).toBe(false);

        renderHandoff({ ...base, consentGiven: true, storageWritable: true }, record.view);
        expect(record.tokenEnabled).toBe(true);
        expect(record.submitEnabled).toBe(true);
    });

    it('renders the connected line through the view, never as markup', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), connected: { numericUserId: '1', login: 'octocat' } }, record.view);

        expect(record.connected).toBe('Connected as octocat');
    });

    it('keeps DOM rendering on textContent and the pinned input attributes', () => {
        const source = readFileSync(DOM_SOURCE_PATH, 'utf8');

        expect(source).toContain('textContent');
        expect(source).toContain("setAttribute('type', 'password')");
        expect(source).toContain("setAttribute('autocomplete', 'new-password')");
        // Usage, not vocabulary: the module's own docs name the forbidden
        // sinks, so the scan looks for how they would actually be called.
        expect(source).not.toMatch(/\.innerHTML\b/);
        expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
        expect(source).not.toMatch(/\.outerHTML\b/);
    });

    it('keeps every module of extension/src on text-only sinks (F-E)', () => {
        const modules = readdirSync(SRC_DIR, { recursive: true })
            .map((entry) => String(entry))
            .filter((entry) => entry.endsWith('.ts'));

        // A scan that matched nothing would be reading the wrong directory.
        expect(modules.length).toBeGreaterThan(1);
        for (const relative of modules) {
            const source = readFileSync(join(SRC_DIR, relative), 'utf8');
            for (const sink of HTML_SINKS) {
                expect(source, `${relative} must not call ${sink.source}`).not.toMatch(sink);
            }
        }
    });
});

describe('silent account adoption (MVP blocker 2)', () => {
    it('adopts a service-side account after a reinstall and hides the paste form', async () => {
        const accountsBody = JSON.stringify({
            accounts: [
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN,
                    state: 'active',
                    scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
                },
            ],
        });
        // Reinstall state: host.storage is wiped — no consent mirror, no
        // account mirror. Only the service still holds the account.
        const host = await scriptedRuntime(
            (request) => {
                return request.path === '/v1/accounts'
                    ? { status: 200, body: accountsBody }
                    : { status: 200, body: STATUS_BODY };
            },
            {},
        );

        await adoptServiceAccounts(host.rt);
        refreshHandoff(host.rt);

        expect(host.rt.state.handoff.connected).toEqual({ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN });
        expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
        expect(host.record.pasteVisible).toBe(false);
        expect(host.record.consentShown).toBe(false);
        // The adoption rewrote the mirror the reinstall deleted, so the
        // next mount adopts from storage without touching the service.
        const mirrored = host.storage.values.get(ACCOUNTS_STORAGE_KEY);
        expect(mirrored).toBeDefined();
        expect(JSON.stringify(mirrored)).toContain(CONNECTED_ID);
    });
});

describe('accepting the consent step (MVP blocker: Accept did not stick)', () => {
    it('persists the mirror and hides the consent card after Accept', async () => {
        // No stored mirror: this install has not encountered the copy yet.
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            {},
        );

        await acceptConsentAndRepaint(host.rt);

        expect(host.storage.values.get(CONSENT_STORAGE_KEY)).toMatchObject({ version: CONSENT_VERSION });
        expect(host.rt.state.handoff.consentGiven).toBe(true);
        // Working storage: the card is gone for this mount and the mirror
        // the re-consent gate reads at submit time now exists.
        expect(host.record.consentShown).toBe(false);
        expect(host.record.note).toBe('');
    });

    it('keeps the consent card and names the storage refusal when the write fails', async () => {
        const storage = createStorageDouble({});
        const host = fakeHost({
            storage: {
                ...storage.storage,
                set: async () => {
                    throw new Error('storage offline');
                },
            },
        });
        const rt = createTestRuntime(host);
        const record = recordingView();
        rt.handoffView = record.view;

        await acceptConsentAndRepaint(rt);

        // Fail closed and show it: no mirror stored, no pretend-accepted
        // state, and the operator sees why the card is still there.
        expect(storage.values.has(CONSENT_STORAGE_KEY)).toBe(false);
        expect(rt.state.handoff.consentGiven).toBe(false);
        expect(record.consentShown).toBe(true);
        expect(record.note).toBe(STORAGE_REFUSAL);
        // The pasted-token gate stays shut without a stored mirror, so the
        // input can never appear while the consent step is unresolved.
        expect(handoffInputEnabled(rt.state.handoff)).toBe(false);
    });

    it('re-accepting after a refused write retries the mirror write', async () => {
        const storage = createStorageDouble({});
        let refused = true;
        const host = fakeHost({
            storage: {
                ...storage.storage,
                set: async (key, value) => {
                    if (refused) {
                        throw new Error('storage offline');
                    }
                    await storage.storage.set(key, value);
                },
            },
        });
        const rt = createTestRuntime(host);
        const record = recordingView();
        rt.handoffView = record.view;

        await acceptConsentAndRepaint(rt);
        expect(rt.state.handoff.consentGiven).toBe(false);

        refused = false;
        await acceptConsentAndRepaint(rt);

        expect(rt.state.handoff.consentGiven).toBe(true);
        expect(storage.values.get(CONSENT_STORAGE_KEY)).toMatchObject({ version: CONSENT_VERSION });
        expect(record.consentShown).toBe(false);
    });
});

describe('restoring accepted consent at mount (remount must not re-ask)', () => {
    it('sets consentGiven from the current stored mirror before the first repaint', async () => {
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            { [CONSENT_STORAGE_KEY]: { givenAt: GIVEN_AT, version: CONSENT_VERSION } },
        );

        await restoreStoredConsent(host.rt);
        refreshHandoff(host.rt);

        expect(host.rt.state.handoff.consentGiven).toBe(true);
        expect(host.record.consentShown).toBe(false);
    });

    it('treats a missing, stale, or unreadable mirror as no consent', async () => {
        const absent = createTestRuntime(fakeHost({ storage: createStorageDouble({}).storage }));
        await restoreStoredConsent(absent);
        expect(absent.state.handoff.consentGiven).toBe(false);

        const stale = createTestRuntime(
            fakeHost({
                storage: createStorageDouble({ [CONSENT_STORAGE_KEY]: { givenAt: GIVEN_AT, version: 0 } }).storage,
            }),
        );
        await restoreStoredConsent(stale);
        expect(stale.state.handoff.consentGiven).toBe(false);

        const broken = createTestRuntime(
            fakeHost({
                storage: {
                    get: async () => {
                        throw new Error('storage unavailable');
                    },
                    set: () => Promise.resolve(),
                    delete: () => Promise.resolve(),
                    keys: async () => [],
                },
            }),
        );
        await restoreStoredConsent(broken);
        expect(broken.state.handoff.consentGiven).toBe(false);

        // Repaint from the broken read: the card shows, with no crash.
        const record = recordingView();
        broken.handoffView = record.view;
        refreshHandoff(broken);
        expect(record.consentShown).toBe(true);
    });

    it('leaves the gate exactly as the stored mirror says, not the memory', async () => {
        // An in-memory "true" from a previous mount must not survive when the
        // stored mirror says otherwise — the mirror is the durable record.
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            {},
        );
        host.rt.state.handoff.consentGiven = true;

        await restoreStoredConsent(host.rt);

        expect(host.rt.state.handoff.consentGiven).toBe(false);
    });
});

