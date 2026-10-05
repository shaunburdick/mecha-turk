/**
 * The Bindings tab's Edit affordance (005 FR-050, FR-051, FR-053).
 *
 * The product owner's review found Create/Read/Delete only: a binding row
 * selected nothing that could change it, so the editor's derived field views
 * had no reachable way to load a row. This suite proves the path that was
 * added — load every field (including the starting prompt) from the selected
 * row, then save through the **same** whole-file `PUT /v1/bindings` grant,
 * with no `PATCH` and no new endpoint (FR-050, asserted by
 * `tests/bindings-removal.test.ts`'s source scan).
 *
 * The round trip and the refusal run against the **real service** on loopback
 * with a temp-dir store and a fake GitHub verifier, because that is the only
 * way "the displayed value is the saved value" means anything: the panel's
 * draft goes through the service's own validator and lands in the service's
 * own file, and the assertion reads it back out of the service rather than
 * out of the panel's memory. Nothing here reaches the network.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { saveEditedBinding, startEditingBinding } from '../src/bindings-edit.ts';
import { readDraft } from '../src/bindings.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { BINDINGS_PATH } from '../src/service-calls.ts';
import type { PanelBinding, PanelTriggers } from '../src/bindings-service.ts';
import type { PanelHost } from '../src/session.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `bindings-edit-credential-${'p'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Repository the stored binding watches. */
const REPOSITORY = 'acme/widget';

/** Repository the round-trip edit retargets the binding at. */
const NEXT_REPOSITORY = 'acme/widget-next';

/** Binding id the editor loads in every round trip. */
const BINDING_ID = 'bnd-edit';

/** RFC 3339 stamp the stored row carries; an edit must keep it. */
const STAMP = '2026-09-27T00:00:00.000Z';

/** Project the stored binding dispatches into. */
const PROJECT_ID = 'prj_42';

/** Stored starting prompt, so the prompt leg of the load can be asserted. */
const STORED_PROMPT = 'Review the diff before you touch anything.';

/** A prompt the service refuses for carrying a credential shape (004 FR-024). */
const REFUSED_PROMPT = 'ghp_AbCdEf0123456789AbCdEf0123456789AbCd';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
});

/** Build a header map without writing HTTP header names as object keys. */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/**
 * Bridge one panel runtime onto the loopback service.
 *
 * `host.serviceRequest` is the panel's only path to the service, so
 * forwarding it — method, path, and body verbatim, answer verbatim — is a
 * complete bridge: the panel code under test cannot tell it from the host's
 * own implementation.
 *
 * @returns The host double the runtime runs against.
 */
function panelHost(service: TestService): PanelHost {
    return fakeHost({
        serviceRequest: async (request) => {
            const init: RequestInit = { method: request.method };
            if (request.body !== undefined) {
                init.headers = jsonHeaders();
                init.body = request.body;
            }

            const response = await service.call(request.path, init);

            return { status: response.status, body: await response.text() };
        },
    });
}

/**
 * Start the service against a fake GitHub and register the fixture account.
 *
 * The bindings route refuses an unregistered account fail-closed (002
 * FR-015's custody rule), so every grant here runs over a real one.
 *
 * @returns The running harness instance.
 */
async function startWithAccount(): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: headerMap([['x-oauth-sopes', 'repo, user']]),
        },
    });
    const service = await startTestService({ github: github.verifier });
    running.push(service);
    await service.handle.reconciled;

    const registered = await service.call(VERIFY_PATH, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ token: REGISTERED_TOKEN }),
    });
    expect(registered.status).toBe(201);

    return service;
}

/** The row as the service stores it before any edit. */
function panelRow(): PanelBinding {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: true },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
        startingPrompt: STORED_PROMPT,
    };
}

/**
 * Write the fixture row through the real `PUT /v1/bindings`.
 *
 * @param row - The binding to store.
 */
async function seedRow(service: TestService, row: PanelBinding): Promise<void> {
    const response = await service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ bindings: [row] }),
    });
    expect(response.status).toBe(200);
}

/**
 * Read the bindings back **out of the service** (never out of panel state).
 *
 * @returns The stored rows, as the panel's own parser reads them.
 */
async function storedBindings(service: TestService): Promise<readonly PanelBinding[]> {
    const response = await service.call(BINDINGS_PATH);
    expect(response.status).toBe(200);
    const parsed = parseBindingsBody(await response.text());
    expect(parsed).not.toBeNull();

    return parsed?.bindings ?? [];
}

/** One runtime bound to the service, with the fixture row loaded into it. */
async function editorRuntime(service: TestService): Promise<ReturnType<typeof createTestRuntime>> {
    const rt = createTestRuntime(panelHost(service));
    rt.state.bindings.status = 'ready';
    rt.state.bindings.bindings = await storedBindings(service);
    rt.state.bindings.accounts = [
        {
            numericUserId: ACCOUNT_ID,
            login: ACCOUNT_LOGIN,
            displayName: null,
            usable: true,
            scope: 'ok',
        },
    ];
    rt.state.bindings.selectedBinding = BINDING_ID;

    return rt;
}

describe('loading the selected binding into the editor (FR-053)', () => {
    it('repopulates every field, and readDraft answers with the stored row', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, panelRow());
            const rt = await editorRuntime(service);

            startEditingBinding(rt);

            const { bindings } = rt.state;
            expect(bindings.editing).toBe(true);
            expect(bindings.repoInput).toBe(REPOSITORY);
            expect(bindings.accountSelection).toBe(ACCOUNT_ID);
            expect(bindings.repoProjectSelection).toBe(PROJECT_ID);
            expect(bindings.triggerAssignment).toBe(true);
            expect(bindings.triggerMention).toBe(false);
            expect(bindings.triggerReviewRequest).toBe(true);
            expect(bindings.worktreeSelection).toBe('none');
            expect(bindings.startingPromptInput).toBe(STORED_PROMPT);
            expect(bindings.startingPromptDirty).toBe(false);

            // What the form now displays is what a save would write: the draft
            // reads back as the stored row under its own id, state, and stamp.
            const draft = readDraft(bindings, { bindingId: BINDING_ID });
            expect(draft).not.toBeNull();
            expect(draft).toMatchObject({
                bindingId: BINDING_ID,
                accountNumericUserId: ACCOUNT_ID,
                accountLogin: ACCOUNT_LOGIN,
                repository: REPOSITORY,
                projectId: PROJECT_ID,
                worktreeOption: 'none',
                state: 'active',
                createdAt: STAMP,
            });
            expect(draft?.triggers).toEqual({ assignment: true, mention: false, reviewRequest: true });
        }
    });

    it('demands a selection instead of inventing a row to edit', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, panelRow());
            const rt = await editorRuntime(service);
            rt.state.bindings.selectedBinding = null;

            startEditingBinding(rt);

            expect(rt.state.bindings.editing).toBe(false);
        }
    });

    it('refuses a row whose worktree option the editor cannot render', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, { ...panelRow(), worktreeOption: 'new:feature' });
            const rt = await editorRuntime(service);

            startEditingBinding(rt);

            // Loading it would display `none` and silently rewrite `new:feature`
            // on save, so the edit does not open at all — and says why.
            expect(rt.state.bindings.editing).toBe(false);
            expect(rt.state.bindings.note).toContain('new:feature');
            expect(rt.state.bindings.repoInput).toBe('');
        }
    });

});

describe('saving an edited binding through the whole-file grant (FR-050)', () => {
    it('round-trips the edited fields through the real service', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, panelRow());
            const rt = await editorRuntime(service);
            const handlers = createBindingsHandlers(rt);

            handlers.selectBinding(BINDING_ID);
            handlers.setMention(true);
            handlers.setWorktree('generated');
            handlers.setRepoInput(NEXT_REPOSITORY);
            // The prompt the operator did not touch must not travel: the service
            // keeps the stored one (004 FR-014's omission-preserves rule).
            await saveEditedBinding(rt);
            stopRelayPolling(rt);

            const [saved] = await storedBindings(service);
            expect(saved).toBeDefined();
            expect(saved).toMatchObject({
                bindingId: BINDING_ID,
                repository: NEXT_REPOSITORY,
                projectId: PROJECT_ID,
                worktreeOption: 'generated',
                state: 'active',
                createdAt: STAMP,
                accountNumericUserId: ACCOUNT_ID,
                accountLogin: ACCOUNT_LOGIN,
            });
            const triggers: PanelTriggers | undefined = saved?.triggers;
            expect(triggers).toEqual({ assignment: true, mention: true, reviewRequest: true });
            // The untouched prompt survived the write that carried no prompt.
            expect(saved?.startingPrompt).toBe(STORED_PROMPT);

            // The panel's own list follows the service's answer, and edit mode
            // closes on a save the service accepted.
            expect(rt.state.bindings.bindings[0]?.repository).toBe(NEXT_REPOSITORY);
            expect(rt.state.bindings.editing).toBe(false);
            expect(rt.state.bindings.note).toBe(`Saved ${NEXT_REPOSITORY}.`);
        }
    });

    it('keeps the row byte-identical and renders the remediation when the service refuses', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, panelRow());
            const rt = await editorRuntime(service);
            const handlers = createBindingsHandlers(rt);

            handlers.selectBinding(BINDING_ID);
            handlers.setStartingPrompt(REFUSED_PROMPT);
            handlers.setMention(true);
            await saveEditedBinding(rt);
            stopRelayPolling(rt);

            // Nothing was written: the service still holds the row it held.
            const [stored] = await storedBindings(service);
            expect(stored).toMatchObject({
                bindingId: BINDING_ID,
                repository: REPOSITORY,
                worktreeOption: 'none',
                startingPrompt: STORED_PROMPT,
            });
            const triggers: PanelTriggers | undefined = stored?.triggers;
            expect(triggers).toEqual({ assignment: true, mention: false, reviewRequest: true });

            // The refusal lands on the field it belongs to (FR-052) rather than
            // behind a generic failure, the draft stays for the operator to fix,
            // and nothing is reported as saved.
            expect(rt.state.bindings.startingPromptError).toContain('startingPrompt');
            expect(rt.state.bindings.startingPromptInput).toBe(REFUSED_PROMPT);
            expect(rt.state.bindings.editing).toBe(true);
            expect(rt.state.bindings.note).not.toContain('Saved');
            expect(rt.state.bindings.note).not.toContain(REFUSED_PROMPT);
        }
    });

    it('leaves the list untouched when the draft no longer reads (repository shape)', async () => {
        {
            const service = await startWithAccount();
            await seedRow(service, panelRow());
            const rt = await editorRuntime(service);
            const handlers = createBindingsHandlers(rt);

            handlers.selectBinding(BINDING_ID);
            handlers.setRepoInput('not-a-repository');
            await saveEditedBinding(rt);
            stopRelayPolling(rt);

            const [stored] = await storedBindings(service);
            expect(stored?.repository).toBe(REPOSITORY);
            expect(rt.state.bindings.note).toBe('repository must be `owner/name`');
            expect(rt.state.bindings.editing).toBe(true);
        }
    });

});

/** A recording service double for the handler-wiring assertions. */
function recordingHost(): { readonly host: PanelHost; readonly puts: string[] } {
    const puts: string[] = [];

    return {
        puts,
        host: fakeHost({
            serviceRequest: async (request) => {
                if (request.method === 'PUT') {
                    puts.push(request.body ?? '');
                    const sent = JSON.parse(request.body ?? '{}') as {
                        readonly bindings?: readonly PanelBinding[];
                    };

                    return { status: 200, body: JSON.stringify({ bindings: sent.bindings ?? [], status: [] }) };
                }

                return { status: 404, body: '{"error":{"code":"not-found"}}' };
            },
        }),
    };
}

/** A second ready row, so "another row" is a real selection. */
function otherRow(): PanelBinding {
    return { ...panelRow(), bindingId: 'bnd-other', repository: 'acme/other', startingPrompt: undefined };
}

describe('the row click is the Edit affordance (FR-050, FR-081)', () => {
    it('loads on a row click, and another row click swaps the edit to that row', async () => {
        {
            const { host } = recordingHost();
            const rt = createTestRuntime(host);
            rt.state.bindings.status = 'ready';
            rt.state.bindings.bindings = [panelRow(), otherRow()];
            rt.state.bindings.selectedBinding = BINDING_ID;
            const handlers = createBindingsHandlers(rt);

            handlers.selectBinding(BINDING_ID);
            expect(rt.state.bindings.editing).toBe(true);
            expect(rt.state.bindings.editorOpen).toBe(true);
            expect(rt.state.bindings.repoInput).toBe(REPOSITORY);

            // A stray click on the row being edited keeps the edit open.
            handlers.selectBinding(BINDING_ID);
            expect(rt.state.bindings.editing).toBe(true);
            expect(rt.state.bindings.repoInput).toBe(REPOSITORY);

            // Clicking another row loads **that** row: one row's draft must never
            // stay pointed at a different row, or a save would write these values
            // into the row the selection now names.
            handlers.selectBinding('bnd-other');
            expect(rt.state.bindings.editing).toBe(true);
            expect(rt.state.bindings.repoInput).toBe('acme/other');
            expect(rt.state.bindings.startingPromptInput).toBe('');

            handlers.cancelEdit();
            expect(rt.state.bindings.editing).toBe(false);
            expect(rt.state.bindings.editorOpen).toBe(false);
            expect(rt.state.bindings.repoInput).toBe('');
        }
    });

    it('routes the primary control to the save once the row is loaded', async () => {
        {
            const { host, puts } = recordingHost();
            const rt = createTestRuntime(host);
            rt.state.bindings.status = 'ready';
            rt.state.bindings.bindings = [panelRow()];
            rt.state.bindings.selectedBinding = BINDING_ID;
            const handlers = createBindingsHandlers(rt);

            handlers.selectBinding(BINDING_ID);
            handlers.setMention(true);
            handlers.submit();
            await tick();

            expect(puts).toHaveLength(1);
            const sent = JSON.parse(puts[0] ?? '{}') as { readonly bindings: readonly PanelBinding[] };
            expect(sent.bindings[0]?.bindingId).toBe(BINDING_ID);
            expect(sent.bindings[0]?.triggers.mention).toBe(true);
            expect(rt.state.bindings.editing).toBe(false);
            // A save the service accepted closes the editor: the list is the
            // surface the result belongs to (2026-10-01 review).
            expect(rt.state.bindings.editorOpen).toBe(false);
            stopRelayPolling(rt);
        }
    });

});

describe('New binding opens the editor on an empty draft (2026-10-01 review)', () => {
    it('selects nothing, empties every field, and opens the editor', async () => {
        {
            const rt = createTestRuntime(recordingHost().host);
            rt.state.bindings.status = 'ready';
            rt.state.bindings.bindings = [panelRow()];
            rt.state.bindings.selectedBinding = BINDING_ID;
            rt.state.bindings.repoInput = panelRow().repository;
            rt.state.bindings.note = 'an older refusal';
            const handlers = createBindingsHandlers(rt);

            handlers.newBinding();

            const { bindings } = rt.state;
            expect(bindings.editorOpen).toBe(true);
            expect(bindings.editing).toBe(false);
            expect(bindings.selectedBinding).toBeNull();
            expect(bindings.repoInput).toBe('');
            expect(bindings.note).toBe('');
            expect(bindings.startingPromptInput).toBe('');
            expect(bindings.startingPromptDirty).toBe(false);
        }
    });

    it('closes again on cancel, with nothing written', async () => {
        {
            const rt = createTestRuntime(recordingHost().host);
            rt.state.bindings.status = 'ready';
            const handlers = createBindingsHandlers(rt);

            handlers.newBinding();
            handlers.setRepoInput('acme/brand-new');
            handlers.cancelEdit();

            expect(rt.state.bindings.editorOpen).toBe(false);
            expect(rt.state.bindings.repoInput).toBe('');
            expect(rt.state.bindings.note).toBe('');
        }
    });

});
