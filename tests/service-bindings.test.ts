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

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../extension/src/consent.ts';
import { parseBindingsBody } from '../extension/src/repos-service.ts';
import { SCAN_STATE_FILE } from '../extension/service/poll/scan.ts';
import { VERIFY_PATH } from '../extension/service/routes/verify.ts';
import { BINDINGS_PATH } from '../extension/service/routes/bindings.ts';
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
        body: JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: CONSENT_VERSION }),
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
        // in repos-service.ts expects: nothing invented, nothing dropped.
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
