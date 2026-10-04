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
import { isActorAllowed } from '../service/bindings-allow-list.ts';
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

/** A repository string no GitHub owner would have, for the refusal cases. */
const BAD_REPOSITORY = 'not-a-repository';

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

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
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
        {
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
        }
    });

    it('parses the planted file in place, leaving no quarantine file behind (FIX 1)', async () => {
        {
            const service = await startWithAccount();
            await grantBindings(service, [bindingFixture()]);
            await plantScanState(service, { lastScanAt: null, lastError: SKIP_REASON });

            await service.call(BINDINGS_PATH);

            const entries = await readdir(service.dataDir);
            expect(entries.filter((entry) => entry.includes('.corrupt-'))).toEqual([]);
        }
    });

    it('carries status rows in the PUT answer so a grant cannot blank the rows', async () => {
        {
            const service = await startWithAccount();
            await plantScanState(service, { lastScanAt: null, lastError: SKIP_REASON });

            const answer = await grantBindings(service, [bindingFixture()]);

            const parsed = parseBindingsBody(JSON.stringify(answer));
            expect(parsed?.status.map((row) => row.lastError)).toEqual([SKIP_REASON]);
        }
    });

    it('keeps the registered credential out of the bindings answer', async () => {
        {
            const service = await startWithAccount();
            await grantBindings(service, [bindingFixture()]);

            const response = await service.call(BINDINGS_PATH);

            expect(await response.text()).not.toContain(REGISTERED_TOKEN);
        }
    });

});

describe('PUT /v1/bindings (the M7 reviewRequest trigger)', () => {
    it('stores a submitted reviewRequest flag and answers it back', async () => {
        {
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
        }
    });

    it('reads a binding stored before M7 as `false`, without quarantining the file', async () => {
        {
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
        }
    });

    it('refuses a reviewRequest that is not a boolean, naming the field', async () => {
        {
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
        }
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
    it('parses a file written before the field existed, with no quarantine', async () => {
        {
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
        }
    });

    it('reads a stored null as unset and a stored string as the prompt', async () => {
        {
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
        }
    });

    it('quarantines a stored non-text prompt, logging the reason and yielding no bindings', async () => {
        {
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
                // The *reason* field is the whole of what the log says about the
                // value; the surrounding line carries a quarantine path whose hex
                // can contain anything, so only the reason is scanned for it.
                const logged = JSON.parse(line ?? '{}') as { readonly reason?: unknown };
                expect(String(logged.reason)).not.toContain(JSON.stringify(value));

                const entries = await readdir(service.dataDir);
                expect(entries.filter((entry) => entry.includes('.corrupt-'))).toHaveLength(1);
            }
        }
    });

    it('reports a bad prompt and a bad repository in one 422', async () => {
        {
            const service = await startWithAccount();
            const binding = { ...bindingFixture(), repository: BAD_REPOSITORY, startingPrompt: 42 };

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
            expect(body.error.message).not.toContain(BAD_REPOSITORY);
        }
    });

    it('refuses a credential-shaped prompt at the write boundary, storing nothing', async () => {
        {
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
        }
    });

});

/**
 * Every row in the service's audit trail, oldest first.
 *
 * @param service - Harness instance whose store holds the trail.
 * @returns The trail as the service wrote it, one parsed object per line.
 */
async function auditTrail(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const text = await readFile(join(service.dataDir, 'audit.ndjson'), 'utf8');

    return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The `binding.prompt-updated` rows a service instance has written, oldest first. */
async function promptRows(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const trail = await auditTrail(service);

    return trail.filter((row) => row.eventType === 'binding.prompt-updated');
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

describe('PUT /v1/bindings: a refused write appends zero audit rows (AC-133)', () => {
    it('defers the custody observation a directory read implies until the write is certain', async () => {
        const service = await startWithAccount();
        // A prompt typed straight into the custody file, observed by nobody
        // yet: the next *observing* read of the directory owes it exactly one
        // `account.prompt-updated` row. The account-existence check reads that
        // directory before it can validate, so that read must stay
        // unobserved — otherwise a refused PUT records a change it never
        // applied and never even decided about.
        const accountFile = join(service.dataDir, 'accounts', `${ACCOUNT_ID}.json`);
        const account = JSON.parse(await readFile(accountFile, 'utf8')) as Record<string, unknown>;
        account.startingPrompt = 'Typed into the file, not through the panel.';
        await writeFile(accountFile, JSON.stringify(account), 'utf8');

        const before = await auditTrail(service);
        const refused = await putBindings(service, [{ ...bindingFixture(), repository: BAD_REPOSITORY }]);
        const after = await auditTrail(service);

        expect(refused.status).toBe(422);
        // Not one row of any kind: the trail is exactly what it was.
        expect(after).toEqual(before);

        // Deferred, not dropped: a grant that goes through observes the same
        // hand edit exactly once, and nothing else.
        const granted = await putBindings(service, [bindingFixture()]);
        expect(granted.status).toBe(200);
        const trail = await auditTrail(service);
        const appended = trail.slice(before.length);
        expect(appended.map((row) => row.eventType)).toEqual(['account.prompt-updated']);
    });
});

describe('T-005 PUT /v1/bindings: omission preserves, an explicit value sets (AC-137)', () => {
    it('preserves every stored prompt on a panel-shaped whole-file save', async () => {
        {
            const service = await startWithAccount();
            await putBindings(service, [
                panelRow({ startingPrompt: STORED_PROMPT }),
                panelRow({
                    bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY, startingPrompt: SECOND_PROMPT }),
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
        }
    });

    it('clears exactly the binding an explicit empty value names', async () => {
        {
            const service = await startWithAccount();
            await putBindings(service, [
                panelRow({ startingPrompt: STORED_PROMPT }),
                panelRow({
                    bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY, startingPrompt: SECOND_PROMPT }),
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
        }
    });

    it('refuses an invalid prompt with no write, no row, and the previous prompt in force', async () => {
        {
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
        }
    });

    it('writes exactly three rows across set, change, and clear, chained', async () => {
        {
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
        }
    });

});

describe('T-005 a hand edit is observed once, by whoever actually made it (AC-137, SC-125)', () => {
    it('records an out-of-panel edit once with actor service, and a racing PUT adds nothing', async () => {
        {
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
        }
    });

    it('writes zero rows when a restarted service sees an unchanged file', async () => {
        {
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
        }
    });

});

/** A login list the operator typed, with deliberate mixed case (002 FR-047). */
const TYPED_USERS = ['Alice', 'bob'];

/** A login the operator did not type, used to prove the comparison is closed. */
const OTHER_LOGIN = 'carol';

/** A bot account's login: syntactically a login GitHub issues, inert here (plan D7). */
const BOT_LOGIN = 'dependabot[bot]';

/** The longest login research §R9 accepts, and the first one past it. */
const LONGEST_LOGIN = `a${'b'.repeat(38)}`;
const OVERLONG_LOGIN = `a${'b'.repeat(39)}`;

/** Longer than any bound the field needs, to prove there is no length cap (plan D6). */
const NO_CAP_USERS = Array.from({ length: 40 }, (_, index) => `user${index}`);

/**
 * Every element the per-element rule refuses, each labelled by why.
 *
 * One case per way a value fails research §R9's shape rather than an array of
 * near-duplicates: a number where a login belongs, a nested list, the empty
 * string, a leading hyphen, a trailing hyphen, doubled hyphens, an interior
 * space, an underscore, and one character past the length bound.
 */
const BAD_ELEMENTS: readonly (readonly [string, unknown])[] = [
    ['a number', 42],
    ['a nested list', ['alice']],
    ['the empty string', ''],
    ['a leading hyphen', '-alice'],
    ['a trailing hyphen', 'alice-'],
    ['doubled hyphens', 'al--ice'],
    ['an interior space', 'ali ce'],
    ['an underscore', 'ali_ce'],
    ['one character past the bound', OVERLONG_LOGIN],
];

/** The four non-array values the `[]`-shaped states do not cover. */
const NON_ARRAY_USERS: readonly (readonly [string, unknown])[] = [
    ['a string', 'alice'],
    ['an object', { login: 'alice' }],
    ['a literal null', null],
    ['a number', 42],
];

/** Read the stored `bindings.json` bytes verbatim. */
async function storedBytes(service: TestService): Promise<string> {
    return await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
}

/** Every stored row the service reports, in document order. */
async function storedRows(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const response = await service.call(BINDINGS_PATH);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly bindings: readonly Record<string, unknown>[] };

    return body.bindings;
}

/** The one stored row, or `undefined` when the document was quarantined. */
async function storedRow(service: TestService): Promise<Record<string, unknown> | undefined> {
    const rows = await storedRows(service);
    expect(rows.length).toBeLessThanOrEqual(1);

    return rows[0];
}

/** One field-level refusal as the `422` envelope carries it. */
interface RefusalIssue {
    /** Field the refusal names. */
    readonly field: string;
    /** Actionable remediation; never a submitted value. */
    readonly remediation: string;
}

/** The issue list a refused `PUT` answers with, or `[]` when it answered none. */
async function refusalIssues(text: string): Promise<readonly RefusalIssue[]> {
    const body = JSON.parse(text) as {
        readonly error: {
            readonly code: string;
            readonly issues?: readonly RefusalIssue[];
        };
    };
    expect(body.error.code).toBe('validation');

    return body.error.issues ?? [];
}

/** The quarantine files a store wrote beside the document it set aside. */
async function quarantines(service: TestService): Promise<readonly string[]> {
    const entries = await readdir(service.dataDir);

    return entries.filter((entry) => entry.includes('.corrupt-'));
}

describe('002 FR-047 the binding allow-list: its three states (AC-026, A-1)', () => {
    it('absent reads valid, the key stays omitted, and the file is byte-identical afterwards', async () => {
        {
            const service = await startWithAccount();
            // Exactly what an installation from before this field holds.
            await plantBindings(service, [bindingFixture()]);
            const before = await storedBytes(service);

            const row = await storedRow(service);

            expect(row?.bindingId).toBe(BINDING_ID);
            // Absent is a complete state, so no member is invented to stand in for it.
            expect('allowedUsers' in (row as Record<string, unknown>)).toBe(false);
            // Reading a pre-field document rewrites not one byte of it (no migration).
            expect(await storedBytes(service)).toBe(before);
            expect(await quarantines(service)).toEqual([]);
        }
    });

    it('[\'Alice\',\'bob\'] round-trips byte-identically and matches case-insensitively', async () => {
        {
            const service = await startWithAccount();
            await putBindings(service, [panelRow({ allowedUsers: TYPED_USERS })]);
            const stored = await storedBytes(service);
            // The submitted spelling survives the store byte for byte (plan D5):
            // nothing is lowercased, trimmed, or de-duplicated on the way in.
            expect(stored).toContain('"Alice"');
            expect(stored).toContain('"bob"');

            // Only the comparison folds case, so every spelling matches.
            expect(isActorAllowed('alice', TYPED_USERS)).toBe(true);
            expect(isActorAllowed('ALICE', TYPED_USERS)).toBe(true);
            expect(isActorAllowed('Bob', TYPED_USERS)).toBe(true);
            expect(isActorAllowed(OTHER_LOGIN, TYPED_USERS)).toBe(false);

            const row = await storedRow(service);
            expect(row?.allowedUsers).toEqual(TYPED_USERS);
        }
    });

    it('an absent list is the open state, and an unreadable actor is nobody either way', async () => {
        {
            const service = await startWithAccount();
            // A binding stored before the field existed *is* the open state, so
            // the predicate is driven with the value the store actually yields
            // rather than with a literal standing in for it.
            await plantBindings(service, [bindingFixture()]);
            const openRow = await storedRow(service);
            const open = openRow?.allowedUsers as readonly string[] | undefined;

            expect(open).toBeUndefined();
            expect(isActorAllowed(OTHER_LOGIN, open)).toBe(true);
            expect(isActorAllowed('ALICE', open)).toBe(true);
            // The open policy is not permission to attribute work to no one.
            expect(isActorAllowed('', open)).toBe(false);
            expect(isActorAllowed('', TYPED_USERS)).toBe(false);
            // A bot login may sit in the list and is inert (plan D7): bots are
            // filtered at detection, so no bot event exists for it to admit.
            expect(isActorAllowed(BOT_LOGIN, [BOT_LOGIN])).toBe(true);
        }
    });

    it('[] is refused, naming both honest alternatives, with nothing of it echoed', async () => {
        {
            const service = await startWithAccount();
            await putBindings(service, [panelRow({ allowedUsers: TYPED_USERS })]);
            const bytesBefore = await storedBytes(service);

            const refused = await putBindings(service, [panelRow({ allowedUsers: [] })]);
            expect(refused.status).toBe(422);

            const issues = await refusalIssues(refused.text);
            expect(issues.map((issue) => issue.field)).toEqual(['allowedUsers']);
            const remediation = issues[0]?.remediation ?? '';
            // Both honest alternatives, plus how *every* trigger stops: an empty
            // list has two plausible readings and this product picks neither.
            expect(remediation).toContain('omit the field');
            expect(remediation).toContain('any human actor may trigger this repository');
            expect(remediation).toContain('disable the binding');
            // Zero characters of the submitted value — not even its brackets.
            expect(remediation).not.toContain('[');
            expect(remediation).not.toContain(']');
            // A refusal writes nothing, so the configured list is still in force.
            expect(await storedBytes(service)).toBe(bytesBefore);
            const row = await storedRow(service);
            expect(row?.allowedUsers).toEqual(TYPED_USERS);
        }
    });

    it('accepts a [bot] login, the longest legal login, and a 42-entry list', async () => {
        {
            const service = await startWithAccount();
            const answer = await putBindings(service, [
                panelRow({ allowedUsers: [BOT_LOGIN, LONGEST_LOGIN, ...NO_CAP_USERS] }),
            ]);

            expect(answer.status).toBe(200);
            // A `[bot]` login is accepted and inert (plan D7): bots are already
            // filtered at detection, so no bot event exists for it to admit.
            expect(isActorAllowed(BOT_LOGIN, [BOT_LOGIN])).toBe(true);
            // No list-length cap (plan D6): boundedness is carried elsewhere.
            const row = await storedRow(service);
            const stored = row?.allowedUsers as readonly string[];
            expect(stored).toHaveLength(NO_CAP_USERS.length + 2);
            expect(stored[0]).toBe(BOT_LOGIN);
            expect(stored[1]).toBe(LONGEST_LOGIN);
        }
    });

});

describe('002 FR-024 the allow-list refusals: one rule set, every issue at once', () => {
    it('a non-array and every bad element are refused, naming `allowedUsers`', async () => {
        {
            for (const [label, value] of NON_ARRAY_USERS) {
                const service = await startWithAccount();
                await putBindings(service, [panelRow({ allowedUsers: TYPED_USERS })]);
                const bytesBefore = await storedBytes(service);

                const refused = await putBindings(service, [panelRow({ allowedUsers: value })]);
                expect(refused.status, `${label} must be refused`).toBe(422);

                const issues = await refusalIssues(refused.text);
                expect(issues.map((issue) => issue.field), label).toEqual(['allowedUsers']);
                // The remediation names the shape to send, never the text typed.
                expect(issues[0]?.remediation, label).not.toContain(String(JSON.stringify(value)));
                expect(await storedBytes(service), label).toBe(bytesBefore);
            }

            for (const [label, element] of BAD_ELEMENTS) {
                const service = await startWithAccount();
                await putBindings(service, [panelRow({ allowedUsers: TYPED_USERS })]);
                const bytesBefore = await storedBytes(service);

                const refused = await putBindings(service, [panelRow({ allowedUsers: ['alice', element] })]);
                expect(refused.status, `an element that is ${label} must be refused`).toBe(422);

                const issues = await refusalIssues(refused.text);
                expect(issues.map((issue) => issue.field), label).toEqual(['allowedUsers']);
                // One refusal for the whole field, and no echo of the bad element.
                expect(issues[0]?.remediation, label).not.toContain(String(JSON.stringify(element)));
                expect(await storedBytes(service), label).toBe(bytesBefore);
            }
        }
    });

    it('a bad list and a bad repository arrive in one 422, and nothing is written', async () => {
        {
            const service = await startWithAccount();
            await putBindings(service, [
                panelRow({ allowedUsers: TYPED_USERS }),
                panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY }),
            ]);
            const bytesBefore = await storedBytes(service);

            const refused = await putBindings(service, [
                panelRow({ repository: BAD_REPOSITORY, allowedUsers: ['-not-a-login'] }),
                panelRow({ bindingId: SECOND_BINDING_ID, repository: SECOND_REPOSITORY }),
            ]);
            expect(refused.status).toBe(422);

            // Collected rather than short-circuited: one answer for the whole
            // submission, exactly as `startingPrompt` collects (004 FR-027).
            const issues = await refusalIssues(refused.text);
            expect(issues.map((issue) => issue.field)).toContain('repository');
            expect(issues.map((issue) => issue.field)).toContain('allowedUsers');
            // All-or-nothing after validation: both other bindings byte-identical.
            expect(await storedBytes(service)).toBe(bytesBefore);
        }
    });

    it('a hand-edited stored [] is refused on read, by the same rule set', async () => {
        {
            const service = await startWithAccount();
            // The hand edit the contract forbids an operator from making: an empty
            // list typed straight into the store file.
            await plantBindings(service, [{ ...bindingFixture(), allowedUsers: [] }]);

            // Quarantined rather than half-read: no binding is coerced into
            // "open", so nothing scans until the operator repairs the file.
            expect(await storedRows(service)).toEqual([]);
            expect(await quarantines(service)).toHaveLength(1);

            const line = service.logLines.find((entry) => entry.includes('stored bindings were unusable'));
            expect(line).toBeDefined();
            const logged = JSON.parse(line ?? '{}') as { readonly reason?: unknown };
            expect(String(logged.reason)).toContain('allowedUsers');
            expect(String(logged.reason)).toContain('disable the binding');
        }
    });

});
