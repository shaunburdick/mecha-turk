/**
 * The actor allow-list's contract proof (002 v1.11.0,
 * [`contracts/binding-allow-list.md`](specs/002-agent-event-extension/contracts/binding-allow-list.md)
 * §5; AC-026, NFR-113).
 *
 * `tests/service-bindings.test.ts` proves the **validator** — the three states,
 * the refusals, the round trip through the module. This suite proves the
 * **contract** around it, row for row, because three of the five things FR-047
 * promises are not about the validator at all:
 *
 * 1. **The three states**, end to end over the loopback service rather than
 *    through the module: absent is a complete state, a list saves and reads back
 *    byte-identically, and an empty array is refused on write.
 * 2. **One rule set.** The same reader judges a panel `PUT` and a hand-edited
 *    file, and a refusal changes nothing at all — no file, no half-applied edit.
 * 3. **No new surface.** The route table still answers exactly the operations
 *    it answered before, and `src/` still contains no per-binding `PATCH`.
 * 4. **The list never escapes `bindings.json`.** This is the row that matters
 *    most, because the failure it prevents is silent: with a list configured, no
 *    permitted login may appear in a refusal envelope, a log line, any other
 *    store file, or either committed bundle. Only the *shape* of the policy is
 *    ever reportable.
 * 5. **One comparison.** A source scan asserts the membership helper's
 *    identifier is called from exactly one place outside its own module (plan
 *    D9, 003 FR-076).
 *
 * Offline and deterministic: a real service on a temp data directory, a fake
 * GitHub, a poller that answers every feed empty so the background scan can
 * never reach the network, and no credential that is not a fixture value.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { isActorAllowed } from '../service/bindings-allow-list.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import type { GitHubIssuePoller } from '../service/poll/poller-github.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolvePath(import.meta.dirname, '..');

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `allow-list-credential-${'p'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** RFC 3339 stamps the fixture binding carries. */
const STAMP = '2026-09-27T00:00:00.000Z';

/** Binding id every case in this suite grants. */
const BINDING_ID = 'bnd-allow-list';

/** Repository every case binds. */
const REPOSITORY = 'acme/widget';

/** A second repository, so a two-binding document is distinguishable. */
const OTHER_REPOSITORY = 'acme/other';

/**
 * The permitted logins this suite configures.
 *
 * Deliberately **distinctive and unlike anything else in the repository**, so a
 * leak of any kind is unambiguous: two legal GitHub logins with deliberate mixed
 * case, plus one bot login that plan D7 accepts as inert.
 */
const PERMITTED = ['Permitted-One', 'permitted-two'];
const PERMITTED_BOT = 'permitted-runner[bot]';

/** The second binding's own list, so a leak can be told from the first's. */
const OTHER_PERMITTED = 'other-permitted-login';

/** A login no binding in this suite permits, used to prove the list is closed. */
const DENIED = 'stranger-login';

/** A repository string no GitHub owner would have, for the refusal cases. */
const BAD_REPOSITORY = 'not-a-repository';

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the route that takes a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/**
 * Per-test teardown: drain every harness this suite started.
 */
const afterEachDrain = async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
};

afterEach(afterEachDrain);

/**
 * A poller whose every feed answers empty.
 *
 * The harness binds a real, active binding, so the background scan loop would
 * otherwise list against GitHub. Injecting this keeps the suite offline and
 * keeps the scan from writing anything the leak scan then has to reason about.
 *
 * @returns The poller the harness hands the cycle.
 */
function silentPoller(): GitHubIssuePoller {
    const empty = { kind: 'ok' as const };

    return {
        listOpenIssues: async () => ({ ...empty, issues: [] }),
        listIssueComments: async () => ({ ...empty, comments: [] }),
        listOpenPulls: async () => ({ ...empty, pulls: [] }),
        listIssueEvents: async () => ({ ...empty, events: [], exhausted: false }),
    };
}

/**
 * Start the service against a fake GitHub and register the fixture account.
 */
async function startWithAccount(): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: headerMap([['x-oauth-sopes', 'repo, user']]),
        },
    });
    const service = await startTestService({ github: github.verifier, poller: silentPoller() });
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
 * Build one binding this suite grants.
 *
 * @returns The submitted record.
 */
function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPOSITORY,
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: true, reviewRequest: true },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
        ...overrides,
    };
}

/**
 * The members that make the second binding distinguishable from the first.
 *
 * @returns Overrides carrying its own id, repository, and list.
 */
function secondBinding(): Record<string, unknown> {
    return { bindingId: 'bnd-other', repository: OTHER_REPOSITORY, allowedUsers: [OTHER_PERMITTED] };
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

/** The stored `bindings.json` bytes verbatim. */
async function storedBytes(service: TestService): Promise<string> {
    return await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8');
}

/**
 * Every binding the `GET` answer reports, in document order.
 *
 * @returns The answer's `bindings` array.
 */
async function storedRows(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const response = await service.call(BINDINGS_PATH);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly bindings: readonly Record<string, unknown>[] };

    return body.bindings;
}

/** Every file the harness wrote in its data directory, walked recursively. */
async function storeFiles(service: TestService): Promise<readonly string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        const children = await readdir(dir, { withFileTypes: true });
        for (const entry of children) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(path);
            } else {
                found.push(path);
            }
        }
    };
    await walk(service.dataDir);

    return found;
}

/**
 * The text of every store file **except** the bindings document.
 *
 * @param service - Harness instance owning the data directory.
 * @returns Every other byte the store holds, joined for one scan.
 */
async function storeTextWithoutBindings(service: TestService): Promise<string> {
    const parts: string[] = [];
    const files = await storeFiles(service);
    for (const path of files) {
        if (path.endsWith(BINDINGS_FILE)) {
            continue;
        }

        parts.push(await readFile(path, 'utf8'));
    }

    return parts.join('\n');
}

/** Both committed bundles, as the host would load them. */
function committedBundles(): string {
    return ['panel/main.js', 'service/main.js']
        .map((relative) => readFileSync(join(ROOT, relative), 'utf8'))
        .join('\n');
}

/**
 * Every TypeScript source under one repository directory, keyed by its path.
 *
 * @param dir - Repository-relative directory to walk.
 * @returns The source files, keyed by `dir/<relative path>`.
 */
function sourceFiles(dir: string): ReadonlyMap<string, string> {
    const files = new Map<string, string>();
    const names = readdirSync(resolvePath(ROOT, dir), { recursive: true });
    for (const entry of names) {
        const relative = String(entry);
        if (relative.endsWith('.ts')) {
            files.set(`${dir}/${relative}`, readFileSync(resolvePath(ROOT, dir, relative), 'utf8'));
        }
    }

    return files;
}

describe('contract §5.1 the three states, end to end over the route', () => {
    it('treats absent as a state, round-trips a list byte-identically, and refuses []', async () => {
        const service = await startWithAccount();

        // **Absent** is complete and valid: no policy is configured, any human
        // actor may trigger, and the answer omits the key entirely.
        const empty = await service.call(BINDINGS_PATH);
        expect(await empty.json()).toMatchObject({ bindings: [] });

        // **Non-empty** saves with the submitted spelling preserved byte for byte
        // (plan D5: nothing is lowercased, trimmed, or de-duplicated on the way in).
        const saved = await putBindings(service, [bindingRow({ allowedUsers: PERMITTED })]);
        expect(saved.status).toBe(200);
        const stored = await storedBytes(service);
        expect(stored).toContain('"Permitted-One"');
        expect(stored).toContain('"permitted-two"');

        const read = await service.call(BINDINGS_PATH);
        const body = (await read.json()) as { readonly bindings: readonly Record<string, unknown>[] };
        expect(body.bindings[0]?.allowedUsers).toEqual(PERMITTED);

        // **Explicitly empty** is refused, never reinterpreted. Nothing is
        // written, so the configured list stays in force — which is the whole
        // point of refusing rather than coercing.
        const refused = await putBindings(service, [bindingRow({ allowedUsers: [] })]);
        expect(refused.status).toBe(422);
        expect(await storedBytes(service)).toBe(stored);
        const rows = await storedRows(service);
        expect(rows[0]?.allowedUsers).toEqual(PERMITTED);
    });

    it('answers the comparison case-insensitively for the stored spelling', () => {
        // Contract §1: the comparison folds case; the stored spelling does not.
        expect(isActorAllowed('permitted-one', PERMITTED)).toBe(true);
        expect(isActorAllowed('PERMITTED-ONE', PERMITTED)).toBe(true);
        expect(isActorAllowed('Permitted-Two', PERMITTED)).toBe(true);
        expect(isActorAllowed(DENIED, PERMITTED)).toBe(false);
        // A bot login is accepted into the list and is inert (plan D7): bots are
        // filtered at detection, so no bot event exists for it to admit.
        expect(isActorAllowed(PERMITTED_BOT, [PERMITTED_BOT])).toBe(true);
    });
});

describe('contract §5.2–§5.3 bad shapes, and one rule set for every path', () => {
    it('collects every issue in one 422, writes nothing, and judges a hand edit the same way', async () => {
        const service = await startWithAccount();
        const other = bindingRow(secondBinding());
        await putBindings(service, [bindingRow({ allowedUsers: PERMITTED }), other]);
        const bytesBefore = await storedBytes(service);

        // Every issue in one submission arrives in one answer (004 FR-027's
        // additive posture, extended to this field), and the refusal writes
        // nothing at all: both bindings stay byte-identical.
        const refused = await putBindings(service, [
            bindingRow({ repository: BAD_REPOSITORY, allowedUsers: ['-not-a-login'] }),
            other,
        ]);
        expect(refused.status).toBe(422);
        expect(refused.text).toContain('repository');
        expect(refused.text).toContain('allowedUsers');
        expect(await storedBytes(service)).toBe(bytesBefore);

        // The **same** rule set answers a hand-edited file (002 FR-024). An empty
        // list typed straight into the store quarantines the document and
        // coerces nothing into "open".
        await writeFile(
            join(service.dataDir, BINDINGS_FILE),
            JSON.stringify([bindingRow({ allowedUsers: [] })], null, 2),
            'utf8',
        );
        const read = await service.call(BINDINGS_PATH);
        expect(await read.json()).toMatchObject({ bindings: [] });
        const logged = service.logLines.find((line) => line.includes('stored bindings were unusable'));
        expect(logged).toBeDefined();
        expect(String((JSON.parse(logged ?? '{}') as { reason?: unknown }).reason)).toContain('allowedUsers');
    });
});

describe('contract §5.4 no new surface', () => {
    it('answers exactly the operations it answered before, with no per-binding PATCH', () => {
        // The field rides the surface the product already had: no endpoint, no
        // method, no error code (FR-047). The route module exports exactly the
        // two operations, and `src/` has no `PATCH /v1/bindings/` call to add.
        const route = readFileSync(resolvePath(ROOT, 'service/routes/bindings.ts'), 'utf8');
        expect(route).toContain("method: 'GET'");
        expect(route).toContain("method: 'PUT'");
        expect(route).not.toContain("method: 'PATCH'");
        for (const [path, text] of sourceFiles('src')) {
            expect(text, `${path} calls a per-binding PATCH`).not.toContain('PATCH /v1/bindings');
        }
    });
});

describe('contract §5.5 the list never escapes bindings.json (NFR-113)', () => {
    it('keeps every permitted login out of every surface but the bindings document', async () => {
        const service = await startWithAccount();
        const other = bindingRow(secondBinding());
        await putBindings(service, [bindingRow({ allowedUsers: [...PERMITTED, PERMITTED_BOT] }), other]);

        // The one place the value is allowed to appear: the operator's own file.
        expect(await storedBytes(service)).toContain('"Permitted-One"');

        // The `GET` answer carries the editor field's own value and nothing else —
        // so the second binding's list never rides the first one's row.
        const rows = await storedRows(service);
        expect(rows.map((row) => row.allowedUsers)).toEqual([[...PERMITTED, PERMITTED_BOT], [OTHER_PERMITTED]]);

        // A refusal, every log line, and every other byte the store holds are
        // scanned for all three permitted logins. Configuration belongs to
        // `bindings.json` and to nowhere else (002 NFR-113).
        const refused = await putBindings(service, [bindingRow({ allowedUsers: ['-bad'] })]);
        expect(refused.status).toBe(422);
        const logs = service.logLines.join('\n');
        const store = await storeTextWithoutBindings(service);
        for (const login of [...PERMITTED, PERMITTED_BOT]) {
            expect(refused.text, `the refusal echoed ${login}`).not.toContain(login);
            expect(logs, `a log line leaked ${login}`).not.toContain(login);
            expect(store, `the store leaked ${login}`).not.toContain(login);
        }

        // The committed bundles are the operator's copy of the service: a
        // permitted login could only be in one if it were hard-coded.
        const bundles = committedBundles();
        for (const login of [...PERMITTED, PERMITTED_BOT]) {
            expect(bundles, `a bundle leaked ${login}`).not.toContain(login);
        }
    });
});

describe('contract §5.6 one comparison', () => {
    it('calls the membership helper from its own module and the gate only', () => {
        // Plan D9 / 003 FR-076: exactly one membership comparison in the product,
        // so "may this run start a session?" has exactly one answer. The
        // gate (`service/poll/dispatch-actor-gate.ts`, beside the reserve that
        // calls it) is that one caller, and this is the scan that keeps it the
        // only one: a panel-side pre-check, a poll-loop filter, or a second
        // service comparison all fail here rather than drifting into a second
        // answer to the same question.
        const gate = 'service/poll/dispatch-actor-gate.ts';
        const callers = [...sourceFiles('service'), ...sourceFiles('src')]
            .filter(([, text]) => /\bisActorAllowed\(/.test(text))
            .map(([path]) => path)
            .filter((path) => path !== 'service/bindings-allow-list.ts');

        // Exactly two files name it: the module that defines it and the gate.
        expect(callers).toEqual([gate]);
    });
});

describe('002 FR-048 exactly one repository per binding, permanently', () => {
    it('accepts one `repository` and refuses every plural or wildcard form', async () => {
        // A binding is the edge `repo → project`: `projectId` flows to the
        // enqueued event, then to the run, then to `host.startSession()`. A
        // binding spanning repositories would make "which project does this
        // dispatch into?" ill-defined, so the product owner rejected both the
        // plural and the wildcard on exactly that ground.
        const service = await startWithAccount();
        const accepted = await putBindings(service, [bindingRow()]);
        expect(accepted.status).toBe(200);

        const refusedShapes: readonly (readonly [string, Record<string, unknown>])[] = [
            ['a star repository', { repository: '*' }],
            ['a repository glob', { repository: 'acme/*' }],
            ['two repositories in one label', { repository: `${REPOSITORY},${OTHER_REPOSITORY}` }],
            ['a bare owner', { repository: 'acme' }],
            ['a repository list', { repository: [REPOSITORY, OTHER_REPOSITORY] }],
        ];

        for (const [label, value] of refusedShapes) {
            const refused = await putBindings(service, [bindingRow(value)]);
            expect(refused.status, `${label} must be refused`).toBe(422);
            expect(refused.text, label).toContain('repository');
        }

        // A **plural member** is not refused so much as never honoured: the
        // bindings document is deliberately not a closed object (contract §1), so
        // an unknown member is ignored and cannot widen a binding. The stored row
        // keeps exactly one `repository` and gains no plural key — which is the
        // only sense in which "no plural is accepted" can hold without turning
        // every future member into a refusal the specs do not name.
        await putBindings(service, [bindingRow({ repositories: [REPOSITORY, OTHER_REPOSITORY] })]);
        const rows = await storedRows(service);
        expect(rows[0]?.repository).toBe(REPOSITORY);
        expect('repositories' in (rows[0] as Record<string, unknown>)).toBe(false);
        expect(await storedBytes(service)).not.toContain('repositories');
    });
});
