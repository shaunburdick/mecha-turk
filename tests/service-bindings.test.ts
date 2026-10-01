/**
 * `GET /v1/bindings` status rows (MVP fix 2 — scan status on binding rows).
 *
 * The operator's complaint was "binding on, pending 0, nothing happens" while
 * the service logged `auth-failed` every cycle: the scan state existed only
 * in the service log. The answer now carries one status row per binding, and
 * this suite checks it from *both* directions — the real service answering
 * over loopback, and the real panel parser (`parseBindingsBody`) reading that
 * answer — so a shape drift on either side fails here instead of on the
 * operator's screen.
 *
 * The planted scan-state file is the operator's own bytes (a never-scanned
 * slot with `auth-failed`), so the same request also proves FIX 1 end to end:
 * the file parses in place and leaves no quarantine file behind.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { promptFingerprint } from '../service/prompt.ts';
import { SCAN_STATE_FILE } from '../service/poll/scan.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `bindings-status-credential-${'p'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** RFC 3339 stamps the fixture binding carries. */
const STAMP = '2026-09-27T00:00:00.000Z';

/** Skip reason the planted scan state records for the binding. */
const SKIP_REASON = 'auth-failed';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Binding id every case in this suite grants. */
const BINDING_ID = 'bnd-status';

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @param pairs - Header name/value pairs.
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

afterEach(async () => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
});

/**
 * Start the service against a fake GitHub and register the fixture account.
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

/**
 * Build the one binding this suite grants, under the registered account.
 *
 * @returns The stored binding row.
 */
function bindingFixture(): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Grant the fixture binding through the panel's own whole-file PUT.
 *
 * @param service - Harness instance.
 * @param bindings - The list to store.
 * @returns The parsed answer, so a caller can assert on it too.
 */
async function grantBindings(
    service: TestService,
    bindings: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>> {
    const response = await service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ bindings }),
    });
    expect(response.status).toBe(200);

    return (await response.json()) as Record<string, unknown>;
}

/**
 * Plant the operator's scan-state bytes in the store directory.
 *
 * @param service - Harness instance owning the data directory.
 * @param slot - The per-binding slot to record.
 */
async function plantScanState(
    service: TestService,
    slot: { readonly lastScanAt: string | null; readonly lastError: string | null },
): Promise<void> {
    await writeFile(
        join(service.dataDir, SCAN_STATE_FILE),
        JSON.stringify({ bindings: { [BINDING_ID]: slot } }),
        'utf8',
    );
}

describe('GET /v1/bindings (bindings + per-binding scan status)', () => {
    it('answers rows the panel parser reads, with the never-scanned slot intact', async () => {
        const service = await startWithAccount();
        await grantBindings(service, [bindingFixture()]);
        // The operator's exact on-disk state: bound, never scanned, auth failed.
        await plantScanState(service, { lastScanAt: null, lastError: SKIP_REASON });

        const response = await service.call(BINDINGS_PATH);
        expect(response.status).toBe(200);

        const parsed = parseBindingsBody(await response.text());
        expect(parsed).not.toBeNull();
        expect(parsed?.bindings.map((binding) => binding.bindingId)).toEqual([BINDING_ID]);
        // The row shape is exactly what `readStatusRows`/`BindingStatusRow`
        // in bindings-service.ts expects: nothing invented, nothing dropped.
        expect(parsed?.status).toEqual([
            {
                bindingId: BINDING_ID,
                repository: 'acme/widget',
                projectId: 'prj_42',
                accountLogin: ACCOUNT_LOGIN,
                active: true,
                lastScanAt: null,
                lastError: SKIP_REASON,
                pendingCount: 0,
            },
        ]);
    });

    it('parses the planted file in place, leaving no quarantine file behind (FIX 1)', async () => {
        const service = await startWithAccount();
        await grantBindings(service, [bindingFixture()]);
        await plantScanState(service, { lastScanAt: null, lastError: SKIP_REASON });

        await service.call(BINDINGS_PATH);

        const entries = await readdir(service.dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
    });

    it('carries status rows in the PUT answer so a grant cannot blank the rows', async () => {
        const service = await startWithAccount();
        await plantScanState(service, { lastScanAt: null, lastError: SKIP_REASON });

        const answer = await grantBindings(service, [bindingFixture()]);

        const parsed = parseBindingsBody(JSON.stringify(answer));
        expect(parsed?.status.map((row) => row.lastError)).toEqual([SKIP_REASON]);
    });

    it('keeps the registered credential out of the bindings answer', async () => {
        const service = await startWithAccount();
        await grantBindings(service, [bindingFixture()]);

        const response = await service.call(BINDINGS_PATH);

        expect(await response.text()).not.toContain(REGISTERED_TOKEN);
    });
});

describe('PUT /v1/bindings (the M7 reviewRequest trigger)', () => {
    it('stores a submitted reviewRequest flag and answers it back', async () => {
        const service = await startWithAccount();
        const binding = bindingFixture();
        binding.triggers = { assignment: true, mention: false, reviewRequest: true };

        const answer = await grantBindings(service, [binding]);
        const stored = answer.bindings as Record<string, unknown>[];
        expect(stored[0]?.triggers).toEqual({ assignment: true, mention: false, reviewRequest: true });

        // The panel reads its own grant back through the same parser.
        const response = await service.call(BINDINGS_PATH);
        const parsed = parseBindingsBody(await response.text());
        expect(parsed?.bindings[0]?.triggers.reviewRequest).toBe(true);
    });

    it('reads a binding stored before M7 as `false`, without quarantining the file', async () => {
        const service = await startWithAccount();
        // The fixture's triggers are the pre-M7 shape: no `reviewRequest` key.
        const answer = await grantBindings(service, [bindingFixture()]);
        const stored = answer.bindings as Record<string, unknown>[];
        expect(stored[0]?.triggers).toEqual({ assignment: true, mention: false, reviewRequest: false });

        // The stored file parses in place: no quarantine, no lost binding.
        const entries = await readdir(service.dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
        const reread = await service.call(BINDINGS_PATH);
        const parsed = parseBindingsBody(await reread.text());
        expect(parsed?.bindings).toHaveLength(1);
    });

    it('refuses a reviewRequest that is not a boolean, naming the field', async () => {
        const service = await startWithAccount();
        const binding = bindingFixture();
        binding.triggers = { assignment: true, mention: false, reviewRequest: 'yes' };

        const response = await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: jsonHeaders(),
            body: JSON.stringify({ bindings: [binding] }),
        });
        expect(response.status).toBe(422);

        const body = (await response.json()) as {
            readonly error: { readonly code: string; readonly issues?: readonly { readonly field: string }[] };
        };
        expect(body.error.code).toBe('validation');
        expect(body.error.issues?.map((issue) => issue.field)).toContain('triggers');
    });
});

/** A distinctive prompt this suite stores, changes, and scans for. */
const STORED_PROMPT = 'Reproduce first, then patch. Keep the public API stable.';

/** A prompt value that is present but is not text, for the quarantine cases. */
const NON_TEXT_PROMPTS: readonly unknown[] = [42, true, {}, []];

/**
 * Plant the operator's own `bindings.json` bytes in the store directory.
 *
 * @param service - Harness instance owning the data directory.
 * @param bindings - The array of records to write verbatim.
 */
async function plantBindings(service: TestService, bindings: readonly unknown[]): Promise<void> {
    await writeFile(join(service.dataDir, BINDINGS_FILE), JSON.stringify(bindings, null, 2), 'utf8');
}

describe('T-003 the starting prompt on the stored binding (004 FR-010, FR-017–FR-019)', () => {
    it('parses a file written before the field existed, with no quarantine (AC-142)', async () => {
        const service = await startWithAccount();
        // Exactly what a pre-004 installation holds: no `startingPrompt` key.
        await plantBindings(service, [bindingFixture()]);

        const response = await service.call(BINDINGS_PATH);
        expect(response.status).toBe(200);

        const parsed = parseBindingsBody(await response.text());
        expect(parsed?.bindings).toHaveLength(1);
        expect(parsed?.bindings[0]?.bindingId).toBe(BINDING_ID);
        const entries = await readdir(service.dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
        // Absent means unset, so no member is invented to stand in for it.
        const stored = await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
        expect(stored).not.toContain('startingPrompt');
    });

    it('reads a stored null as unset and a stored string as the prompt (FR-012, FR-017)', async () => {
        const service = await startWithAccount();
        const cleared = { ...bindingFixture(), bindingId: 'bnd-cleared', startingPrompt: null };
        const set = { ...bindingFixture(), bindingId: 'bnd-set', startingPrompt: `  ${STORED_PROMPT}  ` };
        await plantBindings(service, [cleared, set]);

        const response = await service.call(BINDINGS_PATH);
        expect(response.status).toBe(200);
        const answer = (await response.json()) as { readonly bindings: readonly Record<string, unknown>[] };
        expect(answer.bindings).toHaveLength(2);

        const clearedRow = answer.bindings.find((row) => row.bindingId === 'bnd-cleared');
        const setRow = answer.bindings.find((row) => row.bindingId === 'bnd-set');
        // A stored `null` reads exactly like absence: the key is not invented.
        expect(clearedRow !== undefined && 'startingPrompt' in clearedRow).toBe(false);
        // The configuration read is the only read that returns the text (FR-012).
        expect(setRow?.startingPrompt).toBe(STORED_PROMPT);

        const entries = await readdir(service.dataDir);
        expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
    });

    it('quarantines a stored non-text prompt, logging the reason and yielding no bindings (AC-141)', async () => {
        for (const value of NON_TEXT_PROMPTS) {
            const service = await startWithAccount();
            await plantBindings(service, [{ ...bindingFixture(), startingPrompt: value }]);

            const response = await service.call(BINDINGS_PATH);
            expect(response.status, `${JSON.stringify(value)} must still answer`).toBe(200);
            const parsed = parseBindingsBody(await response.text());
            // Nothing scans until the operator repairs the file, and no
            // binding is silently dropped or coerced.
            expect(parsed?.bindings, `${JSON.stringify(value)} dropped no binding`).toEqual([]);

            const line = service.logLines.find((entry) =>
                entry.includes('stored bindings were unusable'));
            expect(line, `${JSON.stringify(value)} was not logged`).toBeDefined();
            expect(line).toContain('startingPrompt: startingPrompt must be text');
            // The *reason* field is the whole of what the log says about the
            // value; the surrounding line carries a quarantine path whose hex
            // can contain anything, so only the reason is scanned for it.
            const logged = JSON.parse(line ?? '{}') as { readonly reason?: unknown };
            expect(String(logged.reason)).not.toContain(JSON.stringify(value));

            const entries = await readdir(service.dataDir);
            expect(entries.filter((entry) => entry.includes('.corrupt-'))).toHaveLength(1);
        }
    });

    it('reports a bad prompt and a bad repository in one 422 (FR-027)', async () => {
        const service = await startWithAccount();
        const binding = { ...bindingFixture(), repository: 'not-a-repository', startingPrompt: 42 };

        const response = await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: jsonHeaders(),
            body: JSON.stringify({ bindings: [binding] }),
        });
        expect(response.status).toBe(422);

        const body = (await response.json()) as {
            readonly error: {
                readonly code: string;
                readonly message: string;
                readonly issues?: readonly { readonly field: string; readonly remediation: string }[];
            };
        };
        expect(body.error.code).toBe('validation');
        expect(body.error.issues?.map((issue) => issue.field)).toContain('repository');
        expect(body.error.issues?.map((issue) => issue.field)).toContain('startingPrompt');
        // Nothing of the submission is echoed back, whole or partial.
        expect(body.error.message).not.toContain('42');
        expect(body.error.message).not.toContain('not-a-repository');
    });

    it('refuses a credential-shaped prompt at the write boundary, storing nothing (AC-133)', async () => {
        const service = await startWithAccount();
        const secret = `ghp_${'e'.repeat(30)}`;
        const binding = { ...bindingFixture(), startingPrompt: `push with ${secret}` };

        const response = await service.call(BINDINGS_PATH, {
            method: 'PUT',
            headers: jsonHeaders(),
            body: JSON.stringify({ bindings: [binding] }),
        });
        expect(response.status).toBe(422);

        const text = await response.text();
        expect(text).toContain('github-token-classic');
        expect(text).not.toContain(secret);
        // The refusal wrote no state: the file never came into existence.
        const entries = await readdir(service.dataDir);
        expect(entries).not.toContain(BINDINGS_FILE);
    });
});

/** The `binding.prompt-updated` rows a service instance has written, oldest first. */
async function promptRows(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const text = await readFile(join(service.dataDir, 'audit.ndjson'), 'utf8');

    return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.eventType === 'binding.prompt-updated');
}

/** One `PUT /v1/bindings` round trip, returning the status and the raw answer text. */
async function putBindings(
    service: TestService,
    bindings: readonly Record<string, unknown>[],
): Promise<{ readonly status: number; readonly text: string }> {
    const response = await service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ bindings }),
    });

    return { status: response.status, text: await response.text() };
}

/** A second binding this suite keeps beside the first, to prove scoping. */
const SECOND_BINDING_ID = 'bnd-second';

/** The second binding's own prompt. */
const SECOND_PROMPT = 'Close it with a comment instead of patching it.';

/** The second binding's repository, so a two-binding document is distinguishable. */
const SECOND_REPOSITORY = 'acme/other';

/**
 * A panel-shaped row: every field the shipped panel writes, and never the
 * prompt member it does not know exists.
 *
 * @param overrides - Members to replace on the base row.
 * @returns The submitted record.
 */
function panelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...bindingFixture(), ...overrides };
}

describe('T-005 PUT /v1/bindings: omission preserves, an explicit value sets (AC-137)', () => {
    it('preserves every stored prompt on a panel-shaped whole-file save (AC-137)', async () => {
        const service = await startWithAccount();
        await putBindings(service, [
            panelRow({ startingPrompt: STORED_PROMPT }),
            panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY, startingPrompt: SECOND_PROMPT }),
        ]);
        const before = await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
        expect(before).toContain(STORED_PROMPT);
        const rowsAfterSet = await promptRows(service);
        expect(rowsAfterSet).toHaveLength(2);

        // Exactly what the shipped panel sends: the member is absent everywhere.
        const answer = await putBindings(service, [
            panelRow(),
            panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY }),
        ]);
        expect(answer.status).toBe(200);

        const after = await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
        expect(after).toContain(STORED_PROMPT);
        expect(after).toContain(SECOND_PROMPT);
        // And no *new* prompt-change row: nothing changed, so nothing is recorded.
        expect(await promptRows(service)).toHaveLength(rowsAfterSet.length);
    });

    it('clears exactly the binding an explicit empty value names (AC-137)', async () => {
        const service = await startWithAccount();
        await putBindings(service, [
            panelRow({ startingPrompt: STORED_PROMPT }),
            panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY, startingPrompt: SECOND_PROMPT }),
        ]);

        const answer = await putBindings(service, [
            panelRow({ startingPrompt: '' }),
            panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY }),
        ]);
        expect(answer.status).toBe(200);

        const response = await service.call(BINDINGS_PATH);
        const body = (await response.json()) as { readonly bindings: readonly Record<string, unknown>[] };
        const first = body.bindings.find((row) => row.bindingId === BINDING_ID);
        const second = body.bindings.find((row) => row.bindingId === SECOND_BINDING_ID);
        expect(first !== undefined && 'startingPrompt' in first).toBe(false);
        expect(second?.startingPrompt).toBe(SECOND_PROMPT);
    });

    it('refuses an invalid prompt with no write, no row, and the previous prompt in force', async () => {
        const service = await startWithAccount();
        await putBindings(service, [panelRow({ startingPrompt: STORED_PROMPT })]);
        const bytesBefore = await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
        const rowsBefore = await promptRows(service);

        const refused = await putBindings(service, [panelRow({ startingPrompt: 42 })]);
        expect(refused.status).toBe(422);
        expect(refused.text).toContain('startingPrompt');
        expect(refused.text).not.toContain('42');

        expect(await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8')).toBe(bytesBefore);
        expect(await promptRows(service)).toHaveLength(rowsBefore.length);

        const response = await service.call(BINDINGS_PATH);
        const body = (await response.json()) as { readonly bindings: readonly Record<string, unknown>[] };
        expect(body.bindings[0]?.startingPrompt).toBe(STORED_PROMPT);
    });

    it('writes exactly three rows across set, change, and clear, chained (SC-125)', async () => {
        const service = await startWithAccount();

        await putBindings(service, [panelRow({ startingPrompt: STORED_PROMPT })]);
        await putBindings(service, [panelRow({ startingPrompt: `${STORED_PROMPT} Really.` })]);
        await putBindings(service, [panelRow({ startingPrompt: '' })]);

        const rows = await promptRows(service);
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.decision)).toEqual(['set', 'changed', 'cleared']);
        expect(rows.every((row) => row.actorSource === 'operator')).toBe(true);

        const details = rows.map((row) => row.details as Record<string, unknown>);
        expect(details.map((entry) => entry.previousFingerprint)).toEqual([
            null,
            promptFingerprint(STORED_PROMPT),
            promptFingerprint(`${STORED_PROMPT} Really.`),
        ]);
        expect(details.map((entry) => entry.promptPresent)).toEqual([true, true, false]);
        // No row ever carries the instruction itself.
        expect(JSON.stringify(rows)).not.toContain(STORED_PROMPT);
    });
});

describe('T-005 a hand edit is observed once, by whoever actually made it (AC-137, SC-125)', () => {
    it('records an out-of-panel edit once with actor service, and a racing PUT adds nothing', async () => {
        const service = await startWithAccount();
        await putBindings(service, [panelRow({ startingPrompt: STORED_PROMPT })]);
        const beforeEdit = await promptRows(service);
        expect(beforeEdit).toHaveLength(1);
        expect(beforeEdit[0]?.actorSource).toBe('operator');

        // The operator edits the store file directly, the way 004 FR-062
        // documents as the set path until 005 lands.
        const edited = `${STORED_PROMPT} Edit made in the file.`;
        await writeFile(
            join(service.dataDir, BINDINGS_FILE),
            JSON.stringify([{ ...bindingFixture(), startingPrompt: edited }], null, 2),
            'utf8',
        );

        // A read and a whole-file save racing over the same chain: still
        // exactly one row for the one change.
        const [read, save] = await Promise.all([
            service.call(BINDINGS_PATH),
            putBindings(service, [panelRow()]),
        ]);
        expect(read.status).toBe(200);
        expect(save.status).toBe(200);

        const rows = await promptRows(service);
        expect(rows).toHaveLength(beforeEdit.length + 1);
        const observed = rows.at(-1);
        expect(observed?.actorSource).toBe('service');
        expect(observed?.decision).toBe('changed');
        expect((observed?.details as Record<string, unknown>).promptFingerprint).toBe(promptFingerprint(edited));
        expect(JSON.stringify(rows)).not.toContain('Edit made in the file');

        // The prompt survived the racing save untouched.
        const after = await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
        expect(after).toContain(edited);
    });

    it('writes zero rows when a restarted service sees an unchanged file', async () => {
        const first = await startWithAccount();
        await putBindings(first, [panelRow({ startingPrompt: STORED_PROMPT })]);
        const beforeRestart = await promptRows(first);
        expect(beforeRestart).toHaveLength(1);

        // A second instance over the same directory is what a restart is: a
        // fresh store handle, a fresh baseline seeded from the trail.
        const restarted = await startTestService({ dataDir: first.dataDir });
        running.push(restarted);
        await restarted.handle.reconciled;

        const read = await restarted.call(BINDINGS_PATH);
        expect(read.status).toBe(200);
        const body = (await read.json()) as { readonly bindings: readonly Record<string, unknown>[] };
        expect(body.bindings[0]?.startingPrompt).toBe(STORED_PROMPT);

        const save = await putBindings(restarted, [panelRow()]);
        expect(save.status).toBe(200);

        expect(await promptRows(restarted)).toHaveLength(beforeRestart.length);
        expect(await promptRows(first)).toHaveLength(beforeRestart.length);
    });
});
