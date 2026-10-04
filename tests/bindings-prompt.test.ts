/**
 * Each starting-prompt **tier value** renders exactly once in the whole panel
 * (005 T-021 as re-cut at 005 v1.9.0 / 004 v1.3.0: SC-105, FR-051, FR-052,
 * AC-123, AC-124; 004 FR-014, FR-063, FR-064, FR-089, AC-144).
 *
 * Four promises are asserted here:
 *
 * 1. **T-032 / SC-105 / AC-123** — mounting all six tab bodies over a seeded
 *    **global**, **account**, and **binding** prompt (three distinct
 *    sentinels) and counting every element whose current props carry each one
 *    answers **one** for each — the count that fails at zero (the site
 *    vanished) and at two (a second surface started carrying a tier's value)
 *    alike. The count is taken from the mounts themselves rather than from a
 *    source scan, because a string can sit in the source and never reach the
 *    DOM — or the reverse — and each element counts once however many
 *    repaints it received.
 * 2. **T-039** — the binding tier's field carries FR-063's five-fact
 *    guidance and FR-064's honest `not set`, with no panel-side validation
 *    of its own: the service stays the only validator (plan D24), a refusal
 *    keeps the field's slot without echoing the value, and the row summary
 *    shows presence and length only.
 * 3. **The wire shape** (004 FR-014) — an untouched prompt is **absent** from
 *    the whole-file PUT, and a cleared one travels as an explicit empty value
 *    on exactly one row. Both are asserted on the raw request body, because
 *    "the key is missing" is a fact about bytes, not about an object.
 * 4. **AC-124** — a refusal lands at the field with the service's own
 *    remediation, the previously stored prompt stays in force, and nothing is
 *    reported as saved.
 *
 * Offline: a fake host, recorded service legs, and the DOM double. No live
 * OpenChamber, no PAT, no network (FR-086).
 */

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { selectAccountRow } from '../src/accounts-tab.ts';
import { accountRows } from '../src/accounts-rows.ts';
import { createBindingsHandlers, mountBindingsTabBody } from '../src/bindings-mount.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import { PROMPT_GUIDANCE, PROMPT_NOT_SET, STARTING_PROMPT_LABEL } from '../src/bindings-prompt.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import { BINDINGS_PATH, CONFIG_PATH } from '../src/service-calls.ts';
import { fakeDom } from './support/dom.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { ACCOUNT_TIER_SENTINEL, BINDING_TIER_SENTINEL, GLOBAL_TIER_SENTINEL } from './support/prompt-tiers.ts';

/**
 * Every SDK mount the six tab bodies performed, and the props it carried.
 *
 * Hoisted so the `vi.mock` factory below can write to it while the module
 * graph is still being evaluated — the same reason `tests/app.test.ts`
 * hoists its counters.
 *
 * `updates` is the per-handle half: each `update` is recorded under the
 * primitive **and the mount** that issued its handle, because the add-mode
 * proof needs the props *this* field is standing at right now (its
 * `disabled` above all), and the shared `log` alone cannot say which of the
 * several text fields a repaint belonged to.
 */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
    updates: [] as { readonly key: string; readonly id: number; readonly props: unknown }[],
    paints: 0,
    disposes: 0,
    inert: 0,
}));

/** The SDK primitive the prompt field and the repository input both are. */
const TEXT_FIELD = 'mountTextField';

/**
 * Count one stubbed SDK handle's paint and dispose, so "mounted" stays
 * distinguishable from "constructed", and record each repaint under the
 * mount it belongs to.
 *
 * @param key - The SDK primitive that issued this handle.
 * @param id - Which mount of that primitive this handle is (0-based).
 * @returns The handle every `mount*` primitive answers with here.
 */
function sdkHandle(key: string, id: number): {
    readonly update: (patched?: unknown) => void;
    readonly dispose: () => void;
} {
    return {
        update: (patched?: unknown): void => {
            mounts.paints += 1;
            mounts.updates.push({ key, id, props: patched ?? null });
        },
        dispose: (): void => {
            mounts.disposes += 1;
        },
    };
}

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): ReturnType<typeof sdkHandle> => {
                // The mount's index among its own primitive's mounts, counted
                // out of the journal itself — so a test that clears the
                // journal gets ids that line up with it again, and a repaint
                // is always matched back to the handle it was issued to.
                const id = mounts.log.filter((entry) => entry.key === key).length;
                mounts.log.push({ key, props });

                return sdkHandle(key, id);
            };
        }
    }

    return stubbed;
});

/** The member a whole-file save carries the prompt under (004 FR-014). */
const PROMPT_KEY = 'startingPrompt';

/** The stored prompt a refusal is judged against. */
const PREVIOUS = 'Write the changelog before merging.';

/** Fixture numeric account id the bindings and the form share. */
const ACCOUNT_ID = '77331';

/** Fixture account login. */
const LOGIN = 'octocat-mt';

/** Fixture repository the edited binding watches. */
const REPOSITORY = 'acme/widget';

/** Project every fixture binding dispatches into. */
const PROJECT_ID = 'prj_42';

/** The note an accepted save leaves for {@link REPOSITORY}'s row. */
const SAVED_NOTE = 'Saved acme/widget.';

/** Fixture repository the untouched binding watches. */
const OTHER_REPOSITORY = 'acme/other';

/** Panel id of the binding whose prompt the editor opens on. */
const EDITED_ID = 'bnd-prompt';

/** Panel id of the second binding, which no test edits. */
const OTHER_ID = 'bnd-other';

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** Tabs FR-010 puts in the strip, so SC-105 really is cross-tab. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/**
 * The picker callbacks the shell's bodies take; none is exercised here.
 *
 * They count rather than no-op so an accidental invocation during a mount
 * would show up as a number instead of as silence.
 */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => {
        mounts.inert += 1;
    },
    selectProject: (): void => {
        mounts.inert += 1;
    },
    copyProjectId: (): void => {
        mounts.inert += 1;
    },
};

/** The service's field-level refusal, exactly as the prompt route answers it. */
const REFUSAL = JSON.stringify({
    error: {
        code: 'validation',
        message: 'startingPrompt: this value looks like a credential; store it in a secret manager instead',
    },
});

/** A credential-shaped draft the service refuses, for the field's slot (004 FR-024). */
const CREDENTIAL_VALUE = 'ghp_A_CREDENTIAL_SHAPED_VALUE';

/**
 * Over FR-020's 2,000-code-point cap *and* credential-shaped: two refusals
 * the panel must never pre-empt with a check of its own (004 plan D24).
 */
const OVER_CAP_CREDENTIAL = `ghp_${'x'.repeat(2_100)}`;

/**
 * Build one binding as `GET /v1/bindings` serializes it.
 *
 * @param input - The row's identity and its stored prompt, if any.
 * @returns One complete binding row.
 */
function bindingRow(input: {
    /** Panel-generated id. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** The stored prompt; `undefined` means the binding has none. */
    readonly startingPrompt?: string;
}): Record<string, unknown> {
    return {
        bindingId: input.bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: input.repository,
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        ...(input.startingPrompt === undefined ? {} : { startingPrompt: input.startingPrompt }),
    };
}

/**
 * Read fixture rows through the panel's own fail-closed reader (004 FR-012).
 *
 * @param rows - Binding rows exactly as the service serializes them.
 * @returns The bindings the reader accepted.
 * @throws {Error} When the fixture itself cannot be read.
 */
function stateFromWire(rows: readonly unknown[]): readonly PanelBinding[] {
    const parsed = parseBindingsBody(JSON.stringify({ bindings: rows, status: [] }));
    if (parsed === null) {
        throw new Error('the fixture bindings could not be read');
    }

    return parsed.bindings;
}

/**
 * Build a host whose PUT echoes its own body back, and record every leg.
 *
 * @returns The host and the service requests it saw.
 */
function echoService(): { readonly host: ReturnType<typeof fakeHost>; readonly requests: GuestRequest[] } {
    const requests: GuestRequest[] = [];

    return {
        requests,
        host: fakeHost({
            serviceRequest: async (request): Promise<GuestRequestResult> => {
                requests.push(request);
                if (request.method !== 'PUT') {
                    return { status: 404, body: UNROUTED };
                }

                const sent = JSON.parse(request.body ?? '{}') as { readonly bindings?: readonly unknown[] };

                return { status: 200, body: JSON.stringify({ bindings: sent.bindings ?? [], status: [] }) };
            },
        }),
    };
}

/**
 * Clear the mount journal so one case starts from an empty pane.
 *
 * Ids are counted out of the log itself (see the mock above), so they
 * re-align with it the moment it clears; `updates` goes with it because a
 * repaint left over from an earlier case would otherwise be laid over this
 * case's field — the one guess the journal exists to make impossible.
 */
function freshJournal(): void {
    mounts.log.length = 0;
    mounts.updates.length = 0;
}

/**
 * Mount the Bindings body over rows a case supplies, with nothing selected.
 *
 * The add form and the row editor both start from this shape, so a case
 * states the rows it is about and the posture it opens them in — and the
 * body is mounted (rather than only its state built) because the promises
 * under test are about what reaches the field, not about what sits in
 * state.
 *
 * @param input - The binding rows to load, and the service to mount against.
 * @returns The runtime, the pane's handler table, and the service double.
 */
function promptEditor(input: {
    /** Binding rows exactly as `GET /v1/bindings` serializes them. */
    readonly rows: readonly unknown[];
    /** The service double; an echoing one by default, so a save answers from its own body. */
    readonly service?: ReturnType<typeof echoService>;
}): {
    /** The runtime under test. */
    readonly rt: ReturnType<typeof createTestRuntime>;
    /** The pane's handler table. */
    readonly handlers: ReturnType<typeof createBindingsHandlers>;
    /** The service double the writes land on. */
    readonly service: ReturnType<typeof echoService>;
} {
    const service = input.service ?? echoService();
    const rt = createTestRuntime(service.host);
    rt.state.bindings.bindings = stateFromWire(input.rows);
    rt.state.bindings.status = 'ready';
    rt.state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true, scope: 'ok' },
    ];
    freshJournal();
    mountBindingsTabBody({ rt, root: fakeDom().root });

    return { rt, handlers: createBindingsHandlers(rt), service };
}

/**
 * Build a service that **refuses** one bindings save and accepts the next.
 *
 * The refusal is what puts the service's copy into the field's slot; the
 * acceptance is what retires it again. One double, because the flow under
 * test is the operator's own: fix the value, save again, and watch the slot
 * return to FR-063's guidance.
 *
 * @returns The service and the legs it recorded.
 */
function refuseThenAcceptService(): {
    /** Every request the panel made, in order. */
    readonly requests: GuestRequest[];
    /** The host double that recorded them. */
    readonly host: ReturnType<typeof fakeHost>;
} {
    const requests: GuestRequest[] = [];
    let saves = 0;

    return {
        requests,
        host: fakeHost({
            serviceRequest: async (request): Promise<GuestRequestResult> => {
                requests.push(request);
                if (request.method !== 'PUT') {
                    return { status: 404, body: UNROUTED };
                }

                saves += 1;
                if (saves === 1) {
                    return { status: 422, body: REFUSAL };
                }

                const sent = JSON.parse(request.body ?? '{}') as { readonly bindings?: readonly unknown[] };

                return { status: 200, body: JSON.stringify({ bindings: sent.bindings ?? [], status: [] }) };
            },
        }),
    };
}

/**
 * Read the PUT a test drove, failing loudly when none was sent.
 *
 * @param requests - The legs the service recorded.
 * @returns The raw body the panel put on the wire.
 * @throws {Error} When the panel never sent one.
 */
function putBody(requests: readonly GuestRequest[]): string {
    const put = requests.find((request) => request.method === 'PUT' && request.path === BINDINGS_PATH);
    if (put === undefined) {
        throw new Error('the panel never put the bindings list');
    }

    return put.body ?? '';
}

/* -------------------------------------------------------------------- *
 * T-032 / SC-105 / AC-123 — one rendering per tier value (004 FR-089;
 * 005 FR-051, SC-105, AC-123 as re-cut at 005 v1.9.0)
 * -------------------------------------------------------------------- */

/**
 * The global tier's answer to `GET /v1/config`, with its sentinel in it.
 *
 * Assembled from the service's own projection, so the Settings row this
 * counts is the row the service would really declare — same descriptors,
 * same order, same cap — with only the value swapped for the sentinel.
 *
 * @returns The response body.
 */
function globalTierBody(): string {
    return JSON.stringify({
        config: { ...DEFAULT_CONFIG, startingPrompt: GLOBAL_TIER_SENTINEL },
        fields: configSchema(),
        source: 'stored',
        defaultsApplied: [],
    });
}

/**
 * A host that answers the one read the Settings body performs on
 * activation, and nothing else.
 *
 * The bindings and accounts tiers are seeded the way a landed `GET` leaves
 * them (`status: 'ready'`, so neither body re-reads), and Status's own read
 * fails before it ever reaches the config — so each tier reaches the DOM
 * through the one site FR-089 names for it, which is what gets counted.
 *
 * @returns The host double.
 */
function tierHost(): ReturnType<typeof fakeHost> {
    return fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            if (request.method === 'GET' && request.path === CONFIG_PATH) {
                return { status: 200, body: globalTierBody() };
            }

            return { status: 404, body: UNROUTED };
        },
    });
}

/**
 * Read one mount's props as the object the count compares over.
 *
 * @param raw - Whatever the SDK primitive was handed.
 * @returns The props as a plain record (a bare string prop reads as `text`).
 */
function propsOf(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'string') {
        return { text: raw };
    }

    if (typeof raw === 'object' && raw !== null) {
        return { ...(raw as Record<string, unknown>) };
    }

    return {};
}

/**
 * Every rendered **element** whose current props carry `sentinel`, in mount
 * order.
 *
 * An element is one mount, and each repaint its own handle received is laid
 * over that mount's props in journal order (the harness records every
 * update under the mount it was issued to), so a field that mounts empty
 * and is painted with the text a beat later still counts as **one**
 * element — while a second element carrying the same text counts as two,
 * which is the duplication AC-123 fails on.
 *
 * @param sentinel - The text to look for.
 * @returns The elements carrying it, each named by its SDK primitive.
 */
function elementsCarrying(sentinel: string): readonly { readonly key: string }[] {
    const seen: Record<string, number> = {};
    const carrying: { readonly key: string }[] = [];

    for (const entry of mounts.log) {
        const id = seen[entry.key] ?? 0;
        seen[entry.key] = id + 1;
        const props = propsOf(entry.props);

        for (const update of mounts.updates) {
            if (update.key === entry.key && update.id === id) {
                Object.assign(props, update.props);
            }
        }

        if (JSON.stringify(props).includes(sentinel)) {
            carrying.push({ key: entry.key });
        }
    }

    return carrying;
}

describe('T-032 / SC-105 / AC-123 one rendering per tier value across all six tabs', () => {
    it('counts exactly one element carrying each tier sentinel', async () => {
        // Each tier is opened the way an operator opens it: the binding row
        // click loads that binding's text into the editor, the account row
        // click loads that account's into its field.
        freshJournal();
        const rt = createTestRuntime(tierHost());
        rt.state.bindings.bindings = stateFromWire([
            bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: BINDING_TIER_SENTINEL }),
            bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, startingPrompt: PREVIOUS }),
        ]);
        rt.state.bindings.status = 'ready';
        rt.state.bindings.accounts = [{
            numericUserId: ACCOUNT_ID,
            login: LOGIN,
            displayName: null,
            startingPrompt: ACCOUNT_TIER_SENTINEL,
            usable: true,
            scope: 'ok',
        }];
        const handlers = createBindingsHandlers(rt);
        handlers.selectBinding(EDITED_ID);
        selectAccountRow(rt, ACCOUNT_ID);

        {
            const dom = fakeDom();
            mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
            for (const id of TAB_IDS) {
                rt.shell?.activate(id);
            }
            // The Settings body's one read is what puts the global tier on
            // its row; one macrotask lands it (the Settings suite settles
            // its read the same way).
            await tick();

            // Not vacuous: the six bodies really mounted, and a text field is
            // among them rather than an empty journal agreeing with itself.
            expect(mounts.log.length).toBeGreaterThan(TAB_IDS.length);
            expect(mounts.log.some((entry) => entry.key === TEXT_FIELD)).toBe(true);

            for (const [tier, sentinel] of [
                ['global', GLOBAL_TIER_SENTINEL],
                ['account', ACCOUNT_TIER_SENTINEL],
                ['binding', BINDING_TIER_SENTINEL],
            ] as const) {
                const carrying = elementsCarrying(sentinel);
                // The criterion fails at 0 (the site vanished) and at 2 (a
                // second surface started carrying a tier's value) alike.
                expect(carrying, `${tier} tier rendered ${carrying.length} times`).toHaveLength(1);
                // …and it landed on the site FR-089 names for that tier.
                expect(carrying[0]?.key, `${tier} tier's one carrier`).toBe(TEXT_FIELD);
            }
        }

        {
            // Nothing carries this: a vanished field would read this way
            // rather than the count agreeing with itself.
            expect(elementsCarrying('SC105-NO-SUCH-SENTINEL-AT-ALL')).toHaveLength(0);
            // Several empty prompt fields do carry this word (FR-064's
            // placeholder on every tier's surface), so two elements carrying
            // one text read as 2+, never as 1.
            expect(elementsCarrying(PROMPT_NOT_SET).length).toBeGreaterThan(1);
        }

        {
            const bindingSummary = bindingRows(rt.state.bindings);
            expect(bindingSummary[0]?.subtitle).toContain(
                `prompt set · ${[...BINDING_TIER_SENTINEL].length} chars`,
            );
            expect(bindingSummary[0]?.subtitle).not.toContain(BINDING_TIER_SENTINEL);
            expect(bindingSummary[0]?.subtitle).not.toContain('mtp-');
            expect(bindingSummary[1]?.subtitle).not.toContain(PREVIOUS);

            const accountSummary = accountRows(rt.state.bindings);
            expect(accountSummary[0]?.subtitle).toContain(
                `prompt set · ${[...ACCOUNT_TIER_SENTINEL].length} chars`,
            );
            expect(accountSummary[0]?.subtitle).not.toContain(ACCOUNT_TIER_SENTINEL);
            expect(accountSummary[0]?.subtitle).not.toContain('mtp-');
        }

        stopRelayPolling(rt);
        rt.shell?.dispose();
    });
});

describe('004 FR-014 the save carries the prompt only where it was edited', () => {
    it('omits the key from every row when no prompt was edited', async () => {
        {
            const service = echoService();
            const rt = createTestRuntime(service.host);
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
                bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, startingPrompt: PREVIOUS }),
            ]);
            rt.state.bindings.status = 'ready';
            rt.state.bindings.selectedBinding = OTHER_ID;
            const handlers = createBindingsHandlers(rt);

            handlers.toggle();
            await tick();

            // Asserted on the raw body: "the key is absent" is a fact about bytes.
            expect(putBody(service.requests)).not.toContain(PROMPT_KEY);
        }
        {
            const service = echoService();
            const rt = createTestRuntime(service.host);
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
                bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, startingPrompt: PREVIOUS }),
            ]);
            rt.state.bindings.status = 'ready';
            const handlers = createBindingsHandlers(rt);
            handlers.selectBinding(EDITED_ID);
            handlers.setStartingPrompt('');

            // One form, one save: the editor's primary control writes the prompt
            // with the rest of the binding (2026-10-01 review).
            handlers.submit();
            await tick();

            const raw = putBody(service.requests);
            expect(raw).toContain('"startingPrompt":""');
            const body = JSON.parse(raw) as { readonly bindings?: readonly Record<string, unknown>[] };
            const rows = body.bindings ?? [];
            expect(rows).toHaveLength(2);
            expect(rows[0] === undefined ? false : Object.hasOwn(rows[0], 'startingPrompt')).toBe(true);
            expect(rows[1] === undefined ? true : Object.hasOwn(rows[1], 'startingPrompt')).toBe(false);
            expect(rt.state.bindings.startingPromptDirty).toBe(false);
            expect(rt.state.bindings.note).toBe(SAVED_NOTE);
            expect(rt.state.bindings.editorOpen).toBe(false);
        }
        {
            const service = echoService();
            const rt = createTestRuntime(service.host);
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
            ]);
            rt.state.bindings.status = 'ready';
            const handlers = createBindingsHandlers(rt);
            handlers.selectBinding(EDITED_ID);

            handlers.submit();
            await tick();

            // The row still saves — the operator asked for that — but the prompt
            // key is absent from the wire, so the service keeps what it holds
            // (004 FR-014's omission-preserves).
            expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
            expect(putBody(service.requests)).not.toContain(PROMPT_KEY);
            expect(rt.state.bindings.note).toBe(SAVED_NOTE);
        }
    });
});

describe('AC-124 a refused prompt stays in force and is never reported as saved', () => {
    it('renders the remediation at the field and keeps the stored prompt', async () => {
        {
            const requests: GuestRequest[] = [];
            const host = fakeHost({
                serviceRequest: async (request): Promise<GuestRequestResult> => {
                    requests.push(request);

                    return request.method === 'PUT'
                        ? { status: 422, body: REFUSAL }
                        : { status: 404, body: UNROUTED };
                },
            });
            const rt = createTestRuntime(host);
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
            ]);
            rt.state.bindings.status = 'ready';
            const handlers = createBindingsHandlers(rt);
            handlers.selectBinding(EDITED_ID);
            handlers.setStartingPrompt('ghp_A_CREDENTIAL_SHAPED_VALUE');
            const before = JSON.stringify(rt.state.bindings.bindings);

            handlers.submit();
            await tick();

            expect(requests.some((request) => request.method === 'PUT')).toBe(true);
            expect(JSON.stringify(rt.state.bindings.bindings)).toBe(before);
            expect(rt.state.bindings.bindings[0]?.startingPrompt).toBe(PREVIOUS);
            // The draft survives so the operator can fix it, rather than being
            // silently reverted to what the service already holds.
            expect(rt.state.bindings.startingPromptInput).toBe('ghp_A_CREDENTIAL_SHAPED_VALUE');
            expect(rt.state.bindings.startingPromptDirty).toBe(true);
            expect(rt.state.bindings.note).not.toContain('saved');
        }
        {
            const service = echoService();
            const rt = createTestRuntime(service.host);
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
            ]);
            rt.state.bindings.status = 'ready';
            rt.state.bindings.startingPromptError = 'startingPrompt: an older refusal';
            const handlers = createBindingsHandlers(rt);
            handlers.selectBinding(EDITED_ID);
            const edited = `${PREVIOUS} Then the release notes.`;
            handlers.setStartingPrompt(edited);

            handlers.submit();
            await tick();

            expect(rt.state.bindings.startingPromptError).toBeNull();
            expect(rt.state.bindings.startingPromptDirty).toBe(false);
            // The field shows what the service stored after its own normalisation,
            // not the draft the operator typed.
            expect(rt.state.bindings.startingPromptInput).toBe(edited);
            expect(rt.state.bindings.note).toBe(SAVED_NOTE);
        }
    });
});

/* -------------------------------------------------------------------- *
 * The field in both editor modes (005 FR-051, FR-052; 004 FR-014)
 * -------------------------------------------------------------------- */

/** Text the operator types into a brand-new binding's prompt field. */
const TYPED_PROMPT = 'Ship it, then open a PR with the changelog entry.';

/** Text the operator types over a loaded row's stored prompt. */
const EDIT_PROMPT = 'Reproduce the report before changing anything.';

/** Repository the add form saves in the add-mode case. */
const NEW_REPOSITORY = 'acme/brand-new';

/**
 * The starting-prompt field's props as they stand right now.
 *
 * The field is found by the label only it carries, then every repaint its own
 * handle received is laid over the mount props in order — so `disabled` here
 * is what an operator would meet, not what some earlier paint said.
 *
 * @returns The field's current props.
 * @throws {Error} When the field never mounted.
 */
function promptFieldProps(): Record<string, unknown> {
    const at = mounts.log.findIndex(
        (entry) => entry.key === TEXT_FIELD
            && (entry.props as { readonly label?: unknown }).label === STARTING_PROMPT_LABEL,
    );
    if (at === -1) {
        throw new Error('the starting-prompt field never mounted');
    }

    let id = 0;
    for (let index = 0; index < at; index += 1) {
        if (mounts.log[index]?.key === TEXT_FIELD) {
            id += 1;
        }
    }

    const props: Record<string, unknown> = { ...(mounts.log[at]?.props as Record<string, unknown>) };
    for (const update of mounts.updates) {
        if (update.key === TEXT_FIELD && update.id === id) {
            Object.assign(props, update.props);
        }
    }

    return props;
}

/**
 * Type into the prompt field the way an operator does.
 *
 * A disabled control fires no handler — that is the whole of the reported
 * bug, * the field rendering but refusing focus — so the input is refused here
 * before its `onChange` is reached, loudly instead of as a silent no-op that
 * would let a dead field read as a working one.
 *
 * @param text - What the operator types.
 * @throws {Error} When the field is disabled, or wired no handler at all.
 */
function typeIntoPromptField(text: string): void {
    const props = promptFieldProps();
    if (props.disabled === true) {
        throw new Error('the starting-prompt field is disabled, so it can neither be focused nor typed into');
    }

    if (typeof props.onChange !== 'function') {
        throw new Error('the starting-prompt field wired no onChange');
    }

    (props.onChange as (value: string) => void)(text);
}

/**
 * One runtime with the fixture binding loaded **and** the Bindings body
 * mounted, which is what makes `refresh` repaint and the field's `disabled`
 * a fact on screen rather than an intention in state.
 *
 * @returns The runtime, its handler table, and the service it will write to.
 */
function mountedBindings(): {
    /** The runtime under test. */
    readonly rt: ReturnType<typeof createTestRuntime>;
    /** The pane's handler table. */
    readonly handlers: ReturnType<typeof createBindingsHandlers>;
    /** The recording service the write lands on. */
    readonly service: ReturnType<typeof echoService>;
} {
    const service = echoService();
    const rt = createTestRuntime(service.host);
    rt.state.bindings.bindings = stateFromWire([
        bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
    ]);
    rt.state.bindings.status = 'ready';
    rt.state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true, scope: 'ok' },
    ];
    freshJournal();
    mountBindingsTabBody({ rt, root: fakeDom().root });

    return { rt, handlers: createBindingsHandlers(rt), service };
}

/**
 * Release one case's mounted body and stop the relay a granted list armed.
 *
 * @param mounted - What {@link mountedBindings} answered with.
 */
function releaseBindings(mounted: ReturnType<typeof mountedBindings>): void {
    stopRelayPolling(mounted.rt);
    mounted.rt.bindingsUi?.dispose();
    mounted.rt.bindingsUi = null;
}

describe('the prompt field takes input in both editor modes (005 FR-051, 004 FR-014)', () => {
    it('takes the text on New binding, and the add save carries it', async () => {
        const { rt, handlers, service } = mountedBindings();

        handlers.newBinding();
        expect(rt.state.bindings.editorOpen).toBe(true);
        // No row is selected in add mode by design, which is exactly where the
        // field used to render and stay dead: present, but never focusable.
        typeIntoPromptField(TYPED_PROMPT);
        expect(rt.state.bindings.startingPromptInput).toBe(TYPED_PROMPT);
        expect(rt.state.bindings.startingPromptDirty).toBe(true);

        handlers.setRepoInput(NEW_REPOSITORY);
        handlers.selectAccount(ACCOUNT_ID);
        // The picker is not what this case is about; the draft only owes
        // `readDraft` a project to dispatch into.
        rt.state.bindings.repoProjectSelection = PROJECT_ID;
        handlers.submit();
        await tick();

        const body = JSON.parse(putBody(service.requests)) as {
            readonly bindings?: readonly Record<string, unknown>[];
        };
        const added = (body.bindings ?? []).find((row) => row.repository === NEW_REPOSITORY);
        expect(added?.startingPrompt).toBe(TYPED_PROMPT);
        releaseBindings({ rt, handlers, service });
    });

    it('never reaches the add save when the field was left untouched (004 FR-014)', async () => {
        const { rt, handlers, service } = mountedBindings();

        handlers.newBinding();
        handlers.setRepoInput(NEW_REPOSITORY);
        handlers.selectAccount(ACCOUNT_ID);
        rt.state.bindings.repoProjectSelection = PROJECT_ID;
        handlers.submit();
        await tick();

        expect(putBody(service.requests)).not.toContain(PROMPT_KEY);
        expect(rt.state.bindings.startingPromptDirty).toBe(false);
        releaseBindings({ rt, handlers, service });
    });

    it('takes the text on a loaded row, and the edit save carries it unchanged', async () => {
        const { rt, handlers, service } = mountedBindings();

        handlers.selectBinding(EDITED_ID);
        typeIntoPromptField(EDIT_PROMPT);
        expect(rt.state.bindings.startingPromptInput).toBe(EDIT_PROMPT);

        handlers.submit();
        await tick();

        expect(putBody(service.requests)).toContain(`"${PROMPT_KEY}":"${EDIT_PROMPT}"`);
        expect(rt.state.bindings.startingPromptDirty).toBe(false);
        expect(rt.state.bindings.startingPromptError).toBeNull();
        releaseBindings({ rt, handlers, service });
    });
});

describe('T-039 the binding tier carries FR-063 guidance and FR-064 honesty (AC-144)', () => {
    it('conveys the five facts beside a field that validates nothing', async () => {
        {
            const { rt, handlers, service } = promptEditor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS })],
            });
            handlers.selectBinding(EDITED_ID);
            const props = promptFieldProps();

            expect(props.helper).toBe(PROMPT_GUIDANCE);
            // FR-063's five, word by word: verbatim, no placeholders, the
            // pinned Default Agent the text cannot change, the refusal
            // shape, and the cap — a helper carrying four of them fails here.
            for (const fact of ['verbatim', 'placeholders', 'Default Agent', 'refused', '2,000']) {
                expect(String(props.helper), fact).toContain(fact);
            }
            releaseBindings({ rt, handlers, service });
        }

        {
            const { rt, handlers, service } = promptEditor({
                rows: [bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY })],
            });
            handlers.newBinding();
            const props = promptFieldProps();

            // No row is selected by design in add mode — the state an idle
            // "select a binding" line used to live in — and the five facts
            // and the honest absence are here all the same.
            expect(rt.state.bindings.selectedBinding).toBeNull();
            expect(props.helper).toBe(PROMPT_GUIDANCE);
            expect(props.value).toBe('');
            expect(props.placeholder).toBe(PROMPT_NOT_SET);
            releaseBindings({ rt, handlers, service });
        }

        {
            const unset = promptEditor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY })],
            });
            unset.handlers.selectBinding(EDITED_ID);
            const empty = promptFieldProps();

            // Honest absence: the slot an empty instruction box would occupy
            // states the state — the same word Settings and Accounts use.
            expect(empty.value).toBe('');
            expect(empty.placeholder).toBe(PROMPT_NOT_SET);
            expect(empty.helper).toBe(PROMPT_GUIDANCE);
            releaseBindings(unset);

            const set = promptEditor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS })],
            });
            set.handlers.selectBinding(EDITED_ID);
            const filled = promptFieldProps();

            expect(filled.value).toBe(PREVIOUS);
            // The word stays the field's placeholder; a value is what hides
            // it, exactly as on the two sibling surfaces.
            expect(filled.placeholder).toBe(PROMPT_NOT_SET);
            releaseBindings(set);
        }

        {
            const { rt, handlers, service } = promptEditor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS })],
            });
            handlers.selectBinding(EDITED_ID);
            // Both things the service refuses — over FR-020's cap *and*
            // credential-shaped — pass through byte for byte: the panel
            // holds no cap, no shape rule, and no length check of its own.
            typeIntoPromptField(OVER_CAP_CREDENTIAL);

            expect(rt.state.bindings.startingPromptInput).toBe(OVER_CAP_CREDENTIAL);
            expect(rt.state.bindings.startingPromptDirty).toBe(true);
            expect(rt.state.bindings.startingPromptError).toBeNull();
            // Typing alone never talks to the service either: the one
            // validator is reached by the save this case does not make.
            expect(service.requests).toHaveLength(0);
            releaseBindings({ rt, handlers, service });
        }

        {
            const service = refuseThenAcceptService();
            const { rt, handlers } = promptEditor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS })],
                service,
            });
            handlers.selectBinding(EDITED_ID);
            typeIntoPromptField(CREDENTIAL_VALUE);

            handlers.submit();
            await tick();

            const { message } = (JSON.parse(REFUSAL) as { readonly error: { readonly message: string } }).error;
            const refused = promptFieldProps();
            // The service's own copy takes the slot FR-063's guidance was
            // resting in — the same slot, the service's words, and never the
            // value it refused (FR-052, FR-085).
            expect(refused.helper).toBe(message);
            expect(String(refused.helper)).not.toContain(CREDENTIAL_VALUE);
            expect(String(refused.helper)).not.toContain(PROMPT_GUIDANCE);
            expect(rt.state.bindings.bindings[0]?.startingPrompt).toBe(PREVIOUS);

            // The operator fixes the value and saves again: the service
            // accepts, the refusal clears, and what the field rests on is
            // the guidance once more.
            handlers.setStartingPrompt(`${PREVIOUS} Then the release notes.`);
            handlers.submit();
            await tick();

            expect(rt.state.bindings.startingPromptError).toBeNull();
            expect(promptFieldProps().helper).toBe(PROMPT_GUIDANCE);
            releaseBindings({ rt, handlers, service });
        }

        {
            const { rt, handlers, service } = promptEditor({
                rows: [
                    bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: PREVIOUS }),
                    bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY }),
                ],
            });
            const [set, unset] = bindingRows(rt.state.bindings);

            expect(set?.subtitle).toContain(`prompt set · ${[...PREVIOUS].length} chars`);
            expect(set?.subtitle).not.toContain(PREVIOUS);
            expect(set?.subtitle).not.toContain('mtp-');
            expect(unset?.subtitle).toContain('prompt not set');
            releaseBindings({ rt, handlers, service });
        }
    });
});
