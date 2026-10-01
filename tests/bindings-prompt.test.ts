/**
 * The starting prompt renders **exactly once** in the whole panel (005 T-021:
 * FR-051, FR-052, SC-105, AC-123, AC-124; 004 FR-014).
 *
 * Three promises are asserted here:
 *
 * 1. **SC-105 / AC-123** — mounting all six tab bodies and counting every SDK
 *    mount whose props carry the prompt text answers **one**, which is the
 *    count that fails at zero (the field vanished) and at two (a second
 *    surface started carrying an operator instruction). The count is taken
 *    from the mounts themselves rather than from a source scan, because a
 *    string can sit in the source and never reach the DOM — or the reverse.
 * 2. **The wire shape** (004 FR-014) — an untouched prompt is **absent** from
 *    the whole-file PUT, and a cleared one travels as an explicit empty value
 *    on exactly one row. Both are asserted on the raw request body, because
 *    "the key is missing" is a fact about bytes, not about an object.
 * 3. **AC-124** — a refusal lands at the field with the service's own
 *    remediation, the previously stored prompt stays in force, and nothing is
 *    reported as saved.
 *
 * Offline: a fake host, recorded service legs, and the DOM double. No live
 * OpenChamber, no PAT, no network (FR-086).
 */

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import { BINDINGS_PATH } from '../src/service-calls.ts';
import { fakeDom } from './support/dom.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/**
 * Every SDK mount the six tab bodies performed, and the props it carried.
 *
 * Hoisted so the `vi.mock` factory below can write to it while the module
 * graph is still being evaluated — the same reason `tests/app.test.ts`
 * hoists its counters.
 */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
    paints: 0,
    disposes: 0,
    inert: 0,
}));

/**
 * Count one stubbed SDK handle's paint and dispose, so "mounted" stays
 * distinguishable from "constructed".
 *
 * @returns The handle every `mount*` primitive answers with here.
 */
function sdkHandle(): { readonly update: () => void; readonly dispose: () => void } {
    return {
        update: (): void => {
            mounts.paints += 1;
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
                mounts.log.push({ key, props });

                return sdkHandle();
            };
        }
    }

    return stubbed;
});

/** The prompt text every count below looks for. */
const SENTINEL = 'SC105-SENTINEL-STARTING-PROMPT-TEXT';

/** The stored prompt a refusal is judged against. */
const PREVIOUS = 'Write the changelog before merging.';

/** Fixture numeric account id the bindings and the form share. */
const ACCOUNT_ID = '77331';

/** Fixture account login. */
const LOGIN = 'octocat-mt';

/** Fixture repository the edited binding watches. */
const REPOSITORY = 'acme/widget';

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
        projectId: 'prj_42',
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
 * Build a runtime whose stored bindings carry the sentinel prompt.
 *
 * @returns The runtime and the pane's handler table.
 */
function editorRuntime(): {
    /** The runtime under test. */
    readonly rt: ReturnType<typeof createTestRuntime>;
    /** The pane's handler table. */
    readonly handlers: ReturnType<typeof createBindingsHandlers>;
} {
    const rt = createTestRuntime(echoService().host);
    rt.state.bindings.bindings = stateFromWire([
        bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, startingPrompt: SENTINEL }),
        bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, startingPrompt: PREVIOUS }),
    ]);
    rt.state.bindings.status = 'ready';

    return { rt, handlers: createBindingsHandlers(rt) };
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

describe('SC-105 / AC-123 the prompt is rendered exactly once across all six tabs', () => {
    it('counts one SDK mount carrying the prompt text', () => {
        mounts.log.length = 0;
        const { rt, handlers } = editorRuntime();
        // The field opens on what the service holds for the selected row —
        // the same path the pane's own select handler takes (004 FR-012).
        handlers.selectBinding(EDITED_ID);
        expect(rt.state.bindings.startingPromptInput).toBe(SENTINEL);

        const dom = fakeDom();
        mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
        for (const id of TAB_IDS) {
            rt.shell?.activate(id);
        }

        const rendered = mounts.log.filter((entry) => JSON.stringify(entry.props ?? null).includes(SENTINEL));

        // The count that fails at 0 (the field vanished) and at 2 (a second
        // surface started carrying an operator instruction) alike.
        expect(rendered).toHaveLength(1);
        expect(rendered[0]?.key).toBe('mountTextField');
        // Not vacuous: the six bodies really mounted, and a text field is
        // among them rather than an empty log agreeing with itself.
        expect(mounts.log.length).toBeGreaterThan(TAB_IDS.length);
        expect(mounts.log.some((entry) => entry.key === 'mountTextField')).toBe(true);

        rt.shell?.dispose();
    });

    it('shows presence and length on the row, never the text and never a fingerprint', () => {
        const { rt } = editorRuntime();
        const row = bindingRows(rt.state.bindings)[0];

        expect(row?.subtitle).toContain(`prompt set · ${SENTINEL.length} chars`);
        expect(row?.subtitle).not.toContain(SENTINEL);
        expect(row?.subtitle).not.toContain('mtp-');
    });

    it('says the prompt is not set rather than showing an empty instruction', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindings.bindings = stateFromWire([
            bindingRow({ bindingId: 'bnd-none', repository: REPOSITORY }),
        ]);
        const row = bindingRows(rt.state.bindings)[0];

        expect(row?.subtitle).toContain('prompt not set');
    });
});

describe('004 FR-014 the save carries the prompt only where it was edited', () => {
    it('omits the key from every row when no prompt was edited', async () => {
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
        expect(putBody(service.requests)).not.toContain('startingPrompt');
    });

    it('sends an explicit empty value on exactly the row whose prompt was cleared', async () => {
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
    });

    it('omits the key from the save when the field was never touched', async () => {
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
        expect(putBody(service.requests)).not.toContain('startingPrompt');
        expect(rt.state.bindings.note).toBe(SAVED_NOTE);
    });
});

describe('AC-124 a refused prompt stays in force and is never reported as saved', () => {
    it('renders the remediation at the field and keeps the stored prompt', async () => {
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
        expect(rt.state.bindings.startingPromptError).toContain('store it in a secret manager instead');
        expect(JSON.stringify(rt.state.bindings.bindings)).toBe(before);
        expect(rt.state.bindings.bindings[0]?.startingPrompt).toBe(PREVIOUS);
        // The draft survives so the operator can fix it, rather than being
        // silently reverted to what the service already holds.
        expect(rt.state.bindings.startingPromptInput).toBe('ghp_A_CREDENTIAL_SHAPED_VALUE');
        expect(rt.state.bindings.startingPromptDirty).toBe(true);
        expect(rt.state.bindings.note).toContain('no binding changed');
        expect(rt.state.bindings.note).not.toContain('saved');
    });

    it('clears the field-level refusal once the service accepts', async () => {
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
    });
});
